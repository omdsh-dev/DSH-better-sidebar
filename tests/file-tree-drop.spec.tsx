/**
 * FileTree drag-drop surface: an OS file drag over the tree shows the
 * portaled drop zone (document.body, above DSH's z-1000 page mask) with the
 * hint pill docked at the bottom; row hovers retarget the drop directory.
 * The enter/leave DEPTH COUNTER is the regression guard for the mask
 * flicker: child-element transitions must never hide the zone mid-drag —
 * only the drag actually leaving the tree does. Drops report through
 * onUploadRequest (file rows target their parent directory) and reset all
 * drag state.
 */
// @vitest-environment jsdom
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import type { UploadItem } from '../src/client/upload.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// vitest 4.1.11+ follows the OS locale; pin en-US so hint assertions are
// deterministic regardless of the developer machine.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async () => ({
      entries: [
        { name: 'src', path: '/tmp/src', isDir: true },
        { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
      ],
    }),
  },
  downloadUrl: () => '/sidebar/file',
}))

interface Harness {
  container: HTMLDivElement
  body: HTMLElement
  uploads: { dir: string; items: UploadItem[] }[]
  unmount: () => void
}

/** Mount the tree rooted at /tmp (one level loaded: dir 'src', file 'a.ts'). */
async function mountTree(busy = false): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const uploads: { dir: string; items: UploadItem[] }[] = []
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: (dir, items) => { uploads.push({ dir, items }) },
      busy,
    }))
  })
  return {
    container,
    body: container.firstElementChild as HTMLElement,
    uploads,
    unmount: () => { act(() => { root.unmount() }) },
  }
}

/** A bubbling drag event carrying a stub dataTransfer (jsdom has no DragEvent). */
function dragEvent(type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    // No entry API on the items, so drops fall back to the flat file list.
    value: {
      types: ['Files'],
      items: [],
      files: [new File(['x'], 'dropped.txt')],
      dropEffect: '',
    },
  })
  return event
}

/** Dispatch inside act() so React flushes the state update. */
function fire(target: Element, type: string): Event {
  const event = dragEvent(type)
  act(() => { target.dispatchEvent(event) })
  return event
}

const dropZone = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[class*="uploadDropZone"]')

/** The row whose label text matches (rows are role="button" divs). */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

describe('FileTree drag-drop surface', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await mountTree()
  })
  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
  })

  it('shows the portaled drop zone with the generic hint while a file drag hovers the tree', () => {
    expect(dropZone()).toBeNull()
    fire(harness.body, 'dragenter')
    const zone = dropZone()
    expect(zone).not.toBeNull()
    expect(zone!.parentElement).toBe(document.body)
    expect(zone!.textContent).toContain('Drop files/folders here to upload')
    // jsdom's rects are all-zero, so the left space is 0px wide and the
    // chat-area hint is skipped (its floor is 200px).
    expect(document.body.querySelector('[class*="uploadDropChatHint"]')).toBeNull()
  })

  it('keeps the zone through child-element transitions and hides it only when the drag leaves the tree', () => {
    const file = rowByName(harness.container, 'a.ts')
    fire(harness.body, 'dragenter') // depth 1
    fire(file, 'dragenter') // bubbles: depth 2 (entered the row)
    fire(file, 'dragleave') // bubbles: depth 1 — a child transition must not hide the zone
    expect(dropZone()).not.toBeNull()
    fire(harness.body, 'dragleave') // depth 0: the drag left the tree
    expect(dropZone()).toBeNull()
  })

  it('retargets the pill to the hovered directory row and back to the root over gaps', () => {
    const dir = rowByName(harness.container, 'src')
    fire(harness.body, 'dragenter')
    fire(dir, 'dragover')
    expect(dropZone()!.textContent).toContain('Upload into /tmp/src')
    expect(dir.className).toContain('explorerRowDropTarget')
    fire(harness.body, 'dragover') // a non-row region: back to the workspace root
    expect(dropZone()!.textContent).toContain('Drop files/folders here to upload')
    expect(dir.className).not.toContain('explorerRowDropTarget')
  })

  it('drops onto a file row upload into its parent directory and reset the drag state', async () => {
    const file = rowByName(harness.container, 'a.ts')
    fire(harness.body, 'dragenter')
    const drop = fire(file, 'drop')
    // The payload collection is async (entry traversal); flush the then.
    await act(async () => {})
    expect(drop.defaultPrevented).toBe(true)
    expect(harness.uploads).toHaveLength(1)
    expect(harness.uploads[0]!.dir).toBe('/tmp')
    expect(harness.uploads[0]!.items.map(item => item.relativePath)).toEqual(['dropped.txt'])
    expect(dropZone()).toBeNull()
  })

  it('drops onto the tree body upload into the workspace root', async () => {
    fire(harness.body, 'dragenter')
    fire(harness.body, 'drop')
    await act(async () => {})
    expect(harness.uploads).toHaveLength(1)
    expect(harness.uploads[0]!.dir).toBe('/tmp')
  })

  it('suppresses the affordance while an upload is in flight', async () => {
    harness.unmount()
    document.body.innerHTML = ''
    const busyHarness = await mountTree(true)
    fire(busyHarness.body, 'dragenter')
    fire(busyHarness.body, 'dragover')
    expect(dropZone()).toBeNull()
    fire(busyHarness.body, 'drop')
    await act(async () => {})
    expect(busyHarness.uploads).toHaveLength(0)
    busyHarness.unmount()
  })
})
