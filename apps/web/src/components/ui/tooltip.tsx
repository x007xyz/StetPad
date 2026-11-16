import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as React from 'react'
import { portalRoot } from '@/lib/utils'

export const TooltipProvider = TooltipPrimitive.Provider

/** Wraps one element; the text is the tooltip. Keep an aria-label on icon-only triggers. */
export function Tip({ text, children, side = 'bottom' }: { text: string; children: React.ReactElement; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <TooltipPrimitive.Root delayDuration={350}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal container={portalRoot()}>
        <TooltipPrimitive.Content side={side} sideOffset={6} className="z-[60] rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-md">{text}</TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
