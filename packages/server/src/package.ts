import { blocks as yBlocks, projectBlocks } from '@stetpad/crdt'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough, type UnzipFile } from 'fflate'
import * as Y from 'yjs'
import { newAssetId, AssetFiles, TooLargeError, type AssetKind } from './assets'
import type { Collab, VersionContent } from './collab'
import { docFromBlocks, type Block } from './content'
import type { DocRow, Store } from './db'

/** The ids of the uploaded files a document's blocks refer to (`/files/<id>` attributes). */
export function referencedAssets(doc: Y.Doc): string[] {
  const out = new Set<string>()
  for (const el of yBlocks(doc)) {
    for (const v of Object.values(el.getAttributes())) {
      const m = typeof v === 'string' ? /^\/files\/([\w-]+)$/.exec(v) : null
      if (m) out.add(m[1]!)
    }
  }
  return [...out]
}

/**
 * The document package: one zip with the document (its full CRDT state, a readable copy and every version)
 * and the files it refers to. Also reads the older v1 JSON export and the zip back into a new document.
 */

export const PACKAGE_FORMAT = 'stetpad-package'
export const PACKAGE_VERSION = 2
/** Largest package accepted on import. */
export const PACKAGE_MAX_BYTES = 4 * 1024 ** 3
/** document.json holds the CRDT state and every version: generous, but bounded. */
const MANIFEST_MAX_BYTES = 256 * 1024 ** 2

/** What the server needs from the app: its files, its store, the live documents, and the upload rules. */
export interface PackageContext {
  store: Store
  files: AssetFiles
  collab: Collab
  /** The kind of a MIME type the server stores, null for anything else. */
  kindOf: (mime: string) => AssetKind | null
  /** Largest accepted size of a file of that kind. */
  limitOf: (kind: AssetKind) => number
  /** Cleans blocks from a JSON file (the same rules as `/import/create`). */
  sanitize: (raw: unknown[]) => Block[]
}

/** The package is not one we can read. The route answers 422. */
export class PackageError extends Error {
  constructor(message = '不是有效的文档包') {
    super(message)
    this.name = 'PackageError'
  }
}

type AssetMeta = NonNullable<Awaited<ReturnType<Store['getAssetMeta']>>>
const B64 = /^[A-Za-z0-9+/]*={0,2}$/
const ASSET_ID = /^[\w-]+$/
const FILE_REF = /\/files\/([\w-]+)/g

const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
function fromB64(text: unknown): Uint8Array {
  if (typeof text !== 'string' || !B64.test(text) || text.length % 4 === 1) throw new PackageError()
  return new Uint8Array(Buffer.from(text, 'base64'))
}
const docOf = (state: Uint8Array): Y.Doc => {
  const d = new Y.Doc()
  Y.applyUpdate(d, state)
  return d
}

/** Everything a package of this document holds, read once. */
interface Collected {
  title: string
  state: Uint8Array
  blocks: ReturnType<typeof projectBlocks>
  /** Every referenced file, in first-seen order. `meta` is null when the file is gone. */
  refs: { id: string; meta: AssetMeta | null }[]
  versions: { row: { id: string; label: string | null; trigger: string; author: string; word_count: number; created_at: number }; content: unknown; state: Uint8Array | null }[]
}

/** The current state, the readable copy, every version, and the files they refer to. */
async function collect(ctx: PackageContext, doc: DocRow): Promise<Collected> {
  const live = await ctx.collab.withDoc(doc.id, (y) => ({
    state: Y.encodeStateAsUpdate(y),
    blocks: projectBlocks(y, 'revised'),
    ids: referencedAssets(y),
  }))
  const ids = new Set(live.ids)
  const versions: Collected['versions'] = []
  for (const row of await ctx.store.listVersions(doc.id)) {
    const full = await ctx.store.getVersion(row.id)
    if (!full) continue
    const state = await ctx.store.getVersionState(row.id)
    if (state) for (const id of referencedAssets(docOf(state))) ids.add(id)
    for (const m of full.content_json.matchAll(FILE_REF)) ids.add(m[1]!)
    versions.push({ row, content: JSON.parse(full.content_json) as VersionContent, state })
  }
  const refs: Collected['refs'] = []
  for (const id of ids) refs.push({ id, meta: await ctx.store.getAssetMeta(id) })
  return { title: doc.title, state: live.state, blocks: live.blocks, refs, versions }
}

