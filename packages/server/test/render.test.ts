import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../src'
import { pictureSize } from '../src/content'
import { providerKeyNames } from '../src/models'
import { mathToSvg, prepareRenders, sanitizeSvg, svgToPng } from '../src/render'

describe('mathToSvg', () => {
  it('renders a display formula as a self-contained svg', () => {
    const svg = mathToSvg('\\frac{a}{b}')
    expect(svg).not.toBeNull()
    expect(svg!.startsWith('<svg')).toBe(true)
    expect(svg).not.toContain('<script')
  })

  it('returns null on a TeX error', () => {
    expect(mathToSvg('\\frac{')).toBeNull()
  })
})

describe('sanitizeSvg', () => {
  it('strips script, foreignObject, event handlers and unsafe links', () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" width="10" height="10">' +
        '<script>alert(2)</script><foreignObject><div>x</div></foreignObject>' +
        '<a href="javascript:alert(3)"><rect width="5" height="5" onclick="x()"/></a>' +
        '<use xlink:href="https://example.com/x.svg#a"/><use href="#ok"/></svg>',
    )
    expect(out).not.toBeNull()
    expect(out).not.toMatch(/<script|foreignObject|onload|onclick|javascript:|example\.com/i)
    expect(out).toContain('href="#ok"')
    expect(out).toContain('<rect')
  })

  it('rejects input that is not an svg, and oversized input', () => {
    expect(sanitizeSvg('<div>hi</div>')).toBeNull()
    expect(sanitizeSvg('  <svg></svg>')).not.toBeNull()
    expect(sanitizeSvg('<svg>' + 'a'.repeat(2 * 1024 * 1024) + '</svg>')).toBeNull()
  })
})

describe('svgToPng', () => {
  it('rasterizes an svg to a PNG of the right size', async () => {
    const r = await svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>')
    expect(r).not.toBeNull()
    expect(r!.png[0]).toBe(0x89)
    expect(String.fromCharCode(r!.png[1]!, r!.png[2]!, r!.png[3]!)).toBe('PNG')
    expect(r!.width).toBe(40)
    expect(r!.height).toBe(20)
    const pic = pictureSize(r!.png)
    expect(pic && [pic.width, pic.height]).toEqual([80, 40])
  })
})

describe('prepareRenders', () => {
  it('renders math on the server and keeps only sanitized client mermaid svg', async () => {
    const blocks = [
      { type: 'codeBlock', attrs: { language: 'math' }, delta: [{ insert: '\\frac{a}{b}' }], blockId: 'm1' },
      { type: 'codeBlock', attrs: { language: 'mermaid' }, delta: [{ insert: 'flowchart TD' }], blockId: 'd1' },
      { type: 'codeBlock', attrs: { language: 'mermaid' }, delta: [{ insert: 'flowchart TD' }], blockId: 'd2' },
    ] as Parameters<typeof prepareRenders>[0]
    const r = await prepareRenders(blocks, { d1: '<svg onload="x()"></svg>', m1: '<svg></svg>' }, { png: false })
    expect(r.svg.m1?.startsWith('<svg')).toBe(true)
    expect(r.svg.m1).not.toBe('<svg></svg>')
    expect(r.svg.d1).toBe('<svg></svg>')
    expect(r.svg.d2).toBeUndefined()
    expect(r.png).toEqual({})
  })
})

