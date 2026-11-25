/** Source unit-test seam only. The parent owns the real shared scheduler. */
import { vi } from 'vitest'
import { ClueError } from '../../src/clues/types.ts'
export const runClueProviderRequest = vi.fn(async <T>(_key: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (signal?.aborted === true) throw new ClueError('cancelled', 'cancelled before provider admission')
  return await run()
})
