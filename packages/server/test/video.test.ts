import { insertBlock, projectBlocks } from '@stetpad/crdt'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { startServer, type RunningServer, type ServerConfig } from '../src'
import { blocksToDocx, blocksToHtml, type Block } from '../src/content'
import { providerKeyNames } from '../src/models'
import { buildVtt, formatTimestamp, parseSegmentsJson, type Transcriber } from '../src/transcribe'
import { DocTools, parseBlock } from '../src/tools'
import { createCanvas } from '@napi-rs/canvas'

// Keys from the environment or ~/.dsh would reach real providers. Hide them for these tests.
const hidden = ['DSH_HOME', ...providerKeyNames().map((p) => p.keyName)]
const saved: Record<string, string | undefined> = {}
let dshDir = ''

beforeAll(() => {
  for (const k of hidden) saved[k] = process.env[k]
  dshDir = mkdtempSync(join(tmpdir(), 'aiw-video-dsh-'))
  for (const k of hidden) delete process.env[k]
  process.env.DSH_HOME = dshDir
})
afterAll(() => {
  rmSync(dshDir, { recursive: true, force: true })
  for (const k of hidden) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const VIDEO_TYPE = 'video/mp4'
const PNG = new Uint8Array(createCanvas(2, 2).toBuffer('image/png'))

interface Host {
  server: RunningServer
  base: string
  token: string
  dir: string
  docId: string
}

async function boot(options: Partial<ServerConfig> = {}): Promise<Host> {
  const dir = mkdtempSync(join(tmpdir(), 'aiw-video-'))
  const server = await startServer({ dataDir: dir, port: 0, maxVideoBytes: 1000, ...options })
  const base = `http://127.0.0.1:${server.port}`
  const token = server.token
  const created = await fetch(base + '/api/docs', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'video' }) })
  return { server, base, token, dir, docId: (await created.json()).id as string }
}

const auth = (h: Host, t = h.token) => ({ authorization: `Bearer ${t}` })
const json = (r: Response) => r.json() as Promise<Record<string, any>>

describe('WebVTT builder', () => {
  it('formats timestamps as HH:MM:SS.mmm', () => {
    expect(formatTimestamp(1)).toBe('00:00:01.000')
    expect(formatTimestamp(61.5)).toBe('00:01:01.500')
    expect(formatTimestamp(3723.004)).toBe('01:02:03.004')
    expect(formatTimestamp(-2)).toBe('00:00:00.000')
  })

  it('builds a valid WebVTT file from segments and skips empty text', () => {
    const vtt = buildVtt([
      { start: 0, end: 2.5, text: ' Hello   world ' },
      { start: 3, end: 3, text: '   ' },
      { start: 4, end: 6, text: 'a --> b' },
    ])
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true)
    expect(vtt).toContain('00:00:00.000 --> 00:00:02.500\nHello world\n')
    expect(vtt).toContain('00:00:04.000 --> 00:00:06.000\na -> b\n')
    expect(vtt.match(/-->/g)).toHaveLength(2)
  })

  it('parses Gemini JSON defensively', () => {
    const segs = parseSegmentsJson('Here: {"segments":[{"start":1,"end":2,"text":" hi "},{"start":"x"}]} done')
    expect(segs).toEqual([{ start: 1, end: 2, text: 'hi' }])
    expect(() => parseSegmentsJson('no json here')).toThrow()
    expect(() => parseSegmentsJson('{"segments":[]}')).toThrow()
  })
})

