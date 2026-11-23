import { ChevronRight, ChevronsLeft, FilePlus2, FileText, Folder as FolderIcon, FolderInput, FolderPlus, PanelLeft, Pencil, Plus, Search, Settings as SettingsIcon, Trash, Trash2 } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, post, type DocMeta, type Folder } from './api'
import { go, type Session } from './App'
import { ConfirmHost, confirmAction } from './components/confirm'
import { Button } from './components/ui/button'
import { Dialog, SheetContent } from './components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './components/ui/dropdown-menu'
import { Tip, TooltipProvider } from './components/ui/tooltip'
import { Settings } from './panels/Settings'
import { useMedia } from './lib/useMedia'
import { cn } from './lib/utils'
import { SearchDialog } from './SearchDialog'

const SIDEBAR_KEY = 'aiw.sidebar'

interface Ctx {
  session: Session
  docs: DocMeta[] | null
  folders: Folder[]
  createFolder: () => Promise<void>
  renameFolder: (f: Folder, name: string) => Promise<void>
  removeFolder: (f: Folder) => Promise<void>
  moveDoc: (docId: string, folderId: string | null) => Promise<void>
  reload: () => Promise<void>
  createDoc: () => Promise<void>
  removeDoc: (d: DocMeta) => Promise<void>
  notify: (text: string, options?: { error?: boolean }) => void
  /** Bumped whenever the shell moves a document to the trash. */
  trashVersion: number
  openSearch: () => void
  sidebarOpen: boolean
  toggleSidebar: () => void
  openSettings: () => void
  isMobile: boolean
}
const WorkspaceCtx = createContext<Ctx | null>(null)
export const useWorkspace = (): Ctx => useContext(WorkspaceCtx)!
/** For pages that also render without a shell. */
export const useWorkspaceOptional = (): Ctx | null => useContext(WorkspaceCtx)

const read = (k: string): string => {
  try {
    return localStorage.getItem(k) ?? ''
  } catch {
    return ''
  }
}
const write = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* storage unavailable */
  }
}

/** The sidebar button the page headers show while the sidebar is hidden. */
export function SidebarToggle({ className }: { className?: string }) {
  const { sidebarOpen, toggleSidebar, isMobile } = useWorkspace()
  if (sidebarOpen && !isMobile) return null
  return (
    <Tip text="打开侧栏">
      <Button variant="ghost" size="icon" aria-label="打开侧栏" className={className} onClick={toggleSidebar}><PanelLeft /></Button>
    </Tip>
  )
}

