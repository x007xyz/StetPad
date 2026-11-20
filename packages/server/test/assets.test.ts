import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AssetFiles, parseRange } from '../src/assets'
import { startServer, type RunningServer, type ServerConfig } from '../src'

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
/** Stands in for a video body. The server never parses media, so ten known bytes are enough. */
const VIDEO = Uint8Array.from([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])

interface Host {
  server: RunningServer
  base: string
  token: string
  dir: string
  docId: string
}

async function boot(options: Partial<ServerConfig> = {}): Promise<Host> {
  const dir = mkdtempSync(join(tmpdir(), 'aiw-assets-'))
  const server = await startServer({ dataDir: dir, port: 0, ...options })
  const base = `http://127.0.0.1:${server.port}`
  const token = server.token
  const docId = await newDoc({ base, token, dir, docId: '', server })
  return { server, base, token, dir, docId }
}

async function newDoc(h: Host): Promise<string> {
  const res = await fetch(h.base + '/api/docs', {
    method: 'POST',
    headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'assets' }),
  })
  return (await res.json()).id as string
}

/** Raw body upload: the type is the Content-Type header. */
const raw = (h: Host, docId: string, body: BodyInit, type: string, extra: Record<string, string> = {}) =>
  fetch(`${h.base}/api/docs/${docId}/assets`, { method: 'POST', headers: { authorization: `Bearer ${h.token}`, 'content-type': type, ...extra }, body })

/** multipart/form-data upload with the `file` field. */
const multipart = (h: Host, docId: string, file: File) => {
  const form = new FormData()
  form.append('file', file)
  return fetch(`${h.base}/api/docs/${docId}/assets`, { method: 'POST', headers: { authorization: `Bearer ${h.token}` }, body: form })
}

const json = async (res: Response) => ({ status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() })
const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer())

describe('parseRange', () => {
  it('reads single byte ranges and leaves everything else to the full response', () => {
    expect(parseRange(undefined, 10)).toBeUndefined()
    expect(parseRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 })
    expect(parseRange('bytes=2-', 10)).toEqual({ start: 2, end: 9 })
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseRange('bytes=-30', 10)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=5-99', 10)).toEqual({ start: 5, end: 9 })
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 10)).toBe('unsatisfiable')
    expect(parseRange('bytes=1-2', 0)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-1,4-5', 10)).toBeUndefined()
    expect(parseRange('items=0-1', 10)).toBeUndefined()
  })
})

describe('AssetFiles', () => {
  it('writes, reads, stats and removes files, rejects unsafe ids, and ignores missing files', async () => {
    const files = new AssetFiles(mkdtempSync(join(tmpdir(), 'aiw-files-')))
    expect(() => files.path('../etc/passwd')).toThrow()
    expect(() => files.path('a/b')).toThrow()
    await files.writeBytes('abc_-1', VIDEO)
    expect(await files.stat('abc_-1')).toEqual({ size: 10 })
    expect(await files.readBytes('abc_-1')).toEqual(VIDEO)
    await files.remove('abc_-1')
    await files.remove('abc_-1') // already gone: not an error
    expect(await files.stat('abc_-1')).toBeNull()
    expect(await files.readBytes('abc_-1')).toBeNull()
  })
})

