import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import { Readable } from 'node:stream'
import { isIP } from 'node:net'
import { parseHTML } from 'linkedom'
import { sniffImage } from './images'
import { isPrivateHost } from './models'

/**
 * Link previews: the title, description and picture of a web page, for link cards.
 * The server fetches the page itself, so every address it contacts is checked first:
 * loopback, private, link-local and similar ranges are refused, on every redirect hop.
 */

/** A failure the user sees. The route answers 422 with the message. */
export class UnfurlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnfurlError'
  }
}

export interface UnfurlDeps {
  fetch: typeof fetch
  lookup: (host: string) => Promise<{ address: string; family: number }[]>
  /** Stores a checked picture and returns its `/files/<id>` url, or '' when it is refused. */
  storeImage: (bytes: Uint8Array, mime: string) => Promise<string>
}

export interface LinkPreview {
  url: string
  title: string
  description: string
  /** `/files/<id>` of the stored picture, or '' when the page has none that could be stored. */
  image: string
  site: string
}

const MAX_PAGE_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const TIMEOUT_MS = 8000
const MAX_REDIRECTS = 3
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])
const USER_AGENT = 'Mozilla/5.0 (compatible; StetpadLinkPreview/1.0)'

/** Literal addresses that are not public: the private ranges plus carrier-grade NAT, multicast and broadcast. */
function blockedAddress(address: string): boolean {
  if (isPrivateHost(address)) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  return /^ff/i.test(address) // IPv6 multicast
}

/**
 * fetch for production: the address check runs inside the socket's DNS lookup, so the address that is checked is
 * the one connected to. (Checking first and letting fetch resolve again would let a DNS server answer "public",
 * then "internal": a rebinding attack.) Redirects are never followed here; `fetchChecked` handles them.
 */
export const pinnedFetch = (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  const lookup = (host: string, _opts: unknown, cb: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void): void => {
    dnsLookup(host, { all: true }).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some((a) => blockedAddress(a.address))) cb(new UnfurlError('不允许访问本机或内网地址'), [])
        else cb(null, addresses)
      },
      (err: Error) => cb(err, []),
    )
  }
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((v, k) => (headers[k] = v))
  return new Promise<Response>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: init.method ?? 'GET', headers, lookup: lookup as never, signal: init.signal ?? undefined }, (res) => {
      const out = new Headers()
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(', ') : String(v))
      const status = res.statusCode ?? 502
      const body = status === 204 || status === 304 || (init.method ?? 'GET') === 'HEAD' ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>)
      resolve(new Response(body, { status, headers: out }))
    })
    req.on('error', reject)
    req.end()
  })
}) as typeof fetch

/** Parses an http(s) URL and checks that its host resolves only to public addresses. */
async function checkedUrl(raw: string, lookup: UnfurlDeps['lookup']): Promise<URL> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new UnfurlError('请输入有效的网址')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnfurlError('只支持 http 或 https 链接')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host || isPrivateHost(host) || (isIP(host) && blockedAddress(host))) throw new UnfurlError('不允许访问本机或内网地址')
  if (!isIP(host)) {
    let addresses: { address: string }[]
    try {
      addresses = await lookup(host)
    } catch {
      throw new UnfurlError('无法解析这个网址的域名')
    }
    if (addresses.length === 0) throw new UnfurlError('无法解析这个网址的域名')
    if (addresses.some((a) => blockedAddress(a.address))) throw new UnfurlError('不允许访问本机或内网地址')
  }
  return u
}

/**
 * GET with manual redirects: each hop is checked again, at most MAX_REDIRECTS are followed.
 * Returns the final response and the URL it came from (for resolving relative picture links).
 */
async function fetchChecked(start: string, deps: UnfurlDeps, accept: string): Promise<{ res: Response; final: string }> {
  let current = start
  for (let hop = 0; ; hop++) {
    const u = await checkedUrl(current, deps.lookup)
    let res: Response
    try {
      res = await deps.fetch(u.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept, 'user-agent': USER_AGENT },
      })
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      throw new UnfurlError(timedOut ? '打开网址超时' : '无法打开这个网址')
    }
    if (REDIRECT_CODES.has(res.status)) {
      const location = res.headers.get('location')
      await res.body?.cancel().catch(() => undefined)
      if (!location) throw new UnfurlError('网页返回了无效的跳转')
      if (hop >= MAX_REDIRECTS) throw new UnfurlError('跳转次数过多')
      current = new URL(location, u).href
      continue
    }
    return { res, final: u.href }
  }
}

/** The body, read at most `max` bytes. Over the limit is an error; the stream is cancelled. */
async function readBody(res: Response, max: number, tooLarge: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined)
    throw new UnfurlError(tooLarge)
  }
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>
    try {
      step = await reader.read()
    } catch {
      throw new UnfurlError('打开网址超时')
    }
    if (step.done) break
    total += step.value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw new UnfurlError(tooLarge)
    }
    chunks.push(step.value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** Downloads a picture under the same rules and stores it. '' for anything that does not work out. */
async function fetchImage(url: string, deps: UnfurlDeps): Promise<string> {
  try {
    const { res } = await fetchChecked(url, deps, 'image/png,image/jpeg,image/gif,image/webp;q=0.9,*/*;q=0.1')
    if (!res.ok) return ''
    const bytes = await readBody(res, MAX_IMAGE_BYTES, '图片超过 5MB')
    const mime = sniffImage(bytes)
    return mime ? await deps.storeImage(bytes, mime) : ''
  } catch {
    return ''
  }
}

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])

/** The preview of one page. Throws UnfurlError with a message for the user. */
export async function unfurl(raw: string, deps: UnfurlDeps): Promise<LinkPreview> {
  const { res, final } = await fetchChecked(raw, deps, 'text/html,application/xhtml+xml;q=0.9')
  if (!res.ok) throw new UnfurlError(`网页返回 ${res.status}`)
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type && !HTML_TYPES.has(type)) throw new UnfurlError('这个链接不是网页')
  const html = new TextDecoder('utf-8').decode(await readBody(res, MAX_PAGE_BYTES, '网页超过 2MB'))

  const { document } = parseHTML(html)
  const meta = (name: string): string => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute('content')?.trim() ?? ''
  const pageTitle = document.querySelector('title')?.textContent?.trim() ?? ''
  const host = new URL(final).hostname.replace(/^www\./, '')
  const title = (meta('og:title') || meta('twitter:title') || pageTitle || host).slice(0, 300)
  const description = (meta('og:description') || meta('description') || meta('twitter:description')).slice(0, 500)
  const site = (meta('og:site_name') || host).slice(0, 100)

  let image = ''
  const pictureLink = meta('og:image') || meta('twitter:image')
  if (pictureLink) {
    let absolute: string | null = null
    try {
      absolute = new URL(pictureLink, final).href
    } catch {
      absolute = null
    }
    if (absolute) image = await fetchImage(absolute, deps)
  }
  return { url: new URL(raw).href, title, description, image, site }
}
