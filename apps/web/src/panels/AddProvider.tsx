import { getLang, t } from '../i18n'
import { useState } from 'react'
import { post } from '../api'
import { Button } from '../components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { CapsPicker, DEFAULT_CAPS, normalizeCaps, type Capability } from './caps'

/** One entry of the provider catalog (GET /providers/catalog). */
export type CatalogRegion = 'cn' | 'global' | 'aggregator' | 'local'

export interface CatalogEntry {
  id: string
  name: string
  region: CatalogRegion
  /** Built-in provider id this entry configures, instead of creating a custom provider. */
  builtin?: string
  baseURL: string
  keyUrl?: string
  keyOptional?: boolean
  freeTier?: boolean
  /** Symbol for prices: "$" or "¥". */
  currency: string
  note: string
  /** Suggested models; the first is the suggested default. */
  models: { id: string; label?: string }[]
}

/** The subset of a provider row the picker needs. */
export interface AddProviderRow {
  id: string
  name: string
  builtin: boolean
  preset: string | null
  keySource: 'saved' | 'dsh' | 'env' | null
}

/** A model in a draft. `caps` is missing for models the server never tagged; those count as the defaults. */
export interface ModelOpt { id: string; label?: string; caps?: Capability[] }

export type AddDraft =
  | { kind: 'builtin'; provider: string; apiKey: string; models: ModelOpt[]; defaultModel: string }
  | { kind: 'custom'; preset: string | null; name: string; baseURL: string; currency: string; apiKey: string; models: ModelOpt[]; defaultModel: string }

const REGIONS: { value: 'all' | CatalogRegion; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'cn', label: '国内' },
  { value: 'global', label: '海外' },
  { value: 'aggregator', label: '聚合平台' },
  { value: 'local', label: '本机' },
]

const uniq = (xs: ModelOpt[]): ModelOpt[] => [...new Map(xs.map((m) => [m.id, m])).values()]
const initialOf = (name: string): string => Array.from(name.trim())[0]?.toUpperCase() ?? '?'

interface AddProviderProps {
  catalog: CatalogEntry[]
  rows: AddProviderRow[]
  onCancel: () => void
  onDone: (draft: AddDraft) => void
}

/**
 * Add a provider in two steps: pick a service from the catalog (or a blank custom endpoint),
 * then paste its key, verify it and choose the models. Nothing is saved here; onDone hands the draft back.
 */
