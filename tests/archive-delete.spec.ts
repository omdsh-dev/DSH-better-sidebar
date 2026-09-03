import { describe, expect, it, vi } from 'vitest'
import { archiveDeleteAvailable, deleteSessionViaArchiveManager } from '../src/client/archive-delete.ts'
import type { Context } from '../src/context-types.ts'

function makeCtx(registry: unknown): Context {
  return { get: () => registry } as unknown as Context
}

describe('archiveDeleteAvailable', () => {
  it('is false when archive-manager has not mounted its remote service', () => {
    expect(archiveDeleteAvailable(makeCtx(undefined))).toBe(false)
  })

  it('is true once the remote workspaceRegistry is present', () => {
    expect(archiveDeleteAvailable(makeCtx({}))).toBe(true)
  })
})

describe('deleteSessionViaArchiveManager', () => {
  it('calls deleteSession on the mounted remote service', async () => {
    const deleteSession = vi.fn(async () => ({ ok: true }))
    const ctx = makeCtx({ deleteSession })
    await deleteSessionViaArchiveManager(ctx, 'child-1')
    expect(deleteSession).toHaveBeenCalledWith('child-1')
  })

  it('surfaces the archive-manager error message', async () => {
    const deleteSession = vi.fn(async () => ({ ok: false, error: { message: 'unknown session' } }))
    const ctx = makeCtx({ deleteSession })
    await expect(deleteSessionViaArchiveManager(ctx, 'child-2')).rejects.toThrow('unknown session')
  })

  it('throws a clear error when the remote service is missing', async () => {
    await expect(deleteSessionViaArchiveManager(makeCtx(undefined), 'child-3'))
      .rejects.toThrow('archive-manager remote service is unavailable')
  })
})
