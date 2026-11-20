import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../src'
import { clearImageModelCache, generateImageBytes, listImageModels } from '../src/images'
import { providerKeyNames, type ModelScope } from '../src/models'

// A 1x1 PNG. Real bytes, so the magic-byte check passes.
const B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG = Uint8Array.from(atob(B64), (c) => c.charCodeAt(0))

const OR_MODELS = {
  data: [
    { id: 'x/y', name: 'Model X', architecture: { output_modalities: ['image'] } },
    { id: 'a/b', name: 'Model B', architecture: { output_modalities: ['image', 'text'] } },
  ],
}

/** Answers the OpenRouter model list and chat completions; records chat request bodies. */
function fakeOpenRouter(chat: unknown, bodies: Record<string, unknown>[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/models?output_modalities=image')) return Response.json(OR_MODELS)
    if (url.endsWith('/chat/completions')) {
      bodies.push(JSON.parse(String(init?.body ?? '{}')))
      return Response.json(chat)
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

const okChat = {
  choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${B64}` } }] } }],
  usage: { prompt_tokens: 3, completion_tokens: 5 },
}

const orScope = (): ModelScope => ({ key: (n) => (n === 'OPENROUTER_API_KEY' ? 'test-or-key' : null), custom: [] })
const noScope = (): ModelScope => ({ key: () => null, custom: [] })

// Keys from the environment or ~/.dsh would make these tests call real providers. Hide them.
const hidden = ['DSH_HOME', ...providerKeyNames().map((p) => p.keyName)]
const saved: Record<string, string | undefined> = {}
let dshDir = ''

beforeAll(() => {
  for (const k of hidden) saved[k] = process.env[k]
  dshDir = mkdtempSync(join(tmpdir(), 'aiw-images-dsh-'))
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

beforeEach(() => clearImageModelCache())

describe('listImageModels', () => {
  it('lists OpenRouter image models with the provider prefix when only that key is set', async () => {
    const models = await listImageModels(orScope(), fakeOpenRouter(okChat))
    expect(models).toEqual([
      { id: 'openrouter:x/y', label: 'Model X' },
      { id: 'openrouter:a/b', label: 'Model B' },
    ])
  })

  it('returns nothing without keys', async () => {
    expect(await listImageModels(noScope(), fakeOpenRouter(okChat))).toEqual([])
  })

  it('returns nothing when the OpenRouter list cannot be fetched', async () => {
    const down = (async () => new Response('down', { status: 503 })) as typeof fetch
    expect(await listImageModels(orScope(), down)).toEqual([])
  })
})

describe('generateImageBytes', () => {
  it('returns the PNG bytes of an OpenRouter data URL and sends image-only modalities for an image-only model', async () => {
    const bodies: Record<string, unknown>[] = []
    const r = await generateImageBytes('openrouter:x/y', 'a red square', {
      size: '1024x1024',
      scope: orScope(),
      fetchFn: fakeOpenRouter(okChat, bodies),
    })
    expect(r.mime).toBe('image/png')
    expect(Array.from(r.data)).toEqual(Array.from(PNG))
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 5 })
    expect(bodies[0]?.modalities).toEqual(['image'])
    expect(JSON.stringify(bodies[0]?.messages)).toContain('a red square')
  })

  it('throws when the response has no image', async () => {
    const chat = { choices: [{ message: { content: 'sorry' } }] }
    await expect(generateImageBytes('openrouter:x/y', 'x', { scope: orScope(), fetchFn: fakeOpenRouter(chat) })).rejects.toThrow()
  })

  it('throws when the bytes are not a supported image, whatever the data URL claims', async () => {
    const text = Buffer.from('hello, not an image').toString('base64')
    const chat = { choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${text}` } }] } }] }
    await expect(generateImageBytes('openrouter:x/y', 'x', { scope: orScope(), fetchFn: fakeOpenRouter(chat) })).rejects.toThrow()
  })

  it('refuses a model of an unknown provider', async () => {
    await expect(generateImageBytes('nope:model', 'x', { scope: orScope(), fetchFn: fakeOpenRouter(okChat) })).rejects.toThrow('不支持的图片模型')
  })

  it('refuses a size outside the three supported ones', async () => {
    await expect(generateImageBytes('openrouter:x/y', 'x', { size: '512x512', scope: orScope(), fetchFn: fakeOpenRouter(okChat) })).rejects.toThrow()
  })
})

