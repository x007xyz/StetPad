import { getLang } from './i18n'
import { addComment, blocks, blockIdOf, changesInBlock, decide, deleteComment, findBlock, listChanges, listComments, listDecided, decideAndLog, type DecidedChange, projectBlocks, replyToComment, resolveComment, type CommentView, type PendingChange } from '@stetpad/crdt'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Editor } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Code from '@tiptap/extension-code'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import Document from '@tiptap/extension-document'
import Heading from '@tiptap/extension-heading'
import Highlight from '@tiptap/extension-highlight'
import Italic from '@tiptap/extension-italic'
import Link from '@tiptap/extension-link'
import Paragraph from '@tiptap/extension-paragraph'
import Strike from '@tiptap/extension-strike'
import Text from '@tiptap/extension-text'
import Underline from '@tiptap/extension-underline'
import { Dropcursor, Gapcursor, Placeholder } from '@tiptap/extensions'
import type { Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection } from '@tiptap/pm/state'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { api, apiBlob, collabUrl, download, getToken, post, printHtml, type DocMeta } from './api'
import { go, type Session } from './App'
import { ListChecks, ListTree, MessageSquare, MessageSquarePlus, Sparkles, AlignLeft, Columns2, ChevronDown, ChevronUp, Cloud, Download, GripVertical, Share2, Ellipsis, FilePenLine, Bold as BoldIcon, Italic as ItalicIcon, Underline as UnderlineIcon, Strikethrough, Code as CodeIcon, Highlighter, Repeat2, Copy, ArrowUp, ArrowDown, Trash2, Type, Heading1, Heading2, Heading3, List, ListOrdered, ListTodo, Quote as QuoteIcon, StickyNote, SquareCode, PenLine } from 'lucide-react'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, SheetContent } from './components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './components/ui/dropdown-menu'
import { Input } from './components/ui/input'
import { Select } from './components/ui/select'
import { Tip, TooltipProvider } from './components/ui/tooltip'
import { useMedia } from './lib/useMedia'
import { cn } from './lib/utils'
import { SidebarToggle, useWorkspaceOptional } from './Shell'
import { BlockId, BlockKeys, BulletItem, Callout, CodeBlock, Divider, Image, moveBlock, OrderedItem, Quote, SLASH_ITEMS, Table, TaskItem } from './editor/schema'
import { BlockMenu, type MenuAction, type MenuSection } from './editor/BlockMenu'
import { anchorBetween, Tracked } from './editor/tracked'
import { AiPanel, makeLabel, useRuns, type ContextItem } from './panels/Ai'
import { ChangesPanel } from './panels/Changes'
import { CommentsPanel } from './panels/Comments'
import { DiffView, rowChanged, type DiffRow } from './panels/DiffView'
import { OutlineRail, readTocPinned, writeTocPinned } from './panels/Outline'
import { VersionsMenu } from './panels/Versions'

export interface Shared { token: string; role: 'edit' | 'suggest' | 'view'; title: string }
const COLORS = ['#d9480f', '#2b8a3e', '#1971c2', '#9c36b5', '#c2255c', '#087f5b']
const guestName = (): string => {
  try {
    let n = sessionStorage.getItem('aiw.guest')
    if (!n) sessionStorage.setItem('aiw.guest', (n = '访客 ' + Math.random().toString(36).slice(2, 5).toUpperCase()))
    return n
  } catch {
    return '访客'
  }
}

type View = 'inline' | 'side'
type Tab = 'changes' | 'comments' | 'ai'
interface Floating { x: number; y: number }

const AI_ITEM: (typeof SLASH_ITEMS)[number] = { label: 'AI 续写', hint: '接着上文往下写', type: '__ai', keys: 'ai xuxie continue' }

