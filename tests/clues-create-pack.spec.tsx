/**
 * The create-pack window (S9).
 *
 * Contract pinned here:
 * - the compact window is a singleton per workspace: opening again focuses the
 *   live instance and keeps the typed draft;
 * - typing writes nothing; only Submit calls `packsCreate`, exactly once;
 * - success closes the window BEFORE `onCreated` reports the pack;
 * - failure keeps the window, the draft and a visible reason (plus onNotice);
 * - the close control, Cancel and `handle.close()` are refused while the one
 *   create request is in flight, then succeed once it settles;
 * - Cancel closes without ever writing.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'

setupReactAct()

beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

import { WindowHost } from '../src/client/windows/WindowHost.tsx'
import { createWindowHost } from '../src/client/windows/host.ts'
import { openCreatePackWindow, createPackWindowId } from '../src/client/clues/windows/create-pack.tsx'
import type { WindowHostController } from '../src/client/windows/types.ts'
import type { FormatRendererRegistry } from '../src/client/windows/format-content.tsx'
import type { BetterSidebarCluesClientFace } from '../src/client/clues/registry.ts'
import type { CluePack, CluesPackMutationResult } from '../src/clues/types.ts'

const VIEWPORT = { width: 1_000, height: 800 }

const PACK: CluePack = {
  id: 'p3',
  name: 'Roadmap',
  workspaceId: 'ws-1',
  members: [],
  revision: 1,
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
}

const FORMATS: FormatRendererRegistry = {
  getFormatRenderer: () => undefined,
  subscribe: () => () => {},
}

function resultOf(): CluesPackMutationResult {
  return { pack: PACK, revision: 4, packRevision: 1 }
}

/** A promise the test resolves (or rejects) when it chooses. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** The focused face: only `packsCreate` is exercised by this surface. */
function faceOf(
  create: (workspaceId: string, input: { name: string }) => Promise<CluesPackMutationResult>,
): BetterSidebarCluesClientFace {
  return { api: { packsCreate: create } } as unknown as BetterSidebarCluesClientFace
}

let host: WindowHostController
let mounted: RenderedRoot

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height })
  host = createWindowHost({ viewport: () => VIEWPORT })
  mounted = renderRoot(createElement(WindowHost, { host, formats: FORMATS }))
})

afterEach(() => {
  mounted.unmount()
  host.dispose()
  document.body.innerHTML = ''
})

interface OpenOptions {
  readonly face: BetterSidebarCluesClientFace
  readonly workspaceId?: string
  onCreated?(pack: CluePack): void
  onNotice?(message: string): void
  onClosed?(): void
}

function open(options: OpenOptions): ReturnType<typeof openCreatePackWindow> {
  let handle!: ReturnType<typeof openCreatePackWindow>
  act(() => {
    handle = openCreatePackWindow({
      windows: host,
      face: options.face,
      workspaceId: options.workspaceId ?? 'ws-1',
      onCreated: options.onCreated ?? ((): void => {}),
      onNotice: options.onNotice ?? ((): void => {}),
      ...(options.onClosed === undefined ? {} : { onClosed: options.onClosed }),
    })
  })
  return handle
}

function frames(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-floating-window]')]
}

function onlyFrame(): HTMLElement {
  const [frame] = frames()
  if (frame === undefined) throw new Error('no create-pack window is open')
  return frame
}

function inputOf(frame: HTMLElement = onlyFrame()): HTMLInputElement {
  const input = frame.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')
  if (input === null) throw new Error('no pack-name input')
  return input
}

function submitOf(frame: HTMLElement = onlyFrame()): HTMLButtonElement {
  const button = frame.querySelector<HTMLButtonElement>('button[type="submit"]')
  if (button === null) throw new Error('no submit button')
  return button
}

function buttonWithText(frame: HTMLElement, label: string): HTMLButtonElement {
  const button = [...frame.querySelectorAll<HTMLButtonElement>('button')]
    .find(candidate => candidate.textContent?.trim() === label)
  if (button === undefined) throw new Error(`no "${label}" button`)
  return button
}

/** Type through the native setter + input event React listens for. */
function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Flush the close/guard microtask chain without depending on real timers. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
  })
}