describe('image routes', () => {
  let server: RunningServer
  let dir: string
  let base: string
  let token = ''
  let docId = ''
  const calls: string[] = []

  const api = (path: string, init: RequestInit = {}) =>
    fetch(base + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-images-'))
    const imageFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input))
      return fakeOpenRouter(okChat)(input, init)
    }) as typeof fetch
    server = await startServer({ dataDir: dir, port: 0, imageFetch })
    base = `http://127.0.0.1:${server.port}`
    token = server.token ?? ''
    const r = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'images' }) })
    docId = (await r.json()).id as string
  })

  afterAll(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists no models and no default without keys', async () => {
    const r = await api('/api/image-models')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ models: [], default: null })
  })

  it('answers 400 to a generation request without keys', async () => {
    const r = await api(`/api/docs/${docId}/ai/image`, { method: 'POST', body: JSON.stringify({ prompt: 'a cat' }) })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toContain('图片模型')
  })

  it('answers 400 to an empty prompt', async () => {
    const r = await api(`/api/docs/${docId}/ai/image`, { method: 'POST', body: JSON.stringify({ prompt: '   ' }) })
    expect(r.status).toBe(400)
  })

  it('generates an image once an OpenRouter key is saved, and serves the stored file', async () => {
    const put = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ keys: { OPENROUTER_API_KEY: 'test-or-key' } }) })
    expect(put.status).toBe(200)

    const models = await (await api('/api/image-models')).json()
    expect(models.models.map((m: { id: string }) => m.id)).toEqual(['openrouter:x/y', 'openrouter:a/b'])
    expect(models.default).toBe('openrouter:x/y')

    const r = await api(`/api/docs/${docId}/ai/image`, { method: 'POST', body: JSON.stringify({ prompt: 'a cat', size: '1536x1024' }) })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.mime).toBe('image/png')
    expect(body.modelId).toBe('openrouter:x/y')
    expect(body.url).toMatch(/^\/files\/[\w-]+$/)

    const file = await fetch(base + body.url)
    expect(file.status).toBe(200)
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(Array.from(PNG))
    expect(calls.some((u) => u.endsWith('/chat/completions'))).toBe(true)
  })

  it('clears the saved image model with an empty string', async () => {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ imageModel: 'openrouter:a/b' }) })
    expect((await (await api('/api/image-models')).json()).default).toBe('openrouter:a/b')
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ imageModel: '' }) })
    expect((await (await api('/api/image-models')).json()).default).toBe('openrouter:x/y')
  })
})

describe('cropToRatio', () => {
  it('centre-crops a 4:3 picture to 3:2 and leaves a matching one alone', async () => {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas')
    const { cropToRatio } = await import('../src/images')
    const src = new Uint8Array(createCanvas(400, 300).toBuffer('image/png'))
    const out = await loadImage(Buffer.from(await cropToRatio(src, 3 / 2)))
    expect([out.width, out.height]).toEqual([400, 267])
    const tall = await loadImage(Buffer.from(await cropToRatio(new Uint8Array(createCanvas(300, 400).toBuffer('image/png')), 2 / 3)))
    expect([tall.width, tall.height]).toEqual([267, 400])
    const same = new Uint8Array(createCanvas(300, 200).toBuffer('image/png'))
    expect(await cropToRatio(same, 3 / 2)).toBe(same)
  })
})
