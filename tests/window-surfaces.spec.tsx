/** Public retained window surface: docking moves the SAME live DOM and keeps draft, scroll, stack and session. */
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createElement, useEffect, useState } from 'react'
import { act } from 'react-dom/test-utils'
import { createWindowHost } from '../src/client/windows/host.ts'
import { WindowHost } from '../src/client/windows/WindowHost.tsx'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
import type { WindowHostController } from '../src/client/windows/types.ts'

setupReactAct()
let view: RenderedRoot | undefined
let host: WindowHostController | undefined
afterEach(() => { view?.unmount(); host?.dispose(); document.body.replaceChildren() })

it('moves live content between floating and original-session sidebar without remounting', async () => {
  let session = 'original'
  const open = vi.fn()
  const focus = vi.fn()
  const close = vi.fn()
  host = createWindowHost({ viewport: () => ({ width: 1000, height: 800 }), sessionId: () => session })
  host.attachSidebar({ open, focus, close })
  const mounted = vi.fn()
  const unmounted = vi.fn()
  function Draft() {
    const [text, setText] = useState('')
    useEffect(() => { mounted(); return unmounted }, [])
    return createElement('textarea', { 'data-draft': '', value: text, onChange: event => setText((event.currentTarget as HTMLTextAreaElement).value) })
  }
  const guard = vi.fn(() => false)
  const handle = host.open({ id: 'retained', title: 'Retained', content: createElement(Draft), dirty: true, onBeforeClose: guard })
  view = renderRoot(createElement(WindowHost, { host, formats: { subscribe: () => () => {}, getFormatRenderer: () => undefined } }))
  const input = document.querySelector<HTMLTextAreaElement>('[data-draft]')!
  input.value = 'unsaved'
  const body = document.querySelector<HTMLElement>('[data-window-body]')!
  body.scrollTop = 173
  act(() => { handle.navigation.push({ title: 'Second', content: 'second' }) })
  session = 'other'
  act(() => { expect(handle.dock!()).toBe(true) })
  expect(open).toHaveBeenCalledWith('retained', 'original', 'Second')
  const sidebar = document.createElement('div')
  document.body.append(sidebar)
  act(() => { host!.setSidebarTarget('retained', 'original', sidebar) })
  expect(sidebar.querySelector('[data-draft]')).toBe(input)
  expect(body.scrollTop).toBe(173)
  expect(input.value).toBe('unsaved')
  expect(host.getSnapshot().windows[0]).toMatchObject({ surface: 'sidebar', dirty: true, sessionId: 'original', canGoBack: true })
  act(() => { handle.float!() })
  expect(document.querySelector('[data-draft]')).toBe(input)
  expect(sidebar.contains(input)).toBe(false)
  expect(handle.navigation.depth()).toBe(2)
  expect(mounted).toHaveBeenCalledTimes(1)
  expect(unmounted).not.toHaveBeenCalled()
  await act(async () => { await handle.close() })
  expect(guard).toHaveBeenCalledTimes(1)
  expect(host.getSnapshot().windows).toHaveLength(1)
  act(() => { handle.dock!() })
  await act(async () => { await host!.closeFromSidebar('retained', 'original') })
  expect(guard).toHaveBeenCalledTimes(2)
  expect(host.getSnapshot().windows).toHaveLength(1)
  expect(unmounted).not.toHaveBeenCalled()
})


