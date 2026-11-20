import { zipSync } from 'fflate'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { startServer, type RunningServer, type ServerConfig } from '../src'
import { clearImageModelCache, listImageModels, priceLabel, recommendedImageModel, type ImageModelInfo } from '../src/images'
import type { ModelScope } from '../src/models'
import { DRAWIO_VERSION, drawioUrl, unsafeEntry } from '../../../desktop/scripts/fetch-drawio.mjs'

const dirs: string[] = []
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

/** A folder with an index.html that stands in for a draw.io webapp. */
function drawioFolder(): string {
  const d = tmp('aiw-drawio-')
  writeFileSync(join(d, 'index.html'), '<!doctype html><title>draw.io stub</title>')
  mkdirSync(join(d, 'js'))
  writeFileSync(join(d, 'js', 'app.js'), 'console.log("drawio")')
  return d
}

/** A folder standing in for the built web app. */
function webFolder(): string {
  const d = tmp('aiw-web-')
  writeFileSync(join(d, 'index.html'), '<!doctype html><div id="root"></div>')
  return d
}

async function boot(options: Partial<ServerConfig> = {}): Promise<{ server: RunningServer; base: string; token: string }> {
  const server = await startServer({ dataDir: tmp('aiw-small-'), port: 0, assetGc: false, ...options })
  return { server, base: `http://127.0.0.1:${server.port}`, token: server.token ?? '' }
}

