import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent } from '../components/ui/dialog'
import { Select } from '../components/ui/select'
import { uploadFile } from './media'

type Ratio = 'free' | '1:1' | '4:3' | '16:9'
type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Point {
  x: number
  y: number
}

interface Props {
  docId: string
  /** The `/files/<id>` url of the picture to crop. */
  src: string
  open: boolean
  onClose(): void
  /** Called with the url of the saved copy. The caller swaps it into the block. */
  onSaved(url: string): void
}

const RATIOS: { value: Ratio; label: string }[] = [
  { value: 'free', label: '自由' },
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: '16:9', label: '16:9' },
]
const RATIO_NUMBER: Record<Exclude<Ratio, 'free'>, number> = { '1:1': 1, '4:3': 4 / 3, '16:9': 16 / 9 }
/** The largest the picture is drawn in the dialog, in CSS pixels. */
const BOX_W = 560
const BOX_H = 400
/** The smallest side a crop may have, in picture pixels. */
const MIN_SIDE = 10

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Width and height of the picture after `turn` quarter turns clockwise. */
function turnedSize(w: number, h: number, turn: number): { w: number; h: number } {
  return turn % 2 === 1 ? { w: h, h: w } : { w: w, h: h }
}

/**
 * Draws the picture turned, then flipped horizontally in the turned picture, offset by (ox, oy).
 * The flip is in display space, the same space the crop is in. Shared by the preview and the saved copy.
 */
function paint(ctx: CanvasRenderingContext2D, img: CanvasImageSource, w: number, h: number, turn: number, flip: boolean, ox: number, oy: number): void {
  const t = turnedSize(w, h, turn)
  ctx.save()
  ctx.translate(-ox, -oy)
  ctx.translate(t.w / 2, t.h / 2)
  ctx.scale(flip ? -1 : 1, 1)
  ctx.rotate((turn * Math.PI) / 2)
  ctx.drawImage(img, -w / 2, -h / 2, w, h)
  ctx.restore()
}

/** The crop after one quarter turn clockwise of a picture `w` by `h` (the size before the turn). */
function turnRect(r: Rect, w: number, h: number): Rect {
  return { x: h - (r.y + r.h), y: r.x, w: r.h, h: r.w }
}

/** The crop after a horizontal flip of a picture `w` wide. */
function flipRect(r: Rect, w: number): Rect {
  return { ...r, x: w - (r.x + r.w) }
}

/** The largest rectangle of the given ratio, centred in a `w` by `h` picture. */
function centredRect(w: number, h: number, ratio: number | null): Rect {
  if (!ratio) return { x: 0, y: 0, w, h }
  const rw = w / h > ratio ? h * ratio : w
  const rh = w / h > ratio ? h : w / ratio
  return { x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh }
}

/** Moves or resizes the crop by dragging `handle` to `p`, keeping the ratio when one is set. */
function dragRect(origin: Rect, handle: Handle, start: Point, p: Point, w: number, h: number, ratio: number | null): Rect {
  if (handle === 'move') {
    const x = clamp(origin.x + (p.x - start.x), 0, w - origin.w)
    const y = clamp(origin.y + (p.y - start.y), 0, h - origin.h)
    return { x, y, w: origin.w, h: origin.h }
  }
  // The corner opposite the dragged one stays put.
  const left = handle.includes('w')
  const top = handle.includes('n')
  const ax = left ? origin.x + origin.w : origin.x
  const ay = top ? origin.y + origin.h : origin.y
  const sx = left ? -1 : 1
  const sy = top ? -1 : 1
  const x1 = clamp(p.x, 0, w)
  const y1 = clamp(p.y, 0, h)
  let rw = Math.abs(x1 - ax)
  let rh = Math.abs(y1 - ay)
  if (ratio) {
    if (rw / rh > ratio) rh = rw / ratio
    else rw = rh * ratio
  }
  const maxW = sx > 0 ? w - ax : ax
  const maxH = sy > 0 ? h - ay : ay
  if (rw > maxW) {
    rw = maxW
    if (ratio) rh = rw / ratio
  }
  if (rh > maxH) {
    rh = maxH
    if (ratio) rw = rh * ratio
  }
  rw = Math.max(MIN_SIDE, rw)
  rh = Math.max(MIN_SIDE, rh)
  return { x: sx > 0 ? ax : ax - rw, y: sy > 0 ? ay : ay - rh, w: rw, h: rh }
}

