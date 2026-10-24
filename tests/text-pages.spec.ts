/**
 * The append-only pager behind the over-limit preview.
 *
 * What is under test is the reader-visible behaviour: scroll to the bottom and
 * the next window is APPENDED (nothing already read disappears), `loadAll`
 * walks to EOF one request at a time, and the caller can stop that walk early
 * with its own ceiling.
 *
 * `api.fsReadPage` is stubbed — this is the pager's contract with the host, not
 * the host's paging (that lives in `tests/fs-read-page.spec.ts`).
 */
// @vitest-environment jsdom
import './browser-globals.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { useTextPager, type TextPager } from '../src/client/text-pages.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()

const SCOPE = { sessionId: 's', cwd: '/ws' }
const PATH = '/ws/log.jsonl'

/** One page the stubbed host hands back. */
interface FakePage {
  text: string
  nextOffset: number
  eof: boolean
}

/** A file of `count` identical pages. */
function pagesOf(count: number, text = 'line\n'): FakePage[] {
  return Array.from({ length: count }, (_, index) => ({
    text,
    nextOffset: (index + 1) * text.length,
    eof: index === count - 1,
  }))
}

/** The offsets each page starts at, i.e. the byte-offset request sequence. */
function boundariesOf(pages: FakePage[]): number[] {
  let running = 0
  return pages.map((page) => {
    const start = running
    running = page.nextOffset
    return start
  })
}

/** Install a stubbed `fsReadPage` that serves `pages` BY OFFSET, like the host. */
function stubPages(pages: FakePage[], failAtRequest?: number): number[] {
  const requests: number[] = []
  const boundaries = boundariesOf(pages)
  const total = pages[pages.length - 1]?.nextOffset ?? 0
  vi.spyOn(api, 'fsReadPage').mockImplementation(async (_scope, _path, offset) => {
    requests.push(offset)
    if (failAtRequest !== undefined && requests.length === failAtRequest) {
      throw new Error('page fetch failed')
    }
    const index = boundaries.indexOf(offset)
    if (index === -1) throw new Error(`test setup: unexpected offset ${offset}`)
    const page = pages[index]!
    return {
      kind: 'text' as const,
      text: page.text,
      offset,
      nextOffset: page.nextOffset,
      eof: page.eof,
      size: total,
      encoding: 'utf8',
    }
  })
  return requests
}

/** The pager face the tests drive, captured from inside the rendered tree. */
interface Harness {
  pager: () => TextPager
  loadMore: () => void
  loadAll: () => void
  reload: () => void
  rerender: (enabled: boolean, revision?: number) => void
}

/** Render the hook and expose its commands. */
function mountPager(maxLines?: number): Harness {
  const seen: { value: TextPager | null } = { value: null }
  function Probe(props: { enabled: boolean; revision: number }): ReturnType<typeof createElement> {
    seen.value = useTextPager(SCOPE, PATH, props.enabled, props.revision, maxLines)
    // A ref write proves the probe really rendered (a stale `seen` from an
    // earlier mount would otherwise read as a passing assertion).
    rendered.current = true
    return createElement('div', { 'data-pages': seen.value.pages.length })
  }
  const rendered = { current: false }
  const root = renderRoot(createElement(Probe, { enabled: true, revision: 0 }))
  const pager = (): TextPager => {
    if (!rendered.current || seen.value === null) throw new Error('the probe never rendered')
    return seen.value
  }
  return {
    pager,
    loadMore: () => { void act(() => { pager().loadMore() }) },
    loadAll: () => { void act(() => { pager().loadAll() }) },
    reload: () => { void act(() => { pager().reload() }) },
    rerender: (enabled: boolean, revision = 0) => {
      root.rerender(createElement(Probe, { enabled, revision }))
    },
  }
}

