import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button'
import { Dialog, DialogContent } from './ui/dialog'
import { Input } from './ui/input'

type ConfirmOptions = { title: string; body?: string; confirmLabel: string; danger?: boolean }
type Request = ConfirmOptions & { cancelLabel?: string; text?: { defaultValue?: string; placeholder?: string }; resolve: (value: string | boolean | null) => void }
type ActiveRequest = Request & { opener?: HTMLElement }

let show: ((r: Request) => void) | null = null

/**
 * Resolves true on confirm and false on cancel. With a custom cancel label,
 * dismissal resolves null so only an explicit button click selects an option.
 */
export function confirmAction(opts: ConfirmOptions & { cancelLabel: string }): Promise<boolean | null>
export function confirmAction(opts: ConfirmOptions & { cancelLabel?: never }): Promise<boolean>
export function confirmAction(opts: ConfirmOptions & { cancelLabel?: string }): Promise<boolean | null> {
  if (!show) return Promise.resolve(opts.cancelLabel === undefined ? false : null)
  return new Promise((resolve) => show!({ ...opts, resolve: (value) => resolve(value === null && opts.cancelLabel !== undefined ? null : value === true) }))
}

export function promptText(opts: { title: string; defaultValue?: string; placeholder?: string; confirmLabel: string }): Promise<string | null> {
  if (!show) return Promise.resolve(window.prompt(opts.title, opts.defaultValue))
  return new Promise((resolve) => show!({ title: opts.title, confirmLabel: opts.confirmLabel, text: opts, resolve: (value) => resolve(typeof value === 'string' ? value : null) }))
}

export function ConfirmHost() {
  const [req, setReq] = useState<ActiveRequest | null>(null)
  const ok = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    show = (r) => {
      const active = document.activeElement
      setReq((cur) => {
        cur?.resolve(null)
        return { ...r, opener: cur?.opener ?? (active instanceof HTMLElement ? active : undefined) }
      })
    }
    return () => {
      show = null
    }
  }, [])
  const close = (confirmed: boolean | null): void => {
    req?.resolve(req.text ? confirmed ? input.current?.value ?? '' : null : confirmed)
    setReq(null)
  }
  return (
    <Dialog open={req !== null} onOpenChange={(o) => !o && close(null)}>
      {req && (
        <DialogContent
          title={req.title}
          description={req.body}
          className="max-w-sm"
          layerClassName="z-[1010]"
          // Like window.confirm, Enter confirms: start on the confirm button, not the first one.
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            if (req.text) {
              input.current?.focus()
              input.current?.select()
            } else ok.current?.focus()
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            if (req.opener?.isConnected && document.activeElement === document.body) req.opener.focus()
          }}
        >
          {req.text && <Input key={req.title} ref={input} aria-label={req.title} defaultValue={req.text.defaultValue ?? ''} placeholder={req.text.placeholder} onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              close(true)
            }
          }} />}
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => close(false)}>{req.cancelLabel ?? '取消'}</Button>
            <Button ref={ok} variant={req.danger ? 'destructive' : 'default'} className={req.danger ? 'border border-destructive/40' : undefined} onClick={() => close(true)}>{req.confirmLabel}</Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}
