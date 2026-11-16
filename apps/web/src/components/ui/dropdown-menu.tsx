import * as P from '@radix-ui/react-dropdown-menu'
import * as React from 'react'
import { cn, portalRoot } from '@/lib/utils'

export const DropdownMenu = P.Root
export const DropdownMenuTrigger = P.Trigger
export const DropdownMenuSeparator = () => <P.Separator className="my-1 h-px bg-border" />
export const DropdownMenuLabel = ({ children }: { children: React.ReactNode }) => <P.Label className="px-2 py-1 text-xs text-muted-foreground">{children}</P.Label>

export const DropdownMenuContent = React.forwardRef<React.ElementRef<typeof P.Content>, React.ComponentPropsWithoutRef<typeof P.Content>>(({ className, sideOffset = 4, ...p }, ref) => (
  <P.Portal container={portalRoot()}>
    <P.Content ref={ref} sideOffset={sideOffset} className={cn('z-[60] min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg', className)} {...p} />
  </P.Portal>
))
DropdownMenuContent.displayName = 'DropdownMenuContent'

export const DropdownMenuItem = React.forwardRef<React.ElementRef<typeof P.Item>, React.ComponentPropsWithoutRef<typeof P.Item>>(({ className, ...p }, ref) => (
  <P.Item ref={ref} className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent', className)} {...p} />
))
DropdownMenuItem.displayName = 'DropdownMenuItem'
