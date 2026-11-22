import { t } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent } from '../components/ui/dialog'
import { Select } from '../components/ui/select'
import { cn } from '../lib/utils'
import { useImageModelCatalog } from './useImageModelCatalog'

interface EditResponse { url: string; id: string; mime: string; modelId: string }

interface Props {
  docId: string
  /** The `/files/<id>` url of the picture to edit. */
  src: string
  open: boolean
  onClose(): void
  /** Swap the result into the original block. */
  onReplace(url: string): void
  /** Insert the result as a new image after the original, with this alt text. */
  onInsert(url: string, alt: string): void
}

interface Edited {
  url: string
  /** The trimmed prompt the result was made from. */
  prompt: string
}

const NO_MODELS = '还没有可用的图片编辑模型。请在设置里配置 OpenAI 或 OpenRouter 的密钥。'
const ALT_MAX = 80

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Edits one picture of the document with an AI model, from a text instruction. */
export function AiImageEditDialog({ docId, src, open, onClose, onReplace, onInsert }: Props) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Edited | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const startedAt = useRef(0)

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort()
      abortRef.current = null
      setBusy(false)
      return
    }
    setPrompt('')
    setResult(null)
    setError(null)
    setShowOriginal(false)
  }, [open])

  const { models, modelId, setModelId } = useImageModelCatalog(open, 'edit', setError)

  // Elapsed seconds while a request is in flight.
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000)
    return () => clearInterval(id)
  }, [busy])

  const hasModels = (models?.length ?? 0) > 0
  const text = prompt.trim()
  const canEdit = hasModels && !!modelId && !!text && !busy

  const edit = async (): Promise<void> => {
    if (!canEdit) return
    const ctrl = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ctrl
    startedAt.current = Date.now()
    setElapsed(0)
    setBusy(true)
    setError(null)
    try {
      const res = await api<EditResponse>(`/docs/${docId}/ai/image-edit`, {
        method: 'POST',
        body: JSON.stringify({ src, prompt: text, modelId }),
        signal: ctrl.signal,
      })
      if (ctrl.signal.aborted) return
      setResult({ url: res.url, prompt: text })
      setShowOriginal(false)
    } catch (e) {
      if (ctrl.signal.aborted) return
      setError(message(e))
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null
        setBusy(false)
      }
    }
  }

  /** Stops the request in flight; the dialog stays open. */
  const cancelEdit = (): void => {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
  }

  const replace = (): void => {
    if (!result) return
    onReplace(result.url)
    onClose()
  }

  const insert = (): void => {
    if (!result) return
    onInsert(result.url, result.prompt.slice(0, ALT_MAX).trim())
    onClose()
  }

  const shown = result && !showOriginal ? result.url : src

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent title="AI 改图" className="max-w-xl">
        <div className="flex flex-col gap-3 pt-1">
          {models !== null && !hasModels && <p className="text-sm text-destructive">{NO_MODELS}</p>}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">模型</span>
            <Select
              aria-label="模型"
              value={modelId}
              disabled={busy || !hasModels}
              onValueChange={setModelId}
              placeholder={models === null ? '加载中…' : '没有可用的模型'}
              options={(models ?? []).map((m) => ({ value: m.id, label: m.label }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">修改要求</span>
            <textarea
              className="min-h-20 w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              placeholder="例如：把背景换成傍晚的海边，保留人物"
              value={prompt}
              disabled={busy}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void edit()
                }
              }}
            />
          </div>
          {busy && <p className="text-sm text-muted-foreground">{`改图中… ${elapsed}s`}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {result && !busy && (
            <div className="flex flex-col gap-2">
              <div className="flex gap-1 self-end" role="group" aria-label="预览">
                <button
                  type="button"
                  aria-pressed={showOriginal}
                  onClick={() => setShowOriginal(true)}
                  className={cn('rounded-md border px-2.5 py-1 text-xs', showOriginal ? 'border-ring bg-accent' : 'border-border')}
                >
                  原图
                </button>
                <button
                  type="button"
                  aria-pressed={!showOriginal}
                  onClick={() => setShowOriginal(false)}
                  className={cn('rounded-md border px-2.5 py-1 text-xs', !showOriginal ? 'border-ring bg-accent' : 'border-border')}
                >
                  新图
                </button>
              </div>
              <img src={shown} alt={showOriginal ? t('原图') : result.prompt} className="max-h-[50vh] w-full rounded-md bg-muted object-contain" />
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            {busy ? (
              <Button variant="outline" onClick={cancelEdit}>取消改图</Button>
            ) : (
              <>
                <Button variant="outline" onClick={onClose}>取消</Button>
                {result ? (
                  <>
                    <Button variant="outline" disabled={!canEdit} onClick={() => void edit()}>重新生成</Button>
                    <Button variant="outline" onClick={insert}>插入为新图片</Button>
                    <Button onClick={replace}>替换原图</Button>
                  </>
                ) : (
                  <Button disabled={!canEdit} onClick={() => void edit()}>改图</Button>
                )}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
