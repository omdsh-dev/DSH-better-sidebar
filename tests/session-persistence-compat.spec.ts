/**
 * Unit tests for the session-persistence compatibility layer
 * (src/session-persistence-compat.ts): the 0.1.3 handle seam, the legacy
 * inspect fallback, and handle cleanup on failure.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SidebarSessionEvent, SidebarSessionPersistenceService } from '../src/context-types.ts'
import { readPersistedSession } from '../src/session-persistence-compat.ts'

const ev = (type: string, seq: number): SidebarSessionEvent => ({ type, seq, time: seq, data: {} }) as SidebarSessionEvent

describe('readPersistedSession', () => {
  it('reads through the 0.1.3 handle seam and closes the handle', async () => {
    const close = vi.fn(async () => {})
    const read = vi.fn(async () => ({ events: [ev('turn/end', 0)] }))
    const open = vi.fn(async () => ({ header: { cwd: '/w', agentPreset: 'standard' }, read, close }))
    const persistence: SidebarSessionPersistenceService = { open }
    const view = await readPersistedSession(persistence, 'session-1')
    expect(open).toHaveBeenCalledWith('session-1', 'read')
    expect(read).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(view.meta).toEqual({ cwd: '/w', agentPreset: 'standard' })
    expect(view.events.map(e => e.type)).toEqual(['turn/end'])
  })

  it('closes the handle even when the read rejects', async () => {
    const close = vi.fn(async () => {})
    const read = vi.fn(async () => { throw new Error('torn tail') })
    const persistence: SidebarSessionPersistenceService = {
      open: async () => ({ header: {}, read, close }),
    }
    await expect(readPersistedSession(persistence, 'session-2')).rejects.toThrow('torn tail')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('falls back to the legacy inspect seam when open is absent', async () => {
    const inspect = vi.fn(async () => ({ meta: { cwd: '/old' }, events: [ev('user/message', 0)] }))
    const persistence: SidebarSessionPersistenceService = { inspect }
    const view = await readPersistedSession(persistence, 'session-3')
    expect(inspect).toHaveBeenCalledWith('session-3')
    expect(view.meta).toEqual({ cwd: '/old' })
  })

  it('prefers the handle seam when both are present', async () => {
    const inspect = vi.fn(async () => ({ meta: {}, events: [] }))
    const close = vi.fn(async () => {})
    const persistence: SidebarSessionPersistenceService = {
      inspect,
      open: async () => ({ header: {}, read: async () => ({ events: [] }), close }),
    }
    await readPersistedSession(persistence, 'session-4')
    expect(inspect).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('rejects with a clear message when the service exposes neither seam', async () => {
    await expect(readPersistedSession({}, 'session-5'))
      .rejects.toThrow('exposes neither open() nor inspect()')
  })

  it('tolerates a header without the optional metadata fields', async () => {
    const persistence: SidebarSessionPersistenceService = {
      open: async () => ({ header: {}, read: async () => ({ events: [] }), close: async () => {} }),
    }
    const view = await readPersistedSession(persistence, 'session-6')
    expect(view.meta).toEqual({})
  })
})
