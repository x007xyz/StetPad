import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResumableUploads, UPLOAD_IDLE_MS } from '../src/uploads'

const enc = (s: string) => new TextEncoder().encode(s)
const input = { docId: 'doc1', userId: 'user1', mime: 'video/mp4', name: 'clip.mp4', size: 10 }

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiw-uploads-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resumable uploads across a restart', () => {
  it('a new instance over the same directory resumes at the stored offset', async () => {
    const a = new ResumableUploads(dir)
    await a.init()
    const r = await a.create(input)
    const first = await a.append(r.id, 0, enc('hello'), async () => null)
    expect(first).toEqual({ ok: true, value: null })

    const b = new ResumableUploads(dir)
    await b.init()
    const restored = b.get(r.id, 'user1')
    expect(restored).toMatchObject({ id: r.id, docId: 'doc1', userId: 'user1', mime: 'video/mp4', name: 'clip.mp4', size: 10, offset: 5 })
    expect(b.get(r.id, 'someone-else')).toBeNull()

    const second = await b.append(r.id, 5, enc('world'), async () => null)
    expect(second).toEqual({ ok: true, value: null })
    expect(readFileSync(b.path(r.id), 'utf8')).toBe('helloworld')
    expect(b.get(r.id, 'user1')?.offset).toBe(10)
  })

  it('a stale offset after restart is refused with the stored offset', async () => {
    const a = new ResumableUploads(dir)
    await a.init()
    const r = await a.create(input)
    await a.append(r.id, 0, enc('hello'), async () => null)

    const b = new ResumableUploads(dir)
    await b.init()
    const res = await b.append(r.id, 0, enc('hello'), async () => null)
    expect(res).toEqual({ ok: false, offset: 5 })
    expect(readFileSync(b.path(r.id), 'utf8')).toBe('hello')
  })

  it('a record with a result is still answered after restart', async () => {
    const a = new ResumableUploads(dir)
    await a.init()
    const r = await a.create({ ...input, size: 5 })
    await a.append(r.id, 0, enc('hello'), async (rec) => {
      rec.result = { url: '/files/abc', id: 'abc', mime: 'video/mp4', size: 5, name: 'clip.mp4' }
      await a.dropFile(rec.id)
      return 'done'
    })

    const b = new ResumableUploads(dir)
    await b.init()
    const restored = b.get(r.id, 'user1')
    expect(restored?.result).toEqual({ url: '/files/abc', id: 'abc', mime: 'video/mp4', size: 5, name: 'clip.mp4' })
    expect(restored?.offset).toBe(5)
    expect(existsSync(b.path(r.id))).toBe(false)
  })

  it('a record without a temp file and without a result is dropped', async () => {
    const a = new ResumableUploads(dir)
    await a.init()
    const r = await a.create(input)
    rmSync(a.path(r.id))

    const b = new ResumableUploads(dir)
    await b.init()
    expect(b.get(r.id, 'user1')).toBeNull()
    expect(existsSync(join(dir, `${r.id}.json`))).toBe(false)
  })
})

describe('reconciling the temp file with the record', () => {
  it('truncates a temp file longer than the stored offset', async () => {
    const a = new ResumableUploads(dir)
    await a.init()
    const r = await a.create(input)
    await a.append(r.id, 0, enc('hello'), async () => null)
    // A crash after the append but before the sidecar write: bytes past the acknowledged offset.
    appendFileSync(a.path(r.id), enc('XYZ'))

    const b = new ResumableUploads(dir)
    await b.init()
    expect(b.get(r.id, 'user1')?.offset).toBe(5)
    expect(readFileSync(b.path(r.id), 'utf8')).toBe('hello')
  })

  it('moves the offset back to the size of a temp file shorter than the stored offset', async () => {
    const a = new ResumableUploads(dir)
    await a.init()
    const r = await a.create(input)
    await a.append(r.id, 0, enc('hello'), async () => null)
    truncateSync(a.path(r.id), 3)

    const b = new ResumableUploads(dir)
    await b.init()
    expect(b.get(r.id, 'user1')?.offset).toBe(3)
    const next = await b.append(r.id, 3, enc('lo'), async () => null)
    expect(next).toEqual({ ok: true, value: null })
    expect(readFileSync(b.path(r.id), 'utf8')).toBe('hello')
  })
})

