import { generateImage } from 'ai'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { BUILTIN_ENDPOINTS, builtinKey, capsOf, customKey, type ModelScope } from './models'

/**
 * AI image generation. Model ids are "<provider>:<model>", like chat models. A model is offered only when
 * the key of its provider is available, the same rule as models.ts.
 */

export interface ImageModelInfo {
  id: string
  label: string
  /** Price per image as shown to the user, e.g. "$0.04/张" or "免费". Only when the provider publishes it. */
  price?: string
}

export const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const
export type ImageSize = (typeof IMAGE_SIZES)[number]

/** File extension of each stored image type. */
export const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const FETCH_TIMEOUT_MS = 60_000
const OPENROUTER_CACHE_MS = 10 * 60_000

const OPENAI_MODELS: ImageModelInfo[] = [
  { id: 'gpt-image-1', label: 'GPT Image 1' },
  { id: 'dall-e-3', label: 'DALL·E 3' },
]
const GOOGLE_MODELS: ImageModelInfo[] = [{ id: 'imagen-4.0-generate-001', label: 'Imagen 4' }]

const DALLE3_SIZE: Record<ImageSize, string> = { '1024x1024': '1024x1024', '1536x1024': '1792x1024', '1024x1536': '1024x1792' }
/** Imagen has no 3:2 or 2:3: it draws 4:3 / 3:4 and the result is centre-cropped (`cropTo`). */
const GOOGLE_ASPECT: Record<ImageSize, { ratio: string; cropTo?: number }> = {
  '1024x1024': { ratio: '1:1' },
  '1536x1024': { ratio: '4:3', cropTo: 3 / 2 },
  '1024x1536': { ratio: '3:4', cropTo: 2 / 3 },
}

/** Centre-crops an image to `ratio` (width / height), as PNG. The input unchanged when it cannot be decoded. */
export async function cropToRatio(data: Uint8Array, ratio: number): Promise<Uint8Array> {
  try {
    const img = await loadImage(Buffer.from(data))
    let w = img.width
    let h = img.height
    if (w / h > ratio) w = Math.round(h * ratio)
    else h = Math.round(w / ratio)
    if (w === img.width && h === img.height) return data
    const canvas = createCanvas(w, h)
    canvas.getContext('2d').drawImage(img, (img.width - w) / 2, (img.height - h) / 2, w, h, 0, 0, w, h)
    return new Uint8Array(canvas.toBuffer('image/png'))
  } catch {
    return data
  }
}
const ASPECT: Record<ImageSize, string> = { '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3' }

interface OpenRouterModel {
  id: string
  name: string
  outputs: string[]
  inputs: string[]
  price?: string
}

/**
 * The price label of an OpenRouter model from its `pricing` object: the per-image price when it is above zero,
 * "免费" when every published price is zero, and undefined when nothing usable is published.
 */
export function priceLabel(id: string, pricing: unknown): string | undefined {
  if (!pricing || typeof pricing !== 'object') return undefined
  const p = pricing as Record<string, unknown>
  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
    return Number.isFinite(n) ? n : null
  }
  const image = num(p.image)
  if (image !== null && image > 0) {
    const shown = image >= 0.0001 ? image.toFixed(4).replace(/\.?0+$/, '') : '<0.0001'
    return `$${shown}/张`
  }
  const known = ['prompt', 'completion', 'image', 'request'].map((k) => num(p[k])).filter((v): v is number => v !== null)
  if (id.endsWith(':free') || (known.length > 0 && known.every((v) => v === 0))) return '免费'
  return undefined
}

/**
 * The image model to use when the user has not chosen one: the first available of the preferred models, in this
 * order, else the first model in the list. Null when there are none.
 */
export function recommendedImageModel(models: ImageModelInfo[]): string | null {
  for (const id of ['openai:gpt-image-1', 'google:imagen-4.0-generate-001']) {
    if (models.some((m) => m.id === id)) return id
  }
  for (const re of [/gemini.*image|nano-banana/i, /gpt-image/i, /flux/i, /seedream/i]) {
    const hit = models.find((m) => m.id.startsWith('openrouter:') && re.test(m.id.slice('openrouter:'.length)))
    if (hit) return hit.id
  }
  return models[0]?.id ?? null
}

