import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../src'
import { prepareRenders, RenderCache } from '../src/render'

const SOURCE = 'flowchart TD\nA-->B'
const MARK = '<rect width="21" height="21" class="cached-mermaid"/>'
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">${MARK}</svg>`

describe('RenderCache', () => {
  it('stores sanitized svg by trimmed source and ignores what cannot be stored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiw-cache-'))
    try {
      const cache = new RenderCache(join(dir, 'renders'))
      await cache.put(`  ${SOURCE}\n`, '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script><rect width="1" height="1"/></svg>')
      const hit = await cache.get(SOURCE)
      expect(hit?.svg).toContain('<rect')
      expect(hit?.svg).not.toContain('<script')
      expect(hit?.raster).toBeUndefined()
      await cache.put('bad', 'not an svg')
      expect(await cache.get('bad')).toBeNull()
      expect(await cache.get('')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('prepareRenders with the cache', () => {
  it('uses the cached svg when the browser sent none, and caches the browser svg otherwise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiw-cache-'))
    try {
      const cache = new RenderCache(join(dir, 'renders'))
      const block = (id: string, source: string) =>
        ({ type: 'codeBlock', attrs: { language: 'mermaid' }, delta: [{ insert: source }], blockId: id }) as unknown as Parameters<typeof prepareRenders>[0][number]
      const first = await prepareRenders([block('d1', SOURCE)], { d1: SVG }, { png: false, cache })
      expect(first.svg.d1).toContain(MARK)
      const second = await prepareRenders([block('d2', SOURCE)], undefined, { png: false, cache })
      expect(second.svg.d2).toContain(MARK)
      const none = await prepareRenders([block('d3', 'pie title Other')], undefined, { png: false, cache })
      expect(none.svg.d3).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('mermaid diagrams in exports', () => {
  let server: RunningServer
  let dir: string
  let base: string
  let token = ''
  let docId = ''

  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    })
    const ct = res.headers.get('content-type') ?? ''
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() }
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-mermaid-export-'))
    server = await startServer({ dataDir: dir, port: 0 })
    base = `http://127.0.0.1:${server.port}`
    token = server.token ?? ''
    const made = await call('/api/import/create', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Mermaid',
        blocks: [
          { type: 'paragraph', attrs: {}, delta: [{ insert: 'Intro' }] },
          { type: 'codeBlock', attrs: { language: 'mermaid' }, delta: [{ insert: SOURCE }] },
        ],
      }),
    })
    docId = made.body.id as string
  })

  afterAll(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps inline math when a document is created from imported blocks', async () => {
    const made = await call('/api/import/create', {
      method: 'POST',
      body: JSON.stringify({ title: 'Math', blocks: [{ type: 'paragraph', attrs: {}, delta: [{ insert: 'a ' }, { insert: 'x^2', attributes: { math: true } }] }] }),
    })
    const md = await call(`/api/docs/${made.body.id}/export?format=md`)
    expect(md.body).toContain('a $x^2$')
  })

  it('PUT renders then GET html export includes the cached svg', async () => {
    const put = await call(`/api/docs/${docId}/renders`, { method: 'PUT', body: JSON.stringify({ source: SOURCE, svg: SVG }) })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ ok: true })
    const html = await call(`/api/docs/${docId}/export?format=html`)
    expect(html.status).toBe(200)
    expect(html.body).toContain('<svg')
    expect(html.body).toContain('cached-mermaid')
  })

  it('PUT rejects a non-svg body and a missing source', async () => {
    const bad = await call(`/api/docs/${docId}/renders`, { method: 'PUT', body: JSON.stringify({ source: SOURCE, svg: '<div></div>' }) })
    expect(bad.status).toBe(400)
    const noSource = await call(`/api/docs/${docId}/renders`, { method: 'PUT', body: JSON.stringify({ svg: SVG }) })
    expect(noSource.status).toBe(400)
  })

  it('GET export/diagrams lists the mermaid source of the original view', async () => {
    const r = await call(`/api/docs/${docId}/export/diagrams?view=original`)
    expect(r.status).toBe(200)
    const diagrams = r.body.diagrams as { blockId: string; source: string }[]
    expect(diagrams.map((d) => d.source)).toEqual([SOURCE])
    expect(diagrams[0]!.blockId).toBeTruthy()
  })

  it('export/diagrams rejects an unknown token', async () => {
    const r = await call(`/api/docs/${docId}/export/diagrams?view=original`, { headers: { authorization: 'Bearer nope' } })
    expect(r.status).toBe(401)
  })
})

describe('render cache scope', () => {
  it('keeps one document\'s renders away from another document', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { RenderCache } = await import('../src/render')
    const cache = new RenderCache(mkdtempSync(join(tmpdir(), 'rc-')))
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
    await cache.forDoc('a').put('graph TD; A-->B', svg)
    expect(await cache.forDoc('a').get('graph TD; A-->B')).not.toBeNull()
    expect(await cache.forDoc('b').get('graph TD; A-->B')).toBeNull()
  })
})

describe('render cache clear', () => {
  it('removes a document\'s renders and only those', async () => {
    const { RenderCache } = await import('../src/render')
    const cache = new RenderCache(mkdtempSync(join(tmpdir(), 'rc-')))
    await cache.forDoc('a').put(SOURCE, SVG)
    await cache.forDoc('b').put(SOURCE, SVG)
    await cache.forDoc('a').clear()
    expect(await cache.forDoc('a').get(SOURCE)).toBeNull()
    expect(await cache.forDoc('b').get(SOURCE)).not.toBeNull()
  })
})