export function AddProvider({ catalog, rows, onCancel, onDone }: AddProviderProps) {
  const [chosen, setChosen] = useState<CatalogEntry | 'custom' | null>(null)
  const [query, setQuery] = useState('')
  const [region, setRegion] = useState<'all' | CatalogRegion>('all')

  if (chosen) {
    return (
      <ConfigureProvider
        key={chosen === 'custom' ? 'custom' : chosen.id}
        entry={chosen === 'custom' ? null : chosen}
        rows={rows}
        onBack={() => setChosen(null)}
        onCancel={onCancel}
        onDone={onDone}
      />
    )
  }

  const isAdded = (e: CatalogEntry): boolean =>
    e.builtin ? rows.some((r) => r.id === e.builtin && !!r.keySource) : rows.some((r) => !r.builtin && r.preset === e.id)
  const tabs = REGIONS.filter((t) => t.value === 'all' || catalog.some((e) => e.region === t.value))
  const q = query.trim().toLowerCase()
  const shown = catalog.filter(
    (e) => (region === 'all' || e.region === region) && (!q || [e.name, t(e.name), e.id].some((name) => name.toLowerCase().includes(q))),
  )

  return (
    <div className="addp">
      <h3 className="prov-title">添加提供方</h3>
      <input autoFocus aria-label="搜索提供方" placeholder="搜索名称或 ID…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {tabs.length > 1 && (
        <Tabs value={region} onValueChange={(v) => setRegion(v as 'all' | CatalogRegion)}>
          <TabsList>
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      <div className="addp-list">
        {catalog.length === 0 && <p className="muted small">提供方目录暂时不可用，仍可以添加自定义端点。</p>}
        {catalog.length > 0 && shown.length === 0 && <p className="muted small">没有匹配的提供方。</p>}
        <div className="prov-grid">
          {shown.map((e) => (
            <button key={e.id} type="button" data-slot="prov-card" className="prov-card" onClick={() => setChosen(e)}>
              <span className="prov-avatar" aria-hidden>{initialOf(t(e.name))}</span>
              <span className="prov-card-body">
                <span className="prov-card-name">{e.name}</span>
                <span className="muted small prov-card-note">{e.note}</span>
                <span className="prov-badges">
                  {e.freeTier && <span className="prov-badge">免费额度</span>}
                  {e.keyOptional && <span className="prov-badge">无需密钥</span>}
                  {isAdded(e) && <span className="prov-badge ok">已添加</span>}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="row between addp-foot">
        <Button variant="link" size="sm" onClick={() => setChosen('custom')}>没有找到？添加自定义 OpenAI 兼容端点</Button>
        <Button onClick={onCancel}>取消</Button>
      </div>
    </div>
  )
}

interface ConfigureProps {
  /** null for a blank custom endpoint. */
  entry: CatalogEntry | null
  rows: AddProviderRow[]
  onBack: () => void
  onCancel: () => void
  onDone: (draft: AddDraft) => void
}

function ConfigureProvider({ entry, rows, onBack, onCancel, onDone }: ConfigureProps) {
  const isBuiltin = !!entry?.builtin
  const builtinRow = entry?.builtin ? rows.find((r) => r.id === entry.builtin) : undefined
  const configured = !!builtinRow?.keySource
  const suggested: ModelOpt[] = (entry?.models ?? []).map((m) => ({ ...m, caps: [...DEFAULT_CAPS] }))

  const [name, setName] = useState(entry?.name ?? '')
  const [baseURL, setBaseURL] = useState(entry?.baseURL ?? '')
  const [currency] = useState(entry?.currency ?? '')
  const [apiKey, setApiKey] = useState('')
  const [list, setList] = useState<ModelOpt[]>(suggested)
  const [picked, setPicked] = useState<string[]>(() => suggested.map((m) => m.id))
  const [manual, setManual] = useState<string[]>([])
  const [defaultPick, setDefaultPick] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [verifyOk, setVerifyOk] = useState('')
  const [verifyErr, setVerifyErr] = useState('')
  const [filter, setFilter] = useState('')
  const [manualId, setManualId] = useState('')

  const selectedOpts = list.filter((m) => picked.includes(m.id))
  // Keeps the default valid: the chosen one if still selected, else the first selected.
  const effDefault = selectedOpts.some((m) => m.id === defaultPick) ? defaultPick : (selectedOpts[0]?.id ?? '')
  const q = filter.trim().toLowerCase()
  const shownModels = list.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.label ?? '').toLowerCase().includes(q))

  const togglePick = (id: string, on: boolean): void =>
    setPicked((p) => (on ? [...p.filter((x) => x !== id), id] : p.filter((x) => x !== id)))

  const setCaps = (id: string, caps: Capability[]): void =>
    setList((l) => l.map((m) => (m.id === id ? { ...m, caps } : m)))

  const verify = async (): Promise<void> => {
    setVerifying(true)
    setVerifyOk('')
    setVerifyErr('')
    try {
      const body = isBuiltin ? { provider: entry?.builtin, apiKey: apiKey.trim() } : { baseURL: baseURL.trim(), apiKey: apiKey.trim() }
      const r = await post<{ models: ModelOpt[] }>('/providers/models', body)
      const found = r.models ?? []
      const foundIds = new Set(found.map((m) => m.id))
      // Suggested models stay first (the first one is the default), then whatever the endpoint reported.
      // Capabilities the user already set on a model survive a re-verify; new models get the defaults.
      const editedCaps = new Map(list.map((m) => [m.id, m.caps]))
      const merged = uniq([...suggested, ...found, ...list.filter((m) => manual.includes(m.id))]).map((m) => ({ ...m, caps: editedCaps.get(m.id) ?? m.caps ?? [...DEFAULT_CAPS] }))
      const hits = suggested.map((m) => m.id).filter((id) => foundIds.has(id))
      const preset = hits.length > 0 ? hits : found[0] ? [found[0].id] : suggested.map((m) => m.id)
      setList(merged)
      setPicked([...new Set([...preset, ...manual])])
      setDefaultPick('')
      setVerifyOk(`✓ 连接成功，读到 ${found.length} 个模型`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '验证失败'
      // Some services (Perplexity, Featherless…) serve chat but no model list; the suggested models still work.
      setVerifyErr(/\b(404|405|410)\b/.test(msg) ? '这个服务不提供模型列表，无法据此验证密钥。可以直接使用下面的推荐模型，或手动添加模型 ID。' : msg)
    } finally {
      setVerifying(false)
    }
  }

  const addManual = (): void => {
    const id = manualId.trim()
    if (!id) return
    setList((l) => (l.some((m) => m.id === id) ? l : [...l, { id, caps: [...DEFAULT_CAPS] }]))
    setPicked((p) => (p.includes(id) ? p : [...p, id]))
    setManual((m) => (m.includes(id) ? m : [...m, id]))
    setManualId('')
  }

  const keyPlaceholder = isBuiltin && configured ? '已配置，留空沿用现有密钥' : !entry || entry.keyOptional ? '本机服务可以留空' : undefined
  const canSave =
    selectedOpts.length > 0 &&
    // A blank custom endpoint may be a keyless self-hosted server, so its key is optional too.
    (!entry || !!entry.keyOptional || apiKey.trim() !== '' || configured) &&
    (isBuiltin || (name.trim() !== '' && baseURL.trim() !== ''))

  const submit = (): void => {
    if (!canSave) return
    const models = selectedOpts.map((m) => (m.label && m.label !== m.id ? { id: m.id, label: m.label, caps: normalizeCaps(m.caps) } : { id: m.id, caps: normalizeCaps(m.caps) }))
    if (entry?.builtin) {
      onDone({ kind: 'builtin', provider: entry.builtin, apiKey: apiKey.trim(), models, defaultModel: effDefault })
    } else {
      onDone({ kind: 'custom', preset: entry?.id ?? null, name: name.trim(), baseURL: baseURL.trim(), currency: currency.trim(), apiKey: apiKey.trim(), models, defaultModel: effDefault })
    }
  }

  const endpointFields = (
    <>
      <label>名称<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>端点<input value={baseURL} placeholder="https://host/v1" onChange={(e) => setBaseURL(e.target.value)} /></label>
    </>
  )

  return (
    <div className="addp">
      <div className="row between">
        <Button size="sm" onClick={onBack}>← 返回</Button>
        <h3 className="prov-title">{entry ? entry.name : '自定义 OpenAI 兼容端点'}</h3>
      </div>

      {!entry && <p className="muted small">任何兼容 OpenAI 接口的服务都可以添加。端点通常以 /v1 结尾。</p>}

      <label>
        API 密钥
        <input type="password" autoComplete="off" value={apiKey} placeholder={keyPlaceholder} onChange={(e) => setApiKey(e.target.value)} />
      </label>
      {entry?.keyUrl && (
        <a className="small" href={entry.keyUrl} target="_blank" rel="noreferrer">
          {getLang() === 'en' ? `Get an API key from ${t(entry.name)} ↗` : `去 ${entry.name} 获取密钥 ↗`}
        </a>
      )}

      {!isBuiltin && (entry ? <details className="addp-adv"><summary className="muted small">高级设置</summary>{endpointFields}</details> : endpointFields)}

      <div className="row wrap">
        <Button size="sm" disabled={verifying || (!isBuiltin && !baseURL.trim())} onClick={() => void verify()}>
          {verifying ? '验证中…' : '验证密钥并获取模型'}
        </Button>
        {verifyOk && <span className="prov-ok">{verifyOk}</span>}
        {verifyErr && <span className="error small">{verifyErr}</span>}
      </div>

      <div className="addp-models">
        <div className="row between">
          <span className="muted small">{`已选 ${selectedOpts.length} / 共 ${list.length} 个模型`}</span>
        </div>
        <p className="muted small addp-hint">能力决定模型出现在哪些用途里，例如"识图"模型可用于图片描述。默认勾选文字和识图，不支持的请取消。</p>
        {list.length > 10 && <input aria-label="筛选模型" placeholder="筛选模型…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        <div className="addp-model-list">
          {shownModels.length === 0 && <p className="muted small pad">还没有模型。验证密钥或手动添加一个。</p>}
          {shownModels.map((m) => (
            <div key={m.id} className="row addp-model">
              <label className="row addp-model-main">
                <input type="checkbox" checked={picked.includes(m.id)} onChange={(e) => togglePick(m.id, e.target.checked)} />
                <code translate="no">{m.id}</code>
                {m.label && m.label !== m.id && <span className="muted small" translate="no">{m.label}</span>}
              </label>
              <CapsPicker caps={normalizeCaps(m.caps)} disabled={!picked.includes(m.id)} onChange={(caps) => setCaps(m.id, caps)} />
            </div>
          ))}
        </div>
        <div className="row wrap">
          <input aria-label="手动添加模型 ID" placeholder="手动添加模型 ID" value={manualId} onChange={(e) => setManualId(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addManual()} />
          <Button size="sm" onClick={addManual}>添加</Button>
        </div>
        <label>
          默认模型
          <select aria-label="默认模型" value={effDefault} disabled={selectedOpts.length === 0} onChange={(e) => setDefaultPick(e.target.value)}>
            {selectedOpts.length === 0 && <option value="">先选择模型</option>}
            {selectedOpts.map((m) => <option key={m.id} value={m.id} translate="no">{m.label ?? m.id}</option>)}
          </select>
        </label>
      </div>

      <div className="row end">
        <Button onClick={onCancel}>取消</Button>
        <Button variant="default" disabled={!canSave} onClick={submit}>添加并保存</Button>
      </div>
    </div>
  )
}
