/**
 * The shadcn/ui class-name helper: `clsx` for conditional composition,
 * `tailwind-merge` so a caller's later utility wins over a component's default
 * of the same kind (`cn('px-2', 'px-4')` -> `px-4`) instead of both landing in
 * the class list and letting stylesheet order decide.
 *
 * Vendored shadcn components import this file directly (relative path); the
 * CLI's `@/lib/utils` alias is never used in this repo.
 */
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge conditional class values, resolving conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
