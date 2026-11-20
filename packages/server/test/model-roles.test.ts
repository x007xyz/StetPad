import { createCanvas } from '@napi-rs/canvas'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type RunningServer, type ServerConfig } from '../src'
import { editImageBytes, generateImageBytes } from '../src/images'
import { capsOf, parseCaps, providerKeyNames, type ModelScope } from '../src/models'
import type { Transcriber } from '../src/transcribe'

// Keys from the environment or ~/.dsh would make these tests call real providers. Hide them.
const hidden = ['DSH_HOME', ...providerKeyNames().map((p) => p.keyName)]
const saved: Record<string, string | undefined> = {}
let dshDir = ''

beforeAll(() => {
  for (const k of hidden) saved[k] = process.env[k]
  dshDir = mkdtempSync(join(tmpdir(), 'aiw-roles-dsh-'))
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

const BASE_URL = 'https://llm.example.com/v1'
const OUT_PNG = new Uint8Array(createCanvas(2, 2).toBuffer('image/png'))
const OUT_B64 = Buffer.from(OUT_PNG).toString('base64')

/** A fake OpenAI-compatible endpoint for images. Records every request; never leaves the test. */
function fakeImages(log: { url: string; body: unknown }[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    log.push({ url, body: init?.body })
    if (url.endsWith('/images/generations')) return Response.json({ data: [{ b64_json: OUT_B64 }] })
    if (url.endsWith('/images/edits')) return Response.json({ data: [{ b64_json: OUT_B64 }] })
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

const provider = (models: unknown[]) => ({ id: 'x', name: 'X', baseURL: BASE_URL, models })

interface Box {
  server: RunningServer
  dir: string
  base: string
  token: string
}

async function boot(options: Partial<ServerConfig> = {}): Promise<Box> {
  const dir = mkdtempSync(join(tmpdir(), 'aiw-roles-'))
  const server = await startServer({ dataDir: dir, port: 0, ...options })
  return { server, dir, base: `http://127.0.0.1:${server.port}`, token: server.token ?? '' }
}

function apiOf(box: Box) {
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(box.base + path, {
      ...init,
      headers: { authorization: `Bearer ${box.token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    })
    return { status: res.status, body: (await res.json()) as Record<string, any> }
  }
  const put = (body: unknown) => call('/api/settings', { method: 'PUT', body: JSON.stringify(body) })
  return { call, put }
}

describe('model capabilities', () => {
  let box: Box
  let api: ReturnType<typeof apiOf>

  beforeAll(async () => {
    box = await boot()
    api = apiOf(box)
  })
  afterAll(async () => {
    await box.server.close()
    rmSync(box.dir, { recursive: true, force: true })
  })

  it('gives a model without a choice the default text and vision capabilities', async () => {
    expect((await api.put({ customProviders: [provider([{ id: 'A' }])] })).status).toBe(200)
    const { models } = (await api.call('/api/models')).body as { models: { id: string; caps: string[] }[] }
    expect(models.find((m) => m.id === 'custom-x:A')?.caps).toEqual(['text', 'vision'])
  })

  it('keeps the capabilities a model was saved with, and rejects an unknown one', async () => {
    expect((await api.put({ customProviders: [provider([{ id: 'A', caps: ['text'] }])] })).status).toBe(200)
    const { models } = (await api.call('/api/models')).body as { models: { id: string; caps: string[] }[] }
    expect(models.find((m) => m.id === 'custom-x:A')?.caps).toEqual(['text'])

    const bad = await api.put({ customProviders: [provider([{ id: 'A', caps: ['video'] }])] })
    expect(bad.status).toBe(400)
    expect(typeof bad.body.error).toBe('string')
    expect((await api.put({ customProviders: [provider([{ id: 'A', caps: 'text' }])] })).status).toBe(400)
    // The rejected save wrote nothing: the previous capabilities are still there.
    const after = (await api.call('/api/models')).body as { models: { id: string; caps: string[] }[] }
    expect(after.models.find((m) => m.id === 'custom-x:A')?.caps).toEqual(['text'])
  })

  it('dedupes capabilities and allows an empty list', () => {
    expect(parseCaps(['text', 'vision', 'text'])).toEqual(['text', 'vision'])
    expect(parseCaps([])).toEqual([])
    expect(() => parseCaps(['text', 'speech'])).toThrow()
  })

  it('round-trips the capabilities of a built-in model, and reports them in the provider page', async () => {
    expect((await api.put({ keys: { ANTHROPIC_API_KEY: 'test-anthropic-key' }, modelCaps: { 'anthropic:claude-haiku-5-5': ['text'] } })).status).toBe(200)
    const models = ((await api.call('/api/models')).body as { models: { id: string; caps: string[] }[] }).models
    expect(models.find((m) => m.id === 'anthropic:claude-haiku-5-5')?.caps).toEqual(['text'])
    expect(models.find((m) => m.id === 'anthropic:claude-sonnet-5-5')?.caps).toEqual(['text', 'vision'])

    const providers = ((await api.call('/api/models')).body as { providerList: { id: string; models: { id: string; caps: string[] }[] }[] }).providerList
    const row = providers.find((p) => p.id === 'anthropic')?.models.find((m) => m.id === 'anthropic:claude-haiku-5-5')
    expect(row?.caps).toEqual(['text'])

    // Only built-in ids may carry capabilities, and only known capability names.
    expect((await api.put({ modelCaps: { 'nobody:model': ['text'] } })).status).toBe(400)
    expect((await api.put({ modelCaps: { 'anthropic:claude-haiku-5-5': ['audio', 'video'] } })).status).toBe(400)
    // A whole-map replacement: the earlier entry is gone once the map is saved without it.
    expect((await api.put({ modelCaps: {} })).status).toBe(200)
    const cleared = ((await api.call('/api/models')).body as { models: { id: string; caps: string[] }[] }).models
    expect(cleared.find((m) => m.id === 'anthropic:claude-haiku-5-5')?.caps).toEqual(['text', 'vision'])
  })

  it('reads a custom model capability through capsOf', () => {
    const scope: ModelScope = {
      key: () => null,
      custom: [{ id: 'x', name: 'X', baseURL: BASE_URL, models: [{ id: 'A' }, { id: 'B', caps: ['text'] }, { id: 'C', caps: [] }] }],
      caps: { 'deepseek:deepseek-flash': ['text'] },
    }
    expect(capsOf('custom-x:A', scope)).toEqual(['text', 'vision'])
    expect(capsOf('custom-x:B', scope)).toEqual(['text'])
    expect(capsOf('custom-x:C', scope)).toEqual([])
    expect(capsOf('deepseek:deepseek-flash', scope)).toEqual(['text'])
    expect(capsOf('openai:gpt-5.6-luna', scope)).toEqual(['text', 'vision'])
  })
})

describe('model roles', () => {
  let box: Box
  let api: ReturnType<typeof apiOf>
  const transcripts: Parameters<Transcriber>[0][] = []
  const transcribe: Transcriber = async (req) => {
    transcripts.push(req)
    return { text: 'hi', segments: [{ start: 0, end: 1, text: 'hi' }] }
  }
  const imageLog: { url: string; body: unknown }[] = []

  const roles = async () => (await api.call('/api/model-roles')).body.roles as { key: string; label: string; value: string; effective: string | null; options: { id: string; label: string }[] }[]
  const role = async (key: string) => (await roles()).find((r) => r.key === key)!
  /** The custom provider with a text+vision model A, a text model B and an audio model C; C also draws images. */
  const standard = [
    { id: 'A', caps: ['text', 'vision'] },
    { id: 'B', caps: ['text'] },
    { id: 'C', caps: ['audio'] },
    { id: 'img', caps: ['image'] },
  ]

  beforeAll(async () => {
    box = await boot({ transcribe, imageFetch: fakeImages(imageLog) })
    api = apiOf(box)
    expect((await api.put({ customProviders: [provider(standard)] })).status).toBe(200)
  })
  afterAll(async () => {
    await box.server.close()
    rmSync(box.dir, { recursive: true, force: true })
  })

  it('lists the six roles in order with their labels', async () => {
    expect((await roles()).map((r) => [r.key, r.label])).toEqual([
      ['text', '默认模型'],
      ['vision', '识图模型'],
      ['image', '图片生成模型'],
      ['imageEdit', '改图模型'],
      ['transcribe', '语音转写模型'],
      ['diagram', '图表生成模型'],
    ])
  })

  it('offers each role the models with its capability, and resolves the automatic choices', async () => {
    expect((await role('vision')).options.map((o) => o.id)).toEqual(['custom-x:A'])
    expect((await role('transcribe')).options.map((o) => o.id)).toContain('custom-x:C')
    expect((await role('text')).options.map((o) => o.id)).toEqual(['custom-x:A', 'custom-x:B'])
    expect((await role('image')).options.map((o) => o.id)).toEqual(['custom-x:img'])
    expect((await role('imageEdit')).options).toEqual([])

    const text = await role('text')
    expect(text.effective).toBe('custom-x:A')
    expect((await role('diagram')).effective).toBe(text.effective)
    expect((await role('vision')).effective).toBe('custom-x:A')
    expect((await role('transcribe')).effective).toBe('custom-x:C')
    expect((await role('imageEdit')).effective).toBeNull()
  })

  it('picks the default model for vision when it has 识图, else the first model that has it', async () => {
    // Any model the user leaves with 识图 on counts, whatever its family (DeepSeek reads images too).
    const ds = { id: 'ds', caps: ['text', 'vision'] }
    expect((await api.put({ customProviders: [provider([{ id: 'B', caps: ['text'] }, ds, { id: 'A', caps: ['text', 'vision'] }])], model: 'custom-x:ds' })).status).toBe(200)
    expect((await role('vision')).effective).toBe('custom-x:ds')
    expect((await api.put({ model: 'custom-x:B' })).status).toBe(200)
    expect((await role('vision')).effective).toBe('custom-x:ds')
    expect((await api.put({ customProviders: [provider(standard)], model: '' })).status).toBe(200)
  })

  it('rejects a vision choice that is not a vision option, and writes nothing', async () => {
    const bad = await api.put({ roles: { vision: 'custom-x:B' } })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain('识图模型')
    expect((await role('vision')).value).toBe('')
  })

  it('saves a vision choice, shows it as effective, and clears it back to automatic', async () => {
    expect((await api.put({ roles: { vision: 'custom-x:A' } })).status).toBe(200)
    let vision = await role('vision')
    expect(vision).toMatchObject({ value: 'custom-x:A', effective: 'custom-x:A' })

    expect((await api.put({ roles: { vision: '' } })).status).toBe(200)
    vision = await role('vision')
    expect(vision).toMatchObject({ value: '', effective: 'custom-x:A' })
  })

  it('falls back to automatic when the saved choice is no longer offered', async () => {
    expect((await api.put({ roles: { transcribe: 'custom-x:C' } })).status).toBe(200)
    // Without the audio model the choice is stale: nothing transcribes now.
    expect((await api.put({ customProviders: [provider([{ id: 'A', caps: ['text', 'vision'] }])] })).status).toBe(200)
    expect(await role('transcribe')).toMatchObject({ value: 'custom-x:C', effective: null, options: [] })
    expect((await api.put({ customProviders: [provider(standard)] })).status).toBe(200)
    expect((await role('transcribe')).effective).toBe('custom-x:C')
  })

  it('rejects roles that are not settable, and values that are not options', async () => {
    expect((await api.put({ roles: { text: 'custom-x:A' } })).status).toBe(400)
    expect((await api.put({ roles: { diagram: 'custom-x:img' } })).status).toBe(400)
    expect((await api.put({ roles: { transcribe: 'custom-x:A' } })).status).toBe(400)
    expect((await api.put({ roles: 'vision' })).status).toBe(400)
  })

  it('keeps the image role in the existing imageModel setting', async () => {
    expect((await api.put({ roles: { image: 'custom-x:img' } })).status).toBe(200)
    const settings = (await api.call('/api/settings')).body
    expect(settings.imageModel).toBe('custom-x:img')
    expect((await role('image')).effective).toBe('custom-x:img')
    expect((await api.put({ roles: { image: '' } })).status).toBe(200)
    expect((await api.call('/api/settings')).body.imageModel).toBe('')
  })

  it('answers 400 to describe when no model is offered for vision', async () => {
    expect((await api.put({ customProviders: [provider([{ id: 'B', caps: ['text'] }])] })).status).toBe(200)
    const doc = (await api.call('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'alt' }) })).body.id as string
    const r = await api.call(`/api/docs/${doc}/ai/describe`, { method: 'POST', body: JSON.stringify({ src: '/files/abc' }) })
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: '没有可识别图片的模型，请在设置里选择识图模型' })
    expect((await api.put({ customProviders: [provider(standard)] })).status).toBe(200)
  })

  it('sends transcription to the chosen audio model, by its full id', async () => {
    transcripts.length = 0
    const doc = (await api.call('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'video' }) })).body.id as string
    const up = await fetch(`${box.base}/api/docs/${doc}/assets`, { method: 'POST', headers: { authorization: `Bearer ${box.token}`, 'content-type': 'video/mp4' }, body: new Uint8Array([1, 2, 3, 4, 5]) })
    const src = (await up.json()).url as string
    const r = await api.call(`/api/docs/${doc}/ai/transcribe`, { method: 'POST', body: JSON.stringify({ src }) })
    expect(r.status).toBe(200)
    expect(transcripts).toHaveLength(1)
    expect(transcripts[0]).toMatchObject({ provider: 'custom', modelId: 'custom-x:C', baseURL: BASE_URL, apiKey: '' })
  })

  it('generates an image with a custom model flagged for images, through an injected fetch', async () => {
    imageLog.length = 0
    const scope: ModelScope = { key: () => null, custom: [{ id: 'x', name: 'X', baseURL: BASE_URL, models: [{ id: 'img', caps: ['image'] }] }] }
    const out = await generateImageBytes('custom-x:img', 'a red square', { scope, fetchFn: fakeImages(imageLog) })
    expect(out.mime).toBe('image/png')
    expect(Array.from(out.data)).toEqual(Array.from(OUT_PNG))
    expect(imageLog[0]?.url).toBe(`${BASE_URL}/images/generations`)
    expect(String(imageLog[0]?.body)).toContain('a red square')
  })

  it('edits an image with a custom model flagged for editing, as multipart form data', async () => {
    imageLog.length = 0
    const scope: ModelScope = { key: (n) => (n === 'custom:x' ? 'k-test' : null), custom: [{ id: 'x', name: 'X', baseURL: BASE_URL, models: [{ id: 'ed', caps: ['imageEdit'] }] }] }
    const out = await editImageBytes('custom-x:ed', { data: OUT_PNG, mime: 'image/png' }, 'make it blue', { scope, fetchFn: fakeImages(imageLog) })
    expect(Array.from(out.data)).toEqual(Array.from(OUT_PNG))
    expect(imageLog[0]?.url).toBe(`${BASE_URL}/images/edits`)
    const form = imageLog[0]?.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('ed')
    expect(form.get('prompt')).toBe('make it blue')
    expect(form.get('image')).toBeInstanceOf(Blob)
  })
})
