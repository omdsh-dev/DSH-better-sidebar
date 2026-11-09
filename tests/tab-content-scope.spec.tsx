/**
 * The `scope` object a tab body receives must be stable across re-renders of
 * the Sidebar shell.
 *
 * Tab bodies key memos and effects off `scope` (DiffPane resolves its media /
 * html routes from it, TextEditor restores the preview scroll, the side chat
 * rebuilds its prose-rewrite cache). The cell used to build `{ sessionId, cwd }`
 * fresh on every render, so every one of those dependencies looked changed
 * whenever the cell re-rendered. The cell re-renders when a COMPARED memo field
 * moves (`tab-content-memo.ts`) — a directory toggle reaches every mounted tab
 * through `expanded`, and `revealed` / `localeRevision` / `tabsVersion` do the
 * same; a bare poll tick does NOT, because the comparator already absorbs it.
 * On those re-renders the diff preview re-ran its whole-document rewrite and
 * its content tab re-issued a whole-file `fs.read`, flashing its loading row.
 *
 * The regression: the cell DOES re-render, but the scope it hands down must be
 * the SAME object, and must only become a new one when the session or cwd
 * actually changes.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'

import { setupReactAct, renderRoot } from './test-utils.ts'
setupReactAct()

import { TabContent } from '../src/client/sidebar/TabContent.tsx'
import type { SessionScope } from '../src/client/api.ts'
import type { Context } from '../src/context-types.ts'
import type { SidebarStore, SidebarTab } from '../src/client/state.ts'
import type { TabContentMemoKey } from '../src/client/tab-content-memo.ts'

const TAB: SidebarTab = { id: 'tab:1', type: 'probe', title: 'Probe' }

/** Every scope object the tab body was rendered with, in order. */
const seen: SessionScope[] = []

function ProbeBody(props: { scope: SessionScope }): null {
  seen.push(props.scope)
  return null
}

/** A context whose service resolves exactly one registered tab type. */
function makeCtx(): Context {
  const service = {
    getTab: (type: string) => (type === TAB.type
      ? { id: TAB.type, title: 'Probe', component: ProbeBody }
      : undefined),
  }
  return { get: (name: string) => (name === 'betterSidebar' ? service : undefined) } as unknown as Context
}

/** Everything the comparator looks at except `tab` / `paneId` (fixed here).
 *  Derived from the real key so a field the comparator gains later is not
 *  silently left uncovered here. */
type Fields = Partial<Omit<TabContentMemoKey, 'tab' | 'paneId'>>

/** Stable array identities, like the store's own `state.expanded` / `revealed`
 *  (a fresh `[]` on every render would itself be a compared change). */
const EMPTY_A: string[] = []
const EMPTY_B: string[] = []

function mountCell(): { rerender: (fields?: Fields) => void; unmount: () => void } {
  const ctx = makeCtx()
  const store = {} as SidebarStore
  let current: Fields = { expanded: EMPTY_A, revealed: EMPTY_B }

  const element = (): ReturnType<typeof createElement> => createElement(TabContent, {
    tab: TAB,
    paneId: 'pane:a',
    sessionId: current.sessionId ?? 'session:1',
    cwd: 'cwd' in current ? current.cwd : '/workspace',
    // Fixed across every case: `visible` moving is the tab being parked or
    // shown, which no case here varies (so it is deliberately not in `Fields`).
    visible: true,
    expanded: current.expanded ?? EMPTY_A,
    revealed: current.revealed ?? EMPTY_B,
    localeRevision: current.localeRevision ?? 'en-US',
    tabsVersion: current.tabsVersion ?? 0,
    onToggleDir: () => {},
    onReferenceFile: () => {},
    ctx,
    store,
    onSubagentJump: () => {},
    onOpenDiff: () => {},
  })

  const root = renderRoot(element())
  return {
    rerender: (fields = {}) => {
      current = { ...current, ...fields }
      root.rerender(element())
    },
    unmount: root.unmount,
  }
}

afterEach(() => { document.body.innerHTML = '' })

describe('TabContent scope identity', () => {
  it('keeps the same scope object when only `expanded` changes', () => {
    seen.length = 0
    const shell = mountCell()
    const first = seen.at(-1)
    expect(first).toBeDefined()

    shell.rerender({ expanded: ['/workspace/src'] })
    // The cell really did re-render (not a memo skip)...
    expect(seen.length).toBe(2)
    // ...and handed down the SAME scope.
    expect(seen[1]).toBe(first)

    shell.rerender({ expanded: ['/workspace/src', '/workspace/tests'] })
    expect(seen.length).toBe(3)
    expect(seen[2]).toBe(first)
    shell.unmount()
  })

  /**
   * The other compared fields reach the body the same way and must not churn
   * the scope either — these are the triggers a perf investigation should
   * actually follow (a bare poll tick is absorbed by the comparator and never
   * gets here at all).
   */
  it.each([
    ['revealed', { revealed: ['/workspace/a.ts'] }],
    ['localeRevision', { localeRevision: 'zh-CN' }],
    ['tabsVersion', { tabsVersion: 1 }],
  ] as Array<[string, Fields]>)('keeps the same scope object when only %s changes', (_label, change) => {
    seen.length = 0
    const shell = mountCell()
    const first = seen.at(-1)

    shell.rerender(change)
    expect(seen.length).toBe(2)
    expect(seen[1]).toBe(first)
    shell.unmount()
  })

  it('builds a new scope when the session changes', () => {
    seen.length = 0
    const shell = mountCell()
    const first = seen.at(-1)
    shell.rerender({ sessionId: 'session:2' })
    expect(seen.at(-1)).not.toBe(first)
    expect(seen.at(-1)?.sessionId).toBe('session:2')
    shell.unmount()
  })

  it('builds a new scope when the cwd changes', () => {
    seen.length = 0
    const shell = mountCell()
    const first = seen.at(-1)
    shell.rerender({ cwd: '/other' })
    expect(seen.at(-1)).not.toBe(first)
    expect(seen.at(-1)?.cwd).toBe('/other')
    shell.unmount()
  })
})
