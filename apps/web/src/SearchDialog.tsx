import { FileText, Search } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { api, fmtTime, type SearchResult } from './api'
import { go } from './App'
import { Dialog, DialogContent } from './components/ui/dialog'
import { cn } from './lib/utils'

const DEBOUNCE_MS = 200

/** Splits text around case-insensitive matches of the query, so matches can be highlighted as React nodes. */
function highlight(text: string, query: string): ReactNode[] {
  const q = query.trim()
  if (!q) return [text]
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : p))
}

export function SearchDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [searched, setSearched] = useState('') // the query the current results belong to
  const [active, setActive] = useState(0)
  const seq = useRef(0)
  const activeResult = useRef<HTMLLIElement>(null)

  useEffect(() => {
    activeResult.current?.scrollIntoView({ block: 'nearest' })
  }, [active, results])

  useEffect(() => {
    const q = query.trim()
    const my = ++seq.current
    if (!q) {
      setResults([])
      setSearched('')
      setLoading(false)
      setError(false)
      return
    }
    setLoading(true)
    const t = setTimeout(() => {
      api<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (my !== seq.current) return
          setResults(r.results)
          setSearched(q)
          setError(false)
          setActive(0)
        })
        .catch(() => {
          if (my !== seq.current) return
          setResults([])
          setSearched(q)
          setError(true)
        })
        .finally(() => {
          if (my === seq.current) setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  const showingFor = query.trim() !== '' && searched === query.trim()
  const currentResults = showingFor ? results : []
  const open = (r: SearchResult): void => {
    onClose()
    go({ page: 'doc', id: r.id })
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!currentResults.length) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + step + currentResults.length) % currentResults.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const r = currentResults[active]
      if (r) open(r)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="搜索文档" hideTitle className="max-w-xl max-md:top-[12vh] max-md:translate-y-0">
        <div className="flex items-center gap-2 border-b border-border pb-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            role="combobox"
            aria-expanded={currentResults.length > 0}
            aria-controls="search-results"
            aria-activedescendant={currentResults[active] ? `search-r-${currentResults[active].id}` : undefined}
            aria-label="搜索文档"
            placeholder="搜索所有文档的标题和正文…"
            className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          {loading && <span className="shrink-0 text-xs text-muted-foreground">搜索中…</span>}
        </div>

        {!query.trim() && <p className="px-1 py-6 text-center text-sm text-muted-foreground">输入关键词，搜索你能看到的所有文档。</p>}
        {query.trim() && error && showingFor && <p className="error px-1 py-6 text-center text-sm">搜索失败，请稍后再试。</p>}
        {query.trim() && !error && showingFor && results.length === 0 && <p className="px-1 py-6 text-center text-sm text-muted-foreground">没有找到相关文档。</p>}

        {currentResults.length > 0 && (
          <ul id="search-results" role="listbox" aria-label="搜索结果" className="m-0 mt-2 max-h-[60vh] list-none overflow-auto p-0">
            {currentResults.map((r, i) => (
              <li
                key={r.id}
                ref={i === active ? activeResult : undefined}
                id={`search-r-${r.id}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => open(r)}
                className={cn('flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2', i === active ? 'bg-accent' : 'hover:bg-accent/60')}
              >
                <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-medium">{highlight(r.title, query)}</span>
                  </span>
                  {r.snippet && <span className="line-clamp-2 block text-xs text-muted-foreground">{highlight(r.snippet, query)}</span>}
                </span>
                <span className="shrink-0 pt-0.5 text-[11px] text-muted-foreground">{fmtTime(r.updated_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
