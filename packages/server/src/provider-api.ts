/**
 * Talks to a provider's own HTTP API: which models it serves, and how much
 * balance is left. Both are best-effort; a provider that lacks the endpoint
 * simply reports it as unsupported.
 */
export interface DiscoveredModel {
  id: string
  label?: string
}

export interface BalanceItem {
  label: string
  value: string
}

export interface Balance {
  /** False when the provider has no balance endpoint we know of. */
  supported: boolean
  items: BalanceItem[]
}

export type AuthStyle = 'bearer' | 'anthropic' | 'google'

const TIMEOUT_MS = 10_000

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' })
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('密钥无效或没有权限')
    throw new Error(`服务返回了 ${res.status}`)
  }
  return res.json()
}

function authHeaders(style: AuthStyle, key: string): Record<string, string> {
  if (!key) return {}
  if (style === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  if (style === 'google') return { 'x-goog-api-key': key }
  return { authorization: `Bearer ${key}` }
}

const MAX_MODELS = 500

/** Lists the models a provider serves. Works for OpenAI-compatible `/models` and for Anthropic and Google. */
export async function discoverModels(baseURL: string, style: AuthStyle, key: string): Promise<DiscoveredModel[]> {
  const base = baseURL.replace(/\/+$/, '')
  const json = (await getJson(`${base}/models`, authHeaders(style, key))) as Record<string, unknown>
  const rows = (Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : null) as Record<string, unknown>[] | null
  if (!rows) throw new Error('这个端点没有返回模型列表')
  const out: DiscoveredModel[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const raw = typeof r.id === 'string' ? r.id : typeof r.name === 'string' ? r.name : ''
    const id = raw.replace(/^models\//, '')
    if (!id) continue
    const label = typeof r.display_name === 'string' ? r.display_name : typeof r.displayName === 'string' ? r.displayName : undefined
    out.push(label && label !== id ? { id, label } : { id })
    if (out.length >= MAX_MODELS) break
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}
const fmt = (n: number): string => (Math.round(n * 10000) / 10000).toString()

/** Which balance API a base URL belongs to, by host. */
export function balanceKind(baseURL: string): 'deepseek' | 'openrouter' | 'moonshot' | 'siliconflow' | null {
  let host = ''
  try {
    host = new URL(baseURL).hostname.toLowerCase()
  } catch {
    return null
  }
  if (host === 'api.deepseek.com') return 'deepseek'
  if (host === 'openrouter.ai') return 'openrouter'
  if (host === 'api.moonshot.cn' || host === 'api.moonshot.ai') return 'moonshot'
  if (host === 'api.siliconflow.cn' || host === 'api.siliconflow.com') return 'siliconflow'
  return null
}

/** Reads the remaining balance. Returns `supported: false` for providers without a known endpoint. */
export async function fetchBalance(baseURL: string, key: string): Promise<Balance> {
  const kind = balanceKind(baseURL)
  if (!kind) return { supported: false, items: [] }
  if (!key) throw new Error('需要先填写密钥')
  const h = authHeaders('bearer', key)
  const origin = new URL(baseURL).origin
  if (kind === 'deepseek') {
    const j = (await getJson(`${origin}/user/balance`, h)) as { is_available?: boolean; balance_infos?: Record<string, unknown>[] }
    const items: BalanceItem[] = []
    for (const b of j.balance_infos ?? []) {
      const cur = String(b.currency ?? '')
      items.push({ label: `余额（${cur}）`, value: String(b.total_balance ?? '-') })
      const granted = num(b.granted_balance)
      const topped = num(b.topped_up_balance)
      if (granted) items.push({ label: `赠送余额（${cur}）`, value: fmt(granted) })
      if (topped) items.push({ label: `充值余额（${cur}）`, value: fmt(topped) })
    }
    if (j.is_available === false) items.push({ label: '状态', value: '余额不足，无法调用' })
    return { supported: true, items }
  }
  if (kind === 'openrouter') {
    const credits = ((await getJson(`${origin}/api/v1/credits`, h)) as { data?: Record<string, unknown> }).data ?? {}
    const total = num(credits.total_credits)
    const used = num(credits.total_usage)
    const items: BalanceItem[] = []
    if (total !== null) items.push({ label: '累计充值（$）', value: fmt(total) })
    if (used !== null) items.push({ label: '累计消耗（$）', value: fmt(used) })
    if (total !== null && used !== null) items.push({ label: '余额（$）', value: fmt(total - used) })
    return { supported: true, items }
  }
  if (kind === 'moonshot') {
    const d = ((await getJson(`${origin}/v1/users/me/balance`, h)) as { data?: Record<string, unknown> }).data ?? {}
    const items: BalanceItem[] = []
    const avail = num(d.available_balance)
    if (avail !== null) items.push({ label: '可用余额', value: fmt(avail) })
    const cash = num(d.cash_balance)
    if (cash !== null) items.push({ label: '现金余额', value: fmt(cash) })
    const voucher = num(d.voucher_balance)
    if (voucher !== null) items.push({ label: '代金券余额', value: fmt(voucher) })
    return { supported: true, items }
  }
  const d = ((await getJson(`${origin}/v1/user/info`, h)) as { data?: Record<string, unknown> }).data ?? {}
  const items: BalanceItem[] = []
  const total = num(d.totalBalance)
  if (total !== null) items.push({ label: '总余额', value: fmt(total) })
  const charge = num(d.chargeBalance)
  if (charge !== null) items.push({ label: '充值余额', value: fmt(charge) })
  return { supported: true, items }
}
