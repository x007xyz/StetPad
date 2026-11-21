import { useEffect, useRef, useState } from 'react'
import { api, fmtTime, isDesktop, post, type ModelsResponse } from '../api'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent } from '../components/ui/dialog'
import { Select } from '../components/ui/select'
import { CAP_LABELS, type Capability, type Role } from './caps'
import { Providers } from './Providers'

interface ClipperToken {
  id: string
  name: string
  created_at: number
  last_used_at: number
}

function encodeConnectCode(payload: { url: string; token: string; mode: 'local' }): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return 'stetpad1:' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A user-registered external agent. Its args are kept as a list; the form edits them one per line. */
interface AgentRow {
  id: string
  label: string
  command: string
  args: string[]
}
type KnownAgent = NonNullable<ModelsResponse['externalAgentsAll']>[number]
interface RoleOption { id: string; label: string; price?: string }
/** One purpose from GET /model-roles. */
interface RoleRow { key: Role; label: string; value: string; effective: string | null; options: RoleOption[] }

/** Purposes with a picker in 模型分工. 'text' stays with the default provider and model selects. */
const ROLE_KEYS = ['vision', 'image', 'imageEdit', 'transcribe', 'diagram'] as const
type PickedRole = (typeof ROLE_KEYS)[number]
const ROLE_HINT: Record<PickedRole, string> = {
  vision: '图片描述、AI 看图、扫描版 PDF 识别',
  image: 'AI 生成图片',
  imageEdit: 'AI 改图',
  transcribe: '视频转文字稿和字幕',
  diagram: 'Mermaid、公式、draw.io 的 AI 生成（自动 = 跟随默认模型）',
}
/** The capability a model needs to show up for each purpose. */
const ROLE_CAP: Record<PickedRole, Capability> = { vision: 'vision', image: 'image', imageEdit: 'imageEdit', transcribe: 'audio', diagram: 'text' }

const MAX_AGENTS = 20
/** A new agent id. Matches the server's rule: lowercase letters, digits and hyphens. */
const newAgentId = (): string => 'a' + Math.random().toString(36).slice(2, 10)
const blankAgentDraft = () => ({ name: '', command: '', argsText: '' })

