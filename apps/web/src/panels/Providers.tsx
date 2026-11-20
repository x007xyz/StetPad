import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent } from '../components/ui/dialog'
import { Switch } from '../components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { AddProvider, type AddDraft, type CatalogEntry } from './AddProvider'
import { CapsPicker, DEFAULT_CAPS, normalizeCaps, type Capability } from './caps'

/** A model row as it is being edited. Prices are text so a half-typed number survives. */
interface ModelRow {
  id: string // full id: "<provider>:<model>"
  rawId: string
  label: string
  enabled: boolean
  verified: boolean
  /** Added by the user to a built-in provider, so it can be removed again. */
  added: boolean
  input: string
  output: string
  caps: Capability[]
}

interface ProviderRow {
  id: string
  name: string
  builtin: boolean
  baseURL: string
  keySource: 'saved' | 'dsh' | 'env' | null
  keyName: string | null
  enabled: boolean
  currency: string
  /** Typed here, never read back from the server. */
  apiKey: string
  models: ModelRow[]
  /** Created in this dialog and not saved yet, so the server knows nothing about it. */
  isNew: boolean
  /** Catalog entry a custom provider was added from (its id), if any. */
  preset: string | null
  /** Where to get an API key, when the catalog knows it. */
  keyUrl: string | null
}

interface ServerProvider {
  id: string
  name: string
  builtin: boolean
  baseURL: string
  keySource: 'saved' | 'dsh' | 'env' | null
  keyName: string | null
  enabled: boolean
  currency: string
  preset: string | null
  keyUrl: string | null
  models: { id: string; rawId: string; label: string; enabled: boolean; verified: boolean; added: boolean; caps?: Capability[]; price: { input: number; output: number } | null }[]
}

interface UsageDay { day: string; model: string; input_tokens: number; output_tokens: number; runs: number; cost: number | null; currency: string | null }

interface BalanceResult {
  supported?: boolean
  items?: { label: string; value: string }[]
  error?: string
}

/** Providers whose balance can be read with their key: built-in names, or by endpoint host. */
const BALANCE_HOSTS = ['api.deepseek.com', 'openrouter.ai', 'api.moonshot.cn', 'api.moonshot.ai', 'api.siliconflow.cn', 'api.siliconflow.com']
const canQueryBalance = (p: ProviderRow): boolean => {
  if (p.builtin) return p.id === 'deepseek' || p.id === 'openrouter'
  try {
    return BALANCE_HOSTS.includes(new URL(p.baseURL).hostname)
  } catch {
    return false
  }
}

const newProviderId = (): string => 'p' + Math.random().toString(36).slice(2, 10)
const SOURCE_LABEL = { saved: '已保存在应用里', dsh: '来自本机 DSH 配置', env: '来自环境变量' } as const

const toRow = (p: ServerProvider): ProviderRow => ({
  id: p.id,
  name: p.name,
  builtin: p.builtin,
  baseURL: p.baseURL,
  keySource: p.keySource,
  keyName: p.keyName,
  enabled: p.enabled,
  currency: p.currency,
  apiKey: '',
  isNew: false,
  preset: p.preset ?? null,
  keyUrl: p.keyUrl ?? null,
  models: p.models.map((m) => ({
    id: m.id,
    rawId: m.rawId,
    label: m.label,
    enabled: m.enabled,
    verified: m.verified,
    added: m.added,
    input: m.price ? String(m.price.input) : '',
    output: m.price ? String(m.price.output) : '',
    caps: normalizeCaps(m.caps),
  })),
})

const priceOf = (m: ModelRow): { input: number; output: number } | undefined => {
  const input = Number(m.input) || 0
  const output = Number(m.output) || 0
  return input > 0 || output > 0 ? { input, output } : undefined
}

function BalanceView({ value }: { value: BalanceResult | 'loading' | undefined }) {
  if (!value) return null
  if (value === 'loading') return <span className="muted small">查询中…</span>
  if (value.error) return <span className="error small">{value.error}</span>
  if (value.supported === false) return <span className="muted small">这个服务暂不支持查询余额。</span>
  return <span className="small">{(value.items ?? []).map((i) => `${i.label}：${i.value}`).join('　')}</span>
}

