import { ChevronRight, ChevronsLeft, FilePlus2, FileText, Folder as FolderIcon, FolderInput, FolderPlus, LogOut, PanelLeft, Pencil, Plus, Settings as SettingsIcon, Trash2, Users } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, post, type DocMeta, type Folder, type Space } from './api'
import { go, type Session } from './App'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, SheetContent } from './components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './components/ui/dropdown-menu'
import { Input } from './components/ui/input'
import { Select } from './components/ui/select'
import { Tip, TooltipProvider } from './components/ui/tooltip'
import { Settings } from './panels/Settings'
import { useMedia } from './lib/useMedia'
import { cn } from './lib/utils'
import { Members } from './Members'

const SPACE_KEY = 'aiw.space'
const SIDEBAR_KEY = 'aiw.sidebar'

interface Ctx {
  session: Session
  spaces: Space[]
  space: string
  setSpace: (id: string) => void
  current: Space | undefined
  canCreate: boolean
  docs: DocMeta[] | null
  folders: Folder[]
  createFolder: () => Promise<void>
  renameFolder: (f: Folder, name: string) => Promise<void>
  removeFolder: (f: Folder) => Promise<void>
  moveDoc: (docId: string, folderId: string | null) => Promise<void>
  reload: () => Promise<void>
  createDoc: () => Promise<void>
  removeDoc: (d: DocMeta) => Promise<void>
  sidebarOpen: boolean
  toggleSidebar: () => void
  openSettings: () => void
  isMobile: boolean
}
const WorkspaceCtx = createContext<Ctx | null>(null)
export const useWorkspace = (): Ctx => useContext(WorkspaceCtx)!
/** For pages that also render without a shell (shared links). */
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