describe('cleaning up on init', () => {
  it('removes a corrupt sidecar and its temp file', async () => {
    const a = new ResumableUploads(dir)
    await a.init()
    const r = await a.create(input)
    await a.append(r.id, 0, enc('hello'), async () => null)
    writeFileSync(join(dir, `${r.id}.json`), '{not json')

    const b = new ResumableUploads(dir)
    await b.init()
    expect(b.get(r.id, 'user1')).toBeNull()
    expect(existsSync(join(dir, `${r.id}.json`))).toBe(false)
    expect(existsSync(join(dir, r.id))).toBe(false)
  })

  it('removes a sidecar whose fields have the wrong types', async () => {
    const a = new ResumableUploads(dir)
    await a.init()
    const r = await a.create(input)
    writeFileSync(join(dir, `${r.id}.json`), JSON.stringify({ id: r.id, docId: 'doc1', userId: 'user1', mime: 'video/mp4', name: null, size: 10, offset: 'x', updatedAt: 1 }))

    const b = new ResumableUploads(dir)
    await b.init()
    expect(b.get(r.id, 'user1')).toBeNull()
    expect(existsSync(join(dir, `${r.id}.json`))).toBe(false)
    expect(existsSync(join(dir, r.id))).toBe(false)
  })

  it('removes a stray temp file that has no sidecar, and a leftover sidecar temp file', async () => {
    const a = new ResumableUploads(dir)
    await a.init()
    const r = await a.create(input)
    writeFileSync(join(dir, 'stray-upload-id'), 'bytes')
    writeFileSync(join(dir, `${r.id}.json.tmp`), '{"partial"')

    const b = new ResumableUploads(dir)
    await b.init()
    expect(existsSync(join(dir, 'stray-upload-id'))).toBe(false)
    expect(existsSync(join(dir, `${r.id}.json.tmp`))).toBe(false)
    expect(b.get(r.id, 'user1')).not.toBeNull()
  })

  it('removes idle records on init and keeps recent ones', async () => {
    let t = 1_000_000
    const a = new ResumableUploads(dir, () => t)
    await a.init()
    const old = await a.create(input)
    t += UPLOAD_IDLE_MS / 2
    const recent = await a.create(input)

    t = 1_000_000 + UPLOAD_IDLE_MS + 1
    const b = new ResumableUploads(dir, () => t)
    await b.init()
    expect(b.get(old.id, 'user1')).toBeNull()
    expect(existsSync(join(dir, old.id))).toBe(false)
    expect(existsSync(join(dir, `${old.id}.json`))).toBe(false)
    expect(b.get(recent.id, 'user1')).not.toBeNull()
  })
})

describe('idle sweep and close', () => {
  it('sweep removes records idle past UPLOAD_IDLE_MS, record and temp file together', async () => {
    let t = 1_000_000
    const a = new ResumableUploads(dir, () => t)
    await a.init()
    const r = await a.create(input)
    t += UPLOAD_IDLE_MS + 1
    expect(await a.sweep()).toBe(1)
    expect(a.get(r.id, 'user1')).toBeNull()
    expect(existsSync(join(dir, r.id))).toBe(false)
    expect(existsSync(join(dir, `${r.id}.json`))).toBe(false)
  })

  it('close keeps in-progress uploads on disk', async () => {
    const a = new ResumableUploads(dir)
    await a.init()
    a.startSweep()
    const r = await a.create(input)
    await a.append(r.id, 0, enc('hello'), async () => null)
    await a.close()
    expect(existsSync(join(dir, r.id))).toBe(true)
    expect(existsSync(join(dir, `${r.id}.json`))).toBe(true)

    const b = new ResumableUploads(dir)
    await b.init()
    expect(b.get(r.id, 'user1')?.offset).toBe(5)
    b.stopSweep()
  })
})
