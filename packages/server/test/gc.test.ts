import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type RunningServer, type ServerConfig } from '../src'
import { sqliteSql, type Sql } from '../src/db'

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
/** PNG bytes with a tag appended, so each test's upload is a different file (the server does not parse images on upload). */
const pngWith = (tag: string) => Uint8Array.from([...PNG, ...new TextEncoder().encode(tag)])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Host {
  server: RunningServer
  base: string
  token: string
  dir: string
  /** Direct database access, to age rows in tests. */
  sql: Sql
}

async function boot(options: Partial<ServerConfig> = {}): Promise<Host> {
  const dir = mkdtempSync(join(tmpdir(), 'aiw-gc-'))
  // The timer is off: each test runs the collector itself.
  const server = await startServer({ dataDir: dir, port: 0, assetGc: false, ...options })
  const base = `http://127.0.0.1:${server.port}`
  return { server, base, token: server.token, dir, sql: await sqliteSql(dir) }
}

/** Pretends an asset was created `ms` ago. */
const age = (h: Host, id: string, ms: number) => h.sql.run('update assets set created_at = ? where id = ?', [Date.now() - ms, id])

/** A JSON API call as the owner of the host. */
const api = (h: Host, path: string, init: RequestInit & { json?: unknown } = {}, token = h.token) => {
  const { json, ...rest } = init
  return fetch(h.base + '/api' + path, {
    ...rest,
    headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
}

const newDoc = async (h: Host, blocks: unknown[] = [], token = h.token): Promise<string> => {
  const res = await api(h, '/import/create', { method: 'POST', json: { title: 'gc', blocks } }, token)
  return (await res.json()).id as string
}

/** Uploads raw bytes as an image into a document. Returns the id and the url the document should use. */
async function upload(h: Host, docId: string, bytes: Uint8Array<ArrayBuffer>, token = h.token): Promise<{ id: string; url: string }> {
  const res = await fetch(`${h.base}/api/docs/${docId}/assets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
    body: bytes,
  })
  expect(res.status).toBe(200)
  const body = await res.json()
  return { id: body.id as string, url: body.url as string }
}

const imageBlock = (url: string) => ({ type: 'image', attrs: { src: url, alt: 'pic' }, delta: [] })
const served = async (h: Host, url: string) => (await fetch(h.base + url)).status

describe('asset garbage collection', () => {
  let h: Host

  beforeAll(async () => {
    h = await boot()
  })
  afterAll(async () => {
    await h.server.close()
    rmSync(h.dir, { recursive: true, force: true })
  })

  it('removes an unreferenced file, and keeps one a document uses', async () => {
    const doc1 = await newDoc(h)
    const a = await upload(h, doc1, pngWith('a'))
    const b = await upload(h, doc1, pngWith('b'))
    // Only A is referenced: the block is added to the document through an import.
    await api(h, `/docs/${doc1}/clip`, { method: 'POST', json: { asSuggestion: false, blocks: [imageBlock(a.url)] } })
    await sleep(5)

    const file = (id: string) => join(h.dir, 'assets', id)
    expect(existsSync(file(b.id))).toBe(true)
    const result = await h.server.gcAssets({ graceMs: 0 })
    expect(result.removed).toContain(b.id)
    expect(result.removed).not.toContain(a.id)
    expect(await served(h, b.url)).toBe(404)
    expect(existsSync(file(b.id))).toBe(false)
    expect(await served(h, a.url)).toBe(200)
    expect(existsSync(file(a.id))).toBe(true)
  })

  it('keeps a fresh unreferenced upload within the default grace period', async () => {
    const doc = await newDoc(h)
    const fresh = await upload(h, doc, pngWith('fresh'))
    const result = await h.server.gcAssets()
    expect(result.removed).not.toContain(fresh.id)
    expect(await served(h, fresh.url)).toBe(200)
    expect(existsSync(join(h.dir, 'assets', fresh.id))).toBe(true)
  })

  it('keeps a file that only a version refers to', async () => {
    const doc = await newDoc(h)
    // Version 0 is the empty document. The picture goes in after it, and version 1 is taken with the picture.
    const v0 = await (await api(h, `/docs/${doc}/versions`, { method: 'POST', json: { label: 'empty' } })).json()
    expect(v0.id).toBeTruthy()
    const img = await upload(h, doc, pngWith('versioned'))
    await api(h, `/docs/${doc}/clip`, { method: 'POST', json: { asSuggestion: false, blocks: [imageBlock(img.url)] } })
    await api(h, `/docs/${doc}/versions`, { method: 'POST', json: { label: 'with picture' } })
    // Restoring version 0 takes the picture out of the current text (the restore keeps a snapshot of it too).
    expect((await api(h, `/versions/${v0.id}/restore`, { method: 'POST' })).status).toBe(200)
    const md = await (await api(h, `/docs/${doc}/export?format=md`)).text()
    expect(md).not.toContain(img.url)

    await sleep(5)
    const result = await h.server.gcAssets({ graceMs: 0 })
    expect(result.removed).not.toContain(img.id)
    expect(await served(h, img.url)).toBe(200)
  })

  it('a file linked from another document survives purging its owner, and goes when the last link is deleted', async () => {
    const doc1 = await newDoc(h)
    const img = await upload(h, doc1, pngWith('shared'))
    const doc2 = await newDoc(h, [imageBlock(img.url)])
    // doc1 keeps its own copy of the link; doc2 refers to the same file.
    await api(h, `/docs/${doc1}/clip`, { method: 'POST', json: { asSuggestion: false, blocks: [imageBlock(img.url)] } })

    expect((await api(h, `/docs/${doc1}`, { method: 'DELETE' })).status).toBe(200)
    expect((await api(h, `/docs/${doc1}/purge`, { method: 'DELETE' })).status).toBe(200)
    expect(await served(h, img.url)).toBe(200)
    expect(existsSync(join(h.dir, 'assets', img.id))).toBe(true)

    expect((await api(h, `/docs/${doc2}`, { method: 'DELETE' })).status).toBe(200)
    expect((await api(h, `/docs/${doc2}/purge`, { method: 'DELETE' })).status).toBe(200)
    // Uploaded moments ago, so the immediate collection leaves it (an edit naming it may still be in flight)…
    expect(await served(h, img.url)).toBe(200)
    // …and the next periodic run removes it.
    await h.server.gcAssets({ graceMs: 0 })
    expect(await served(h, img.url)).toBe(404)
    expect(existsSync(join(h.dir, 'assets', img.id))).toBe(false)
  })

  it('purging a document removes its older unshared files at once', async () => {
    const doc = await newDoc(h)
    const img = await upload(h, doc, pngWith('old-unshared'))
    await api(h, `/docs/${doc}/clip`, { method: 'POST', json: { asSuggestion: false, blocks: [imageBlock(img.url)] } })
    await age(h, img.id, 60 * 60 * 1000)
    expect((await api(h, `/docs/${doc}`, { method: 'DELETE' })).status).toBe(200)
    expect((await api(h, `/docs/${doc}/purge`, { method: 'DELETE' })).status).toBe(200)
    expect(await served(h, img.url)).toBe(404)
  })

  it('uploads the same bytes once and reuses the file', async () => {
    const doc1 = await newDoc(h)
    const doc2 = await newDoc(h)
    const bytes = pngWith('dedup')
    const first = await upload(h, doc1, bytes)
    const again = await upload(h, doc2, bytes)
    // The second upload is answered with the first file; no second copy is written.
    expect(again.id).toBe(first.id)
    expect(again.url).toBe(first.url)
    expect(existsSync(join(h.dir, 'assets', first.id))).toBe(true)
    expect(await served(h, first.url)).toBe(200)
  })
})
