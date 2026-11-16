import { useEffect, useState } from 'react'
import { api, isDesktop, post, type ModelsResponse } from '../api'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent } from '../components/ui/dialog'
import { Select } from '../components/ui/select'
import { Providers } from './Providers'

/** A user-registered external agent. Its args are kept as a list; the form edits them one per line. */
interface AgentRow {
  id: string
  label: string
  command: string
  args: string[]
}
type KnownAgent = NonNullable<ModelsResponse['externalAgentsAll']>[number]

const MAX_AGENTS = 20
/** A new agent id. Matches the server's rule: lowercase letters, digits and hyphens. */
const newAgentId = (): string => 'a' + Math.random().toString(36).slice(2, 10)
const blankAgentDraft = () => ({ name: '', command: '', argsText: '' })

export function Settings({ onClose }: { onClose: () => void }) {
  const [models, setModels] = useState<ModelsResponse | null>(null)
  const [preferences, setPreferences] = useState('')
  const [model, setModel] = useState('')
  const [saved, setSaved] = useState(false)
  const [usage, setUsage] = useState<{ days: { day: string; model: string; input_tokens: number; output_tokens: number; runs: number; cost: number | null; currency: string | null }[]; totals: Record<string, number>; today: number; dailyLimit: number } | null>(null)
  const [defaultProvider, setDefaultProvider] = useState('')
  const [manage, setManage] = useState(false)
  const [cloud, setCloud] = useState<{ url: string | null; email: string | null } | null>(null)
  const [login, setLogin] = useState({ url: '', email: '', password: '' })
  const [cloudError, setCloudError] = useState('')
  const [known, setKnown] = useState<KnownAgent[]>([])
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [agentDraft, setAgentDraft] = useState(blankAgentDraft)
  const [agentError, setAgentError] = useState('')
  const [error, setError] = useState('')

  const load = async (): Promise<void> => {
    const m = await api<ModelsResponse>('/models')
    setModels(m)
    setModel(m.default ?? '')
    setDefaultProvider(m.models.find((x) => x.id === m.default)?.provider ?? '')
    const all = m.externalAgentsAll ?? []
    setKnown(all)
    setAgents(all.filter((a) => !a.builtin).map(({ id, label, command, args }) => ({ id, label, command, args })))
    setPreferences((await api<{ preferences: string }>('/settings')).preferences)
    setUsage(await api('/usage'))
    if (isDesktop) setCloud(await api('/cloud'))
  }
  useEffect(() => void load(), [])

  const save = async (): Promise<void> => {
    setError('')
    try {
      // Only the desktop app takes external agents; the web server rejects the field.
      const externalAgents = isDesktop ? agents : undefined
      await api('/settings', { method: 'PUT', body: JSON.stringify({ preferences, model, externalAgents }) })
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
        {isDesktop && cloud && (
          <>
            <h3 className="sect">云端同步</h3>
            {cloud.url ? (
              <p className="small">已登录 {cloud.email}（{cloud.url}）。在文档页点"同步到云端"即可让这篇文档在桌面和网页之间保持一致。 <Button variant="link" size="sm" onClick={async () => { await post('/cloud/logout'); await load() }}>退出云端</Button></p>
            ) : (
              <form onSubmit={async (e) => {
                e.preventDefault()
                setCloudError('')
                try {
                  await post('/cloud/login', login)
                  setLogin({ url: '', email: '', password: '' })
                  await load()
                } catch (err) {
                  setCloudError(err instanceof Error ? err.message : '登录失败')
                }
              }}>
                <p className="muted small">登录你的云端账号后，可以选择把某些文档同步上去。不同步的文档始终只在这台电脑上。</p>
                <label>云端地址<input value={login.url} placeholder="https://writer.example.com" onChange={(e) => setLogin({ ...login, url: e.target.value })} /></label>
                <label>邮箱<input type="email" value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} /></label>
                <label>密码<input type="password" autoComplete="off" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} /></label>
                {cloudError && <p className="error">{cloudError}</p>}
                <div className="row end"><Button type="submit">登录云端</Button></div>
              </form>
            )}
          </>
        )}
        <h3 className="sect">AI 用量</h3>
        {usage && usage.days.length === 0 && <p className="muted small">最近 30 天没有用量。</p>}
        {usage && usage.days.length > 0 && (
          <>
            <p className="muted small">今天已用 {usage.today.toLocaleString()} token{usage.dailyLimit ? `，每日上限 ${usage.dailyLimit.toLocaleString()}` : ''}。{Object.keys(usage.totals).length > 0 && `最近 30 天估算花费：${Object.entries(usage.totals).map(([c, v]) => `${c}${v.toFixed(4)}`).join('、')}。`}</p>
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
