/**
 * Middle-click close over the plugin's tabs in DSH's native right Sidebar.
 *
 * The host's strip has no button-1 handling at all (its tab element handles
 * pointerdown for drag, click for activation, keydown for arrow focus and
 * contextmenu for the menu), so the plugin restores the gesture from the one
 * element of a native tab it renders itself — the title chip — and closes
 * through the tab's own `actions.close()`. These specs pin the three things
 * that make that safe:
 *
 * - OWNERSHIP: only chips carrying the plugin's marker resolve to a tab, so a
 *   host tab (the built-in guide / document preview) keeps its native
 *   behaviour, autoscroll and all;
 * - SEMANTICS: press over a plugin tab, release over the same tab, drift
 *   inside the drag slop — the release-position rule the plugin's own strip
 *   (TabBar.tsx) follows;
 * - CONSENT OF THE HOST'S GESTURES: the press is consumed (preventDefault +
 *   stopPropagation) so the kit's drag tracking never sees the middle button,
 *   and the left button / right button / wheel paths are untouched.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'

import { renderRoot, setupReactAct } from './test-utils.ts'
setupReactAct()

import { createNativeTabRecords, NativeTabTitle, type NativeTabInfo } from '../src/client/native/tab-adapter.tsx'
import {
  createNativeTabMiddleClick,
  NATIVE_TAB_MARKER,
  nativeTabMarker,
  type NativeTabMiddleClick,
} from '../src/client/native/tab-middle-click.ts'

const controllers: NativeTabMiddleClick[] = []
const unmounts: Array<() => void> = []

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  for (const unmount of unmounts.splice(0)) unmount()
  document.body.innerHTML = ''
})

/** One middle-button event on `target`. */
function middle(target: EventTarget, type: 'mousedown' | 'mouseup', at = { x: 10, y: 10 }): MouseEvent {
  const event = new MouseEvent(type, {
    button: 1,
    bubbles: true,
    cancelable: true,
    clientX: at.x,
    clientY: at.y,
  })
  target.dispatchEvent(event)
  return event
}

/**
 * The host's own markup, shrunk to what the gesture reads: two strip tabs (one
 * the plugin owns — marker chip + a close control, exactly the shape
 * `canCloseTab` decides), a floating panel with a header and a body, and a
 * plugin tab the host itself refuses to close (no close control).
 */
function mountTabs(): {
  controller: NativeTabMiddleClick
  close: ReturnType<typeof vi.fn>
  floatClose: ReturnType<typeof vi.fn>
  refusedClose: ReturnType<typeof vi.fn>
  chip: HTMLElement
  tab: HTMLElement
  hostTab: HTMLElement
  floatHeader: HTMLElement
  floatBody: HTMLElement
  refusedTab: HTMLElement
} {
  const controller = createNativeTabMiddleClick()
  controllers.push(controller)
  const close = vi.fn()
  const floatClose = vi.fn()
  const refusedClose = vi.fn()
  controller.register('tab-1', close)
  controller.register('float-1', floatClose)
  controller.register('tab-3', refusedClose)
  const wrapper = document.createElement('div')
  wrapper.innerHTML = `
    <div data-dockkit-tab="tab-1">
      <span class="title"></span>
      <button class="x" data-dockkit-tab-close="tab-1">x</button>
    </div>
    <div data-dockkit-tab="tab-2"><span class="title">guide</span></div>
    <div data-dockkit-float="float-1">
      <header data-dockkit-float-grip="float-1">
        <span class="ftitle"></span>
        <button data-dockkit-float-close="float-1">x</button>
      </header>
      <div class="fbody"><span class="term">terminal</span></div>
    </div>
    <div data-dockkit-tab="tab-3"><span class="title"></span></div>
  `
  document.body.append(wrapper)
  const [tab, hostTab, refusedTab] = [...wrapper.querySelectorAll<HTMLElement>('[data-dockkit-tab]')]
  const chip = document.createElement('span')
  chip.setAttribute(NATIVE_TAB_MARKER, 'tab-1')
  chip.textContent = 'a.ts'
  tab!.querySelector<HTMLElement>('.title')!.append(chip)
  const floatHeader = wrapper.querySelector<HTMLElement>('[data-dockkit-float-grip]')!
  const floatChip = document.createElement('span')
  floatChip.setAttribute(NATIVE_TAB_MARKER, 'float-1')
  floatChip.textContent = 'b.ts'
  floatHeader.querySelector<HTMLElement>('.ftitle')!.append(floatChip)
  const refusedChip = document.createElement('span')
  refusedChip.setAttribute(NATIVE_TAB_MARKER, 'tab-3')
  refusedChip.textContent = 'c.ts'
  refusedTab!.querySelector<HTMLElement>('.title')!.append(refusedChip)
  return {
    controller,
    close,
    floatClose,
    refusedClose,
    chip,
    tab: tab!,
    hostTab: hostTab!,
    floatHeader,
    floatBody: wrapper.querySelector<HTMLElement>('.fbody')!,
    refusedTab: refusedTab!,
  }
}

