import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button'
import { Dialog, DialogContent } from './ui/dialog'
import { Input } from './ui/input'

type Request = { title: string; body?: string; confirmLabel: string; danger?: boolean; text?: { defaultValue?: string; placeholder?: string }; resolve: (value: string | boolean | null) => void }

let show: ((r: Request) => void) | null = null

/**
 * An in-app replacement for window.confirm: resolves true when the user
 * confirms, false when they cancel or dismiss. Needs <ConfirmHost /> mounted.
 */
export function confirmAction(opts: { title: string; body?: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
  if (!show) return Promise.resolve(window.confirm(opts.body ? `${opts.title}\n${opts.body}` : opts.title))
  return new Promise((resolve) => show!({ ...opts, resolve: (value) => resolve(value === true) }))
}

export function promptText(opts: { title: string; defaultValue?: string; placeholder?: string; confirmLabel: string }): Promise<string | null> {
  if (!show) return Promise.resolve(window.prompt(opts.title, opts.defaultValue))
  return new Promise((resolve) => show!({ title: opts.title, confirmLabel: opts.confirmLabel, text: opts, resolve: (value) => resolve(typeof value === 'string' ? value : null) }))
}

export function ConfirmHost() {
  const [req, setReq] = useState<Request | null>(null)
  const ok = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
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
    req?.resolve(req.text ? confirmed ? input.current?.value ?? '' : null : confirmed)
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
            if (req.text) {
              input.current?.focus()
              input.current?.select()
            } else ok.current?.focus()
          }}
        >
          {req.body && <p className="text-sm text-muted-foreground">{req.body}</p>}
          {req.text && <Input key={req.title} ref={input} aria-label={req.title} defaultValue={req.text.defaultValue ?? ''} placeholder={req.text.placeholder} onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              close(true)
            }
          }} />}
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => close(false)}>取消</Button>
            <Button ref={ok} variant={req.danger ? 'destructive' : 'default'} className={req.danger ? 'border border-destructive/40' : undefined} onClick={() => close(true)}>{req.confirmLabel}</Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}
