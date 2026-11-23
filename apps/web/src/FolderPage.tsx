import { changesInBlock, decideAndLog, findBlock, listChanges, listDecided, projectBlocks, type DecidedChange, type PendingChange } from '@stetpad/crdt'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Editor } from '@tiptap/core'
import { editorExtensions, type EditorExtensionOptions } from './editor/extensions'
import { ExternalLink, ListChecks, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { api, collabUrl, getToken, post, streamRun, type DocMeta, type Folder, type ModelsResponse, type RunMeta } from './api'
import { go } from './App'
import { Button } from './components/ui/button'
import { Dialog, SheetContent } from './components/ui/dialog'
import { Select } from './components/ui/select'
import { Switch } from './components/ui/switch'
import { Tip, TooltipProvider } from './components/ui/tooltip'
import { getLang } from './i18n'
import { useMedia } from './lib/useMedia'
import { cn } from './lib/utils'
import { ChangesPanel, RunChanges } from './panels/Changes'
import { SidebarToggle, useWorkspaceOptional } from './Shell'

const COLORS = ['#d9480f', '#2b8a3e', '#1971c2', '#9c36b5', '#c2255c', '#087f5b']
type FolderInfo = Folder & { docs: DocMeta[] }
interface SectionState { ydoc: Y.Doc; changes: PendingChange[]; decided: DecidedChange[]; status: 'connecting' | 'connected' | 'offline' }
type Tab = 'changes' | 'ai'

/** The editor extensions for each document shown in a folder page. */
export const folderEditorExtensions = (opts: Omit<EditorExtensionOptions, 'placeholder'>) =>
  editorExtensions({ ...opts, placeholder: getLang() === 'en' ? 'Type something' : '输入内容' })

/**
 * One continuous page for all documents of a folder. Each document has its own
 * editor on its own collaboration connection, so edits are saved exactly as on
 * the single-document page.
 */
export function FolderPage({ id }: { id: string }) {
  const workspace = useWorkspaceOptional()
  const [info, setInfo] = useState<FolderInfo | null>(null)
  const [missing, setMissing] = useState(false)
  const [sections, setSections] = useState<Record<string, SectionState>>({})
  const [tracking, setTracking] = useState(false)
  const [tab, setTab] = useState<Tab>('ai')
  const [panelOpen, setPanelOpen] = useState(() => !window.matchMedia('(max-width: 1023px)').matches)
  const [force, setForce] = useState<Set<string>>(new Set())
  const narrow = useMedia('(max-width: 1023px)')
  const page = useRef<HTMLElement>(null)
  const trackingRef = useRef(false)
  trackingRef.current = tracking
  const author = '我'
  const loadSequence = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequence.current
    try {
      const f = await api<FolderInfo>(`/folders/${id}`)
      if (sequence !== loadSequence.current) return
      setInfo(f)
      document.title = f.name
    } catch {
      if (sequence !== loadSequence.current) return
      setMissing(true)
    }
  }, [id])
  // Reload when documents are moved in or out from the sidebar.
  useEffect(() => {
    void load()
    return () => { ++loadSequence.current }
  }, [load, workspace?.docs])

  const onSection = useCallback((docId: string, s: SectionState): void => setSections((cur) => ({ ...cur, [docId]: s })), [])

  const ids = info?.docs.map((d) => d.id) ?? []
  const all = ids.flatMap((d) => (sections[d] ? [{ docId: d, ...sections[d]! }] : []))
  const changes = all.flatMap((s) => s.changes)
  const decided = all.flatMap((s) => s.decided)
  const docOfChange = (cid: string): string | undefined => all.find((s) => s.changes.some((c) => c.id === cid))?.docId
  const statuses = all.map((s) => s.status)
  const status = statuses.includes('offline') ? 'offline' : statuses.length < ids.length || statuses.includes('connecting') ? 'connecting' : 'connected'

  const decideMany = useCallback((cids: string[], d: 'accept' | 'reject'): void => {
    for (const s of all) {
      const mine = cids.filter((c) => s.changes.some((x) => x.id === c))
      if (!mine.length) continue
      const text = (bid: string): string => projectBlocks(s.ydoc, 'physical').find((b) => b.blockId === bid)?.text ?? ''
      decideAndLog(s.ydoc, listChanges(s.ydoc), mine, d, text)
    }
  }, [all])
  const blockText = useCallback((bid: string): string => {
    for (const s of all) {
      const t = projectBlocks(s.ydoc, 'physical').find((b) => b.blockId === bid)
      if (t) return t.text
    }
    return ''
  }, [all])

  const focusChange = (cid: string): void => {
    const docId = docOfChange(cid)
    if (!docId) return
    setForce((f) => new Set(f).add(docId))
    if (narrow) setPanelOpen(false)
    const s = sections[docId]!
    setTimeout(() => {
      const root = page.current?.querySelector(`[data-doc-id="${docId}"]`)
      const el = root?.querySelector(`[data-change="${cid}"]`) ??
        [...(root?.querySelectorAll('.tc-block-ins, .tc-block-del') ?? [])].find((b) => {
          const y = findBlock(s.ydoc, b.getAttribute('data-block-id') ?? '')
          return y && changesInBlock(s.ydoc, y).includes(cid)
        }) ?? root
      if (!el) return
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add('flash')
      setTimeout(() => el.classList.remove('flash'), 1200)
    }, 120)
  }

  const scrollToDoc = (docId: string): void => {
    setForce((f) => new Set(f).add(docId))
    page.current?.querySelector(`[data-doc-id="${docId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const rename = async (input: HTMLInputElement): Promise<void> => {
    const name = input.value
    if (!info) return
    if (!name.trim() || name.trim() === info.name) {
      input.value = info.name
      return
    }
    try {
      await api(`/folders/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
    } catch {
      input.value = info.name
      workspace?.notify('文件夹名称保存失败，请重试。', { error: true })
      return
    }
    setInfo({ ...info, name: name.trim() })
    document.title = name.trim()
    void workspace?.reload()
  }

  if (missing) {
    return (
      <div className="center">
        <div className="flex flex-col items-center gap-3 rounded-xl border border-border p-6">
          <p>找不到这个文件夹，或者你没有权限打开它。</p>
          <Button onClick={() => go({ page: 'home' })}>返回文档列表</Button>
        </div>
      </div>
    )
  }

  const panel = (
    <div className="panel flex min-h-0 flex-1 flex-col">
      {tab === 'changes' && <ChangesPanel changes={changes} blockText={blockText} onDecide={decideMany} onFocus={focusChange} />}
      {tab === 'ai' && <FolderAi folderId={id} changes={changes} decided={decided} blockText={blockText} onDecide={decideMany} onFocus={focusChange} disabled={ids.length === 0} />}
    </div>
  )
  const buttons: [Tab, string, typeof Sparkles, number | boolean][] = [['changes', '修订', ListChecks, changes.length], ['ai', 'AI', Sparkles, false]]

  return (
    <TooltipProvider>
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-background px-3 py-1.5">
          <SidebarToggle />
          <input className="min-w-0 flex-1 basis-40 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-semibold outline-none hover:bg-accent focus:border-ring focus:bg-background" aria-label="文件夹名称"
            defaultValue={info?.name ?? ''} key={info?.name} onBlur={(e) => rename(e.currentTarget)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className={cn('size-1.5 rounded-full', status === 'connected' ? 'bg-emerald-500' : status === 'connecting' ? 'bg-amber-400' : 'bg-orange-500')} />
            <span role="status" className="max-sm:sr-only">{status === 'connected' ? '已同步' : status === 'connecting' ? '连接中…' : '离线，修改已保存在本机'}</span>
          </span>
          <label className="flex cursor-pointer items-center gap-1.5 text-[13px]">
            <Switch checked={tracking} onCheckedChange={setTracking} aria-label="修订模式" />
            <span>修订模式</span>
          </label>
          <div role="group" aria-label="侧边面板" className="flex items-center gap-0.5">
            {buttons.map(([t, label, Icon, badge]) => {
              const active = panelOpen && tab === t
              return (
                <Tip key={t} text={active ? `收起${label}` : label}>
                  <Button variant="ghost" size="icon" className={'relative size-7 ' + (active ? 'bg-secondary' : 'text-muted-foreground')} aria-label={label} aria-pressed={active} onClick={() => { if (active) setPanelOpen(false); else { setTab(t); setPanelOpen(true) } }}>
                    <Icon />
                    {typeof badge === 'number' && badge > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 text-primary-foreground">{badge}</span>}
                  </Button>
                </Tip>
              )
            })}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <main className="page" ref={page}>
            <div className="mx-auto w-full max-w-[720px] px-5 pt-8 sm:px-10">
              <h1 translate="no" className="text-3xl font-bold tracking-tight">{info?.name ?? ''}</h1>
              {info && info.docs.length === 0 && <p className="muted mt-4">这个文件夹还是空的。把侧栏里的文档拖进来，或用文档旁的“移动到…”。</p>}
              {info && info.docs.length > 0 && (
                <nav aria-label="文件夹大纲" className="mt-4 rounded-lg border border-border bg-secondary/40 px-4 py-3">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">{`共 ${info.docs.length} 篇`}</div>
                  <ol className="m-0 list-decimal pl-5 text-sm">
                    {info.docs.map((d) => {
                      const n = sections[d.id]?.changes.length ?? 0
                      return (
                        <li key={d.id} className="py-0.5">
                          <button translate="no" className="text-left hover:underline" onClick={() => scrollToDoc(d.id)}>{d.title}</button>
                          {n > 0 && <span className="ml-2 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">{`${n} 处修订`}</span>}
                        </li>
                      )
                    })}
                  </ol>
                </nav>
              )}
            </div>
            {info?.docs.map((d, i) => (
              <DocSection key={d.id} doc={d} first={i === 0} author={author} trackingRef={trackingRef} force={force.has(d.id)} onState={onSection}
                onRenamed={() => { void load(); void workspace?.reload() }} />
            ))}
            <div className="h-40" />
          </main>
          {!narrow && panelOpen && (
            <aside className="relative flex w-[360px] shrink-0 flex-col border-l border-border bg-background" aria-label="面板">{panel}</aside>
          )}
        </div>
        {narrow && (
          <Dialog open={panelOpen} onOpenChange={setPanelOpen}>
            <SheetContent side="bottom" title="面板">{panel}</SheetContent>
          </Dialog>
        )}
      </div>
    </TooltipProvider>
  )
}

/** One document of the folder: its title, a divider, and an editor on its own connection. */
function DocSection({ doc, first, author, trackingRef, force, onState, onRenamed }: {
  doc: DocMeta
  first: boolean
  author: string
  trackingRef: React.MutableRefObject<boolean>
  force: boolean
  onState: (docId: string, s: SectionState) => void
  onRenamed: () => void
}) {
  const id = doc.id
  const workspace = useWorkspaceOptional()
  const ydoc = useMemo(() => new Y.Doc(), [id])
  const [ready, setReady] = useState(false)
  const [near, setNear] = useState(false)
  const root = useRef<HTMLElement>(null)
  const mount = useRef<HTMLDivElement>(null)
  const providerRef = useRef<HocuspocusProvider | null>(null)
  const status = useRef<SectionState['status']>('connecting')
  const report = useRef<() => void>(() => {})
  const onStateRef = useRef(onState)
  onStateRef.current = onState

  // The connection is opened for every document, so pending changes show up in the panel;
  // only the editor waits until the section is near the screen.
  useEffect(() => {
    const local = new IndexeddbPersistence(`aiw-${id}`, ydoc)
    let timer: ReturnType<typeof setTimeout> | null = null
    const push = (): void => onStateRef.current(id, { ydoc, changes: listChanges(ydoc), decided: listDecided(ydoc), status: status.current })
    report.current = push
    const provider = new HocuspocusProvider({
      url: collabUrl(),
      name: id,
      document: ydoc,
      token: getToken(),
      onSynced: () => { setReady(true); push() },
      onStatus: ({ status: s }) => { status.current = s === 'connected' ? 'connected' : s === 'connecting' ? 'connecting' : 'offline'; push() },
    })
    providerRef.current = provider
    const onTx = (): void => {
      if (timer) return
      timer = setTimeout(() => { timer = null; push() }, 60)
    }
    ydoc.on('afterTransaction', onTx)
    push()
    return () => {
      ydoc.off('afterTransaction', onTx)
      if (timer) clearTimeout(timer)
      provider.destroy()
      void local.destroy()
      ydoc.destroy()
    }
  }, [id, ydoc])

  useEffect(() => {
    const el = root.current
    if (!el || near) return
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) setNear(true) }, { rootMargin: '600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [near])

  const visible = near || force
  const editorRef = useRef<Editor | null>(null)
  useEffect(() => {
    if (!ready || !visible || !mount.current) return
    const editor = new Editor({
      element: mount.current,
      extensions: folderEditorExtensions({
        ydoc, docId: id,
        onError: (text) => workspace?.notify(text, { error: true }),
        user: () => ({ author, tracking: trackingRef.current }),
        caret: providerRef.current ? { provider: providerRef.current, user: { name: author, color: COLORS[Math.floor(Math.random() * COLORS.length)]! } } : undefined,
      }),
      editorProps: { attributes: { class: 'prose', spellcheck: 'false' } },
    })
    editorRef.current = editor
    report.current()
    return () => {
      editor.destroy()
      editorRef.current = null
    }
  }, [ready, visible, ydoc, author, trackingRef])

  const rename = async (input: HTMLInputElement): Promise<void> => {
    const title = input.value.trim() || '未命名文档'
    if (title === doc.title) {
      input.value = title
      return
    }
    try {
      await api(`/docs/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) })
    } catch {
      input.value = doc.title
      workspace?.notify('标题保存失败，请重试。', { error: true })
      return
    }
    onRenamed()
  }

  return (
    <section ref={root} data-doc-id={id} className={cn('mx-auto w-full max-w-[720px] px-5 sm:px-10', !first && 'mt-10')} aria-labelledby={`doc-title-${id}`}>
      <hr className="mb-4 mt-8 border-border" />
      <div className="flex items-center gap-2">
        <input id={`doc-title-${id}`} className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-2xl font-bold tracking-tight outline-none hover:bg-accent focus:border-ring focus:bg-background" aria-label={`文档标题：${doc.title}`}
          defaultValue={doc.title} key={doc.title} onBlur={(e) => rename(e.currentTarget)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <Tip text="在单独页面中打开"><Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" aria-label={`单独打开 ${doc.title}`} onClick={() => go({ page: 'doc', id })}><ExternalLink /></Button></Tip>
      </div>
      {!visible && <p className="muted py-6">滚动到这里时加载内容…</p>}
      {visible && !ready && <p className="muted py-6">正在打开文档…</p>}
      <div ref={mount} className="[&_.prose]:min-h-24 [&_.prose]:max-w-none [&_.prose]:px-0 [&_.prose]:pb-4 [&_.prose]:pt-3" />
    </section>
  )
}

interface Live { runId: string; title: string; steps: { detail: string; ok?: boolean; error?: string; notApplied?: number }[]; text: string; status: string; error?: string; question?: string }
const STATUS: Record<string, string> = { running: '进行中', done: '完成', cancelled: '已取消', error: '出错', interrupted: '已中断', 'step-limit': '达到步数上限，未完成', truncated: '输出被截断', refused: '模型拒绝了请求' }

/**
 * The AI chat of a folder: a message goes out with every document of the folder
 * as its scope. Changes come back as pending suggestions in the documents.
 */
function FolderAi({ folderId, changes, decided, blockText, onDecide, onFocus, disabled }: {
  folderId: string
  changes: PendingChange[]
  decided: DecidedChange[]
  blockText: (id: string) => string
  onDecide: (ids: string[], d: 'accept' | 'reject') => void
  onFocus: (id: string) => void
  disabled: boolean
}) {
  const [models, setModels] = useState<ModelsResponse | null>(null)
  const [model, setModel] = useState('')
  const [history, setHistory] = useState<RunMeta[]>([])
  const [live, setLive] = useState<Live | null>(null)
  const [error, setError] = useState('')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const end = useRef<HTMLDivElement>(null)

  const loadHistory = useCallback(async () => {
    const r = await api<{ active: string | null; runs: RunMeta[] }>(`/folders/${folderId}/runs`)
    setHistory(r.runs)
    return r
  }, [folderId])

  const attach = useCallback((runId: string, title: string) => {
    abort.current?.abort()
    const ac = new AbortController()
    abort.current = ac
    setLive({ runId, title, steps: [], text: '', status: 'running' })
    void streamRun(runId, (type, d) => {
      setLive((cur) => {
        if (!cur || cur.runId !== runId) return cur
        const next = { ...cur }
        if (type === 'text.delta') next.text += String(d.text ?? '')
        else if (type === 'step.started') next.steps = [...cur.steps, { detail: String(d.detail ?? d.tool) }]
        else if (type === 'step.finished') {
          const i = cur.steps.findLastIndex((s) => s.ok === undefined)
          if (i >= 0) next.steps = cur.steps.map((s, k) => (k === i ? { ...s, ok: d.ok !== false, error: d.error as string | undefined, notApplied: Number(d.notApplied ?? 0) } : s))
        } else if (type === 'run.error') next.error = String(d.message ?? '')
        else if (type === 'ask.user') next.question = String(d.question ?? '')
        else if (type === 'run.finished') next.status = String(d.status ?? 'done')
        return next
      })
    }, ac.signal).then(async () => {
      if (ac.signal.aborted) return
      await loadHistory().catch(() => {})
      setLive((cur) => (cur && cur.runId === runId && cur.status === 'running' ? { ...cur, status: 'interrupted' } : cur))
    })
  }, [loadHistory])

  useEffect(() => {
    void api<ModelsResponse>('/models').then((m) => { setModels(m); setModel(m.default ?? '') })
    void loadHistory().then((r) => {
      if (r.active && r.active !== 'starting') attach(r.active, r.runs.find((x) => x.id === r.active)?.instruction || 'AI 任务')
    }).catch(() => {})
    return () => abort.current?.abort()
  }, [loadHistory, attach])
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' })
  }, [live, history.length])

  const running = live?.status === 'running'
  const noModel = models !== null && models.models.length === 0
  const canSend = !!input.trim() && !noModel && !running && !disabled && !sending
  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!canSend) return
    setSending(true)
    setError('')
    try {
      const { runId } = await post<{ runId: string }>(`/folders/${folderId}/runs`, { instruction: text, modelId: model || undefined })
      setInput('')
      attach(runId, text)
    } catch (e) {
      setError(e instanceof Error ? e.message : '启动失败')
    } finally {
      setSending(false)
    }
  }
  const past = history.filter((r) => r.id !== live?.runId)
  const review = (runId: string) => (
    <RunChanges decided={decided.filter((c) => c.runId === runId)} changes={changes.filter((c) => c.runId === runId)} blockText={blockText} onDecide={onDecide} onFocus={onFocus} />
  )

  return (
    <div className="ai">
      <div className="panel-header-content ai-log">
        {past.length === 0 && !live && (
          <p className="muted pad">
            这里的 AI 能阅读并修改这个文件夹里的全部文档，例如"统一各篇的语气""检查前后的术语是否一致"。修改会以修订的形式出现在对应文档里，由你逐条确认。
          </p>
        )}
        {past.map((r) => (
          <div key={r.id} className="turn">
            <div className="ask" translate="no">{r.instruction}</div>
            <div className="answer"><span className="avatar" aria-hidden>AI</span><div className="answer-body">{r.summary ? <span translate="no">{r.summary}</span> : (STATUS[r.status] || r.status)}</div></div>
            {r.status !== 'done' && <div className="muted small">{STATUS[r.status] ?? r.status}</div>}
            {review(r.id)}
          </div>
        ))}
        {live && (
          <div className="turn">
            <div className="ask" translate="no">{live.title}</div>
            {live.steps.length > 0 && (
              <ul className="steps">
                {live.steps.map((s, i) => (
                  <li key={i} data-ok={s.ok === undefined ? 'pending' : String(s.ok)}>
                    {s.detail}
                    {s.ok === false && <span className="error">　失败：{s.error}</span>}
                    {!!s.notApplied && <span className="warn">{`　${s.notApplied} 处未应用（文字已被改动）`}</span>}
                  </li>
                ))}
              </ul>
            )}
            {live.text && <div className="answer"><span className="avatar" aria-hidden>AI</span><div className="answer-body" translate="no">{live.text}</div></div>}
            {live.question && <div className="question" role="alert">AI 想问你：<span translate="no">{live.question}</span><div className="muted small">直接在下面回复即可。</div></div>}
            {live.error && <div className="error">{live.error}</div>}
            <div className="status-line small" role="status" data-status={live.status}>{live.status === 'running' && <span className="dot" />}{STATUS[live.status] ?? live.status}</div>
            {review(live.runId)}
          </div>
        )}
        <div ref={end} />
      </div>
      {error && <p className="error pad">{error}</p>}
      {noModel && <p className="error pad">没有可用的模型。请在"设置"里填写模型密钥。</p>}
      <div className="ai-input">
        <textarea
          rows={2}
          value={input}
          disabled={disabled}
          aria-label="给文件夹里的 AI 的指令"
          placeholder={disabled ? '没有可编辑的文档' : '让 AI 处理整个文件夹…（Enter 发送）'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <div className="row between">
          <Select className="max-w-[200px]" size="sm" aria-label="模型" value={model} onValueChange={setModel} options={(models?.models ?? []).map((m) => ({ value: m.id, label: m.label + (m.verified ? '' : '（未验证）') }))} />
          {running
            ? <Button size="sm" onClick={() => void post(`/runs/${live!.runId}/cancel`)}>停止</Button>
            : <Button size="sm" variant="default" disabled={!canSend} onClick={() => void send()}>发送</Button>}
        </div>
      </div>
    </div>
  )
}
