import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../src'
import { Store, sqliteSql, type Sql } from '../src/db'

describe('trash', () => {
  let server: RunningServer
  let dir: string
  let base: string
  let sql: Sql
  let store: Store
  let token = ''
  const json = (v: unknown): string => JSON.stringify(v)
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } })
    return { status: res.status, body: (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text() }
  }
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

  beforeAll(async () => {
    // Read when the server starts: the trash keeps documents for 30 days.
    const saved = process.env.AIW_TRASH_DAYS
    process.env.AIW_TRASH_DAYS = '30'
    dir = mkdtempSync(join(tmpdir(), 'aiw-trash-'))
    sql = await sqliteSql(dir)
    store = new Store(sql)
    await store.init()
    server = await startServer({ dataDir: dir, port: 0, sql, assetGc: false })
    base = `http://127.0.0.1:${server.port}`
    token = server.token
    if (saved === undefined) delete process.env.AIW_TRASH_DAYS
    else process.env.AIW_TRASH_DAYS = saved
  })
  afterAll(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('moves a deleted document out of every list and page', async () => {
    const d = (await call('/api/docs', { method: 'POST', body: json({ title: 'Draft' }) })).body

    expect((await call(`/api/docs/${d.id}`, { method: 'DELETE' })).body).toEqual({ ok: true })
    expect(ids((await call('/api/docs')).body)).not.toContain(d.id)
    expect((await call(`/api/docs/${d.id}`)).status).toBe(404)
    expect((await call(`/api/docs/${d.id}/versions`)).status).toBe(404)
    expect((await call(`/api/docs/${d.id}`, { method: 'DELETE' })).status).toBe(404)

    const trash = (await call('/api/trash')).body as { id: string; deleted_at: number }[]
    expect(ids(trash)).toEqual([d.id])
    expect(typeof trash[0]!.deleted_at).toBe('number')
    await call(`/api/docs/${d.id}/purge`, { method: 'DELETE' })
  })

  it('restores a trashed document, and restoring a live one is not found', async () => {
    const d = (await call('/api/docs', { method: 'POST', body: json({ title: 'Keep me' }) })).body
    await call(`/api/docs/${d.id}`, { method: 'DELETE' })
    expect(ids((await call('/api/trash')).body)).toEqual([d.id])

    expect((await call(`/api/docs/${d.id}/restore`, { method: 'POST' })).body).toEqual({ ok: true })
    expect(ids((await call('/api/docs')).body)).toContain(d.id)
    expect((await call('/api/trash')).body).toEqual([])
    // Restoring a live document is not found.
    expect((await call(`/api/docs/${d.id}/restore`, { method: 'POST' })).status).toBe(404)
  })

  it('purges only a trashed document', async () => {
    const live = (await call('/api/docs', { method: 'POST', body: json({ title: 'Live' }) })).body
    const doomed = (await call('/api/docs', { method: 'POST', body: json({ title: 'Doomed' }) })).body

    // Purging a live document is not found.
    expect((await call(`/api/docs/${live.id}/purge`, { method: 'DELETE' })).status).toBe(404)

    await call(`/api/docs/${doomed.id}`, { method: 'DELETE' })
    expect((await call(`/api/docs/${doomed.id}/purge`, { method: 'DELETE' })).body).toEqual({ ok: true })

    expect(await store.getDocAny(doomed.id)).toBeNull()
    expect((await call('/api/trash')).body).toEqual([])
    expect((await call(`/api/docs/${doomed.id}/purge`, { method: 'DELETE' })).status).toBe(404)
    expect(await store.getDocAny(live.id)).not.toBeNull()
  })

  it('lists the trash newest deletion first', async () => {
    const p1 = (await call('/api/docs', { method: 'POST', body: json({ title: 'P1' }) })).body
    const p2 = (await call('/api/docs', { method: 'POST', body: json({ title: 'P2' }) })).body
    await call(`/api/docs/${p1.id}`, { method: 'DELETE' })
    await call(`/api/docs/${p2.id}`, { method: 'DELETE' })
    expect(ids((await call('/api/trash')).body)).toEqual([p2.id, p1.id])
  })

  it('auto-purges documents trashed longer than AIW_TRASH_DAYS ago, and no others', async () => {
    const old = (await call('/api/docs', { method: 'POST', body: json({ title: 'Old' }) })).body
    const fresh = (await call('/api/docs', { method: 'POST', body: json({ title: 'Fresh' }) })).body
    await call(`/api/docs/${old.id}`, { method: 'DELETE' })
    await call(`/api/docs/${fresh.id}`, { method: 'DELETE' })
    await sql.run('update documents set deleted_at = ? where id = ?', [Date.now() - 31 * 86400_000, old.id])

    expect(await server.purgeTrash()).toEqual([old.id])
    expect(await store.getDocAny(old.id)).toBeNull()
    expect((await store.getDocAny(fresh.id))?.deleted_at).toBeGreaterThan(0)
    expect(ids((await call('/api/trash')).body)).toContain(fresh.id)
    expect(ids((await call('/api/trash')).body)).not.toContain(old.id)
  })

  it('closes the live connections of a deleted document', async () => {
    // Reconnecting is refused once the document is in the trash.
    const { HocuspocusProvider } = await import('@hocuspocus/provider')
    const Y = await import('yjs')
    const d = (await call('/api/docs', { method: 'POST', body: json({ title: 'Live link' }) })).body
    const provider = new HocuspocusProvider({ url: base.replace('http', 'ws') + '/collab', name: d.id, document: new Y.Doc(), token })
    const until = async (check: () => boolean, ms = 8000) => {
      const t = Date.now()
      while (!check()) {
        if (Date.now() - t > ms) throw new Error('timed out')
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    try {
      await until(() => provider.isAuthenticated)
      await call(`/api/docs/${d.id}`, { method: 'DELETE' })
      await until(() => !provider.isAuthenticated)
    } finally {
      provider.destroy()
    }
  })
})
