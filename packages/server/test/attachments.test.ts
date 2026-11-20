import { zipSync } from 'fflate'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../src'
import { formatBlock, parseBlock } from '../src/tools'
import { nonAsciiFixtures } from './non-ascii'

const TOKEN = 'attachments-test-token'
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
const PDF = new TextEncoder().encode('%PDF-1.4\n%%EOF\n')
const ZIP = zipSync({ 'notes.txt': new TextEncoder().encode('hello') })
const PAGE_HTML = `<!doctype html><html><head><title>Plain title</title>
<meta property="og:title" content="Hello &amp; welcome">
<meta property="og:description" content="A post about things">
<meta property="og:site_name" content="Blog">
<meta property="og:image" content="/cover.png">
</head><body><p>body</p></body></html>`

/**
 * The network the link preview may use, faked. `blog.example.test` resolves to a public address;
 * `private.example.test` resolves to a private one, which must be refused.
 */
const lookup = async (host: string) => {
  if (host === 'blog.example.test') return [{ address: '93.184.216.34', family: 4 }]
  if (host === 'private.example.test') return [{ address: '10.0.0.5', family: 4 }]
  return []
}
const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  const page = (path: string) => `https://blog.example.test${path}`
  if (url === page('/post')) return new Response(PAGE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  if (url === page('/cover.png')) return new Response(PNG, { headers: { 'content-type': 'image/png' } })
  if (url === page('/redirect')) return new Response(null, { status: 302, headers: { location: '/post' } })
  if (url === page('/loop1')) return new Response(null, { status: 302, headers: { location: '/loop2' } })
  if (url === page('/loop2')) return new Response(null, { status: 302, headers: { location: '/loop3' } })
  if (url === page('/loop3')) return new Response(null, { status: 302, headers: { location: '/loop4' } })
  if (url === page('/loop4')) return new Response(null, { status: 302, headers: { location: '/post' } })
  if (url === page('/huge')) return new Response(new Uint8Array(2 * 1024 * 1024 + 16).fill(60), { headers: { 'content-type': 'text/html' } })
  return new Response('not found', { status: 404 })
}) as typeof fetch

let server: RunningServer
let base = ''
let dir = ''
let docId = ''

const call = (path: string, init: { method?: string; json?: unknown; body?: BodyInit; type?: string; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) }
  let body = init.body
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(init.json)
  } else if (init.type) headers['content-type'] = init.type
  return fetch(base + path, { method: init.method ?? 'GET', headers, body })
}

/** Uploads raw bytes under a file name, as the web app does. */
async function upload(bytes: Uint8Array, type: string, name: string): Promise<string> {
  const res = await call(`/api/docs/${docId}/assets`, { method: 'POST', body: new Blob([bytes as BlobPart]), type, headers: { 'x-file-name': encodeURIComponent(name) } })
  expect(res.status).toBe(200)
  return (await res.json()).url as string
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aiw-attach-'))
  server = await startServer({ dataDir: dir, port: 0, token: TOKEN, unfurlFetch: fakeFetch, unfurlLookup: lookup, assetGc: false })
  base = `http://127.0.0.1:${server.port}`
  const doc = await call('/api/docs', { method: 'POST', json: { title: 'attachments' } })
  docId = (await doc.json()).id as string
})