it('keeps transfer text before maximize and removes docked windows from floating Escape handling', async () => {
  host = createWindowHost({ viewport: () => ({ width: 1000, height: 800 }), sessionId: () => 'original' })
  host.attachSidebar({ open: () => {}, focus: () => {}, close: () => {} })
  const guard = vi.fn(() => false)
  const handle = host.open({ id: 'controls', title: 'Controls', content: 'body', onBeforeClose: guard })
  view = renderRoot(createElement(WindowHost, { host, formats: { subscribe: () => () => {}, getFormatRenderer: () => undefined } }))
  const transfer = document.querySelector<HTMLButtonElement>('[data-window-dock]')!
  const maximize = document.querySelector<HTMLButtonElement>('[data-window-maximize]')!
  expect(transfer.textContent?.trim().length).toBeGreaterThan(0)
  expect(transfer.querySelector('svg')).not.toBeNull()
  expect(transfer.compareDocumentPosition(maximize) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const before = host.getSnapshot().windows[0]!.box
  act(() => { maximize.click() })
  expect(document.querySelector('[data-window-dock]')).toBe(transfer)
  const sidebar = document.createElement('div')
  document.body.append(sidebar)
  act(() => { host!.setSidebarTarget('controls', 'other', sidebar) })
  expect(host.getSnapshot().windows[0]!.sidebarTarget).toBeUndefined()
  act(() => { host!.setSidebarTarget('controls', 'original', sidebar); transfer.click() })
  expect(sidebar.querySelector('[data-window-float]')?.textContent?.trim().length).toBeGreaterThan(0)
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(guard).not.toHaveBeenCalled()
  act(() => { handle.float!(); handle.update({ maximized: false }) })
  expect(host.getSnapshot().windows[0]!.box).toEqual(before)
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(guard).toHaveBeenCalledOnce()
  expect(host.getSnapshot().windows).toHaveLength(1)
})


/** jsdom has no layout: model the browser-proven scroll reset at the real DOM mutation/reparent seams. */
it('restores nested scroll after pre-layout frame changes and a delayed native destination without remounting', () => {
  host = createWindowHost({ viewport: () => ({ width: 390, height: 844 }), sessionId: () => 'original' })
  host.attachSidebar({ open: () => {}, focus: () => {}, close: () => {} })
  const mounts = vi.fn()
  const unmounts = vi.fn()
  function Body() {
    useEffect(() => { mounts(); return unmounts }, [])
    return createElement('div', { 'data-retained-scroll': '', style: { overflow: 'auto' } },
      createElement('textarea', { defaultValue: 'draft survives' }), createElement('div', null, 'long body'))
  }
  const handle = host.open({ id: 'scroll-reset', title: 'Scroll reset', content: createElement(Body) })
  view = renderRoot(createElement(WindowHost, { host, formats: { subscribe: () => () => {}, getFormatRenderer: () => undefined } }))
  const scroll = document.querySelector<HTMLElement>('[data-retained-scroll]')!
  const textarea = scroll.querySelector('textarea')!
  scroll.scrollTop = 140
  scroll.scrollLeft = 25
  const resetScroll = (): void => { scroll.scrollTop = 0; scroll.scrollLeft = 0 }
  const setAttribute = Element.prototype.setAttribute
  const removeAttribute = Element.prototype.removeAttribute
  const append = Element.prototype.append
  const remove = Element.prototype.remove
  // React changes docked presentation BEFORE parent layout effects. A capture
  // in the old WindowFrame layout effect (or its cleanup) would see zero.
  const setSpy = vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (this: Element, name, value) {
    setAttribute.call(this, name, value)
    if (name === 'data-window-docked') resetScroll()
  })
  const unsetSpy = vi.spyOn(Element.prototype, 'removeAttribute').mockImplementation(function (this: Element, name) {
    removeAttribute.call(this, name)
    if (name === 'data-window-docked') resetScroll()
  })
  const appendSpy = vi.spyOn(Element.prototype, 'append').mockImplementation(function (this: Element, ...nodes) {
    append.apply(this, nodes)
    if (nodes.some(node => node instanceof Element && node.hasAttribute('data-window-surface-target'))) resetScroll()
  })
  const removeSpy = vi.spyOn(Element.prototype, 'remove').mockImplementation(function (this: Element) {
    const retainedTarget = this.hasAttribute('data-window-surface-target')
    remove.call(this)
    if (retainedTarget) resetScroll()
  })
  try {
    act(() => { handle.dock!() })
    expect(scroll.isConnected).toBe(false)
    const destination = document.createElement('div')
    document.body.append(destination)
    act(() => { host!.setSidebarTarget('scroll-reset', 'original', destination) })
    expect(scroll.scrollTop).toBe(140)
    expect(scroll.scrollLeft).toBe(25)
    act(() => { handle.float!() })
    expect(scroll.scrollTop).toBe(140)
    expect(scroll.scrollLeft).toBe(25)
    expect(document.querySelector('[data-retained-scroll]')).toBe(scroll)
    expect(scroll.querySelector('textarea')).toBe(textarea)
    expect(textarea.value).toBe('draft survives')
    expect(mounts).toHaveBeenCalledOnce()
    expect(unmounts).not.toHaveBeenCalled()
  } finally {
    setSpy.mockRestore(); unsetSpy.mockRestore(); appendSpy.mockRestore(); removeSpy.mockRestore()
  }
})

it('restores the native destination while an async close decision still needs the live in-surface UI', async () => {
  const open = vi.fn()
  host = createWindowHost({ sessionId: () => 'original' })
  host.attachSidebar({ open, focus: () => {}, close: () => {} })
  let decide!: (allowed: boolean) => void
  const pending = new Promise<boolean>(resolve => { decide = resolve })
  const handle = host.open({ id: 'pending', title: 'Pending', content: 'save/discard/cancel', onBeforeClose: () => pending })
  handle.dock!()
  const closing = host.closeFromSidebar('pending', 'original')
  await Promise.resolve()
  // Native cleanup removes the occurrence synchronously, so the guard's own
  // save/discard/cancel UI needs a replacement destination BEFORE it resolves.
  expect(open).toHaveBeenCalledTimes(2)
  expect(host.getSnapshot().windows).toHaveLength(1)
  decide(false)
  await closing
  expect(open).toHaveBeenCalledTimes(2)
  expect(host.getSnapshot().windows).toHaveLength(1)
})
