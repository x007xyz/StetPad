import * as P from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import * as React from 'react'
import { cn, portalRoot } from '@/lib/utils'

/**
 * Radix Select does not allow an empty-string item value, so '' maps to a sentinel
 * and back. Callers keep using '' for "none".
 */
const EMPTY = '__empty__'
export interface Option { value: string; label: string; group?: string; translateLabel?: boolean }

export function Select({ value, onValueChange, options, placeholder, className, disabled, 'aria-label': aria, size = 'default' }: {
  value: string
  onValueChange: (v: string) => void
  options: Option[]
  placeholder?: string
  className?: string
  disabled?: boolean
  'aria-label'?: string
  size?: 'default' | 'sm'
}) {
  const enc = (v: string): string => (v === '' ? EMPTY : v)
  return (
    <P.Root value={value === '' && !options.some((o) => o.value === '') ? undefined : enc(value)} onValueChange={(v) => onValueChange(v === EMPTY ? '' : v)} disabled={disabled}>
      <P.Trigger aria-label={aria} className={cn('inline-flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 data-[placeholder]:text-muted-foreground', size === 'sm' ? 'h-7 text-xs' : 'h-8', className)}>
        <span className="truncate"><P.Value placeholder={placeholder} /></span>
        <ChevronDown className="size-3.5 shrink-0 opacity-60" />
      </P.Trigger>
      <P.Portal container={portalRoot()}>
        <P.Content position="popper" sideOffset={4} className="z-[70] max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg">
          <P.Viewport>
            {options.map((o, i) => (
              <React.Fragment key={o.value}>
              {o.group && o.group !== options[i - 1]?.group && <P.Label className="px-2 py-1 text-xs text-muted-foreground">{o.group}</P.Label>}
              <P.Item value={enc(o.value)} className="relative flex cursor-pointer select-none items-center rounded-md py-1.5 pl-7 pr-2 text-sm outline-none data-[highlighted]:bg-accent">
                <span className="absolute left-2 flex size-3.5 items-center justify-center"><P.ItemIndicator><Check className="size-3.5" /></P.ItemIndicator></span>
                <P.ItemText>{o.translateLabel === false ? <span translate="no">{o.label}</span> : o.label}</P.ItemText>
              </P.Item>
              </React.Fragment>
            ))}
          </P.Viewport>
        </P.Content>
      </P.Portal>
    </P.Root>
  )
}
