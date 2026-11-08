/**
 * The module-level caches that a kept-mounted page would otherwise grow forever.
 *
 * v0.25 made every visited native tab body permanent (the host has no LRU), so
 * the small maps that used to be bounded by their component's lifetime now live
 * for the whole page: the editor's per-file PREVIEW SCROLL memory, the changes
 * lens's per-scope COMMIT DRAFTS, the markdown navigation's parked cross-file
 * anchors (whose TTL was only ever checked when an anchor was TAKEN — a fragment
 * parked for a document nobody opens was never re-checked), and the editor
 * ops-stream's per-session record. Each has its own spec-level surface because
 * none of them has behaviour to observe otherwise:
 *
 *  - the scroll memory and the draft record are written and read by the
 *    component through the exported helpers below, so the bound is asserted on
 *    exactly the function the component calls;
 *  - the anchor sweep is a no-op for a MISS (an expired entry and an evicted one
 *    both take as `null`), so its count is the only observable — the sweep the
 *    WRITE path performs is what the case pins;
 *  - the ops-stream's bound IS observable: a session still inside it resumes
 *    from its cursor and publishes what it missed, one evicted past it
 *    re-baselines (the state a page reload starts from).
 */
// @vitest-environment jsdom
import './browser-globals.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { COMMIT_DRAFT_CAP, withCommitDraft } from '../src/client/changes/GitLens.tsx'
import { PREVIEW_SCROLL_CAP, previewScrollOf, rememberPreviewScroll } from '../src/client/TextEditor.tsx'
import { useFileOpStream, type FileOpStreamState } from '../src/client/ops-stream.ts'
import {
  rememberMarkdownAnchor,
  sweepPendingAnchors,
  takeMarkdownAnchor,
} from '../src/client/markdown-navigation.ts'
import type { SidebarSessionEvent } from '../src/context-types.ts'

setupReactAct()

const { changesOps } = vi.hoisted(() => ({ changesOps: vi.fn() }))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return { ...actual, api: { ...actual.api, changesOps: (...args: unknown[]) => changesOps(...args) } }
})

/** One `tool/call` event (the shape `extractFileOps` reads). */
function call(seq: number, name: string, callId: string, args: unknown): SidebarSessionEvent {
  return { type: 'tool/call', seq, time: seq, data: { name, callId, arguments: JSON.stringify(args) } }
}

/** Its settled `tool/result`, in the 0.1.7 first-class tool-message shape. */
function result(seq: number, callId: string, text: string): SidebarSessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: {
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        isError: false,
        content: [{ type: 'text', text }],
      },
    },
  }
}

/** The published state of the stream the probe last read. */
let latestStream: FileOpStreamState | null = null

/** One mounted editor's view of its session's ops stream. */
function StreamProbe(props: { sessionId: string; enabled: boolean }) {
  latestStream = useFileOpStream({ sessionId: props.sessionId, cwd: '/w' }, props.enabled)
  return null
}

describe('TextEditor preview scroll memory', () => {
  it('remembers a position per document and forgets the least recent past the cap', () => {
    const scope = { sessionId: 'scroll-spec' }
    rememberPreviewScroll(scope, '/w/a.md', 120)
    rememberPreviewScroll(scope, '/w/b.md', 240)
    expect(previewScrollOf(scope, '/w/a.md')).toBe(120)
    expect(previewScrollOf(scope, '/w/b.md')).toBe(240)
    // A document never previewed opens at the top.
    expect(previewScrollOf(scope, '/w/never.md')).toBe(0)

    // One entry per document is fine; the (cap + 1)-th write is not — the two
    // documents above are the least recently written, so they go first.
    for (let index = 0; index < PREVIEW_SCROLL_CAP; index++) {
      rememberPreviewScroll(scope, `/w/f${index}.md`, index + 1)
    }
    expect(previewScrollOf(scope, '/w/a.md')).toBe(0)
    expect(previewScrollOf(scope, '/w/b.md')).toBe(0)
    expect(previewScrollOf(scope, `/w/f${PREVIEW_SCROLL_CAP - 1}.md`)).toBe(PREVIEW_SCROLL_CAP)

    // Re-scrolling a document moves it to the back of the eviction order, so
    // the NEXT new document evicts the one behind it instead.
    rememberPreviewScroll(scope, '/w/f0.md', 111)
    rememberPreviewScroll(scope, '/w/fresh.md', 999)
    expect(previewScrollOf(scope, '/w/f0.md')).toBe(111)
    expect(previewScrollOf(scope, '/w/f1.md')).toBe(0)
    expect(previewScrollOf(scope, '/w/fresh.md')).toBe(999)
  })

  it('keys a position by session as well as by path', () => {
    rememberPreviewScroll({ sessionId: 'scroll-a' }, '/w/same.md', 10)
    rememberPreviewScroll({ sessionId: 'scroll-b' }, '/w/same.md', 20)
    expect(previewScrollOf({ sessionId: 'scroll-a' }, '/w/same.md')).toBe(10)
    expect(previewScrollOf({ sessionId: 'scroll-b' }, '/w/same.md')).toBe(20)
  })
})

