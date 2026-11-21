import { listChanges } from '@stetpad/crdt'
import { unzipSync } from 'fflate'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { startServer, type RunningServer, type ServerConfig } from '../src'
import { nonAsciiFixtures } from './non-ascii'

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
/** Stands in for an mp4. The server never parses media, so ten known bytes are enough. */
const VIDEO = Uint8Array.from([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])

interface Host {
  server: RunningServer
  base: string
  token: string
  dir: string
}

async function boot(options: Partial<ServerConfig> = {}): Promise<Host> {
  const dir = mkdtempSync(join(tmpdir(), 'aiw-package-'))
  const server = await startServer({ dataDir: dir, port: 0, ...options })
  const base = `http://127.0.0.1:${server.port}`
  return { server, base, token: server.token, dir }
}

/** One authorized API call. `json` sends a JSON body; `body` sends the raw body with `type` as its Content-Type. */
const send = (h: Host, path: string, init: { method?: string; json?: unknown; body?: BodyInit; type?: string } = {}) => {
  const headers: Record<string, string> = { authorization: `Bearer ${h.token}` }
  let body = init.body
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(init.json)
  } else if (init.type) headers['content-type'] = init.type
  return fetch(h.base + '/api' + path, { method: init.method ?? 'GET', headers, body })
}

/** The entries of a package, by name, with document.json parsed. */
function openPackage(zip: ArrayBuffer) {
  const files = unzipSync(new Uint8Array(zip))
  const manifest = JSON.parse(new TextDecoder().decode(files['document.json']!)) as {
    title: string
    state: string
    versions: unknown[]
    assets: { id: string; mime: string; path: string }[]
    skipped: { id: string; reason: string }[]
  }
  return { files, manifest }
}

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer())
const md = async (h: Host, id: string) => (await send(h, `/docs/${id}/export?format=md`)).text()

