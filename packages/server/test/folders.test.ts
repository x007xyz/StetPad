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
    expect((await store.listFolders('u')).map((x) => x.name)).toEqual(['新名字'])
    await store.deleteFolder(f.id)
    expect(await store.getFolder(f.id)).toBeNull()
    expect((await store.getDoc(a.id))!.folder_id).toBeNull()
    expect(await store.getDoc(a.id)).not.toBeNull()
  })
})

describe('folders: API', () => {
  let server: RunningServer
  let dir: string
  let base: string
  const call = async (path: string, init: RequestInit = {}, t = token) => {
    const res = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${t}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } })
    return { status: res.status, body: (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text() }
  }
  const json = (v: unknown): string => JSON.stringify(v)
  let token = ''

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-fa-'))
    server = await startServer({ dataDir: dir, port: 0 })
    base = `http://127.0.0.1:${server.port}`
    token = server.token
  })
  afterAll(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates, renames, moves documents, and deleting keeps documents at the root', async () => {
    const t = token
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

  it('refuses a folder run with no documents', async () => {
    const t = token
    const f = (await call('/api/folders', { method: 'POST', body: json({ name: 'empty' }) }, t)).body
    const r = await call(`/api/folders/${f.id}/runs`, { method: 'POST', body: json({ instruction: 'x', modelId: 'anthropic:claude-x' }) }, t)
    expect([400, 409]).toContain(r.status)
  })
})