export function Settings({ onClose }: { onClose: () => void }) {
  const [models, setModels] = useState<ModelsResponse | null>(null)
  const [preferences, setPreferences] = useState('')
  const [model, setModel] = useState('')
  // null until /model-roles answers; rolesError says why the section is unavailable.
  const [roles, setRoles] = useState<RoleRow[] | null>(null)
  const [rolesError, setRolesError] = useState('')
  const [roleValues, setRoleValues] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [usage, setUsage] = useState<{ days: { day: string; model: string; input_tokens: number; output_tokens: number; runs: number; cost: number | null; currency: string | null }[]; totals: Record<string, number>; today: number } | null>(null)
  const [defaultProvider, setDefaultProvider] = useState('')
  const [manage, setManage] = useState(false)
  const [known, setKnown] = useState<KnownAgent[]>([])
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [agentDraft, setAgentDraft] = useState(blankAgentDraft)
  const [agentError, setAgentError] = useState('')
  const [clipperTokens, setClipperTokens] = useState<ClipperToken[]>([])
  const [connectCode, setConnectCode] = useState('')
  const [copiedCode, setCopiedCode] = useState(false)
  const [clipperError, setClipperError] = useState('')
  const [error, setError] = useState('')
  const loadSequence = useRef(0)

  const load = async (): Promise<void> => {
    const sequence = ++loadSequence.current
    const m = await api<ModelsResponse>('/models')
    if (sequence !== loadSequence.current) return
    setModels(m)
    setModel(m.default ?? '')
    setDefaultProvider(m.models.find((x) => x.id === m.default)?.provider ?? '')
    const all = m.externalAgentsAll ?? []
    setKnown(all)
    setAgents(all.filter((a) => !a.builtin).map(({ id, label, command, args }) => ({ id, label, command, args })))
    const settings = await api<{ preferences: string }>('/settings')
    if (sequence !== loadSequence.current) return
    setPreferences(settings.preferences)
    await loadRoles(sequence)
    if (sequence !== loadSequence.current) return
    const nextUsage = await api<NonNullable<typeof usage>>('/usage')
    if (sequence !== loadSequence.current) return
    setUsage(nextUsage)
    const { tokens } = await api<{ tokens: ClipperToken[] }>('/clipper/tokens')
    if (sequence !== loadSequence.current) return
    setClipperTokens(tokens)
  }
  /** Loads 模型分工. A failure only hides this section; the rest of the page keeps working. */
  const loadRoles = async (sequence: number): Promise<void> => {
    try {
      const r = await api<{ roles: RoleRow[] }>('/model-roles')
      if (sequence !== loadSequence.current) return
      setRoles(r.roles)
      setRoleValues(Object.fromEntries(r.roles.map((x) => [x.key, x.value])))
      setRolesError('')
    } catch (err) {
      if (sequence !== loadSequence.current) return
      setRoles(null)
      setRolesError(`模型分工暂时不可用${err instanceof Error ? `：${err.message}` : ''}`)
    }
  }
  useEffect(() => void load(), [])

  const save = async (): Promise<void> => {
    ++loadSequence.current
    setError('')
    try {
      // External agents are a desktop-only feature.
      const externalAgents = isDesktop ? agents : undefined
      // Sent only when the roles loaded: a blank value means automatic, so a failed load must not send them.
      const roleBody = roles ? Object.fromEntries(ROLE_KEYS.map((k) => [k, roleValues[k] ?? ''])) : undefined
      await api('/settings', { method: 'PUT', body: JSON.stringify({ preferences, model, externalAgents, ...(roleBody ? { roles: roleBody } : {}) }) })
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
      return
    }
    setSaved(true)
    await load()
  }

  const addAgent = (): void => {
    const label = agentDraft.name.trim()
    const command = agentDraft.command.trim()
    if (!label || !command) return setAgentError('请填写名称和命令')
    const args = agentDraft.argsText.split('\n').map((s) => s.trim()).filter(Boolean)
    setAgents([...agents, { id: newAgentId(), label, command, args }])
    setAgentDraft(blankAgentDraft())
    setAgentError('')
  }
  const removeAgent = (id: string): void => setAgents(agents.filter((a) => a.id !== id))
  // Built-in agents first, then the user's own. Installed state comes from the last load.
  const agentRows = [
    ...known.filter((a) => a.builtin),
    ...agents.map((a) => ({ ...a, builtin: false, installed: known.find((k) => k.id === a.id)?.installed }) as KnownAgent),
  ]

  const generateCode = async (): Promise<void> => {
    setClipperError('')
    setCopiedCode(false)
    try {
      const res = await post<{ token: string }>('/clipper/tokens', { name: '手动连接' })
      setConnectCode(encodeConnectCode({ url: location.origin, token: res.token, mode: 'local' }))
      await load()
    } catch (err) {
      setClipperError(err instanceof Error ? err.message : '生成连接码失败')
    }
  }
  const revokeClipperToken = async (tid: string): Promise<void> => {
    setClipperError('')
    try {
      await api(`/clipper/tokens/${tid}`, { method: 'DELETE' })
      await load()
    } catch (err) {
      setClipperError(err instanceof Error ? err.message : '撤销失败')
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="设置" className="panel max-w-2xl">
        <div className="row">
          <label>
            默认提供方
            <Select
              className="mt-1"
              aria-label="默认提供方"
              value={defaultProvider}
              onValueChange={(v) => {
                setDefaultProvider(v)
                setModel((models?.models ?? []).find((m) => m.provider === v)?.id ?? '')
              }}
              placeholder="没有可用的提供方"
              options={Array.from(new Map((models?.models ?? []).map((m) => [m.provider, models?.providerList?.find((p) => p.id === m.provider)?.name ?? m.provider]))).map(([value, label]) => ({ value, label }))}
            />
          </label>
          <label>
            默认模型
            <Select
              className="mt-1"
              aria-label="默认模型"
              value={model}
              onValueChange={setModel}
              placeholder="没有可用的模型"
              options={(models?.models ?? []).filter((m) => !defaultProvider || m.provider === defaultProvider).map((m) => ({ value: m.id, label: m.label + (m.verified ? '' : '（未验证）') }))}
            />
          </label>
        </div>
        <p className="muted small">"未验证"表示这个模型还没有通过编辑评测，可以用，但工具调用的可靠性没有保证。</p>
        <h3 className="sect">模型分工</h3>
        {rolesError && <p className="muted small">{rolesError}</p>}
        {roles && roles.filter((r) => (ROLE_KEYS as readonly string[]).includes(r.key)).map((r) => {
          const key = r.key as PickedRole
          // Names of every option across purposes, so the 自动 label can show the model it resolves to.
          const labelOf = (id: string): string => roles.flatMap((x) => x.options).find((o) => o.id === id)?.label ?? id
          const opts = [
            { value: '', label: '自动' + (r.effective ? `（当前：${labelOf(r.effective)}）` : '') },
            ...r.options.map((o) => ({ value: o.id, label: o.label + (o.price ? ` · ${o.price}` : '') })),
          ]
          return (
            <div key={r.key} className="role-row">
              <label>
                {r.label}
                <Select className="mt-1" aria-label={r.label} value={r.options.some((o) => o.id === roleValues[key]) ? roleValues[key]! : ''} onValueChange={(v) => setRoleValues({ ...roleValues, [key]: v })} options={opts} />
              </label>
              <p className="muted small">{ROLE_HINT[key]}</p>
              {r.options.length === 0 && <p className="muted small">{`没有可用的模型：在模型提供方里给模型勾选"${CAP_LABELS[ROLE_CAP[key]]}"能力`}</p>}
            </div>
          )
        })}
        <label>
          写作偏好
          <textarea rows={4} value={preferences} placeholder="例如：不用被动句；术语统一用“修订”而不是“更改”" onChange={(e) => setPreferences(e.target.value)} />
        </label>
        <h3 className="sect">模型提供方</h3>
        <p className="muted small">从目录添加提供方，配置密钥和可用模型，并查看余额和用量。</p>
        {models?.providerList && <p className="muted small">{`目前有 ${models.providerList.filter((p) => p.status === 'ready').length} 个提供方可用，${models.models.length} 个模型已启用。`}</p>}
        <div className="row"><Button onClick={() => setManage(true)}>管理提供方…</Button></div>
        {manage && <Providers onClose={() => setManage(false)} onChanged={() => void load()} />}
        {isDesktop && (
          <>
            <h3 className="sect">外部 Agent</h3>
            <p className="muted small">外部 Agent 是你电脑上已安装的编程助手。它们使用自己的模型、密钥和计费，对文档的修改会作为建议等你确认。命令会直接在这台电脑上运行（不经过 shell），请只添加你信任的程序。</p>
            {agentRows.length > 0 && (
              <table className="usage">
                <thead><tr><th>名称</th><th>命令</th><th>来源</th><th>状态</th><th></th></tr></thead>
                <tbody>
                  {agentRows.map((a) => (
                    <tr key={a.id}>
                      <td>{a.label}</td>
                      <td><code>{a.command}</code></td>
                      <td>{a.builtin ? '内置' : '自定义'}</td>
                      <td>{a.installed === undefined ? '保存后检测' : a.installed ? '已安装' : '未安装'}</td>
                      <td>{!a.builtin && <Button variant="link" size="sm" onClick={() => removeAgent(a.id)}>删除</Button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {agents.length < MAX_AGENTS && (
              <>
                <label>
                  名称
                  <input value={agentDraft.name} placeholder="例如：My Agent" onChange={(e) => setAgentDraft({ ...agentDraft, name: e.target.value })} />
                </label>
                <label>
                  命令
                  <input value={agentDraft.command} placeholder="例如：my-agent 或 /usr/local/bin/my-agent" onChange={(e) => setAgentDraft({ ...agentDraft, command: e.target.value })} />
                </label>
                <label>
                  参数（每行一个）
                  <textarea rows={3} value={agentDraft.argsText} placeholder={'acp'} onChange={(e) => setAgentDraft({ ...agentDraft, argsText: e.target.value })} />
                </label>
                {agentError && <p className="error">{agentError}</p>}
                <div className="row end">
                  <Button onClick={addAgent}>添加 Agent</Button>
                </div>
              </>
            )}
          </>
        )}
        <h3 className="sect">浏览器插件</h3>
        <p className="muted small">管理已连接的 Stetpad 网页剪藏插件。撤销后，对应浏览器插件需重新配对才能访问文档。</p>
        {clipperTokens.length > 0 && (
          <table className="usage">
            <thead><tr><th>名称</th><th>创建时间</th><th>最近使用</th><th></th></tr></thead>
            <tbody>
              {clipperTokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{fmtTime(t.created_at)}</td>
                  <td>{fmtTime(t.last_used_at)}</td>
                  <td><Button variant="link" size="sm" onClick={() => void revokeClipperToken(t.id)}>撤销</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row wrap" style={{ marginTop: 8 }}>
          <Button onClick={() => void generateCode()}>生成连接码</Button>
          {clipperError && <span className="error">{clipperError}</span>}
        </div>
        {connectCode && (
          <div style={{ marginTop: 8 }}>
            <div className="row">
              <input className="flex-1" readOnly value={connectCode} aria-label="插件连接码" onFocus={(e) => e.currentTarget.select()} />
              <Button onClick={() => { void navigator.clipboard.writeText(connectCode); setCopiedCode(true) }}>{copiedCode ? '已复制' : '复制'}</Button>
            </div>
            <p className="muted small" style={{ marginTop: 4 }}>连接码只显示一次，粘贴到浏览器插件即可完成绑定。</p>
          </div>
        )}
        <h3 className="sect">AI 用量</h3>
        {usage && usage.days.length === 0 && <p className="muted small">最近 30 天没有用量。</p>}
        {usage && usage.days.length > 0 && (
          <>
            <p className="muted small">{`今天已用 ${usage.today.toLocaleString()} token。`}{Object.keys(usage.totals).length > 0 && `最近 30 天估算花费：${Object.entries(usage.totals).map(([c, v]) => `${c}${v.toFixed(4)}`).join('、')}。`}</p>
            <table className="usage">
              <thead><tr><th>日期</th><th>模型</th><th>次数</th><th>输入</th><th>输出</th><th>估算花费</th></tr></thead>
              <tbody>
                {usage.days.slice(0, 20).map((d) => (
                  <tr key={d.day + d.model}><td>{d.day}</td><td>{d.model}</td><td>{d.runs}</td><td>{d.input_tokens.toLocaleString()}</td><td>{d.output_tokens.toLocaleString()}</td><td>{d.cost === null ? '-' : `${d.currency}${d.cost.toFixed(4)}`}</td></tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div className="row end">
          {error && <span className="error">{error}</span>}
          {saved && <span className="muted">已保存</span>}
          <Button onClick={onClose}>关闭</Button>
          <Button variant="default" onClick={save}>保存</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
