import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../src'
import { catalogEntry } from '../src/provider-catalog'
import { stubAgentDiscovery } from './stub-agent-discovery'

stubAgentDiscovery()

const SECRET = 'sk-custom-test-secret-7731'
const BASE_URL = 'https://llm.example.com/v1'

/** A provider as the Settings dialog submits it. */
const provider = (over: Record<string, unknown> = {}) => ({
  id: 'ollama',
  name: 'Ollama',
  baseURL: BASE_URL,
  models: [{ id: 'qwen3:8b', label: 'Qwen 3 8B' }, { id: 'llama3' }],
  apiKey: SECRET,
  ...over,
})
const withoutKey = (over: Record<string, unknown> = {}) => {
  const { apiKey: _omit, ...rest } = provider(over)
  return rest
}

describe('custom model providers', () => {
  let server: RunningServer
  let dir: string
  let base = ''
  let token = ''
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    })
    return { status: res.status, body: (await res.json()) as Record<string, any> }
  }
  const put = (customProviders: unknown) => call('/api/settings', { method: 'PUT', body: JSON.stringify({ customProviders }) })
  const models = async () => (await call('/api/models')).body as { models: { id: string; label: string; verified: boolean; provider: string }[]; customProviders: Record<string, any>[] }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-custom-'))
    server = await startServer({ dataDir: dir, port: 0 })
    base = `http://127.0.0.1:${server.port}`
    token = server.token
  })
  afterAll(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('saves a provider, lists its models unverified, and never returns the key', async () => {
    expect((await put([provider()])).status).toBe(200)
    const { models: all, customProviders } = await models()
    const custom = all.filter((m) => m.provider === 'custom-ollama')
    expect(custom.map((m) => m.id)).toEqual(['custom-ollama:qwen3:8b', 'custom-ollama:llama3'])
    expect(custom[0]).toMatchObject({ label: 'Qwen 3 8B', verified: false })
    expect(custom[1]).toMatchObject({ label: 'llama3', verified: false })
    expect(customProviders).toHaveLength(1)
    expect(customProviders[0]).toMatchObject({ id: 'ollama', name: 'Ollama', baseURL: BASE_URL, hasKey: true })
    expect(customProviders[0]).not.toHaveProperty('apiKey')
    expect(JSON.stringify(await models())).not.toContain(SECRET)
  })

  it('keeps the saved key when apiKey is omitted', async () => {
    expect((await put([withoutKey()])).status).toBe(200)
    const { customProviders } = await models()
    expect(customProviders[0]).toMatchObject({ id: 'ollama', hasKey: true })
    expect(JSON.stringify(await models())).not.toContain(SECRET)
  })

  it('removes the models and the key of a provider that is left out', async () => {
    expect((await put([])).status).toBe(200)
    let state = await models()
    expect(state.models.some((m) => m.provider.startsWith('custom-'))).toBe(false)
    expect(state.customProviders).toEqual([])

    // Re-adding the same id without a key shows the key was cleared, not kept.
    expect((await put([withoutKey()])).status).toBe(200)
    state = await models()
    expect(state.customProviders[0]).toMatchObject({ id: 'ollama', hasKey: false })
    expect(state.models.filter((m) => m.provider === 'custom-ollama')).toHaveLength(2)
  })

  it('rejects invalid provider lists with a message and keeps the previous list', async () => {
    expect((await put([provider()])).status).toBe(200)
    const bad: [string, unknown[]][] = [
      ['bad id', [provider({ id: 'Bad_ID' })]],
      ['duplicate id', [provider(), provider({ name: 'Other' })]],
      ['empty name', [provider({ name: '   ' })]],
      ['long name', [provider({ name: 'x'.repeat(61) })]],
      ['non-http url', [provider({ baseURL: 'ftp://example.com/v1' })]],
      ['not a url', [provider({ baseURL: 'not a url' })]],
      ['no models', [provider({ models: [] })]],
      ['blank model id', [provider({ models: [{ id: '  ' }] })]],
      ['too many models', [provider({ models: Array.from({ length: 51 }, (_, i) => ({ id: `m${i}` })) })]],
      ['too many providers', Array.from({ length: 21 }, (_, i) => provider({ id: `p${i}` }))],
    ]
    for (const [what, input] of bad) {
      const res = await put(input)
      expect(res.status, what).toBe(400)
      expect(typeof res.body.error, what).toBe('string')
    }
    // Nothing from the rejected saves was written.
    const { customProviders } = await models()
    expect(customProviders.map((p) => p.id)).toEqual(['ollama'])
    expect(customProviders[0]?.hasKey).toBe(true)
  })

  it('stores prices and currency, and rejects bad prices', async () => {
    const priced = provider({ currency: '¥', models: [{ id: 'm1', price: { input: 2, output: 8 } }, { id: 'm2' }] })
    expect((await put([priced])).status).toBe(200)
    const { customProviders } = await models()
    expect(customProviders[0]).toMatchObject({ currency: '¥' })
    expect(customProviders[0]?.models[0]).toEqual({ id: 'm1', price: { input: 2, output: 8 } })
    expect(customProviders[0]?.models[1]).toEqual({ id: 'm2' })
    expect((await put([provider({ models: [{ id: 'm1', price: { input: -1, output: 1 } }] })])).status).toBe(400)
    expect((await put([provider({ models: [{ id: 'm1', price: { input: 'x', output: 1 } }] })])).status).toBe(400)
  })

  it('hides disabled models and providers, keeps them in the provider list, and validates the lists', async () => {
    expect((await put([provider({ models: [{ id: 'a' }, { id: 'b' }] })])).status).toBe(200)
    const save = (body: unknown) => call('/api/settings', { method: 'PUT', body: JSON.stringify(body) })
    expect((await save({ disabledModels: ['custom-ollama:b'], extraModels: { deepseek: [{ id: 'extra-1' }] }, modelPrices: { 'deepseek:extra-1': { input: 1, output: 2 } } })).status).toBe(200)
    let state = (await call('/api/models')).body as { models: { id: string }[]; providerList: { id: string; status: string; models: { rawId: string; enabled: boolean; price: unknown }[] }[] }
    expect(state.models.map((m) => m.id)).toContain('custom-ollama:a')
    expect(state.models.map((m) => m.id)).not.toContain('custom-ollama:b')
    const ollama = state.providerList.find((p) => p.id === 'custom-ollama')!
    expect(ollama.models.map((m) => [m.rawId, m.enabled])).toEqual([['a', true], ['b', false]])
    const ds = state.providerList.find((p) => p.id === 'deepseek')!
    expect(ds.models.find((m) => m.rawId === 'extra-1')).toMatchObject({ enabled: true, price: { input: 1, output: 2 } })

    expect((await save({ disabledProviders: ['custom-ollama'] })).status).toBe(200)
    state = (await call('/api/models')).body as typeof state
    expect(state.models.some((m) => m.id.startsWith('custom-ollama:'))).toBe(false)
    expect(state.providerList.find((p) => p.id === 'custom-ollama')).toMatchObject({ status: 'disabled' })

    expect((await save({ extraModels: { nope: [{ id: 'x' }] } })).status).toBe(400)
    expect((await save({ modelPrices: { 'deepseek:x': { input: -1, output: 1 } } })).status).toBe(400)
    expect((await save({ disabledModels: 'x' })).status).toBe(400)
    expect((await save({ disabledProviders: [], disabledModels: [], extraModels: {}, modelPrices: {} })).status).toBe(200)
  })

  it('rejects balance and discovery for unknown providers or bad endpoints', async () => {
    expect((await call('/api/providers/models', { method: 'POST', body: JSON.stringify({ provider: 'nope' }) })).status).toBe(400)
    expect((await call('/api/providers/balance', { method: 'POST', body: JSON.stringify({ baseURL: 'not a url' }) })).status).toBe(400)
    // An endpoint with no known balance API reports it as unsupported rather than failing.
    const res = await call('/api/providers/balance', { method: 'POST', body: JSON.stringify({ baseURL: 'http://127.0.0.1:1/v1' }) })
    expect(res.body).toMatchObject({ supported: false })
  })

  it('discovers models from an OpenAI-compatible endpoint, using the typed key', async () => {
    let auth = ''
    const upstream = createServer((req, res) => {
      auth = String(req.headers.authorization ?? '')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'zeta' }, { id: 'alpha' }] }))
    })
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    const port = (upstream.address() as { port: number }).port
    try {
      const res = await call('/api/providers/models', { method: 'POST', body: JSON.stringify({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'typed-key' }) })
      expect(res.status).toBe(200)
      expect(res.body.models).toEqual([{ id: 'alpha' }, { id: 'zeta' }])
      expect(auth).toBe('Bearer typed-key')
    } finally {
      upstream.close()
    }
  })

  it('accepts loopback and private endpoints', async () => {
    const addresses = ['http://127.0.0.1/v1', 'http://192.168.1.5/v1', 'http://localhost:11434/v1', 'http://[::1]:11434/v1']
    for (const url of addresses) {
      const res = await put([provider({ baseURL: url })])
      expect(res.status, url).toBe(200)
    }
    // Public endpoints are fine too.
    expect((await put([provider({ baseURL: BASE_URL })])).status).toBe(200)
  })

  const providerRow = async (id: string) => {
    const state = (await call('/api/models')).body as { providerList: Record<string, any>[] }
    return state.providerList.find((p) => p.id === id)
  }

  it('keeps the preset of a custom provider and reports its catalog key page', async () => {
    expect((await put([provider({ id: 'kimi', name: 'Kimi', preset: 'moonshot' })])).status).toBe(200)
    expect(await providerRow('custom-kimi')).toMatchObject({ preset: 'moonshot', keyUrl: catalogEntry('moonshot')?.keyUrl })
    expect(catalogEntry('moonshot')?.keyUrl).toBeTruthy()
  })

  it('drops a malformed preset without rejecting the provider', async () => {
    for (const bad of ['Moonshot', 'x'.repeat(33), 'has space', 42]) {
      expect((await put([provider({ id: 'kimi', preset: bad })])).status, String(bad)).toBe(200)
      expect(await providerRow('custom-kimi'), String(bad)).toMatchObject({ preset: null, keyUrl: null })
    }
  })

  it('reports the built-in deepseek row with its catalog preset and key page', async () => {
    const row = await providerRow('deepseek')
    expect(row).toMatchObject({ builtin: true, preset: 'deepseek', keyUrl: catalogEntry('deepseek')?.keyUrl })
    expect(row?.keyUrl).toBeTruthy()
  })

  it('serves the provider catalog, with local runtimes', async () => {
    const res = await call('/api/providers/catalog')
    expect(res.status).toBe(200)
    const catalog = res.body.catalog as { id: string; region: string }[]
    expect(catalog.some((e) => e.id === 'moonshot')).toBe(true)
    expect(catalog.some((e) => e.region === 'local')).toBe(true)
  })
})
