import * as P from '@radix-ui/react-switch'
import { cn } from '@/lib/utils'

export function Switch({ className, ...p }: React.ComponentPropsWithoutRef<typeof P.Root>) {
  return (
    <P.Root className={cn('inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary', className)} {...p}>
      <P.Thumb className="block size-3 translate-x-0.5 rounded-full bg-background shadow transition-transform data-[state=checked]:translate-x-[14px]" />
    </P.Root>
  )
}