describe('GitLens commit drafts', () => {
  it('keeps the newest scopes and drops the ones typed into longest ago', () => {
    const key = (index: number): string => `draft-s${index}\u0000/w${index}`
    let drafts: Record<string, string> = {}
    for (let index = 0; index < COMMIT_DRAFT_CAP + 5; index++) {
      drafts = withCommitDraft(drafts, key(index), `message ${index}`)
    }
    // The record is bounded…
    expect(Object.keys(drafts)).toHaveLength(COMMIT_DRAFT_CAP)
    // …and what it dropped is the OLDEST scope, never the newest one.
    expect(drafts[key(0)]).toBeUndefined()
    expect(drafts[key(COMMIT_DRAFT_CAP + 4)]).toBe(`message ${COMMIT_DRAFT_CAP + 4}`)

    // A rewrite moves its scope to the back: the next new scope evicts another.
    drafts = withCommitDraft(drafts, key(5), 'edited')
    drafts = withCommitDraft(drafts, 'draft-fresh\u0000/w', 'new message')
    expect(drafts[key(5)]).toBe('edited')
    expect(drafts[key(6)]).toBeUndefined()

    // Committing clears the draft but keeps its key: the box reads back as an
    // empty input, which is what `commitDrafts[draftKey] ?? ''` relies on.
    expect(withCommitDraft(drafts, 'draft-fresh\u0000/w', '')['draft-fresh\u0000/w']).toBe('')
  })

  it('never mutates the record it is given', () => {
    const before: Record<string, string> = { 'draft-x\u0000/w': 'typed' }
    const after = withCommitDraft(before, 'draft-y\u0000/w', 'other')
    expect(before).toEqual({ 'draft-x\u0000/w': 'typed' })
    expect(after).toEqual({ 'draft-x\u0000/w': 'typed', 'draft-y\u0000/w': 'other' })
  })
})

describe('markdown pending anchors', () => {
  afterEach(() => { vi.useRealTimers() })

  it('sweeps the expired entries on every write, not only on a take', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    // Fifty fragments parked for documents the reader never opened: nothing
    // ever TAKES them, which is the only moment the TTL used to be checked.
    for (let index = 0; index < 50; index++) {
      rememberMarkdownAnchor('sweep-spec', '/w', `/w/f${index}.md`, `sec-${index}`)
    }
    expect(sweepPendingAnchors()).toBe(0)
    vi.setSystemTime(1_000 + 16_000)
    expect(sweepPendingAnchors()).toBe(50)

    // A second batch expires too — and the WRITE itself is what clears it, so
    // no expired entry is left behind for a manual sweep to find.
    for (let index = 0; index < 50; index++) {
      rememberMarkdownAnchor('sweep-spec', '/w', `/w/g${index}.md`, `sec-${index}`)
    }
    vi.setSystemTime(1_000 + 32_000)
    rememberMarkdownAnchor('sweep-spec', '/w', '/w/late.md', 'late')
    expect(sweepPendingAnchors()).toBe(0)

    // The TTL's own semantics are untouched: what was just parked is taken,
    // what was parked a minute ago is not.
    expect(takeMarkdownAnchor('sweep-spec', '/w', '/w/late.md')).toBe('late')
    rememberMarkdownAnchor('sweep-spec', '/w', '/w/stale.md', 'stale')
    vi.setSystemTime(1_000 + 60_000)
    expect(takeMarkdownAnchor('sweep-spec', '/w', '/w/stale.md')).toBeNull()
  })
})

