import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** An upload in progress: its bytes so far sit in one temp file under the upload directory. */
export interface UploadRecord {
  id: string
  docId: string
  userId: string
  mime: string
  name: string | null
  size: number
  offset: number
  updatedAt: number
  /** Set once the last chunk has been stored as an asset; a repeated last chunk gets the same answer. */
  result?: { url: string; id: string; mime: string; size: number; name: string | null }
}

/** Uploads idle this long are deleted. */
export const UPLOAD_IDLE_MS = 24 * 3600_000

const ID_PATTERN = /^[\w-]+$/

/**
 * Resumable uploads: the client sends a file in chunks and the server appends them to a temp file. Each upload's
 * record is kept in a JSON sidecar next to its temp file (`<id>` holds the bytes, `<id>.json` the record), so an
 * upload survives a restart: `init()` reloads it and the client resumes from the stored offset. Chunks of one
 * upload are applied one at a time.
 */
export class ResumableUploads {
  private readonly records = new Map<string, UploadRecord>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Loads the uploads left by an earlier run and reconciles each with its temp file. Corrupt records and stray
   * files are removed. Then the idle sweep runs once.
   */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const names = await readdir(this.dir)
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      if (!ID_PATTERN.test(id)) {
        await rm(join(this.dir, name), { force: true })
        continue
      }
      const record = await this.load(id)
      if (record) this.records.set(id, record)
    }
    // Anything that is not a kept record's sidecar or temp file is left over: leftover `*.json.tmp`, stray bytes.
    const live = new Set<string>()
    for (const id of this.records.keys()) {
      live.add(id)
      live.add(`${id}.json`)
    }
    for (const name of await readdir(this.dir)) {
      if (live.has(name)) continue
      await rm(join(this.dir, name), { force: true }).catch(() => {})
    }
    await this.sweep()
  }

  /** Starts the idle sweep, which removes the uploads idle for `UPLOAD_IDLE_MS`, and the uploads with them. */
  startSweep(intervalMs = 3600_000): void {
    this.stopSweep()
    this.sweepTimer = setInterval(() => void this.sweep().catch(() => {}), intervalMs)
    this.sweepTimer.unref()
  }

  stopSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  async sweep(): Promise<number> {
    const cutoff = this.now() - UPLOAD_IDLE_MS
    let removed = 0
    for (const r of [...this.records.values()]) {
      if (r.updatedAt < cutoff) {
        await this.remove(r.id)
        removed++
      }
    }
    return removed
  }

  /** Stops the idle sweep (server close). In-progress uploads stay on disk, so they can resume after a restart. */
  async close(): Promise<void> {
    this.stopSweep()
  }

  async create(input: { docId: string; userId: string; mime: string; name: string | null; size: number }): Promise<UploadRecord> {
    const id = randomBytes(18).toString('base64url')
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.path(id), new Uint8Array(0))
    const record: UploadRecord = { id, ...input, offset: 0, updatedAt: this.now() }
    await this.persist(record)
    this.records.set(id, record)
    return record
  }

  /** The upload, if it exists and belongs to this user. */
  get(id: string, userId: string): UploadRecord | null {
    const r = this.records.get(id)
    return r && r.userId === userId ? r : null
  }

  /**
   * Appends `bytes` when `start` is the current offset. Otherwise nothing is written and the offset is returned.
   * `then` runs with the record once it has the new offset, still in order with other chunks of this upload.
   * The record is persisted after the bytes are written and again after `then` resolves.
   */
  append<T>(id: string, start: number, bytes: Uint8Array, then: (record: UploadRecord) => Promise<T>): Promise<{ ok: false; offset: number } | { ok: true; value: T }> {
    return this.serial(id, async () => {
      const r = this.records.get(id)
      if (!r) throw new UploadGone()
      if (start !== r.offset) return { ok: false as const, offset: r.offset }
      if (bytes.byteLength) await appendFile(this.path(id), bytes)
      r.offset += bytes.byteLength
      r.updatedAt = this.now()
      await this.persist(r)
      const value = await then(r)
      // `then` may have removed the upload; its record must not come back.
      if (this.records.get(id) === r) await this.persist(r)
      return { ok: true as const, value }
    })
  }

  /** Deletes the upload, its record and its temp file. */
  async remove(id: string): Promise<void> {
    this.records.delete(id)
    await rm(this.path(id), { force: true })
    await rm(this.sidecar(id), { force: true })
    await rm(`${this.sidecar(id)}.tmp`, { force: true })
  }

  /** Deletes the temp file only; the record stays, so a repeated last chunk can still be answered. */
  async dropFile(id: string): Promise<void> {
    await rm(this.path(id), { force: true })
  }

  /** The temp file path. The id is random base64url, so it is safe as a file name. */
  path(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error('invalid upload id')
    return join(this.dir, id)
  }

  /** The record's JSON sidecar path. */
  private sidecar(id: string): string {
    return `${this.path(id)}.json`
  }

  /** Writes the record to its sidecar atomically: a temp file, then a rename. */
  private async persist(r: UploadRecord): Promise<void> {
    const file = this.sidecar(r.id)
    await writeFile(`${file}.tmp`, JSON.stringify(r))
    await rename(`${file}.tmp`, file)
  }

  /**
   * Reads one sidecar and reconciles it with its temp file. Returns null, and removes the upload's files, when the
   * record is corrupt or has nothing left to resume from.
   */
  private async load(id: string): Promise<UploadRecord | null> {
    let record: UploadRecord | null
    try {
      record = parseRecord(JSON.parse(await readFile(this.sidecar(id), 'utf8')), id)
    } catch {
      record = null
    }
    if (!record) {
      await this.remove(id)
      return null
    }
    const file = this.path(id)
    if (record.result) {
      // The bytes were stored as an asset already; only the answer is kept.
      await rm(file, { force: true })
      return record
    }
    const size = await fileSize(file)
    if (size === null) {
      await this.remove(id)
      return null
    }
    if (size > record.offset) {
      // A crash after an append but before its sidecar write: the extra bytes are not acknowledged, so cut them.
      await truncate(file, record.offset)
    } else if (size < record.offset) {
      record.offset = size
      await this.persist(record)
    }
    return record
  }

  private serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(id) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(task)
    this.queues.set(id, next)
    void next.finally(() => {
      if (this.queues.get(id) === next) this.queues.delete(id)
    }).catch(() => {})
    return next
  }
}

