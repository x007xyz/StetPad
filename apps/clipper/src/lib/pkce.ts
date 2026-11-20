export function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(input: string): Uint8Array {
  const norm = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4))
  const bin = atob(norm + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function sha256Base64Url(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return toBase64Url(new Uint8Array(digest))
}

export async function generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const verifier = toBase64Url(bytes)
  const challenge = await sha256Base64Url(verifier)
  return { verifier, challenge }
}

export function randomHex(byteCount = 16): string {
  const bytes = new Uint8Array(byteCount)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface ParsedConnectionCode {
  url: string
  token: string
  mode: 'local'
}

export function parseConnectionCode(raw: string): ParsedConnectionCode | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('stetpad1:')) return null
  try {
    const json = new TextDecoder().decode(fromBase64Url(trimmed.slice('stetpad1:'.length)))
    const data = JSON.parse(json) as Record<string, unknown>
    const rawUrl = typeof data.url === 'string' ? data.url.trim().replace(/\/+$/, '') : ''
    const token = typeof data.token === 'string' ? data.token.trim() : ''
    if (data.mode !== 'local' || !token.startsWith('clp_')) return null
    const u = new URL(rawUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return { url: u.origin, token, mode: 'local' }
  } catch {
    return null
  }
}

export function detectBrowserName(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  if (/Edg\//i.test(ua)) return 'Edge 浏览器'
  if (/Firefox\//i.test(ua)) return 'Firefox 浏览器'
  if (/Safari\//i.test(ua) && !/Chrome|Chromium|CriOS/i.test(ua)) return 'Safari 浏览器'
  if (/Chrome|Chromium/i.test(ua)) return 'Chrome 浏览器'
  return '浏览器插件'
}