afterAll(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('attachment uploads', () => {
  it.each(nonAsciiFixtures)('preserves $name attachment filenames and bytes', async (fixture) => {
    const name = `${fixture.title}.txt`
    const bytes = new TextEncoder().encode(fixture.content)
    const url = await upload(bytes, 'text/plain', name)
    const got = await fetch(base + url)
    expect(got.status).toBe(200)
    expect(got.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes)
  })

  it('a PDF is accepted and served inline under a sandboxing Content-Security-Policy', async () => {
    const url = await upload(PDF, 'application/pdf', 'spec sheet.pdf')
    const got = await fetch(base + url)
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('application/pdf')
    expect(got.headers.get('content-disposition')).toBeNull()
    expect(got.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect(got.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PDF)
  })

  it('a zip is served as a download under its file name', async () => {
    const url = await upload(ZIP, 'application/zip', 'bundle 1.zip')
    const got = await fetch(base + url)
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('application/zip')
    expect(got.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''bundle%201.zip")
    expect(got.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(ZIP)
  })

  it('a text attachment is accepted, and types outside the list get 415', async () => {
    expect((await call(`/api/docs/${docId}/assets`, { method: 'POST', body: 'plain words', type: 'text/plain' })).status).toBe(200)
    const exe = await call(`/api/docs/${docId}/assets`, { method: 'POST', body: 'MZ', type: 'application/x-msdownload' })
    expect(exe.status).toBe(415)
    expect((await exe.json()).error).toBe('不支持的文件类型')
    expect((await call(`/api/docs/${docId}/assets`, { method: 'POST', body: '<p>x</p>', type: 'text/html' })).status).toBe(415)
  })
})

describe('link previews', () => {
  const unfurlUrl = (url: string) => call(`/api/docs/${docId}/unfurl`, { method: 'POST', json: { url } })

  it('refuses loopback, private and non-web addresses', async () => {
    for (const url of ['http://127.0.0.1:9/', 'http://localhost/admin', 'http://[::1]/', 'http://10.1.2.3/']) {
      const res = await unfurlUrl(url)
      expect(res.status).toBe(422)
      expect((await res.json()).error).toBe('不允许访问本机或内网地址')
    }
    const file = await unfurlUrl('file:///etc/passwd')
    expect(file.status).toBe(422)
    expect((await file.json()).error).toBe('只支持 http 或 https 链接')
  })

  it('refuses a public-looking name that resolves to a private address', async () => {
    const res = await unfurlUrl('https://private.example.test/')
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('不允许访问本机或内网地址')
  })

  it('reads the title, description, site and picture of a public page, and stores the picture', async () => {
    const res = await unfurlUrl('https://blog.example.test/post')
    expect(res.status).toBe(200)
    const preview = await res.json()
    expect(preview).toEqual({
      url: 'https://blog.example.test/post',
      title: 'Hello & welcome',
      description: 'A post about things',
      site: 'Blog',
      image: expect.stringMatching(/^\/files\/[\w-]+$/),
    })
    const picture = await fetch(base + preview.image)
    expect(picture.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await picture.arrayBuffer())).toEqual(PNG)
  })

  it('follows up to three redirects, and refuses more', async () => {
    const followed = await unfurlUrl('https://blog.example.test/redirect')
    expect(followed.status).toBe(200)
    expect((await followed.json()).title).toBe('Hello & welcome')
    const looped = await unfurlUrl('https://blog.example.test/loop1')
    expect(looped.status).toBe(422)
    expect((await looped.json()).error).toBe('跳转次数过多')
  })

  it('refuses a page over 2 MB', async () => {
    const res = await unfurlUrl('https://blog.example.test/huge')
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('网页超过 2MB')
  })

  it('answers 422 for a missing URL', async () => {
    const res = await call(`/api/docs/${docId}/unfurl`, { method: 'POST', json: {} })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('请输入有效的网址')
  })
})

describe('notation', () => {
  it('round-trips a file block and a link card', () => {
    const file = { type: 'file', attrs: { src: '/files/abcdefghijklmnop', name: 'report [v2].pdf' }, text: '' }
    const parsedFile = parseBlock(formatBlock(file))
    expect(parsedFile).toEqual({ type: 'file', attrs: { src: '/files/abcdefghijklmnop', name: 'report v2.pdf' }, text: '' })
    expect(formatBlock(parsedFile)).toBe('!file[report v2.pdf](/files/abcdefghijklmnop)')

    const card = { type: 'linkCard', attrs: { url: 'https://example.test/a?b=1', title: 'A title' }, text: '' }
    const parsedCard = parseBlock(formatBlock(card))
    expect(parsedCard).toEqual({ type: 'linkCard', attrs: { url: 'https://example.test/a?b=1', title: 'A title' }, text: '' })
    expect(formatBlock(parsedCard)).toBe('!link[A title](https://example.test/a?b=1)')
  })

  it('keeps the notation to uploaded files and web links', () => {
    expect(parseBlock('!file[x](https://evil.example.test/x.pdf)').type).toBe('paragraph')
    expect(parseBlock('!link[x](javascript:alert(1))').type).toBe('paragraph')
  })
})

describe('exports and packages', () => {
  let pdfUrl = ''
  let pngUrl = ''
  let sourceId = ''

  beforeAll(async () => {
    pdfUrl = await upload(new Uint8Array([...PDF, 0x31]), 'application/pdf', 'report.pdf')
    pngUrl = await upload(PNG, 'image/png', 'cover.png')
    sourceId = docId
    // A file block, a link card with a stored picture, and one card with a javascript: link that must be dropped.
    const clip = await call(`/api/docs/${sourceId}/clip`, {
      method: 'POST',
      json: {
        asSuggestion: false,
        blocks: [
          { type: 'file', attrs: { src: pdfUrl, name: 'report.pdf', mime: 'application/pdf', size: 2048 }, delta: [] },
          { type: 'linkCard', attrs: { url: 'https://blog.example.test/post', title: 'Hello', description: 'A post', site: 'Blog', image: pngUrl }, delta: [] },
          { type: 'linkCard', attrs: { url: 'javascript:alert(1)', title: 'bad' }, delta: [] },
        ],
      },
    })
    expect(clip.status).toBe(200)
  })

  it('exports Markdown for both blocks, dropping the unsafe link card', async () => {
    const md = await (await call(`/api/docs/${sourceId}/export?format=md`)).text()
    expect(md).toContain(`[📎 report.pdf](${pdfUrl})`)
    expect(md).toContain('[Hello](https://blog.example.test/post) — A post')
    expect(md).not.toContain('javascript:')
  })

  it('exports HTML with a download link and a link card', async () => {
    const html = await (await call(`/api/docs/${sourceId}/export?format=html`)).text()
    expect(html).toContain(`<p class="attachment"><a href="${pdfUrl}" download="report.pdf">report.pdf</a> (2 KB)</p>`)
    expect(html).toContain('<a class="link-card" href="https://blog.example.test/post" target="_blank" rel="noopener noreferrer">')
    expect(html).toContain(`<img src="${pngUrl}" alt="">`)
  })

  it('exports Word', async () => {
    const res = await call(`/api/docs/${sourceId}/export?format=docx`)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]))
  })

  it('counts attachments in the package info', async () => {
    const info = await (await call(`/api/docs/${sourceId}/package/info`)).json()
    expect(info.files).toEqual({ count: 1, bytes: new Uint8Array([...PDF, 0x31]).byteLength })
    expect(info.images).toEqual({ count: 1, bytes: PNG.byteLength })
  })

  it('a package with an attachment imports with the file under a new id', async () => {
    const zip = await (await call(`/api/docs/${sourceId}/package`)).arrayBuffer()
    const imported = await call('/api/import/package', { method: 'POST', body: zip, type: 'application/octet-stream' })
    expect(imported.status).toBe(200)
    const copy = (await imported.json()).id as string
    expect(copy).not.toBe(sourceId)
    const md = await (await call(`/api/docs/${copy}/export?format=md`)).text()
    const ref = /\[📎 report\.pdf\]\((\/files\/[\w-]+)\)/.exec(md)
    expect(ref).not.toBeNull()
    expect(ref![1]).not.toBe(pdfUrl)
    const bytes = new Uint8Array(await (await fetch(base + ref![1])).arrayBuffer())
    expect(bytes).toEqual(new Uint8Array([...PDF, 0x31]))
    expect(md).toMatch(/\[Hello\]\(https:\/\/blog\.example\.test\/post\) — A post/)
  })
})