export function Shell({ session, onLogout, activeId, activeFolderId, children }: { session: Session; onLogout: () => void; activeId?: string; activeFolderId?: string; children: ReactNode }) {
  const isMobile = useMedia('(max-width: 767px)')
  const [spaces, setSpaces] = useState<Space[]>([])
  const [space, setSpaceState] = useState(() => read(SPACE_KEY))
  const [docs, setDocs] = useState<DocMeta[] | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [desktopOpen, setDesktopOpen] = useState(() => read(SIDEBAR_KEY) !== 'closed')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [settings, setSettings] = useState(false)
  const [members, setMembers] = useState(false)
  const [newSpaceOpen, setNewSpaceOpen] = useState(false)
  const current = spaces.find((s) => s.id === space)
  const canCreate = !current || current.role !== 'viewer'

  const setSpace = useCallback((id: string) => {
    setSpaceState(id)
    write(SPACE_KEY, id)
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    const q = space ? `?space=${space}` : ''
    const [d, f] = await Promise.all([api<DocMeta[]>('/docs' + q), api<Folder[]>('/folders' + q)])
    setDocs(d)
    setFolders(f)
  }, [space])
  useEffect(() => {
    void reload()
  }, [reload, activeId])
  useEffect(() => {
    if (session.mode !== 'web') return
    void api<Space[]>('/spaces').then((list) => {
      setSpaces(list)
      // A remembered space that no longer exists falls back to the personal one.
      setSpaceState((cur) => (cur && !list.some((s) => s.id === cur) ? '' : cur))
    })
  }, [session.mode])

  const createDoc = useCallback(async (): Promise<void> => {
    setMobileOpen(false)
    go({ page: 'doc', id: (await post<DocMeta>('/docs', { spaceId: space || undefined })).id })
  }, [space])
  const removeDoc = useCallback(async (d: DocMeta): Promise<void> => {
    if (!confirm(`删除"${d.title}"？此操作不可恢复。`)) return
    await api(`/docs/${d.id}`, { method: 'DELETE' })
    await reload()
    if (d.id === activeId) go({ page: 'home' })
  }, [reload, activeId])

  const createFolder = useCallback(async (): Promise<void> => {
    const f = await post<Folder>('/folders', { name: '新建文件夹', spaceId: space || undefined })
    await reload()
    go({ page: 'folder', id: f.id })
  }, [space, reload])
  const renameFolder = useCallback(async (f: Folder, name: string): Promise<void> => {
    if (!name.trim() || name.trim() === f.name) return
    await api(`/folders/${f.id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
    await reload()
  }, [reload])
  const removeFolder = useCallback(async (f: Folder): Promise<void> => {
    if (!confirm(`删除文件夹"${f.name}"？其中的文档不会被删除，会移到文档列表。`)) return
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
    session, spaces, space, setSpace, current, canCreate, docs, folders, createFolder, renameFolder, removeFolder, moveDoc, reload, createDoc, removeDoc, sidebarOpen, toggleSidebar, openSettings: () => setSettings(true), isMobile,
  }), [session, spaces, space, setSpace, current, canCreate, docs, folders, createFolder, renameFolder, removeFolder, moveDoc, reload, createDoc, removeDoc, sidebarOpen, toggleSidebar, isMobile])

  const sidebar = (
    <SidebarBody
      ctx={ctx}
      activeId={activeId}
      activeFolderId={activeFolderId}
      onLogout={onLogout}
      onMembers={() => setMembers(true)}
      onNewSpace={() => setNewSpaceOpen(true)}
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
        {members && current && <Members space={current} onClose={() => setMembers(false)} />}
        {newSpaceOpen && (
          <NewSpace
            onClose={() => setNewSpaceOpen(false)}
            onCreate={async (name) => {
              const { id } = await post<{ id: string }>('/spaces', { name })
              setSpaces(await api<Space[]>('/spaces'))
              setSpace(id)
              setNewSpaceOpen(false)
              go({ page: 'home' })
            }}
          />
        )}
      </TooltipProvider>
    </WorkspaceCtx.Provider>
  )
}

function SidebarBody({ ctx, activeId, activeFolderId, onLogout, onMembers, onNewSpace, onNavigate }: {
  ctx: Ctx; activeId?: string; activeFolderId?: string; onLogout: () => void; onMembers: () => void; onNewSpace: () => void; onNavigate: () => void
}) {
  const { session, spaces, space, setSpace, current, canCreate, docs, folders, createFolder, renameFolder, removeFolder, moveDoc, createDoc, removeDoc, toggleSidebar, openSettings, isMobile } = ctx
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
  const dropProps = (folderId: string | null) => canCreate ? {
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
  } : {}
  const docRow = (d: DocMeta, indent: boolean) => (
    <li
      key={d.id}
      draggable={canCreate && d.access !== 'viewer'}
      onDragStart={(e) => { e.dataTransfer.setData('application/x-aiw-doc', d.id); e.dataTransfer.effectAllowed = 'move' }}
      className={cn('group flex items-center rounded-md', indent && 'ml-4', d.id === activeId ? 'bg-accent' : 'hover:bg-accent/70')}
    >
      <button className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-[13px]" aria-current={d.id === activeId ? 'page' : undefined} onClick={() => { go({ page: 'doc', id: d.id }); onNavigate() }}>
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{d.title}</span>
      </button>
      {canCreate && d.access !== 'viewer' && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="mr-0.5 hidden rounded p-1 text-muted-foreground hover:text-foreground focus-visible:block group-focus-within:block group-hover:block data-[state=open]:block" aria-label={`移动 ${d.title}`}><FolderInput className="size-3.5" /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <div className="px-2 py-1 text-xs text-muted-foreground">移动到…</div>
            {folders.filter((f) => f.id !== d.folder_id).map((f) => (
              <DropdownMenuItem key={f.id} onSelect={() => void moveDoc(d.id, f.id)}><FolderIcon className="size-4" />{f.name}</DropdownMenuItem>
            ))}
            {folders.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">还没有文件夹</div>}
            {d.folder_id && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void moveDoc(d.id, null)}>移出文件夹</DropdownMenuItem></>}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {(!current || current.role !== 'viewer') && d.access !== 'viewer' && (
        <button className="mr-1 hidden rounded p-1 text-muted-foreground hover:text-destructive focus-visible:block group-focus-within:block group-hover:block" aria-label={`删除 ${d.title}`} onClick={() => removeDoc(d)}><Trash2 className="size-3.5" /></button>
      )}
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

      {session.mode === 'web' && (
        <div className="flex items-center gap-1 px-3 py-1">
          <Select
            className="h-8 border-transparent bg-transparent text-[13px]"
            aria-label="空间"
            value={space}
            onValueChange={(v) => (v === '__new' ? onNewSpace() : setSpace(v))}
            options={[{ value: '', label: '个人空间' }, ...spaces.map((s) => ({ value: s.id, label: s.name })), { value: '__new', label: '＋ 新建团队空间…' }]}
          />
          {current && <Tip text="成员"><Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label="成员" onClick={onMembers}><Users /></Button></Tip>}
        </div>
      )}

      <nav className="min-h-0 flex-1 overflow-auto px-2 py-2" aria-label="文档">
        <div className="flex items-center justify-between px-2 pb-1 text-xs font-medium text-muted-foreground">
          <span>文档</span>
          {canCreate && (
            <span className="flex items-center gap-0.5">
              <Tip text="新建文件夹" side="right"><button aria-label="新建文件夹" className="rounded p-0.5 hover:bg-accent" onClick={() => void createFolder()}><FolderPlus className="size-3.5" /></button></Tip>
              <Tip text="新建文档" side="right"><button aria-label="新建文档" className="rounded p-0.5 hover:bg-accent" onClick={createDoc}><Plus className="size-3.5" /></button></Tip>
            </span>
          )}
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
                      <span className="truncate">{f.name}</span>
                      <span className="text-xs font-normal text-muted-foreground">{inside.length}</span>
                    </button>
                  )}
                  {canCreate && renaming !== f.id && (
                    <>
                      <button className="hidden rounded p-1 text-muted-foreground hover:text-foreground focus-visible:block group-focus-within:block group-hover:block" aria-label={`重命名 ${f.name}`} onClick={() => setRenaming(f.id)}><Pencil className="size-3.5" /></button>
                      <button className="mr-1 hidden rounded p-1 text-muted-foreground hover:text-destructive focus-visible:block group-focus-within:block group-hover:block" aria-label={`删除文件夹 ${f.name}`} onClick={() => void removeFolder(f)}><Trash2 className="size-3.5" /></button>
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
        {canCreate && <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent" onClick={createDoc}><FilePlus2 className="size-4 text-muted-foreground" />新建文档</button>}
        {canCreate && <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent" onClick={() => void createFolder()}><FolderPlus className="size-4 text-muted-foreground" />新建文件夹</button>}
        <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent" onClick={openSettings}><SettingsIcon className="size-4 text-muted-foreground" />设置</button>
        {session.mode === 'web' && <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent" onClick={onLogout}><LogOut className="size-4 text-muted-foreground" /><span className="truncate">退出（{session.user.email}）</span></button>}
      </div>
    </div>
  )
}

function NewSpace({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="团队空间的名称" className="max-w-sm">
        <form className="flex gap-2" onSubmit={async (e) => {
          e.preventDefault()
          if (!name.trim()) return
          try {
            await onCreate(name.trim())
          } catch (err) {
            setError(err instanceof Error ? err.message : '出错了')
          }
        }}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="团队空间的名称" />
          <Button variant="default" type="submit" disabled={!name.trim()}>确定</Button>
        </form>
        {error && <p className="error mt-2 text-sm">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}
