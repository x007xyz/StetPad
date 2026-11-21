import { getLang } from './i18n'
import { addComment, blocks, blockIdOf, changesInBlock, decide, deleteComment, findBlock, footnotesOf, listChanges, listComments, listDecided, decideAndLog, type DecidedChange, projectBlocks, replyToComment, resolveComment, type CommentView, type PendingChange } from '@stetpad/crdt'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Editor } from '@tiptap/core'
import { editorExtensions, type EditorExtensionOptions } from './editor/extensions'
import type { Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection } from '@tiptap/pm/state'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { api, ApiError, collabUrl, download, getToken, notifyComment, post, printHtml, type DocMeta } from './api'
import { go } from './App'
import { ListChecks, ListTree, MessageSquare, MessageSquarePlus, Sparkles, AlignLeft, Columns2, ChevronDown, ChevronUp, Download, GripVertical, Ellipsis, FilePenLine, Bold as BoldIcon, Italic as ItalicIcon, Underline as UnderlineIcon, Strikethrough, Code as CodeIcon, Highlighter, Repeat2, Copy, ArrowUp, ArrowDown, Trash2, Type, Heading1, Heading2, Heading3, List, ListOrdered, ListTodo, Quote as QuoteIcon, StickyNote, SquareCode, PenLine, NotebookPen, Sigma } from 'lucide-react'
import { Button } from './components/ui/button'
import { confirmAction } from './components/confirm'
import { Dialog, SheetContent } from './components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './components/ui/dropdown-menu'
import { Tip, TooltipProvider } from './components/ui/tooltip'
import { useMedia } from './lib/useMedia'
import { cn } from './lib/utils'
import { SidebarToggle, useWorkspaceOptional } from './Shell'
import { addFootnote, FootnoteList, FootnotePopover, scrollToFootnote } from './editor/footnotes'
import { moveBlock, SLASH_ITEMS } from './editor/schema'
import { BlockMenu, type MenuAction, type MenuSection } from './editor/BlockMenu'
import { AiDiagramDialog, type AiDiagramInitial, type DialogKind } from './editor/AiDiagramDialog'
import { DrawioEditor } from './editor/DrawioEditor'
import { commitDrawio, DRAWIO_EDIT_EVENT, findTopBlock } from './editor/drawio'
import { AiImageDialog } from './editor/AiImageDialog'
import { VideoEmbedDialog, type VideoEmbed } from './editor/VideoEmbedDialog'
import { LinkCardDialog } from './editor/LinkCardDialog'
import { unfurlLink, type LinkCardAttrs } from './editor/linkcard'
import { AI_DIAGRAM_EVENT, AI_DIAGRAM_NEW_EVENT, rasterizeSvg, renderMermaid, type AiDiagramNewRequest, type AiDiagramRequest, type Raster } from './editor/diagram'
import { attachmentFiles, describeInBackground, FILE_ACCEPT, IMAGE_ACCEPT, IMAGE_ACTION_EVENT, VIDEO_ACCEPT, imageFiles, insertAttachment, insertImageAfter, insertImageFiles, insertVideoFile, posAfterBlock, replaceImageSrc, uploadFile, videoFiles, type ImageAction } from './editor/media'
import { AiImageEditDialog } from './editor/AiImageEditDialog'
import { ImageEditDialog } from './editor/ImageEditDialog'
import { anchorBetween } from './editor/tracked'
import { AiPanel, makeLabel, useRuns, type ContextItem } from './panels/Ai'
import { ChangesPanel } from './panels/Changes'
import { CommentsPanel } from './panels/Comments'
import { MentionInput } from './MentionInput'
import { DiffView, rowChanged, type DiffRow } from './panels/DiffView'
import { OutlineRail, readTocPinned, writeTocPinned } from './panels/Outline'
import { VersionsMenu } from './panels/Versions'

/** Where an upload from the slash menu or a paste goes: a top-level boundary, and whether an empty line before it is replaced. */
type InsertAt = { pos: number; replaceEmpty?: boolean }

/** The text as a web address when it is exactly one http(s) URL, else null. */
function webAddress(text: string | null | undefined): string | null {
  const t = (text ?? '').trim()
  return /^https?:\/\/\S+$/i.test(t) ? t : null
}

/** The top-level block with this id: where it starts and ends, and the node. */
function blockRange(doc: PMNode, blockId: string): { from: number; to: number; node: PMNode } | null {
  let offset = 0
  for (let i = 0; i < doc.childCount; i++) {
    const node = doc.child(i)
    if (node.attrs.blockId === blockId) return { from: offset, to: offset + node.nodeSize, node }
    offset += node.nodeSize
  }
  return null
}

const COLORS = ['#d9480f', '#2b8a3e', '#1971c2', '#9c36b5', '#c2255c', '#087f5b']

type View = 'inline' | 'side'
type Tab = 'changes' | 'comments' | 'ai'
interface Floating { x: number; y: number }

const AI_ITEM: (typeof SLASH_ITEMS)[number] = { label: 'AI 续写', hint: '接着上文往下写', type: '__ai', keys: 'ai xuxie continue' }

/** The document page's editor extensions. */
export const docEditorExtensions = (opts: Omit<EditorExtensionOptions, 'placeholder'>) =>
  editorExtensions({ ...opts, placeholder: getLang() === 'en' ? 'Type something, or type / to pick a block type' : '输入内容，或输入 / 选择块类型' })

