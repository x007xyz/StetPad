import { useEffect, useState } from 'react'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent } from '../components/ui/dialog'
import { Field, Input } from '../components/ui/input'
import { unfurlLink, type LinkCardAttrs } from './linkcard'

interface Props {
  docId: string
  open: boolean
  onClose(): void
  onInsert(card: LinkCardAttrs): void
}

const INVALID = '请输入 http 或 https 网址'
// A bare domain like "example.com/post" gets https in front.
const BARE = /^[\w-]+(\.[\w-]+)+(\/\S*)?$/

/** The address as it will be sent: trimmed, with https when only a host was typed. */
function normalize(raw: string): string {
  const t = raw.trim()
  return BARE.test(t) ? `https://${t}` : t
}

/** The URL dialog for a link card. The page is read when inserting, so the dialog waits for it. */
export function LinkCardDialog({ docId, open, onClose, onInsert }: Props) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setUrl('')
    setBusy(false)
    setError('')
  }, [open])

  const src = normalize(url)
  const valid = /^https?:\/\/\S+$/i.test(src)

  const insert = async (): Promise<void> => {
    if (!valid || busy) return
    setBusy(true)
    setError('')
    try {
      const card = await unfurlLink(docId, src)
      onInsert(card)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '获取网页信息失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent title="链接卡片" className="max-w-xl">
        <div className="flex flex-col gap-1">
          <Field label="网址">
            <Input
              autoFocus
              placeholder="https://example.com/article"
              value={url}
              aria-invalid={!!src && !valid}
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void insert()
                }
              }}
            />
          </Field>
          {error ? <p className="mt-1.5 text-sm text-destructive">{error}</p> : <p className="mt-1.5 text-xs text-muted-foreground">{!src || valid ? '会读取网页的标题、简介和图片' : INVALID}</p>}

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
            <Button disabled={!valid || busy} onClick={() => void insert()}>{busy ? '正在获取…' : '插入'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