describe('resumable uploads', () => {
  it('creates, takes three chunks, answers a wrong offset with 409, and stores the whole file', async () => {
    const h = await boot()
    try {
      const data = Uint8Array.from({ length: 30 }, (_, i) => i + 1)
      const created = await json(await fetch(`${h.base}/api/docs/${h.docId}/uploads`, { method: 'POST', headers: { ...auth(h), 'content-type': 'application/json' }, body: JSON.stringify({ name: 'clip.mp4', mime: VIDEO_TYPE, size: 30 }) }))
      expect(created).toMatchObject({ offset: 0 })
      const up = (start: number, end: number, uid = created.uploadId) =>
        fetch(`${h.base}/api/uploads/${uid}`, { method: 'PUT', headers: { ...auth(h), 'content-range': `bytes ${start}-${end}/30` }, body: data.slice(start, end + 1) })

      expect(await json(await up(0, 9))).toEqual({ done: false, offset: 10 })
      const wrong = await up(5, 14)
      expect(wrong.status).toBe(409)
      expect(await json(wrong)).toMatchObject({ offset: 10 })
      expect(await json(await up(10, 19))).toEqual({ done: false, offset: 20 })
      expect(await json(await fetch(`${h.base}/api/uploads/${created.uploadId}`, { headers: auth(h) }))).toEqual({ offset: 20, size: 30 })

      const last = await json(await up(20, 29))
      expect(last.done).toBe(true)
      expect(last.url).toMatch(/^\/files\//)
      const got = new Uint8Array(await (await fetch(h.base + last.url)).arrayBuffer())
      expect(got).toEqual(data)

      // A repeated last chunk gets the same answer as the stored file, not a second copy.
      const again = await up(20, 29)
      expect(again.status).toBe(409)
      expect(await json(again)).toMatchObject({ url: last.url })
    } finally {
      await h.server.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('refuses a disallowed type and a file over the limit at create', async () => {
    const h = await boot()
    try {
      const post = (body: unknown) => fetch(`${h.base}/api/docs/${h.docId}/uploads`, { method: 'POST', headers: { ...auth(h), 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect((await post({ name: 'x.html', mime: 'text/html', size: 4 })).status).toBe(415)
      expect((await post({ name: 'v.mp4', mime: VIDEO_TYPE, size: 5000 })).status).toBe(413)
    } finally {
      await h.server.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})

describe('transcription', () => {
  it('answers 400 when no OpenAI or Google key is saved', async () => {
    const h = await boot()
    try {
      const up = await fetch(`${h.base}/api/docs/${h.docId}/assets`, { method: 'POST', headers: { ...auth(h), 'content-type': VIDEO_TYPE }, body: new Uint8Array([1, 2, 3, 4]) })
      const src = (await json(up)).url as string
      const r = await fetch(`${h.base}/api/docs/${h.docId}/ai/transcribe`, { method: 'POST', headers: { ...auth(h), 'content-type': 'application/json' }, body: JSON.stringify({ src }) })
      expect(r.status).toBe(400)
      expect(await json(r)).toEqual({ error: '需要 OpenAI 或 Google 的密钥才能转写' })
    } finally {
      await h.server.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('stores the WebVTT file and returns the segments, using the injected transcriber', async () => {
    const seen: { provider: string; apiKey: string }[] = []
    const transcribe: Transcriber = async (req) => {
      seen.push({ provider: req.provider, apiKey: req.apiKey })
      return { text: 'Hello there', segments: [{ start: 0, end: 1.5, text: 'Hello' }, { start: 1.5, end: 3, text: 'there' }] }
    }
    const h = await boot({ transcribe })
    try {
      const keys = await fetch(`${h.base}/api/settings`, { method: 'PUT', headers: { ...auth(h), 'content-type': 'application/json' }, body: JSON.stringify({ keys: { OPENAI_API_KEY: 'sk-test' } }) })
      expect(keys.ok).toBe(true)
      const src = (await json(await fetch(`${h.base}/api/docs/${h.docId}/assets`, { method: 'POST', headers: { ...auth(h), 'content-type': VIDEO_TYPE }, body: new Uint8Array([9, 8, 7, 6, 5]) }))).url as string
      const r = await fetch(`${h.base}/api/docs/${h.docId}/ai/transcribe`, { method: 'POST', headers: { ...auth(h), 'content-type': 'application/json' }, body: JSON.stringify({ src }) })
      expect(r.status).toBe(200)
      const body = await json(r)
      expect(body.text).toBe('Hello there')
      expect(body.segments).toEqual([{ start: 0, end: 1.5, text: 'Hello' }, { start: 1.5, end: 3, text: 'there' }])
      expect(seen).toEqual([{ provider: 'openai', apiKey: 'sk-test' }])

      const vtt = await fetch(h.base + body.vtt)
      expect(vtt.headers.get('content-type')).toBe('text/vtt; charset=utf-8')
      expect(vtt.headers.get('content-security-policy')).toContain('sandbox')
      const text = await vtt.text()
      expect(text).toContain('00:00:00.000 --> 00:00:01.500\nHello\n')
      expect(text).toContain('00:00:01.500 --> 00:00:03.000\nthere\n')
    } finally {
      await h.server.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('uses Google when only the Google key is saved', async () => {
    const seen: string[] = []
    const transcribe: Transcriber = async (req) => {
      seen.push(req.provider)
      return { text: 'x', segments: [{ start: 0, end: 1, text: 'x' }] }
    }
    const h = await boot({ transcribe })
    try {
      await fetch(`${h.base}/api/settings`, { method: 'PUT', headers: { ...auth(h), 'content-type': 'application/json' }, body: JSON.stringify({ keys: { GOOGLE_GENERATIVE_AI_API_KEY: 'g-test' } }) })
      const src = (await json(await fetch(`${h.base}/api/docs/${h.docId}/assets`, { method: 'POST', headers: { ...auth(h), 'content-type': VIDEO_TYPE }, body: new Uint8Array([1, 1, 1]) }))).url as string
      const r = await fetch(`${h.base}/api/docs/${h.docId}/ai/transcribe`, { method: 'POST', headers: { ...auth(h), 'content-type': 'application/json' }, body: JSON.stringify({ src }) })
      expect(r.status).toBe(200)
      expect(seen).toEqual(['google'])
    } finally {
      await h.server.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})

describe('poster frames in notation and export', () => {
  const meta = { author: 'AI', runId: 'r1' }
  const docWith = (blocks: { id: string; type: string; text?: string; attrs?: Record<string, unknown> }[]): Y.Doc => {
    const doc = new Y.Doc()
    doc.transact(() => blocks.forEach((b, i) => insertBlock(doc, i, b.id, b.text ?? '', b.type, b.attrs ?? {})))
    return doc
  }

  it('a replaced video keeps its poster and subtitles', () => {
    const doc = docWith([{ id: 'v1', type: 'video', attrs: { src: '/files/abc', kind: 'file', title: 'old', caption: '', poster: '/files/pp', captions: '/files/cc' } }])
    const r = new DocTools(doc, meta).replaceBlock('v1', '!video[new title](/files/abc)', 'retitle')
    expect(r).toMatchObject({ ok: true })
    const revised = projectBlocks(doc, 'revised').find((b) => b.attrs.title === 'new title')!
    expect(revised.attrs).toMatchObject({ poster: '/files/pp', captions: '/files/cc' })
  })

  it('notation carries no poster of its own', () => {
    expect(parseBlock('!video[t](/files/abc)').attrs).not.toHaveProperty('poster')
  })

  it('HTML export sets the poster on the video element', () => {
    const block = (poster: string): Block => ({ type: 'video', attrs: { src: '/files/abc', kind: 'file', title: 't', caption: '', poster }, delta: [] })
    expect(blocksToHtml([block('/files/pp')], 'T')).toContain('poster="/files/pp"')
    expect(blocksToHtml([block('javascript:x')], 'T')).not.toContain('poster=')
  })

  it('Word export loads the poster image above the video line', async () => {
    const loaded: string[] = []
    const docx = await blocksToDocx(
      [{ type: 'video', attrs: { src: '/files/abc', kind: 'file', title: 't', caption: '', poster: '/files/pp' }, delta: [] }],
      'T',
      { loadAsset: async (src) => (loaded.push(src), { mime: 'image/png', data: PNG }) },
    )
    expect(loaded).toContain('/files/pp')
    expect(docx.byteLength).toBeGreaterThan(0)
  })
})

describe('video subtitles in HTML export', () => {
  it('adds a subtitles track when the video has captions', async () => {
    const { blocksToHtml } = await import('../src/content')
    const html = blocksToHtml([{ type: 'video', attrs: { kind: 'file', src: '/files/v1', captions: '/files/c1' }, delta: [] }], 'T')
    expect(html).toContain('<track kind="subtitles" src="/files/c1" srclang="zh" label="字幕" default>')
    const plain = blocksToHtml([{ type: 'video', attrs: { kind: 'file', src: '/files/v1' }, delta: [] }], 'T')
    expect(plain).not.toContain('<track')
  })
})
