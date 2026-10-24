/**
 * FileTree session scope: the workbench keeps ONE mounted tree instance per
 * tab id, and tab ids restart per session, so a session (or cwd) swap
 * re-renders this component in place instead of mounting a fresh one. Nothing
 * picked in the previous project may survive that swap — a leftover selection
 * made "delete selected" send the NEW session's scope with the OLD project's
 * absolute paths, and the host applies those verbatim (containment was removed
 * on purpose): it deleted another project's files. Confirmations and inline
 * editors aimed at a row that is no longer on screen are the same leak.
 *
 * What must NOT change: an ordinary re-render of the SAME session keeps every
 * bit of that state (the workbench relies on the instance staying alive).
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest follows the OS locale; pin en-US so the copy asserted below is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { fsRemove, fsTrees } = vi.hoisted(() => ({
  fsRemove: vi.fn(async (_scope: unknown, path: string) => ({ path })),
  // Every requested level answers with the same two rows under THAT level's
  // path, so each row's absolute path names the project it belongs to.
  fsTrees: vi.fn(async (_scope: unknown, paths: readonly string[]) => ({
    levels: paths.map(path => ({
      path,
      entries: [
        { name: 'a.ts', path: `${path}/a.ts`, isDir: false },
        { name: 'b.ts', path: `${path}/b.ts`, isDir: false },
      ],
      truncated: false,
    })),
  })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees,
    fsRemove,
    // The tree reads the shared git-status store; a non-repo answer keeps every
    // row plain (this spec is about state ownership).
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

let container: HTMLDivElement
let root: Root

/** The tree element for one project, as the workbench renders it. */
function tree(sessionId: string, cwd: string) {
  return createElement(FileTree, {
    sessionId,
    cwd,
    expanded: [],
    revealed: [],
    onToggle: () => {},
    onOpenFile: () => {},
    onReferenceFile: () => {},
    refreshTick: 0,
    onUploadRequest: () => {},
    busy: false,
  })
}

/** Render — or RE-render in place — the one mounted tree, exactly as the
 *  workbench's reused tab instance does on a session swap. */
async function render(sessionId: string, cwd: string): Promise<void> {
  await act(async () => {
    root.render(tree(sessionId, cwd))
  })
}

function click(el: Element, init: MouseEventInit = {}): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })) })
}

function rowByName(name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

/** The batch bar (the kit's section band carries the page class). */
function selectionBar(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[class*="explorerSelectionBar"]')
}

function barAction(label: string): HTMLElement {
  const button = [...(selectionBar()?.querySelectorAll<HTMLElement>('button') ?? [])]
    .find(el => el.textContent === label)
  if (button === undefined) throw new Error(`bar action not found: ${label}`)
  return button
}

function openMenu(name: string): void {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })
  act(() => { rowByName(name).dispatchEvent(event) })
}

function clickMenuitem(label: string): void {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent === label)
  if (item === undefined) throw new Error(`menuitem "${label}" not found`)
  act(() => { item.click() })
}

/** The confirmation modal's action button (the modal is portaled). */
function confirmButton(label: string): HTMLElement {
  const button = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')]
    .find(el => el.textContent === label)
  if (button === undefined) throw new Error(`dialog button "${label}" not found`)
  return button
}

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  // Reset, not clear: a case that parks a removal on a deferred promise must
  // not leak that implementation into the next one.
  fsRemove.mockReset()
  fsRemove.mockImplementation(async (_scope: unknown, path: string) => ({ path }))
})

function mount(): void {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
}

