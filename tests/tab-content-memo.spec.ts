/**
 * The TabContent memo comparator: geometry/store re-renders of the Sidebar
 * shell must not reconcile every mounted tab (issue #315), while the fields
 * a cell's output or callbacks depend on MUST invalidate it. The pane-move
 * case (review P1): moveTab reuses the SAME tab object when a tab moves
 * panes, so paneId — not tab identity — is what identifies the move and
 * must be compared (onOpenDiff closes over the pane id).
 */
import { describe, expect, it } from 'vitest'
import { tabContentCompare, type TabContentMemoKey } from '../src/client/tab-content-memo.ts'
import type { SidebarTab } from '../src/client/state.ts'

function makeKey(overrides: Partial<TabContentMemoKey> = {}): TabContentMemoKey {
  return {
    tab: { id: 'tab:1', type: 'git', title: 'Git' } as SidebarTab,
    paneId: 'pane:a',
    sessionId: 'session:1',
    cwd: '/workspace',
    visible: true,
    expanded: [],
    revealed: [],
    localeRevision: 'en-US',
    tabsVersion: 0,
    effectiveTabId: undefined,
    ...overrides,
  }
}

describe('tabContentCompare', () => {
  it('skips re-render when nothing render-affecting changed (callback identity alone is ignored)', () => {
    const key = makeKey()
    expect(tabContentCompare(key, { ...key })).toBe(true)
  })

  it('invalidates on a tab moving between panes even though the tab OBJECT is reused (moveTab P1)', () => {
    const sameTab = { id: 'tab:1', type: 'git', title: 'Git' } as SidebarTab
    const before = makeKey({ tab: sameTab, paneId: 'pane:a' })
    const after = makeKey({ tab: sameTab, paneId: 'pane:b' }) // moveTab reinserts the same object
    expect(before.tab).toBe(after.tab)
    expect(tabContentCompare(before, after)).toBe(false)
  })

  it('invalidates on locale switches (copy freshness)', () => {
    expect(tabContentCompare(makeKey(), makeKey({ localeRevision: 'zh-CN' }))).toBe(false)
  })

  it('invalidates on tab-registry updates (descriptor refresh)', () => {
    expect(tabContentCompare(makeKey(), makeKey({ tabsVersion: 1 }))).toBe(false)
  })

  it('invalidates on visible/expanded/session/cwd changes', () => {
    expect(tabContentCompare(makeKey(), makeKey({ visible: false }))).toBe(false)
    expect(tabContentCompare(makeKey(), makeKey({ expanded: ['/workspace'] }))).toBe(false)
    expect(tabContentCompare(makeKey(), makeKey({ sessionId: 'session:2' }))).toBe(false)
    expect(tabContentCompare(makeKey(), makeKey({ cwd: '/other' }))).toBe(false)
  })
})
