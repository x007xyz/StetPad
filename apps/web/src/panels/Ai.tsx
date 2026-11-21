import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, post, streamRun, type ModelsResponse, type RunMeta } from '../api'
import { Button } from '../components/ui/button'
import { confirmAction } from '../components/confirm'
import type { CommentView, DecidedChange, PendingChange } from '@stetpad/crdt'
import { ArrowUp, ChevronDown, MessageSquare, Pencil, Pilcrow, Plus, Square, TextQuote, Trash2, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import { Tip } from '../components/ui/tooltip'
import { RunChanges } from './Changes'
import { Select } from '../components/ui/select'
import { fmtDate } from '../i18n'

/** Something the user attached to a message: a paragraph, a comment, or selected text. */
export interface ContextItem { id: string; kind: 'block' | 'comment' | 'text'; label: string; text: string; blockIds: string[] }
export interface RunRequest { instruction?: string; preset?: string; selection?: { blockIds: string[]; text?: string }; context?: ContextItem[] }
const KIND_NAME = { block: '段落', comment: '评论', text: '选中文字' } as const
const clip1 = (s: string, n: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }
export const makeLabel = (text: string): string => clip1(text, 24)
interface Live {
  runId: string
  title: string
  steps: { tool: string; detail: string; ok?: boolean; error?: string; notApplied?: number }[]
  plan: { title: string; status: string }[]
  text: string
  status: string
  error?: string
  question?: string
  note?: string
}

const STATUS: Record<string, string> = {
  running: '进行中', done: '完成', cancelled: '已取消', error: '出错', interrupted: '已中断',
  'step-limit': '达到步数上限，未完成', truncated: '输出被截断', refused: '模型拒绝了请求',
}

export interface ChatMeta { id: string; title: string; created_at: number; updated_at: number; runs: number }
const chatKey = (docId: string): string => 'aiw.chat.' + docId
const readLastChat = (docId: string): string | null => {
  try {
    return localStorage.getItem(chatKey(docId))
  } catch {
    return null
  }
}
const writeLastChat = (docId: string, id: string | null): void => {
  try {
    if (id) localStorage.setItem(chatKey(docId), id)
    else localStorage.removeItem(chatKey(docId))
  } catch {
    /* storage unavailable */
  }
}

/** Runs for one document: its chats, the history and live run of each, and how to start or cancel one. */
export function useRuns(docId: string, onFinished: () => void, enabled = true) {
  const [models, setModels] = useState<ModelsResponse | null>(null)
  const [model, setModel] = useState('')
  const [chats, setChats] = useState<ChatMeta[]>([])
  const [chatId, setChatId] = useState<string | null>(null)
  const [history, setHistory] = useState<RunMeta[]>([])
  const [knownRunIds, setKnownRunIds] = useState<string[]>([])
  /** The live run of every chat that has one: switching chats leaves a running one running. */
  const [lives, setLives] = useState<Record<string, Live>>({})
  const [error, setError] = useState('')
  /** `builtin`, or the id of an external agent on this machine. */
  const [engine, setEngine] = useState('builtin')
  const aborts = useRef(new Map<string, AbortController>())
  const finished = useRef(onFinished)
  finished.current = onFinished
  const current = useRef<string | null>(null)
  current.current = chatId
  const live = chatId ? (lives[chatId] ?? null) : null

  const patchLive = useCallback((cid: string, f: (cur: Live) => Live) => {
    setLives((all) => (all[cid] ? { ...all, [cid]: f(all[cid]!) } : all))
  }, [])

  const loadChats = useCallback(async () => {
    const r = await api<{ chats: ChatMeta[] }>(`/docs/${docId}/chats`)
    setChats(r.chats)
    return r.chats
  }, [docId])

  const loadHistory = useCallback(async (cid: string | null) => {
    if (!cid) {
      setHistory([])
      return null
    }
    const r = await api<{ active: string | null; activeChat: string | null; knownRunIds: string[]; runs: RunMeta[] }>(`/docs/${docId}/runs?chat=${cid}`)
    if (current.current === cid) {
      setHistory(r.runs)
      setKnownRunIds(r.knownRunIds)
    }
    return r
  }, [docId])

  const attach = useCallback((cid: string, runId: string, title: string) => {
    aborts.current.get(cid)?.abort()
    const ac = new AbortController()
    aborts.current.set(cid, ac)
    setLives((all) => ({ ...all, [cid]: { runId, title, steps: [], plan: [], text: '', status: 'running' } }))
    void streamRun(runId, (type, d) => {
      patchLive(cid, (cur) => {
        if (cur.runId !== runId) return cur
        const next = { ...cur }
        if (type === 'text.delta') next.text += String(d.text ?? '')
        else if (type === 'step.started') next.steps = [...cur.steps, { tool: String(d.tool), detail: String(d.detail ?? d.tool) }]
        else if (type === 'step.finished') {
          const i = cur.steps.map((s) => s.tool).lastIndexOf(String(d.tool))
          if (i >= 0) next.steps = cur.steps.map((s, k) => (k === i ? { ...s, ok: d.ok !== false, error: d.error as string | undefined, notApplied: Number(d.notApplied ?? 0) } : s))
        } else if (type === 'plan.updated') next.plan = (d.steps as Live['plan']) ?? []
        else if (type === 'run.error') next.error = String(d.message ?? '')
        else if (type === 'ask.user') next.question = String(d.question ?? '')
        else if (type === 'run.fallback') next.note = `首选模型出错，已改用备用模型（${String(d.to ?? '')}）`
        else if (type === 'run.finished') next.status = String(d.status ?? 'done')
        return next
      })
    }, ac.signal).then(async () => {
      if (ac.signal.aborted) return
      await Promise.all([loadHistory(current.current), loadChats()]).catch(() => {})
      patchLive(cid, (cur) => (cur.runId === runId && cur.status === 'running' ? { ...cur, status: 'interrupted' } : cur))
      finished.current()
    })
  }, [loadHistory, loadChats, patchLive])

  useEffect(() => {
    if (!enabled) return
    let stale = false
    const ctl = aborts.current
    void api<ModelsResponse>('/models').then((m) => {
      setModels(m)
      setModel(m.default ?? '')
    })
    setChatId(null)
    setHistory([])
    setLives({})
    void (async () => {
      const list = await loadChats()
      if (stale) return
      const last = readLastChat(docId)
      const pick = (last && list.some((c) => c.id === last) ? last : list[0]?.id) ?? null
      current.current = pick
      setChatId(pick)
      const r = await loadHistory(pick)
      // A run started earlier (even from a page that was closed) is picked up again, in the chat it belongs to.
      const all = await api<{ active: string | null; activeChat: string | null; runs: RunMeta[] }>(`/docs/${docId}/runs${r?.activeChat ? `?chat=${r.activeChat}` : ''}`)
      if (stale || !all.active || all.active === 'starting' || !all.activeChat) return
      attach(all.activeChat, all.active, all.runs.find((x) => x.id === all.active)?.instruction || 'AI 任务')
    })().catch(() => {})
    return () => {
      stale = true
      for (const ac of ctl.values()) ac.abort()
      ctl.clear()
    }
  }, [docId, loadChats, loadHistory, attach, enabled])

  const selectChat = useCallback((id: string | null) => {
    current.current = id
    setChatId(id)
    writeLastChat(docId, id)
    setError('')
    setHistory([])
    void loadHistory(id).catch(() => {})
  }, [docId, loadHistory])

  const newChat = useCallback(async (select = true): Promise<string | null> => {
    // An empty chat is reused instead of piling up blank ones.
    const blank = chats.find((c) => c.runs === 0 && !lives[c.id])
    if (blank) {
      if (select) selectChat(blank.id)
      return blank.id
    }
    try {
      const { chat } = await post<{ chat: ChatMeta }>(`/docs/${docId}/chats`, {})
      setChats((cur) => [chat, ...cur])
      if (select) selectChat(chat.id)
      return chat.id
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建对话失败')
      return null
    }
  }, [docId, chats, lives, selectChat])

  const renameChat = useCallback(async (id: string, title: string) => {
    try {
      await api(`/chats/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) })
      setChats((cur) => cur.map((c) => (c.id === id ? { ...c, title } : c)))
    } catch (e) {
      setError(e instanceof Error ? e.message : '重命名失败')
    }
  }, [])

  const deleteChat = useCallback(async (id: string) => {
    try {
      await api(`/chats/${id}`, { method: 'DELETE' })
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
      return
    }
    aborts.current.get(id)?.abort()
    aborts.current.delete(id)
    setLives((all) => {
      const { [id]: _gone, ...rest } = all
      return rest
    })
    const rest = chats.filter((c) => c.id !== id)
    setChats(rest)
    if (current.current === id) {
      selectChat(rest[0]?.id ?? null)
    } else void loadHistory(current.current).catch(() => {})
    finished.current()
  }, [chats, selectChat, loadHistory])

  /** An external agent (ACP): started here, then polled until it ends. */
  const startExternal = useCallback(async (cid: string, agentId: string, prompt: string, onStarted: () => void) => {
    aborts.current.get(cid)?.abort()
    const ac = new AbortController()
    aborts.current.set(cid, ac)
    const { id } = await post<{ id: string }>(`/docs/${docId}/external-runs`, { agent: agentId, prompt })
    const put = (l: Live): void => setLives((all) => ({ ...all, [cid]: l }))
    put({ runId: 'ext:' + id, title: prompt, steps: [], plan: [], text: '', status: 'running' })
    onStarted()
    while (!ac.signal.aborted) {
      await new Promise((r) => setTimeout(r, 700))
      const r = await api<{ status: string; text: string; steps: string[]; error?: string; agent: string }>(`/external-runs/${id}`).catch(() => null)
      if (!r) continue
      put({ runId: 'ext:' + id, title: prompt, plan: [], steps: r.steps.map((t) => ({ tool: t, detail: t, ok: true })), text: r.text, status: r.status, error: r.error, note: `由外部 Agent「${r.agent}」执行，使用它自己的模型和密钥` })
      if (r.status !== 'running') break
    }
    finished.current()
  }, [docId])

  const start = useCallback(async (req: RunRequest, title: string, onStarted?: () => void) => {
    setError('')
    try {
      let cid = current.current
      if (!cid) {
        cid = await newChat(false)
        if (!cid) return
      }
      const started = (): void => {
        if (!current.current) selectChat(cid)
        onStarted?.()
      }
      if (engine !== 'builtin' && !req.preset && !req.selection && req.instruction) return await startExternal(cid, engine, req.instruction, started)
      const { runId } = await post<{ runId: string }>(`/docs/${docId}/runs`, { ...req, chatId: cid, modelId: model || undefined })
      attach(cid, runId, title)
      started()
      void loadChats().catch(() => {})
    } catch (e) {
      setError(e instanceof Error ? e.message : '启动失败')
    }
  }, [docId, model, attach, engine, startExternal, newChat, loadChats, selectChat])

  const cancel = useCallback(() => {
    if (live?.status !== 'running') return
    void post(live.runId.startsWith('ext:') ? `/external-runs/${live.runId.slice(4)}/cancel` : `/runs/${live.runId}/cancel`)
  }, [live])

  const runningChat = Object.entries(lives).find(([, l]) => l.status === 'running')?.[0] ?? null
  return {
    models, model, setModel, history, live, error, start, cancel, running: live?.status === 'running', engine, setEngine,
    chats, chatId, selectChat, newChat, renameChat, deleteChat, knownRunIds,
    /** Another chat of this document is busy: the document takes one AI task at a time. */
    busyElsewhere: runningChat !== null && runningChat !== chatId,
    runningChat,
  }
}

/** The text typed but not yet sent, kept per chat so switching chats, panels or documents does not lose it. */
const drafts = new Map<string, string>()
export const draftKey = (docId: string, chatId: string | null): string => (chatId ? 'chat.' + chatId : docId)
const readDraft = (key: string): string => {
  const mem = drafts.get(key)
  if (mem !== undefined) return mem
  try {
    return localStorage.getItem('aiw.draft.' + key) ?? ''
  } catch {
    return ''
  }
}
const writeDraft = (key: string, v: string): void => {
  drafts.set(key, v)
  try {
    if (v) localStorage.setItem('aiw.draft.' + key, v)
    else localStorage.removeItem('aiw.draft.' + key)
  } catch {
    /* storage unavailable */
  }
}

export const ago = (t: number): string => {
  const m = Math.floor((Date.now() - t) / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  if (m < 1440) return `${Math.floor(m / 60)} 小时前`
  return fmtDate(t)
}

/** The chat picker at the top of the panel: switch, start, rename and delete conversations. */
function ChatBar({ runs }: { runs: ReturnType<typeof useRuns> }) {
  const { chats, chatId, selectChat, newChat, renameChat, deleteChat } = runs
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const cur = chats.find((c) => c.id === chatId)
  const label = (c?: ChatMeta): string => c?.title || '新对话'
  const requestDelete = async (chat: ChatMeta): Promise<void> => {
    if (await confirmAction({
      title: `删除对话"${label(chat)}"？`,
      body: '文档内容和待确认的修改不会受影响。',
      confirmLabel: '删除',
      danger: true,
    })) await deleteChat(chat.id)
  }
  const commit = (id: string): void => {
    const t = name.trim()
    setEditing(null)
    if (t && t !== chats.find((c) => c.id === id)?.title) void renameChat(id, t)
  }
  return (
    <div className="chat-bar">
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null) }}>
        <PopoverTrigger asChild>
          <button className="chat-current" aria-label="切换对话" title={label(cur)}>
            <span className="chat-title">{label(cur)}</span>
            <ChevronDown className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="chat-menu">
          {chats.length === 0 && <div className="muted small pad">还没有对话</div>}
          <ul>
            {chats.map((c) => (
              <li key={c.id} data-active={c.id === chatId}>
                {editing === c.id ? (
                  <input
                    className="chat-rename"
                    autoFocus
                    value={name}
                    maxLength={80}
                    aria-label="对话标题"
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => commit(c.id)}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return
                      if (e.key === 'Enter') commit(c.id)
                      else if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                ) : (
                  <>
                    <button className="chat-pick" onClick={() => { selectChat(c.id); setOpen(false) }}>
                      <span className="chat-title">{label(c)}</span>
                      <span className="muted small">{ago(c.updated_at)}</span>
                    </button>
                    <button className="chat-act" aria-label="重命名" title="重命名" onClick={() => { setName(c.title); setEditing(c.id) }}><Pencil className="size-3.5" /></button>
                    <button className="chat-act" aria-label="删除对话" title="删除对话" onClick={() => void requestDelete(c)}><Trash2 className="size-3.5" /></button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
      <Button size="sm" variant="ghost" className="chat-new" onClick={() => { setOpen(false); void newChat() }}><Plus className="size-3.5" />新对话</Button>
    </div>
  )
}

export function AiPanel({ docId, runs, changes, decided, blockText, onDecide, onFocus, refs, setRefs, comments, listBlocks, focusSignal }: {
  docId: string
  runs: ReturnType<typeof useRuns>
  changes: PendingChange[]
  decided: DecidedChange[]
  blockText: (id: string) => string
  onDecide: (ids: string[], d: 'accept' | 'reject') => void
  onFocus: (id: string) => void
  refs: ContextItem[]
  setRefs: (f: (cur: ContextItem[]) => ContextItem[]) => void
  comments: CommentView[]
  listBlocks: () => { blockId: string; text: string }[]
  focusSignal: number
}) {
  const [menu, setMenu] = useState<{ query: string; at: number; index: number } | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const changesOf = (runId: string): PendingChange[] => changes.filter((c) => c.runId === runId)
  const review = (runId: string) => (
    <RunChanges decided={decided.filter((c) => c.runId === runId)} changes={changesOf(runId)} blockText={blockText} onDecide={onDecide} onFocus={onFocus} />
  )
  const dkey = draftKey(docId, runs.chatId)
  const [input, setInputState] = useState(() => readDraft(dkey))
  const [inputKey, setInputKey] = useState(dkey)
  // Each chat keeps its own unsent text.
  if (inputKey !== dkey) {
    setInputKey(dkey)
    setInputState(readDraft(dkey))
    setMenu(null)
  }
  const setInput = (v: string | ((cur: string) => string)): void => {
    setInputState((cur) => {
      const next = typeof v === 'function' ? v(cur) : v
      writeDraft(dkey, next)
      return next
    })
  }
  const { models, model, setModel, history, live, error, start, cancel, running, engine, setEngine, busyElsewhere, knownRunIds } = runs
  const [sending, setSending] = useState(false)
  const noModel = models !== null && models.models.length === 0 && engine === 'builtin'
  const canSend = !!input.trim() && !noModel && !running && !busyElsewhere && !sending
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Braces matter: newer browsers return a promise from scrollIntoView, and an effect must not return one.
    end.current?.scrollIntoView({ block: 'nearest' })
  }, [live, history.length])

  const send = (): void => {
    const text = input.trim()
    if (!canSend) return
    setSending(true)
    const context = refs
    const title = context.length ? `${text}\n${context.map((r) => `「${KIND_NAME[r.kind]}：${r.label}」`).join(' ')}` : text
    void start({ instruction: text, context: context.length ? context : undefined }, title, () => {
      setInput('')
      setMenu(null)
      setRefs((cur) => cur.filter((r) => !context.includes(r)))
      setSending(false)
    }).finally(() => setSending(false))
  }

  useEffect(() => {
    if (focusSignal > 0) area.current?.focus()
  }, [focusSignal])

  // Auto-grow the input with its content; CSS caps it (max-height) and scrolls beyond that.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [input])

  const options = (() => {
    if (!menu) return []
    const q = menu.query.toLowerCase()
    const cs = comments
      .filter((c) => !q || c.text.toLowerCase().includes(q) || c.quote.toLowerCase().includes(q))
      .sort((a, b) => Number(a.resolved) - Number(b.resolved))
      .slice(0, 5)
      .map((c): ContextItem & { hint: string } => ({
        id: 'comment:' + c.id, kind: 'comment', label: makeLabel(c.text), hint: c.quote ? `针对「${clip1(c.quote, 20)}」${c.resolved ? ' · 已解决' : ''}` : c.resolved ? '已解决' : '',
        text: `${c.quote ? `Commented text: "${c.quote}"\n` : ''}Comment by ${c.author}: ${c.text}${c.replies.map((r) => `\nReply by ${r.author}: ${r.text}`).join('')}`,
        blockIds: c.blockId ? [c.blockId] : [],
      }))
    const bs = listBlocks()
      .filter((b) => b.text.trim() && (!q || b.text.toLowerCase().includes(q)))
      .slice(0, 8)
      .map((b): ContextItem & { hint: string } => ({ id: 'block:' + b.blockId, kind: 'block', label: makeLabel(b.text), hint: '', text: b.text, blockIds: [b.blockId] }))
    return [...cs, ...bs]
  })()

  const pick = (o: ContextItem): void => {
    if (!menu) return
    setRefs((cur) => (cur.some((r) => r.id === o.id) ? cur : [...cur, { id: o.id, kind: o.kind, label: o.label, text: o.text, blockIds: o.blockIds }]))
    const end = menu.at + 1 + menu.query.length
    setInput((v) => v.slice(0, menu.at) + v.slice(end))
    setMenu(null)
    requestAnimationFrame(() => area.current?.focus())
  }

  const onInput = (v: string, caret: number): void => {
    setInput(v)
    const m = /(^|\s)@([^\s@]*)$/.exec(v.slice(0, caret))
    setMenu(m ? { query: m[2]!, at: caret - m[2]!.length - 1, index: 0 } : null)
  }
  /** The "+" button: insert "@" at the caret and open the same @ menu as typing it. */
  const insertMention = (): void => {
    const el = area.current
    if (!el) return
    el.focus()
    const start = el.selectionStart ?? input.length
    const end = el.selectionEnd ?? start
    const before = input.slice(0, start)
    // The menu only opens after whitespace or at the start, so pad when the caret follows a word.
    const pad = before && !/\s$/.test(before) ? ' ' : ''
    const caret = start + pad.length + 1
    onInput(before + pad + '@' + input.slice(end), caret)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(caret, caret)
    })
  }
  const orphanIds = new Set(changes.map((c) => c.runId).filter((id): id is string => !!id && !knownRunIds.includes(id) && id !== live?.runId))
  const past = history.filter((r) => r.id !== live?.runId)

  return (
    <div className="ai">
      <ChatBar runs={runs} />
      <div className="ai-log">
        {past.length === 0 && !live && (
          <p className="muted pad">
            告诉 AI 你想怎么改这篇文档，例如"把全文改得更正式""给每一节加一句小结"。它的修改会以修订的形式出现在文档里，由你逐条确认。也可以选中文字后直接用工具栏里的润色、扩写。
          </p>
        )}
        {past.map((r) => (
          <div key={r.id} className="turn">
            <div className="ask">{r.instruction || '快捷操作'}</div>
            <div className="answer"><span className="avatar" aria-hidden>AI</span><div className="answer-body">{r.summary || STATUS[r.status] || r.status}</div></div>
            {r.status !== 'done' && <div className="muted small">{STATUS[r.status] ?? r.status}</div>}
            {review(r.id)}
          </div>
        ))}
        {live && (
          <div className="turn">
            <div className="ask">{live.title}</div>
            {live.plan.length > 0 && (
              <ol className="plan">
                {live.plan.map((p, i) => <li key={i} data-status={p.status}>{p.title}</li>)}
              </ol>
            )}
            {live.steps.length > 0 && (
              <ul className="steps">
                {live.steps.map((s, i) => (
                  <li key={i} data-ok={s.ok === undefined ? 'pending' : String(s.ok)}>
                    {s.detail}
                    {s.ok === false && <span className="error">　失败：{s.error}</span>}
                    {!!s.notApplied && <span className="warn">　{s.notApplied} 处未应用（文字已被改动）</span>}
                  </li>
                ))}
              </ul>
            )}
            {live.note && <div className="muted small">{live.note}</div>}
            {live.text && <div className="answer"><span className="avatar" aria-hidden>AI</span><div className="answer-body">{live.text}</div></div>}
            {live.question && <div className="question" role="alert">AI 想问你：{live.question}<div className="muted small">直接在下面回复即可。</div></div>}
            {live.error && <div className="error">{live.error}</div>}
            <div className="status-line small" role="status" data-status={live.status}>{live.status === 'running' && <span className="dot" />}{STATUS[live.status] ?? live.status}</div>
            {review(live.runId)}
          </div>
        )}
        {[...orphanIds].length > 0 && (
          <div className="turn">
            <div className="muted small">来自已删除对话的修改，仍待你确认</div>
            {[...orphanIds].map((id) => <div key={id}>{review(id)}</div>)}
          </div>
        )}
        <div ref={end} />
      </div>
      {error && <p className="error pad">{error}</p>}
      {busyElsewhere && <p className="muted small pad">另一个对话正在运行，这篇文档一次只能有一个 AI 任务。</p>}
      {noModel && <p className="error pad">没有可用的模型。请在首页的"设置"里填写模型密钥。</p>}
      <div className="ai-input">
        {menu && (
          <div className="at-menu" role="listbox" aria-label="引用评论或段落">
            {options.length === 0 && <div className="muted small at-empty">没有匹配的评论或段落</div>}
            {options.map((o, i) => (
              <button key={o.id} role="option" aria-selected={i === menu.index} className="at-item" data-active={i === menu.index} onMouseDown={(e) => { e.preventDefault(); pick(o) }} onMouseEnter={() => setMenu({ ...menu, index: i })}>
                {o.kind === 'comment' ? <MessageSquare className="size-3.5" /> : <Pilcrow className="size-3.5" />}
                <span className="at-label">{o.label}</span>
                <span className="muted small">{(o as { hint?: string }).hint || KIND_NAME[o.kind]}</span>
              </button>
            ))}
          </div>
        )}
        {refs.length > 0 && (
          <div className="ref-chips">
            {refs.map((r) => (
              <span key={r.id} className="ref-chip" title={r.text}>
                {r.kind === 'comment' ? <MessageSquare className="size-3" /> : r.kind === 'block' ? <Pilcrow className="size-3" /> : <TextQuote className="size-3" />}
                <span>{r.label}</span>
                <button aria-label="移除引用" onClick={() => setRefs((cur) => cur.filter((x) => x.id !== r.id))}><X className="size-3" /></button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          rows={2}
          readOnly={sending}
          value={input}
          placeholder="让 AI 修改这篇文档…（@ 引用评论或段落，Enter 发送）"
          onChange={(e) => onInput(e.target.value, e.target.selectionStart)}
          onKeyDown={(e) => {
            if (menu && !e.nativeEvent.isComposing) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const n = Math.max(options.length, 1)
                setMenu({ ...menu, index: (menu.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n })
                return
              }
              if ((e.key === 'Enter' || e.key === 'Tab') && options[menu.index]) {
                e.preventDefault()
                pick(options[menu.index]!)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setMenu(null)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="flex items-center gap-1 mt-1">
          <Tip text="引用评论或段落" side="top">
            <Button variant="ghost" size="icon" aria-label="引用评论或段落" className="size-7 rounded-full text-muted-foreground hover:bg-accent" onClick={insertMention}>
              <Plus />
            </Button>
          </Tip>
          <span className="flex-1" />
          <Select
            className="w-auto max-w-[180px] h-7 text-[13px] border-transparent bg-transparent text-muted-foreground shadow-none"
            size="sm"
            aria-label="模型或外部 Agent"
            value={engine === 'builtin' ? model : 'ext:' + engine}
            onValueChange={(v) => {
              if (v.startsWith('ext:')) setEngine(v.slice(4))
              else {
                setEngine('builtin')
                setModel(v)
              }
            }}
            options={[
              ...(models?.models ?? []).map((m) => ({ value: m.id, label: m.label + (m.verified ? '' : '（未验证）') })),
              ...(models?.externalAgents ?? []).map((x) => ({ value: 'ext:' + x.id, label: x.label, group: '外部 Agent（用它自己的模型）' })),
            ]}
          />
          {running ? (
            <Tip text="停止" side="top">
              <Button variant="default" size="icon" aria-label="停止" className="size-8 rounded-full bg-foreground text-background hover:bg-foreground hover:opacity-90" onClick={cancel}>
                <Square className="size-3 fill-current" />
              </Button>
            </Tip>
          ) : (
            <Tip text="发送（Enter）" side="top">
              <Button
                variant="default"
                size="icon"
                aria-label="发送"
                disabled={!canSend}
                className={
                  'size-8 rounded-full ' +
                  (!canSend ? 'bg-muted text-muted-foreground' : 'bg-foreground text-background hover:bg-foreground hover:opacity-90')
                }
                onClick={send}
              >
                <ArrowUp />
              </Button>
            </Tip>
          )}
        </div>
      </div>
    </div>
  )
}
