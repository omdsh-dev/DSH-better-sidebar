// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/client/Sidebar.tsx', () => ({
  Sidebar: ({ ctx, store }: {
    ctx: { sessions: { list: { getSnapshot(): unknown } } }
    store: { getSnapshot(): { sessionId?: string } }
  }) => {
    const first = ctx.sessions.list.getSnapshot()
    const second = ctx.sessions.list.getSnapshot()
    return createElement('div', {
      'data-test-pane-sidebar': store.getSnapshot().sessionId,
      'data-test-list-snapshot-stable': String(first === second),
    })
  },
}))

import type { Context } from '../src/context-types.ts'
import { createPaneCapability } from '../src/client/pane-mount.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

function target(sessionId: string, focused = false) {
  const pane = document.createElement('section')
  const rightHost = document.createElement('aside')
  const bottomHost = document.createElement('aside')
  pane.append(rightHost, bottomHost)
  document.body.appendChild(pane)
  return { sessionId, pane, rightHost, bottomHost, focused }
}

function context(): Context {
  const snapshot = {
    ids: ['s1', 's2'],
    byId: { s1: { id: 's1' }, s2: { id: 's2' } },
    current: 's1',
    presentation: { visible: ['s1', 's2'], focused: 's1', capacity: 2 },
  }
  const list = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  const ctx = {
    sessions: { list },
    get: () => undefined,
  }
  return ctx as unknown as Context
}

describe('Better Sidebar Pane capability', () => {
  beforeEach(() => { document.body.replaceChildren() })

  it('mounts one scoped React root per Session and releases it independently', async () => {
    const primary = createSidebarStore()
    primary.setSession('s1')
    const service = createBetterSidebarService(primary)
    const changed = vi.fn()
    const panes = createPaneCapability(context(), primary, service, changed)
    const paneTarget = target('s2')

    let attachment: ReturnType<typeof panes.mountPane>
    await act(async () => { attachment = panes.mountPane(paneTarget) })
    expect(panes.activeCount).toBe(1)
    expect(paneTarget.pane.querySelector('[data-dsh-better-sidebar-pane="s2"]')).not.toBeNull()
    expect(paneTarget.pane.querySelector('[data-test-pane-sidebar="s2"]')).not.toBeNull()
    expect(paneTarget.pane.querySelector('[data-test-list-snapshot-stable="true"]')).not.toBeNull()

    attachment!.update({ ...paneTarget, focused: true })
    expect(paneTarget.pane.querySelector('[data-dsh-better-sidebar-pane="s2"]')?.hasAttribute('data-focused')).toBe(true)

    await act(async () => { attachment!.dispose() })
    expect(panes.activeCount).toBe(0)
    expect(paneTarget.pane.querySelector('[data-dsh-better-sidebar-pane]')).toBeNull()
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