export function DocPage({ id, session, shared }: { id: string; session: Session | null; shared?: Shared }) {
  const [meta, setMeta] = useState<DocMeta | null>(null)
  const [missing, setMissing] = useState(false)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting')
  const [ready, setReady] = useState(false)
  const [view, setView] = useState<View>('inline')
  const [tab, setTab] = useState<Tab>('changes')
  const [tocPinned, setTocPinned] = useState(readTocPinned)
  const [tracking, setTracking] = useState(shared?.role === 'suggest')
  const [shareOpen, setShareOpen] = useState(false)
  const readOnly = shared?.role === 'view' || meta?.access === 'viewer'
  /** Guests and viewers get the document, its suggestions and comments, and nothing else. */
  const limited = !!shared || meta?.access === 'viewer'
  const providerRef = useRef<HocuspocusProvider | null>(null)
  const [changes, setChanges] = useState<PendingChange[]>([])
  const [decided, setDecided] = useState<DecidedChange[]>([])
  const [commentList, setCommentList] = useState<CommentView[]>([])
  const [handle, setHandle] = useState<{ top: number; left: number; el: HTMLElement } | null>(null)
  const [blockMenu, setBlockMenu] = useState<{ x: number; y: number; blockId: string } | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const imageAt = useRef<{ from: number; to: number } | null>(null)
  const [tick, setTick] = useState(0) // bumps when the document changes
  const [versionsKey, setVersionsKey] = useState(0)
  const [bubble, setBubble] = useState<(Floating & { custom: boolean; commenting?: boolean; ai?: boolean }) | null>(null)
  const [slash, setSlash] = useState<(Floating & { query: string; index: number; from: number }) | null>(null)
  const workspace = useWorkspaceOptional()
  const narrow = useMedia('(max-width: 1023px)')
  const [panelW, setPanelW] = useState(() => {
    try { return Math.min(760, Math.max(300, Number(localStorage.getItem('aiw.panelW')) || 340)) } catch { return 340 }
  })
  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelW
    let w = startW
    const move = (ev: PointerEvent): void => {
      w = Math.min(760, Math.max(300, startW + (startX - ev.clientX)))
      setPanelW(w)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
      try { localStorage.setItem('aiw.panelW', String(w)) } catch { /* ignore */ }
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const [panelOpen, setPanelOpen] = useState(() => !window.matchMedia('(max-width: 1023px)').matches)
  const [onlyChanged, setOnlyChanged] = useState(false)
  const [custom, setCustom] = useState('')
  const [refs, setRefs] = useState<ContextItem[]>([])
  const [focusSignal, setFocusSignal] = useState(0)

  const showTab = (t: Tab): void => {
    setTab(t)
    setPanelOpen(true)
  }
  const mount = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const trackingRef = useRef(false)
  trackingRef.current = tracking
  const slashRef = useRef(slash)
  slashRef.current = slash
  const author = useMemo(() => (shared ? guestName() : session!.mode === 'local' ? '我' : session!.user.email), [shared, session])
  const ydoc = useMemo(() => new Y.Doc(), [id])

  const runs = useRuns(id, () => setVersionsKey((k) => k + 1), !shared)
  const runsRef = useRef(runs)
  runsRef.current = runs

  useEffect(() => {
    if (shared) {
      setMeta({ id, title: shared.title, created_at: 0, updated_at: 0 })
      document.title = shared.title
      return
    }
    api<DocMeta>(`/docs/${id}`).then((m) => {
      setMeta(m)
      document.title = m.title
    }).catch(() => setMissing(true))
  }, [id, shared])

  // --- sync
  useEffect(() => {
    // A local copy lets the page reopen and keep editing without a connection.
    const local = new IndexeddbPersistence(`aiw-${id}`, ydoc)
    const provider = new HocuspocusProvider({
      url: collabUrl(),
      name: id,
      document: ydoc,
      token: shared ? `share:${shared.token}` : getToken(),
      onSynced: () => setReady(true),
      onStatus: ({ status: s }) => setStatus(s === 'connected' ? 'connected' : s === 'connecting' ? 'connecting' : 'offline'),
      onAuthenticationFailed: () => setMissing(true),
    })
    providerRef.current = provider
    let timer: ReturnType<typeof setTimeout> | null = null
    const onTx = (): void => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        setChanges(listChanges(ydoc))
        setDecided(listDecided(ydoc))
        setCommentList(listComments(ydoc))
        setTick((t) => t + 1)
      }, 60)
    }
    ydoc.on('afterTransaction', onTx)
    return () => {
      ydoc.off('afterTransaction', onTx)
      if (timer) clearTimeout(timer)
      provider.destroy()
      void local.destroy()
      ydoc.destroy()
    }
  }, [id, ydoc, shared])

  // --- editor
  const selectionScope = useCallback((): { blockIds: string[]; text: string } | null => {
    const ed = editorRef.current
    if (!ed) return null
    const { from, to } = ed.state.selection
    const blockIds: string[] = []
    ed.state.doc.nodesBetween(from, to, (node, _pos, parent) => {
      if (parent === ed.state.doc && node.attrs.blockId) blockIds.push(String(node.attrs.blockId))
      return false
    })
    return blockIds.length ? { blockIds, text: from === to ? '' : ed.state.doc.textBetween(from, to, '\n') } : null
  }, [])

  const slashItems = useCallback((query: string) => {
    const q = query.toLowerCase()
    return [...SLASH_ITEMS, AI_ITEM].filter((i) => !q || i.label.includes(q) || i.keys.includes(q))
  }, [])

  const pickSlash = useCallback((index: number) => {
    const ed = editorRef.current
    const s = slashRef.current
    if (!ed || !s) return
    const item = slashItems(s.query)[index]
    if (!item) return
    const range = { from: s.from, to: ed.state.selection.from }
    setSlash(null)
    if (item.type === '__ai') {
      const $pos = ed.state.doc.resolve(s.from)
      const prev = $pos.index(0) > 0 ? ed.state.doc.child($pos.index(0) - 1) : null
      ed.chain().focus().deleteRange(range).run()
      const blockId = prev?.attrs.blockId as string | undefined
      if (blockId) {
        void runsRef.current.start({ preset: 'continue', selection: { blockIds: [blockId] } }, 'AI 续写')
        showTab('ai')
      }
    } else if (item.type === '__image') {
      imageAt.current = range
      imageInput.current?.click()
    } else if (item.type === 'divider' || item.type === 'table') {
      ed.chain().focus().deleteRange(range).insertContent([{ type: item.type }, { type: 'paragraph' }]).run()
    } else {
      ed.chain().focus().deleteRange(range).setNode(item.type, item.attrs).run()
    }
  }, [slashItems])
  const pickRef = useRef(pickSlash)
  pickRef.current = pickSlash

  useEffect(() => {
    if (!ready || !mount.current) return
    const editor = new Editor({
      element: mount.current,
      extensions: [
        Document, Text, Paragraph,
        Heading.configure({ levels: [1, 2, 3] }),
        BulletItem, OrderedItem, TaskItem, Quote, Callout, CodeBlock, Divider, Image, Table,
        Bold, Italic, Underline, Strike, Code, Highlight,
        Link.configure({ openOnClick: false, autolink: true }),
        Dropcursor, Gapcursor,
        Placeholder.configure({ placeholder: getLang() === 'en' ? 'Type something, or type / to pick a block type' : '输入内容，或输入 / 选择块类型' }),
        Collaboration.configure({ document: ydoc, field: 'content' }),
        // Other people's cursors and selections.
        ...(providerRef.current ? [CollaborationCaret.configure({ provider: providerRef.current, user: { name: author, color: COLORS[Math.floor(Math.random() * COLORS.length)]! } })] : []),
        BlockId, BlockKeys,
        Tracked.configure({ doc: ydoc, user: () => ({ author, tracking: trackingRef.current, suggestOnly: shared?.role === 'suggest' }) }),
      ],
      editable: !readOnly,
      editorProps: {
        attributes: { class: 'prose', spellcheck: 'false' },
        handleKeyDown(_view, event) {
          const s = slashRef.current
          if (!s) return false
          const count = slashItems(s.query).length
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            setSlash({ ...s, index: (s.index + (event.key === 'ArrowDown' ? 1 : count - 1)) % Math.max(count, 1) })
            return true
          }
          if (event.key === 'Enter' && count) {
            pickRef.current(s.index)
            return true
          }
          if (event.key === 'Escape') {
            setSlash(null)
            return true
          }
          return false
        },
      },
    })
    editorRef.current = editor

    const place = (): void => {
      const { state, view: v } = editor
      const { from, to, empty, $from } = state.selection
      // Slash menu: "/query" as the whole text of a paragraph, cursor at its end.
      const parent = $from.parent
      const m = empty && parent.type.name === 'paragraph' && $from.parentOffset === parent.content.size
        ? parent.textContent.match(/^\/([^\s/]*)$/) : null
      if (m && editor.isFocused) {
        const c = v.coordsAtPos(from)
        const prev = slashRef.current
        setSlash({ x: c.left, y: c.bottom + 6, query: m[1]!, index: prev && prev.query === m[1] ? prev.index : 0, from: $from.start() })
      } else if (slashRef.current) setSlash(null)
      // Selection toolbar.
      if (!empty && editor.isFocused && !v.composing) {
        const a = v.coordsAtPos(from)
        const b = v.coordsAtPos(to)
        setBubble((cur) => ({ x: (a.left + b.right) / 2, y: Math.min(a.top, b.top) - 8, custom: cur?.custom ?? false, commenting: cur?.commenting ?? false, ai: cur?.ai ?? false }))
      } else setBubble((cur) => (cur?.custom || cur?.commenting ? cur : null))
    }
    editor.on('selectionUpdate', place)
    editor.on('transaction', place)
    editor.on('focus', place)
    setChanges(listChanges(ydoc))
    setDecided(listDecided(ydoc))
    setCommentList(listComments(ydoc))
    return () => {
      editor.destroy()
      editorRef.current = null
    }
  }, [ready, ydoc, author, slashItems, readOnly, shared])

  useEffect(() => {
    editorRef.current?.setEditable(!readOnly)
  }, [readOnly, ready])

  const uploadImage = async (file: File): Promise<void> => {
    const ed = editorRef.current
    const range = imageAt.current
    imageAt.current = null
    if (!ed) return
    const form = new FormData()
    form.append('file', file)
    try {
      const { url } = await api<{ url: string }>(`/docs/${id}/assets`, { method: 'POST', body: form })
      const chain = ed.chain().focus()
      if (range) chain.deleteRange(range)
      chain.insertContent([{ type: 'image', attrs: { src: url, alt: file.name } }, { type: 'paragraph' }]).run()
    } catch (e) {
      alert(e instanceof Error ? e.message : '上传失败')
    }
  }

  /** Dragging the handle moves the whole block; the editor's own drop logic does the rest. */
  const startDrag = (e: React.DragEvent): void => {
    const ed = editorRef.current
    if (!ed || !handle) return
    const view = ed.view
    const inside = view.posAtDOM(handle.el, 0)
    const $p = view.state.doc.resolve(inside)
    const pos = $p.depth >= 1 ? $p.before(1) : inside
    const sel = NodeSelection.create(view.state.doc, pos)
    view.dispatch(view.state.tr.setSelection(sel))
    view.dragging = { slice: sel.content(), move: true }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', handle.el.textContent ?? '')
    e.dataTransfer.setDragImage(handle.el, 0, 0)
  }
  const trackHandle = (e: React.MouseEvent): void => {
    if (readOnly) return
    const el = (e.target as HTMLElement).closest?.('.prose > *') as HTMLElement | null
    if (!el) return
    const r = el.getBoundingClientRect()
    if (!handle || handle.el !== el) setHandle({ top: r.top + 2, left: r.left - 24, el })
  }

  const submitComment = (text: string): void => {
    const ed = editorRef.current
    if (!ed || !text.trim()) return
    const { from, to } = ed.state.selection
    addComment(ydoc, anchorBetween(ydoc, ed.state.doc, from, to), author, text.trim())
    setBubble(null)
    setCustom('')
    showTab('comments')
  }
  const focusComment = (cid: string): void => {
    if (view === 'side') setView('inline')
    setTimeout(() => {
      const el = mount.current?.querySelector(`.cm[data-comment~="${cid}"]`)
      if (!el) return
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add('flash')
      setTimeout(() => el.classList.remove('flash'), 1200)
    }, 30)
  }
  const toggleSync = async (): Promise<void> => {
    try {
      await api(`/docs/${id}/sync`, { method: meta?.sync ? 'DELETE' : 'POST' })
      setMeta(await api<DocMeta>(`/docs/${id}`))
    } catch (e) {
      alert(e instanceof Error ? e.message : '操作失败')
    }
  }

  // --- actions
  const decideMany = useCallback((ids: string[], d: 'accept' | 'reject') => {
    const text = (bid: string): string => projectBlocks(ydoc, 'physical').find((b) => b.blockId === bid)?.text ?? ''
    decideAndLog(ydoc, listChanges(ydoc), ids, d, text)
  }, [ydoc])

  // When the last pending change is handled, keep that state as a version.
  const hadChanges = useRef(false)
  useEffect(() => {
    if (changes.length > 0) hadChanges.current = true
    else if (hadChanges.current && !runs.running && !shared) {
      hadChanges.current = false
      const t = setTimeout(() => void post(`/docs/${id}/versions`, { trigger: 'reviewed' }).then(() => setVersionsKey((k) => k + 1)), 1200)
      return () => clearTimeout(t)
    }
  }, [changes.length, runs.running, id, shared])

  const focusChange = (cid: string): void => {
    if (view !== 'inline') setView('inline')
    setTimeout(() => {
      const el = mount.current?.querySelector(`[data-change="${cid}"]`) ??
        [...(mount.current?.querySelectorAll('.tc-block-ins, .tc-block-del') ?? [])].find((b) => {
          const y = findBlock(ydoc, b.getAttribute('data-block-id') ?? '')
          return y && changesInBlock(ydoc, y).includes(cid)
        })
      if (!el) return
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add('flash')
      setTimeout(() => el.classList.remove('flash'), 1200)
    }, 30)
  }

  const focusBlock = (bid: string): void => {
    if (view !== 'inline') setView('inline')
    setTimeout(() => {
      const el = mount.current?.querySelector(`[data-block-id="${CSS.escape(bid)}"]`)
      if (!el) return
      el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      el.classList.add('flash')
      setTimeout(() => el.classList.remove('flash'), 1200)
    }, 30)
  }

  const runAi = (preset: string | undefined, instruction: string, title: string): void => {
    const selection = selectionScope()
    if (!selection) return
    void runs.start({ preset, instruction: instruction || undefined, selection }, title)
    setBubble(null)
    setCustom('')
    showTab('ai')
  }

  /** Put the current selection into the AI chat as a reference. */
  const addSelectionToChat = (): void => {
    const sel = selectionScope()
    if (!sel?.text.trim()) return
    const item: ContextItem = { id: 'text:' + sel.blockIds.join(',') + ':' + sel.text.slice(0, 40), kind: 'text', label: makeLabel(sel.text), text: sel.text, blockIds: sel.blockIds }
    setRefs((cur) => (cur.some((r) => r.id === item.id) ? cur : [...cur, item]))
    setBubble(null)
    showTab('ai')
    setFocusSignal((n) => n + 1)
  }

  /** The top-level block with this id, and where it starts. */
  const topBlock = (bid: string): { node: PMNode; pos: number } | null => {
    const ed = editorRef.current
    if (!ed) return null
    let found: { node: PMNode; pos: number } | null = null
    ed.state.doc.forEach((node, pos) => {
      if (!found && node.attrs.blockId === bid) found = { node, pos }
    })
    return found
  }
  const openBlockMenu = (): void => {
    const ed = editorRef.current
    if (!ed || !handle) return
    const inside = ed.view.posAtDOM(handle.el, 0)
    const $p = ed.state.doc.resolve(inside)
    const node = $p.depth >= 1 ? $p.node(1) : ed.state.doc.nodeAt(inside)
    const bid = node?.attrs.blockId as string | undefined
    if (!bid) return
    setBlockMenu({ x: handle.left, y: handle.top + 28, blockId: bid })
  }
  // Mark the block whose menu is open.
  useEffect(() => {
    if (!blockMenu) return
    const el = document.querySelector(`.prose [data-block-id="${CSS.escape(blockMenu.blockId)}"]`)
    el?.classList.add('block-selected')
    return () => el?.classList.remove('block-selected')
  }, [blockMenu])
  /** Select the whole text of a block (or the block itself when it has no text). */
  const selectBlock = (bid: string): boolean => {
    const ed = editorRef.current
    const b = topBlock(bid)
    if (!ed || !b) return false
    if (b.node.isTextblock) ed.chain().focus().setTextSelection({ from: b.pos + 1, to: b.pos + b.node.nodeSize - 1 }).run()
    else ed.view.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, b.pos)))
    return true
  }
  const blockMenuSections = (bid: string): MenuSection[] => {
    const ed = editorRef.current
    const b = topBlock(bid)
    if (!ed || !b) return []
    const text = b.node.textContent
    const isText = b.node.isTextblock
    const convertIcons: Record<string, typeof Type> = { paragraph: Type, 'heading-1': Heading1, 'heading-2': Heading2, 'heading-3': Heading3, bulletItem: List, orderedItem: ListOrdered, taskItem: ListTodo, quote: QuoteIcon, callout: StickyNote, codeBlock: SquareCode }
    const convert: MenuAction[] = SLASH_ITEMS.filter((i) => ['paragraph', 'heading', 'bulletItem', 'orderedItem', 'taskItem', 'quote', 'callout', 'codeBlock'].includes(i.type)).map((i) => {
      const key = i.type === 'heading' ? `heading-${String(i.attrs?.level)}` : i.type
      const same = b.node.type.name === i.type && (i.type !== 'heading' || b.node.attrs.level === i.attrs?.level)
      return {
        id: 'to-' + key,
        label: i.label,
        icon: convertIcons[key],
        hint: same ? '当前' : undefined,
        disabled: same,
        run: () => {
          const cur = topBlock(bid)
          if (cur) ed.chain().focus().setTextSelection(cur.pos + 1).setNode(i.type, i.attrs).run()
        },
      }
    })
    const sections: MenuSection[] = [
      {
        title: '块',
        actions: [
          { id: 'convert', label: '转换成', icon: Repeat2, disabled: !isText, children: convert },
          {
            id: 'duplicate', label: '创建副本', icon: Copy,
            run: () => {
              const cur = topBlock(bid)
              if (cur) ed.view.dispatch(ed.state.tr.insert(cur.pos + cur.node.nodeSize, cur.node.type.create({ ...cur.node.attrs, blockId: null }, cur.node.content, cur.node.marks)))
            },
          },
          { id: 'up', label: '上移', icon: ArrowUp, hint: '⌥↑', disabled: b.pos === 0, run: () => { if (selectBlock(bid)) moveBlock(ed, -1) } },
          { id: 'down', label: '下移', icon: ArrowDown, hint: '⌥↓', disabled: b.pos + b.node.nodeSize >= ed.state.doc.content.size, run: () => { if (selectBlock(bid)) moveBlock(ed, 1) } },
          {
            id: 'delete', label: '删除', icon: Trash2,
            run: () => {
              const cur = topBlock(bid)
              if (cur) ed.chain().focus().command(({ tr }) => { tr.delete(cur.pos, cur.pos + cur.node.nodeSize); return true }).run()
            },
          },
        ],
      },
      {
        actions: [
          { id: 'comment', label: '评论', icon: MessageSquare, disabled: !isText || !text.trim(), run: () => { if (selectBlock(bid)) setBubble((cur) => (cur ? { ...cur, commenting: true } : cur)) } },
        ],
      },
    ]
    if (!limited) {
      sections.push({
        title: 'AI',
        actions: [
          {
            id: 'ai', label: 'AI 修改这一段', icon: Sparkles, disabled: !isText || !text.trim() || runs.running,
            children: [
              ...presets.filter((p) => p.id !== 'continue').map((p): MenuAction => ({ id: 'ai-' + p.id, label: p.label, run: () => { if (selectBlock(bid)) runAi(p.id, '', p.label) } })),
              { id: 'ai-custom', label: '自定义指令…', icon: PenLine, run: () => { if (selectBlock(bid)) setBubble((cur) => (cur ? { ...cur, custom: true } : cur)) } },
            ],
          },
          {
            id: 'chat', label: '加入 AI 对话', icon: MessageSquarePlus, disabled: !text.trim(),
            run: () => {
              const item: ContextItem = { id: 'block:' + bid, kind: 'block', label: makeLabel(text), text, blockIds: [bid] }
              setRefs((cur) => (cur.some((r) => r.id === item.id) ? cur : [...cur, item]))
              showTab('ai')
              setFocusSignal((n) => n + 1)
            },
          },
        ],
      })
    }
    return sections
  }

  const rename = async (title: string): Promise<void> => {
    if (!meta || title === meta.title) return
    await api(`/docs/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) })
    setMeta({ ...meta, title: title.trim() || '未命名文档' })
    document.title = title
    void workspace?.reload()
  }

  const doExport = async (format: 'md' | 'html' | 'json' | 'docx' | 'pdf', which: 'revised' | 'original'): Promise<void> => {
    const name = (meta?.title ?? 'document').replace(/[\\/:*?"<>|]/g, '_')
    if (format === 'docx') return download(`${name}.docx`, await apiBlob(`/docs/${id}/export?format=docx&view=${which}`), '')
    if (format === 'pdf') return printHtml(await api<string>(`/docs/${id}/export?format=html&view=${which}`))
    const body = await api<string | object>(`/docs/${id}/export?format=${format}&view=${which}`)
    if (format === 'json') download(`${name}.stetpad.json`, JSON.stringify(body, null, 2), 'application/json')
    else download(`${name}.${format}`, body as string, format === 'md' ? 'text/markdown' : 'text/html')
  }

  // Rows for the side-by-side review: the original against the revision.
  const reviewRows = useMemo((): DiffRow[] => {
    if (view !== 'side') return []
    const orig = new Map(projectBlocks(ydoc, 'original').map((b) => [b.blockId, b]))
    const rev = new Map(projectBlocks(ydoc, 'revised').map((b) => [b.blockId, b]))
    return blocks(ydoc).filter((el) => orig.has(blockIdOf(el)) || rev.has(blockIdOf(el))).map((el) => {
      const bid = blockIdOf(el)
      const row: DiffRow = { id: bid, left: orig.get(bid), right: rev.get(bid) }
      const ids = changesInBlock(ydoc, el)
      if (ids.length && !readOnly && (!shared || shared.role === 'edit')) {
        row.actions = (
          <>
            <button onClick={() => decideMany(ids, 'accept')}>接受{ids.length > 1 ? ` ${ids.length} 处` : ''}</button>
            <button onClick={() => decideMany(ids, 'reject')}>拒绝</button>
          </>
        )
      }
      return row
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, tick, ydoc, decideMany, shared, readOnly])

  const jump = (dir: 1 | -1): void => {
    const els = [...document.querySelectorAll<HTMLElement>(view === 'side' ? '[data-diff-changed]' : '.prose [data-change]:not([data-change=""]), .prose .tc-block-ins, .prose .tc-block-del')]
    if (!els.length) return
    const mid = window.innerHeight / 2
    const next = dir === 1 ? els.find((e) => e.getBoundingClientRect().top > mid + 8) ?? els[0]! : [...els].reverse().find((e) => e.getBoundingClientRect().top < mid - 40) ?? els[els.length - 1]!
    next.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  if (missing) {
    return (
      <div className="center">
        <div className="flex flex-col items-center gap-3 rounded-xl border border-border p-6">
          <p>找不到这篇文档，或者你没有权限打开它。</p>
          <Button onClick={() => go({ page: 'home' })}>返回文档列表</Button>
        </div>
      </div>
    )
  }

  const blockTextOf = (bid: string): string => projectBlocks(ydoc, 'physical').find((b) => b.blockId === bid)?.text ?? ''
  const presets = runs.models?.presets ?? []
  const items = slash ? slashItems(slash.query) : []
  const unresolved = commentList.filter((c) => !c.resolved).length
  const canDecide = !readOnly && (!shared || shared.role === 'edit')
  const closeIfNarrow = (): void => {
    if (narrow) setPanelOpen(false)
  }
  const panelButtons: [Tab, string, typeof Sparkles, number | boolean][] = [['changes', '修订', ListChecks, changes.length], ['comments', '评论', MessageSquare, unresolved]]

  const panel = (
    <div className="panel flex min-h-0 flex-1 flex-col">
      {tab === 'changes' && <ChangesPanel changes={changes} blockText={blockTextOf} onDecide={decideMany} onFocus={(cid) => { closeIfNarrow(); focusChange(cid) }} canDecide={canDecide} />}
      {tab === 'comments' && <CommentsPanel list={commentList} canWrite={!readOnly} onFocus={(cid) => { closeIfNarrow(); focusComment(cid) }} onReply={(cid, t) => replyToComment(ydoc, cid, author, t)} onResolve={(cid, r) => resolveComment(ydoc, cid, r)} onDelete={(cid) => deleteComment(ydoc, cid)} />}
      {tab === 'ai' && <AiPanel docId={id} runs={runs} refs={refs} setRefs={setRefs} comments={commentList} focusSignal={focusSignal} listBlocks={() => projectBlocks(ydoc, 'revised').map((b) => ({ blockId: b.blockId, text: b.text }))} changes={changes} decided={decided} blockText={blockTextOf} onDecide={decideMany} onFocus={(cid) => { closeIfNarrow(); focusChange(cid) }} canDecide={canDecide} />}
    </div>
  )

  const syncLabel = meta?.sync ? `云端同步：${{ synced: '已同步', connecting: '连接中', offline: '离线', refused: '被拒绝' }[meta.sync] ?? meta.sync}（点击停止）` : '同步到云端'
  const exportItems: [string, 'md' | 'html' | 'json' | 'docx' | 'pdf', 'revised' | 'original', boolean][] = [
    [`Markdown${changes.length ? '（按修改稿）' : ''}`, 'md', 'revised', true],
    ['Markdown（按原文）', 'md', 'original', changes.length > 0],
    [`HTML${changes.length ? '（按修改稿）' : ''}`, 'html', 'revised', true],
    ['HTML（按原文）', 'html', 'original', changes.length > 0],
    [`Word${changes.length ? '（按修改稿）' : ''}`, 'docx', 'revised', true],
    ['Word（按原文）', 'docx', 'original', changes.length > 0],
    [`PDF（打印）${changes.length ? '（按修改稿）' : ''}`, 'pdf', 'revised', true],
    ['文档包（含全部版本）', 'json', 'revised', true],
  ]

  return (
    <TooltipProvider>
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-background px-3 py-1.5">
        {/* Left: where am I */}
        {!shared && <SidebarToggle />}
        <input className="min-w-0 flex-1 basis-40 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-semibold outline-none hover:bg-accent focus:border-ring focus:bg-background" aria-label="文档标题" readOnly={!!shared} defaultValue={meta?.title ?? ''} key={meta?.title} onBlur={(e) => !shared && rename(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        {shared && <span className="chip">{{ edit: '可编辑', suggest: '只能提建议', view: '只读' }[shared.role]} · {author}</span>}
        <span className={`sync flex items-center gap-1.5 text-xs text-muted-foreground ${status}`}>
          <span aria-hidden className={cn('size-1.5 rounded-full', status === 'connected' ? 'bg-emerald-500' : status === 'connecting' ? 'bg-amber-400' : 'bg-orange-500')} />
          <span role="status" className="max-sm:sr-only">{status === 'connected' ? '已同步' : status === 'connecting' ? '连接中…' : '离线，修改已保存在本机'}</span>
        </span>

        {/* Edit tools */}
        <span aria-hidden className="mx-0.5 h-4 w-px bg-border max-sm:hidden" />
        <div role="group" aria-label="编辑工具" className="flex items-center gap-1.5 max-sm:order-last">
          <div role="group" aria-label="视图" className="flex gap-0.5 rounded-lg bg-secondary p-0.5">
            {([['inline', '行内修订', AlignLeft], ['side', '左右对比', Columns2]] as const).map(([v, label, Icon]) => (
              <Tip key={v} text={label}>
                <Button variant="ghost" size="icon" className={'size-7 ' + (view === v ? 'bg-background shadow-sm' : 'text-muted-foreground')} aria-label={label} aria-pressed={view === v} onClick={() => setView(v)}>
                  <Icon />
                </Button>
              </Tip>
            ))}
          </div>
          {!readOnly && (
            <Tip text={shared?.role === 'suggest' ? '你只能提建议：所有修改都会成为待作者确认的修订' : tracking ? '修订模式已开启：你的修改会记为修订，确认后才生效' : '修订模式已关闭：直接修改正文。点击开启后修改会留痕'}>
              {/* span so the tip still shows when the button is disabled */}
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn('size-7', tracking ? 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary' : 'text-muted-foreground')}
                  aria-label="修订模式"
                  aria-pressed={tracking}
                  disabled={shared?.role === 'suggest'}
                  onClick={() => setTracking((t) => !t)}
                >
                  <FilePenLine />
                </Button>
              </span>
            </Tip>
          )}
          {changes.length > 0 && (
            <span className="flex items-center">
              <Tip text="上一处修订"><Button variant="ghost" size="icon" className="size-7" onClick={() => jump(-1)} aria-label="上一处修订"><ChevronUp /></Button></Tip>
              <Tip text="下一处修订"><Button variant="ghost" size="icon" className="size-7" onClick={() => jump(1)} aria-label="下一处修订"><ChevronDown /></Button></Tip>
            </span>
          )}
        </div>

        {/* Document actions: wide screens get icon buttons, narrow ones a "更多" menu */}
        {!limited && <span aria-hidden className="mx-0.5 h-4 w-px bg-border max-sm:hidden" />}
        <div role="group" aria-label="文档操作" className="flex items-center gap-0.5">
          {!limited && <VersionsMenu docId={id} refreshKey={versionsKey} current={() => projectBlocks(ydoc, 'revised')} />}
          {!shared && (
            <DropdownMenu>
              <Tip text="导出"><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7 text-muted-foreground max-sm:hidden" aria-label="导出"><Download /></Button></DropdownMenuTrigger></Tip>
              <DropdownMenuContent align="end">
                {exportItems.filter(([, , , show]) => show).map(([label, f, which]) => (
                  <DropdownMenuItem key={label} onSelect={() => void doExport(f, which)}>{label}</DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {!limited && session?.mode === 'web' && <Tip text="分享"><Button variant="ghost" size="icon" className="size-7 text-muted-foreground max-sm:hidden" aria-label="分享" onClick={() => setShareOpen(true)}><Share2 /></Button></Tip>}
          {!limited && session?.mode === 'local' && <Tip text={syncLabel}><Button variant="ghost" size="icon" className={cn('size-7 max-sm:hidden', meta?.sync ? 'text-primary' : 'text-muted-foreground')} aria-label={syncLabel} aria-pressed={!!meta?.sync} onClick={toggleSync}><Cloud /></Button></Tip>}
          {!shared && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7 text-muted-foreground sm:hidden" aria-label="更多"><Ellipsis /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!limited && session?.mode === 'web' && <DropdownMenuItem onSelect={() => setShareOpen(true)}>分享</DropdownMenuItem>}
                {!limited && session?.mode === 'local' && <DropdownMenuItem onSelect={() => void toggleSync()}>{syncLabel}</DropdownMenuItem>}
                {exportItems.filter(([, , , show]) => show).map(([label, f, which]) => (
                  <DropdownMenuItem key={label} onSelect={() => void doExport(f, which)}>导出 {label}</DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* Side panels */}
        <span aria-hidden className="mx-0.5 h-4 w-px bg-border max-sm:hidden" />
        <div role="group" aria-label="侧边面板" className="flex items-center gap-0.5">
          {!narrow && (
            <Tip text={tocPinned ? '目录：一直显示（点击改为悬停显示）' : '目录：悬停显示（点击改为一直显示）'}>
              <Button variant="ghost" size="icon" className={'size-7 ' + (tocPinned ? 'bg-secondary' : 'text-muted-foreground')} aria-label="目录" aria-pressed={tocPinned} onClick={() => { writeTocPinned(!tocPinned); setTocPinned(!tocPinned) }}>
                <ListTree />
              </Button>
            </Tip>
          )}
          {panelButtons.filter(([t]) => !limited || t === 'changes' || t === 'comments').map(([t, label, Icon, badge]) => {
            const active = panelOpen && tab === t
            return (
              <Tip key={t} text={active ? `收起${label}` : label}>
                <Button variant="ghost" size="icon" className={'relative size-7 ' + (active ? 'bg-secondary' : 'text-muted-foreground')} aria-label={label} aria-pressed={active} onClick={() => (active ? setPanelOpen(false) : showTab(t))}>
                  <Icon />
                  {badge === true && <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" />}
                  {typeof badge === 'number' && badge > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 text-primary-foreground">{badge}</span>}
                </Button>
              </Tip>
            )
          })}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1">
          <main className="page" data-view={view} onMouseMove={trackHandle} onScroll={() => setHandle(null)}>
            {!ready && <p className="muted pad">正在打开文档…</p>}
            <div ref={mount} hidden={view === 'side'} />
            {view === 'side' && (
              <>
                <div className="row between pad mx-auto max-w-[1180px] px-5">
                  <span className="muted">{reviewRows.filter(rowChanged).length} 个段落有修订</span>
                  <label className="row text-[13px]"><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> 只看有修订的段落</label>
                </div>
                <DiffView rows={reviewRows} leftTitle="原文" rightTitle="修改稿" onlyChanged={onlyChanged} />
              </>
            )}
          </main>
          {!narrow && ready && view !== 'side' && <OutlineRail ydoc={ydoc} tick={tick} pinned={tocPinned} onJump={focusBlock} />}
          {!limited && (() => {
            const aiOpen = panelOpen && tab === 'ai'
            return (
              <Tip text={aiOpen ? '收起 AI' : 'AI'} side="left">
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn('absolute bottom-6 right-6 z-30 size-11 rounded-full border border-border bg-background shadow-lg hover:bg-accent [&_svg]:size-5', aiOpen ? 'text-primary' : 'text-foreground')}
                  aria-label="AI"
                  aria-pressed={aiOpen}
                  onClick={() => (aiOpen ? setPanelOpen(false) : showTab('ai'))}
                >
                  <Sparkles />
                  {runs.running && <span className="absolute right-1 top-1 size-2 rounded-full bg-primary" />}
                </Button>
              </Tip>
            )
          })()}
        </div>
        {!narrow && panelOpen && (
          <aside className="relative flex shrink-0 flex-col border-l border-border bg-background" style={{ width: panelW }} aria-label="面板">
            <div className="panel-resizer" role="separator" aria-orientation="vertical" aria-label="拖动调整面板宽度" onPointerDown={startResize} onDoubleClick={() => { setPanelW(340); try { localStorage.removeItem('aiw.panelW') } catch { /* ignore */ } }} />
            {panel}
          </aside>
        )}
      </div>
      {narrow && (
        <Dialog open={panelOpen} onOpenChange={setPanelOpen}>
          <SheetContent side="bottom" title="面板">{panel}</SheetContent>
        </Dialog>
      )}

      {shareOpen && <ShareDialog docId={id} onClose={() => setShareOpen(false)} />}

      {bubble && view !== 'side' && !readOnly && (
        <div className="bubble" style={{ left: bubble.x, top: bubble.y }} onMouseDown={(e) => (e.target as HTMLElement).tagName !== 'INPUT' && e.preventDefault()}>
          {bubble.commenting ? (
            <form className="row" onSubmit={(e) => { e.preventDefault(); submitComment(custom) }}>
              <input autoFocus value={custom} placeholder="写下评论" onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setBubble(null)} onBlur={() => !custom && setBubble(null)} />
              <button className="primary" disabled={!custom.trim()}>评论</button>
            </form>
          ) : bubble.custom ? (
            <form className="row" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) runAi(undefined, custom.trim(), custom.trim()) }}>
              <input autoFocus value={custom} placeholder="告诉 AI 怎么改选中的内容" onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setBubble(null)} onBlur={() => !custom && setBubble(null)} />
              <button className="primary" disabled={!custom.trim() || runs.running}>发送</button>
            </form>
          ) : (
            <>
              {([['bold', '加粗', '⌘B', BoldIcon], ['italic', '斜体', '⌘I', ItalicIcon], ['underline', '下划线', '⌘U', UnderlineIcon], ['strike', '删除线', '⌘⇧S', Strikethrough], ['code', '行内代码', '⌘E', CodeIcon], ['highlight', '高亮', '⌘⇧H', Highlighter]] as const).map(([mark, label, keys, Icon]) => (
                <Tip key={mark} text={`${label} ${keys}`} side="top">
                  <button className="ico" aria-label={label} aria-pressed={editorRef.current?.isActive(mark) ?? false} onClick={() => editorRef.current?.chain().focus().toggleMark(mark).run()}><Icon /></button>
                </Tip>
              ))}
              <span className="sep" />
              <Tip text="评论" side="top">
                <button className="ico" aria-label="评论" onClick={() => setBubble({ ...bubble, commenting: true })}><MessageSquare /></button>
              </Tip>
              {!limited && (
                <Tip text="加入 AI 对话" side="top">
                  <button className="ico" aria-label="加入 AI 对话" onClick={addSelectionToChat}><MessageSquarePlus /></button>
                </Tip>
              )}
              {!limited && <span className="sep" />}
              {!limited && (
                <Tip text="让 AI 修改选中的内容" side="top">
                  <button className="ai-trigger" aria-label="AI 修改" aria-expanded={!!bubble.ai} aria-pressed={!!bubble.ai} disabled={runs.running} onClick={() => setBubble({ ...bubble, ai: !bubble.ai })}><Sparkles /><span>AI</span><ChevronDown className="chev" /></button>
                </Tip>
              )}
              {!limited && bubble.ai && (
                <div className="bubble-ai" role="menu" aria-label="AI 修改">
                  {presets.filter((p) => p.id !== 'continue').map((p) => (
                    <button key={p.id} role="menuitem" onClick={() => runAi(p.id, '', p.label)}>{p.label}</button>
                  ))}
                  <span className="bubble-ai-sep" />
                  <button role="menuitem" onClick={() => setBubble({ ...bubble, ai: false, custom: true })}><PenLine />自定义指令…</button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {handle && !readOnly && shared?.role !== 'suggest' && view !== 'side' && (
        <div className="drag-handle" style={{ top: handle.top, left: handle.left, opacity: 1 }} draggable title="点击打开菜单，拖动移动这一段" onClick={openBlockMenu} onDragStart={startDrag} onDragEnd={() => setHandle(null)}><GripVertical className="size-4" /></div>
      )}
      {blockMenu && (() => {
        const b = topBlock(blockMenu.blockId)
        if (!b) return null
        const chars = b.node.textContent.replace(/\s/g, '').length
        return <BlockMenu x={blockMenu.x} y={blockMenu.y} sections={blockMenuSections(blockMenu.blockId)} footer={`${chars} 个字`} onClose={() => setBlockMenu(null)} />
      })()}
      <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => {
        const f = e.target.files?.[0]
        e.target.value = ''
        if (f) void uploadImage(f)
      }} />

      {slash && items.length > 0 && (
        <div className="slash" style={{ left: Math.min(slash.x, window.innerWidth - 296), top: slash.y }} onMouseDown={(e) => e.preventDefault()} role="listbox">
          {items.map((it, i) => (
            <button key={it.label} role="option" aria-selected={i === slash.index} onMouseEnter={() => setSlash({ ...slash, index: i })} onClick={() => pickSlash(i)}>
              <span>{it.label}</span>
              <span className="muted small">{it.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
    </TooltipProvider>
  )
}

function ShareDialog({ docId, onClose }: { docId: string; onClose: () => void }) {
  const [links, setLinks] = useState<{ token: string; role: string }[]>([])
  const [role, setRole] = useState('edit')
  const [copied, setCopied] = useState('')
  const load = (): Promise<void> => api<{ token: string; role: string }[]>(`/docs/${docId}/shares`).then(setLinks)
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])
  const url = (t: string): string => `${location.origin}/#/s/${t}`
  const names: Record<string, string> = { edit: '可编辑', suggest: '只能提建议', view: '只读' }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="分享" className="panel" description="拿到链接的人不需要账号。&quot;只能提建议&quot;的人所做的修改都会成为待你确认的修订。">
        <div className="row mt-2">
          <Select className="w-40" aria-label="权限" value={role} onValueChange={setRole} options={Object.entries(names).map(([k, v]) => ({ value: k, label: v }))} />
          <Button variant="default" onClick={async () => { await post(`/docs/${docId}/shares`, { role }); await load() }}>创建链接</Button>
        </div>
        <ul className="shares">
          {links.map((l) => (
            <li key={l.token}>
              <span className="chip">{names[l.role] ?? l.role}</span>
              <Input readOnly value={url(l.token)} aria-label="分享链接" className="h-7 flex-1 text-xs" onFocus={(e) => e.target.select()} />
              <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(url(l.token)); setCopied(l.token) }}>{copied === l.token ? '已复制' : '复制'}</Button>
              <Button size="sm" variant="destructive" onClick={async () => { await api(`/shares/${l.token}`, { method: 'DELETE' }); await load() }}>撤销</Button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
