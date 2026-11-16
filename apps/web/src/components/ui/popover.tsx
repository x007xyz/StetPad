import * as P from '@radix-ui/react-popover'
import * as React from 'react'
import { cn, portalRoot } from '@/lib/utils'

export const Popover = P.Root
export const PopoverTrigger = P.Trigger

export const PopoverContent = React.forwardRef<React.ElementRef<typeof P.Content>, React.ComponentPropsWithoutRef<typeof P.Content>>(({ className, sideOffset = 6, align = 'end', ...p }, ref) => (
  <P.Portal container={portalRoot()}>
    <P.Content ref={ref} sideOffset={sideOffset} align={align} className={cn('panel z-[60] w-[360px] max-w-[calc(100vw-24px)] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg outline-none', className)} {...p} />
  </P.Portal>
))
PopoverContent.displayName = 'PopoverContent'
