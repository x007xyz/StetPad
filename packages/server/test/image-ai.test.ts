import { createCanvas } from '@napi-rs/canvas'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../src'
import { clearImageModelCache, editImageBytes, listImageEditModels } from '../src/images'
import { isVisionModelId, providerKeyNames, visionModelFor, type ModelScope } from '../src/models'

// A 1x1 PNG. Real bytes, so the magic-byte check passes.
const B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG = Uint8Array.from(atob(B64), (c) => c.charCodeAt(0))
// Uploads are deduplicated by content, so the edit result and the foreign file need bytes of their own.
const OUT_PNG = new Uint8Array(createCanvas(2, 2).toBuffer('image/png'))
const FOREIGN_PNG = new Uint8Array(createCanvas(3, 3).toBuffer('image/png'))

// Editable: takes image input and gives image output. Generation only: no image input.
const OR_MODELS = {
  data: [
    { id: 'x/edit', name: 'Model Edit', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image', 'text'] } },
    { id: 'x/gen', name: 'Model Gen', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
  ],
}

const okChat = {
  choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${B64}` } }] } }],
  usage: { prompt_tokens: 7, completion_tokens: 2 },
}
const outChat = {
  choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${Buffer.from(OUT_PNG).toString('base64')}` } }] } }],
  usage: { prompt_tokens: 7, completion_tokens: 2 },
}

