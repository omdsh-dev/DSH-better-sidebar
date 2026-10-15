/**
 * The explorer row's last-modified column: a row that knows its time shows a
 * compact label pinned right, today's rows read as a clock and older ones as a
 * date, the full stamp rides in the tooltip, and a row whose stat failed shows no
 * label at all rather than a placeholder.
 *
 * The label's branch is what makes it useful — a reader compares a fresh artifact
 * against a stale one at a glance — so both branches are pinned here.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

/** One hour in milliseconds, the unit the fixtures below reason in. */
const HOUR = 3_600_000

/**
 * Entries cover the three shapes the column must distinguish: a file modified
 * today, a file modified well before today, and a file whose time is unknown.
 */
const NOW = Date.now()
const fixtures = [
  { name: 'today.ts', path: '/tmp/today.ts', isDir: false, mtimeMs: NOW },
  { name: 'older.ts', path: '/tmp/older.ts', isDir: false, mtimeMs: NOW - 30 * 24 * HOUR },
  { name: 'unknown.ts', path: '/tmp/unknown.ts', isDir: false },
  { name: 'folder', path: '/tmp/folder', isDir: true, mtimeMs: NOW - 2 * HOUR },
]

const { fsTrees } = vi.hoisted(() => ({ fsTrees: vi.fn() }))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees: async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => ({ path, entries: fixtures, truncated: false })),
    }),
    gitStatus: async () => ({ isRepo: false }),
    downloadUrl: () => '/sidebar/file',
    isOutsideWorkspaceMessage: () => false,
  },
}))
void fsTrees

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

async function mountTree(): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 'mtime-spec',
      cwd: '/tmp',
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
    // Settle the listing fetch, which starts in FileTree's mount effect.
    await Promise.resolve()
    await Promise.resolve()
  })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** One tree row by its displayed name. */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

/** The time label inside one row, or undefined when the row shows none. */
function timeLabel(row: HTMLElement): HTMLElement | undefined {
  return row.querySelector<HTMLElement>('[class*="explorerTime"]') ?? undefined
}

describe('file tree modified time', () => {
  let harness: Harness | undefined
  afterEach(() => {
    harness?.unmount()
    harness = undefined
  })

  it('shows the clock for a row modified today and the date for an older one', async () => {
    harness = await mountTree()
    const today = timeLabel(rowByName(harness.container, 'today.ts'))
    const older = timeLabel(rowByName(harness.container, 'older.ts'))
    // Same day reads as a clock, any other day as a date. Both are the compact
    // five-character form the column is sized for.
    expect(today?.textContent).toMatch(/^\d{2}:\d{2}$/u)
    expect(older?.textContent).toMatch(/^\d{2}-\d{2}$/u)
  })

  it('puts the full stamp in the label tooltip', async () => {
    harness = await mountTree()
    const today = timeLabel(rowByName(harness.container, 'today.ts'))
    // The abbreviated label cannot carry the year, so the tooltip must.
    const title = today?.getAttribute('title') ?? ''
    expect(title).not.toBe('')
    expect(title).toBe(new Date(NOW).toLocaleString())
  })

  it('renders no label for a row whose time is unknown', async () => {
    harness = await mountTree()
    const row = rowByName(harness.container, 'unknown.ts')
    // A missing stat is an absent label, never a placeholder like `--:--`, which
    // would read as a real (and wrong) time. The row's text is then just its name
    // plus the hover-revealed reference affordance.
    expect(timeLabel(row)).toBeUndefined()
    expect(row.textContent).toBe('unknown.ts@file')
  })

  it('dates a directory row as well as a file row', async () => {
    harness = await mountTree()
    // Directories carry a time too: the probe stats every row, and a folder's
    // recency is what tells a reader whether its contents were just touched.
    expect(timeLabel(rowByName(harness.container, 'folder'))?.textContent).toMatch(/^\d{2}:\d{2}$/u)
  })
})
