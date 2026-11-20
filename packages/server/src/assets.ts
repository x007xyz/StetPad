import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, stat as statFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** What an uploaded file is: a picture, a video, or an attachment (anything else the server keeps). */
export type AssetKind = 'image' | 'video' | 'file' | 'text'

/** Thrown when a body grows past the limit it was written with. The partial file is already gone. */
export class TooLargeError extends Error {
  constructor(message = 'too large') {
    super(message)
    this.name = 'TooLargeError'
  }
}

/**
 * One HTTP Range header against a body of `size` bytes. Undefined: serve everything (no header, or one we do not
 * understand). 'unsatisfiable': answer 416. Otherwise the inclusive byte span to send.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!m || (m[1] === '' && m[2] === '')) return undefined
  if (size === 0) return 'unsatisfiable'
  if (m[1] === '') {
    // Suffix: the last N bytes.
    const n = Number(m[2])
    if (n === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  if (start >= size) return 'unsatisfiable'
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

/** A new unguessable asset id. The id is the access control for `/files/:id`. */
export const newAssetId = (): string => randomBytes(24).toString('base64url')

/** Asset bytes on disk, one file per asset id, under `dir`. */
export class AssetFiles {
  constructor(readonly dir: string) {}

  path(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`invalid asset id: ${id}`)
    return join(this.dir, id)
  }

  async writeBytes(id: string, data: Uint8Array): Promise<void> {
    const file = this.path(id)
    await mkdir(this.dir, { recursive: true })
    await writeFile(file, data)
  }

  /**
   * Streams `body` to disk. Returns the byte count and the SHA-256 of the bytes written. Throws TooLargeError
   * (and removes the file) past `maxBytes`.
   */
  async writeStream(id: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<{ size: number; sha256: string }> {
    const file = this.path(id)
    await mkdir(this.dir, { recursive: true })
    let total = 0
    const hash = createHash('sha256')
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        total += chunk.byteLength
        if (total > maxBytes) callback(new TooLargeError(`asset exceeds ${maxBytes} bytes`))
        else {
          hash.update(chunk)
          callback(null, chunk)
        }
      },
    })
    try {
      await pipeline(Readable.fromWeb(body as never), limit, createWriteStream(file))
    } catch (err) {
      await rm(file, { force: true })
      throw err
    }
    return { size: total, sha256: hash.digest('hex') }
  }

  /** Full bytes of an asset, or null when the file is missing. */
  async readBytes(id: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.path(id)))
    } catch {
      return null
    }
  }

  /** Web stream of the file, or of an inclusive byte range of it. */
  stream(id: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
    return Readable.toWeb(createReadStream(this.path(id), range)) as unknown as ReadableStream<Uint8Array>
  }

  /** The file's size, or null when it does not exist. */
  async stat(id: string): Promise<{ size: number } | null> {
    try {
      const s = await statFile(this.path(id))
      return { size: s.size }
    } catch {
      return null
    }
  }

  /** Where files made from an asset (PDF page previews) are cached: removed together with the asset. */
  derivedPath(id: string, name: string): string {
    if (!/^[\w.-]+$/.test(name) || name.includes('..')) throw new Error(`invalid derived name: ${name}`)
    return join(this.dir, 'derived', this.path(id).slice(this.dir.length + 1), name)
  }

  /** Removes the file and anything derived from it. A missing file is not an error. */
  async remove(id: string): Promise<void> {
    await rm(this.path(id), { force: true })
    await rm(join(this.dir, 'derived', id), { recursive: true, force: true })
  }
}
