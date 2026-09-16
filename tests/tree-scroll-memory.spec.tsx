/**
 * The explorer's scroll position across tab / conversation switches. The host
 * mounts ONE tab body per pane (native right Sidebar) or keys the workbench
 * cell by tab id, so switching away destroys the `.explorerBody` element and
 * its `scrollTop` with it; the tree must restore the reader's place when the
 * tab comes back. The tree loads levels lazily, which is where the interesting
 * cases live: a mount's first commit has a body far shorter than the
 * remembered offset, so a naive write is clamped to 0.
 *
 * jsdom has no layout, so every geometry (scrollHeight / clientHeight /
 * scrollTop) is pinned per test — the same technique the reveal-scroll spec
 * uses. A re-render stands in for a level arriving (it re-runs the restore
 * effect, exactly as the `data` state update does in the browser).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { createSidebarStore } from '../src/client/state.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async () => ({ entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

afterEach(() => { document.body.innerHTML = '' })

interface Harness {
  root: Root
  container: HTMLDivElement
  body: HTMLElement
  /** Re-render (a fresh `revealed` identity re-runs the restore effect). */
  rerender: (revealed: string[]) => Promise<void>
  /** Pin the body's scroll geometry (jsdom reports 0 for everything). */
  metrics: (client: number, height: number) => void
  /** Write `top` and fire the scroll event the reader's wheel would fire. */
  scrollTo: (top: number) => void
  /** The body's current scrollTop as React left it. */
  top: () => number
  unmount: () => void
}

async function mountTree(sessionId: string, cwd: string, revealed: string[] = []): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  let client = 0
  let height = 0
  const render = (nextRevealed: string[]): void => {
    root.render(createElement(FileTree, {
      sessionId,
      cwd,
      store: createSidebarStore(),
      expanded: [],
      revealed: nextRevealed,
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
  }
  await act(async () => { render(revealed) })
  const body = container.firstElementChild as HTMLElement
  Object.defineProperty(body, 'clientHeight', { get: () => client })
  Object.defineProperty(body, 'scrollHeight', { get: () => height })
  let top = 0
  Object.defineProperty(body, 'scrollTop', { get: () => top, set: (value: number) => { top = value } })
  return {
    root,
    container,
    body,
    rerender: async (nextRevealed) => { await act(async () => { render(nextRevealed) }) },
    metrics: (nextClient, nextHeight) => { client = nextClient; height = nextHeight },
    scrollTo: (value) => {
      top = value
      act(() => { body.dispatchEvent(new Event('scroll', { bubbles: false })) })
    },
    top: () => top,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/**
 * Remember a position for `sessionId`, the way a reader scrolling the tree
 * does, then tear the tree down (the host's tab switch).
 */
async function seed(user: string, cwd: string, position: number): Promise<void> {
  const tree = await mountTree(user, cwd)
  tree.metrics(300, 3000)
  tree.scrollTo(position)
  expect(tree.top(), 'the harness must record a real offset').toBe(position)
  tree.unmount()
}

describe('FileTree scroll memory', () => {
  it('restores the remembered offset after a remount', async () => {
    await seed('restore', '/tmp', 620)
    const tree = await mountTree('restore', '/tmp')
    // A fresh mount: the levels have not loaded, the body cannot scroll yet.
    tree.metrics(300, 300)
    await tree.rerender([])
    expect(tree.top(), 'a short body must not swallow the offset as 0').toBe(0)

    // A level arrives and the body can hold the offset.
    tree.metrics(300, 3000)
    await tree.rerender([])
    expect(tree.top()).toBe(620)
    tree.unmount()
  })

  it('starts at the top when nothing was remembered', async () => {
    const tree = await mountTree('fresh', '/tmp')
    tree.metrics(300, 3000)
    await tree.rerender([])
    expect(tree.top()).toBe(0)
    tree.unmount()
  })

  it('clamps a remembered offset past the end of a shorter tree', async () => {
    await seed('shrink', '/tmp', 5000)
    const tree = await mountTree('shrink', '/tmp')
    tree.metrics(300, 1000)
    await tree.rerender([])
    expect(tree.top(), 'the offset is clamped to the scrollable range').toBe(700)
    tree.unmount()
  })

  it('keeps each session’s own place (a conversation switch)', async () => {
    await seed('session-a', '/tmp', 400)
    await seed('session-b', '/tmp', 900)

    const a = await mountTree('session-a', '/tmp')
    a.metrics(300, 3000)
    await a.rerender([])
    expect(a.top()).toBe(400)
    a.unmount()

    const b = await mountTree('session-b', '/tmp')
    b.metrics(300, 3000)
    await b.rerender([])
    expect(b.top()).toBe(900)
    b.unmount()
  })

  it('applies the remembered offset only once (a later commit must not re-yank)', async () => {
    await seed('once', '/tmp', 500)
    const tree = await mountTree('once', '/tmp')
    tree.metrics(300, 3000)
    await tree.rerender([])
    expect(tree.top()).toBe(500)

    // The reader scrolls somewhere else, then a refresh tick re-renders.
    tree.scrollTo(120)
    await tree.rerender([])
    expect(tree.top(), 'a settled restore never fights the reader again').toBe(120)
    tree.unmount()
  })

  it('a reader who scrolls before the levels load wins over the pending restore', async () => {
    await seed('raced', '/tmp', 800)
    const tree = await mountTree('raced', '/tmp')
    // The root level is in, so a scroll is legitimate — and it arrives before
    // the tree is tall enough for the remembered 800.
    tree.metrics(300, 600)
    tree.scrollTo(150)
    await tree.rerender([])
    expect(tree.top(), 'the reader’s own position outranks the memory').toBe(150)
    tree.unmount()
  })

  it('does not overwrite the memory while the body cannot scroll', async () => {
    await seed('clamped', '/tmp', 730)
    // A second tree at the SAME key: while it is collapsed/loading, a scroll
    // event reports 0 — remembering that would erase the real position.
    const tree = await mountTree('clamped', '/tmp')
    tree.metrics(300, 300)
    tree.scrollTo(0)
    tree.unmount()

    const back = await mountTree('clamped', '/tmp')
    back.metrics(300, 3000)
    await back.rerender([])
    expect(back.top(), 'the collapsed 0 must not have replaced the memory').toBe(730)
    back.unmount()
  })

  it('lets a “show in folder” reveal own the scroll when both apply', async () => {
    await seed('reveal', '/tmp', 640)
    const tree = await mountTree('reveal', '/tmp', ['/tmp/src/deep.ts'])
    tree.metrics(300, 3000)
    await tree.rerender(['/tmp/src/deep.ts'])
    expect(tree.top(), 'the reveal effect scrolls; the memory stands down').toBe(0)
    tree.unmount()
  })
})