/** How many images, videos and attachments a package of this document would hold, and their total size. */
export async function packageInfo(ctx: PackageContext, doc: DocRow): Promise<{ images: { count: number; bytes: number }; videos: { count: number; bytes: number }; files: { count: number; bytes: number } }> {
  const c = await collect(ctx, doc)
  const out = { images: { count: 0, bytes: 0 }, videos: { count: 0, bytes: 0 }, files: { count: 0, bytes: 0 } }
  for (const { meta } of c.refs) {
    if (!meta) continue
    const kind = ctx.kindOf(meta.mime)
    const bucket = kind === 'video' ? out.videos : kind === 'image' ? out.images : kind === 'file' ? out.files : null
    if (bucket) {
      bucket.count++
      bucket.bytes += meta.size
    }
  }
  return out
}

/** The zip, as chunks produced on demand: document.json first, then one entry per file, never all in memory. */
async function* zipChunks(ctx: PackageContext, doc: DocRow, videos: boolean): AsyncGenerator<Uint8Array> {
  const c = await collect(ctx, doc)
  const assets: { id: string; mime: string; name: string | null; size: number; meta: AssetMeta }[] = []
  const skipped: { id: string; mime: string; size: number; reason: 'video-excluded' | 'missing' }[] = []
  for (const { id, meta } of c.refs) {
    if (!meta) {
      skipped.push({ id, mime: '', size: 0, reason: 'missing' })
      continue
    }
    const kind = ctx.kindOf(meta.mime)
    if (!kind) continue
    if (kind === 'video' && !videos) {
      skipped.push({ id, mime: meta.mime, size: meta.size, reason: 'video-excluded' })
      continue
    }
    assets.push({ id, mime: meta.mime, name: meta.name, size: meta.size, meta })
  }
  const manifest = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    title: c.title,
    exportedAt: new Date().toISOString(),
    state: toB64(c.state),
    blocks: c.blocks,
    versions: c.versions.map((v) => ({
      label: v.row.label,
      trigger: v.row.trigger,
      author: v.row.author,
      wordCount: v.row.word_count,
      createdAt: v.row.created_at,
      content: v.content,
      state: v.state ? toB64(v.state) : null,
    })),
    assets: assets.map((a) => ({ id: a.id, mime: a.mime, name: a.name, size: a.size, path: `assets/${a.id}` })),
    skipped,
  }

  const out: Uint8Array[] = []
  const zip = new Zip((err, chunk) => {
    if (!err && chunk) out.push(chunk)
  })
  const flush = function* (): Generator<Uint8Array> {
    yield* out.splice(0)
  }

  const head = new ZipDeflate('document.json', { level: 6 })
  zip.add(head)
  head.push(new TextEncoder().encode(JSON.stringify(manifest)), true)
  yield* flush()

  for (const a of assets) {
    const entry = new ZipPassThrough(`assets/${a.id}`)
    zip.add(entry)
    if (a.meta.storage === 'db') {
      // Legacy rows keep their bytes in the table; they are small enough to read at once.
      entry.push((await ctx.store.getAssetData(a.id)) ?? new Uint8Array(0), true)
      yield* flush()
    } else {
      const reader = ctx.files.stream(a.id).getReader()
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        entry.push(r.value, false)
        yield* flush()
      }
      entry.push(new Uint8Array(0), true)
      yield* flush()
    }
  }
  zip.end()
  yield* flush()
}

/** The package as a web stream. Pulled chunk by chunk, so memory stays bounded by one file chunk. */
export function packageStream(ctx: PackageContext, doc: DocRow, videos: boolean): ReadableStream<Uint8Array> {
  const it = zipChunks(ctx, doc, videos)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await it.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel() {
      await it.return(undefined)
    },
  })
}

// --- import

/** Writes an upload to a temp file, refusing past `max` bytes. The caller removes it with `remove`. */
export async function receivePackage(body: ReadableStream<Uint8Array> | null, max: number): Promise<{ path: string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'stetpad-import-'))
  const path = join(dir, 'package')
  const remove = () => rm(dir, { recursive: true, force: true })
  try {
    if (body) {
      let total = 0
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          total += chunk.byteLength
          if (total > max) callback(new TooLargeError('package too large'))
          else callback(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(body as never), limit, createWriteStream(path))
    } else {
      await pipeline(Readable.from([]), createWriteStream(path))
    }
  } catch (err) {
    await remove()
    throw err
  }
  return { path, remove }
}

/** Feeds one zip entry into a new asset file. Pushed chunks wait until the file write has taken them. */
class AssetSink {
  private queue: Uint8Array[] = []
  private closed = false
  private failed = false
  private wakeReader: (() => void) | null = null
  private wakeWriter: (() => void) | null = null
  readonly done: Promise<{ size: number; sha256: string }>

