import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import * as yaml from 'js-yaml'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CATALOG, catalogEntry } from './provider-catalog'

/**
 * Model registry. A model is offered only when a key for its provider is
 * available. Keys come from, in order: keys the user saved in the app, the
 * process environment, and the DSH credential store (~/.dsh/.credentials.yaml).
 * Keys never leave this process.
 */
export interface ModelInfo {
  id: string // "<provider>:<model>"
  provider: string
  label: string
  /** Passed the editing eval set. Unverified models may still be used. */
  verified: boolean
  /** False when the user switched the model, or its whole provider, off. */
  enabled: boolean
  caps: Capability[]
}

/** What a model can do. Chosen by the user per model; a model with no choice has DEFAULT_CAPS. */
export type Capability = 'text' | 'vision' | 'image' | 'imageEdit' | 'audio'
export const CAPABILITIES: readonly Capability[] = ['text', 'vision', 'image', 'imageEdit', 'audio']
export const DEFAULT_CAPS: Capability[] = ['text', 'vision']

/** The jobs a model can be chosen for in the settings. `text` is the default chat model. */
export type Role = 'text' | 'vision' | 'image' | 'imageEdit' | 'transcribe' | 'diagram'

/** Validates a list of capabilities: a subset of CAPABILITIES, deduplicated. Throws a generic message. */
export function parseCaps(input: unknown): Capability[] {
  if (!Array.isArray(input) || input.length > CAPABILITIES.length * 2) throw new Error('能力的格式不正确')
  const out: Capability[] = []
  for (const v of input) {
    if (typeof v !== 'string' || !(CAPABILITIES as readonly string[]).includes(v)) throw new Error('能力的格式不正确')
    if (!out.includes(v as Capability)) out.push(v as Capability)
  }
  return out
}

/** Built-in model capabilities, keyed by full model id ("deepseek:deepseek-flash"). Only built-in ids are accepted. */
export function parseModelCaps(input: unknown): Record<string, Capability[]> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('模型能力的格式不正确')
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length > 500) throw new Error('模型能力的格式不正确')
  const out: Record<string, Capability[]> = {}
  for (const [id, caps] of entries) {
    const colon = id.indexOf(':')
    if (id.length > 200 || colon < 1 || !PROVIDERS[id.slice(0, colon)]) throw new Error(`「${id}」不是内置模型，不能设置能力`)
    try {
      out[id] = parseCaps(caps)
    } catch {
      throw new Error(`模型「${id}」的能力不正确`)
    }
  }
  return out
}

/** The capabilities of a model: from its entry for a custom provider, from the user's settings for a built-in one. */
export function capsOf(modelId: string, scope: ModelScope = NO_SCOPE): Capability[] {
  const [provider, ...rest] = modelId.split(':')
  if (provider?.startsWith('custom-')) {
    const p = scope.custom.find((c) => `custom-${c.id}` === provider)
    const m = p?.models.find((x) => x.id === rest.join(':'))
    return m ? [...(m.caps ?? DEFAULT_CAPS)] : []
  }
  return [...(scope.caps?.[modelId] ?? DEFAULT_CAPS)]
}

interface ProviderDef {
  keyName: string
  models: { id: string; label: string; verified?: boolean }[]
  create: (apiKey: string, model: string) => LanguageModel
}