/** OpenAI models that edit a picture (image in, image out). DALL·E 3 cannot. */
const OPENAI_EDIT_MODELS: ImageModelInfo[] = [{ id: 'gpt-image-1', label: 'GPT Image 1' }]

let openrouterCache: { at: number; models: OpenRouterModel[] } | null = null

/** Drops the cached OpenRouter model list (tests). */
export function clearImageModelCache(): void {
  openrouterCache = null
}

/** The public OpenRouter list of image-output models, cached for ten minutes. Failures return [] and are not cached. */
async function openrouterModels(fetchFn: typeof fetch): Promise<OpenRouterModel[]> {
  if (openrouterCache && Date.now() - openrouterCache.at < OPENROUTER_CACHE_MS) return openrouterCache.models
  try {
    const res = await fetchFn(`${BUILTIN_ENDPOINTS.openrouter!.baseURL}/models?output_modalities=image`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const json = (await res.json()) as { data?: unknown }
    if (!Array.isArray(json.data)) return []
    const models: OpenRouterModel[] = []
    for (const raw of json.data) {
      const m = raw as { id?: unknown; name?: unknown; pricing?: unknown; architecture?: { output_modalities?: unknown } }
      if (typeof m.id !== 'string' || !m.id) continue
      const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
      const outputs = strings(m.architecture?.output_modalities)
      const inputs = strings((m.architecture as { input_modalities?: unknown } | undefined)?.input_modalities)
      const price = priceLabel(m.id, m.pricing)
      models.push({ id: m.id, name: typeof m.name === 'string' && m.name ? m.name : m.id, outputs, inputs, ...(price ? { price } : {}) })
    }
    openrouterCache = { at: Date.now(), models }
    return models
  } catch {
    return []
  }
}

/** Image models the user can use now, in order: OpenAI, Google, OpenRouter. */
export async function listImageModels(scope: ModelScope, fetchFn: typeof fetch = fetch): Promise<ImageModelInfo[]> {
  const enabled = (provider: string, id: string): boolean => !scope.disabledProviders?.has(provider) && !scope.disabledModels?.has(id)
  const out: ImageModelInfo[] = []
  if (builtinKey('openai', scope)) {
    for (const m of OPENAI_MODELS) if (enabled('openai', `openai:${m.id}`)) out.push({ id: `openai:${m.id}`, label: m.label })
  }
  if (builtinKey('google', scope)) {
    for (const m of GOOGLE_MODELS) if (enabled('google', `google:${m.id}`)) out.push({ id: `google:${m.id}`, label: m.label })
  }
  if (builtinKey('openrouter', scope)) {
    for (const m of await openrouterModels(fetchFn)) {
      if (enabled('openrouter', `openrouter:${m.id}`)) out.push({ id: `openrouter:${m.id}`, label: m.name, ...(m.price ? { price: m.price } : {}) })
    }
  }
  return out
}

/** Image models that can edit a given picture: OpenAI's edit model, and OpenRouter models that take image input. */
export async function listImageEditModels(scope: ModelScope, fetchFn: typeof fetch = fetch): Promise<ImageModelInfo[]> {
  const enabled = (provider: string, id: string): boolean => !scope.disabledProviders?.has(provider) && !scope.disabledModels?.has(id)
  const out: ImageModelInfo[] = []
  if (builtinKey('openai', scope)) {
    for (const m of OPENAI_EDIT_MODELS) if (enabled('openai', `openai:${m.id}`)) out.push({ id: `openai:${m.id}`, label: m.label })
  }
  if (builtinKey('openrouter', scope)) {
    for (const m of await openrouterModels(fetchFn)) {
      if (m.inputs.includes('image') && enabled('openrouter', `openrouter:${m.id}`)) out.push({ id: `openrouter:${m.id}`, label: m.name })
    }
  }
  return out
}

/** The image type named by the magic bytes, or null. Headers and the provider's claim are not trusted. */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp'
  }
  return null
}