  constructor(files: AssetFiles, id: string, limit: number) {
    const stream = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          while (this.queue.length === 0 && !this.closed) await new Promise<void>((r) => (this.wakeReader = r))
          const next = this.queue.shift()
          if (next) {
            controller.enqueue(next)
            this.wakeWriter?.()
          } else controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    this.done = files.writeStream(id, stream, limit).then(
      (written) => written,
      (err) => {
        this.failed = true
        this.queue = []
        this.wakeWriter?.()
        throw err
      },
    )
    this.done.catch(() => undefined) // reported by the caller, which awaits `done`
  }

  push(chunk: Uint8Array, final: boolean): void {
    if (this.failed) return
    if (chunk.byteLength) this.queue.push(chunk)
    if (final) this.closed = true
    this.wakeReader?.()
    this.wakeReader = null
  }

  /** Resolves once the writer has taken all but the last chunk, or has failed. */
  async drain(): Promise<void> {
    while (this.queue.length > 1 && !this.failed) await new Promise<void>((r) => (this.wakeWriter = r))
  }
}

/** Why a file of the package did not come across: its type is not stored, it is too large, it is missing, or the exporter left it out. */
export type DroppedReason = 'type' | 'size' | 'missing' | 'excluded'
/** A file of the package that the import did not keep. `name` is null when the package does not say. */
export interface DroppedFile {
  name: string | null
  mime: string
  reason: DroppedReason
}

interface ManifestAsset {
  id: string
  mime: string
  name: string | null
  size: number
}
interface Manifest {
  title: string
  state: Uint8Array
  blocks: unknown[]
  versions: { label: string | null; trigger: string; author: string; wordCount: number; createdAt: number | null; content: unknown; state: Uint8Array | null }[]
  assets: ManifestAsset[]
  /** Files the manifest lists that cannot be imported, before any file is read. */
  dropped: DroppedFile[]
}

/** Checks document.json. Anything missing or of the wrong shape is a PackageError. */
function parseManifest(raw: Uint8Array): Manifest {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>
  } catch {
    throw new PackageError()
  }
  if (!obj || typeof obj !== 'object' || obj.format !== PACKAGE_FORMAT || obj.version !== PACKAGE_VERSION) throw new PackageError()
  if (!Array.isArray(obj.blocks) || !Array.isArray(obj.versions) || !Array.isArray(obj.assets)) throw new PackageError()
  const state = fromB64(obj.state)
  const versions = obj.versions.map((raw) => {
    const v = raw as Record<string, unknown>
    if (!v || typeof v !== 'object' || (v.state !== null && typeof v.state !== 'string')) throw new PackageError()
    return {
      label: typeof v.label === 'string' ? v.label : null,
      trigger: typeof v.trigger === 'string' ? v.trigger : 'import',
      author: typeof v.author === 'string' ? v.author.slice(0, 80) : 'import',
      wordCount: Number.isFinite(Number(v.wordCount)) ? Number(v.wordCount) : 0,
      createdAt: typeof v.createdAt === 'number' ? v.createdAt : null,
      content: v.content,
      state: v.state === null ? null : fromB64(v.state),
    }
  })
  const assets: ManifestAsset[] = []
  const dropped: DroppedFile[] = []
  for (const raw of obj.assets as unknown[]) {
    const a = raw as Record<string, unknown>
    if (!a || typeof a !== 'object') continue
    const name = typeof a.name === 'string' ? a.name.slice(0, 255) : null
    // Entries with an unsafe id or no MIME type are dropped; their files are never written.
    if (typeof a.id !== 'string' || !ASSET_ID.test(a.id) || typeof a.mime !== 'string') {
      dropped.push({ name, mime: typeof a.mime === 'string' ? a.mime : '', reason: 'type' })
      continue
    }
    assets.push({ id: a.id, mime: a.mime, name, size: Number(a.size) || 0 })
  }
  // Files the exporter left out: videos when they were excluded, and files it could not find.
  for (const raw of Array.isArray(obj.skipped) ? (obj.skipped as unknown[]) : []) {
    const s = raw as Record<string, unknown>
    if (!s || typeof s !== 'object') continue
    const mime = typeof s.mime === 'string' ? s.mime : ''
    if (s.reason === 'video-excluded') dropped.push({ name: null, mime, reason: 'excluded' })
    else if (s.reason === 'missing') dropped.push({ name: null, mime, reason: 'missing' })
  }
  return { title: typeof obj.title === 'string' ? obj.title.trim() : '', state, blocks: obj.blocks, versions, assets, dropped }
}