const PROVIDERS: Record<string, ProviderDef> = {
  deepseek: {
    keyName: 'DEEPSEEK_API_KEY',
    models: [
      { id: 'deepseek-flash', label: 'DeepSeek Flash', verified: true },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    ],
    create: (apiKey, m) => createDeepSeek({ apiKey })(m),
  },
  anthropic: {
    keyName: 'ANTHROPIC_API_KEY',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    ],
    create: (apiKey, m) => createAnthropic({ apiKey })(m),
  },
  openai: {
    keyName: 'OPENAI_API_KEY',
    models: [{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' }],
    create: (apiKey, m) => createOpenAI({ apiKey })(m),
  },
  google: {
    keyName: 'GOOGLE_GENERATIVE_AI_API_KEY',
    models: [{ id: 'gemini-3-pro', label: 'Gemini 3 Pro' }],
    create: (apiKey, m) => createGoogleGenerativeAI({ apiKey })(m),
  },
  openrouter: {
    keyName: 'OPENROUTER_API_KEY',
    models: [
      { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5 (OpenRouter)', verified: true },
      { id: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna (OpenRouter)' },
    ],
    create: (apiKey, m) =>
      createOpenAICompatible({ name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey })(m),
  },
}

let dshRefs: Record<string, string> | null = null
function dshKey(name: string): string | undefined {
  if (dshRefs === null) {
    dshRefs = {}
    const file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
    try {
      if (existsSync(file)) {
        const doc = yaml.load(readFileSync(file, 'utf8')) as { refs?: Record<string, unknown> } | null
        for (const [k, v] of Object.entries(doc?.refs ?? {})) if (typeof v === 'string') dshRefs[k] = v
      }
    } catch {
      // An unreadable credential store only means fewer models are offered.
    }
  }
  return dshRefs[name]
}

export type KeyLookup = (keyName: string) => string | null

/** A user-defined OpenAI-compatible endpoint with its own list of models. */
export interface CustomProvider {
  id: string
  name: string
  baseURL: string
  /** Symbol shown beside costs, e.g. "$" or "¥". */
  currency?: string
  /** Catalog id (provider-catalog.ts) this provider was created from. */
  preset?: string
  models: CustomModel[]
}

/** A model of a custom provider. Prices are per million tokens, in the provider's currency. */
export interface CustomModel {
  id: string
  label?: string
  price?: { input: number; output: number }
  /** What the model can do. Absent: DEFAULT_CAPS (text and vision). */
  caps?: Capability[]
}

/** What one user may use: saved keys, and the user's own custom providers. */
export interface ModelScope {
  key: KeyLookup
  custom: CustomProvider[]
  /** Provider ids ("deepseek", "custom-x") the user switched off. */
  disabledProviders?: ReadonlySet<string>
  /** Full model ids ("deepseek:deepseek-flash") the user hid. */
  disabledModels?: ReadonlySet<string>
  /** Models the user added to a built-in provider, for example from its model list API. */
  extra?: Record<string, { id: string; label?: string }[]>
  /** Prices of built-in models, per million tokens. */
  prices?: Record<string, { input: number; output: number }>
  /** Capabilities of built-in models, keyed by full model id. Absent ids have DEFAULT_CAPS. */
  caps?: Record<string, Capability[]>
}

const NO_SCOPE: ModelScope = { key: () => null, custom: [] }

/** Key name of a custom provider; stored as setting `key:custom:<id>`. */
export function customKeyName(providerId: string): string {
  return `custom:${providerId}`
}

const CUSTOM_ID = /^[a-z0-9-]{1,32}$/
const PRESET_ID = /^[a-z0-9-]{1,32}$/
const MAX_CUSTOM_PROVIDERS = 20
const MAX_CUSTOM_MODELS = 50

/** A custom provider as submitted by the client: the key is write-only. */
export type CustomProviderInput = CustomProvider & { apiKey?: string }

/**
 * Literal addresses of this machine and its private network. Link previews refuse to fetch them (SSRF guard).
 * Names are not resolved here.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true
    if (/^f[cd]/.test(h)) return true // fc00::/7
    if (/^fe[89ab]/.test(h)) return true // fe80::/10
    if (h.startsWith('::ffff:')) return true // IPv4-mapped: refused outright
  }
  return false
}

/**
 * Validates a complete custom provider list. Throws an Error whose message is
 * shown to the user.
 */
export function parseCustomProviders(input: unknown): CustomProviderInput[] {
  if (!Array.isArray(input)) throw new Error('自定义提供商的格式不正确')
  if (input.length > MAX_CUSTOM_PROVIDERS) throw new Error(`最多只能添加 ${MAX_CUSTOM_PROVIDERS} 个自定义提供商`)
  const seen = new Set<string>()
  const out: CustomProviderInput[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') throw new Error('自定义提供商的格式不正确')
    const p = raw as Record<string, unknown>
    const id = typeof p.id === 'string' ? p.id : ''
    if (!CUSTOM_ID.test(id)) throw new Error(`提供商 ID「${id}」不合法：只能包含小写字母、数字和连字符，最多 32 个字符`)
    if (seen.has(id)) throw new Error(`提供商 ID「${id}」重复`)
    seen.add(id)
    const name = typeof p.name === 'string' ? p.name.trim() : ''
    if (!name || name.length > 60) throw new Error(`提供商「${id}」的名称不能为空，且不能超过 60 个字符`)
    const rawUrl = typeof p.baseURL === 'string' ? p.baseURL.trim() : ''
    let url: URL | null = null
    try {
      url = new URL(rawUrl)
    } catch {
      url = null
    }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new Error(`提供商「${name}」的端点必须是有效的 http(s) 地址`)
    }
    if (!Array.isArray(p.models) || p.models.length === 0) throw new Error(`提供商「${name}」至少需要一个模型`)
    if (p.models.length > MAX_CUSTOM_MODELS) throw new Error(`提供商「${name}」最多只能有 ${MAX_CUSTOM_MODELS} 个模型`)
    const models: CustomModel[] = []
    for (const m of p.models) {
      const mid = m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string' ? (m as { id: string }).id.trim() : ''
      if (!mid) throw new Error(`提供商「${name}」中有模型 ID 为空`)
      const label = (m as { label?: unknown }).label
      const entry: CustomModel = { id: mid }
      if (typeof label === 'string' && label.trim()) entry.label = label.trim()
      const caps = (m as { caps?: unknown }).caps
      if (caps !== undefined) {
        try {
          entry.caps = parseCaps(caps)
        } catch {
          throw new Error(`提供商「${name}」中模型「${mid}」的能力不正确`)
        }
      }
      const price = (m as { price?: { input?: unknown; output?: unknown } }).price
      if (price && typeof price === 'object') {
        const pin = Number(price.input)
        const pout = Number(price.output)
        if (!Number.isFinite(pin) || !Number.isFinite(pout) || pin < 0 || pout < 0 || pin > 1e6 || pout > 1e6) {
          throw new Error(`提供商「${name}」中模型「${mid}」的价格不正确`)
        }
        if (pin > 0 || pout > 0) entry.price = { input: pin, output: pout }
      }
      models.push(entry)
    }
    if (p.apiKey !== undefined && typeof p.apiKey !== 'string') throw new Error(`提供商「${name}」的密钥格式不正确`)
    const currency = typeof p.currency === 'string' ? p.currency.trim().slice(0, 4) : ''
    // An unrecognised preset is dropped rather than rejecting the whole provider.
    const preset = typeof p.preset === 'string' && PRESET_ID.test(p.preset) ? p.preset : ''
    out.push({
      id,
      name,
      baseURL: url.href.replace(/\/+$/, ''),
      ...(currency ? { currency } : {}),
      ...(preset ? { preset } : {}),
      models,
      ...(typeof p.apiKey === 'string' ? { apiKey: p.apiKey } : {}),
    })
  }
  return out
}

/** The custom providers stored for a user. Unreadable data counts as none. */
export function parseStoredProviders(raw: string | null): CustomProvider[] {
  if (!raw) return []
  try {
    return parseCustomProviders(JSON.parse(raw)).map(({ id, name, baseURL, currency, preset, models }) => ({ id, name, baseURL, ...(currency ? { currency } : {}), ...(preset ? { preset } : {}), models }))
  } catch {
    return []
  }
}

function keyFor(def: ProviderDef, saved: KeyLookup): string | undefined {
  // The DSH store is consulted before the environment: it is the user's maintained source.
  return saved(def.keyName) ?? dshKey(def.keyName) ?? process.env[def.keyName] ?? undefined
}

/** A custom OpenAI-compatible endpoint, configured by environment. */
function customProvider(): ProviderDef | null {
  const base = process.env.AIW_COMPAT_BASE_URL
  const models = process.env.AIW_COMPAT_MODELS
  if (!base || !models) return null
  return {
    keyName: 'AIW_COMPAT_API_KEY',
    models: models.split(',').map((m) => ({ id: m.trim(), label: m.trim() })),
    create: (apiKey, m) => createOpenAICompatible({ name: 'custom', baseURL: base, apiKey })(m),
  }
}

function providers(): Record<string, ProviderDef> {
  const custom = customProvider()
  return custom ? { ...PROVIDERS, custom } : PROVIDERS
}

function builtinModels(provider: string, def: ProviderDef, scope: ModelScope): { id: string; label: string; verified: boolean }[] {
  const out = def.models.map((m) => ({ id: m.id, label: m.label, verified: !!m.verified }))
  for (const m of scope.extra?.[provider] ?? []) {
    if (!out.some((o) => o.id === m.id)) out.push({ id: m.id, label: m.label || m.id, verified: false })
  }
  return out
}

/** Every model of every usable provider; `all` also keeps the ones the user switched off. */
export function listModels(scope: ModelScope = NO_SCOPE, opts: { all?: boolean } = {}): ModelInfo[] {
  const out: ModelInfo[] = []
  const push = (provider: string, m: { id: string; label: string; verified: boolean }): void => {
    const id = `${provider}:${m.id}`
    const enabled = !scope.disabledProviders?.has(provider) && !scope.disabledModels?.has(id)
    if (enabled || opts.all) out.push({ id, provider, label: m.label, verified: m.verified, enabled, caps: capsOf(id, scope) })
  }
  for (const [provider, def] of Object.entries(providers())) {
    if (!keyFor(def, scope.key)) continue
    for (const m of builtinModels(provider, def, scope)) push(provider, m)
  }
  // Custom providers need no key: local servers such as Ollama accept requests without one.
  for (const p of scope.custom) {
    for (const m of p.models) push(`custom-${p.id}`, { id: m.id, label: m.label || m.id, verified: false })
  }
  return out
}

export type KeySource = 'saved' | 'dsh' | 'env' | null

/** Where the key of a built-in provider comes from. The key itself is never returned. */
export function keySource(provider: string, scope: ModelScope): KeySource {
  const def = providers()[provider]
  if (!def) return null
  if (scope.key(def.keyName)) return 'saved'
  if (dshKey(def.keyName)) return 'dsh'
  return process.env[def.keyName] ? 'env' : null
}

export interface ProviderSummary {
  id: string
  name: string
  builtin: boolean
  baseURL: string
  hasKey: boolean
  keySource: KeySource
  keyName: string | null
  enabled: boolean
  /** Ready: usable now. Needs key: a key is missing. Disabled: switched off by the user. */
  status: 'ready' | 'needs-key' | 'disabled'
  currency: string
  /** Catalog id this provider comes from (built-ins: the entry whose `builtin` is this id). */
  preset: string | null
  /** Where the user creates or copies the key, from the catalog entry of `preset`. */
  keyUrl: string | null
  models: { id: string; rawId: string; label: string; enabled: boolean; verified: boolean; added: boolean; price: { input: number; output: number } | null; caps: Capability[] }[]
}

const keyUrlOf = (preset: string | null): string | null => (preset ? catalogEntry(preset)?.keyUrl ?? null : null)

const BUILTIN_NAMES: Record<string, string> = { deepseek: 'DeepSeek', anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', openrouter: 'OpenRouter' }
const BUILTIN_CURRENCY: Record<string, string> = { deepseek: '¥' }

/** What the provider management page shows: built-in and custom providers alike, usable or not. */
export function describeProviders(scope: ModelScope): ProviderSummary[] {
  const out: ProviderSummary[] = []
  for (const [provider, def] of Object.entries(providers())) {
    const source = keySource(provider, scope)
    const enabled = !scope.disabledProviders?.has(provider)
    const extraIds = new Set((scope.extra?.[provider] ?? []).map((m) => m.id))
    const preset = CATALOG.find((e) => e.builtin === provider)?.id ?? null
    out.push({
      id: provider,
      name: BUILTIN_NAMES[provider] ?? provider,
      builtin: true,
      baseURL: BUILTIN_ENDPOINTS[provider]?.baseURL ?? '',
      hasKey: source !== null,
      keySource: source,
      keyName: def.keyName,
      enabled,
      status: !enabled ? 'disabled' : source ? 'ready' : 'needs-key',
      currency: BUILTIN_CURRENCY[provider] ?? '$',
      preset,
      keyUrl: keyUrlOf(preset),
      models: builtinModels(provider, def, scope).map((m) => ({
        id: `${provider}:${m.id}`,
        rawId: m.id,
        label: m.label,
        enabled: !scope.disabledModels?.has(`${provider}:${m.id}`),
        verified: m.verified,
        added: extraIds.has(m.id),
        price: scope.prices?.[`${provider}:${m.id}`] ?? null,
        caps: capsOf(`${provider}:${m.id}`, scope),
      })),
    })
  }
  for (const p of scope.custom) {
    const provider = `custom-${p.id}`
    const enabled = !scope.disabledProviders?.has(provider)
    out.push({
      id: provider,
      name: p.name,
      builtin: false,
      baseURL: p.baseURL,
      hasKey: !!scope.key(customKeyName(p.id)),
      keySource: scope.key(customKeyName(p.id)) ? 'saved' : null,
      keyName: null,
      enabled,
      status: enabled ? 'ready' : 'disabled',
      currency: p.currency || '$',
      preset: p.preset ?? null,
      keyUrl: keyUrlOf(p.preset ?? null),
      models: p.models.map((m) => ({
        id: `${provider}:${m.id}`,
        rawId: m.id,
        label: m.label || m.id,
        enabled: !scope.disabledModels?.has(`${provider}:${m.id}`),
        verified: false,
        added: false,
        price: m.price ?? null,
        caps: capsOf(`${provider}:${m.id}`, scope),
      })),
    })
  }
  return out
}

export function providerKeyNames(): { provider: string; keyName: string }[] {
  return Object.entries(providers()).map(([provider, d]) => ({ provider, keyName: d.keyName }))
}

export function resolveModel(id: string, scope: ModelScope = NO_SCOPE): LanguageModel {
  const [provider, ...rest] = id.split(':')
  if (scope.disabledProviders?.has(provider ?? '') || scope.disabledModels?.has(id)) throw new Error(`model ${id} is switched off`)
  if (provider?.startsWith('custom-')) {
    const p = scope.custom.find((c) => `custom-${c.id}` === provider)
    if (!p) throw new Error(`model ${id} is not available`)
    const apiKey = scope.key(customKeyName(p.id)) ?? ''
    return createOpenAICompatible({ name: provider, baseURL: p.baseURL, apiKey })(rest.join(':'))
  }
  const def = providers()[provider ?? '']
  const key = def && keyFor(def, scope.key)
  if (!def || !key) throw new Error(`model ${id} is not available`)
  return def.create(key, rest.join(':'))
}

/** The key in effect for a built-in provider (saved, DSH store or environment). */
export function builtinKey(provider: string, scope: ModelScope): string | undefined {
  const def = PROVIDERS[provider]
  return def ? keyFor(def, scope.key) : undefined
}

/**
 * A model that accepts images, for alt text and OCR: a built-in Anthropic, OpenAI or Google model, or an
 * OpenRouter model of a vision-capable family. Undefined when none is usable.
 */
export function visionModelFor(scope: ModelScope = NO_SCOPE): string | undefined {
  return listModels(scope).find((m) => isVisionModelId(m.id))?.id
}

/** Whether a model id names a model family that takes images. */
export function isVisionModelId(id: string): boolean {
  return /^(anthropic|openai|google):/.test(id) || /^openrouter:(anthropic\/|openai\/gpt-4|openai\/gpt-5|google\/gemini)/.test(id)
}

/** The saved or typed key of a custom provider, if any. */
export const customKey = (providerId: string, scope: ModelScope): string | undefined => scope.key(customKeyName(providerId)) ?? undefined

/** Endpoint and auth style of the built-in providers, for model discovery and balance. */
export const BUILTIN_ENDPOINTS: Record<string, { baseURL: string; auth: 'bearer' | 'anthropic' | 'google' }> = {
  deepseek: { baseURL: 'https://api.deepseek.com', auth: 'bearer' },
  openai: { baseURL: 'https://api.openai.com/v1', auth: 'bearer' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', auth: 'bearer' },
  anthropic: { baseURL: 'https://api.anthropic.com/v1', auth: 'anthropic' },
  google: { baseURL: 'https://generativelanguage.googleapis.com/v1beta', auth: 'google' },
}

/** Price of one model id ("custom-x:model"), if the user set one. */
export function modelPrice(id: string, scope: ModelScope): { input: number; output: number; currency: string } | null {
  const [provider, ...rest] = id.split(':')
  if (!provider?.startsWith('custom-')) {
    const price = scope.prices?.[id]
    return price ? { ...price, currency: BUILTIN_CURRENCY[provider ?? ''] ?? '$' } : null
  }
  const p = scope.custom.find((c) => `custom-${c.id}` === provider)
  const price = p?.models.find((m) => m.id === rest.join(':'))?.price
  return p && price ? { ...price, currency: p.currency || '$' } : null
}

/** A list of ids as submitted by the client (disabled providers or models). Throws a message for the user. */
export function parseIdList(input: unknown, what: string): string[] {
  if (!Array.isArray(input) || input.length > 2000) throw new Error(`${what}的格式不正确`)
  const out: string[] = []
  for (const v of input) {
    if (typeof v !== 'string' || !v || v.length > 200) throw new Error(`${what}的格式不正确`)
    out.push(v)
  }
  return [...new Set(out)]
}

/** Models added to built-in providers. Only built-in provider names are accepted. */
export function parseExtraModels(input: unknown): Record<string, { id: string; label?: string }[]> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('额外模型的格式不正确')
  const out: Record<string, { id: string; label?: string }[]> = {}
  for (const [provider, list] of Object.entries(input as Record<string, unknown>)) {
    if (!PROVIDERS[provider]) throw new Error(`未知的提供商「${provider}」`)
    if (!Array.isArray(list) || list.length > 300) throw new Error('额外模型的格式不正确')
    const models: { id: string; label?: string }[] = []
    for (const m of list) {
      const id = m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string' ? (m as { id: string }).id.trim() : ''
      if (!id || id.length > 200) throw new Error('额外模型的格式不正确')
      const label = (m as { label?: unknown }).label
      models.push(typeof label === 'string' && label.trim() ? { id, label: label.trim().slice(0, 100) } : { id })
    }
    if (models.length) out[provider] = models
  }
  return out
}

/** Prices of built-in models, keyed by full model id. */
export function parsePrices(input: unknown): Record<string, { input: number; output: number }> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('价格的格式不正确')
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length > 2000) throw new Error('价格的格式不正确')
  const out: Record<string, { input: number; output: number }> = {}
  for (const [id, v] of entries) {
    const p = v as { input?: unknown; output?: unknown } | null
    const pin = Number(p?.input)
    const pout = Number(p?.output)
    if (!Number.isFinite(pin) || !Number.isFinite(pout) || pin < 0 || pout < 0 || pin > 1e6 || pout > 1e6) throw new Error(`模型「${id}」的价格不正确`)
    if (pin > 0 || pout > 0) out[id] = { input: pin, output: pout }
  }
  return out
}

/** Reads a stored JSON setting; anything unreadable counts as the fallback. */
export function parseStored<T>(raw: string | null, fallback: T, check: (v: unknown) => T): T {
  if (!raw) return fallback
  try {
    return check(JSON.parse(raw))
  } catch {
    return fallback
  }
}
