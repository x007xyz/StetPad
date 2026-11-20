import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button'
import { Dialog, DialogContent } from './ui/dialog'

type Request = { title: string; body?: string; confirmLabel: string; danger?: boolean; resolve: (ok: boolean) => void }

let show: ((r: Request) => void) | null = null

/**
 * An in-app replacement for window.confirm: resolves true when the user
 * confirms, false when they cancel or dismiss. Needs <ConfirmHost /> mounted.
 */
export function confirmAction(opts: { title: string; body?: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
  if (!show) return Promise.resolve(window.confirm(opts.body ? `${opts.title}\n${opts.body}` : opts.title))
  return new Promise((resolve) => show!({ ...opts, resolve }))
}

export function ConfirmHost() {
  const [req, setReq] = useState<Request | null>(null)
  const ok = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    show = (r) => setReq((cur) => {
      cur?.resolve(false)
      return r
    })
    return () => {
      show = null
    }
  }, [])
  const close = (confirmed: boolean): void => {
    req?.resolve(confirmed)
    setReq(null)
  }
  return (
    <Dialog open={req !== null} onOpenChange={(o) => !o && close(false)}>
      {req && (
        <DialogContent
          title={req.title}
          className="max-w-sm"
          // Like window.confirm, Enter confirms: start on the confirm button, not the first one.
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            ok.current?.focus()
          }}
        >
          {req.body && <p className="text-sm text-muted-foreground">{req.body}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => close(false)}>取消</Button>
            <Button ref={ok} variant={req.danger ? 'destructive' : 'default'} className={req.danger ? 'border border-destructive/40' : undefined} onClick={() => close(true)}>{req.confirmLabel}</Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}
