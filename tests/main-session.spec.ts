import { describe, expect, it, vi } from 'vitest'
import { conversationShown, mainSessionId, switchMainSession } from '../src/client/main-session.ts'

describe('mainSessionId', () => {
  it('reads the retention dsh 0.1.6-alpha.2 publishes: the session `mainView` holds', () => {
    expect(mainSessionId({
      byId: {
        a: { retainedBy: {} },
        b: { retainedBy: { mainView: 1, sidebar: 2 } },
        c: { retainedBy: { sidebar: 1 } },
      },
    })).toBe('b')
  })

  it('still honours a published `current` (dsh ≤ 0.1.6-alpha.1, and this suite\'s fakes)', () => {
    expect(mainSessionId({ current: 's1', byId: { s1: {} } })).toBe('s1')
  })

  it('answers undefined when nothing is on screen', () => {
    expect(mainSessionId({ byId: {} })).toBeUndefined()
    expect(mainSessionId({ byId: { a: { retainedBy: { mainView: 0 } }, b: undefined } })).toBeUndefined()
  })
})

describe('switchMainSession', () => {
  it('uses sessions.open where the host still has it', () => {
    const open = vi.fn()
    const get = vi.fn()
    switchMainSession({ sessions: { open }, get }, 's1')
    expect(open).toHaveBeenCalledWith('s1')
    expect(get).not.toHaveBeenCalled()
  })

  it('falls back to the uiWorkspace service on dsh 0.1.6-alpha.2', () => {
    const openSession = vi.fn()
    switchMainSession({ sessions: {}, get: (name) => (name === 'uiWorkspace' ? { openSession } : undefined) }, 's2')
    expect(openSession).toHaveBeenCalledWith('s2')
  })

  it('does nothing on a host with neither, as the optional call did', () => {
    expect(() => switchMainSession({ sessions: {} }, 's3')).not.toThrow()
  })
})

describe('conversationShown (round 6, acceptance v4 SEND-v4-new-1)', () => {
  const list = (main: string) => ({ byId: { a: { retainedBy: main === 'a' ? { mainView: 1 } : {} }, b: { retainedBy: main === 'b' ? { mainView: 1 } : {} } } })

  it('is true for the session in the main view, false for one kept behind it — whatever the tab\'s own visibility', () => {
    expect(conversationShown(list('a'), 'a', false)).toBe(true)
    expect(conversationShown(list('a'), 'b', true)).toBe(false)
  })

  it('falls back to the tab\'s visibility where the host names no main view, or the tab has no session', () => {
    expect(conversationShown({ byId: {} }, 'a', true)).toBe(true)
    expect(conversationShown({ byId: {} }, 'a', false)).toBe(false)
    expect(conversationShown(undefined, 'a', false)).toBe(false)
    expect(conversationShown(list('b'), '', true)).toBe(true)
  })
})
