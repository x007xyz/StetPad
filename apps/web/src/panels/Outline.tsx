import { projectBlocks } from '@stetpad/crdt'
import { useEffect, useMemo, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { cn } from '../lib/utils'

export type OutlineItem = { id: string; text: string; level: 1 | 2 | 3 }

/**
 * Heading list of the revised text (h1–h3, non-empty), plus the id of the heading
 * currently at the top of the `main.page` scroll area.
 */
export function useOutline(ydoc: Y.Doc, tick: number): { items: OutlineItem[]; active: string } {
  const items = useMemo<OutlineItem[]>(
    () => projectBlocks(ydoc, 'revised')
      .filter((b) => b.type === 'heading' && b.text.trim())
      .map((b) => ({ id: b.blockId, text: b.text, level: Math.min(3, Math.max(1, Number(b.attrs.level) || 1)) as 1 | 2 | 3 })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ydoc, tick],
  )
  const [active, setActive] = useState('')

  // Highlight the last heading that has scrolled past the top of the page.
  useEffect(() => {
    const page = document.querySelector<HTMLElement>('main.page')
    if (!page) return
    const update = (): void => {
      const top = page.getBoundingClientRect().top + 80
      let cur = ''
      for (const it of items) {
        const el = page.querySelector(`.prose [data-block-id="${CSS.escape(it.id)}"]`)
        if (el && el.getBoundingClientRect().top <= top) cur = it.id
      }
      setActive(cur || items[0]?.id || '')
    }
    update()
    page.addEventListener('scroll', update, { passive: true })
    return () => page.removeEventListener('scroll', update)
  }, [items])

  return { items, active }
}

const PIN_KEY = 'aiw.tocPinned'
const LINE_WIDTH: Record<1 | 2 | 3, number> = { 1: 20, 2: 14, 3: 10 }
const HIDE_DELAY = 150

export function readTocPinned(): boolean {
  try { return localStorage.getItem(PIN_KEY) === '1' } catch { return false }
}
export function writeTocPinned(v: boolean): void {
  try { if (v) localStorage.setItem(PIN_KEY, '1'); else localStorage.removeItem(PIN_KEY) } catch { /* storage unavailable */ }
}

function OutlineList({ items, active, onJump }: { items: OutlineItem[]; active: string; onJump: (blockId: string) => void }) {
  return (
    <nav aria-label="目录">
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {items.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              aria-current={active === it.id ? 'location' : undefined}
              className={cn('line-clamp-2 w-full rounded-md px-2 py-1 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground', active === it.id && 'font-medium text-foreground')}
              style={{ paddingLeft: 8 + (it.level - 1) * 14 }}
              title={it.text}
              onClick={() => onJump(it.id)}
            >{it.text}</button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

/**
 * Table of contents beside the page (h1–h3 of the revised text).
 * Not pinned: a column of short lines floating on the page's right edge; hovering opens the list.
 * Pinned: the list is a column of its own, taking space next to the page.
 */
export function OutlineRail({ ydoc, tick, pinned, onJump }: { ydoc: Y.Doc; tick: number; pinned: boolean; onJump: (blockId: string) => void }) {
  const { items, active } = useOutline(ydoc, tick)
  const [hover, setHover] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  if (pinned) {
    return (
      <aside aria-label="目录" className="w-[240px] shrink-0 overflow-y-auto px-2 pb-6 pt-24">
        {items.length ? <OutlineList items={items} active={active} onJump={onJump} /> : <p className="px-2 text-[13px] text-muted-foreground">还没有标题。用 # 或 / 插入标题后，这里会出现目录。</p>}
      </aside>
    )
  }
  if (!items.length) return null

  const enter = (): void => {
    window.clearTimeout(timer.current)
    setHover(true)
  }
  const leave = (): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setHover(false), HIDE_DELAY)
  }

  return (
    <div className="absolute right-4 top-24 z-20 flex flex-col items-end" onMouseEnter={enter} onMouseLeave={leave}>
      {hover ? (
        <div className="max-h-[70vh] w-[260px] overflow-y-auto rounded-xl border border-border bg-background px-2 py-3 shadow-lg">
          <OutlineList items={items} active={active} onJump={onJump} />
        </div>
      ) : (
        <div aria-hidden className="flex flex-col items-end gap-2.5 py-1">
          {items.map((it) => (
            <div key={it.id} className="flex h-3 items-center">
              <span className={cn('block h-0.5 rounded-full', active === it.id ? 'bg-foreground/70' : 'bg-muted-foreground/25')} style={{ width: LINE_WIDTH[it.level] }} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
