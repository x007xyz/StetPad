import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import * as React from 'react'
import { cn, portalRoot } from '@/lib/utils'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { title: string; description?: string; hideTitle?: boolean }
>(({ className, children, title, description, hideTitle, ...props }, ref) => (
  <DialogPrimitive.Portal container={portalRoot()}>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
    <DialogPrimitive.Content
      ref={ref}
      aria-describedby={description ? undefined : undefined}
      className={cn('fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[calc(100vw-24px)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl outline-none', className)}
      {...props}
    >
      <div className="flex items-center justify-between px-5 pb-1 pt-4">
        <DialogPrimitive.Title className={cn('text-base font-semibold', hideTitle && 'sr-only')}>{title}</DialogPrimitive.Title>
        <DialogPrimitive.Close aria-label="关闭" className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><X className="size-4" /></DialogPrimitive.Close>
      </div>
      {description && <DialogPrimitive.Description className="px-5 text-xs text-muted-foreground">{description}</DialogPrimitive.Description>}
      <div className="min-h-0 flex-1 overflow-auto px-5 pb-5 pt-2">{children}</div>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
))
DialogContent.displayName = 'DialogContent'

/** A bottom or side sheet, built on the same primitive. */
export const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { side?: 'left' | 'bottom'; title: string }
>(({ className, children, side = 'left', title, ...props }, ref) => (
  <DialogPrimitive.Portal container={portalRoot()}>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
    <DialogPrimitive.Content
      ref={ref}
      aria-describedby={undefined}
      className={cn(
        'fixed z-50 flex flex-col bg-sidebar text-foreground shadow-2xl outline-none',
        side === 'left' ? 'inset-y-0 left-0 w-[280px] max-w-[85vw] border-r border-border' : 'inset-x-0 bottom-0 h-[78vh] rounded-t-xl border-t border-border bg-background',
        className,
      )}
      {...props}
    >
      <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
))
SheetContent.displayName = 'SheetContent'
