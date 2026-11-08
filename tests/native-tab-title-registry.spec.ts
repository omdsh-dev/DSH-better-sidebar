// @vitest-environment jsdom
/**
 * The native tab CHIP's title for a single-instance page: it is the type's
 * registered title, read at render time. The record and the native tab both
 * keep the title captured when the tab opened, so a page renamed later (a
 * plugin update or a locale change re-registering the descriptor) used to
 * keep its stale title on every tab that was already open.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  NativeTabTitle,
  createNativeTabRecords,
  type NativeTabInfo,
} from '../src/client/native/tab-adapter.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

const scope = { sessionId: 's1', cwd: '/work' }

function nativeInfo(id: string, kind: string, title: string): NativeTabInfo {
  return {
    tab: {
      id,
      kind,
      title,
      contentId: `sidebar://${kind}`,
      visible: false,
      navigation: { address: `sidebar://${kind}`, params: undefined, revision: 0 },
      signal: new AbortController().signal,
    },
  }
}

function renderTitle(
  records: ReturnType<typeof createNativeTabRecords>,
  service: ReturnType<typeof createBetterSidebarService>,
  info: NativeTabInfo,
  descriptorId: string,
): { text: () => string; unmount: () => void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: Root | undefined
  act(() => {
    root = createRoot(host)
    root.render(createElement(NativeTabTitle, {
      records,
      service,
      descriptorId,
      useTabInfo: () => info,
    } as never))
  })
  return {
    text: () => host.textContent ?? '',
    unmount: () => {
      act(() => { root?.unmount() })
      host.remove()
    },
  }
}

describe('NativeTabTitle registry title', () => {
  it('shows a renamed single page by its registered title, not the one stored when it opened', () => {
    const records = createNativeTabRecords()
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTab({ id: 'library', single: true, title: () => 'Library', component: () => createElement('div') })
    records.ensure({ id: 'tab1', kind: 'library', title: 'Old library name', scope } as never)

    const { text, unmount } = renderTitle(records, service, nativeInfo('tab1', 'library', 'Old library name'), 'library')
    expect(text()).toBe('Library')
    unmount()
  })

  it('keeps the record title for a multi-instance tab (an editor file, a side chat)', () => {
    const records = createNativeTabRecords()
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTab({ id: 'chat', title: () => 'Chat', component: () => createElement('div') })
    records.ensure({ id: 'tab2', kind: 'chat', title: 'Why is the sky blue?', scope } as never)

    const { text, unmount } = renderTitle(records, service, nativeInfo('tab2', 'chat', 'Chat'), 'chat')
    expect(text()).toBe('Why is the sky blue?')
    unmount()
  })
})
