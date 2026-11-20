import { FilePlus2, FileText, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { api, fmtTime, getToken, isDesktop, post, type DocMeta, type RichBlock } from './api'
import { go } from './App'
import { Button } from './components/ui/button'
import { Dialog, DialogContent } from './components/ui/dialog'
import { Field, Input } from './components/ui/input'
import { SidebarToggle, useWorkspace } from './Shell'

interface Preview { title: string; blocks: RichBlock[] }

/** The message for an import that left files out: their names, five at most. */
const droppedNote = (dropped: { name: string | null; mime: string }[]): string => {
  const names = dropped.slice(0, 5).map((d) => d.name ?? (d.mime || '未命名文件'))
  return `导入完成，但有 ${dropped.length} 个文件没有带过来：${names.join('、')}${dropped.length > 5 ? '等' : ''}`
}

/** The landing page: the documents, plus import by drag and drop. */
export function Home() {
  const { docs, createDoc } = useWorkspace()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  /** A document package (.stetpad zip, or a .stetpad.json export): the server creates the document from it. */
  const importPackage = async (f: File): Promise<void> => {
    setError('')
    setBusy('正在导入文档包…')
    try {
      const res = await fetch('/api/import/package', {
        method: 'POST',
        headers: { authorization: `Bearer ${getToken()}`, 'content-type': 'application/octet-stream' },
        body: f,
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(j?.error ?? `导入失败（${res.status}）`)
      }
      const doc = (await res.json()) as DocMeta & { dropped?: { name: string | null; mime: string }[] }
      go({ page: 'doc', id: doc.id })
      // Files the package could not bring across are named after the document opens.
      const dropped = doc.dropped ?? []
      if (dropped.length > 0) window.setTimeout(() => alert(droppedNote(dropped)), 300)
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败')
    } finally {
      setBusy('')
    }
  }
  const importFile = async (f: File): Promise<void> => {
    const my = ++seq.current
    if (/\.stetpad(\.zip|\.json)?$/i.test(f.name)) return importPackage(f)
    setError('')
    setBusy(`正在解析 ${f.name}…`)
    try {
      const form = new FormData()
      form.append('file', f)
      const next = await api<Preview>('/import/preview', { method: 'POST', body: form })
      if (my !== seq.current) return
      setPreview(next)
    } catch (e) {
      if (my !== seq.current) return
      setError(e instanceof Error ? e.message : '导入失败')
    } finally {
      if (my === seq.current) setBusy('')
    }
  }
  const confirmImport = async (): Promise<void> => {
    if (!preview) return
    go({ page: 'doc', id: (await post<DocMeta>('/import/create', preview)).id })
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const f = e.dataTransfer.files[0]
        if (f) void importFile(f)
      }}
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <SidebarToggle />
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl px-5 pb-24 pt-10 sm:px-10 sm:pt-16">
          <h1 className="text-3xl font-bold tracking-tight">我的文档</h1>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button variant="default" onClick={createDoc}><FilePlus2 />新建文档</Button>
            <Button onClick={() => file.current?.click()}><Upload />导入文件</Button>
          </div>
          <input ref={file} type="file" hidden accept=".docx,.pdf,.html,.htm,.md,.markdown,.txt,.stetpad,.json" onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void importFile(f)
          }} />
          {busy && <p className="muted mt-4">{busy}</p>}
          {error && <p className="error mt-4">{error}</p>}
          <div className="mt-8">
            {docs === null ? (
              <p className="muted">加载中…</p>
            ) : docs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-6 py-14 text-center">
                <p>还没有文档。</p>
                <p className="muted mt-1">新建一篇，或把 Word、PDF、HTML、Markdown 文件拖到这里导入。{isDesktop ? '文档保存在这台电脑上。' : ''}</p>
              </div>
            ) : (
              <ul className="m-0 list-none p-0">
                {docs.map((d) => (
                  <li key={d.id}>
                    <button className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent" onClick={() => go({ page: 'doc', id: d.id })}>
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{d.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{fmtTime(d.updated_at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </main>
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        {preview && (
          <DialogContent title="导入预览" className="max-w-3xl">
            <p className="muted">原文档的排版不会保留，内容已整理成下面的简单格式。共 {preview.blocks.length} 个段落。</p>
            <Field label="标题">
              <Input value={preview.title} onChange={(e) => setPreview({ ...preview, title: e.target.value })} />
            </Field>
            <div className="preview">
              {preview.blocks.slice(0, 200).map((b, i) => (
                <div key={i} className={`pv pv-${b.type}`} data-level={String(b.attrs.level ?? '')}>
                  <span className="pv-tag">{b.type}</span>
                  {b.type === 'table' ? '（表格）' : b.type === 'image' ? '（图片）' : b.type === 'divider' ? '———' : b.delta.map((d) => d.insert).join('')}
                </div>
              ))}
              {preview.blocks.length > 200 && <p className="muted">……其余 {preview.blocks.length - 200} 段未显示</p>}
            </div>
            <div className="row end">
              <Button onClick={() => setPreview(null)}>取消</Button>
              <Button variant="default" onClick={confirmImport}>创建文档</Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
