import { HocuspocusProvider } from '@hocuspocus/provider'
import { findBlock, insertBlock, projectBlocks } from '@stetpad/crdt'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { startServer, type RunningServer } from '../src'
import { Store, sqliteSql, type Sql } from '../src/db'
import { nonAsciiFixtures } from './non-ascii'

const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 8000) => {
  const t = Date.now()
  while (!(await check())) {
    if (Date.now() - t > ms) throw new Error('timed out: ' + what)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** A document state whose blocks hold these texts, as the editor would write them. */
const stateWith = (...texts: string[]): Uint8Array => {
  const doc = new Y.Doc()
  texts.forEach((t, i) => insertBlock(doc, i, 'b' + i, t))
  return Y.encodeStateAsUpdate(doc)
}

describe('search', () => {
  let server: RunningServer
  let dir: string
  let base: string
  let sql: Sql
  let store: Store
  const providers: HocuspocusProvider[] = []
  const json = (v: unknown): string => JSON.stringify(v)
  const call = async (path: string, init: RequestInit = {}, t = '') => {
    const res = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${t}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } })
    return { status: res.status, body: (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text() }
  }
  /** The single local user: the desktop token, and the user id that owns the documents. */
  const me = { token: '', id: 'local' }
  const search = async (q: string, t: string) => (await call('/api/search?q=' + encodeURIComponent(q), {}, t)).body.results as { id: string; title: string; snippet: string; titleMatch: boolean }[]

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-search-'))
    sql = await sqliteSql(dir)
    store = new Store(sql)
    await store.init()
    // The server and this test share one database connection, so a test can write rows the way old code did.
    server = await startServer({ dataDir: dir, port: 0, sql, assetGc: false })
    base = `http://127.0.0.1:${server.port}`
    me.token = server.token
  })
  afterAll(async () => {
    providers.forEach((p) => p.destroy())
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds titles first, then body text, with a snippet around the body match', async () => {
    const a = me
    const byTitle = (await call('/api/docs', { method: 'POST', body: json({ title: 'Alpha plan' }) }, a.token)).body
    // Stored directly, with no plain text yet: the search computes it from the saved state.
    const byBody = await store.createDoc(a.id, 'Zeta notes', stateWith('Nothing here', 'The alpha milestone is in March'))
    const hits = await search('ALPHA', a.token)
    expect(hits.map((h) => h.id)).toEqual([byTitle.id, byBody.id])
    expect(hits[0]).toMatchObject({ title: 'Alpha plan', snippet: '', titleMatch: true })
    expect(hits[1]!.titleMatch).toBe(false)
    expect(hits[1]!.snippet.toLowerCase()).toContain('alpha milestone')
    expect(hits[1]!.snippet.length).toBeLessThanOrEqual(110)
    // The computed text is kept for next time.
    expect((await sql.all<{ text_content: string }>('select text_content from documents where id = ?', [byBody.id]))[0]!.text_content).toContain('alpha milestone')
  })

  it.each(['missing', 'legacy'])('finds table cell text with %s stored search text', async (stored) => {
    const content = new Y.Doc()
    insertBlock(content, 0, 'p', 'Project notes')
    insertBlock(content, 1, 't', '', 'table', { rows: JSON.stringify([['Heading', ''], ['Other cell', 'Budget forecast']]) })
    const doc = await store.createDoc(me.id, 'Example table', Y.encodeStateAsUpdate(content))
    if (stored === 'legacy') {
      await sql.run('update documents set text_content = ? where id = ?', ['Project notes\n', doc.id])
    }
    try {
      expect(await search('budget forecast', me.token)).toEqual([
        expect.objectContaining({ id: doc.id, titleMatch: false, snippet: expect.stringContaining('Budget forecast') }),
      ])
      expect((await sql.all<{ text_content: string }>('select text_content from documents where id = ?', [doc.id]))[0]!.text_content).toContain('Budget forecast')
    } finally {
      await store.deleteDoc(doc.id)
    }
  })

  it.each(['missing', 'cached'])('finds rendered numbers and booleans in table cells with %s search text', async (stored) => {
    const { body: { id }, status } = await call('/api/import/create', {
      method: 'POST',
      body: json({ title: 'Imported table', blocks: [{ type: 'table', attrs: { rows: [['Values', 804632, false, null]] }, delta: [] }] }),
    }, me.token)
    expect(status).toBe(200)
    if (stored === 'cached') {
      await sql.run('update documents set text_content = ?, search_text_version = 1 where id = ?', ['Values', id])
    }
    try {
      for (const query of ['804632', 'false']) {
        const hit = (await search(query, me.token)).find((result) => result.id === id)
        expect(hit).toMatchObject({ id, titleMatch: false, snippet: expect.stringContaining(query) })
      }
      expect(await search('null', me.token)).toEqual([])
    } finally {
      await store.deleteDoc(id)
    }
  })

  it.each(['école', 'ÉCOLE', 'École'])('finds Unicode titles for %s regardless of case', async (query) => {
    const docs = []
    for (const title of ['ÉCOLE Notes', 'école Notes', 'École Notes']) {
      docs.push(await store.createDoc(me.id, title, stateWith('Nothing here')))
    }
    const hits = await search(query, me.token)
    for (const doc of docs) {
      expect(hits).toContainEqual(expect.objectContaining({ id: doc.id, title: doc.title, titleMatch: true, snippet: '' }))
      await store.deleteDoc(doc.id)
    }
    expect(await search('écolière', me.token)).toEqual([])
  })

  for (const fixture of nonAsciiFixtures) {
    it.each(fixture.queries)(`finds ${fixture.name} titles for %s`, async (query) => {
      const doc = await store.createDoc(me.id, fixture.title, stateWith('Unrelated body'))
      try {
        expect(await search(query, me.token)).toContainEqual(expect.objectContaining({ id: doc.id, title: fixture.title, titleMatch: true, snippet: '' }))
      } finally {
        await store.deleteDoc(doc.id)
      }
    })

    it(`finds unchanged ${fixture.name} body text`, async () => {
      const doc = await store.createDoc(me.id, 'Unrelated title', stateWith(fixture.content))
      try {
        expect(await search(fixture.bodyQuery, me.token)).toContainEqual(expect.objectContaining({ id: doc.id, titleMatch: false, snippet: fixture.content }))
      } finally {
        await store.deleteDoc(doc.id)
      }
    })

    it(`finds case-insensitive ${fixture.name} body text`, async () => {
      const query = fixture.caseContent.toLowerCase()
      const doc = await store.createDoc(me.id, 'Unrelated title', stateWith(fixture.caseContent))
      try {
        expect(await search(query, me.token)).toContainEqual(expect.objectContaining({ id: doc.id, titleMatch: false, snippet: fixture.caseContent }))
        expect(await search(query + 'missing', me.token)).toEqual([])
      } finally {
        await store.deleteDoc(doc.id)
      }
    })
  }

  it('keeps the body match in the snippet after lowercase expansions', async () => {
    const doc = await store.createDoc(me.id, 'Expanded body', stateWith('İ'.repeat(100) + ' foo ' + 'x'.repeat(200)))
    const hits = await search('foo', me.token)
    expect(hits.find((h) => h.id === doc.id)?.snippet).toContain('foo')
    await store.deleteDoc(doc.id)
  })

  it('returns nothing for a blank query', async () => {
    const a = me
    await call('/api/docs', { method: 'POST', body: json({ title: 'Something' }) }, a.token)
    expect((await call('/api/search?q=', {}, a.token)).body).toEqual({ results: [] })
    expect((await call('/api/search?q=%20%20', {}, a.token)).body).toEqual({ results: [] })
    expect((await call('/api/search', {}, a.token)).body).toEqual({ results: [] })
  })

  it('treats % and _ as plain characters', async () => {
    const a = me
    const pct = await store.createDoc(a.id, 'Wild', stateWith('Progress is 100% done'))
    await store.createDoc(a.id, 'Other', stateWith('Progress is 1000 done and axb'))
    expect((await search('100%', a.token)).map((h) => h.id)).toEqual([pct.id])
    expect(await search('a_b', a.token)).toEqual([])
    expect(await search('%', a.token)).toHaveLength(1)
  })

  it('leaves out trashed documents', async () => {
    const a = me
    const d = (await call('/api/docs', { method: 'POST', body: json({ title: 'Gone soon' }) }, a.token)).body
    expect(await search('gone', a.token)).toHaveLength(1)
    await call(`/api/docs/${d.id}`, { method: 'DELETE' }, a.token)
    expect(await search('gone', a.token)).toEqual([])
  })

  it('keeps the text current as a document is edited live', async () => {
    const a = me
    const id = (await call('/api/docs', { method: 'POST', body: json({ title: 'Live' }) }, a.token)).body.id as string
    const provider = new HocuspocusProvider({ url: base.replace('http', 'ws') + '/collab', name: id, document: new Y.Doc(), token: a.token })
    providers.push(provider)
    const doc = provider.document
    await until(() => projectBlocks(doc, 'physical').length === 1, 'initial block')
    insertBlock(doc, 1, 'bz', 'Zebra crossing notes')
    await until(async () => ((await sql.all<{ text_content: string | null }>('select text_content from documents where id = ?', [id]))[0]?.text_content ?? '').includes('Zebra'), 'text saved', 10000)
    expect((await search('zebra', a.token)).map((h) => h.id)).toEqual([id])
  })

  it('updates the stored search text when a live table cell changes', async () => {
    const { body: { id } } = await call('/api/import/create', {
      method: 'POST',
      body: json({ title: 'Live table', blocks: [{ type: 'table', attrs: { rows: [['Previous cell']] }, delta: [] }] }),
    }, me.token)
    await search('Previous cell', me.token)
    const provider = new HocuspocusProvider({ url: base.replace('http', 'ws') + '/collab', name: id, document: new Y.Doc(), token: me.token })
    providers.push(provider)
    const doc = provider.document
    await until(() => projectBlocks(doc, 'physical').length === 1, 'initial table')
    await until(() => provider.synced, 'provider sync')
    const tableId = projectBlocks(doc, 'physical')[0]!.blockId
    doc.transact(() => {
      findBlock(doc, tableId)!.setAttribute('rows', JSON.stringify([['Updated cell']]))
      insertBlock(doc, 1, 'p', 'New paragraph')
    })
    await until(async () => ((await sql.all<{ text_content: string | null }>('select text_content from documents where id = ?', [id]))[0]?.text_content ?? '').includes('New paragraph'), 'text saved')
    expect((await search('Updated cell', me.token)).map((h) => h.id)).toEqual([id])
    expect(await search('Previous cell', me.token)).toEqual([])
  })

  it('returns at most 30 hits', async () => {
    const a = me
    for (let i = 0; i < 32; i++) await store.createDoc(a.id, `Bulk ${i}`, stateWith('x'))
    expect(await search('bulk', a.token)).toHaveLength(30)
  })

  it('returns snippets for the highest-ranked hits when more than 30 match', async () => {
    const titleOnly = await store.createDoc(me.id, 'Ranked outline', stateWith('Other text'))
    const titleAndBody = await store.createDoc(me.id, 'Ranked draft', stateWith('A ranked draft'))
    const bodyHits = []
    for (let i = 0; i < 32; i++) {
      const title = `Note ${i}`
      const snippet = `Ranked paragraph ${i}`
      const { id } = await store.createDoc(me.id, title, stateWith(snippet))
      bodyHits.push({ id, title, snippet, titleMatch: false })
    }

    expect(await search('ranked', me.token)).toMatchObject([
      { id: titleAndBody.id, title: titleAndBody.title, snippet: 'A ranked draft', titleMatch: true },
      { id: titleOnly.id, title: titleOnly.title, snippet: '', titleMatch: true },
      ...bodyHits.slice(-28).reverse(),
    ])
  })
})