describe('FileTree session scope', () => {
  beforeEach(mount)

  it('drops the previous project\'s selection instead of deleting its files', async () => {
    await render('s1', '/projects/alpha')
    click(rowByName('a.ts'), { ctrlKey: true })
    expect(selectionBar()?.textContent).toContain('1 selected')

    // The same mounted instance, now showing session B's project.
    await render('s2', '/projects/beta')

    expect(selectionBar()).toBeNull()
    expect(fsRemove).not.toHaveBeenCalled()
  })

  it('keeps the selection when the SAME session re-renders', async () => {
    await render('s1', '/projects/alpha')
    click(rowByName('a.ts'), { ctrlKey: true })

    // A refresh tick, a new store revision, a parent re-render: still s1.
    await render('s1', '/projects/alpha')

    expect(selectionBar()?.textContent).toContain('1 selected')
  })

  it('closes a delete confirmation opened in the previous session', async () => {
    await render('s1', '/projects/alpha')
    openMenu('a.ts')
    clickMenuitem('Delete')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    await render('s2', '/projects/beta')

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(fsRemove).not.toHaveBeenCalled()
  })

  it('stops a batch delete from the previous session from settling into the new one', async () => {
    // The walk carries its own scope, so its removals stay correct — but it
    // must not settle (pruneTree / the selection / the busy flag) into whatever
    // project has taken over the instance since.
    let release!: () => void
    const held = new Promise<{ path: string }>((resolve) => {
      release = () => { resolve({ path: '/projects/alpha/a.ts' }) }
    })
    fsRemove.mockImplementationOnce(async () => held)

    await render('s1', '/projects/alpha')
    click(rowByName('a.ts'), { ctrlKey: true })
    click(rowByName('b.ts'), { ctrlKey: true })
    act(() => { barAction('Delete selected').click() })
    const confirm = [...document.querySelectorAll<HTMLElement>('button')]
      .find(el => el.textContent === 'Delete selected' && el.closest('[role="dialog"]') !== null)
    if (confirm === undefined) throw new Error('confirm button not found')
    act(() => { confirm.click() })   // the first removal is now in flight
    // …and it is parked there: one removal issued, the second row untouched.
    expect(fsRemove.mock.calls).toHaveLength(1)

    // Another session takes over the same mounted instance, and the reader
    // makes a fresh selection there.
    await render('s2', '/projects/beta')
    click(rowByName('a.ts'), { ctrlKey: true })
    expect(selectionBar()?.textContent).toContain('1 selected')

    // The previous walk resumes. It must go quiet, not clear THIS selection.
    await act(async () => { release() })
    // The walk's tail is a plain microtask chain, outside act's tracking: give
    // it (and React's flush of whatever it wrote) a beat to land.
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
    expect(selectionBar()?.textContent).toContain('1 selected')
    // …and the stale walk stopped instead of removing the rest of its batch.
    expect(fsRemove.mock.calls).toHaveLength(1)
  })

  // The swap effect above is PASSIVE. A confirmation clicked between the
  // swap's COMMIT and that effect reads the previous project's row while the
  // props already carry the new scope — the request would then pair session
  // B's scope with project A's absolute path, which the host applies verbatim.
  // Only a call-site check closes that window; this case is why it exists.
  it('refuses a confirmation clicked before the swap effect has flushed', async () => {
    await render('s1', '/projects/alpha')
    openMenu('a.ts')
    clickMenuitem('Delete')
    const confirm = confirmButton('Delete')

    // The swap commits NOW and React has not yet run the swap effect.
    flushSync(() => { root.render(tree('s2', '/projects/beta')) })
    // The reader's click lands first — dispatched RAW, not through the `click`
    // helper, whose act() wrapper would flush the effect and hide the window
    // this case exists to cover.
    confirm.click()
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })

    expect(fsRemove).not.toHaveBeenCalled()
  })

  // The positive control for the case above: with no swap the same flow still
  // deletes, and it pairs the armed scope with the armed path. (Counting calls
  // alone would not catch a regression that swapped the scope underneath.)
  it('sends the armed scope together with the armed path', async () => {
    await render('s1', '/projects/alpha')
    openMenu('a.ts')
    clickMenuitem('Delete')
    click(confirmButton('Delete'))
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })

    expect(fsRemove.mock.calls).toEqual([
      [{ sessionId: 's1', cwd: '/projects/alpha' }, '/projects/alpha/a.ts'],
    ])
  })
})
