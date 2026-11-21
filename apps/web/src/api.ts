/**
 * How the UI reaches the local service. The desktop shell injects `window.aiw`,
 * which carries the token that proves who the caller is.
 */
import { fmtDate, getLang } from './i18n'

declare global {
  interface Window {
    aiw?: { token: string; platform: string }
  }
}

export const isDesktop = !!window.aiw

/**
 * Outside the desktop shell (development in a browser), the token is passed
 * once as `?token=` and kept for the tab's session.
 */
const TOKEN_KEY = 'aiw.token'
function browserToken(): string {
  try {
    const url = new URL(location.href)
    const fromUrl = url.searchParams.get('token')
    if (fromUrl) {
      sessionStorage.setItem(TOKEN_KEY, fromUrl)
      url.searchParams.delete('token')
      history.replaceState(null, '', url.pathname + url.search + url.hash)
      return fromUrl
    }
    return sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}
const token = window.aiw?.token ?? browserToken()

export const getToken = (): string => token

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${getToken()}` }
  if (init.body && !(init.body instanceof FormData)) headers['content-type'] = 'application/json'
  const res = await fetch('/api' + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } })
  const isJson = (res.headers.get('content-type') ?? '').includes('json')
  const body = isJson ? await res.json() : await res.text()
  if (!res.ok) throw new ApiError(res.status, (isJson && (body as { error?: string }).error) || `请求失败（${res.status}）`)
  return body as T
}
export const post = <T = unknown>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export async function apiBlob(path: string): Promise<Blob> {
  const res = await fetch('/api' + path, { headers: { authorization: `Bearer ${getToken()}` } })
  if (!res.ok) throw new ApiError(res.status, `请求失败（${res.status}）`)
  return res.blob()
}

/** Print a self-contained HTML document; the system dialog offers "Save as PDF". */
export function printHtml(html: string): void {
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  frame.setAttribute('sandbox', 'allow-modals allow-same-origin')
  const css = '<style>body{font:12pt/1.7 -apple-system,"PingFang SC",sans-serif;max-width:42em;margin:0 auto;color:#111}h1{font-size:22pt}h2{font-size:17pt}h3{font-size:14pt}pre{background:#f3f3f3;padding:8pt;white-space:pre-wrap}blockquote{border-left:3pt solid #ccc;margin-left:0;padding-left:10pt;color:#555}table{border-collapse:collapse}td,th{border:1px solid #999;padding:3pt 6pt}img{max-width:100%}aside{background:#fff6dc;padding:8pt}@page{margin:20mm}</style>'
  frame.srcdoc = html.replace('</head>', css + '</head>')
  frame.onload = () => {
    frame.contentWindow?.focus()
    frame.contentWindow?.print()
    setTimeout(() => frame.remove(), 60_000)
  }
  document.body.appendChild(frame)
}

export const collabUrl = (): string => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`

export function download(name: string, content: string | Blob, mime: string): void {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type: mime }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export interface Folder { id: string; name: string; created_at: number }
export interface DocMeta { id: string; title: string; created_at: number; updated_at: number; folder_id?: string | null }
export interface ModelInfo { id: string; provider: string; label: string; verified: boolean; enabled: boolean }
export interface ModelsResponse {
  models: ModelInfo[]
  default: string | null
  providers: { provider: string; keyName: string; hasSavedKey: boolean }[]
  providerList: { id: string; name: string; status: 'ready' | 'needs-key' | 'disabled' }[]
  customProviders: { id: string; name: string; baseURL: string; currency?: string; models: { id: string; label?: string; price?: { input: number; output: number } }[]; hasKey: boolean }[]
  presets: { id: string; label: string }[]
  externalAgents: { id: string; label: string }[]
  /** Desktop app only: every known agent, and whether it is installed on this machine. */
  externalAgentsAll?: { id: string; label: string; command: string; args: string[]; installed: boolean; builtin: boolean }[]
}
export interface RunMeta { id: string; instruction: string; model: string; status: string; summary: string | null; created_at: number }
export interface VersionMeta { id: string; label: string | null; trigger: string; author: string; word_count: number; created_at: number }
export interface RichBlock {
  blockId: string
  type: string
  attrs: Record<string, unknown>
  text: string
  delta: { insert: string; attributes?: Record<string, unknown> }[]
  state?: string
}

/** Read a run's event stream. Reconnects from the last event seen. */
export async function streamRun(
  runId: string,
  onEvent: (type: string, data: Record<string, unknown>) => void,
  signal: AbortSignal,
): Promise<void> {
  let after = 0
  let finished = false
  for (let attempt = 0; attempt < 6 && !finished && !signal.aborted; attempt++) {
    try {
      const res = await fetch(`/api/runs/${runId}/events?after=${after}`, { headers: { authorization: `Bearer ${getToken()}` }, signal })
      if (!res.ok || !res.body) throw new Error(String(res.status))
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const type = raw.match(/^event: (.*)$/m)?.[1]
          const id = raw.match(/^id: (.*)$/m)?.[1]
          const data = raw.match(/^data: (.*)$/m)?.[1]
          if (id) after = Number(id)
          if (!type || type === 'ping') continue
          onEvent(type, data ? (JSON.parse(data) as Record<string, unknown>) : {})
          if (type === 'run.finished') finished = true
        }
      }
      if (!finished) finished = true // the server closed the stream: the run is over
    } catch {
      if (signal.aborted) return
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
    }
  }
}

export const TRIGGERS: Record<string, string> = {
  manual: '手动保存', auto: '自动保存', import: '导入', 'before-ai': 'AI 操作前', 'after-ai': 'AI 操作后',
  reviewed: '修订处理完', 'before-restore': '恢复前', restore: '恢复',
}
export const fmtTime = (t: number): string => {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${fmtDate(t)}${getLang() === 'en' ? ',' : ''} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** GET /search: one hit across every document the caller can open. */
export interface SearchResult {
  id: string
  title: string
  folder_id: string | null
  updated_at: number
  snippet: string
  titleMatch: boolean
}
/** GET /trash: a trashed document, with the time it was moved there. */
export type TrashDoc = DocMeta & { deleted_at: number }
/** POST /docs/:id/comments/:cid/notify: `ai` says whether the server started an AI reply. */
export interface NotifyResult { ai: boolean }

/** Tell the server a comment (or a reply, given its index) was written so it can run @AI. Resolves to whether an AI reply was started. */
export function notifyComment(docId: string, commentId: string, reply?: number): Promise<boolean> {
  return post<NotifyResult>(`/docs/${docId}/comments/${commentId}/notify`, reply === undefined ? {} : { reply }).then((r) => r.ai).catch(() => false)
}
