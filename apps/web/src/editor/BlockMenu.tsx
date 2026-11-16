import { ChevronRight, type LucideIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { cn } from '../lib/utils'

export interface MenuAction {
  id: string
  label: string
  icon?: LucideIcon
  /** Shortcut or short note shown on the right. */
  hint?: string
  disabled?: boolean
  run?: () => void
  children?: MenuAction[]
}
export interface MenuSection { title?: string; actions: MenuAction[] }

/**
 * The menu that opens from a block's handle (Notion-style): a search box, sections of actions,
 * hover/arrow-key submenus, and an optional footer.
 */
export function BlockMenu({ x, y, sections, footer, onClose }: { x: number; y: number; sections: MenuSection[]; footer?: ReactNode; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [sub, setSub] = useState<{ id: string; index: number } | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  const q = query.trim().toLowerCase()
  // With a query: one flat list (submenu entries become "转换成 › 标题 1"); without: the sections.
  const shown: MenuSection[] = useMemo(() => {
    if (!q) return sections
    const flat: MenuAction[] = []
    for (const s of sections) {
      for (const a of s.actions) {
        if (a.children) for (const c of a.children) flat.push({ ...c, label: `${a.label} › ${c.label}`, icon: c.icon ?? a.icon })
        else flat.push(a)
      }
    }
    return [{ actions: flat.filter((a) => a.label.toLowerCase().includes(q)) }]
  }, [sections, q])
  const items = shown.flatMap((s) => s.actions)

  useEffect(() => setIndex(0), [q])

  // Close on outside click or scroll.
  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', down, true)
    return () => document.removeEventListener('mousedown', down, true)
  }, [onClose])

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8))
    const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8))
    setPos({ left, top })
  }, [x, y, shown.length])

  const activate = (a: MenuAction | undefined): void => {
    if (!a || a.disabled) return
    if (a.children) {
      setSub({ id: a.id, index: 0 })
      return
    }
    onClose()
    a.run?.()
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.nativeEvent.isComposing) return
    const open = sub ? items.find((a) => a.id === sub.id) : undefined
    const kids = open?.children ?? []
    if (e.key === 'Escape') {
      e.preventDefault()
      if (sub) setSub(null)
      else onClose()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      if (sub && kids.length) setSub({ ...sub, index: (sub.index + d + kids.length) % kids.length })
      else if (items.length) setIndex((i) => (i + d + items.length) % items.length)
    } else if (e.key === 'ArrowRight' && !sub && items[index]?.children) {
      e.preventDefault()
      setSub({ id: items[index]!.id, index: 0 })
    } else if (e.key === 'ArrowLeft' && sub) {
      e.preventDefault()
      setSub(null)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (sub) activate(kids[sub.index])
      else activate(items[index])
    }
  }

  let n = -1
  return (
    <div ref={box} role="menu" className="fixed z-[60] w-[280px] rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg" style={pos} onKeyDown={onKey}>
      <input
        autoFocus
        value={query}
        onChange={(e) => { setQuery(e.target.value); setSub(null) }}
        placeholder="搜索操作…"
        aria-label="搜索操作"
        className="mb-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-ring"
      />
      {items.length === 0 && <p className="px-2 py-2 text-[13px] text-muted-foreground">没有匹配的操作</p>}
      {shown.map((s, si) => (
        <div key={si} className={cn(si > 0 && 'mt-1 border-t border-border pt-1')}>
          {s.title && <div className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">{s.title}</div>}
          {s.actions.map((a) => {
            const i = ++n
            const Icon = a.icon
            const subOpen = sub?.id === a.id
            return (
              <div key={a.id} className="relative" onMouseEnter={() => { setIndex(i); setSub(a.children ? { id: a.id, index: -1 } : null) }}>
                <button
                  type="button"
                  role="menuitem"
                  disabled={a.disabled}
                  aria-haspopup={a.children ? 'menu' : undefined}
                  aria-expanded={a.children ? subOpen : undefined}
                  className={cn('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm disabled:opacity-40', (index === i || subOpen) && 'bg-accent')}
                  onClick={() => activate(a)}
                >
                  {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : <span className="size-4 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate">{a.label}</span>
                  {a.hint && <span className="shrink-0 text-xs text-muted-foreground">{a.hint}</span>}
                  {a.children && <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
                </button>
                {subOpen && a.children && (
                  <div role="menu" className="absolute left-full top-0 z-10 ml-1 max-h-[60vh] w-[220px] overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-lg">
                    {a.children.map((c, ci) => {
                      const CIcon = c.icon
                      return (
                        <button
                          key={c.id}
                          type="button"
                          role="menuitem"
                          disabled={c.disabled}
                          className={cn('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent disabled:opacity-40', sub?.index === ci && 'bg-accent')}
                          onMouseEnter={() => setSub({ id: a.id, index: ci })}
                          onClick={() => activate(c)}
                        >
                          {CIcon ? <CIcon className="size-4 shrink-0 text-muted-foreground" /> : <span className="size-4 shrink-0" />}
                          <span className="min-w-0 flex-1 truncate">{c.label}</span>
                          {c.hint && <span className="shrink-0 text-xs text-muted-foreground">{c.hint}</span>}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}
      {footer && <div className="mt-1 border-t border-border px-2 pb-1 pt-2 text-xs text-muted-foreground">{footer}</div>}
    </div>
  )
}