describe('export and AI diagram routes', () => {
  let server: RunningServer
  let dir: string
  let base: string
  let token = ''
  let docId = ''
  let mermaidId = ''
  // Provider keys from the environment or ~/.dsh would let the diagram route call a real model. Hide them for this suite.
  const hidden = ['DSH_HOME', 'AIW_COMPAT_BASE_URL', 'AIW_COMPAT_MODELS', ...providerKeyNames().map((p) => p.keyName)]
  const saved = new Map(hidden.map((k) => [k, process.env[k]]))

  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    })
    const ct = res.headers.get('content-type') ?? ''
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text(), res }
  }

  beforeAll(async () => {
    for (const k of hidden) delete process.env[k]
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'aiw-render-dsh-'))
    dir = mkdtempSync(join(tmpdir(), 'aiw-render-'))
    server = await startServer({ dataDir: dir, port: 0 })
    base = `http://127.0.0.1:${server.port}`
    token = server.token ?? ''
    const made = await call('/api/import/create', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Diagrams',
        blocks: [
          { type: 'paragraph', attrs: {}, delta: [{ insert: 'Intro' }] },
          { type: 'codeBlock', attrs: { language: 'math' }, delta: [{ insert: '\\frac{a}{b}' }] },
          { type: 'codeBlock', attrs: { language: 'mermaid' }, delta: [{ insert: 'flowchart TD\nA-->B' }] },
        ],
      }),
    })
    docId = made.body.id as string
    const json = await call(`/api/docs/${docId}/export?format=json`)
    const mermaid = (json.body.blocks as { type: string; attrs: { language?: string }; blockId?: string }[]).find((b) => b.type === 'codeBlock' && b.attrs.language === 'mermaid')
    mermaidId = mermaid?.blockId ?? ''
  })

  afterAll(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(process.env.DSH_HOME!, { recursive: true, force: true })
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('GET html renders the math block as svg', async () => {
    const r = await call(`/api/docs/${docId}/export?format=html`)
    expect(r.status).toBe(200)
    expect(r.body).toContain('<svg')
    expect(r.body).toContain('<figure class="diagram">')
  })

  it('POST html uses the client mermaid svg without its script', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><script>alert(1)</script><rect width="20" height="20"/></svg>'
    expect(mermaidId).not.toBe('')
    const r = await call(`/api/docs/${docId}/export`, { method: 'POST', body: JSON.stringify({ format: 'html', renders: { [mermaidId]: svg } }) })
    expect(r.status).toBe(200)
    expect(r.body).toContain('<rect')
    expect(r.body).not.toContain('<script')
    expect(r.body).not.toContain('alert(1)')
  })

  it('POST docx returns a non-empty Word file', async () => {
    const res = await fetch(`${base}/api/docs/${docId}/export`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'docx' }),
    })
    expect(res.status).toBe(200)
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes.length).toBeGreaterThan(0)
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('PK')
  })

  it('diagram route returns 400 when no model is configured', async () => {
    const r = await call(`/api/docs/${docId}/ai/diagram`, { method: 'POST', body: JSON.stringify({ kind: 'mermaid', prompt: 'a flow' }) })
    expect(r.status).toBe(400)
    expect(r.body.error).toBeTruthy()
  })
})

describe('parseRaster', () => {
  it('accepts a browser PNG data URL and rejects anything else', async () => {
    const { parseRaster } = await import('../src/render')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')
    expect(parseRaster({ png: `data:image/png;base64,${png}`, width: 100, height: 50 })?.width).toBe(100)
    expect(parseRaster({ png: `data:image/jpeg;base64,${png}`, width: 100, height: 50 })).toBeNull()
    expect(parseRaster({ png: 'data:image/png;base64,AAAA', width: 100, height: 50 })).toBeNull()
    expect(parseRaster({ png: `data:image/png;base64,${png}`, width: 0, height: 50 })).toBeNull()
  })
})

describe('wordSafeImage', () => {
  it('converts WebP to JPEG and leaves PNG alone', async () => {
    const { wordSafeImage } = await import('../src/render')
    const { createCanvas } = await import('@napi-rs/canvas')
    const c = createCanvas(4, 3)
    c.getContext('2d').fillRect(0, 0, 4, 3)
    const webp = new Uint8Array(await c.encode('webp'))
    const out = await wordSafeImage({ mime: 'image/webp', data: webp })
    expect(out?.mime).toBe('image/jpeg')
    expect([...out!.data.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff])
    const png = { mime: 'image/png', data: new Uint8Array([1, 2, 3]) }
    expect(await wordSafeImage(png)).toBe(png)
  })
})