describe('ops-stream session records', () => {
  /** The missed delta a returning session must still see (a settled write). */
  const MISSED: SidebarSessionEvent[] = [
    call(3, 'write', 'w2', { file_path: '/w/missed.ts', content: 'y' }),
    result(4, 'w2', 'wrote /w/missed.ts'),
  ]

  /** Mount one editor of `sessionId` and let its immediate pull settle. */
  async function mountProbe(sessionId: string, enabled = true) {
    const mounted = renderRoot(createElement(StreamProbe, { sessionId, enabled }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    return mounted
  }

  afterEach(() => {
    vi.useRealTimers()
    changesOps.mockReset()
    latestStream = null
  })

  it('keeps a parked session\'s cursor so the delta it missed is still published', async () => {
    vi.useFakeTimers()
    // The stream's own cursor rides `afterSeq`: pull #1 is the BASELINE (no
    // cursor yet — an absent `afterSeq` is what "from the very first event"
    // means, so a seq-0 event is not dropped; an unrelated, long-settled write
    // is published to nobody), and the pull after the parked period carries the
    // write the model did meanwhile.
    changesOps.mockImplementation(async (_scope: unknown, afterSeq?: number) => (
      afterSeq === undefined
        ? {
          events: [call(1, 'write', 'w1', { file_path: '/w/old.ts', content: 'x' }), result(2, 'w1', 'wrote')],
          lastSeq: 2,
        }
        : { events: MISSED, lastSeq: 4 }
    ))

    const parked = await mountProbe('rejoin')
    expect(changesOps).toHaveBeenCalledTimes(1)
    expect(changesOps.mock.calls.at(-1)?.[3]).toBe(false)
    // The baseline published nothing (the historical write is not a touch)…
    expect(latestStream?.revision).toBe(0)

    // …and while the tab is parked the poller stops, so nothing is pulled.
    parked.rerender(createElement(StreamProbe, { sessionId: 'rejoin', enabled: false }))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(changesOps).toHaveBeenCalledTimes(1)
    expect(latestStream?.revision).toBe(0)

    // Coming back resumes from the persisted cursor and folds what was missed:
    // the file the model rewrote while the tab was parked IS a touch, and the
    // primed stream asks the host to WAIT for the next event.
    parked.rerender(createElement(StreamProbe, { sessionId: 'rejoin', enabled: true }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(changesOps.mock.calls.at(-1)?.[1]).toBe(2)
    expect(changesOps.mock.calls.at(-1)?.[3]).toBe(true)
    expect(latestStream?.revision).toBe(1)
    expect(latestStream?.touched.get('/w/missed.ts')?.kind).toBe('write')
    parked.unmount()
  })

  it('re-baselines a session evicted past the record cap', async () => {
    vi.useFakeTimers()
    changesOps.mockImplementation(async (_scope: unknown, afterSeq?: number) => (
      afterSeq === undefined
        ? {
          events: [call(1, 'write', 'w1', { file_path: '/w/old.ts', content: 'x' }), result(2, 'w1', 'wrote')],
          lastSeq: 2,
        }
        : { events: MISSED, lastSeq: 4 }
    ))

    const parked = await mountProbe('cap-victim')
    parked.rerender(createElement(StreamProbe, { sessionId: 'cap-victim', enabled: false }))
    parked.unmount()

    // More sessions than the cap (32) join and leave: each one's record is
    // newest, so the oldest — the parked session above — is what goes.
    for (let index = 0; index < 32; index++) {
      const extra = await mountProbe(`cap-other-${index}`)
      extra.unmount()
    }

    // The evicted session re-joins as a FRESH stream: its first pull is a
    // baseline again (no cursor, no wait), so the delta it missed is
    // deliberately not published — the same state a page reload starts from.
    // Inside the cap the same scenario DOES publish (the case above).
    await mountProbe('cap-victim')
    expect(changesOps.mock.calls.at(-1)?.[1]).toBeUndefined()
    expect(changesOps.mock.calls.at(-1)?.[3]).toBe(false)
    expect(latestStream?.revision).toBe(0)
  })
})
