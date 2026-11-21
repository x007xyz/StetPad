import { useEffect, useRef, useState } from 'react'
import { post } from '../api'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent } from '../components/ui/dialog'
import { Select } from '../components/ui/select'
import { type DiagramKind, renderMath, renderMermaid } from './diagram'

/** What the dialog can make: the diagram kinds, and draw.io (which is drawn in the editor, not here). */
export type DialogKind = DiagramKind | 'drawio'

export interface AiDiagramInitial {
  kind: DialogKind
  prompt?: string
  /** Fix mode: the broken source and the error it produced. */
  previous?: string
  error?: string
  /** Fix mode: the block to replace on insert. */
  blockId?: string
}

interface Props {
  docId: string
  open: boolean
  initial?: AiDiagramInitial
  /** Plain text of the blocks before the cursor. */
  context?: string
  onClose(): void
  onInsert(kind: DialogKind, source: string, blockId?: string): void
}

interface Result {
  kind: DialogKind
  source: string
  svg?: string
  /** For draw.io: what the result holds, shown instead of a preview. */
  note?: string
  renderError?: string
}

const PLACEHOLDER: Record<DialogKind, string> = {
  mermaid: '例如：用户注册登录的流程图',
  math: '例如：正态分布的概率密度函数',
  drawio: '例如：三层架构的系统拓扑图',
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Renders the source in the browser, the same way the editor does. Throws on failure. */
async function testRender(kind: DiagramKind, source: string): Promise<string> {
  if (!source.trim()) throw new Error('生成结果为空')
  return kind === 'math' ? renderMath(source) : renderMermaid(source)
}

/**
 * The browser cannot draw draw.io XML without the editor, so check that it is
 * well-formed XML with an mxGraphModel. Returns the number of shapes. Throws otherwise.
 */
function checkDrawio(source: string): number {
  if (!source.trim()) throw new Error('生成结果为空')
  if (!source.includes('<mxGraphModel')) throw new Error('draw.io XML 缺少 <mxGraphModel>')
  const doc = new DOMParser().parseFromString(source, 'text/xml')
  if (doc.querySelector('parsererror')) throw new Error('draw.io XML 格式不正确')
  return doc.querySelectorAll('mxCell[vertex="1"]').length
}

export function AiDiagramDialog({ docId, open, initial, context, onClose, onInsert }: Props) {
  const fix = !!initial?.previous && !!initial.error
  const [kind, setKind] = useState<DialogKind>('mermaid')
  const [prompt, setPrompt] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Only the latest request may update the dialog.
  const seq = useRef(0)

  const generate = async (k: DialogKind, text: string, fixInfo?: { previous: string; error: string }): Promise<void> => {
    const token = ++seq.current
    setBusy(true)
    setError(null)
    setResult(null)
    const base = { kind: k, prompt: text.trim() || (fixInfo ? '修复这段图表代码的语法错误，保持原意' : ''), context, ...(fixInfo ?? {}) }
    try {
      let source = (await post<{ source: string }>(`/docs/${docId}/ai/diagram`, base)).source
      let svg: string | undefined
      let note: string | undefined
      let renderError: string | undefined
      if (k === 'drawio') {
        try {
          note = `已生成 ${checkDrawio(source)} 个图形，插入后渲染预览`
        } catch (e) {
          // Invalid XML: give the model the error once and try again.
          const retry = await post<{ source: string }>(`/docs/${docId}/ai/diagram`, { ...base, previous: source, error: message(e) })
          source = retry.source
          try {
            note = `已生成 ${checkDrawio(source)} 个图形，插入后渲染预览`
          } catch (e2) {
            renderError = message(e2)
          }
        }
      } else {
        try {
          svg = await testRender(k, source)
        } catch (e) {
          // The first draft did not render: give the model the error once and try again.
          const retry = await post<{ source: string }>(`/docs/${docId}/ai/diagram`, { ...base, previous: source, error: message(e) })
          source = retry.source
          try {
            svg = await testRender(k, source)
          } catch (e2) {
            renderError = message(e2)
          }
        }
      }
      if (token !== seq.current) return
      setResult({ kind: k, source, svg, note, renderError })
    } catch (e) {
      if (token !== seq.current) return
      setError(message(e))
    } finally {
      if (token === seq.current) setBusy(false)
    }
  }

  // Each time the dialog opens, start from the initial values. A fix request runs at once.
  useEffect(() => {
    if (!open) {
      seq.current++
      return
    }
    const k = initial?.kind ?? 'mermaid'
    setKind(k)
    setPrompt(initial?.prompt ?? '')
    setResult(null)
    setError(null)
    if (initial?.previous && initial.error) {
      void generate(k, initial.prompt ?? '', { previous: initial.previous, error: initial.error })
    }
    // Runs only when the dialog opens; the other values are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** Fix mode keeps the broken source and its error, so a retry asks for the same fix. */
  const regenerate = (): void => {
    const fixInfo = fix && initial?.previous && initial.error ? { previous: initial.previous, error: initial.error } : undefined
    void generate(kind, prompt, fixInfo)
  }

  const insert = (): void => {
    if (!result) return
    onInsert(result.kind, result.source, fix && result.kind !== 'drawio' ? initial?.blockId : undefined)
    onClose()
  }

  const title = fix ? 'AI 修复图表' : 'AI 生成图表'

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={title} description={fix ? '根据渲染错误修正这段代码。' : undefined} className="max-w-xl">
        <div className="flex flex-col gap-3 pt-1">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">类型</span>
            <Select
              aria-label="类型"
              value={kind}
              disabled={fix || busy}
              onValueChange={(v) => setKind(v as DialogKind)}
              options={[
                { value: 'mermaid', label: 'Mermaid 图表' },
                { value: 'math', label: '公式' },
                { value: 'drawio', label: 'draw.io 图' },
              ]}
            />
          </div>
          {!fix && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">描述</span>
              <textarea
                className="min-h-20 w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                placeholder={PLACEHOLDER[kind]}
                value={prompt}
                disabled={busy}
                onChange={(e) => setPrompt(e.target.value)}
              />
              {context && <p className="text-xs text-muted-foreground">根据文档上下文</p>}
            </div>
          )}
          {busy && <p className="text-sm text-muted-foreground">生成中…</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {result && (
            <div className="flex flex-col gap-2">
              {result.kind === 'drawio' ? (
                result.renderError ? (
                  <p className="text-sm text-destructive">{`生成失败：${result.renderError}`}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">{result.note}</p>
                )
              ) : result.svg ? (
                <div className="diagram-preview" translate="no" dangerouslySetInnerHTML={{ __html: result.svg }} />
              ) : (
                <p className="text-sm text-destructive">{`渲染失败：${result.renderError}`}</p>
              )}
              <pre translate="no" className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground">{result.source}</pre>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose}>取消</Button>
            {result && (
              <>
                <Button variant="outline" disabled={busy} onClick={regenerate}>重新生成</Button>
                <Button disabled={busy || (result.kind === 'drawio' && !!result.renderError)} onClick={insert}>插入</Button>
              </>
            )}
            {!result && fix && error && (
              <Button variant="outline" disabled={busy} onClick={regenerate}>重试</Button>
            )}
            {!result && !fix && (
              <Button disabled={busy || !prompt.trim()} onClick={() => void generate(kind, prompt)}>生成</Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
