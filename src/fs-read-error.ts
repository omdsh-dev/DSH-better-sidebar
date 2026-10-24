import { SidebarError } from './wire.ts'

/**
 * Convert a filesystem read failure into the message returned by sidebar routes.
 * ENOENT stays readable without exposing Node's platform-specific error text.
 */
export function fileReadError(path: string, error: unknown): SidebarError {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
  const message = code === 'ENOENT'
    ? `File not found: "${path}"`
    : `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`
  return new SidebarError('fs-error', message, 400)
}
