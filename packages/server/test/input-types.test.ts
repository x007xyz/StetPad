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
  const send = async (path: string, method: string, body: string) => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body,
    })
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() }
  }
  const call = (path: string, method: string, body: unknown) => send(path, method, JSON.stringify(body))
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

  it.each([
    ['PUT', '/api/docs/:id/folder'],
    ['PUT', '/api/settings'],
    ['POST', '/api/docs/:id/external-runs'],
  ])('%s %s rejects invalid JSON bodies', async (method, path) => {
    for (const body of ['not json', 'null', '5']) {
      expect(await send(path.replace(':id', docId), method, body)).toEqual({ status: 400, body: { error: 'bad request' } })
    }
  })

  it.each([5, {}, false, []])('rejects non-string version labels (%j)', async (label) => {
    expect(await call(`/api/docs/${docId}/versions`, 'POST', { label })).toEqual({ status: 400, body: { error: expect.any(String) } })
  })

  it.each(['author', 'reason'])('rejects non-string clip %s', async (field) => {
    expect(await call(`/api/docs/${docId}/clip`, 'POST', { blocks, [field]: 4 })).toEqual({ status: 400, body: { error: expect.any(String) } })
  })

  describe('chat titles and run instructions', () => {
    let chatId: string
    let folderId: string
    beforeAll(async () => {
      chatId = (await call(`/api/docs/${docId}/chats`, 'POST', {})).body.chat.id
      folderId = (await call('/api/folders', 'POST', { name: 'Runs' })).body.id
    })
    const routes = () => [
      { path: `/api/docs/${docId}/chats`, method: 'POST', field: 'title' },
      { path: `/api/chats/${chatId}`, method: 'PATCH', field: 'title' },
      { path: `/api/docs/${docId}/runs`, method: 'POST', field: 'instruction' },
      { path: `/api/folders/${folderId}/runs`, method: 'POST', field: 'instruction' },
    ]

    it.each([0, 1, 2, 3])('route %i rejects non-string fields and invalid bodies', async (index) => {
      const { path, method, field } = routes()[index]!
      for (const value of [5, {}, false, [], null]) {
        expect(await call(path, method, { [field]: value, modelId: 'openai:gpt-4o-mini' })).toEqual({ status: 400, body: { error: expect.any(String) } })
      }
      for (const body of ['not json', 'null', '5']) {
        expect(await send(path, method, body)).toEqual({ status: 400, body: { error: expect.any(String) } })
      }
    })

    it('accepts and trims string chat titles and permits an omitted create title', async () => {
      expect((await call(`/api/docs/${docId}/chats`, 'POST', {})).status).toBe(200)
      const created = await call(`/api/docs/${docId}/chats`, 'POST', { title: ' Chat ' })
      expect(created).toMatchObject({ status: 200, body: { chat: { title: 'Chat' } } })
      expect((await call(`/api/chats/${created.body.chat.id}`, 'PATCH', { title: ' Renamed ' })).status).toBe(200)
      expect((await call(`/api/docs/${docId}/chats`, 'GET', undefined)).body.chats).toContainEqual(expect.objectContaining({ id: created.body.chat.id, title: 'Renamed' }))
      expect((await call(`/api/chats/${chatId}`, 'PATCH', { title: ' ' })).status).toBe(400)
    })

    it.each([2, 3])('run route %i rejects empty instructions', async (index) => {
      const { path, method } = routes()[index]!
      for (const instruction of [undefined, '', ' ']) {
        expect(await call(path, method, { instruction, modelId: 'openai:gpt-4o-mini' })).toEqual({ status: 400, body: { error: '请输入指令' } })
      }
    })
  })

  describe('version label length', () => {
    it.each([201, 8192])('rejects %i-character labels on create and rename', async (length) => {
      const version = await call(`/api/docs/${docId}/versions`, 'POST', { label: 'Original' })
      const before = (await call(`/api/docs/${docId}/versions`, 'GET', undefined)).body
      const label = '字'.repeat(length)
      expect(await call(`/api/docs/${docId}/versions`, 'POST', { label })).toEqual({ status: 400, body: { error: expect.any(String) } })
      expect(await call(`/api/versions/${version.body.id}`, 'PATCH', { label })).toEqual({ status: 400, body: { error: expect.any(String) } })
      expect((await call(`/api/docs/${docId}/versions`, 'GET', undefined)).body).toEqual(before)
    })

    it('accepts 200-character trimmed labels and still allows clearing a label', async () => {
      const label = '字'.repeat(200)
      const version = await call(`/api/docs/${docId}/versions`, 'POST', { label: ` ${label} ` })
      expect(version.status).toBe(200)
      const path = `/api/versions/${version.body.id}`
      expect((await call(path, 'GET', undefined)).body.label).toBe(label)
      expect((await call(path, 'PATCH', { label: ` ${label} ` })).status).toBe(200)
      expect((await call(path, 'GET', undefined)).body.label).toBe(label)
      expect((await call(path, 'PATCH', { label: '   ' })).status).toBe(200)
      expect((await call(path, 'GET', undefined)).body.label).toBe('')
    })
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

  describe('rename and create routes', () => {
    let folderId: string
    let versionId: string
    beforeAll(async () => {
      folderId = (await call('/api/folders', 'POST', { name: 'Rename me' })).body.id
      versionId = (await call(`/api/docs/${docId}/versions`, 'POST', { label: 'v1' })).body.id
    })
    const route = (name: string) => ({
      'PATCH /docs/:id': { method: 'PATCH', path: `/api/docs/${docId}`, field: 'title', rest: {} },
      'PATCH /folders/:id': { method: 'PATCH', path: `/api/folders/${folderId}`, field: 'name', rest: {} },
      'PATCH /versions/:vid': { method: 'PATCH', path: `/api/versions/${versionId}`, field: 'label', rest: {} },
      'POST /import/create': { method: 'POST', path: '/api/import/create', field: 'title', rest: { blocks } },
      'POST /clipper/tokens': { method: 'POST', path: '/api/clipper/tokens', field: 'name', rest: {} },
    })[name]!
    const all = ['PATCH /docs/:id', 'PATCH /folders/:id', 'PATCH /versions/:vid', 'POST /import/create', 'POST /clipper/tokens']

    it.each(all)('%s rejects a non-string field', async (name) => {
      const { method, path, field, rest } = route(name)
      for (const value of [5, {}, false, []]) {
        expect(await call(path, method, { ...rest, [field]: value })).toEqual({ status: 400, body: { error: expect.any(String) } })
      }
    })

    // The clipper token route keeps treating a missing or unreadable body as "use the default name".
    it.each(all.slice(0, 4))('%s rejects a body that is not a JSON object', async (name) => {
      const { method, path } = route(name)
      for (const body of ['not json', 'null', '5']) {
        expect(await send(path, method, body)).toEqual({ status: 400, body: { error: expect.any(String) } })
      }
    })

    it('rejects a non-string import folder ID', async () => {
      expect(await call('/api/import/create', 'POST', { blocks, folderId: 5 })).toEqual({ status: 400, body: { error: expect.any(String) } })
    })

    it.each(all)('%s accepts a string field', async (name) => {
      const { method, path, field, rest } = route(name)
      expect((await call(path, method, { ...rest, [field]: ' Renamed ' })).status).toBe(200)
    })

    it('saves the trimmed names', async () => {
      expect((await call(`/api/docs/${docId}`, 'GET', undefined)).body.title).toBe('Renamed')
      expect((await call(`/api/folders/${folderId}`, 'GET', undefined)).body.name).toBe('Renamed')
      expect((await call(`/api/versions/${versionId}`, 'GET', undefined)).body.label).toBe('Renamed')
    })
  })
})
