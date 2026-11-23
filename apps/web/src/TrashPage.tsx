import { RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, fmtTime, post, type TrashDoc } from './api'
import { confirmAction } from './components/confirm'
import { Button } from './components/ui/button'
import { SidebarToggle, useWorkspace } from './Shell'

/** 回收站: the trashed documents. */
export function TrashPage() {
  const { reload, trashVersion, notify } = useWorkspace()
  const [list, setList] = useState<TrashDoc[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const seq = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const my = ++seq.current
    try {
      const docs = await api<TrashDoc[]>('/trash')
      if (my !== seq.current) return
      setList(docs)
      setError('')
    } catch (e) {
      if (my !== seq.current) return
      setError(e instanceof Error ? e.message : '加载失败')
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load, trashVersion])

  const act = async (d: TrashDoc, run: () => Promise<unknown>): Promise<void> => {
    setBusy(d.id)
    try {
      await run()
      await Promise.all([load(), reload()])
    } catch (e) {
      notify(e instanceof Error ? e.message : '操作失败', { error: true })
    } finally {
      setBusy(null)
    }
  }
  const restore = (d: TrashDoc): Promise<void> => act(d, () => post(`/docs/${d.id}/restore`))
  const purge = async (d: TrashDoc): Promise<void> => {
    if (!(await confirmAction({ title: `永久删除"${d.title || '无标题'}"？`, body: '删除后无法恢复。', confirmLabel: '彻底删除', danger: true }))) return
    await act(d, () => api(`/docs/${d.id}/purge`, { method: 'DELETE' }))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-border bg-background px-3 py-1.5">
        <SidebarToggle />
        <h1 className="min-w-0 flex-1 truncate px-2 text-sm font-semibold">回收站</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-2xl px-4 py-6">
          <p className="muted mb-4 text-sm">回收站中的文档会在 30 天后自动彻底删除。</p>
          {error && <p className="error mb-3 text-sm">{error}</p>}
          {list === null && !error && <p className="muted text-sm">加载中…</p>}
          {list?.length === 0 && <p className="muted py-12 text-center text-sm">回收站是空的。删除的文档会先放在这里。</p>}
          {list && list.length > 0 && (
            <ul className="m-0 list-none divide-y divide-border rounded-lg border border-border p-0">
              {list.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{d.title ? <span translate="no">{d.title}</span> : '无标题'}</div>
                    <div className="muted text-xs">删除于 {fmtTime(d.deleted_at)}</div>
                  </div>
                  <Button variant="outline" size="sm" disabled={busy === d.id} onClick={() => void restore(d)}><RotateCcw />恢复</Button>
                  <Button variant="destructive" size="sm" disabled={busy === d.id} onClick={() => void purge(d)}><Trash2 />彻底删除</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