/** Replaces `/files/<old>` in a CRDT state's block attributes with the new ids. */
function rewriteState(state: Uint8Array, map: Map<string, string>): Uint8Array {
  if (map.size === 0) return state
  const doc = docOf(state)
  doc.transact(() => {
    for (const el of yBlocks(doc)) {
      for (const [key, value] of Object.entries(el.getAttributes())) {
        const m = typeof value === 'string' ? /^\/files\/([\w-]+)$/.exec(value) : null
        const next = m ? map.get(m[1]!) : undefined
        if (next) el.setAttribute(key, `/files/${next}`)
      }
    }
  })
  return Y.encodeStateAsUpdate(doc)
}

/** Replaces `/files/<old>` in serialized JSON text. Ids not in the map stay as they are. */
function rewriteText(text: string, map: Map<string, string>): string {
  if (map.size === 0) return text
  return text.replace(FILE_REF, (whole, id: string) => (map.has(id) ? `/files/${map.get(id)}` : whole))
}

export interface PreparedPackage {
  title: string
  state: Uint8Array
  versions: { state: Uint8Array; content: unknown; label: string | null; trigger: string; author: string; wordCount: number; createdAt?: number }[]
  assets: { id: string; mime: string; size: number; name: string | null; sha256: string | null }[]
  /** Files of the package that were not kept, with the reason. Empty when everything came across. */
  dropped: DroppedFile[]
  /** Removes the asset files this import wrote. Call it when the document is not created. */
  discard: () => Promise<void>
}

/**
 * Reads a package from `file` (a zip, or a v1 JSON export) and writes its files under new ids.
 * Nothing is recorded in the database here: the caller creates the document from the result.
 * On failure every file already written is removed before the error is thrown.
 */
export async function preparePackage(ctx: PackageContext, file: string): Promise<PreparedPackage> {
  const head = Buffer.from(await readHead(file, 4))
  if (head[0] === 0x50 && head[1] === 0x4b) return preparePackageZip(ctx, file)
  if (head.length === 0 || head.toString('latin1').trimStart()[0] === '{') return prepareLegacy(ctx, file)
  throw new PackageError()
}