describe('assets', () => {
  let h: Host
  let small: Host

  beforeAll(async () => {
    h = await boot()
    small = await boot({ maxVideoBytes: 8 })
  })
  afterAll(async () => {
    await h.server.close()
    await small.server.close()
    rmSync(h.dir, { recursive: true, force: true })
    rmSync(small.dir, { recursive: true, force: true })
  })

  it('a multipart image upload is served back byte for byte', async () => {
    const up = await json(await multipart(h, h.docId, new File([PNG], 'dot.png', { type: 'image/png' })))
    expect(up.status).toBe(200)
    expect(up.body).toMatchObject({ url: `/files/${up.body.id}`, mime: 'image/png', size: PNG.byteLength, name: 'dot.png' })
    const got = await fetch(h.base + up.body.url)
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(got.headers.get('content-length')).toBe(String(PNG.byteLength))
    expect(got.headers.get('accept-ranges')).toBe('bytes')
    expect(got.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await bytesOf(got)).toEqual(PNG)
  })

  it('a raw video upload streams back with Range requests', async () => {
    const up = await json(await raw(h, h.docId, VIDEO, 'video/mp4', { 'x-file-name': encodeURIComponent('clip 1.mp4') }))
    expect(up.status).toBe(200)
    expect(up.body).toMatchObject({ mime: 'video/mp4', size: 10, name: 'clip 1.mp4' })
    const url = h.base + up.body.url

    const part = await fetch(url, { headers: { range: 'bytes=2-5' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(part.headers.get('content-length')).toBe('4')
    expect(await bytesOf(part)).toEqual(VIDEO.slice(2, 6))

    expect(await bytesOf(await fetch(url, { headers: { range: 'bytes=-3' } }))).toEqual(VIDEO.slice(7))
    expect(await bytesOf(await fetch(url, { headers: { range: 'bytes=7-' } }))).toEqual(VIDEO.slice(7))

    const whole = await fetch(url)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-length')).toBe('10')
    expect(await bytesOf(whole)).toEqual(VIDEO)

    const bad = await fetch(url, { headers: { range: 'bytes=50-' } })
    expect(bad.status).toBe(416)
    expect(bad.headers.get('content-range')).toBe('bytes */10')

    const head = await fetch(url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('video/mp4')
    expect(head.headers.get('content-length')).toBe('10')
    expect(head.headers.get('accept-ranges')).toBe('bytes')
  })

  it('refuses types it does not take, and sizes over the limit', async () => {
    const exe = await json(await raw(h, h.docId, 'MZ', 'application/x-msdownload'))
    expect(exe.status).toBe(415)
    expect(exe.body.error).toBe('不支持的文件类型')

    const big = await json(await raw(small, small.docId, VIDEO, 'video/mp4'))
    expect(big.status).toBe(413)
    expect(big.body.error).toMatch(/^视频超过/)

    // Without a Content-Length the limit is enforced while streaming, and the partial file is removed.
    const chunked = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(new Uint8Array(5))
        ctl.enqueue(new Uint8Array(5))
        ctl.close()
      },
    })
    const streamed = await fetch(`${small.base}/api/docs/${small.docId}/assets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${small.token}`, 'content-type': 'video/mp4' },
      body: chunked,
      duplex: 'half',
    } as RequestInit)
    expect(streamed.status).toBe(413)
    expect(readdirSync(join(small.dir, 'assets'))).toEqual([])

    // Exactly at the limit is accepted; an empty body is refused.
    expect((await json(await raw(small, small.docId, new Uint8Array(8), 'video/mp4'))).status).toBe(200)
    expect((await json(await raw(small, small.docId, new Uint8Array(0), 'video/mp4'))).status).toBe(400)
  })

  it('an SVG is served with a sandboxing Content-Security-Policy', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    const up = await json(await raw(h, h.docId, svg, 'image/svg+xml'))
    expect(up.status).toBe(200)
    const got = await fetch(h.base + up.body.url)
    expect(got.headers.get('content-type')).toBe('image/svg+xml')
    expect(got.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox")
    expect(new TextDecoder().decode(await bytesOf(got))).toBe(svg)
  })

  it('deleting the document removes its files from disk', async () => {
    const docId = await newDoc(h)
    // Bytes no other test uploaded: identical bytes from this user would be deduplicated onto the earlier file.
    const up = await json(await raw(h, docId, new Uint8Array([...VIDEO, 0x7a]), 'video/mp4'))
    const file = join(h.dir, 'assets', up.body.id)
    expect(existsSync(file)).toBe(true)
    const del = await fetch(`${h.base}/api/docs/${docId}`, { method: 'DELETE', headers: { authorization: `Bearer ${h.token}` } })
    expect(del.status).toBe(200)
    // Uploaded moments ago: the immediate collection leaves it for the periodic run (see gc.test.ts).
    await h.server.gcAssets({ graceMs: 0 })
    expect(existsSync(file)).toBe(false)
    expect((await fetch(h.base + up.body.url)).status).toBe(404)
  })
})