describe('create-pack window', () => {
  it('writes only on explicit submit and closes before onCreated', async () => {
    const call = deferred<CluesPackMutationResult>()
    const packsCreate = vi.fn(() => call.promise)
    let windowsAtCreated = -1
    const onCreated = vi.fn(() => { windowsAtCreated = host.getSnapshot().windows.length })
    open({ face: faceOf(packsCreate), onCreated })

    const view = host.getSnapshot().windows[0]!
    expect(view.id).toBe(createPackWindowId('ws-1'))
    expect(view.size).toBe('compact')
    expect(onlyFrame().getAttribute('aria-label')).toBe('Clue packs · New')

    typeInto(inputOf(), '  Roadmap  ')
    expect(packsCreate).not.toHaveBeenCalled()

    await act(async () => { submitOf().click() })
    expect(packsCreate).toHaveBeenCalledTimes(1)
    expect(packsCreate).toHaveBeenCalledWith('ws-1', { name: 'Roadmap' })
    expect(submitOf().disabled).toBe(true)
    expect(submitOf().getAttribute('aria-busy')).toBe('true')
    expect(submitOf().textContent).toBe('Create')

    await act(async () => {
      call.resolve(resultOf())
      for (let index = 0; index < 5; index += 1) await Promise.resolve()
    })
    expect(host.getSnapshot().windows).toHaveLength(0)
    expect(frames()).toHaveLength(0)
    expect(onCreated).toHaveBeenCalledWith(PACK)
    // The callback saw the closed state: success reports AFTER the close.
    expect(windowsAtCreated).toBe(0)
  })

  it('keeps the window and the draft when creation fails', async () => {
    const packsCreate = vi.fn(async () => { throw new Error('denied') })
    const onNotice = vi.fn()
    open({ face: faceOf(packsCreate), onNotice })

    typeInto(inputOf(), 'Field notes')
    await act(async () => { submitOf().click() })

    expect(host.getSnapshot().windows).toHaveLength(1)
    const frame = onlyFrame()
    expect(inputOf(frame).value).toBe('Field notes')
    expect(inputOf(frame).disabled).toBe(false)
    expect(frame.querySelector('[role="alert"]')?.textContent).toBe('Saving the pack failed.')
    expect(onNotice).toHaveBeenCalledWith('Saving the pack failed.')
    expect(submitOf(frame).disabled).toBe(false)
    expect(submitOf(frame).textContent).toBe('Create')
  })

  it('refuses every close path while the create is in flight', async () => {
    const call = deferred<CluesPackMutationResult>()
    const packsCreate = vi.fn(() => call.promise)
    const onCreated = vi.fn()
    const handle = open({ face: faceOf(packsCreate), onCreated })

    typeInto(inputOf(), 'Roadmap')
    await act(async () => { submitOf().click() })
    expect(packsCreate).toHaveBeenCalledTimes(1)
    expect(buttonWithText(onlyFrame(), 'Cancel').disabled).toBe(true)

    // The title-bar close control runs the same host guard as Escape.
    act(() => { onlyFrame().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click() })
    await settle()
    expect(host.getSnapshot().windows).toHaveLength(1)
    expect(inputOf().value).toBe('Roadmap')

    // The public handle close is refused too.
    await act(async () => { await handle.close() })
    expect(host.getSnapshot().windows).toHaveLength(1)

    // Once the request settles, the blocked closers no longer block.
    await act(async () => { call.resolve(resultOf()) })
    await settle()
    expect(host.getSnapshot().windows).toHaveLength(0)
    expect(onCreated).toHaveBeenCalledWith(PACK)
  })

  it('keeps one window per workspace and preserves the draft on reopen', () => {
    const first = open({ face: faceOf(vi.fn()) })
    typeInto(inputOf(), 'Draft name')

    const second = open({ face: faceOf(vi.fn()) })
    expect(second).toBe(first)
    expect(frames()).toHaveLength(1)
    expect(inputOf().value).toBe('Draft name')

    open({ face: faceOf(vi.fn()), workspaceId: 'ws-2' })
    expect(frames()).toHaveLength(2)
    expect(host.getSnapshot().windows.map(view => view.id)).toEqual([
      createPackWindowId('ws-1'),
      createPackWindowId('ws-2'),
    ])
  })

  it('Cancel closes without writing', async () => {
    const packsCreate = vi.fn(async () => resultOf())
    open({ face: faceOf(packsCreate) })
    typeInto(inputOf(), 'Draft name')

    await act(async () => { buttonWithText(onlyFrame(), 'Cancel').click() })
    expect(packsCreate).not.toHaveBeenCalled()
    expect(host.getSnapshot().windows).toHaveLength(0)
  })

  it('releases the task pin once on every real close and never on teardown', async () => {
    const cancelClosed = vi.fn()
    open({ face: faceOf(vi.fn()), onClosed: cancelClosed })
    await act(async () => { buttonWithText(onlyFrame(), 'Cancel').click() })
    await settle()
    expect(cancelClosed).toHaveBeenCalledTimes(1)
    expect(host.getSnapshot().windows).toHaveLength(0)

    const successClosed = vi.fn()
    const onCreated = vi.fn()
    const packsCreate = vi.fn(async () => resultOf())
    open({ face: faceOf(packsCreate), onClosed: successClosed, onCreated })
    typeInto(inputOf(), 'Roadmap')
    await act(async () => { submitOf().click() })
    await settle()
    expect(successClosed).toHaveBeenCalledTimes(1)
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(host.getSnapshot().windows).toHaveLength(0)

    // Plugin teardown drops the window WITHOUT calling onClose: the owner is
    // being unloaded with it, so releasing a pin there would be irrelevant.
    const teardownClosed = vi.fn()
    open({ face: faceOf(vi.fn()), workspaceId: 'ws-teardown', onClosed: teardownClosed })
    expect(frames()).toHaveLength(1)
    act(() => { host.dispose() })
    expect(teardownClosed).not.toHaveBeenCalled()
  })
})