describe('pinnedFetch', () => {
  it('refuses a hostname that resolves to a local address at connect time', async () => {
    const { createServer } = await import('node:http')
    const { pinnedFetch } = await import('../src/unfurl')
    const srv = createServer((_req, res) => res.end('secret'))
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as { port: number }).port
    try {
      await expect(pinnedFetch(`http://localhost:${port}/`)).rejects.toThrow()
    } finally {
      srv.close()
    }
  })
})

describe('PDF page previews', () => {
  it('renders a page to PNG, reports the page count, and caches next to the asset', async () => {
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { startServer } = await import('../src')
    const dir = mkdtempSync(join(tmpdir(), 'aiw-pdf-'))
    const server = await startServer({ dataDir: dir, port: 0, assetGc: false })
    const base = `http://127.0.0.1:${server.port}`
    const auth = { authorization: `Bearer ${server.token}` }
    try {
      const doc = await (await fetch(base + '/api/docs', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"title":"pdf"}' })).json()
      const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF'
      const up = await (await fetch(`${base}/api/docs/${doc.id}/assets`, { method: 'POST', headers: { ...auth, 'content-type': 'application/pdf' }, body: pdf })).json()
      expect(await (await fetch(`${base}${up.url}/pages`)).json()).toEqual({ pages: 1 })
      const page = await fetch(`${base}${up.url}/pages/1`)
      expect(page.headers.get('content-type')).toBe('image/png')
      expect([...new Uint8Array(await page.arrayBuffer()).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
      expect(existsSync(join(dir, 'assets', 'derived', up.id, 'page-1.png'))).toBe(true)
      expect((await fetch(`${base}${up.url}/pages/2`)).status).toBe(404)
      await server.gcAssets({ graceMs: 0 })
      expect(existsSync(join(dir, 'assets', 'derived', up.id))).toBe(false)
    } finally {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