async function readHead(file: string, n: number): Promise<Uint8Array> {
  const fh = await open(file, 'r')
  try {
    const buf = new Uint8Array(Math.max(n, 64))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** The v1 JSON export: blocks and versions, no files. */
async function prepareLegacy(ctx: PackageContext, file: string): Promise<PreparedPackage> {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse((await readFile(file)).toString('utf8')) as Record<string, unknown>
  } catch {
    throw new PackageError()
  }
  if (!obj || obj.format !== PACKAGE_FORMAT || obj.version !== 1 || !Array.isArray(obj.blocks)) throw new PackageError()
  const state = Y.encodeStateAsUpdate(docFromBlocks(ctx.sanitize(obj.blocks as unknown[])))
  const versions: PreparedPackage['versions'] = []
  for (const raw of Array.isArray(obj.versions) ? (obj.versions as Record<string, unknown>[]) : []) {
    const content = raw?.content as { revised?: unknown } | undefined
    // Only versions whose content has blocks can be restored; the rest have nothing to show.
    if (!content || !Array.isArray(content.revised) || content.revised.length === 0) continue
    versions.push({
      state: Y.encodeStateAsUpdate(docFromBlocks(ctx.sanitize(content.revised as unknown[]))),
      content,
      label: typeof raw.label === 'string' ? raw.label : null,
      trigger: typeof raw.trigger === 'string' ? raw.trigger : 'import',
      author: typeof raw.author === 'string' ? raw.author.slice(0, 80) : 'import',
      wordCount: Number(raw.word_count ?? raw.wordCount) || 0,
      createdAt: typeof raw.created_at === 'number' ? raw.created_at : typeof raw.createdAt === 'number' ? raw.createdAt : undefined,
    })
  }
  return { title: typeof obj.title === 'string' ? obj.title.trim() : '', state, versions, assets: [], dropped: [], discard: async () => undefined }
}

async function preparePackageZip(ctx: PackageContext, file: string): Promise<PreparedPackage> {
  let manifest: Manifest | null = null
  let manifestError = false
  const sinks: { oldId: string; newId: string; mime: string; name: string | null; sink: AssetSink }[] = []
  const seen = new Set<string>()
  const discard = async (): Promise<void> => {
    for (const s of sinks) {
      await s.sink.done.catch(() => undefined)
      await ctx.files.remove(s.newId)
    }
  }

  try {
    const unzip = new Unzip((entry: UnzipFile) => {
      if (entry.name === 'document.json') {
        const parts: Uint8Array[] = []
        let collected = 0
        entry.ondata = (err, chunk, final) => {
          if (manifestError) return
          if (err) manifestError = true
          else if (chunk.byteLength) {
            // A small zip can inflate to gigabytes: refuse a manifest past the cap instead of holding it.
            collected += chunk.byteLength
            if (collected > MANIFEST_MAX_BYTES) {
              manifestError = true
              parts.length = 0
              entry.terminate()
              return
            }
            parts.push(chunk)
          }
          if (final && !err) {
            const raw = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
            let at = 0
            for (const p of parts) {
              raw.set(p, at)
              at += p.byteLength
            }
            try {
              manifest = parseManifest(raw)
            } catch {
              manifestError = true
            }
          }
        }
        entry.start()
        return
      }
      const m = /^assets\/([\w-]+)$/.exec(entry.name)
      const listed = m && manifest ? (manifest as Manifest).assets.find((a) => a.id === m[1]) : undefined
      const kind = listed ? ctx.kindOf(listed.mime) : null
      if (!m || !listed || !kind || seen.has(m[1]!)) {
        // Not something we store: read and drop it.
        entry.ondata = () => undefined
        entry.start()
        return
      }
      seen.add(m[1]!)
      const newId = newAssetId()
      const sink = new AssetSink(ctx.files, newId, ctx.limitOf(kind))
      sinks.push({ oldId: m[1]!, newId, mime: listed.mime, name: listed.name, sink })
      entry.ondata = (err, chunk, final) => {
        if (err) sink.push(new Uint8Array(0), true)
        else sink.push(chunk, final)
      }
      entry.start()
    })
    unzip.register(UnzipInflate)

    // The zip is read in pieces from disk, not all at once: each piece waits until the file writers have taken the last one.
    for await (const chunk of createReadStream(file, { highWaterMark: 256 * 1024 })) {
      unzip.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), false)
      await Promise.all(sinks.map((s) => s.sink.drain()))
    }
    unzip.push(new Uint8Array(0), true)
  } catch {
    await discard()
    throw new PackageError()
  }

  // Every write ends, even when the zip was truncated.
  for (const s of sinks) s.sink.push(new Uint8Array(0), true)
  const written = new Map<string, { newId: string; mime: string; size: number; name: string | null; sha256: string }>()
  const failed = new Map<string, unknown>()
  for (const s of sinks) {
    try {
      const { size, sha256 } = await s.sink.done
      written.set(s.oldId, { newId: s.newId, mime: s.mime, size, name: s.name, sha256 })
    } catch (err) {
      // Too large or unreadable: its file is already gone, and references to it stay broken.
      failed.set(s.oldId, err)
    }
  }

  try {
    if (manifestError || !manifest) throw new PackageError()
    const m: Manifest = manifest
    // Every file the manifest lists that did not come across, and why.
    const dropped: DroppedFile[] = [...m.dropped]
    const listed = new Set<string>()
    for (const a of m.assets) {
      if (listed.has(a.id)) continue
      listed.add(a.id)
      if (written.has(a.id)) continue
      const reason: DroppedReason = !ctx.kindOf(a.mime) ? 'type' : failed.get(a.id) instanceof TooLargeError ? 'size' : 'missing'
      dropped.push({ name: a.name, mime: a.mime, reason })
    }
    const map = new Map([...written].map(([oldId, w]) => [oldId, w.newId]))
    const state = rewriteState(m.state, map)
    const versions: PreparedPackage['versions'] = []
    for (const v of m.versions) {
      if (!v.state) continue
      if (!v.content || typeof v.content !== 'object') throw new PackageError()
      const content = JSON.parse(rewriteText(JSON.stringify(v.content), map)) as unknown
      versions.push({
        state: rewriteState(v.state, map),
        content,
        label: v.label,
        trigger: v.trigger,
        author: v.author,
        wordCount: v.wordCount,
        createdAt: v.createdAt ?? undefined,
      })
    }
    return {
      title: m.title || '导入的文档',
      state,
      versions,
      assets: [...written.values()].map((w) => ({ id: w.newId, mime: w.mime, size: w.size, name: w.name, sha256: w.sha256 })),
      dropped,
      discard,
    }
  } catch (err) {
    await discard()
    if (err instanceof PackageError) throw err
    throw new PackageError()
  }
}
