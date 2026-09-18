/**
 * The on-screen session must be resolved on both runtime generations.
 *
 * DSH 0.1.5 published the visible conversation as `sessions.list.current`.
 * 0.1.6-alpha.2 removed the field: the sidebar then set no session at all, and
 * every file click ran `openFile` → `openTab`, which returns silently when the
 * store has no session id — a click that opened nothing and logged nothing.
 *
 * The fallback mirrors the runtime's own rule (ui-session `publishMain`): the
 * current session is the row some consumer retains as the main view.
 */
import { describe, expect, it } from 'vitest'
import type { SidebarSessionList } from '../src/context-types.ts'
import { mainViewSessionId } from '../src/client/Sidebar.tsx'

/** Build a list snapshot with the fields the sidebar reads. */
function listOf(overrides: Partial<SidebarSessionList>): SidebarSessionList {
  return { byId: {}, ...overrides }
}

describe('mainViewSessionId', () => {
  it('prefers the id a runtime that still publishes current reports', () => {
    const list = listOf({
      current: 'legacy',
      ids: ['first', 'legacy'],
      byId: { first: { id: 'first', displayTitle: 'first' }, legacy: { id: 'legacy', displayTitle: 'legacy' } },
    })
    expect(mainViewSessionId(list)).toBe('legacy')
  })

  it('finds the retained main view when current is absent', () => {
    const list = listOf({
      ids: ['other', 'main'],
      byId: {
        other: { id: 'other', displayTitle: 'other', retainedBy: { sidebar: 1 } },
        main: { id: 'main', displayTitle: 'main', retainedBy: { mainView: 1 } },
      },
    })
    expect(mainViewSessionId(list)).toBe('main')
  })

  it('does not fall back to the first listed row', () => {
    // Catalog order is host order, so a first-row fallback would bind the
    // sidebar to a session the user is not looking at.
    const list = listOf({
      ids: ['first', 'second'],
      byId: {
        first: { id: 'first', displayTitle: 'first' },
        second: { id: 'second', displayTitle: 'second' },
      },
    })
    expect(mainViewSessionId(list)).toBeUndefined()
  })

  it('ignores a zero main-view count', () => {
    const list = listOf({
      ids: ['released'],
      byId: { released: { id: 'released', displayTitle: 'released', retainedBy: { mainView: 0 } } },
    })
    expect(mainViewSessionId(list)).toBeUndefined()
  })

  it('tolerates a snapshot with no ids (older runtime)', () => {
    const list = listOf({ byId: { only: { id: 'only', displayTitle: 'only', retainedBy: { mainView: 1 } } } })
    expect(mainViewSessionId(list)).toBeUndefined()
  })
})
