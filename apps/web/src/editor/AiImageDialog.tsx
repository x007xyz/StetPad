import { useEffect, useRef, useState } from 'react'
import { api, post } from '../api'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent } from '../components/ui/dialog'
import { Select } from '../components/ui/select'
import { cn } from '../lib/utils'
import { useImageModelCatalog } from './useImageModelCatalog'
import { t } from '../i18n'

type ImageSize = '1024x1024' | '1536x1024' | '1024x1536'

interface GenerateResponse { url: string; id: string; mime: string; modelId: string }

interface Props {
  docId: string
  open: boolean
  initialPrompt?: string
  onClose(): void
  onInsert(img: { url: string; alt: string }): void
}

interface Generated {
  url: string
  /** The trimmed prompt the image was made from. */
  prompt: string
}

const SIZES: { value: ImageSize; label: string }[] = [
  { value: '1024x1024', label: '方形 1:1' },
  { value: '1536x1024', label: '横版 3:2' },
  { value: '1024x1536', label: '竖版 2:3' },
]

const NO_MODELS = '还没有可用的图片模型。请在设置里配置 OpenAI、Google 或 OpenRouter 的密钥。'
const ALT_MAX = 80

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function AiImageDialog({ docId, open, initialPrompt, onClose, onInsert }: Props) {
  const [size, setSize] = useState<ImageSize>('1024x1024')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState<Generated | null>(null)
  // Results from this session, newest first. The dialog stays mounted, so they survive reopening.
  const [history, setHistory] = useState<Generated[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const startedAt = useRef(0)

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort()
      abortRef.current = null
      setBusy(false)
      return
    }
    setPrompt(initialPrompt ?? '')
    setCurrent(null)
    setError(null)
    // Runs only when the dialog opens; initialPrompt is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const { models, modelId, setModelId } = useImageModelCatalog(open, 'generate', setError)

  // Elapsed seconds while a request is in flight.
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000)
    return () => clearInterval(id)
  }, [busy])

  const hasModels = (models?.length ?? 0) > 0
  const text = prompt.trim()
  const canGenerate = hasModels && !!modelId && !!text && !busy

  const generate = async (): Promise<void> => {
    if (!canGenerate) return
    const ctrl = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ctrl
    startedAt.current = Date.now()
    setElapsed(0)
    setBusy(true)
    setError(null)
    try {
      const res = await api<GenerateResponse>(`/docs/${docId}/ai/image`, {
        method: 'POST',
        body: JSON.stringify({ prompt: text, modelId, size }),
        signal: ctrl.signal,
      })
      if (ctrl.signal.aborted) return
      const gen: Generated = { url: res.url, prompt: text }
      setCurrent(gen)
      setHistory((h) => [gen, ...h].slice(0, 12))
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
  const cancelGenerate = (): void => {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
  }

  const insert = (): void => {
    if (!current) return
    onInsert({ url: current.url, alt: current.prompt.slice(0, ALT_MAX).trim() })
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="AI 生成图片" className="max-w-xl">
        <div className="flex flex-col gap-3 pt-1">
          {models !== null && !hasModels && <p className="text-sm text-destructive">{NO_MODELS}</p>}
          <div className="flex gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">模型</span>
              <Select
                aria-label="模型"
                value={modelId}
                disabled={busy || !hasModels}
                onValueChange={setModelId}
                placeholder={models === null ? '加载中…' : '没有可用的模型'}
                options={(models ?? []).map((m) => ({ value: m.id, label: m.price ? `${m.label} · ${m.price}` : m.label }))}
              />
            </div>
            <div className="flex w-36 shrink-0 flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">比例</span>
              <Select
                aria-label="比例"
                value={size}
                disabled={busy}
                onValueChange={(v) => setSize(v as ImageSize)}
                options={SIZES}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">描述</span>
            <textarea
              className="min-h-20 w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              placeholder="例如：水彩风格的江南水乡清晨，薄雾，石桥"
              value={prompt}
              disabled={busy}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void generate()
                }
              }}
            />
          </div>
          {busy && <p className="text-sm text-muted-foreground">{`生成中… ${elapsed}s`}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {current && !busy && (
            <img
              src={current.url}
              alt={current.prompt}
              className="max-h-[50vh] w-full rounded-md bg-muted object-contain"
            />
          )}
          {history.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">本次会话生成的图片</span>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {history.map((h) => (
                  <button
                    key={h.url}
                    type="button"
                    translate="no"
                    title={h.prompt}
                    aria-label={t(`选择图片：${h.prompt}`)}
                    aria-pressed={current?.url === h.url}
                    disabled={busy}
                    onClick={() => setCurrent(h)}
                    className={cn(
                      'size-14 shrink-0 overflow-hidden rounded-md border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50',
                      current?.url === h.url ? 'border-ring ring-2 ring-ring/40' : 'border-border',
                    )}
                  >
                    <img src={h.url} alt="" className="size-full object-cover" />
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            {busy ? (
              <Button variant="outline" onClick={cancelGenerate}>取消生成</Button>
            ) : (
              <>
                <Button variant="outline" onClick={onClose}>取消</Button>
                {current ? (
                  <>
                    <Button variant="outline" disabled={!canGenerate} onClick={() => void generate()}>重新生成</Button>
                    <Button onClick={insert}>插入</Button>
                  </>
                ) : (
                  <Button disabled={!canGenerate} onClick={() => void generate()}>生成</Button>
                )}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