describe('draw.io served from drawioDir', () => {
  let served: { server: RunningServer; base: string; token: string }
  let plain: { server: RunningServer; base: string; token: string }
  let spa: { server: RunningServer; base: string; token: string }

  beforeAll(async () => {
    served = await boot({ drawioDir: drawioFolder(), staticDir: webFolder() })
    plain = await boot()
    spa = await boot({ staticDir: webFolder() })
  })
  afterAll(async () => {
    await served.server.close()
    await plain.server.close()
    await spa.server.close()
  })

  it('serves index.html under /drawio/ with nosniff, and a file below it', async () => {
    const res = await fetch(`${served.base}/drawio/index.html`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await res.text()).toContain('draw.io stub')
    const js = await fetch(`${served.base}/drawio/js/app.js`)
    expect(js.status).toBe(200)
    expect(await js.text()).toContain('drawio')
  })

  it('serves the folder root at /drawio and /drawio/', async () => {
    expect(await (await fetch(`${served.base}/drawio`)).text()).toContain('draw.io stub')
    expect(await (await fetch(`${served.base}/drawio/`)).text()).toContain('draw.io stub')
  })

  it('does not hand a missing /drawio file to the web app', async () => {
    const res = await fetch(`${served.base}/drawio/missing.js`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('id="root"')
  })

  it('still serves the web app elsewhere', async () => {
    expect(await (await fetch(`${served.base}/some/page`)).text()).toContain('id="root"')
  })

  it('/api/config points at this server when drawioDir is set', async () => {
    const cfg = await (await fetch(`${served.base}/api/config`)).json()
    expect(cfg.drawioUrl).toBe(`${served.base}/drawio`)
  })

  it('does not serve /drawio without drawioDir, and keeps the public default', async () => {
    expect((await fetch(`${plain.base}/drawio/index.html`)).status).toBe(404)
    expect((await fetch(`${spa.base}/drawio/index.html`)).status).toBe(404)
    expect((await (await fetch(`${plain.base}/api/config`)).json()).drawioUrl).toBe('https://embed.diagrams.net')
  })

  it('an explicit drawioUrl wins over the local copy', async () => {
    const h = await boot({ drawioDir: drawioFolder(), drawioUrl: 'https://draw.example.test/' })
    try {
      expect((await (await fetch(`${h.base}/api/config`)).json()).drawioUrl).toBe('https://draw.example.test/')
    } finally {
      await h.server.close()
    }
  })

  it('a folder without index.html is not served', async () => {
    const h = await boot({ drawioDir: tmp('aiw-empty-') })
    try {
      expect((await fetch(`${h.base}/drawio/index.html`)).status).toBe(404)
      expect((await (await fetch(`${h.base}/api/config`)).json()).drawioUrl).toBe('https://embed.diagrams.net')
    } finally {
      await h.server.close()
    }
  })
})

describe('recommended image model', () => {
  const m = (id: string): ImageModelInfo => ({ id, label: id })

  it('prefers gpt-image-1, then Imagen, in that order', () => {
    expect(recommendedImageModel([m('openrouter:bfl/flux'), m('google:imagen-4.0-generate-001'), m('openai:gpt-image-1')])).toBe('openai:gpt-image-1')
    expect(recommendedImageModel([m('openrouter:bfl/flux'), m('google:imagen-4.0-generate-001')])).toBe('google:imagen-4.0-generate-001')
  })

  it('then OpenRouter: Gemini image before gpt-image, flux, seedream', () => {
    expect(recommendedImageModel([m('openrouter:bfl/flux'), m('openrouter:bytedance/seedream-4'), m('openrouter:google/gemini-2.5-flash-image')])).toBe('openrouter:google/gemini-2.5-flash-image')
    expect(recommendedImageModel([m('openrouter:bfl/flux'), m('openrouter:openai/gpt-image-1')])).toBe('openrouter:openai/gpt-image-1')
    expect(recommendedImageModel([m('openrouter:bytedance/seedream-4'), m('openrouter:bfl/flux-1.1')])).toBe('openrouter:bfl/flux-1.1')
    expect(recommendedImageModel([m('openrouter:acme/other'), m('openrouter:bytedance/seedream-4')])).toBe('openrouter:bytedance/seedream-4')
  })

  it('ignores a match that is not from OpenRouter, and falls back to the first model', () => {
    expect(recommendedImageModel([m('openai:dall-e-3'), m('openrouter:acme/other')])).toBe('openai:dall-e-3')
    expect(recommendedImageModel([])).toBeNull()
  })
})

describe('image model prices', () => {
  it('formats the per-image price, free models, and leaves unknown prices out', () => {
    expect(priceLabel('google/gemini-2.5-flash-image', { image: '0.04', prompt: '0' })).toBe('$0.04/张')
    expect(priceLabel('acme/big', { image: 0.134 })).toBe('$0.134/张')
    expect(priceLabel('acme/whole', { image: '2' })).toBe('$2/张')
    expect(priceLabel('black-forest-labs/flux-free:free', { image: '0' })).toBe('免费')
    expect(priceLabel('acme/zero', { prompt: '0', completion: '0', image: '0', request: '0' })).toBe('免费')
    expect(priceLabel('acme/tokens', { prompt: '0.000001', completion: '0.00002', image: '0' })).toBeUndefined()
    expect(priceLabel('acme/none', undefined)).toBeUndefined()
  })

  it('listImageModels carries the price from the OpenRouter list', async () => {
    clearImageModelCache()
    const scope: ModelScope = { key: (n) => (n === 'OPENROUTER_API_KEY' ? 'test-or-key' : null), custom: [] }
    const fakeFetch = (async (input: RequestInfo | URL) => {
      if (!String(input).includes('/models?output_modalities=image')) return new Response('not found', { status: 404 })
      return Response.json({
        data: [
          {
            id: 'google/gemini-2.5-flash-image',
            name: 'Gemini Flash Image',
            pricing: { prompt: '0', completion: '0.00003', image: '0.04', request: '0' },
            architecture: { output_modalities: ['image', 'text'], input_modalities: ['text', 'image'] },
          },
          {
            id: 'black-forest-labs/flux-free:free',
            name: 'Flux free',
            pricing: { prompt: '0', completion: '0', image: '0', request: '0' },
            architecture: { output_modalities: ['image'], input_modalities: ['text'] },
          },
          { id: 'acme/no-price', name: 'No price', architecture: { output_modalities: ['image'], input_modalities: ['text'] } },
        ],
      })
    }) as typeof fetch
    const models = await listImageModels(scope, fakeFetch)
    expect(models.find((x) => x.id === 'openrouter:google/gemini-2.5-flash-image')).toMatchObject({ label: 'Gemini Flash Image', price: '$0.04/张' })
    expect(models.find((x) => x.id === 'openrouter:black-forest-labs/flux-free:free')?.price).toBe('免费')
    expect(models.find((x) => x.id === 'openrouter:acme/no-price')).not.toHaveProperty('price')
    clearImageModelCache()
  })
})

describe('draw.io download helpers', () => {
  it('pins a release and builds its war URL', () => {
    expect(DRAWIO_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(drawioUrl('26.0.9')).toBe('https://github.com/jgraph/drawio/releases/download/v26.0.9/draw.war')
  })

  it('refuses zip entries that could escape the folder', () => {
    for (const bad of ['../evil.js', 'js/../../evil.js', '/etc/passwd', 'C:/x.js', 'a\\..\\b.js', '', 'x\0y']) {
      expect(unsafeEntry(bad), bad).toBe(true)
    }
    for (const good of ['index.html', 'js/app.js', 'images/a..b.png', 'styles/.hidden']) {
      expect(unsafeEntry(good), good).toBe(false)
    }
  })
})

describe('package import reports dropped files', () => {
  const MAX_IMAGE = 20 * 1024 * 1024
  let h: { server: RunningServer; base: string; token: string }

  beforeEach(async () => {
    if (!h) h = await boot()
  })
  afterAll(async () => {
    await h?.server.close()
  })

  const stateB64 = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString('base64')
  const manifest = (assets: unknown[], skipped: unknown[] = []) => ({
    format: 'stetpad-package',
    version: 2,
    title: 'Dropped files',
    exportedAt: new Date().toISOString(),
    state: stateB64,
    blocks: [],
    versions: [],
    assets,
    skipped,
  })
  const post = (zip: Uint8Array) =>
    fetch(`${h.base}/api/import/package`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/octet-stream' },
      body: new Blob([zip as BlobPart]),
    })

  it('lists a file of a disallowed type, a missing file, an oversize file, and excluded videos', async () => {
    const zip = zipSync(
      {
        'document.json': new TextEncoder().encode(
          JSON.stringify(
            manifest(
              [
                { id: 'evil1', mime: 'application/x-msdownload', name: 'setup.exe', size: 4, path: 'assets/evil1' },
                { id: 'gone1', mime: 'image/png', name: 'gone.png', size: 3, path: 'assets/gone1' },
                { id: 'big1', mime: 'image/png', name: 'huge.png', size: MAX_IMAGE + 1, path: 'assets/big1' },
                { id: 'ok1', mime: 'image/png', name: 'ok.png', size: 4, path: 'assets/ok1' },
              ],
              [{ id: 'vid1', mime: 'video/mp4', size: 10, reason: 'video-excluded' }],
            ),
          ),
        ),
        'assets/evil1': new Uint8Array([1, 2, 3, 4]),
        'assets/big1': new Uint8Array(MAX_IMAGE + 1),
        'assets/ok1': new Uint8Array([137, 80, 78, 71]),
      },
      { level: 0 },
    )
    const res = await post(zip)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { title: string; dropped: { name: string | null; mime: string; reason: string }[] }
    expect(body.title).toBe('Dropped files')
    expect(body.dropped).toHaveLength(4)
    expect(body.dropped).toEqual(
      expect.arrayContaining([
        { name: 'setup.exe', mime: 'application/x-msdownload', reason: 'type' },
        { name: 'gone.png', mime: 'image/png', reason: 'missing' },
        { name: 'huge.png', mime: 'image/png', reason: 'size' },
        { name: null, mime: 'video/mp4', reason: 'excluded' },
      ]),
    )
  })

  it('a complete package reports nothing dropped', async () => {
    const created = (await (
      await fetch(`${h.base}/api/import/create`, {
        method: 'POST',
        headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Plain', blocks: [{ type: 'paragraph', text: 'hello' }] }),
      })
    ).json()) as { id: string }
    const zip = new Uint8Array(await (await fetch(`${h.base}/api/docs/${created.id}/package`, { headers: { authorization: `Bearer ${h.token}` } })).arrayBuffer())
    const res = await post(zip)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { dropped: unknown[] }).dropped).toEqual([])
  })
})
