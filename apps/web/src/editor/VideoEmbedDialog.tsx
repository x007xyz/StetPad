import { embedPlayerUrl } from '@stetpad/clip'
import { useEffect, useState } from 'react'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent } from '../components/ui/dialog'
import { Field, Input } from '../components/ui/input'

export interface VideoEmbed {
  /** The page link as the user gave it (https). The player URL is derived from it when shown. */
  src: string
  title: string
}

interface Props {
  open: boolean
  onClose(): void
  onInsert(video: VideoEmbed): void
}

const INVALID = '支持 B 站、YouTube、Vimeo 的视频链接'
// Bare links like "youtu.be/..." or "www.bilibili.com/video/..." get https in front.
const BARE = /^(?:www\.|m\.)?(?:bilibili\.com|youtube\.com|youtu\.be|vimeo\.com)\//i

/** The link as it will be stored: trimmed, with https when the scheme was left out. */
function normalize(raw: string): string {
  const t = raw.trim()
  return BARE.test(t) ? `https://${t}` : t
}

export function VideoEmbedDialog({ open, onClose, onInsert }: Props) {
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (!open) return
    setUrl('')
    setTitle('')
  }, [open])

  const src = normalize(url)
  const player = src ? embedPlayerUrl(src) : null
  const invalid = !!src && !player
  const canInsert = !!player

  const insert = (): void => {
    if (!canInsert) return
    onInsert({ src, title: title.trim() })
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="嵌入视频" className="max-w-xl">
        <div className="flex flex-col gap-1">
          <Field label="视频链接">
            <Input
              autoFocus
              placeholder="https://www.bilibili.com/video/BV…"
              value={url}
              aria-invalid={invalid}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  insert()
                }
              }}
            />
          </Field>
          {invalid && <p className="mt-1.5 text-sm text-destructive">{INVALID}</p>}
          {!src && <p className="mt-1.5 text-xs text-muted-foreground">{INVALID}</p>}

          <Field label="标题（可选）">
            <Input placeholder="视频标题" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>

          {player && (
            <div className="mt-3 overflow-hidden rounded-md border border-border bg-muted">
              <div className="relative w-full pb-[56.25%]">
                <iframe
                  src={player}
                  title={title.trim() || '视频预览'}
                  className="absolute inset-0 size-full border-0"
                  allow="fullscreen; picture-in-picture; encrypted-media"
                  allowFullScreen
                  referrerPolicy="strict-origin-when-cross-origin"
                  sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
                  loading="lazy"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button disabled={!canInsert} onClick={insert}>插入</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