describe('createNativeTabMiddleClick', () => {
  it('closes on a middle press and release over the same tab, anywhere on it', () => {
    const { close, chip, tab } = mountTabs()
    const down = middle(chip, 'mousedown')
    // The press is consumed: autoscroll disarmed, and the kit's drag tracking
    // (which listens on the bubbling path this capture listener precedes)
    // never sees the middle button.
    expect(down.defaultPrevented).toBe(true)
    const seenByKit = vi.fn()
    document.body.addEventListener('mousedown', seenByKit)
    middle(chip, 'mousedown')
    expect(seenByKit).not.toHaveBeenCalled()
    document.body.removeEventListener('mousedown', seenByKit)
    // The whole tab is the hit area, not just the chip.
    middle(tab.querySelector('.x')!, 'mouseup')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('cancels when the release lands outside the pressed tab', () => {
    const { close, chip, tab, hostTab } = mountTabs()
    // Another tab, the page, and the pressed tab's own container are all
    // "elsewhere": only a release inside the pressed tab settles the close.
    middle(chip, 'mousedown')
    middle(hostTab, 'mouseup')
    middle(chip, 'mousedown')
    middle(document.body, 'mouseup')
    middle(chip, 'mousedown')
    middle(tab.parentElement!, 'mouseup')
    expect(close).not.toHaveBeenCalled()
  })

  it('cancels when the press drifts past the drag slop', () => {
    const { close, chip, tab } = mountTabs()
    middle(chip, 'mousedown', { x: 10, y: 10 })
    // A middle drag moves the tab; the release must not also close it.
    middle(tab, 'mouseup', { x: 40, y: 12 })
    expect(close).not.toHaveBeenCalled()
    middle(chip, 'mousedown', { x: 10, y: 10 })
    middle(tab, 'mouseup', { x: 13, y: 12 })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('settles one close per press', () => {
    const { close, chip } = mountTabs()
    middle(chip, 'mousedown')
    middle(chip, 'mouseup')
    middle(chip, 'mouseup')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('leaves a host tab entirely alone', () => {
    const { close, hostTab } = mountTabs()
    const down = middle(hostTab, 'mousedown')
    expect(down.defaultPrevented).toBe(false)
    middle(hostTab, 'mouseup')
    expect(close).not.toHaveBeenCalled()
  })

  it('closes a floating panel from its header only, never from its body', () => {
    const { floatClose, floatHeader, floatBody } = mountTabs()
    const chip = floatHeader.querySelector<HTMLElement>(`[${NATIVE_TAB_MARKER}="float-1"]`)!
    // The body hosts the terminal / web content: a middle press there means
    // paste or open-in-background and must stay untouched.
    const inBody = middle(floatBody.querySelector('.term')!, 'mousedown')
    expect(inBody.defaultPrevented).toBe(false)
    middle(floatHeader, 'mouseup')
    expect(floatClose).not.toHaveBeenCalled()
    // The header is the hit area, chip or padding alike.
    middle(floatHeader, 'mousedown')
    middle(chip, 'mouseup')
    expect(floatClose).toHaveBeenCalledTimes(1)
  })

  it('skips a plugin tab the host refuses to close', () => {
    const { refusedClose, refusedTab } = mountTabs()
    const chip = refusedTab.querySelector<HTMLElement>(`[${NATIVE_TAB_MARKER}="tab-3"]`)!
    const down = middle(chip, 'mousedown')
    // No close control in the tab means `canCloseTab` said no: the press keeps
    // its default behaviour and nothing closes.
    expect(down.defaultPrevented).toBe(false)
    middle(refusedTab, 'mouseup')
    expect(refusedClose).not.toHaveBeenCalled()
  })

  it('ignores the left button on a plugin tab', () => {
    const { close, chip } = mountTabs()
    const down = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })
    chip.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(false)
    chip.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }))
    expect(close).not.toHaveBeenCalled()
  })

  it('keeps the newest action for a tab and honours its cleanup', () => {
    const { close, chip, controller } = mountTabs()
    const newest = vi.fn()
    const offStale = controller.register('tab-1', vi.fn())
    const offNewest = controller.register('tab-1', newest)
    // A stale chip's cleanup must not unpublish the newer action.
    offStale()
    middle(chip, 'mousedown')
    middle(chip, 'mouseup')
    expect(newest).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    // The live chip unmounts: nothing is published, so nothing closes.
    offNewest()
    middle(chip, 'mousedown')
    middle(chip, 'mouseup')
    expect(newest).toHaveBeenCalledTimes(1)
  })

  it('unbinds every listener on dispose', () => {
    const { close, chip, controller } = mountTabs()
    controller.dispose()
    const down = middle(chip, 'mousedown')
    middle(chip, 'mouseup')
    expect(down.defaultPrevented).toBe(false)
    expect(close).not.toHaveBeenCalled()
  })
})

describe('NativeTabTitle', () => {
  const scope = { sessionId: 's1', cwd: '/work' }

  /** One native tab's info, as the host's `useTabInfo` hands it over. */
  const infoFor = (input: { id: string; title: string; close?: () => void }): (() => NativeTabInfo) => () => ({
    tab: {
      id: input.id,
      kind: 'editor',
      title: input.title,
      contentId: `addr://s1/work/work/${input.title}`,
      visible: true,
      navigation: { address: `addr://s1/work/work/${input.title}`, params: undefined, revision: 1 },
      signal: new AbortController().signal,
      ...(input.close === undefined ? {} : { actions: { close: input.close } }),
    },
  })

  /** Render one chip inside a kit tab element, the way the host nests it. */
  const mountChip = (input: { id: string; title: string; close?: () => void }): { tab: HTMLElement; container: HTMLElement } => {
    const records = createNativeTabRecords()
    records.ensure({ id: input.id, kind: 'editor', title: input.title, params: undefined, scope })
    const middleClick = createNativeTabMiddleClick()
    controllers.push(middleClick)
    const root = renderRoot(createElement(NativeTabTitle, { records, middleClick, useTabInfo: infoFor(input) }))
    unmounts.push(root.unmount)
    const tab = document.createElement('div')
    tab.setAttribute('data-dockkit-tab', input.id)
    // The kit's own close control: its presence IS `canCloseTab`.
    const closeControl = document.createElement('button')
    closeControl.setAttribute('data-dockkit-tab-close', input.id)
    tab.append(closeControl)
    document.body.append(tab)
    tab.append(root.container)
    return { tab, container: root.container }
  }

  it('stamps its tab and routes the middle click into the tab’s own close action', () => {
    const close = vi.fn()
    const { tab, container } = mountChip({ id: 'tab-1', title: 'a.ts', close })
    const chip = container.querySelector<HTMLElement>(`[${NATIVE_TAB_MARKER}="tab-1"]`)
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toBe('a.ts')

    // Middle press on the tab's padding, release over the chip: one close,
    // through the action the runtime bound to this tab's session.
    middle(tab, 'mousedown')
    middle(chip!, 'mouseup')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('renders without publishing a close when the runtime omits the actions face', () => {
    const { container } = mountChip({ id: 'tab-2', title: 'b.ts' })
    const chip = container.querySelector<HTMLElement>(`[${NATIVE_TAB_MARKER}="tab-2"]`)
    expect(chip!.textContent).toBe('b.ts')
    // No published action means the press stays untouched (autoscroll and
    // the kit's own gestures keep their default behaviour).
    expect(middle(chip!, 'mousedown').defaultPrevented).toBe(false)
    middle(chip!, 'mouseup')
  })

  it('keeps the chip on the record’s live title', () => {
    const records = createNativeTabRecords()
    records.ensure({ id: 'tab-3', kind: 'terminal', title: 'Terminal', params: undefined, scope })
    const middleClick = createNativeTabMiddleClick()
    controllers.push(middleClick)
    const root = renderRoot(createElement(NativeTabTitle, {
      records,
      middleClick,
      useTabInfo: infoFor({ id: 'tab-3', title: 'Terminal', close: () => {} }),
    }))
    unmounts.push(root.unmount)
    expect(root.container.textContent).toBe('Terminal')
    // The record's own subscription re-renders the chip under act().
    act(() => { records.update('tab-3', { title: 'zsh' }) })
    expect(root.container.textContent).toBe('zsh')
  })
})

describe('nativeTabMarker', () => {
  it('stamps the tab id under the exported attribute', () => {
    expect(nativeTabMarker('tab-9')).toEqual({ [NATIVE_TAB_MARKER]: 'tab-9' })
  })
})