export function DocPage({ id }: { id: string }) {
  const [meta, setMeta] = useState<DocMeta | null>(null)
  const [missing, setMissing] = useState(false)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting')
  const [ready, setReady] = useState(false)
  const [view, setView] = useState<View>('inline')
  const [tab, setTab] = useState<Tab>('changes')
  const [tocPinned, setTocPinned] = useState(readTocPinned)
  const [tracking, setTracking] = useState(false)
  // AI diagram dialog: `at` keys the dialog so each request starts fresh.
  // `afterBlockId`: insert the result after this block (a table's chart) instead of at the cursor.
  const [diagram, setDiagram] = useState<{ at: number; initial: AiDiagramInitial; context?: string; afterBlockId?: string } | null>(null)
  const [diagramOpen, setDiagramOpen] = useState(false)
  // The draw.io block being edited: its blockId and the XML it was opened with.
  const [drawioEdit, setDrawioEdit] = useState<{ blockId: string; xml: string } | null>(null)
  // AI image dialog: the insertion point and the document it was taken from.
  const [imageGenOpen, setImageGenOpen] = useState(false)
  // The image whose crop or AI edit dialog is open.
  const [imageEdit, setImageEdit] = useState<{ blockId: string; src: string; action: ImageAction } | null>(null)
  const imageGenAt = useRef<{ pos: number; doc: PMNode } | null>(null)
  const providerRef = useRef<HocuspocusProvider | null>(null)
  const [changes, setChanges] = useState<PendingChange[]>([])
  const [decided, setDecided] = useState<DecidedChange[]>([])
  const [commentList, setCommentList] = useState<CommentView[]>([])
  const [handle, setHandle] = useState<{ top: number; left: number; el: HTMLElement } | null>(null)
  const [blockMenu, setBlockMenu] = useState<{ x: number; y: number; blockId: string } | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const imageAt = useRef<{ from: number; to: number } | null>(null)
  // Video: the slash command's insertion point, the upload in flight, and the embed dialog.
  const videoInput = useRef<HTMLInputElement>(null)
  const videoAt = useRef<InsertAt | null>(null)
  // Attachments share the upload queue with videos. The file input and insertion point are kept apart.
  const attachInput = useRef<HTMLInputElement>(null)
  const attachAt = useRef<InsertAt | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const linkAt = useRef<{ pos: number; doc: PMNode } | null>(null)
  // The paste prompt: a web address pasted alone into an empty line can become a link card.
  const [linkPrompt, setLinkPrompt] = useState<{ blockId: string; url: string; x: number; y: number; busy: boolean; error: string } | null>(null)
  const offerLinkRef = useRef<(blockId: string, url: string) => void>(() => undefined)
  // Files waiting to upload (videos and attachments), one at a time, and the batch in progress.
  type UploadKind = 'video' | 'file'
  const uploadQueue = useRef<{ file: File; pos: number; replaceEmpty: boolean; kind: UploadKind }[]>([])
  const uploadRun = useRef<{ ctrl: AbortController | null; index: number; total: number; lastBlockId: string | null } | null>(null)
  const [upload, setUpload] = useState<{ name: string; fraction: number; index: number; total: number; kind: UploadKind } | null>(null)
  const [embedOpen, setEmbedOpen] = useState(false)
  const embedAt = useRef<{ pos: number; doc: PMNode } | null>(null)
  const [tick, setTick] = useState(0) // bumps when the document changes
  const [versionsKey, setVersionsKey] = useState(0)
  const [bubble, setBubble] = useState<(Floating & { custom: boolean; commenting?: boolean; ai?: boolean; footnote?: boolean }) | null>(null)
  const [fnNote, setFnNote] = useState('')
  const [fnPop, setFnPop] = useState<{ id: string; x: number; y: number; pinned: boolean } | null>(null)
  const fnTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fnOpenRef = useRef<(id: string, rect: DOMRect, pinned: boolean) => void>(() => {})
  const fnShortcutRef = useRef<() => void>(() => {})
  const fnLeaveRef = useRef<() => void>(() => {})
  const [slash, setSlash] = useState<(Floating & { query: string; index: number; from: number; above: number }) | null>(null)
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
  const author = '我'
  const ydoc = useMemo(() => new Y.Doc(), [id])

  const runs = useRuns(id, () => setVersionsKey((k) => k + 1))
  const runsRef = useRef(runs)
  runsRef.current = runs

  useEffect(() => {
    api<DocMeta>(`/docs/${id}`).then((m) => {
      setMeta(m)
      document.title = m.title
    }).catch(() => setMissing(true))
  }, [id])

  // --- sync
  useEffect(() => {
    // A local copy lets the page reopen and keep editing without a connection.
    const local = new IndexeddbPersistence(`aiw-${id}`, ydoc)
    const provider = new HocuspocusProvider({
      url: collabUrl(),
      name: id,
      document: ydoc,
      token: getToken(),
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
  }, [id, ydoc])

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

  /** Opens the draw.io editor for a block, with the block's current XML. */
  const openDrawio = useCallback((blockId: string): void => {
    const ed = editorRef.current
    if (!ed || !ed.isEditable) return
    const found = findTopBlock(ed.state.doc, blockId)
    if (!found || found.node.type.name !== 'drawio') return
    setDrawioEdit({ blockId, xml: String(found.node.attrs.xml ?? '') })
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
    } else if (item.type === '__video') {
      // The slash text goes now; the video lands after this line, which is replaced if it is left empty.
      ed.chain().focus().deleteRange(range).run()
      const $from = ed.state.selection.$from
      videoAt.current = { pos: $from.depth >= 1 ? $from.after(1) : $from.pos, replaceEmpty: true }
      videoInput.current?.click()
    } else if (item.type === '__video_embed') {
      ed.chain().focus().deleteRange(range).run()
      embedAt.current = { pos: ed.state.selection.from, doc: ed.state.doc }
      setEmbedOpen(true)
    } else if (item.type === '__file') {
      // Like a video: the slash text goes now, and the attachment lands after this line, which is replaced if left empty.
      ed.chain().focus().deleteRange(range).run()
      const $from = ed.state.selection.$from
      attachAt.current = { pos: $from.depth >= 1 ? $from.after(1) : $from.pos, replaceEmpty: true }
      attachInput.current?.click()
    } else if (item.type === '__link_card') {
      ed.chain().focus().deleteRange(range).run()
      linkAt.current = { pos: ed.state.selection.from, doc: ed.state.doc }
      setLinkOpen(true)
    } else if (item.type === '__ai_diagram') {
      ed.chain().focus().deleteRange(range).run()
      const context = textBefore(ed.state.doc, ed.state.selection.from)
      setDiagram({ at: Date.now(), initial: { kind: 'mermaid' }, context: context || undefined })
      setDiagramOpen(true)
    } else if (item.type === '__drawio') {
      ed.chain().focus().deleteRange(range).insertContent([{ type: 'drawio', attrs: { xml: '' } }, { type: 'paragraph' }]).run()
      // The new block sits just before the cursor's line; its blockId is set by the time the transaction lands.
      const idx = ed.state.selection.$from.index(0)
      for (let i = idx - 1; i >= Math.max(0, idx - 2); i--) {
        const node = ed.state.doc.child(i)
        if (node.type.name === 'drawio' && node.attrs.blockId) {
          openDrawio(String(node.attrs.blockId))
          break
        }
      }
    } else if (item.type === '__ai_image') {
      ed.chain().focus().deleteRange(range).run()
      imageGenAt.current = { pos: ed.state.selection.from, doc: ed.state.doc }
      setImageGenOpen(true)
    } else if (item.type === 'divider' || item.type === 'table') {
      ed.chain().focus().deleteRange(range).insertContent([{ type: item.type }, { type: 'paragraph' }]).run()
    } else {
      ed.chain().focus().deleteRange(range).setNode(item.type, item.attrs).run()
    }
  }, [slashItems, openDrawio])
  const pickRef = useRef(pickSlash)
  pickRef.current = pickSlash

  /**
   * Uploads the queued files (videos and attachments) one at a time. Each lands after the one before it, so a
   * batch keeps its order. The pill shows the file in flight and its place in the batch; cancelling drops the rest.
   */
  const pumpUploads = (): void => {
    const ed = editorRef.current
    const run = uploadRun.current
    if (!run) return
    const job = uploadQueue.current.shift()
    if (!job || !ed) {
      uploadRun.current = null
      setUpload(null)
      return
    }
    const ctrl = new AbortController()
    run.ctrl = ctrl
    run.index++
    setUpload({ name: job.file.name, fraction: 0, index: run.index, total: run.total, kind: job.kind })
    const pos = run.lastBlockId ? posAfterBlock(ed, run.lastBlockId) : job.pos
    const onProgress = (fraction: number): void => setUpload((u) => (u ? { ...u, fraction } : u))
    const replace = job.replaceEmpty && !run.lastBlockId
    ;(job.kind === 'video'
      ? insertVideoFile(ed, id, job.file, pos, onProgress, ctrl.signal, replace)
      : insertAttachment(ed, id, job.file, pos, onProgress, ctrl.signal, replace))
      .then((blockId) => {
        run.lastBlockId = blockId
        pumpUploads()
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) alert(e instanceof Error ? e.message : '上传失败')
        uploadQueue.current = []
        if (uploadRun.current === run) {
          uploadRun.current = null
          setUpload(null)
        }
      })
  }

  /** Queues these files at the spot; a batch already uploading takes them after its last file. */
  const startUploads = (files: File[], at: InsertAt, kind: UploadKind): void => {
    if (!files.length || !editorRef.current) return
    uploadQueue.current.push(...files.map((file, i) => ({ file, pos: at.pos, replaceEmpty: !!at.replaceEmpty && i === 0, kind })))
    const run = uploadRun.current
    if (run) {
      run.total += files.length
      setUpload((u) => (u ? { ...u, total: run.total } : u))
      return
    }
    uploadRun.current = { ctrl: null, index: 0, total: files.length, lastBlockId: null }
    pumpUploads()
  }
  /** Stops the batch: the file in flight is cancelled and the rest of the queue is dropped. */
  const cancelUploads = (): void => {
    uploadQueue.current = []
    uploadRun.current?.ctrl?.abort()
  }
  const startUploadsRef = useRef(startUploads)
  startUploadsRef.current = startUploads

  useEffect(() => {
    if (!ready || !mount.current) return
    const editor = new Editor({
      element: mount.current,
      extensions: docEditorExtensions({
        ydoc, docId: id,
        user: () => ({ author, tracking: trackingRef.current }),
        footnote: { onOpen: (id, rect, pinned) => fnOpenRef.current(id, rect, pinned), onLeave: () => fnLeaveRef.current(), onShortcut: () => fnShortcutRef.current() },
        caret: providerRef.current ? { provider: providerRef.current, user: { name: author, color: COLORS[Math.floor(Math.random() * COLORS.length)]! } } : undefined,
      }),
      editorProps: {
        attributes: { class: 'prose', spellcheck: 'false' },
        // Pasted images go in after the current block; plain paste is left alone.
        handlePaste(view, event) {
          const ed = editorRef.current
          if (!ed || !ed.isEditable) return false
          const files = imageFiles(event.clipboardData?.files)
          const videos = videoFiles(event.clipboardData?.files)
          const attachments = attachmentFiles(event.clipboardData?.files)
          if (!files.length && !videos.length && !attachments.length) {
            // The text pastes as usual; a lone web address in an empty line may then be offered as a link card.
            const { $from, empty } = view.state.selection
            const url = webAddress(event.clipboardData?.getData('text/plain'))
            if (url && empty && $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0 && $from.parent.attrs.blockId) {
              const blockId = String($from.parent.attrs.blockId)
              setTimeout(() => offerLinkRef.current(blockId, url), 0)
            }
            return false
          }
          event.preventDefault()
          const $from = view.state.selection.$from
          const pos = $from.depth >= 1 ? $from.after(1) : $from.pos
          if (files.length) insertImageFiles(ed, id, files, pos).catch((e: unknown) => alert(e instanceof Error ? e.message : '上传失败'))
          if (videos.length) startUploadsRef.current(videos, { pos }, 'video')
          if (attachments.length) startUploadsRef.current(attachments, { pos }, 'file')
          return true
        },
        // Dropped images go in at the nearest top-level block boundary; moving a block is left alone.
        handleDrop(view, event, _slice, moved) {
          const ed = editorRef.current
          if (moved || !ed || !ed.isEditable) return false
          const files = imageFiles(event.dataTransfer?.files)
          const videos = videoFiles(event.dataTransfer?.files)
          const attachments = attachmentFiles(event.dataTransfer?.files)
          if (!files.length && !videos.length && !attachments.length) return false
          event.preventDefault()
          const hit = view.posAtCoords({ left: event.clientX, top: event.clientY })
          const $pos = view.state.doc.resolve(hit ? hit.pos : view.state.selection.from)
          const pos = $pos.depth >= 1 ? $pos.after(1) : $pos.pos
          if (files.length) insertImageFiles(ed, id, files, pos).catch((e: unknown) => alert(e instanceof Error ? e.message : '上传失败'))
          if (videos.length) startUploadsRef.current(videos, { pos }, 'video')
          if (attachments.length) startUploadsRef.current(attachments, { pos }, 'file')
          return true
        },
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
        setSlash({ x: c.left, y: c.bottom + 6, above: c.top - 6, query: m[1]!, index: prev && prev.query === m[1] ? prev.index : 0, from: $from.start() })
      } else if (slashRef.current) setSlash(null)
      // Selection toolbar.
      if (!empty && editor.isFocused && !v.composing) {
        const a = v.coordsAtPos(from)
        const b = v.coordsAtPos(to)
        setBubble((cur) => ({ x: (a.left + b.right) / 2, y: Math.min(a.top, b.top) - 8, custom: cur?.custom ?? false, commenting: cur?.commenting ?? false, ai: cur?.ai ?? false, footnote: cur?.footnote ?? false }))
      } else setBubble((cur) => (cur?.custom || cur?.commenting || cur?.footnote ? cur : null))
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
  }, [ready, ydoc, author, slashItems])

  const uploadImage = async (file: File): Promise<void> => {
    const ed = editorRef.current
    const range = imageAt.current
    imageAt.current = null
    if (!ed) return
    try {
      const url = await uploadFile(id, file)
      const chain = ed.chain().focus()
      if (range) chain.deleteRange(range)
      chain.insertContent([{ type: 'image', attrs: { src: url, alt: file.name } }, { type: 'paragraph' }]).run()
      describeInBackground(ed, id, url, file.name)
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
    const el = (e.target as HTMLElement).closest?.('.prose > *') as HTMLElement | null
    if (!el) return
    const r = el.getBoundingClientRect()
    if (!handle || handle.el !== el) setHandle({ top: r.top + 2, left: r.left - 24, el })
  }

  // Footnotes: number popover, note input (bubble) and the references list.
  const openFootnote = (id: string, rect: DOMRect, pinned: boolean): void => {
    if (fnTimer.current) clearTimeout(fnTimer.current)
    setFnPop({ id, x: rect.left, y: rect.bottom + 6, pinned })
  }
  const leaveFootnote = (): void => {
    if (fnTimer.current) clearTimeout(fnTimer.current)
    fnTimer.current = setTimeout(() => setFnPop((cur) => (cur && !cur.pinned ? null : cur)), 250)
  }
  const keepFootnote = (): void => {
    if (fnTimer.current) clearTimeout(fnTimer.current)
  }
  fnOpenRef.current = openFootnote
  fnLeaveRef.current = leaveFootnote
  fnShortcutRef.current = () => setBubble((cur) => (cur ? { ...cur, footnote: true } : cur))
  const footnotes = useMemo(() => footnotesOf(projectBlocks(ydoc, 'revised')), [ydoc, tick])
  const submitFootnote = (note: string): void => {
    const ed = editorRef.current
    if (!ed || !addFootnote(ed, note)) return
    setBubble(null)
    setFnNote('')
  }

  // "@AI" in a comment: a short notice that the answer will appear under it.
  const [aiHint, setAiHint] = useState(false)
  const aiHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashAiHint = (): void => {
    setAiHint(true)
    if (aiHintTimer.current) clearTimeout(aiHintTimer.current)
    aiHintTimer.current = setTimeout(() => setAiHint(false), 6000)
  }
  useEffect(() => () => {
    if (aiHintTimer.current) clearTimeout(aiHintTimer.current)
  }, [])

  const submitComment = (text: string): void => {
    const ed = editorRef.current
    if (!ed || !text.trim()) return
    const { from, to } = ed.state.selection
    const cid = addComment(ydoc, anchorBetween(ydoc, ed.state.doc, from, to), author, text.trim())
    void notifyComment(id, cid).then((ai) => { if (ai) flashAiHint() })
    setBubble(null)
    setCustom('')
    showTab('comments')
  }
  const replyComment = (cid: string, text: string): void => {
    // The new reply's index is the count before it is pushed.
    const before = listComments(ydoc).find((c) => c.id === cid)?.replies.length ?? 0
    if (!replyToComment(ydoc, cid, author, text)) return
    void notifyComment(id, cid, before).then((ai) => { if (ai) flashAiHint() })
  }

  // Deep links to a comment: #/d/<doc>?comment=<cid>. Read on load and on every hash change.
  const [linkCid, setLinkCid] = useState<{ cid: string; n: number } | null>(null)
  const [focusedCid, setFocusedCid] = useState<string | null>(null)
  const handledLink = useRef(0)
  useEffect(() => {
    let n = 0
    const read = (): void => {
      if (!location.hash.startsWith(`#/d/${id}?`)) return
      const cid = location.hash.match(/[?&]comment=([\w-]+)/)?.[1]
      if (cid) setLinkCid({ cid, n: ++n })
    }
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [id])
  useEffect(() => {
    // Waits until the comments have loaded, then opens the panel once per link.
    if (!linkCid || !ready || linkCid.n === handledLink.current) return
    if (!commentList.some((c) => c.id === linkCid.cid)) return
    handledLink.current = linkCid.n
    setFocusedCid(linkCid.cid)
    showTab('comments')
    focusComment(linkCid.cid)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkCid, ready, commentList])
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
  // --- actions
  const decideMany = useCallback((ids: string[], d: 'accept' | 'reject') => {
    const text = (bid: string): string => projectBlocks(ydoc, 'physical').find((b) => b.blockId === bid)?.text ?? ''
    decideAndLog(ydoc, listChanges(ydoc), ids, d, text)
  }, [ydoc])

  // When the last pending change is handled, keep that state as a version.
  const hadChanges = useRef(false)
  useEffect(() => {
    if (changes.length > 0) hadChanges.current = true
    else if (hadChanges.current && !runs.running) {
      hadChanges.current = false
      const t = setTimeout(() => void post(`/docs/${id}/versions`, { trigger: 'reviewed' }).then(() => setVersionsKey((k) => k + 1)), 1200)
      return () => clearTimeout(t)
    }
  }, [changes.length, runs.running, id])

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
    return sections
  }

  const rename = async (title: string): Promise<void> => {
    if (!meta || title === meta.title) return
    await api(`/docs/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) })
    setMeta({ ...meta, title: title.trim() || '未命名文档' })
    document.title = title
    void workspace?.reload()
  }

  /** Inserts a generated diagram at the cursor, or replaces the source of the block in fix mode. */
  const insertDiagram = useCallback((kind: DialogKind, source: string, blockId?: string): void => {
    const ed = editorRef.current
    if (!ed) return
    if (kind === 'drawio') {
      // The preview is drawn by the block's node view once it is in the document.
      ed.chain().focus().insertContent([{ type: 'drawio', attrs: { xml: source } }, { type: 'paragraph' }]).run()
      return
    }
    const { doc, schema } = ed.state
    let at = -1
    if (blockId) doc.forEach((child, offset) => {
      if (at < 0 && child.type.name === 'codeBlock' && child.attrs.blockId === blockId) at = offset
    })
    if (at >= 0) {
      const block = doc.nodeAt(at)!
      // Same size, so the content positions below stay valid after the attribute change.
      let tr = ed.state.tr.setNodeMarkup(at, undefined, { ...block.attrs, language: kind })
      const from = at + 1
      const to = at + block.nodeSize - 1
      tr = source ? tr.replaceWith(from, to, schema.text(source)) : tr.delete(from, to)
      ed.view.dispatch(tr.scrollIntoView())
      return
    }
    ed.chain().focus().insertContent([
      { type: 'codeBlock', attrs: { language: kind }, content: source ? [{ type: 'text', text: source }] : undefined },
      { type: 'paragraph' },
    ]).run()
  }, [])

  /** Inserts a generated diagram as a new block right after the block with `blockId`. Falls back to the cursor. */
  const insertDiagramAfter = useCallback((blockId: string, kind: DialogKind, source: string): void => {
    const ed = editorRef.current
    if (!ed || !ed.isEditable) return
    const found = findTopBlock(ed.state.doc, blockId)
    if (!found) {
      insertDiagram(kind, source)
      return
    }
    const at = found.pos + found.node.nodeSize
    const node = kind === 'drawio'
      ? { type: 'drawio', attrs: { xml: source } }
      : { type: 'codeBlock', attrs: { language: kind }, content: source ? [{ type: 'text', text: source }] : undefined }
    ed.chain().insertContentAt(at, node).run()
  }, [insertDiagram])

  /** Saves the draw.io XML and its preview into the block, in one transaction. */
  const saveDrawio = useCallback((blockId: string, xml: string, preview: string): void => {
    const ed = editorRef.current
    if (!ed || !ed.isEditable) return
    if (!commitDrawio(ed, blockId, xml, preview)) alert('找不到这个图，修改未保存到文档')
  }, [])

  /** Inserts at the point the slash command left; if the document changed meanwhile, at the current selection. */
  const insertAiImage = useCallback((img: { url: string; alt: string }): void => {
    const ed = editorRef.current
    if (!ed) return
    const saved = imageGenAt.current
    imageGenAt.current = null
    const chain = ed.chain().focus()
    if (saved && ed.state.doc.eq(saved.doc)) chain.setTextSelection(saved.pos)
    chain.insertContent([{ type: 'image', attrs: { src: img.url, alt: img.alt } }, { type: 'paragraph' }]).run()
    // The alt is the prompt the image was made from; a model's description replaces it if it is still unchanged.
    describeInBackground(ed, id, img.url, img.alt)
  }, [])

  /** Like insertAiImage: at the slash command's line if the document has not changed since. */
  const insertVideoEmbed = useCallback((v: VideoEmbed): void => {
    const ed = editorRef.current
    if (!ed) return
    const saved = embedAt.current
    embedAt.current = null
    const chain = ed.chain().focus()
    if (saved && ed.state.doc.eq(saved.doc)) chain.setTextSelection(saved.pos)
    chain.insertContent([{ type: 'video', attrs: { src: v.src, kind: 'embed', title: v.title } }, { type: 'paragraph' }]).run()
  }, [])

  // The crop and AI edit buttons of an image open their dialog for it.
  useEffect(() => {
    const onAction = (e: Event): void => {
      const d = (e as CustomEvent<{ blockId?: string; src?: string; action?: ImageAction }>).detail
      if (d?.blockId && d.src && d.action) setImageEdit({ blockId: d.blockId, src: d.src, action: d.action })
    }
    window.addEventListener(IMAGE_ACTION_EVENT, onAction)
    return () => window.removeEventListener(IMAGE_ACTION_EVENT, onAction)
  }, [])

  /** Swaps the file of an image block. The alt, caption and width stay. */
  const swapImage = useCallback((blockId: string, url: string): void => {
    const ed = editorRef.current
    if (!ed || !ed.isEditable) return
    if (!replaceImageSrc(ed, blockId, url)) alert('找不到这张图片，修改未保存到文档')
  }, [])

  /** Adds the edited picture as a new image after the original, and describes it in the background. */
  const addImageAfter = useCallback((blockId: string, url: string, alt: string): void => {
    const ed = editorRef.current
    if (!ed || !ed.isEditable) return
    if (!insertImageAfter(ed, blockId, url, alt)) alert('找不到这张图片，未能插入')
    else describeInBackground(ed, id, url, alt)
  }, [id])

  /** The URL dialog's card goes at the slash command's line, as the video embed does. */
  const insertLinkCard = useCallback((card: LinkCardAttrs): void => {
    const ed = editorRef.current
    if (!ed) return
    const saved = linkAt.current
    linkAt.current = null
    const chain = ed.chain().focus()
    if (saved && ed.state.doc.eq(saved.doc)) chain.setTextSelection(saved.pos)
    chain.insertContent([{ type: 'linkCard', attrs: { ...card } }, { type: 'paragraph' }]).run()
  }, [])

  /** Shows the link prompt after a paste, if the line still holds exactly that address. */
  const offerLinkCard = useCallback((blockId: string, url: string): void => {
    const ed = editorRef.current
    if (!ed || !ed.isEditable) return
    const at = blockRange(ed.state.doc, blockId)
    if (!at || at.node.textContent !== url) return
    const c = ed.view.coordsAtPos(ed.state.selection.from)
    setLinkPrompt({ blockId, url, x: c.left, y: c.bottom + 6, busy: false, error: '' })
  }, [])
  offerLinkRef.current = offerLinkCard

  // The prompt hides itself after 8 seconds, unless a conversion is under way.
  useEffect(() => {
    if (!linkPrompt || linkPrompt.busy) return
    const t = window.setTimeout(() => setLinkPrompt(null), 8000)
    return () => window.clearTimeout(t)
  }, [linkPrompt])

  /** 转换: the page is read, and the line becomes a link card if it still holds the address. */
  const convertLink = async (): Promise<void> => {
    const pending = linkPrompt
    if (!pending) return
    setLinkPrompt({ ...pending, busy: true, error: '' })
    try {
      const card = await unfurlLink(id, pending.url)
      const ed = editorRef.current
      const at = ed ? blockRange(ed.state.doc, pending.blockId) : null
      if (!ed || !at || !ed.isEditable || at.node.textContent !== pending.url) {
        setLinkPrompt({ ...pending, busy: false, error: '这一行已经改动，未生成卡片' })
        return
      }
      ed.chain().insertContentAt({ from: at.from, to: at.to }, { type: 'linkCard', attrs: { ...card } }).run()
      setLinkPrompt(null)
    } catch (e) {
      setLinkPrompt({ ...pending, busy: false, error: e instanceof Error ? e.message : '获取网页信息失败' })
    }
  }

  // The edit button and double-click on a draw.io block open the editor for it.
  useEffect(() => {
    const onEdit = (e: Event): void => {
      const blockId = (e as CustomEvent<{ blockId?: string }>).detail?.blockId
      if (blockId) openDrawio(blockId)
    }
    window.addEventListener(DRAWIO_EDIT_EVENT, onEdit)
    return () => window.removeEventListener(DRAWIO_EDIT_EVENT, onEdit)
  }, [openDrawio])

  // A "AI 修复" button on a diagram that failed to render opens the dialog in fix mode.
  useEffect(() => {
    const onFix = (e: Event): void => {
      const d = (e as CustomEvent<AiDiagramRequest>).detail
      setDiagram({ at: Date.now(), initial: { kind: d.kind, previous: d.previous, error: d.error, blockId: d.blockId } })
      setDiagramOpen(true)
    }
    window.addEventListener(AI_DIAGRAM_EVENT, onFix)
    return () => window.removeEventListener(AI_DIAGRAM_EVENT, onFix)
  }, [])

  // A "生成图表" button on a table opens the dialog preset to a chart of the table's data.
  useEffect(() => {
    const onNew = (e: Event): void => {
      const d = (e as CustomEvent<AiDiagramNewRequest>).detail
      if (!d) return
      setDiagram({ at: Date.now(), initial: { kind: d.kind, prompt: d.prompt }, context: d.context || undefined, afterBlockId: d.afterBlockId })
      setDiagramOpen(true)
    }
    window.addEventListener(AI_DIAGRAM_NEW_EVENT, onNew)
    return () => window.removeEventListener(AI_DIAGRAM_NEW_EVENT, onNew)
  }, [])

  /**
   * POST export. Every mermaid diagram of the view is drawn here in the light theme (off the page), so both views
   * export the same pictures; a diagram that fails to draw is left out and the server falls back to its cache.
   */
  const exportPost = async (format: 'html' | 'docx', which: 'revised' | 'original'): Promise<Response> => {
    const { diagrams } = await api<{ diagrams: { blockId: string; source: string }[] }>(`/docs/${id}/export/diagrams?view=${which}`)
    const renders: Record<string, string> = {}
    const rasters: Record<string, Raster> = {}
    for (const d of diagrams) {
      try {
        const svg = await renderMermaid(d.source, { light: true })
        renders[d.blockId] = svg
        if (format === 'docx') {
          const r = await rasterizeSvg(svg)
          if (r) rasters[d.blockId] = r
        }
      } catch {
        // A syntax error or a draw failure: no picture for this block.
      }
    }
    const res = await fetch(`/api/docs/${id}/export`, {
      method: 'POST',
      headers: { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ format, view: which, renders, rasters: format === 'docx' ? rasters : undefined }),
    })
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null
      throw new ApiError(res.status, j?.error ?? `请求失败（${res.status}）`)
    }
    return res
  }

  /** The document package: a zip with the text, every version and the files. Videos are optional when there are any. */
  const exportPackage = async (): Promise<void> => {
    const name = (meta?.title ?? 'document').replace(/[\\/:*?"<>|]/g, '_')
    const info = await api<{ images: { count: number; bytes: number }; videos: { count: number; bytes: number } }>(`/docs/${id}/package/info`)
    let videos = true
    if (info.videos.count > 0) {
      const mb = (info.videos.bytes / 1024 / 1024).toFixed(1)
      const choice = await confirmAction({
        title: '导出时包含视频？',
        body: `文档包含 ${info.videos.count} 个视频（共 ${mb} MB）。图片始终会导出。`,
        confirmLabel: '包含视频',
        cancelLabel: '不含视频',
      })
      if (choice === null) return
      videos = choice
    }
    const res = await fetch(`/api/docs/${id}/package?videos=${videos ? 1 : 0}`, { headers: { authorization: `Bearer ${getToken()}` } })
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null
      throw new ApiError(res.status, j?.error ?? `请求失败（${res.status}）`)
    }
    download(`${name}.stetpad`, await res.blob(), '')
  }

  const doExport = async (format: 'md' | 'html' | 'package' | 'docx' | 'pdf', which: 'revised' | 'original'): Promise<void> => {
    const name = (meta?.title ?? 'document').replace(/[\\/:*?"<>|]/g, '_')
    if (format === 'package') return exportPackage()
    if (format === 'docx') return download(`${name}.docx`, await (await exportPost('docx', which)).blob(), '')
    if (format === 'html') return download(`${name}.html`, await (await exportPost('html', which)).text(), 'text/html')
    if (format === 'pdf') return printHtml(await (await exportPost('html', which)).text())
    const body = await api<string>(`/docs/${id}/export?format=${format}&view=${which}`)
    download(`${name}.${format}`, body, format === 'md' ? 'text/markdown' : 'text/html')
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
      if (ids.length) {
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
  }, [view, tick, ydoc, decideMany])

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
  const closeIfNarrow = (): void => {
    if (narrow) setPanelOpen(false)
  }
  const panelButtons: [Tab, string, typeof Sparkles, number | boolean][] = [['changes', '修订', ListChecks, changes.length], ['comments', '评论', MessageSquare, unresolved]]

  const panel = (
    <div className="panel flex min-h-0 flex-1 flex-col">
      {tab === 'changes' && <ChangesPanel changes={changes} blockText={blockTextOf} onDecide={decideMany} onFocus={(cid) => { closeIfNarrow(); focusChange(cid) }} />}
      {tab === 'comments' && <CommentsPanel list={commentList} focusId={focusedCid} aiHint={aiHint} onFocus={(cid) => { closeIfNarrow(); focusComment(cid) }} onReply={replyComment} onResolve={(cid, r) => resolveComment(ydoc, cid, r)} onDelete={(cid) => deleteComment(ydoc, cid)} />}
      {tab === 'ai' && <AiPanel docId={id} runs={runs} refs={refs} setRefs={setRefs} comments={commentList} focusSignal={focusSignal} listBlocks={() => projectBlocks(ydoc, 'revised').map((b) => ({ blockId: b.blockId, text: b.text }))} changes={changes} decided={decided} blockText={blockTextOf} onDecide={decideMany} onFocus={(cid) => { closeIfNarrow(); focusChange(cid) }} />}
    </div>
  )

  const exportItems: [string, 'md' | 'html' | 'package' | 'docx' | 'pdf', 'revised' | 'original', boolean][] = [
    [`Markdown${changes.length ? '（按修改稿）' : ''}`, 'md', 'revised', true],
    ['Markdown（按原文）', 'md', 'original', changes.length > 0],
    [`HTML${changes.length ? '（按修改稿）' : ''}`, 'html', 'revised', true],
    ['HTML（按原文）', 'html', 'original', changes.length > 0],
    [`Word${changes.length ? '（按修改稿）' : ''}`, 'docx', 'revised', true],
    ['Word（按原文）', 'docx', 'original', changes.length > 0],
    [`PDF（打印）${changes.length ? '（按修改稿）' : ''}`, 'pdf', 'revised', true],
    ['文档包（含图片、视频和全部版本）', 'package', 'revised', true],
  ]

  return (
    <TooltipProvider>
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-background px-3 py-1.5">
        {/* Left: where am I */}
        <SidebarToggle />
        <input className="min-w-0 flex-1 basis-40 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-semibold outline-none hover:bg-accent focus:border-ring focus:bg-background" aria-label="文档标题" defaultValue={meta?.title ?? ''} key={meta?.title} onBlur={(e) => rename(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
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
          <Tip text={tracking ? '修订模式已开启：你的修改会记为修订，确认后才生效' : '修订模式已关闭：直接修改正文。点击开启后修改会留痕'}>
            {/* span so the tip still shows when the button is disabled */}
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="icon"
                className={cn('size-7', tracking ? 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary' : 'text-muted-foreground')}
                aria-label="修订模式"
                aria-pressed={tracking}
                onClick={() => setTracking((t) => !t)}
              >
                <FilePenLine />
              </Button>
            </span>
          </Tip>
          {changes.length > 0 && (
            <span className="flex items-center">
              <Tip text="上一处修订"><Button variant="ghost" size="icon" className="size-7" onClick={() => jump(-1)} aria-label="上一处修订"><ChevronUp /></Button></Tip>
              <Tip text="下一处修订"><Button variant="ghost" size="icon" className="size-7" onClick={() => jump(1)} aria-label="下一处修订"><ChevronDown /></Button></Tip>
            </span>
          )}
        </div>

        {/* Document actions: wide screens get icon buttons, narrow ones a "更多" menu */}
        <span aria-hidden className="mx-0.5 h-4 w-px bg-border max-sm:hidden" />
        <div role="group" aria-label="文档操作" className="flex items-center gap-0.5">
          <VersionsMenu docId={id} refreshKey={versionsKey} current={() => projectBlocks(ydoc, 'revised')} />
          <DropdownMenu>
            <Tip text="导出"><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7 text-muted-foreground max-sm:hidden" aria-label="导出"><Download /></Button></DropdownMenuTrigger></Tip>
            <DropdownMenuContent align="end">
              {exportItems.filter(([, , , show]) => show).map(([label, f, which]) => (
                <DropdownMenuItem key={label} onSelect={() => void doExport(f, which)}>{label}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7 text-muted-foreground sm:hidden" aria-label="更多"><Ellipsis /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {exportItems.filter(([, , , show]) => show).map(([label, f, which]) => (
                <DropdownMenuItem key={label} onSelect={() => void doExport(f, which)}>导出 {label}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
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
          {panelButtons.map(([t, label, Icon, badge]) => {
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
            {view !== 'side' && <FootnoteList notes={footnotes} onJump={(id) => scrollToFootnote(mount.current, id)} />}
            {fnPop && editorRef.current && view !== 'side' && (
              <FootnotePopover
                key={fnPop.id}
                editor={editorRef.current}
                id={fnPop.id}
                x={fnPop.x}
                y={fnPop.y}
                onEnter={keepFootnote}
                onLeave={leaveFootnote}
                onClose={() => setFnPop(null)}
              />
            )}
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
          {(() => {
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


      <AiDiagramDialog
        key={diagram?.at ?? 0}
        docId={id}
        open={diagramOpen}
        initial={diagram?.initial}
        context={diagram?.context}
        onClose={() => setDiagramOpen(false)}
        onInsert={(kind, source, blockId) =>
          diagram?.afterBlockId ? insertDiagramAfter(diagram.afterBlockId, kind, source) : insertDiagram(kind, source, blockId)
        }
      />

      <DrawioEditor
        open={!!drawioEdit}
        docId={id}
        blockId={drawioEdit?.blockId ?? null}
        xml={drawioEdit?.xml ?? ''}
        onClose={() => setDrawioEdit(null)}
        onSaved={saveDrawio}
      />

      <ImageEditDialog
        docId={id}
        src={imageEdit?.action === 'crop' ? imageEdit.src : ''}
        open={imageEdit?.action === 'crop'}
        onClose={() => setImageEdit(null)}
        onSaved={(url) => {
          const target = imageEdit
          setImageEdit(null)
          if (target) swapImage(target.blockId, url)
        }}
      />

      <AiImageEditDialog
        docId={id}
        src={imageEdit?.action === 'ai-edit' ? imageEdit.src : ''}
        open={imageEdit?.action === 'ai-edit'}
        onClose={() => setImageEdit(null)}
        onReplace={(url) => {
          const target = imageEdit
          if (target) swapImage(target.blockId, url)
        }}
        onInsert={(url, alt) => {
          const target = imageEdit
          if (target) addImageAfter(target.blockId, url, alt)
        }}
      />

      <AiImageDialog
        docId={id}
        open={imageGenOpen}
        onClose={() => setImageGenOpen(false)}
        onInsert={insertAiImage}
      />

      {bubble && view !== 'side' && (
        <div className="bubble" style={{ left: bubble.x, top: bubble.y }} onMouseDown={(e) => (e.target as HTMLElement).tagName !== 'INPUT' && e.preventDefault()}>
          {bubble.commenting ? (
            <form className="row" onSubmit={(e) => { e.preventDefault(); submitComment(custom) }}>
              <MentionInput autoFocus value={custom} placeholder="写下评论，@ 可提及他人或 AI" aria-label="评论" onChange={setCustom} onKeyDown={(e) => e.key === 'Escape' && setBubble(null)} onBlur={() => !custom && setBubble(null)} />
              <button className="primary" disabled={!custom.trim()}>评论</button>
            </form>
          ) : bubble.footnote ? (
            <form className="row" onSubmit={(e) => { e.preventDefault(); submitFootnote(fnNote) }}>
              <input autoFocus value={fnNote} placeholder="脚注内容" aria-label="脚注内容" onChange={(e) => setFnNote(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setBubble(null)} onBlur={() => !fnNote && setBubble(null)} />
              <button className="primary" disabled={!fnNote.trim()}>添加脚注</button>
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
              <Tip text="行内公式" side="top">
                <button className="ico" aria-label="行内公式" aria-pressed={editorRef.current?.isActive('math') ?? false} onClick={() => editorRef.current?.chain().focus().toggleMark('math').run()}><Sigma /></button>
              </Tip>
              <Tip text="评论" side="top">
                <button className="ico" aria-label="评论" onClick={() => setBubble({ ...bubble, commenting: true })}><MessageSquare /></button>
              </Tip>
              <Tip text="添加脚注 ⌘⌥F" side="top">
                <button className="ico" aria-label="添加脚注" disabled={editorRef.current?.isActive('footnote') ?? false} onClick={() => { setFnNote(''); setBubble({ ...bubble, footnote: true }) }}><NotebookPen /></button>
              </Tip>
              <Tip text="加入 AI 对话" side="top">
                <button className="ico" aria-label="加入 AI 对话" onClick={addSelectionToChat}><MessageSquarePlus /></button>
              </Tip>
              <Tip text="让 AI 修改选中的内容" side="top">
                <button className="ai-trigger" aria-label="AI 修改" aria-expanded={!!bubble.ai} aria-pressed={!!bubble.ai} disabled={runs.running} onClick={() => setBubble({ ...bubble, ai: !bubble.ai })}><Sparkles /><span>AI</span><ChevronDown className="chev" /></button>
              </Tip>
              {bubble.ai && (
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

      {handle && view !== 'side' && (
        <div className="drag-handle" style={{ top: handle.top, left: handle.left, opacity: 1 }} draggable title="点击打开菜单，拖动移动这一段" onClick={openBlockMenu} onDragStart={startDrag} onDragEnd={() => setHandle(null)}><GripVertical className="size-4" /></div>
      )}
      {blockMenu && (() => {
        const b = topBlock(blockMenu.blockId)
        if (!b) return null
        const chars = b.node.textContent.replace(/\s/g, '').length
        return <BlockMenu x={blockMenu.x} y={blockMenu.y} sections={blockMenuSections(blockMenu.blockId)} footer={`${chars} 个字`} onClose={() => setBlockMenu(null)} />
      })()}
      <input ref={imageInput} type="file" accept={IMAGE_ACCEPT} hidden onChange={(e) => {
        const f = e.target.files?.[0]
        e.target.value = ''
        if (f) void uploadImage(f)
      }} />
      <input ref={videoInput} type="file" accept={VIDEO_ACCEPT} multiple hidden onChange={(e) => {
        const files = Array.from(e.target.files ?? [])
        e.target.value = ''
        const at = videoAt.current
        videoAt.current = null
        if (files.length && at) startUploadsRef.current(files, at, 'video')
      }} />
      <input ref={attachInput} type="file" accept={FILE_ACCEPT} multiple hidden onChange={(e) => {
        const files = Array.from(e.target.files ?? [])
        e.target.value = ''
        const at = attachAt.current
        attachAt.current = null
        if (files.length && at) startUploadsRef.current(files, at, 'file')
      }} />

      <VideoEmbedDialog
        open={embedOpen}
        onClose={() => {
          embedAt.current = null
          setEmbedOpen(false)
        }}
        onInsert={insertVideoEmbed}
      />

      <LinkCardDialog
        docId={id}
        open={linkOpen}
        onClose={() => {
          linkAt.current = null
          setLinkOpen(false)
        }}
        onInsert={insertLinkCard}
      />

      {linkPrompt && (
        <div className="link-prompt" role="dialog" aria-label="转为链接卡片" style={{ left: Math.min(linkPrompt.x, window.innerWidth - 260), top: linkPrompt.y }}>
          <span>{linkPrompt.error || (linkPrompt.busy ? '正在生成卡片…' : '转为链接卡片？')}</span>
          <button type="button" disabled={linkPrompt.busy} onClick={() => void convertLink()}>转换</button>
          <button type="button" disabled={linkPrompt.busy} onClick={() => setLinkPrompt(null)}>忽略</button>
        </div>
      )}

      {upload && (
        <div className="upload-pill" role="status">
          <span>{`上传${upload.kind === 'video' ? '视频' : '附件'} ${upload.name} · ${Math.round(upload.fraction * 100)}%${upload.total > 1 ? `（${upload.index}/${upload.total}）` : ''}`}</span>
          <button type="button" onClick={cancelUploads}>取消</button>
        </div>
      )}

      {slash && items.length > 0 && (
        <div className="slash" style={{
          left: Math.min(slash.x, window.innerWidth - 296),
          // Open upward when the menu (max 340px) would run past the bottom of the window.
          ...(window.innerHeight - slash.y < 350 && slash.above > window.innerHeight - slash.y ? { bottom: window.innerHeight - slash.above } : { top: slash.y }),
        }} onMouseDown={(e) => e.preventDefault()} role="listbox">
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

/** Plain text of up to `n` non-empty blocks, ending with the block that holds `pos`. */
function textBefore(doc: PMNode, pos: number, n = 3): string {
  const idx = Math.min(doc.resolve(pos).index(0), doc.childCount - 1)
  const parts: string[] = []
  for (let i = idx; i >= 0 && parts.length < n; i--) {
    const t = doc.child(i).textContent.trim()
    if (t) parts.unshift(t)
  }
  return parts.join('\n')
}