function checkImage(data: Uint8Array): { data: Uint8Array; mime: string } {
  if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) throw new Error('生成的图片大小不合法')
  const mime = sniffImage(data)
  if (!mime) throw new Error('模型返回的内容不是支持的图片格式')
  return { data, mime }
}

function splitModelId(modelId: string): { provider: string; model: string } {
  const i = modelId.indexOf(':')
  return i < 0 ? { provider: modelId, model: '' } : { provider: modelId.slice(0, i), model: modelId.slice(i + 1) }
}

async function readLimited(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > max) throw new Error('图片超过 20 MB')
  const reader = res.body?.getReader()
  if (!reader) {
    const b = new Uint8Array(await res.arrayBuffer())
    if (b.byteLength > max) throw new Error('图片超过 20 MB')
    return b
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      throw new Error('图片超过 20 MB')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** Bytes of an image URL returned by a provider: a base64 data URL, or an https URL (max 20 MB). */
async function imageFromUrl(url: string, fetchFn: typeof fetch, signal: AbortSignal): Promise<Uint8Array> {
  if (url.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 100) throw new Error('图片超过 20 MB')
  const data = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(url)
  if (data) return new Uint8Array(Buffer.from(data[1]!, 'base64'))
  if (/^https:\/\//i.test(url)) {
    const res = await fetchFn(url, { signal })
    if (!res.ok) throw new Error(`下载生成的图片失败（${res.status}）`)
    return readLimited(res, MAX_IMAGE_BYTES)
  }
  throw new Error('模型返回的图片地址不支持')
}

async function errorDetail(res: Response): Promise<string> {
  const text = (await res.text().catch(() => '')).trim().slice(0, 300)
  return text ? `：${text}` : ''
}

interface Generated {
  data: Uint8Array
  mime?: string
  usage?: { inputTokens: number; outputTokens: number }
}

async function generateOpenAI(model: string, prompt: string, size: ImageSize | undefined, scope: ModelScope, signal: AbortSignal, fetchFn: typeof fetch): Promise<Generated> {
  const key = builtinKey('openai', scope)
  if (!key) throw new Error('没有可用的 OpenAI 密钥')
  if (!OPENAI_MODELS.some((m) => m.id === model) && !capsOf(`openai:${model}`, scope).includes('image')) throw new Error('不支持的图片模型')
  const s = size && (model === 'dall-e-3' ? DALLE3_SIZE[size] : size)
  const r = await generateImage({
    model: createOpenAI({ apiKey: key, fetch: fetchFn }).image(model),
    prompt,
    size: s ? (s as `${number}x${number}`) : undefined,
    abortSignal: signal,
  })
  return { data: r.image.uint8Array, usage: { inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0 } }
}

async function generateGoogle(model: string, prompt: string, size: ImageSize | undefined, scope: ModelScope, signal: AbortSignal, fetchFn: typeof fetch): Promise<Generated> {
  const key = builtinKey('google', scope)
  if (!key) throw new Error('没有可用的 Google 密钥')
  if (!GOOGLE_MODELS.some((m) => m.id === model) && !capsOf(`google:${model}`, scope).includes('image')) throw new Error('不支持的图片模型')
  const r = await generateImage({
    model: createGoogleGenerativeAI({ apiKey: key, fetch: fetchFn }).image(model),
    prompt,
    aspectRatio: size ? (GOOGLE_ASPECT[size].ratio as `${number}:${number}`) : undefined,
    abortSignal: signal,
  })
  const crop = size ? GOOGLE_ASPECT[size].cropTo : undefined
  const data = crop ? await cropToRatio(r.image.uint8Array, crop) : r.image.uint8Array
  return { data, usage: { inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0 } }
}

type OpenRouterPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/** One chat completion asking for an image; returns the image the reply carries. */
async function openrouterImage(model: string, content: string | OpenRouterPart[], key: string, outputs: string[], signal: AbortSignal, fetchFn: typeof fetch): Promise<Generated> {
  const res = await fetchFn(`${BUILTIN_ENDPOINTS.openrouter!.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      modalities: outputs.includes('text') ? ['image', 'text'] : ['image'],
    }),
    signal,
  })
  if (!res.ok) throw new Error(`OpenRouter 返回 ${res.status}${await errorDetail(res)}`)
  const json = (await res.json()) as {
    choices?: { message?: { images?: { image_url?: { url?: unknown } }[] } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url
  if (typeof url !== 'string' || !url) throw new Error('模型没有返回图片')
  const data = await imageFromUrl(url, fetchFn, signal)
  const usage = json.usage
  return {
    data,
    usage: usage ? { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } : undefined,
  }
}

async function generateOpenRouter(model: string, prompt: string, size: ImageSize | undefined, scope: ModelScope, signal: AbortSignal, fetchFn: typeof fetch): Promise<Generated> {
  const key = builtinKey('openrouter', scope)
  if (!key) throw new Error('没有可用的 OpenRouter 密钥')
  const info = (await openrouterModels(fetchFn)).find((m) => m.id === model)
  const outputs = info && info.outputs.length ? info.outputs : ['image', 'text']
  const hint = size ? ` (aspect ratio ${ASPECT[size]})` : ''
  return openrouterImage(model, prompt + hint, key, outputs, signal, fetchFn)
}

async function editOpenAI(model: string, image: InputImage, prompt: string, scope: ModelScope, signal: AbortSignal, fetchFn: typeof fetch): Promise<Generated> {
  const key = builtinKey('openai', scope)
  if (!key) throw new Error('没有可用的 OpenAI 密钥')
  if (!OPENAI_EDIT_MODELS.some((m) => m.id === model) && !capsOf(`openai:${model}`, scope).includes('imageEdit')) throw new Error('不支持的图片模型')
  const r = await generateImage({
    model: createOpenAI({ apiKey: key, fetch: fetchFn }).image(model),
    prompt: { images: [image.data], text: prompt },
    abortSignal: signal,
  })
  return { data: r.image.uint8Array, usage: { inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0 } }
}

async function editOpenRouter(model: string, image: InputImage, prompt: string, scope: ModelScope, signal: AbortSignal, fetchFn: typeof fetch): Promise<Generated> {
  const key = builtinKey('openrouter', scope)
  if (!key) throw new Error('没有可用的 OpenRouter 密钥')
  const info = (await openrouterModels(fetchFn)).find((m) => m.id === model)
  if (!info || !info.inputs.includes('image')) throw new Error('不支持的图片模型')
  const outputs = info.outputs.length ? info.outputs : ['image', 'text']
  const url = `data:${image.mime};base64,${Buffer.from(image.data).toString('base64')}`
  return openrouterImage(model, [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url } }], key, outputs, signal, fetchFn)
}

/** A picture to edit: its bytes and the type they were stored with. */
export interface InputImage {
  data: Uint8Array
  mime: string
}

/** The custom provider of a "custom-<id>:<model>" id, with the model's own id and the key in effect. */
function customTarget(modelId: string, scope: ModelScope): { name: string; baseURL: string; apiKey: string; model: string } {
  const i = modelId.indexOf(':')
  const provider = modelId.slice(0, i)
  const p = scope.custom.find((c) => `custom-${c.id}` === provider)
  if (i < 0 || !p) throw new Error('不支持的图片模型')
  return { name: provider, baseURL: p.baseURL, apiKey: customKey(p.id, scope) ?? '', model: modelId.slice(i + 1) }
}

/** An image from a custom OpenAI-compatible endpoint, through the AI SDK's image model. */
async function generateCustom(modelId: string, prompt: string, size: ImageSize | undefined, scope: ModelScope, signal: AbortSignal, fetchFn: typeof fetch): Promise<Generated> {
  const t = customTarget(modelId, scope)
  if (!capsOf(modelId, scope).includes('image')) throw new Error('不支持的图片模型')
  const r = await generateImage({
    model: createOpenAICompatible({ name: t.name, baseURL: t.baseURL, apiKey: t.apiKey, fetch: fetchFn }).imageModel(t.model),
    prompt,
    size: size ? (size as `${number}x${number}`) : undefined,
    abortSignal: signal,
  })
  return { data: r.image.uint8Array }
}

/** An edited image from a custom endpoint: OpenAI's POST /images/edits, as multipart form data. */
async function editCustom(modelId: string, image: InputImage, prompt: string, scope: ModelScope, signal: AbortSignal, fetchFn: typeof fetch): Promise<Generated> {
  const t = customTarget(modelId, scope)
  if (!capsOf(modelId, scope).includes('imageEdit')) throw new Error('不支持的图片模型')
  const form = new FormData()
  form.append('model', t.model)
  form.append('prompt', prompt)
  form.append('image', new Blob([image.data as BlobPart], { type: image.mime }), `image.${IMAGE_EXT[image.mime] ?? 'png'}`)
  const res = await fetchFn(`${t.baseURL}/images/edits`, {
    method: 'POST',
    headers: t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {},
    body: form,
    signal,
  })
  if (!res.ok) throw new Error(`${t.name} 返回 ${res.status}${await errorDetail(res)}`)
  const json = (await res.json()) as { data?: { b64_json?: unknown; url?: unknown }[] }
  const item = json.data?.[0]
  if (typeof item?.b64_json === 'string') return { data: new Uint8Array(Buffer.from(item.b64_json, 'base64')) }
  if (typeof item?.url === 'string') return { data: await imageFromUrl(item.url, fetchFn, signal) }
  throw new Error('模型没有返回图片')
}

/**
 * Returns an edited copy of `image` made by the given model, as validated bytes. The same rules as
 * generateImageBytes apply to the result. Throws an Error whose message is shown to the user.
 */
export async function editImageBytes(
  modelId: string,
  image: InputImage,
  prompt: string,
  opts: { scope: ModelScope; signal?: AbortSignal; fetchFn?: typeof fetch },
): Promise<{ data: Uint8Array; mime: string; usage?: { inputTokens: number; outputTokens: number } }> {
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mime)) throw new Error('这种图片格式不能用于 AI 改图')
  const fetchFn = opts.fetchFn ?? fetch
  const signal = opts.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const { provider, model } = splitModelId(modelId)
  let out: Generated
  if (provider.startsWith('custom-')) out = await editCustom(modelId, image, prompt, opts.scope, signal, fetchFn)
  else if (provider === 'openai') out = await editOpenAI(model, image, prompt, opts.scope, signal, fetchFn)
  else if (provider === 'openrouter') out = await editOpenRouter(model, image, prompt, opts.scope, signal, fetchFn)
  else throw new Error('不支持的图片模型')
  const checked = checkImage(out.data)
  return { ...checked, ...(out.usage ? { usage: out.usage } : {}) }
}

/**
 * Generates one image with the given model and returns the validated bytes. Throws an Error whose message
 * is shown to the user. Never returns an image whose type is not png, jpeg, webp or gif.
 */
export async function generateImageBytes(
  modelId: string,
  prompt: string,
  opts: { size?: string; scope: ModelScope; signal?: AbortSignal; fetchFn?: typeof fetch },
): Promise<{ data: Uint8Array; mime: string; usage?: { inputTokens: number; outputTokens: number } }> {
  if (opts.size !== undefined && !(IMAGE_SIZES as readonly string[]).includes(opts.size)) throw new Error('不支持的图片尺寸')
  const size = opts.size as ImageSize | undefined
  const fetchFn = opts.fetchFn ?? fetch
  const signal = opts.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const { provider, model } = splitModelId(modelId)
  let out: Generated
  if (provider.startsWith('custom-')) out = await generateCustom(modelId, prompt, size, opts.scope, signal, fetchFn)
  else if (provider === 'openai') out = await generateOpenAI(model, prompt, size, opts.scope, signal, fetchFn)
  else if (provider === 'google') out = await generateGoogle(model, prompt, size, opts.scope, signal, fetchFn)
  else if (provider === 'openrouter') out = await generateOpenRouter(model, prompt, size, opts.scope, signal, fetchFn)
  else throw new Error('不支持的图片模型')
  const checked = checkImage(out.data)
  return { ...checked, ...(out.usage ? { usage: out.usage } : {}) }
}