/** Answers the OpenRouter model list and chat completions; records chat request bodies. */
function fakeOpenRouter(bodies: Record<string, unknown>[] = [], chat: unknown = okChat): typeof fetch {
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

const orScope = (): ModelScope => ({ key: (n) => (n === 'OPENROUTER_API_KEY' ? 'test-or-key' : null), custom: [] })

// Keys from the environment or ~/.dsh would make these tests call real providers. Hide them.
const hidden = ['DSH_HOME', ...providerKeyNames().map((p) => p.keyName)]
const saved: Record<string, string | undefined> = {}
let dshDir = ''

beforeAll(() => {
  for (const k of hidden) saved[k] = process.env[k]
  dshDir = mkdtempSync(join(tmpdir(), 'aiw-image-ai-dsh-'))
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

describe('visionModelFor', () => {
  const withKeys = (keys: Record<string, string>, extra?: ModelScope['extra']): ModelScope => ({
    key: (n) => keys[n] ?? null,
    custom: [],
    ...(extra ? { extra } : {}),
  })

  it('picks a built-in provider model when its key is set', () => {
    const id = visionModelFor(withKeys({ ANTHROPIC_API_KEY: 'k' }))
    expect(id).toMatch(/^anthropic:/)
  })

  it('recognises vision-capable OpenRouter families and rejects the rest', () => {
    expect(isVisionModelId('openrouter:anthropic/claude-x')).toBe(true)
    expect(isVisionModelId('openrouter:openai/gpt-4o')).toBe(true)
    expect(isVisionModelId('openrouter:openai/gpt-5-mini')).toBe(true)
    expect(isVisionModelId('openrouter:google/gemini-2.5-flash')).toBe(true)
    expect(isVisionModelId('openrouter:meta-llama/llama-3')).toBe(false)
    expect(isVisionModelId('openrouter:openai/o1')).toBe(false)
    expect(isVisionModelId('deepseek:deepseek-flash')).toBe(false)
  })

  it('returns a vision model when OpenRouter is keyed, even among non-vision extras', () => {
    const id = visionModelFor(withKeys({ OPENROUTER_API_KEY: 'k' }, { openrouter: [{ id: 'meta-llama/llama-3' }] }))
    expect(id && isVisionModelId(id)).toBe(true)
  })

  it('returns undefined without any key', () => {
    expect(visionModelFor({ key: () => null, custom: [] })).toBeUndefined()
  })

  it('never picks a non-vision OpenRouter model', () => {
    const id = visionModelFor(withKeys({ OPENROUTER_API_KEY: 'k' }, { openrouter: [{ id: 'meta-llama/llama-3' }] }))
    expect(id).toMatch(/^openrouter:(anthropic|openai\/gpt-4|openai\/gpt-5|google\/gemini)/)
  })
})

describe('listImageEditModels', () => {
  it('keeps only OpenRouter models that take image input', async () => {
    const models = await listImageEditModels(orScope(), fakeOpenRouter())
    expect(models).toEqual([{ id: 'openrouter:x/edit', label: 'Model Edit' }])
  })

  it('returns nothing without keys', async () => {
    expect(await listImageEditModels({ key: () => null, custom: [] }, fakeOpenRouter())).toEqual([])
  })
})

describe('editImageBytes', () => {
  it('sends the image as a data URL with the prompt and parses the returned image', async () => {
    const bodies: Record<string, unknown>[] = []
    const r = await editImageBytes('openrouter:x/edit', { data: PNG, mime: 'image/png' }, 'make it blue', {
      scope: orScope(),
      fetchFn: fakeOpenRouter(bodies),
    })
    expect(r.mime).toBe('image/png')
    expect(Array.from(r.data)).toEqual(Array.from(PNG))
    expect(r.usage).toEqual({ inputTokens: 7, outputTokens: 2 })
    const content = (bodies[0]?.messages as { content: { type: string; text?: string; image_url?: { url: string } }[] }[])[0]!.content
    expect(content[0]).toEqual({ type: 'text', text: 'make it blue' })
    expect(content[1]?.image_url?.url).toBe(`data:image/png;base64,${B64}`)
  })

  it('refuses a model that does not take image input', async () => {
    await expect(editImageBytes('openrouter:x/gen', { data: PNG, mime: 'image/png' }, 'x', { scope: orScope(), fetchFn: fakeOpenRouter() })).rejects.toThrow('不支持的图片模型')
  })

  it('refuses an image type that cannot be edited', async () => {
    await expect(editImageBytes('openrouter:x/edit', { data: PNG, mime: 'image/svg+xml' }, 'x', { scope: orScope(), fetchFn: fakeOpenRouter() })).rejects.toThrow()
  })

  it('throws when the reply carries no valid image', async () => {
    const text = Buffer.from('hello, not an image').toString('base64')
    const chat = { choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${text}` } }] } }] }
    await expect(editImageBytes('openrouter:x/edit', { data: PNG, mime: 'image/png' }, 'x', { scope: orScope(), fetchFn: fakeOpenRouter([], chat) })).rejects.toThrow()
  })
})

describe('image-ai routes', () => {
  let server: RunningServer
  let dir: string
  let base: string
  let token = ''
  let docId = ''
  let otherDocId = ''
  let fileSrc = ''
  let foreignSrc = ''
  const bodies: Record<string, unknown>[] = []

  const api = (path: string, init: RequestInit = {}) =>
    fetch(base + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    })

  const uploadPng = async (doc: string, bytes: Uint8Array): Promise<string> => {
    const r = await api(`/api/docs/${doc}/assets`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-file-name': 'a.png' }, body: new Blob([bytes as BlobPart]) })
    expect(r.status).toBe(200)
    return (await r.json()).url as string
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-image-ai-'))
    server = await startServer({ dataDir: dir, port: 0, imageFetch: fakeOpenRouter(bodies, outChat) })
    base = `http://127.0.0.1:${server.port}`
    token = server.token ?? ''
    docId = ((await (await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'ai' }) })).json()) as { id: string }).id
    otherDocId = ((await (await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'other' }) })).json()) as { id: string }).id
    fileSrc = await uploadPng(docId, PNG)
    foreignSrc = await uploadPng(otherDocId, FOREIGN_PNG)
  })

  afterAll(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('answers 400 to describe without a vision model', async () => {
    const r = await api(`/api/docs/${docId}/ai/describe`, { method: 'POST', body: JSON.stringify({ src: fileSrc }) })
    expect(r.status).toBe(400)
    // The message now also says where to choose one (the vision role, once the settings are saved).
    expect(await r.json()).toEqual({ error: '没有可识别图片的模型，请在设置里选择识图模型' })
  })

  it('answers 404 to describe for a file of another document, and for an unknown file', async () => {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ keys: { ANTHROPIC_API_KEY: 'test-anthropic-key' } }) })
    const foreign = await api(`/api/docs/${docId}/ai/describe`, { method: 'POST', body: JSON.stringify({ src: foreignSrc }) })
    expect(foreign.status).toBe(404)
    const unknown = await api(`/api/docs/${docId}/ai/describe`, { method: 'POST', body: JSON.stringify({ src: '/files/doesnotexist' }) })
    expect(unknown.status).toBe(404)
    const malformed = await api(`/api/docs/${docId}/ai/describe`, { method: 'POST', body: JSON.stringify({ src: 'https://example.com/a.png' }) })
    expect(malformed.status).toBe(400)
  })

  it('answers 400 to an image edit without an edit model, after the image is found', async () => {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ keys: { ANTHROPIC_API_KEY: '' } }) })
    expect((await (await api('/api/image-edit-models')).json()).models).toEqual([])
    const r = await api(`/api/docs/${docId}/ai/image-edit`, { method: 'POST', body: JSON.stringify({ src: fileSrc, prompt: 'blue' }) })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toContain('图片编辑模型')
  })

  it('answers 404 to an image edit of a foreign file', async () => {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ keys: { OPENROUTER_API_KEY: 'test-or-key' } }) })
    const r = await api(`/api/docs/${docId}/ai/image-edit`, { method: 'POST', body: JSON.stringify({ src: foreignSrc, prompt: 'blue' }) })
    expect(r.status).toBe(404)
  })

  it('stores the edited image as a new asset of the document', async () => {
    const models = await (await api('/api/image-edit-models')).json()
    expect(models).toEqual({ models: [{ id: 'openrouter:x/edit', label: 'Model Edit' }], default: 'openrouter:x/edit' })

    const r = await api(`/api/docs/${docId}/ai/image-edit`, { method: 'POST', body: JSON.stringify({ src: fileSrc, prompt: 'make it blue' }) })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.mime).toBe('image/png')
    expect(body.modelId).toBe('openrouter:x/edit')
    expect(body.url).toMatch(/^\/files\/[\w-]+$/)
    expect(body.url).not.toBe(fileSrc)

    const file = await fetch(base + body.url)
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(Array.from(OUT_PNG))
    const sent = JSON.stringify(bodies.at(-1)?.messages)
    expect(sent).toContain('make it blue')
    expect(sent).toContain('data:image/png;base64,')
  })

  it('answers 400 to an empty edit prompt', async () => {
    const r = await api(`/api/docs/${docId}/ai/image-edit`, { method: 'POST', body: JSON.stringify({ src: fileSrc, prompt: '  ' }) })
    expect(r.status).toBe(400)
  })
})
