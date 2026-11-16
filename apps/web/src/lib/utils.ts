import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs))

/**
 * Overlays render inside #root so the language switch (which watches #root) also translates them.
 */
export const portalRoot = (): HTMLElement | undefined => document.getElementById('root') ?? undefined
