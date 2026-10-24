// @vitest-environment jsdom
/**
 * The unread dot on DSH's OWN tab chip (`NativeTabTitle`) — the second of the
 * two surfaces the mark is drawn on, and the only one the plugin does not
 * render a strip for: a chip's content IS the plugin's registration in the
 * host's `sidebar.right.pane.tab.title` slot, so this component is the whole
 * carrier.
 *
 * The two halves pinned here are the ones the bottom workbench cannot answer:
 *
 * - a marked tab type draws the dot on its chip (and an unmarked one does not);
 * - the chip RETIRES the mark by itself. Clicking a chip is a host interaction
 *   this plugin never sees — `ISidebarRight` exposes a plain `active()` reader
 *   and no selection feed — so the host's own `tab.visible` flag is the only
 *   signal that the reader is looking at this page now. That is also why the
 *   clearing must not fire for an INACTIVE chip: the host draws the title of
 *   every expanded tab, so a `!visible` chip that cleared on render would
 *   erase the dot the moment it was raised.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

import {
  NativeTabTitle,
  createNativeTabRecords,
  type NativeTabInfo,
} from '../src/client/native/tab-adapter.tsx'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import { t } from '../src/client/locales.ts'

const SESSION = 's1'

/** One native tab record, as the host hands it to a title registration. */
function nativeInfo(visible: boolean): NativeTabInfo {
  return {
    tab: {
      id: 't1',
      kind: 'subagent',
      title: 'Tasks',
      contentId: 'sidebar://subagent',
      visible,
      navigation: { address: 'sidebar://subagent', params: undefined, revision: 0 },
      signal: new AbortController().signal,
    },
  }
}

function createService(store: SidebarStore): BetterSidebarService {
  const service = createBetterSidebarService(store)
  service.registerTab({
    id: 'subagent',
    title: () => 'Tasks',
    // The chip's glyph is the descriptor's, like every other plugin tab type.
    icon: (size: number) => createElement('i', { 'data-type-icon': size }),
    component: () => createElement('div'),
  })
  return service
}

/** The unread dots currently drawn in a chip's host element. */
function dots(host: HTMLElement): Element[] {
  return [...host.querySelectorAll(`[aria-label="${t('tabUnread')}"]`)]
}

const mounted: Array<{ host: HTMLDivElement; root: Root }> = []

/**
 * Render one chip and hand back its host. `info` is re-read on every render
 * (the returned closure keeps whatever object the caller last stored), which
 * is how a visibility change is delivered — exactly like the host's own
 * `useTabInfo` re-delivering its snapshot.
 */
function renderChip(options: {
  store: SidebarStore
  service: BetterSidebarService
  initialVisible: boolean
}): { host: HTMLDivElement; rerender: (visible: boolean) => void } {
  const { store, service } = options
  const records = createNativeTabRecords()
  records.attachStore(store)
  let info = nativeInfo(options.initialVisible)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const draw = (): void => {
    act(() => {
      root.render(createElement(NativeTabTitle, {
        records,
        service,
        descriptorId: 'subagent',
        sessionId: SESSION,
        useTabInfo: () => info,
      } as never))
    })
  }
  draw()
  mounted.push({ host, root })
  return {
    host,
    rerender: (visible: boolean) => {
      info = nativeInfo(visible)
      draw()
    },
  }
}

function makeStore(): SidebarStore {
  const store = createSidebarStore()
  store.setSession(SESSION)
  return store
}

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!
    act(() => { entry.root.unmount() })
    entry.host.remove()
  }
  document.body.innerHTML = ''
})

describe('native tab chip: the unread dot', () => {
  it('draws the dot on a marked tab type and nothing on an unmarked one', () => {
    const store = makeStore()
    const service = createService(store)
    const marked = renderChip({ store, service, initialVisible: false })
    // The chip is drawn BEFORE the mark arrives — the host draws the titles of
    // every expanded tab, and the page this one announces may not even be open
    // yet.
    expect(dots(marked.host)).toHaveLength(0)

    act(() => { store.markUnread('subagent') })
    const drawn = dots(marked.host)
    expect(drawn).toHaveLength(1)
    // The dot is labelled, not decorative: the glyph beside it is the part
    // that is `aria-hidden`.
    expect(drawn[0]!.getAttribute('title')).toBe(t('tabUnread'))
  })

  it('retires the mark once the host says this tab is the visible one', () => {
    const store = makeStore()
    const service = createService(store)
    act(() => { store.markUnread('subagent') })
    const chip = renderChip({ store, service, initialVisible: false })
    // Still marked while the reader is elsewhere: an inactive chip is drawn by
    // the host too, so it must not clear what it did not earn.
    expect(dots(chip.host)).toHaveLength(1)
    expect(store.getSnapshot().state!.unread).toEqual(['subagent'])

    chip.rerender(true)
    expect(store.getSnapshot().state!.unread).toEqual([])
    expect(dots(chip.host)).toHaveLength(0)
  })

  it('a chip that is never visible never clears the mark', () => {
    const store = makeStore()
    const service = createService(store)
    act(() => { store.markUnread('subagent') })
    const chip = renderChip({ store, service, initialVisible: false })
    chip.rerender(false)
    chip.rerender(false)
    expect(store.getSnapshot().state!.unread).toEqual(['subagent'])
    expect(dots(chip.host)).toHaveLength(1)
  })

  it('an unread type of ANOTHER tab does not mark this chip', () => {
    // The mark is per tab TYPE: the chip must read its own, not "any mark".
    const store = makeStore()
    const service = createService(store)
    act(() => { store.markUnread('editor') })
    const chip = renderChip({ store, service, initialVisible: false })
    expect(dots(chip.host)).toHaveLength(0)
  })

  it('adds the dot WITHOUT touching the glyph or the title', () => {
    // A guard on the shape this change could have broken: the glyph stays
    // decorative (its wrapper is `aria-hidden`, so the chip's accessible name
    // is still the title) and the dot is a sibling added after the title
    // rather than something that replaces either.
    const store = makeStore()
    const service = createService(store)
    act(() => { store.markUnread('subagent') })
    const chip = renderChip({ store, service, initialVisible: false })
    const glyphIcon = chip.host.querySelector('[data-type-icon]')
    expect(glyphIcon).not.toBeNull()
    expect(glyphIcon!.closest('[aria-hidden="true"]')).not.toBeNull()
    expect(chip.host.textContent).toBe('Tasks')
    const drawn = dots(chip.host)
    expect(drawn).toHaveLength(1)
    // The dot is empty by design: its meaning is the label, and an empty
    // `role="img"` without one would be announced as nothing at all.
    expect(drawn[0]!.textContent).toBe('')
  })
})