/** Let the pending fetch promises (and their re-renders) settle. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  })
}

// `api` is imported after the mock registry is set up by the spies above; the
// dynamic import keeps the spy attached to the module the hook actually uses.
const { api } = await import('../src/client/api.ts')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useTextPager', () => {
  it('loads the first page on mount, then APPENDS the next without dropping it', async () => {
    const requests = stubPages(pagesOf(3))
    const harness = mountPager()
    await settle()
    expect(requests).toEqual([0])
    expect(harness.pager().pages).toEqual(['line\n'])
    expect(harness.pager().atEnd).toBe(false)

    harness.loadMore()
    await settle()
    expect(requests).toEqual([0, 5])
    // Append, not replace: page one is still on screen.
    expect(harness.pager().pages).toEqual(['line\n', 'line\n'])
    expect(harness.pager().lineStarts).toEqual([1, 2])
  })

  it('walks to EOF and then stops asking', async () => {
    const requests = stubPages(pagesOf(3))
    const harness = mountPager()
    await settle()
    harness.loadMore()
    await settle()
    harness.loadMore()
    await settle()
    expect(harness.pager().atEnd).toBe(true)
    expect(harness.pager().pages).toHaveLength(3)
    expect(harness.pager().loadedBytes).toBe(15)

    // Past EOF the pager must not touch the network again.
    harness.loadMore()
    await settle()
    expect(requests).toEqual([0, 5, 10])
  })

  it('loadAll appends every remaining page, in offset order', async () => {
    const requests = stubPages(pagesOf(6))
    const harness = mountPager()
    await settle()
    harness.loadAll()
    await settle()
    expect(harness.pager().pages).toHaveLength(6)
    expect(harness.pager().atEnd).toBe(true)
    // Each request uses the PREVIOUS response's nextOffset — the reason the walk
    // cannot be parallelised.
    expect(requests).toEqual([0, 5, 10, 15, 20, 25])
    expect(harness.pager().lineStarts).toEqual([1, 2, 3, 4, 5, 6])
    expect(harness.pager().totalLines).toBe(6)
  })

  it('stops loadAll at the line ceiling and reports atCap (#the row budget)', async () => {
    const requests = stubPages(pagesOf(10))
    // One line per page, ceiling of three: exactly three pages may land.
    const harness = mountPager(3)
    await settle()
    harness.loadAll()
    await settle()
    expect(harness.pager().pages).toHaveLength(3)
    expect(harness.pager().totalLines).toBe(3)
    // Not EOF — the ceiling is what stopped it, and the caller can say so.
    expect(harness.pager().atEnd).toBe(false)
    expect(harness.pager().atCap).toBe(true)
    expect(requests).toEqual([0, 5, 10])

    // And loadMore must respect it too, not just loadAll.
    harness.loadMore()
    await settle()
    expect(requests).toEqual([0, 5, 10])
  })

  it('never reports atCap for a file that simply ended inside the ceiling', async () => {
    stubPages(pagesOf(2))
    const harness = mountPager(3)
    await settle()
    harness.loadAll()
    await settle()
    expect(harness.pager().totalLines).toBe(2)
    expect(harness.pager().atEnd).toBe(true)
    expect(harness.pager().atCap).toBe(false)
  })

  it('stops loadAll on a failed page and surfaces the error', async () => {
    const requests = stubPages(pagesOf(6), 3)
    const harness = mountPager()
    await settle()
    harness.loadAll()
    await settle()
    // Two pages landed, the third failed, and the walk did not continue.
    expect(harness.pager().pages).toHaveLength(2)
    expect(harness.pager().error).toBe('page fetch failed')
    expect(requests).toEqual([0, 5, 10])
    expect(harness.pager().loadingAll).toBe(false)
    expect(harness.pager().loading).toBe(false)
  })

  it('reload drops the accumulated pages and re-reads from the start', async () => {
    const requests = stubPages(pagesOf(4))
    const harness = mountPager()
    await settle()
    harness.loadMore()
    await settle()
    expect(harness.pager().pages).toHaveLength(2)

    harness.reload()
    await settle()
    expect(harness.pager().pages).toHaveLength(1)
    expect(harness.pager().atEnd).toBe(false)
    expect(requests).toEqual([0, 5, 0])
  })

  it('issues nothing while parked, and resumes when enabled', async () => {
    const requests = stubPages(pagesOf(3))
    const harness = mountPager()
    harness.rerender(false)
    await settle()
    // The mount itself already fetched page one; parking must add nothing.
    const before = requests.length
    harness.rerender(false)
    await settle()
    expect(requests.length).toBe(before)
  })

  it('counts lines for the row cap without letting a trailing newline inflate it', async () => {
    // The ceiling is spent on LINES, so a phantom line per page would hit it
    // early. `a\n\nb\n` is three rows (the blank one included — it renders as
    // an empty row in the log view) and NOT four: the trailing newline only
    // terminates the last line.
    stubPages([{ text: 'a\n\nb\n', nextOffset: 5, eof: true }])
    const harness = mountPager()
    await settle()
    expect(harness.pager().totalLines).toBe(3)
  })
})
