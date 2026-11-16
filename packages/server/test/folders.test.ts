import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../src'
import { Store, sqliteSql } from '../src/db'

describe('folders: store', () => {
  let dir: string
  let store: Store
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-fs-'))
    store = new Store(await sqliteSql(dir))
    await store.init()
    await store.init() // the migration is safe to repeat
  })
  afterAll(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('groups documents, lists them in order, and deleting a folder keeps them', async () => {
    const f = await store.createFolder('u', '章节')
    const a = await store.createDoc('u', 'A', new Uint8Array())
    const b = await store.createDoc('u', 'B', new Uint8Array())
    const c = await store.createDoc('u', 'C', new Uint8Array())
    await store.setDocFolder(b.id, f.id)
    await store.setDocFolder(a.id, f.id)
    expect((await store.listFolderDocs(f.id)).map((d) => d.title)).toEqual(['A', 'B'])
    expect((await store.getDoc(a.id))!.folder_id).toBe(f.id)
    expect((await store.getDoc(c.id))!.folder_id).toBeNull()
    await store.renameFolder(f.id, '新名字')
    expect((await store.listFolders('u', null)).map((x) => x.name)).toEqual(['新名字'])
    await store.deleteFolder(f.id)
    expect(await store.getFolder(f.id)).toBeNull()
    expect((await store.getDoc(a.id))!.folder_id).toBeNull()
    expect(await store.getDoc(a.id)).not.toBeNull()
  })
})

describe('folders: API and roles', () => {
  let server: RunningServer
  let dir: string
  let base: string
  const call = async (path: string, init: RequestInit = {}, t = '') => {
    const res = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${t}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } })
    return { status: res.status, body: (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text() }
  }
  const json = (v: unknown): string => JSON.stringify(v)
  const register = async (email: string): Promise<string> =>
    (await (await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ email, password: 'password1' }) })).json()).token

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-fa-'))
    server = await startServer({ mode: 'web', dataDir: dir, port: 0 })
    base = `http://127.0.0.1:${server.port}`
  })
  afterAll(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates, renames, moves documents, and deleting keeps documents at the root', async () => {
    const t = await register('a@example.com')
    const folder = (await call('/api/folders', { method: 'POST', body: json({ name: ' 草稿 ' }) }, t)).body
    expect(folder.name).toBe('草稿')
    const doc = (await call('/api/docs', { method: 'POST', body: json({ title: 'D' }) }, t)).body
    expect(doc.folder_id).toBeNull()
    expect((await call(`/api/docs/${doc.id}/folder`, { method: 'PUT', body: json({ folderId: folder.id }) }, t)).status).toBe(200)
    expect((await call('/api/docs', {}, t)).body.find((d: { id: string }) => d.id === doc.id).folder_id).toBe(folder.id)
    expect((await call(`/api/folders/${folder.id}`, {}, t)).body.docs.map((d: { id: string }) => d.id)).toEqual([doc.id])
    expect((await call(`/api/folders/${folder.id}`, { method: 'PATCH', body: json({ name: '终稿' }) }, t)).status).toBe(200)
    expect((await call('/api/folders', {}, t)).body[0].name).toBe('终稿')
    // out of the folder, then back in, then the folder goes away
    expect((await call(`/api/docs/${doc.id}/folder`, { method: 'PUT', body: json({ folderId: null }) }, t)).status).toBe(200)
    await call(`/api/docs/${doc.id}/folder`, { method: 'PUT', body: json({ folderId: folder.id }) }, t)
    expect((await call(`/api/folders/${folder.id}`, { method: 'DELETE' }, t)).status).toBe(200)
    expect((await call(`/api/folders/${folder.id}`, {}, t)).status).toBe(404)
    expect((await call('/api/docs', {}, t)).body.find((d: { id: string }) => d.id === doc.id).folder_id).toBeNull()
  })

  it('keeps folders private and respects space roles', async () => {
    const owner = await register('o@example.com')
    const viewer = await register('v@example.com')
    const stranger = await register('s@example.com')
    const space = (await call('/api/spaces', { method: 'POST', body: json({ name: 'S' }) }, owner)).body.id as string
    await call(`/api/spaces/${space}/members`, { method: 'POST', body: json({ email: 'v@example.com', role: 'viewer' }) }, owner)
    const folder = (await call('/api/folders', { method: 'POST', body: json({ name: 'F', spaceId: space }) }, owner)).body
    const doc = (await call('/api/docs', { method: 'POST', body: json({ title: 'D', spaceId: space, folderId: folder.id }) }, owner)).body
    expect(doc.folder_id).toBe(folder.id)

    // a viewer can read but not change anything
    expect((await call(`/api/folders/${folder.id}`, {}, viewer)).status).toBe(200)
    expect((await call('/api/folders?space=' + space, {}, viewer)).body).toHaveLength(1)
    expect((await call('/api/folders', { method: 'POST', body: json({ name: 'X', spaceId: space }) }, viewer)).status).toBe(404)
    expect((await call(`/api/folders/${folder.id}`, { method: 'PATCH', body: json({ name: 'X' }) }, viewer)).status).toBe(404)
    expect((await call(`/api/folders/${folder.id}`, { method: 'DELETE' }, viewer)).status).toBe(404)
    expect((await call(`/api/docs/${doc.id}/folder`, { method: 'PUT', body: json({ folderId: null }) }, viewer)).status).toBe(404)
    expect((await call(`/api/folders/${folder.id}/runs`, { method: 'POST', body: json({ instruction: 'x' }) }, viewer)).status).toBe(404)

    // a stranger sees nothing
    expect((await call(`/api/folders/${folder.id}`, {}, stranger)).status).toBe(404)
    expect((await call('/api/folders?space=' + space, {}, stranger)).status).toBe(404)

    // a document cannot move into a folder of another scope
    const personal = (await call('/api/folders', { method: 'POST', body: json({ name: 'P' }) }, owner)).body
    expect((await call(`/api/docs/${doc.id}/folder`, { method: 'PUT', body: json({ folderId: personal.id }) }, owner)).status).toBe(404)
    expect((await call(`/api/docs/${doc.id}`, {}, owner)).body.folder_id).toBe(folder.id)
  })

  it('refuses a folder run with no documents', async () => {
    const t = await register('e@example.com')
    const f = (await call('/api/folders', { method: 'POST', body: json({ name: 'empty' }) }, t)).body
    const r = await call(`/api/folders/${f.id}/runs`, { method: 'POST', body: json({ instruction: 'x', modelId: 'anthropic:claude-x' }) }, t)
    expect([400, 409]).toContain(r.status)
  })
})