/** The size of a file, or null when it does not exist. */
async function fileSize(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size
  } catch {
    return null
  }
}

/** Checks a sidecar read from disk. Null when a field is missing or of the wrong type, or when it names another id. */
function parseRecord(raw: unknown, id: string): UploadRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  const isName = (v: unknown): v is string | null => v === null || typeof v === 'string'
  if (o.id !== id || typeof o.docId !== 'string' || typeof o.userId !== 'string' || typeof o.mime !== 'string') return null
  if (!isName(o.name) || !isCount(o.size) || !isCount(o.offset) || o.offset > o.size) return null
  if (typeof o.updatedAt !== 'number' || !Number.isFinite(o.updatedAt)) return null
  const record: UploadRecord = {
    id,
    docId: o.docId,
    userId: o.userId,
    mime: o.mime,
    name: o.name,
    size: o.size,
    offset: o.offset,
    updatedAt: o.updatedAt,
  }
  if (o.result !== undefined) {
    const r = o.result as Record<string, unknown> | null
    if (typeof r !== 'object' || r === null || typeof r.url !== 'string' || typeof r.id !== 'string' || typeof r.mime !== 'string' || !isCount(r.size) || !isName(r.name)) return null
    record.result = { url: r.url, id: r.id, mime: r.mime, size: r.size, name: r.name }
  }
  return record
}

/** The upload was removed while a chunk waited its turn. */
export class UploadGone extends Error {
  constructor() {
    super('upload gone')
    this.name = 'UploadGone'
  }
}