/**
 * Provider management, laid out like opencodex: a searchable provider list on the left
 * (ready / needs a key / off), and on the right the selected provider's overview, models,
 * usage, key and settings. Nothing is written until 保存.
 */
export function Providers({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<ProviderRow[]>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [selected, setSelected] = useState('')
  const [tab, setTab] = useState('overview')
  const [query, setQuery] = useState('')
  const [usage, setUsage] = useState<UsageDay[]>([])
  const [balances, setBalances] = useState<Record<string, BalanceResult | 'loading'>>({})
  const [tests, setTests] = useState<Record<string, { ok?: boolean; ms?: number; error?: string; running?: boolean }>>({})
  const [discovering, setDiscovering] = useState(false)
  const [filter, setFilter] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [adding, setAdding] = useState(false)
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [testModel, setTestModel] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)

  /** Reloads from the server. `keep` is the provider to select afterwards, when it still exists. */
  const load = async (keep?: string): Promise<void> => {
    const m = await api<{ providerList?: ServerProvider[]; default: string | null }>('/models')
    // An older server build has no provider list; say so instead of showing an empty page.
    if (!m.providerList) return setError('服务端版本过旧，请重新构建并重启桌面应用')
    const next = m.providerList.map(toRow)
    setRows(next)
    setDefaultModel(m.default ?? '')
    setSelected(keep && next.some((r) => r.id === keep) ? keep : (next.find((r) => r.enabled)?.id ?? next[0]?.id ?? ''))
    setDirty(false)
    setUsage((await api<{ days: UsageDay[] }>('/usage')).days)
  }
  useEffect(() => void load(), [])
  // The catalog is optional: without it the custom endpoint path still works.
  useEffect(() => {
    api<{ catalog?: CatalogEntry[] }>('/providers/catalog')
      .then((r) => setCatalog(r.catalog ?? []))
      .catch(() => setCatalog([]))
  }, [])

  const current = rows.find((r) => r.id === selected) ?? null
  const status = (r: ProviderRow): 'ready' | 'needs-key' | 'off' => (!r.enabled ? 'off' : r.builtin && !r.keySource && !r.apiKey ? 'needs-key' : 'ready')
  const providerOfDefault = defaultModel.split(':')[0]

  const edit = (patch: Partial<ProviderRow>): void => {
    setRows(rows.map((r) => (r.id === selected ? { ...r, ...patch } : r)))
    setDirty(true)
  }
  const editModel = (id: string, patch: Partial<ModelRow>): void => {
    if (current) edit({ models: current.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) })
  }

  const visible = rows.filter((r) => !query.trim() || r.name.toLowerCase().includes(query.trim().toLowerCase()))
  const groups = [
    { title: '已启用', items: visible.filter((r) => status(r) !== 'off') },
    { title: '已停用', items: visible.filter((r) => status(r) === 'off') },
  ]

  const setAsDefault = (r: ProviderRow, modelId?: string): void => {
    const pick = modelId ?? (r.models.some((m) => m.id === defaultModel && m.enabled) ? defaultModel : r.models.find((m) => m.enabled)?.id)
    if (!pick) return setError('这个提供方没有启用的模型，先到“模型”里打开一个')
    setError('')
    setDefaultModel(pick)
    setDirty(true)
  }

  const query1 = async (key: string, body: Record<string, string>): Promise<void> => {
    setBalances((b) => ({ ...b, [key]: 'loading' }))
    try {
      const r = await api<BalanceResult>('/providers/balance', { method: 'POST', body: JSON.stringify(body) })
      setBalances((b) => ({ ...b, [key]: r }))
    } catch (err) {
      setBalances((b) => ({ ...b, [key]: { error: err instanceof Error ? err.message : '查询失败' } }))
    }
  }

  // Fills the model list from the provider's own /models endpoint. Existing rows keep their state and prices.
  const discover = async (): Promise<void> => {
    if (!current) return
    setDiscovering(true)
    setError('')
    try {
      const r = await api<{ models: { id: string; label?: string }[] }>('/providers/models', {
        method: 'POST',
        body: JSON.stringify({ provider: current.id, baseURL: current.builtin ? undefined : current.baseURL, apiKey: current.apiKey }),
      })
      const have = new Set(current.models.map((m) => m.rawId))
      const fresh = r.models.filter((m) => !have.has(m.id)).map((m): ModelRow => ({ id: `${current.id}:${m.id}`, rawId: m.id, label: m.label ?? m.id, enabled: true, verified: false, added: true, input: '', output: '', caps: [...DEFAULT_CAPS] }))
      edit({ models: [...current.models, ...fresh] })
      setMessage(`从接口读取到 ${r.models.length} 个模型，新增 ${fresh.length} 个。`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取失败')
    } finally {
      setDiscovering(false)
    }
  }

  const addModel = (): void => {
    const raw = customModel.trim()
    if (!current || !raw || current.models.some((m) => m.rawId === raw)) return
    edit({ models: [...current.models, { id: `${current.id}:${raw}`, rawId: raw, label: raw, enabled: true, verified: false, added: true, input: '', output: '', caps: [...DEFAULT_CAPS] }] })
    setCustomModel('')
  }
  const removeModel = (id: string): void => {
    if (current) edit({ models: current.models.filter((m) => m.id !== id) })
  }

  const testConnection = async (r: ProviderRow, modelId: string): Promise<void> => {
    setTests((t) => ({ ...t, [r.id]: { running: true } }))
    try {
      const result = await api<{ ok?: boolean; ms?: number; error?: string }>('/providers/test', { method: 'POST', body: JSON.stringify({ modelId }) })
      setTests((t) => ({ ...t, [r.id]: result }))
    } catch (err) {
      setTests((t) => ({ ...t, [r.id]: { ok: false, error: err instanceof Error ? err.message : '请求失败' } }))
    }
  }

  /** Applies the picker's draft to the rows and saves at once. The new provider is selected afterwards. */
  const addProvider = (draft: AddDraft): void => {
    const newModel = (rowId: string, m: { id: string; label?: string; caps?: Capability[] }): ModelRow => ({ id: `${rowId}:${m.id}`, rawId: m.id, label: m.label ?? m.id, enabled: true, verified: false, added: true, input: '', output: '', caps: normalizeCaps(m.caps) })
    let id: string
    let nextRows: ProviderRow[]
    if (draft.kind === 'builtin') {
      id = draft.provider
      if (!rows.some((r) => r.id === id)) return setError('找不到这个内置提供方')
      const picked = new Set(draft.models.map((m) => m.id))
      nextRows = rows.map((r) => {
        if (r.id !== id) return r
        const have = new Set(r.models.map((m) => m.rawId))
        const models = r.models.map((m) => (picked.has(m.rawId) ? { ...m, enabled: true } : m))
        const fresh = draft.models.filter((m) => !have.has(m.id)).map((m) => newModel(r.id, m))
        return { ...r, apiKey: draft.apiKey, enabled: true, models: [...models, ...fresh] }
      })
    } else {
      id = `custom-${newProviderId()}`
      const row: ProviderRow = {
        id,
        name: draft.name,
        builtin: false,
        baseURL: draft.baseURL,
        keySource: null,
        keyName: null,
        enabled: true,
        currency: draft.currency,
        apiKey: draft.apiKey,
        models: draft.models.map((m) => newModel(id, m)),
        isNew: true,
        preset: draft.preset,
        keyUrl: null,
      }
      nextRows = [...rows, row]
    }
    const nextDefault = `${id}:${draft.defaultModel}`
    setRows(nextRows)
    setDefaultModel(nextDefault)
    setSelected(id)
    setTab('overview')
    setFilter('')
    setAdding(false)
    setError('')
    setDirty(true)
    void save(nextRows, nextDefault, id)
  }

  const removeCurrent = (): void => {
    if (!current || current.builtin) return
    const rest = rows.filter((r) => r.id !== current.id)
    setRows(rest)
    setSelected(rest[0]?.id ?? '')
    setDirty(true)
  }

  /** Writes the given rows and default model to the server, then reloads. `keep` is the provider to stay on. */
  const save = async (nextRows: ProviderRow[], nextDefault: string, keep: string = selected): Promise<void> => {
    setError('')
    setMessage('')
    const customProviders = nextRows
      .filter((r) => !r.builtin)
      .map((r) => ({
        id: r.id.slice('custom-'.length),
        name: r.name.trim(),
        baseURL: r.baseURL.trim(),
        ...(r.currency.trim() ? { currency: r.currency.trim() } : {}),
        ...(r.preset ? { preset: r.preset } : {}),
        models: r.models.map((m) => ({ id: m.rawId, ...(m.label && m.label !== m.rawId ? { label: m.label } : {}), ...(priceOf(m) ? { price: priceOf(m) } : {}), caps: m.caps })),
        ...(r.apiKey.trim() ? { apiKey: r.apiKey.trim() } : {}),
      }))
    const keys: Record<string, string> = {}
    const extraModels: Record<string, { id: string; label?: string }[]> = {}
    const modelPrices: Record<string, { input: number; output: number }> = {}
    // Built-in models keep their capabilities in one map keyed by "<provider>:<model>"; it is sent in full every save.
    const modelCaps: Record<string, Capability[]> = {}
    for (const r of nextRows.filter((x) => x.builtin)) {
      if (r.keyName && r.apiKey.trim()) keys[r.keyName] = r.apiKey.trim()
      const added = r.models.filter((m) => m.added).map((m) => (m.label && m.label !== m.rawId ? { id: m.rawId, label: m.label } : { id: m.rawId }))
      if (added.length) extraModels[r.id] = added
      for (const m of r.models) if (priceOf(m)) modelPrices[m.id] = priceOf(m)!
      for (const m of r.models) modelCaps[m.id] = m.caps
    }
    const disabledProviders = nextRows.filter((r) => !r.enabled).map((r) => r.id)
    const disabledModels = nextRows.flatMap((r) => r.models.filter((m) => !m.enabled).map((m) => m.id))
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify({ model: nextDefault, keys, customProviders, extraModels, modelPrices, modelCaps, disabledProviders, disabledModels }) })
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
      return
    }
    await load(keep)
    setMessage('已保存')
    onChanged()
  }

  const providerUsage = useMemo(() => {
    if (!current) return { days: [] as UsageDay[], tokens: 0 }
    const days = usage.filter((d) => d.model.startsWith(`${current.id}:`))
    return { days, tokens: days.reduce((n, d) => n + d.input_tokens + d.output_tokens, 0) }
  }, [usage, current])

  const enabledModels = current?.models.filter((m) => m.enabled) ?? []
  const testTarget = enabledModels.find((m) => m.id === testModel)?.id ?? enabledModels[0]?.id ?? ''
  const shownModels = current?.models.filter((m) => !filter.trim() || m.rawId.toLowerCase().includes(filter.trim().toLowerCase()) || m.label.toLowerCase().includes(filter.trim().toLowerCase())) ?? []

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="模型提供方" className="panel max-w-4xl">
        <div className="prov">
          <aside className="prov-list">
            <input aria-label="搜索提供方" placeholder="搜索提供方…" value={query} onChange={(e) => setQuery(e.target.value)} />
            {groups.map((g) => g.items.length > 0 && (
              <div key={g.title}>
                <div className="muted small prov-group">{g.title} {g.items.length}</div>
                {g.items.map((r) => (
                  <button key={r.id} type="button" className="prov-item" data-active={r.id === selected} onClick={() => { setSelected(r.id); setAdding(false); setTab('overview'); setFilter('') }}>
                    <span className={`dot ${status(r)}`} aria-hidden />
                    <span className="prov-name">{r.name}</span>
                    {r.id === providerOfDefault && <span title="默认提供方">★</span>}
                    <span className="muted small">{r.models.filter((m) => m.enabled).length}/{r.models.length}</span>
                  </button>
                ))}
              </div>
            ))}
            <Button size="sm" onClick={() => { setAdding(true); setError('') }}>添加提供方</Button>
          </aside>

          <section className="prov-detail">
            {adding && (
              <AddProvider catalog={catalog} rows={rows} onCancel={() => setAdding(false)} onDone={addProvider} />
            )}

            {!adding && !current && <p className="muted">还没有提供方。点“添加提供方”开始。</p>}

            {!adding && current && (
              <div>
                <div className="row between">
                  <div>
                    <h3 className="prov-title">{current.name}</h3>
                    <span className="muted small">{current.builtin ? current.id : current.id.slice('custom-'.length)}</span>
                  </div>
                  <div className="row">
                    <Button size="sm" disabled={current.id === providerOfDefault} onClick={() => setAsDefault(current)}>{current.id === providerOfDefault ? '默认提供方' : '设为默认'}</Button>
                    <label className="row" style={{ margin: 0 }}>
                      启用
                      <Switch aria-label="启用" checked={current.enabled} onCheckedChange={(v) => edit({ enabled: v })} />
                    </label>
                  </div>
                </div>

                <Tabs value={tab} onValueChange={setTab}>
                  <TabsList>
                    <TabsTrigger value="overview">概览</TabsTrigger>
                    <TabsTrigger value="models">模型</TabsTrigger>
                    <TabsTrigger value="usage">用量</TabsTrigger>
                    <TabsTrigger value="key">密钥</TabsTrigger>
                    <TabsTrigger value="settings">设置</TabsTrigger>
                  </TabsList>

                  <TabsContent value="overview">
                    <table className="usage">
                      <tbody>
                        <tr><td>状态</td><td>{{ ready: '就绪', 'needs-key': '需要密钥', off: '已停用' }[status(current)]}</td></tr>
                        <tr><td>端点</td><td><code>{current.baseURL || '内置'}</code></td></tr>
                        <tr><td>密钥</td><td>{current.apiKey ? '将在保存后生效' : current.keySource ? SOURCE_LABEL[current.keySource] : '未设置'}</td></tr>
                        <tr><td>模型</td><td>{`${enabledModels.length} 个已启用，共 ${current.models.length} 个 `}<Button variant="link" size="sm" onClick={() => setTab('models')}>选择模型</Button></td></tr>
                      </tbody>
                    </table>
                    <h3 className="sect">测试连接</h3>
                    <p className="muted small">用已保存的配置向模型发一条很短的请求。{dirty && '有未保存的修改，请先保存。'}</p>
                    <div className="row wrap">
                      <select aria-label="测试用模型" value={testTarget} onChange={(e) => setTestModel(e.target.value)}>
                        {enabledModels.length === 0 && <option value="">没有启用的模型</option>}
                        {enabledModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </select>
                      <Button size="sm" disabled={!testTarget || current.isNew || dirty || tests[current.id]?.running} onClick={() => void testConnection(current, testTarget)}>{tests[current.id]?.running ? '测试中…' : '测试'}</Button>
                      {tests[current.id]?.ok === true && <span className="small">{`连接正常，耗时 ${tests[current.id]!.ms} ms`}</span>}
                      {tests[current.id]?.ok === false && <span className="error small">{tests[current.id]!.error}</span>}
                    </div>
                    <h3 className="sect">余额</h3>
                    {canQueryBalance(current) ? (
                      <div className="row wrap">
                        <Button size="sm" disabled={current.isNew} onClick={() => void query1(current.id, { provider: current.id, ...(current.builtin ? {} : { baseURL: current.baseURL }), apiKey: current.apiKey })}>查询余额</Button>
                        <BalanceView value={balances[current.id]} />
                      </div>
                    ) : (
                      <p className="muted small">这个服务没有可读取余额的接口，请到服务商的控制台查看。</p>
                    )}
                  </TabsContent>

                  <TabsContent value="models">
                    <div className="row wrap">
                      <Button size="sm" disabled={discovering || !current.baseURL && !current.builtin} onClick={() => void discover()}>{discovering ? '获取中…' : '从接口获取模型'}</Button>
                      <input aria-label="添加模型" placeholder="手动添加模型 ID" value={customModel} onChange={(e) => setCustomModel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addModel()} />
                      <Button size="sm" onClick={addModel}>添加</Button>
                      <input aria-label="筛选模型" placeholder="筛选…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                    </div>
                    {message && <p className="muted small">{message}</p>}
                    <p className="muted small">关闭开关的模型不会出现在选择列表里。</p>
                    <table className="usage">
                      <thead><tr><th>启用</th><th>模型</th><th>能力</th><th></th></tr></thead>
                      <tbody>
                        {shownModels.map((m) => (
                          <tr key={m.id}>
                            <td><Switch aria-label={`启用 ${m.rawId}`} checked={m.enabled} onCheckedChange={(v) => editModel(m.id, { enabled: v })} /></td>
                            <td>
                              <code>{m.rawId}</code>{' '}
                              {m.id === defaultModel && <span className="muted small">默认</span>}
                              {!m.verified && <span className="muted small" style={{ marginLeft: 6 }}>未验证</span>}
                              {!current.builtin && (
                                <input aria-label="显示名" className="prov-label" value={m.label === m.rawId ? '' : m.label} placeholder="显示名" onChange={(e) => editModel(m.id, { label: e.target.value || m.rawId })} />
                              )}
                            </td>
                            <td>
                              <CapsPicker caps={m.caps} onChange={(caps) => editModel(m.id, { caps })} />
                            </td>
                            <td>
                              <Button variant="link" size="sm" disabled={!m.enabled || m.id === defaultModel} onClick={() => setAsDefault(current, m.id)}>设为默认</Button>
                              {(!current.builtin || m.added) && <Button variant="link" size="sm" onClick={() => removeModel(m.id)}>删除</Button>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {current.models.length === 0 && <p className="muted small">还没有模型。点“从接口获取模型”，或手动添加。</p>}
                  </TabsContent>

                  <TabsContent value="usage">
                    <p className="muted small">{`最近 30 天共 ${providerUsage.tokens.toLocaleString()} token。`}</p>
                    {providerUsage.days.length === 0 ? (
                      <p className="muted small">这个提供方最近 30 天没有用量。</p>
                    ) : (
                      <table className="usage">
                        <thead><tr><th>日期</th><th>模型</th><th>次数</th><th>输入</th><th>输出</th></tr></thead>
                        <tbody>
                          {providerUsage.days.slice(0, 30).map((d) => (
                            <tr key={d.day + d.model}><td>{d.day}</td><td>{d.model.slice(current.id.length + 1)}</td><td>{d.runs}</td><td>{d.input_tokens.toLocaleString()}</td><td>{d.output_tokens.toLocaleString()}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </TabsContent>

                  <TabsContent value="key">
                    <p className="muted small">{`密钥只保存在服务端，保存后不会再显示。留空表示不修改。当前：${current.keySource ? SOURCE_LABEL[current.keySource] : '未设置'}。${current.builtin ? '没有保存时，会使用环境变量或本机 DSH 配置里的密钥。' : ''}`}</p>
                    <label>
                      API 密钥
                      <input type="password" autoComplete="off" placeholder={current.keyName ?? (current.keySource ? '留空表示不修改' : '本机服务可以留空')} value={current.apiKey} onChange={(e) => edit({ apiKey: e.target.value })} />
                    </label>
                    {current.keyUrl && (
                      <p className="small"><a href={current.keyUrl} target="_blank" rel="noreferrer">去获取密钥 ↗</a></p>
                    )}
                  </TabsContent>

                  <TabsContent value="settings">
                    {current.builtin ? (
                      <p className="muted small">内置提供方的端点是固定的。可以在“概览”里停用它，或在“模型”里增减模型。</p>
                    ) : (
                      <>
                        <label>名称<input value={current.name} onChange={(e) => edit({ name: e.target.value })} /></label>
                        <label>端点<input value={current.baseURL} onChange={(e) => edit({ baseURL: e.target.value })} /></label>
                        <div className="row end"><Button variant="default" onClick={removeCurrent}>删除这个提供方</Button></div>
                      </>
                    )}
                  </TabsContent>
                </Tabs>
              </div>
            )}
          </section>
        </div>
        <div className="row end">
          {error && <span className="error">{error}</span>}
          {!error && dirty && <span className="muted">有未保存的修改</span>}
          {!error && !dirty && message === '已保存' && <span className="muted">已保存</span>}
          <Button onClick={onClose}>关闭</Button>
          <Button variant="default" disabled={!dirty} onClick={() => void save(rows, defaultModel)}>保存</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