/** Whether any pixel of the canvas is not fully opaque. */
function hasAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return true
  return false
}

/** Crop, rotate and flip one picture of the document, and save it as a new file. */
export function ImageEditDialog({ docId, src, open, onClose, onSaved }: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [mime, setMime] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [turn, setTurn] = useState(0)
  const [flip, setFlip] = useState(false)
  const [crop, setCrop] = useState<Rect | null>(null)
  const [ratio, setRatio] = useState<Ratio>('free')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ handle: Handle; start: Point; origin: Rect } | null>(null)

  // Load the picture each time the dialog opens. Its bytes come from the same origin, so the canvas stays readable.
  useEffect(() => {
    if (!open || !src) return
    let objectUrl: string | null = null
    let cancelled = false
    setImg(null)
    setLoadError(null)
    setTurn(0)
    setFlip(false)
    setRatio('free')
    setError(null)
    fetch(src)
      .then((r) => {
        if (!r.ok) throw new Error('图片读取失败')
        return r.blob()
      })
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        const el = new Image()
        el.onload = () => {
          if (cancelled) return
          setMime(blob.type)
          setCrop({ x: 0, y: 0, w: el.naturalWidth, h: el.naturalHeight })
          setImg(el)
        }
        el.onerror = () => !cancelled && setLoadError('图片读取失败')
        el.src = objectUrl
      })
      .catch((e: unknown) => !cancelled && setLoadError(message(e)))
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [open, src])

  const w = img?.naturalWidth ?? 0
  const h = img?.naturalHeight ?? 0
  const shown = turnedSize(w, h, turn)
  const scale = shown.w && shown.h ? Math.min(BOX_W / shown.w, BOX_H / shown.h, 1) : 1
  const ratioValue = ratio === 'free' ? null : RATIO_NUMBER[ratio]

  // Paint the preview whenever the picture or its turn and flip change.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!img || !canvas) return
    canvas.width = Math.round(shown.w * scale)
    canvas.height = Math.round(shown.h * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.clearRect(0, 0, shown.w, shown.h)
    paint(ctx, img, w, h, turn, flip, 0, 0)
  }, [img, w, h, turn, flip, scale, shown.w, shown.h])

  const rotate = (dir: 1 | -1): void => {
    if (!crop) return
    // A quarter turn counter-clockwise is three clockwise ones.
    const steps = dir === 1 ? 1 : 3
    let r = crop
    let t = turn
    for (let i = 0; i < steps; i++) {
      const before = turnedSize(w, h, t)
      r = turnRect(r, before.w, before.h)
      t = (t + 1) % 4
    }
    setTurn(t)
    setCrop(r)
  }

  const flipH = (): void => {
    if (!crop) return
    setFlip((f) => !f)
    setCrop(flipRect(crop, shown.w))
  }

  const chooseRatio = (value: Ratio): void => {
    setRatio(value)
    if (!shown.w || !shown.h) return
    setCrop(centredRect(shown.w, shown.h, value === 'free' ? null : RATIO_NUMBER[value]))
  }

  const reset = (): void => {
    setTurn(0)
    setFlip(false)
    setRatio('free')
    setCrop({ x: 0, y: 0, w, h })
  }

  const startDrag = (handle: Handle, e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!crop) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { handle, start: pointAt(e), origin: crop }
  }

  const pointAt = (e: ReactPointerEvent): Point => {
    const r = boxRef.current?.getBoundingClientRect()
    return { x: ((e.clientX - (r?.left ?? 0)) / scale), y: ((e.clientY - (r?.top ?? 0)) / scale) }
  }

  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    setCrop(dragRect(d.origin, d.handle, d.start, pointAt(e), shown.w, shown.h, ratioValue))
  }

  const endDrag = (): void => {
    drag.current = null
  }

  const save = async (): Promise<void> => {
    if (!img || !crop || busy) return
    setBusy(true)
    setError(null)
    try {
      const cw = Math.max(1, Math.round(crop.w))
      const ch = Math.max(1, Math.round(crop.h))
      const canvas = document.createElement('canvas')
      canvas.width = cw
      canvas.height = ch
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('无法处理图片')
      paint(ctx, img, w, h, turn, flip, crop.x, crop.y)
      // PNG keeps transparency and suits drawings; photos go to JPEG to stay small.
      const keepPng = mime === 'image/png' || mime === 'image/gif' || (mime === 'image/webp' && hasAlpha(ctx, cw, ch))
      const type = keepPng ? 'image/png' : 'image/jpeg'
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片导出失败'))), type, 0.92),
      )
      const url = await uploadFile(docId, new File([blob], keepPng ? 'edited.png' : 'edited.jpg', { type }))
      onSaved(url)
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  const handleStyle: Record<Exclude<Handle, 'move'>, string> = {
    nw: '-left-1.5 -top-1.5 cursor-nwse-resize',
    ne: '-right-1.5 -top-1.5 cursor-nesw-resize',
    sw: '-left-1.5 -bottom-1.5 cursor-nesw-resize',
    se: '-right-1.5 -bottom-1.5 cursor-nwse-resize',
  }

  const handles: Exclude<Handle, 'move'>[] = ['nw', 'ne', 'sw', 'se']

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent title="编辑图片" className="max-w-2xl">
        <div className="flex flex-col gap-3 pt-1">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={!img || busy} onClick={() => rotate(-1)}>左转 90°</Button>
            <Button variant="outline" size="sm" disabled={!img || busy} onClick={() => rotate(1)}>右转 90°</Button>
            <Button variant="outline" size="sm" disabled={!img || busy} onClick={flipH}>水平翻转</Button>
            <div className="ml-auto w-28">
              <Select
                aria-label="裁剪比例"
                value={ratio}
                size="sm"
                disabled={!img || busy}
                onValueChange={(v) => chooseRatio(v as Ratio)}
                options={RATIOS}
              />
            </div>
          </div>

          <div className="flex min-h-40 items-center justify-center rounded-md bg-muted p-3">
            {loadError && <p className="text-sm text-destructive">{loadError}</p>}
            {!img && !loadError && <p className="text-sm text-muted-foreground">加载中…</p>}
            {img && crop && (
              <div
                ref={boxRef}
                className="relative touch-none select-none overflow-hidden"
                style={{ width: shown.w * scale, height: shown.h * scale }}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <canvas ref={canvasRef} className="block" style={{ width: shown.w * scale, height: shown.h * scale }} />
                <div
                  aria-label="裁剪区域"
                  className="absolute cursor-move border-2 border-white"
                  style={{
                    left: crop.x * scale,
                    top: crop.y * scale,
                    width: crop.w * scale,
                    height: crop.h * scale,
                    boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.45)',
                  }}
                  onPointerDown={(e) => startDrag('move', e)}
                >
                  {handles.map((hd) => (
                    <div
                      key={hd}
                      aria-label={`拖动裁剪角 ${hd}`}
                      className={`absolute size-3 rounded-sm border border-white bg-primary ${handleStyle[hd]}`}
                      onPointerDown={(e) => startDrag(hd, e)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {img && <p className="text-xs text-muted-foreground">{`裁剪后尺寸 ${Math.round(crop?.w ?? 0)} × ${Math.round(crop?.h ?? 0)} 像素`}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" disabled={!img || busy} onClick={reset}>重置</Button>
            <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
            <Button disabled={!img || !crop || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