export function Shell({ session, activeId, activeFolderId, trashActive, children }: { session: Session; activeId?: string; activeFolderId?: string; trashActive?: boolean; children: ReactNode }) {
  const isMobile = useMedia('(max-width: 767px)')
  const [docs, setDocs] = useState<DocMeta[] | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [desktopOpen, setDesktopOpen] = useState(() => read(SIDEBAR_KEY) !== 'closed')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [settings, setSettings] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [toast, setToast] = useState<{ text: string; nonce: number; error?: boolean } | null>(null)
  const [trashVersion, setTrashVersion] = useState(0)
  const reloadVersion = useRef(0)
  const notify = useCallback((text: string, options?: { error?: boolean }): void => {
    setToast({ text, nonce: Date.now(), error: options?.error })
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    const version = ++reloadVersion.current
    const [d, f] = await Promise.all([api<DocMeta[]>('/docs'), api<Folder[]>('/folders')])
    if (version !== reloadVersion.current) return
    setDocs(d)
    setFolders(f)
  }, [])
  useEffect(() => {
    void reload()
  }, [reload, activeId])

  const createDoc = useCallback(async (): Promise<void> => {
    setMobileOpen(false)
    try {
      go({ page: 'doc', id: (await post<DocMeta>('/docs')).id })
    } catch {
      notify('新建文档失败，请重试。', { error: true })
    }
  }, [notify])
  const removeDoc = useCallback(async (d: DocMeta): Promise<void> => {
    if (!(await confirmAction({ title: `把"${d.title || '无标题'}"移到回收站？`, body: '30 天内可以在回收站恢复。', confirmLabel: '移到回收站', danger: true }))) return
    try {
      await api(`/docs/${d.id}`, { method: 'DELETE' })
    } catch {
      setToast({ text: `无法删除"${d.title}"。`, nonce: Date.now(), error: true })
      return
    }
    setTrashVersion((v) => v + 1)
    await reload()
    if (d.id === activeId) go({ page: 'home' })
    setToast({ text: `"${d.title}" 已移到回收站`, nonce: Date.now() })
  }, [reload, activeId])
  const openSearch = useCallback((): void => {
    setMobileOpen(false)
    setSearchOpen(true)
  }, [])

  // Cmd/Ctrl+K opens search from anywhere in the shell.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        openSearch()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openSearch])
  // The "moved to trash" notice clears itself.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  const createFolder = useCallback(async (): Promise<void> => {
    const f = await post<Folder>('/folders', { name: '新建文件夹' })
    await reload()
    go({ page: 'folder', id: f.id })
  }, [reload])
  const renameFolder = useCallback(async (f: Folder, name: string): Promise<void> => {
    if (!name.trim() || name.trim() === f.name) return
    try {
      await api(`/folders/${f.id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
    } catch {
      notify('文件夹名称保存失败，请重试。', { error: true })
      return
    }
    await reload()
  }, [reload, notify])
  const removeFolder = useCallback(async (f: Folder): Promise<void> => {
    if (!(await confirmAction({ title: `删除文件夹"${f.name}"？`, body: '其中的文档不会被删除，会移到文档列表。', confirmLabel: '删除', danger: true }))) return
    await api(`/folders/${f.id}`, { method: 'DELETE' })
    await reload()
    if (f.id === activeFolderId) go({ page: 'home' })
  }, [reload, activeFolderId])
  const moveDoc = useCallback(async (docId: string, folderId: string | null): Promise<void> => {
    await api(`/docs/${docId}/folder`, { method: 'PUT', body: JSON.stringify({ folderId }) })
    await reload()
  }, [reload])

  const sidebarOpen = isMobile ? mobileOpen : desktopOpen
  const toggleSidebar = useCallback(() => {
    if (isMobile) setMobileOpen((o) => !o)
    else
      setDesktopOpen((o) => {
        write(SIDEBAR_KEY, o ? 'closed' : 'open')
        return !o
      })
  }, [isMobile])

  const ctx: Ctx = useMemo(() => ({
    session, docs, folders, createFolder, renameFolder, removeFolder, moveDoc, reload, createDoc, removeDoc, notify, trashVersion, openSearch, sidebarOpen, toggleSidebar, openSettings: () => setSettings(true), isMobile,
  }), [session, docs, folders, createFolder, renameFolder, removeFolder, moveDoc, reload, createDoc, removeDoc, notify, trashVersion, openSearch, sidebarOpen, toggleSidebar, isMobile])

  const sidebar = (
    <SidebarBody
      ctx={ctx}
      activeId={activeId}
      activeFolderId={activeFolderId}
      trashActive={trashActive}
      onNavigate={() => setMobileOpen(false)}
    />
  )

  return (
    <WorkspaceCtx.Provider value={ctx}>
      <TooltipProvider>
        <div className="flex h-full">
          {!isMobile && desktopOpen && <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar" aria-label="侧栏">{sidebar}</aside>}
          {isMobile && (
            <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetContent side="left" title="侧栏">{sidebar}</SheetContent>
            </Dialog>
          )}
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        </div>
        {settings && <Settings onClose={() => setSettings(false)} />}
        {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
        <ConfirmHost />
        {toast && <Toast key={toast.nonce} text={toast.text} error={toast.error} onClose={() => setToast(null)} />}
      </TooltipProvider>
    </WorkspaceCtx.Provider>
  )
}

/** A short notice at the bottom of the screen, with one follow-up action. */
function Toast({ text, error, onClose }: { text: string; error?: boolean; onClose: () => void }) {
  return (
    <div role={error ? 'alert' : 'status'} className="fixed bottom-4 left-1/2 z-[70] flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-popover px-4 py-2 text-sm text-popover-foreground shadow-lg">
      <span className={cn('min-w-0', error ? 'break-words text-destructive' : 'truncate')}>{text}</span>
      {!error && <button className="shrink-0 font-medium text-link hover:underline" onClick={() => { onClose(); go({ page: 'trash' }) }}>查看回收站</button>}
      <button className="shrink-0 text-muted-foreground hover:text-foreground" aria-label="关闭提示" onClick={onClose}>×</button>
    </div>
  )
}

function SidebarBody({ ctx, activeId, activeFolderId, trashActive, onNavigate }: {
  ctx: Ctx; activeId?: string; activeFolderId?: string; trashActive?: boolean; onNavigate: () => void
}) {
  const { docs, folders, createFolder, renameFolder, removeFolder, moveDoc, createDoc, removeDoc, openSearch, toggleSidebar, openSettings, isMobile } = ctx
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(read('aiw.folders.collapsed').split(',').filter(Boolean)))
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropOn, setDropOn] = useState<string | null>(null) // folder id, or '' for the root
  const toggleFolder = (id: string): void =>
    setCollapsed((cur) => {
      const next = new Set(cur)
      if (!next.delete(id)) next.add(id)
      write('aiw.folders.collapsed', [...next].join(','))
      return next
    })
  const folderIds = new Set(folders.map((f) => f.id))
  const rootDocs = docs?.filter((d) => !d.folder_id || !folderIds.has(d.folder_id))
  const dropProps = (folderId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('application/x-aiw-doc')) return
      e.preventDefault()
      e.stopPropagation()
      setDropOn(folderId ?? '')
    },
    onDragLeave: () => setDropOn((cur) => (cur === (folderId ?? '') ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData('application/x-aiw-doc')
      setDropOn(null)
      if (!id) return
      e.preventDefault()
      e.stopPropagation()
      const d = docs?.find((x) => x.id === id)
      if (d && (d.folder_id ?? null) !== folderId) void moveDoc(id, folderId)
    },
  })
  const docRow = (d: DocMeta, indent: boolean) => (
    <li
      key={d.id}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('application/x-aiw-doc', d.id); e.dataTransfer.effectAllowed = 'move' }}
      className={cn('group flex items-center rounded-md', indent && 'ml-4', d.id === activeId ? 'bg-accent' : 'hover:bg-accent/70')}
    >
      <button className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-[13px]" aria-current={d.id === activeId ? 'page' : undefined} onClick={() => { go({ page: 'doc', id: d.id }); onNavigate() }}>
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span translate="no" className="truncate">{d.title}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="mr-0.5 hidden rounded p-1 text-muted-foreground hover:text-foreground focus-visible:block group-focus-within:block group-hover:block data-[state=open]:block [@media(hover:none)]:block" aria-label={`移动 ${d.title}`}><FolderInput className="size-3.5" /></button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <div className="px-2 py-1 text-xs text-muted-foreground">移动到…</div>
          {folders.filter((f) => f.id !== d.folder_id).map((f) => (
            <DropdownMenuItem key={f.id} onSelect={() => void moveDoc(d.id, f.id)}><FolderIcon className="size-4" /><span translate="no">{f.name}</span></DropdownMenuItem>
          ))}
          {folders.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">还没有文件夹</div>}
          {d.folder_id && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void moveDoc(d.id, null)}>移出文件夹</DropdownMenuItem></>}
        </DropdownMenuContent>
      </DropdownMenu>
      <button className="mr-1 hidden rounded p-1 text-muted-foreground hover:text-destructive focus-visible:block group-focus-within:block group-hover:block [@media(hover:none)]:block" aria-label={`删除 ${d.title}`} onClick={() => removeDoc(d)}><Trash2 className="size-3.5" /></button>
    </li>
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-3 pb-1 pt-3">
        <button className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-accent" onClick={() => { go({ page: 'home' }); onNavigate() }} aria-label="Stetpad">
          <img src="/favicon.svg" alt="" className="size-5 shrink-0" />
          <span className="truncate text-sm font-semibold">Stetpad</span>
        </button>
        {!isMobile && (
          <Tip text="收起侧栏"><Button variant="ghost" size="icon" className="size-7" aria-label="收起侧栏" onClick={toggleSidebar}><ChevronsLeft /></Button></Tip>
        )}
      </div>

      <div className="px-2 pb-1">
        <button className="flex w-full items-center gap-2 rounded-md border border-border px-2 py-1 text-left text-[13px] text-muted-foreground hover:bg-accent" onClick={() => { onNavigate(); openSearch() }}>
          <Search className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">搜索文档</span>
          <kbd className="shrink-0 rounded border border-border px-1 font-sans text-[11px]">{/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-auto px-2 py-2" aria-label="文档">
        <div className="flex items-center justify-between px-2 pb-1 text-xs font-medium text-muted-foreground">
          <span>文档</span>
          <span className="flex items-center gap-0.5">
            <Tip text="新建文件夹" side="right"><button aria-label="新建文件夹" className="rounded p-0.5 hover:bg-accent" onClick={() => void createFolder()}><FolderPlus className="size-3.5" /></button></Tip>
            <Tip text="新建文档" side="right"><button aria-label="新建文档" className="rounded p-0.5 hover:bg-accent" onClick={createDoc}><Plus className="size-3.5" /></button></Tip>
          </span>
        </div>
        {docs === null && <p className="px-2 text-xs text-muted-foreground">加载中…</p>}
        {docs?.length === 0 && <p className="px-2 text-xs text-muted-foreground">还没有文档。</p>}
        <ul className="m-0 list-none p-0" {...dropProps(null)}>
          {folders.map((f) => {
            const open = !collapsed.has(f.id)
            // The order the folder page reads them in.
            const inside = (docs?.filter((d) => d.folder_id === f.id) ?? []).sort((a, b) => a.created_at - b.created_at)
            return (
              <li key={f.id} aria-label={`文件夹 ${f.name}`} {...dropProps(f.id)} className={cn('rounded-md', dropOn === f.id && 'bg-accent ring-1 ring-ring')}>
                <div className={cn('group flex items-center rounded-md', f.id === activeFolderId ? 'bg-accent' : 'hover:bg-accent/70')}>
                  <button className="rounded p-1 text-muted-foreground" aria-label={open ? `收起 ${f.name}` : `展开 ${f.name}`} aria-expanded={open} onClick={() => toggleFolder(f.id)}><ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} /></button>
                  {renaming === f.id ? (
                    <input autoFocus className="min-w-0 flex-1 rounded border border-ring bg-background px-1 py-0.5 text-[13px] outline-none" aria-label="文件夹名称" defaultValue={f.name}
                      onBlur={(e) => { setRenaming(null); void renameFolder(f, e.target.value) }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null) }} />
                  ) : (
                    <button className="flex min-w-0 flex-1 items-center gap-2 py-1 pr-2 text-left text-[13px] font-medium" aria-current={f.id === activeFolderId ? 'page' : undefined} onClick={() => { go({ page: 'folder', id: f.id }); onNavigate() }}>
                      <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span translate="no" className="truncate">{f.name}</span>
                      <span className="text-xs font-normal text-muted-foreground">{inside.length}</span>
                    </button>
                  )}
                  {renaming !== f.id && (
                    <>
                      <button className="hidden rounded p-1 text-muted-foreground hover:text-foreground focus-visible:block group-focus-within:block group-hover:block [@media(hover:none)]:block" aria-label={`重命名 ${f.name}`} onClick={() => setRenaming(f.id)}><Pencil className="size-3.5" /></button>
                      <button className="mr-1 hidden rounded p-1 text-muted-foreground hover:text-destructive focus-visible:block group-focus-within:block group-hover:block [@media(hover:none)]:block" aria-label={`删除文件夹 ${f.name}`} onClick={() => void removeFolder(f)}><Trash2 className="size-3.5" /></button>
                    </>
                  )}
                </div>
                {open && (
                  <ul className="m-0 list-none p-0">
                    {inside.map((d) => docRow(d, true))}
                    {inside.length === 0 && <li className="ml-8 py-1 text-xs text-muted-foreground">空文件夹（把文档拖进来）</li>}
                  </ul>
                )}
              </li>
            )
          })}
          {folders.length > 0 && rootDocs && rootDocs.length > 0 && <li aria-hidden className={cn('mx-2 my-1 h-px bg-border', dropOn === '' && 'h-1 bg-ring')} />}
          {rootDocs?.map((d) => docRow(d, false))}
        </ul>
      </nav>

      <div className="space-y-0.5 border-t border-border px-2 py-2 pb-12">
        <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent" onClick={createDoc}><FilePlus2 className="size-4 text-muted-foreground" />新建文档</button>
        <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent" onClick={() => void createFolder()}><FolderPlus className="size-4 text-muted-foreground" />新建文件夹</button>
        <button className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent', trashActive && 'bg-accent')} aria-current={trashActive ? 'page' : undefined} onClick={() => { go({ page: 'trash' }); onNavigate() }}><Trash className="size-4 text-muted-foreground" />回收站</button>
        <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent" onClick={openSettings}><SettingsIcon className="size-4 text-muted-foreground" />设置</button>
      </div>
    </div>
  )
}