describe('document package', () => {
  let h: Host
  let src: { id: string; png: string; mp4: string }
  let zipAll: ArrayBuffer
  let imported: { id: string; png: string; mp4: string }
  let srcMd: string

  beforeAll(async () => {
    h = await boot()
    const doc = await (await send(h, '/import/create', { method: 'POST', json: { title: 'Source', blocks: [] } })).json()
    const form = new FormData()
    form.append('file', new File([PNG], 'dot.png', { type: 'image/png' }))
    const png = (await (await send(h, `/docs/${doc.id}/assets`, { method: 'POST', body: form })).json()).id as string
    const mp4 = (await (await send(h, `/docs/${doc.id}/assets`, { method: 'POST', body: VIDEO, type: 'video/mp4' })).json()).id as string
    src = { id: doc.id, png, mp4 }
    // Image and video blocks, inserted directly.
    const inserted = await send(h, `/docs/${doc.id}/clip`, {
      method: 'POST',
      json: {
        asSuggestion: false,
        blocks: [
          { type: 'paragraph', attrs: {}, delta: [{ insert: 'Intro text' }] },
          { type: 'image', attrs: { src: `/files/${png}`, alt: 'dot' }, delta: [] },
          { type: 'video', attrs: { src: `/files/${mp4}`, kind: 'file', title: 'clip', caption: '' }, delta: [] },
        ],
      },
    })
    expect(inserted.status).toBe(200)
    // A pending suggestion: a paragraph the editor would show as tracked.
    const suggested = await send(h, `/docs/${doc.id}/clip`, { method: 'POST', json: { asSuggestion: true, blocks: [{ type: 'paragraph', attrs: {}, delta: [{ insert: 'suggested line' }] }] } })
    expect(suggested.status).toBe(200)
    const named = await send(h, `/docs/${doc.id}/versions`, { method: 'POST', json: { label: 'named' } })
    expect(named.status).toBe(200)
    srcMd = await md(h, doc.id)
    expect(srcMd).toContain(`/files/${png}`)
    expect(srcMd).toContain(`/files/${mp4}`)
  })

  afterAll(async () => {
    await h.server.close()
    rmSync(h.dir, { recursive: true, force: true })
  })

  describe.each(nonAsciiFixtures)('$name round trips', (fixture) => {
    for (const format of ['package', 'json', 'md', 'html', 'docx'] as const) {
      it(`preserves the title and UTF-8 content via ${format}`, async () => {
        const created = await send(h, '/import/create', {
          method: 'POST',
          json: { title: fixture.title, blocks: [{ type: 'paragraph', attrs: {}, delta: [{ insert: fixture.content }] }] },
        })
        expect(created.status).toBe(200)
        const source = await created.json()
        const exported = await send(h, format === 'package' ? `/docs/${source.id}/package` : `/docs/${source.id}/export?format=${format}`)
        expect(exported.status).toBe(200)
        let restored: Response
        if (format === 'package' || format === 'json') {
          if (format === 'package') {
            expect(exported.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent(fixture.title + '.stetpad')}`)
          }
          restored = await send(h, '/import/package', { method: 'POST', body: await exported.arrayBuffer(), type: format === 'package' ? 'application/octet-stream' : 'application/json' })
        } else {
          const form = new FormData()
          form.append('file', new File([await exported.arrayBuffer()], `${fixture.title}.${format}`))
          const preview = await send(h, '/import/preview', { method: 'POST', body: form })
          expect(preview.status).toBe(200)
          const parsed = await preview.json()
          expect(parsed.title).toBe(fixture.title)
          if (format === 'html') {
            expect(parsed.blocks).toEqual([
              { type: 'heading', attrs: { level: 1 }, delta: [{ insert: fixture.title }] },
              { type: 'paragraph', attrs: {}, delta: [{ insert: fixture.content }] },
            ])
          }
          restored = await send(h, '/import/create', { method: 'POST', json: parsed })
        }
        expect(restored.status).toBe(200)
        const copy = await restored.json()
        expect(copy.id).not.toBe(source.id)
        expect(copy.title).toBe(fixture.title)
        const expected = Buffer.from(fixture.content + '\n', 'utf8')
        expect(Buffer.from(await md(h, source.id), 'utf8')).toEqual(expected)
        const restoredContent = format === 'html' ? `# ${fixture.title}\n\n${fixture.content}\n` : fixture.content + '\n'
        expect(Buffer.from(await md(h, copy.id), 'utf8')).toEqual(Buffer.from(restoredContent, 'utf8'))
      })
    }
  })

  it.each(['package', 'json'] as const)('preserves titles longer than 80 characters via %s', async (format) => {
    const title = 'A'.repeat(83) + '— FINAL'
    const created = await send(h, '/docs', { method: 'POST', json: { title } })
    expect(created.status).toBe(200)
    const source = await created.json()
    expect(source.title).toBe(title)
    const exported = await send(h, format === 'package' ? `/docs/${source.id}/package` : `/docs/${source.id}/export?format=json`)
    expect(exported.status).toBe(200)
    const bytes = await exported.arrayBuffer()
    const manifest = format === 'package' ? openPackage(bytes).manifest : JSON.parse(new TextDecoder().decode(bytes))
    expect(manifest.title).toBe(title)
    const restored = await send(h, '/import/package', { method: 'POST', body: bytes, type: format === 'package' ? 'application/octet-stream' : 'application/json' })
    expect(restored.status).toBe(200)
    const copy = await restored.json()
    expect(copy.id).not.toBe(source.id)
    const fetched = await send(h, `/docs/${copy.id}`)
    expect(fetched.status).toBe(200)
    expect((await fetched.json()).title).toBe(title)
  })

  it('counts the images and videos a package would hold', async () => {
    const res = await send(h, `/docs/${src.id}/package/info`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      images: { count: 1, bytes: PNG.byteLength },
      videos: { count: 1, bytes: VIDEO.byteLength },
      files: { count: 0, bytes: 0 },
    })
  })

  it('downloads a zip with document.json first and both files byte for byte', async () => {
    const res = await send(h, `/docs/${src.id}/package?videos=1`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''")
    zipAll = await res.arrayBuffer()
    const { files, manifest } = openPackage(zipAll)
    expect(Object.keys(files)[0]).toBe('document.json')
    expect(manifest.assets.map((a) => a.id).sort()).toEqual([src.png, src.mp4].sort())
    expect(manifest.skipped).toEqual([])
    expect(manifest.versions.length).toBeGreaterThanOrEqual(2)
    expect(Buffer.from(files[`assets/${src.png}`]!)).toEqual(Buffer.from(PNG))
    expect(Buffer.from(files[`assets/${src.mp4}`]!)).toEqual(Buffer.from(VIDEO))
  })

  it('imports the package as a new document with its own file ids and the same content', async () => {
    const res = await send(h, '/import/package', { method: 'POST', body: zipAll, type: 'application/octet-stream' })
    expect(res.status).toBe(200)
    const doc = await res.json()
    expect(doc.id).not.toBe(src.id)
    expect(doc.title).toBe('Source')
    const text = await md(h, doc.id)
    expect(text).toContain('Intro text')
    // Export order is document order: the image comes before the video.
    const refs = [...text.matchAll(/\/files\/([\w-]+)/g)].map((m) => m[1]!)
    expect(refs).toHaveLength(2)
    expect(refs).not.toContain(src.png)
    expect(refs).not.toContain(src.mp4)
    imported = { id: doc.id, png: refs[0]!, mp4: refs[1]! }

    expect(await bytesOf(await fetch(`${h.base}/files/${imported.png}`))).toEqual(PNG)
    expect(await bytesOf(await fetch(`${h.base}/files/${imported.mp4}`))).toEqual(VIDEO)
  })

  it('keeps the pending suggestion and the versions', async () => {
    const srcVersions = await (await send(h, `/docs/${src.id}/versions`)).json()
    const importedVersions = await (await send(h, `/docs/${imported.id}/versions`)).json()
    expect(importedVersions.length).toBe(srcVersions.length)
    expect(importedVersions.map((v: { label: string | null }) => v.label)).toContain('named')

    const copy = await send(h, `/docs/${imported.id}/package?videos=1`)
    const { manifest } = openPackage(await copy.arrayBuffer())
    const d = new Y.Doc()
    Y.applyUpdate(d, Uint8Array.from(Buffer.from(manifest.state, 'base64')))
    expect(listChanges(d).length).toBeGreaterThanOrEqual(1)
  })

  it('leaves the imported files readable after the original document is deleted', async () => {
    const bytesBefore = await bytesOf(await fetch(`${h.base}/files/${imported.png}`))
    // The original is deleted (its files with it). The imported document owns its own copies.
    const del = await send(h, `/docs/${src.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await bytesOf(await fetch(`${h.base}/files/${imported.png}`))).toEqual(bytesBefore)
    expect(await bytesOf(await fetch(`${h.base}/files/${imported.mp4}`))).toEqual(VIDEO)
    expect(await md(h, imported.id)).toContain(`/files/${imported.png}`)
  })

  it('videos=0 lists the video as skipped, leaves it out of the zip, and still imports', async () => {
    // The imported document has the same content and its own files: export it without videos.
    const res = await send(h, `/docs/${imported.id}/package?videos=0`)
    expect(res.status).toBe(200)
    const zipNoVideo = await res.arrayBuffer()
    const { files, manifest } = openPackage(zipNoVideo)
    expect(manifest.skipped).toEqual([{ id: imported.mp4, mime: 'video/mp4', size: VIDEO.byteLength, reason: 'video-excluded' }])
    expect(manifest.assets.map((a) => a.id)).toEqual([imported.png])
    expect(files[`assets/${imported.mp4}`]).toBeUndefined()
    expect(files[`assets/${imported.png}`]).toBeDefined()

    const again = await send(h, '/import/package', { method: 'POST', body: zipNoVideo, type: 'application/octet-stream' })
    expect(again.status).toBe(200)
    const doc = await again.json()
    const text = await md(h, doc.id)
    expect(text).toContain('Intro text')
    // The skipped video keeps its old reference: it shows as broken, as expected.
    expect(text).toContain(`/files/${imported.mp4}`)
  })

  it('answers 422 to a body that is not a package', async () => {
    const garbage = await send(h, '/import/package', { method: 'POST', body: 'not a package at all', type: 'application/octet-stream' })
    expect(garbage.status).toBe(422)
    expect(await garbage.json()).toEqual({ error: '不是有效的文档包' })

    const broken = await send(h, '/import/package', { method: 'POST', body: Uint8Array.from([0x50, 0x4b, 3, 4, 1, 2, 3, 4, 5, 6]), type: 'application/octet-stream' })
    expect(broken.status).toBe(422)
  })

  it('imports a v1 JSON export with the same text', async () => {
    const legacy = await send(h, `/docs/${imported.id}/export?format=json`)
    expect(legacy.status).toBe(200)
    const json = await legacy.text()
    const before = await md(h, imported.id)
    const res = await send(h, '/import/package', { method: 'POST', body: json, type: 'application/json' })
    expect(res.status).toBe(200)
    const doc = await res.json()
    expect(doc.id).not.toBe(imported.id)
    expect(await md(h, doc.id)).toBe(before)
  })
})
