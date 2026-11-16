import * as React from 'react'
import { cn } from '@/lib/utils'

const field = 'w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(field, 'h-8', className)} {...props} />
))
Input.displayName = 'Input'

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(field, 'min-h-16 resize-y py-1.5', className)} {...props} />
))
Textarea.displayName = 'Textarea'

export function Field({ label, children, className }: { label: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('mt-3 block text-xs font-medium text-muted-foreground', className)}>
      {label}
      <span className="mt-1 block text-sm font-normal text-foreground">{children}</span>
    </label>
  )
}
