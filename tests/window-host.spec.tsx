/**
 * Window host state: the public `open/update/focus/close` semantics, the
 * stable-identity rule (a duplicate open focuses, never re-creates), geometry
 * invariants (content updates never move a window; an explicit size or
 * maximize does), the async dirty-close guard, the handle generation guard,
 * and the mounted navigation page stack.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowHost } from '../src/client/windows/host.ts'
import type { WindowHostController } from '../src/client/windows/types.ts'

const VIEWPORT = { width: 1_000, height: 800 }

function makeHost(): WindowHostController {
  return createWindowHost({ viewport: () => VIEWPORT })
}

let host: WindowHostController | undefined

afterEach(() => {
  host?.dispose()
  host = undefined
})

describe('window host: open / focus / duplicate identity', () => {
  it('opens a collection window centred and returns a handle', () => {
    host = makeHost()
    const handle = host.open({ id: 'clue:1', title: 'Clue', content: 'body' })
    expect(handle.id).toBe('clue:1')
    const windows = host.getSnapshot().windows
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({
      id: 'clue:1',
      title: 'Clue',
      baseTitle: 'Clue',
      content: 'body',
      size: 'collection',
      minSize: { width: 320, height: 240 },
      box: { left: 140, top: 120, width: 720, height: 560 },
      maximized: false,
      dirty: false,
      saving: false,
      canGoBack: false,
      activeIndex: 0,
    })
  })

  it('focuses an existing identity instead of creating a second window', () => {
    host = makeHost()
    const first = host.open({ id: 'clue:1', title: 'First', content: 'draft' })
    first.update({ dirty: true })
    const second = host.open({ id: 'clue:1', title: 'Second', content: 'other', size: 'compact' })
    expect(second).toBe(first)
    const snapshot = host.getSnapshot()
    expect(snapshot.windows).toHaveLength(1)
    // The live instance (and its unsaved draft) wins over the new options.
    expect(snapshot.windows[0]!.title).toBe('First')
    expect(snapshot.windows[0]!.content).toBe('draft')
    expect(snapshot.windows[0]!.size).toBe('collection')
    expect(snapshot.windows[0]!.dirty).toBe(true)
  })

  it('rejects an empty id and keeps ids stable across close/reopen', async () => {
    host = makeHost()
    expect(() => host!.open({ id: '  ', title: 'x', content: 'y' })).toThrow(/non-empty id/)
    const first = host.open({ id: 'w', title: 'W', content: 'one' })
    await first.close()
    expect(host.getSnapshot().windows).toHaveLength(0)
    const second = host.open({ id: 'w', title: 'W2', content: 'two' })
    // A stale handle must not reach the reopened window.
    first.update({ title: 'stale', content: 'stale' })
    expect(host.getSnapshot().windows[0]!.title).toBe('W2')
    const closedBefore = host.getSnapshot().windows[0]!.content
    expect(closedBefore).toBe('two')
    second.update({ content: 'three' })
    expect(host.getSnapshot().windows[0]!.content).toBe('three')
  })
})

describe('window host: update keeps the reader placement', () => {
  it('changes content without moving or resizing the window', () => {
    host = makeHost()
    const handle = host.open({ id: 'stream', title: 'Stream', content: 'line 1' })
    const before = host.getSnapshot().windows[0]!.box
    handle.update({ content: 'line 2', dirty: true, saving: true })
    const view = host.getSnapshot().windows[0]!
    expect(view.box).toEqual(before)
    expect(view.content).toBe('line 2')
    expect(view.dirty).toBe(true)
    expect(view.saving).toBe(true)
  })

  it('applies an explicit size preset around the current centre', () => {
    host = makeHost()
    const handle = host.open({ id: 'doc', title: 'Doc', content: 'x', size: 'collection' })
    handle.update({ size: 'document' })
    expect(host.getSnapshot().windows[0]!.box).toEqual({ left: 60, top: 80, width: 880, height: 640 })
  })

  it('maximizes, restores the previous box, and re-clamps after a viewport shrink', () => {
    host = makeHost()
    const handle = host.open({ id: 'max', title: 'Max', content: 'x' })
    handle.update({ maximized: true })
    expect(host.getSnapshot().windows[0]).toMatchObject({
      maximized: true,
      box: { left: 0, top: 0, width: 1_000, height: 800 },
    })
    handle.update({ maximized: false })
    expect(host.getSnapshot().windows[0]!.box).toEqual({ left: 140, top: 120, width: 720, height: 560 })

    handle.update({ size: 'document' })
    host.setViewport({ width: 500, height: 400 })
    expect(host.getSnapshot().windows[0]!.box).toEqual({ left: 8, top: 8, width: 484, height: 384 })
  })

  it('restores the pre-maximize box re-clamped after the viewport shrank', () => {
    host = makeHost()
    const handle = host.open({ id: 'restore', title: 'Restore', content: 'x' })
    handle.update({ maximized: true })
    host.setViewport({ width: 500, height: 400 })
    expect(host.getSnapshot().windows[0]).toMatchObject({
      maximized: true,
      box: { left: 0, top: 0, width: 500, height: 400 },
    })
    handle.update({ maximized: false })
    // The remembered 720×560 box no longer fits 500×400: it lands clamped,
    // not off-screen and not at the stale size.
    expect(host.getSnapshot().windows[0]).toMatchObject({
      maximized: false,
      box: { left: 8, top: 8, width: 484, height: 384 },
    })
  })

  it('keeps an explicitly smaller minSize in the view (the shell gesture floor)', () => {
    host = makeHost()
    host.open({ id: 'tiny', title: 'Tiny', content: 'x', minSize: { width: 280, height: 200 } })
    expect(host.getSnapshot().windows[0]!.minSize).toEqual({ width: 280, height: 200 })
  })
})

describe('window host: viewport safety and injection', () => {
  it('sanitizes a NaN/Infinity viewport instead of leaking it into geometry', () => {
    host = createWindowHost({ viewport: () => ({ width: Number.NaN, height: Number.POSITIVE_INFINITY }) })
    const handle = host.open({ id: 'nan', title: 'NaN', content: 'x' })
    const box = host.getSnapshot().windows[0]!.box
    for (const value of Object.values(box)) expect(Number.isFinite(value), String(value)).toBe(true)
    host.setViewport({ width: Number.NaN, height: Number.NaN })
    const after = host.getSnapshot().windows[0]!.box
    for (const value of Object.values(after)) expect(Number.isFinite(value), String(value)).toBe(true)
    expect(after).toEqual(box)
    void handle
  })

  it('advertises whether it follows the live window viewport', () => {
    expect(createWindowHost({ viewport: () => VIEWPORT }).followsLiveViewport).toBe(false)
    const live = createWindowHost()
    expect(live.followsLiveViewport).toBe(true)
    live.dispose()
  })
})

describe('window host: close guard', () => {
  it('keeps the window (and draft) when onBeforeClose refuses', async () => {
    host = makeHost()
    let onClose = 0
    const guard = vi.fn(() => false)
    const handle = host.open({
      id: 'draft', title: 'Draft', content: 'typed', dirty: true,
      onBeforeClose: guard, onClose: () => { onClose += 1 },
    })
    await handle.close()
    expect(guard).toHaveBeenCalledTimes(1)
    expect(host.getSnapshot().windows).toHaveLength(1)
    expect(host.getSnapshot().windows[0]!.content).toBe('typed')
    expect(onClose).toBe(0)

    handle.update({ onBeforeClose: () => true })
    await handle.close()
    expect(host.getSnapshot().windows).toHaveLength(0)
    expect(onClose).toBe(1)
    // A second close is a no-op, and so is a close after reopening.
    await handle.close()
    expect(onClose).toBe(1)
  })

  it('awaits an async guard and treats a rejection as "stay open"', async () => {
    host = makeHost()
    let resolve: ((allowed: boolean) => void) | undefined
    const pending = new Promise<boolean>((done) => { resolve = done })
    const handle = host.open({ id: 'async', title: 'Async', content: 'x', onBeforeClose: () => pending })
    const closing = handle.close()
    handle.focus()
    expect(host.getSnapshot().windows).toHaveLength(1)
    resolve?.(true)
    await closing
    expect(host.getSnapshot().windows).toHaveLength(0)

    const failing = host.open({
      id: 'reject', title: 'Reject', content: 'x',
      onBeforeClose: () => Promise.reject(new Error('nope')),
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await failing.close()
    expect(host.getSnapshot().windows).toHaveLength(1)
    spy.mockRestore()
  })

  it('treats dispose as teardown, not a user close (no onClose call)', () => {
    host = makeHost()
    const onClose = vi.fn()
    host.open({ id: 'teardown', title: 'Teardown', content: 'x', onClose })
    host.dispose()
    expect(onClose).not.toHaveBeenCalled()
    expect(host.getSnapshot().windows).toHaveLength(0)
  })
})

describe('window host: navigation pages', () => {
  it('pushes/pops pages and keeps the base page mounted for state retention', () => {
    host = makeHost()
    const handle = host.open({ id: 'pack', title: 'Pack', content: 'manager' })
    expect(handle.navigation.canGoBack()).toBe(false)
    expect(handle.navigation.depth()).toBe(1)
    handle.navigation.push({ title: 'Add members', content: 'picker' })
    expect(handle.navigation.canGoBack()).toBe(true)
    expect(handle.navigation.depth()).toBe(2)
    expect(host.getSnapshot().windows[0]).toMatchObject({
      title: 'Add members', content: 'picker', canGoBack: true, activeIndex: 1,
    })
    // Both pages stay in the snapshot (the React host keeps them mounted).
    expect(host.getSnapshot().windows[0]!.pages.map(page => page.page.content)).toEqual(['manager', 'picker'])
    expect(handle.navigation.pop()).toBe(true)
    expect(host.getSnapshot().windows[0]).toMatchObject({ title: 'Pack', content: 'manager', canGoBack: false })
    expect(handle.navigation.pop()).toBe(false)
  })

  it('updates the page that is on top without popping its mounted state', () => {
    host = makeHost()
    const handle = host.open({ id: 'live-page', title: 'Base', content: 'base' })
    handle.navigation.push({ title: 'Pushed', content: 'draft' })
    handle.update({ content: 'streamed', title: 'Pushed live', actions: 'act' })
    expect(host.getSnapshot().windows[0]).toMatchObject({
      title: 'Pushed live',
      content: 'streamed',
      actions: 'act',
      canGoBack: true,
    })
    // The covered base page kept its own content and title.
    handle.navigation.pop()
    expect(host.getSnapshot().windows[0]).toMatchObject({ title: 'Base', content: 'base' })
  })

  it('refuses to pop when the top page leave guard says no', () => {
    host = makeHost()
    const handle = host.open({ id: 'guard', title: 'Guard', content: 'base' })
    let allowed = false
    handle.navigation.push({ content: 'dirty page', onBeforeLeave: () => allowed })
    expect(handle.navigation.back()).toBe(false)
    expect(handle.navigation.depth()).toBe(2)
    allowed = true
    expect(handle.navigation.back()).toBe(true)
    expect(handle.navigation.depth()).toBe(1)
  })

  it('caps the page stack', () => {
    host = makeHost()
    const handle = host.open({ id: 'cap', title: 'Cap', content: 'base' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let index = 0; index < 30; index += 1) handle.navigation.push({ content: index })
    expect(handle.navigation.depth()).toBe(21)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
