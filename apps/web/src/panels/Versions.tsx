import { useCallback, useEffect, useRef, useState } from 'react'
import { api, fmtTime, post, TRIGGERS, type RichBlock, type VersionMeta } from '../api'
import { History } from 'lucide-react'
import { Button } from '../components/ui/button'
import { confirmAction, promptText } from '../components/confirm'
import { Dialog, DialogContent } from '../components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import { Tip } from '../components/ui/tooltip'
import { alignBlocks, DiffView } from './DiffView'
import { t } from '../i18n'

interface Loaded { meta: VersionMeta; content: { revised: RichBlock[]; original: RichBlock[] } }

const MAX_VERSION_LABEL_LENGTH = 200

export const versionName = (v: VersionMeta): string => v.label || `${t(TRIGGERS[v.trigger] ?? v.trigger)} · ${fmtTime(v.created_at)}`

export function VersionsMenu({ docId, current, refreshKey }: { docId: string; current: () => RichBlock[]; refreshKey: number }) {
  const [list, setList] = useState<VersionMeta[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [compare, setCompare] = useState<{ left: string; right: string; a: RichBlock[]; b: RichBlock[] } | null>(null)
  const [onlyChanged, setOnlyChanged] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [open, setOpen] = useState(false)
  const latestLoad = useRef<{ docId: string } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (latestLoad.current?.docId !== docId) return
    const request = { docId }
    latestLoad.current = request
    try {
      const versions = await api<VersionMeta[]>(`/docs/${docId}/versions`)
      if (latestLoad.current === request) setList(versions)
    } catch (e) {
      if (latestLoad.current === request) throw e
    }
  }, [docId])
  useEffect(() => {
    latestLoad.current = { docId }
    void load()
    return () => { latestLoad.current = null }
  }, [docId, refreshKey, open, load])

  const name = versionName
  const fetchOne = async (id: string): Promise<Loaded> => {
    const v = await api<VersionMeta & { content: Loaded['content'] }>(`/versions/${id}`)
    return { meta: v, content: v.content }
  }
  const save = async (): Promise<void> => {
    const label = await promptText({ title: '给这个版本起个名字（可留空）', confirmLabel: '保存', maxLength: MAX_VERSION_LABEL_LENGTH })
    if (label === null) return
    setError('')
    setNotice('')
    try {
      const { id } = await post<{ id: string | null }>(`/docs/${docId}/versions`, { label })
      if (!id) {
        setNotice('自上个版本以来没有改动，未保存新版本。')
        setOpen(true)
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
      setOpen(true)
    }
  }
  const toggle = (id: string): void =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)))
  const doCompare = async (): Promise<void> => {
    if (picked.length === 2) {
      const [x, y] = await Promise.all(picked.map(fetchOne))
      const [older, newer] = x!.meta.created_at <= y!.meta.created_at ? [x!, y!] : [y!, x!]
      setOpen(false)
      setCompare({ left: name(older.meta), right: name(newer.meta), a: older.content.revised, b: newer.content.revised })
    } else if (picked.length === 1) {
      const v = await fetchOne(picked[0]!)
      setOpen(false)
      setCompare({ left: name(v.meta), right: t('当前文档'), a: v.content.revised, b: current() })
    }
  }
  const restore = async (v: VersionMeta): Promise<void> => {
    if (!(await confirmAction({
      title: `恢复到"${name(v)}"？`,
      body: '当前内容会先保存为一个版本，不会丢失。',
      confirmLabel: '恢复',
    }))) return
    setError('')
    try {
      await post(`/versions/${v.id}/restore`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '恢复失败')
      setOpen(true)
    }
  }
  const rename = async (v: VersionMeta): Promise<void> => {
    const label = await promptText({ title: '版本名称', defaultValue: v.label ?? '', confirmLabel: '保存', maxLength: MAX_VERSION_LABEL_LENGTH })
    if (label === null) return
    setError('')
    try {
      await api(`/versions/${v.id}`, { method: 'PATCH', body: JSON.stringify({ label }) })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
      setOpen(true)
    }
  }

  return (
    <>
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setNotice('') }}>
      <Tip text="版本历史">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" aria-label="版本历史"><History /></Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent>
    <div className="versions" style={{ maxHeight: '70vh' }}>
      <div className="row between pad">
        <button onClick={save}>保存当前版本</button>
        <button disabled={picked.length === 0} onClick={doCompare}>
          {picked.length === 2 ? '对比所选两个版本' : picked.length === 1 ? '与当前文档对比' : '勾选版本以对比'}
        </button>
      </div>
      {error && <p className="error pad" role="alert">{error}</p>}
      {notice && <p className="muted pad" role="status">{notice}</p>}
      {list.length === 0 && <p className="muted pad">还没有版本。AI 操作前后、导入后会自动保存，也可以手动保存。</p>}
      <ul>
        {list.map((v) => (
          <li key={v.id}>
            <label className="version">
              <input type="checkbox" checked={picked.includes(v.id)} onChange={() => toggle(v.id)} />
              <span>
                <span className="v-name" title={v.label || undefined} data-i18n-skip={!!v.label || undefined}>{v.label || t(TRIGGERS[v.trigger] || v.trigger)}</span>
                <span className="muted small">{fmtTime(v.created_at)} · {v.word_count} 字{v.label ? ` · ${t(TRIGGERS[v.trigger] ?? v.trigger)}` : ''}</span>
              </span>
            </label>
            <span className="row">
              <button className="link" onClick={() => rename(v)}>命名</button>
              <button className="link" onClick={() => restore(v)}>恢复</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
      </PopoverContent>
    </Popover>
      <Dialog open={!!compare} onOpenChange={(o) => !o && setCompare(null)}>
        {compare && (
          <DialogContent title="版本对比" className="dialog-diff panel min-h-[40vh] max-w-6xl">
            <label className="row mb-2 text-sm"><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> 只看有变化的段落</label>
            <DiffView rows={alignBlocks(compare.a, compare.b)} leftTitle={compare.left} rightTitle={compare.right} onlyChanged={onlyChanged} skipTitleTranslation />
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}
