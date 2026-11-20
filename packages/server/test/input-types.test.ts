import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../src'

describe('document input types', () => {
  let server: RunningServer
  let dir: string
  let base: string
  let docId: string
  const call = async (path: string, method: string, body: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() }
  }
  const blocks = [{ type: 'paragraph', delta: [{ insert: 'Clipped text' }] }]

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-input-'))
    server = await startServer({ dataDir: dir, port: 0 })
    base = `http://127.0.0.1:${server.port}`
    docId = (await call('/api/docs', 'POST', { title: 'Input types' })).body.id
  })
  afterAll(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it.each([{}, 42, false, []])('rejects non-string folder IDs (%j)', async (folderId) => {
    expect(await call(`/api/docs/${docId}/folder`, 'PUT', { folderId })).toEqual({ status: 400, body: { error: expect.any(String) } })
  })

  it.each([5, {}, false, []])('rejects non-string version labels (%j)', async (label) => {
    expect(await call(`/api/docs/${docId}/versions`, 'POST', { label })).toEqual({ status: 400, body: { error: expect.any(String) } })
  })

  it.each(['author', 'reason'])('rejects non-string clip %s', async (field) => {
    expect(await call(`/api/docs/${docId}/clip`, 'POST', { blocks, [field]: 4 })).toEqual({ status: 400, body: { error: expect.any(String) } })
  })

  it('accepts a folder ID and null to move back to the root', async () => {
    const folder = (await call('/api/folders', 'POST', { name: 'Folder' })).body
    expect(await call(`/api/docs/${docId}/folder`, 'PUT', { folderId: folder.id })).toEqual({ status: 200, body: { ok: true } })
    expect(await call(`/api/docs/${docId}/folder`, 'PUT', { folderId: null })).toEqual({ status: 200, body: { ok: true } })
  })

  it.each([{}, { label: '' }, { label: ' Named version ', trigger: 'reviewed' }])('accepts optional version labels (%j)', async (body) => {
    const result = await call(`/api/docs/${docId}/versions`, 'POST', body)
    expect(result.status).toBe(200)
    expect(result.body).toHaveProperty('id')
    expect(result.body.id === null || typeof result.body.id === 'string').toBe(true)
  })

  it.each([{}, { author: '', reason: '' }, { author: 'Browser', reason: 'Saved page', asSuggestion: false }])('accepts optional clip metadata (%j)', async (body) => {
    expect(await call(`/api/docs/${docId}/clip`, 'POST', { blocks, ...body })).toMatchObject({ status: 200, body: { ok: true, blockCount: expect.any(Number) } })
  })

  it('rejects empty clip content', async () => {
    expect(await call(`/api/docs/${docId}/clip`, 'POST', { blocks: [] })).toEqual({ status: 400, body: { error: expect.any(String) } })
  })
})
