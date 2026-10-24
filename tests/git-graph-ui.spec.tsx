// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { api, SidebarApiError } from '../src/client/api.ts'
import { CommitDetails, messageBodyOf } from '../src/client/changes/CommitDetails.tsx'
import { GitGraphSection, type GitGraphSectionProps } from '../src/client/changes/GitGraphSection.tsx'
import { relativeTime, t } from '../src/client/locales.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
setupReactAct()
const entry = (hashFull: string, parents: string[] = []) => ({ hash: hashFull.slice(0, 7), hashFull, parents, subject: `subject ${hashFull}`, author: 'Author', date: '2026-01-01', refs: ['main'], message: 'Full commit message' })
const page = (hash = 'a', more = false) => ({ isRepo: true, root: '/repo', entries: [entry(hash)], branches: [{ ref: 'refs/heads/topic', name: 'topic', hashFull: hash }], hasMore: more, nextCursor: more ? 'opaque' : undefined, snapshot: 'snapshot' })
const defaults: GitGraphSectionProps = { scope: { sessionId: 'one', cwd: '/repo', repoRoot: '/repo' }, worktree: '/linked', visible: true, onPreview: () => {}, selectedRef: null }
const flush = async () => { await act(async () => { await Promise.resolve() }) }
function button(container: HTMLElement, text: string): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find(node => node.textContent === text)!
}
/** jsdom ships no IntersectionObserver, so the sentinel effect is inert there;
 *  these tests install a fake one on globalThis and restore the saved value. */
interface FakeObserver {
  callback: IntersectionObserverCallback
  options?: IntersectionObserverInit
  targets: Element[]
  disconnected: boolean
}
function installIntersectionObserver(): { observers: FakeObserver[]; restore: () => void } {
  const original = (globalThis as Record<string, unknown>).IntersectionObserver
  const observers: FakeObserver[] = []
  class FakeIntersectionObserver {
    root: Element | Document | null = null
    rootMargin = ''
    thresholds: number[] = []
    targets: Element[] = []
    disconnected = false
    constructor(public callback: IntersectionObserverCallback, public options?: IntersectionObserverInit) { observers.push(this) }
    observe(target: Element): void { this.targets.push(target) }
    unobserve(): void {}
    disconnect(): void { this.disconnected = true }
    takeRecords(): IntersectionObserverEntry[] { return [] }
  }
  ;(globalThis as Record<string, unknown>).IntersectionObserver = FakeIntersectionObserver
  return {
    observers,
    restore: () => {
      if (original === undefined) delete (globalThis as Record<string, unknown>).IntersectionObserver
      else (globalThis as Record<string, unknown>).IntersectionObserver = original
    },
  }
}
/** Deliver one intersection callback to `observer` the way the browser would. */
const intersect = async (observer: FakeObserver, isIntersecting = true): Promise<void> => {
  await act(async () => {
    observer.callback([{ isIntersecting } as IntersectionObserverEntry], observer as unknown as IntersectionObserver)
  })
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
describe('read-only graph', () => {
  it('loads only when visible and has no timer-driven requests', async () => {
    vi.useFakeTimers()
    const graph = vi.spyOn(api, 'gitGraph').mockResolvedValue(page())
    const mounted = renderRoot(createElement(GitGraphSection, { ...defaults, visible: false }))
    try {
      await flush(); expect(graph).not.toHaveBeenCalled()
      mounted.rerender(createElement(GitGraphSection, defaults)); await flush()
      expect(graph).toHaveBeenCalledTimes(1)
      await act(async () => { vi.advanceTimersByTime(120_000) })
      expect(graph).toHaveBeenCalledTimes(1)
    } finally { mounted.unmount() }
  })
  it('shows loading, error and retry rather than an empty-history lie', async () => {
    let reject!: (reason: Error) => void
    const graph = vi.spyOn(api, 'gitGraph').mockImplementationOnce(() => new Promise((_, no) => { reject = no })).mockResolvedValue(page())
    const mounted = renderRoot(createElement(GitGraphSection, defaults))
    try {
      expect(mounted.container.textContent).toContain(t('loading'))
      await act(async () => { reject(new Error('offline')) })
      expect(mounted.container.textContent).toContain('offline')
      expect(mounted.container.textContent).not.toContain(t('graphEmpty'))
      await act(async () => { button(mounted.container, t('retry')).click() })
      expect(graph).toHaveBeenCalledTimes(2)
      expect(mounted.container.textContent).toContain('subject a')
    } finally { mounted.unmount() }
  })
  it('filters full branch refs without checkout and pages with the opaque cursor', async () => {
    const graph = vi.spyOn(api, 'gitGraph').mockResolvedValueOnce(page('a', true)).mockResolvedValueOnce(page('b')).mockResolvedValue(page('c'))
    const checkout = vi.spyOn(api, 'gitCheckout')
    const clear = vi.fn()
    const preview = vi.fn()
    const mounted = renderRoot(createElement(GitGraphSection, { ...defaults, onPreview: preview, onClearPreview: clear }))
    try {
      await flush()
      await act(async () => { button(mounted.container, t('graphLoadMore')).click() })
      expect(graph.mock.calls[1]![1]?.cursor).toBe('opaque')
      expect(mounted.container.querySelectorAll('[data-graph-commit]')).toHaveLength(2)
      await act(async () => { mounted.container.querySelector<HTMLButtonElement>('[data-graph-commit]')!.click() })
      expect(preview).toHaveBeenCalledWith(expect.objectContaining({ kind: 'commit', worktree: '/linked', repoRoot: '/repo', hashFull: 'a' }))
      await act(async () => { const select = mounted.container.querySelector('select')!; select.value = 'refs/heads/topic'; select.dispatchEvent(new Event('change', { bubbles: true })) })
      expect(clear).toHaveBeenCalled()
      expect(graph.mock.calls.at(-1)![1]).toMatchObject({ branch: 'refs/heads/topic', cursor: undefined })
      expect(checkout).not.toHaveBeenCalled()
      expect(mounted.container.textContent).not.toContain('subject a')
    } finally { mounted.unmount() }
  })
  it('aborts hidden and old-session requests and ignores late answers', async () => {
    let resolve!: (value: ReturnType<typeof page>) => void
    const graph = vi.spyOn(api, 'gitGraph').mockImplementationOnce(() => new Promise(yes => { resolve = yes })).mockResolvedValue(page('new'))
    const mounted = renderRoot(createElement(GitGraphSection, defaults))
    try {
      const signal = graph.mock.calls[0]![3]!
      mounted.rerender(createElement(GitGraphSection, { ...defaults, visible: false }))
      expect(signal.aborted).toBe(true)
      mounted.rerender(createElement(GitGraphSection, { ...defaults, scope: { sessionId: 'two', cwd: '/other' } }))
      await flush()
      await act(async () => { resolve(page('old')) })
      expect(mounted.container.textContent).toContain('subject new')
      expect(mounted.container.textContent).not.toContain('subject old')
      expect(graph.mock.calls.at(-1)![0].sessionId).toBe('two')
    } finally { mounted.unmount() }
  })
  it('cancels an old branch request even when its transport delivers late', async () => {
    let resolve!: (value: ReturnType<typeof page>) => void
    const graph = vi.spyOn(api, 'gitGraph').mockResolvedValueOnce(page('a')).mockImplementationOnce(() => new Promise(yes => { resolve = yes })).mockResolvedValue(page('all'))
    const mounted = renderRoot(createElement(GitGraphSection, defaults))
    try {
      await flush()
      const change = async (value: string) => act(async () => { const select = mounted.container.querySelector('select')!; select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
      await change('refs/heads/topic')
      const signal = graph.mock.calls[1]![3]!
      await change('')
      expect(signal.aborted).toBe(true)
      await act(async () => { resolve(page('late-topic')) })
      expect(mounted.container.textContent).toContain('subject all')
      expect(mounted.container.textContent).not.toContain('late-topic')
    } finally { mounted.unmount() }
  })

  it('clears an absent commit preview after refresh but preserves a surviving selection', async () => {
    vi.spyOn(api, 'gitGraph').mockResolvedValueOnce(page('a')).mockResolvedValueOnce(page('a')).mockResolvedValueOnce(page('b'))
    const clear = vi.fn()
    const props: GitGraphSectionProps = { ...defaults, onClearPreview: clear, selectedRef: { kind: 'commit', hash: 'a', hashFull: 'a', subject: 'subject a', repoRoot: '/repo', worktree: '/linked' } }
    const mounted = renderRoot(createElement(GitGraphSection, props))
    try {
      await flush()
      mounted.rerender(createElement(GitGraphSection, { ...props, refreshTick: 1 })); await flush()
      expect(clear).not.toHaveBeenCalled()
      mounted.rerender(createElement(GitGraphSection, { ...props, refreshTick: 2 })); await flush()
      expect(clear).toHaveBeenCalledTimes(1)
    } finally { mounted.unmount() }
  })

  it('refreshes from the beginning after a stale cursor', async () => {
    const graph = vi.spyOn(api, 'gitGraph').mockResolvedValueOnce(page('a', true)).mockRejectedValueOnce(new SidebarApiError('graph-stale', 'changed')).mockResolvedValue(page('fresh'))
    const mounted = renderRoot(createElement(GitGraphSection, defaults))
    try {
      await flush()
      await act(async () => { button(mounted.container, t('graphLoadMore')).click() })
      expect(mounted.container.textContent).toContain(t('graphStale'))
      await act(async () => { button(mounted.container, t('retry')).click() })
      expect(graph.mock.calls.at(-1)![1]?.cursor).toBeUndefined()
      expect(mounted.container.textContent).not.toContain('subject a')
    } finally { mounted.unmount() }
  })
})

/** The restyle deleted the `graphReadOnly` copy key (and the toolbar hint the
 *  select's tooltip used to carry) from every dictionary, so it can no longer
 *  be read back through `t()` — the two released wordings are pinned literally
 *  instead. zh is included because which one renders depends on the locale. */
const REMOVED_READ_ONLY_HINTS = ['Filters only — never switches branches', '仅筛选，不切换分支']
/** The merge note the details card used to carry (`graphFirstParent`) was
 *  deleted from every dictionary, so it can no longer be read back through
 *  `t()` — the two released wordings are pinned literally instead (zh is
 *  included because which one would render depends on the locale). */
const REMOVED_MERGE_NOTES = ['Merge diff compared with the first parent', '合并提交的差异与第一个父提交比较']
/** Real 40-char SHA-1 shapes (git's own length): the details card's hash chip
 *  renders the full hash while the row and the parent chips carry 7 chars, so a
 *  fixture that is one char too long would let a truncation bug hide. */
const HASH_A = 'aaaaaaa111111111111111111111111111111111'
const HASH_B = 'bbbbbbb222222222222222222222222222222222'
const HASH_C = 'ccccccc333333333333333333333333333333333'
type GraphEntry = ReturnType<typeof entry>
type GraphPage = Awaited<ReturnType<typeof api.gitGraph>>
/** `entry()` with the per-test refs (and optionally the parent list) filled in:
 *  the shared fixture always answers `refs: ['main']`, while the tone and
 *  colour cases need to control exactly which names a row carries. */
const commit = (hashFull: string, refs: string[], parents: string[] = []): GraphEntry => ({ ...entry(hashFull, parents), refs })
/** A page of hand-built rows; `page()` carries only one synthetic commit. */
const graphPage = (entries: GraphEntry[], branches: GraphPage['branches'] = []): GraphPage => ({ isRepo: true, root: '/repo', entries, branches, hasMore: false, nextCursor: undefined, snapshot: 'snapshot' })
const dialog = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[role="dialog"]')

describe('graph toolbar', () => {
  it('carries ONLY the branch select — no hints, no legend, no extra actions', async () => {
    // The legend was removed outright: a colour says "a different line", not
    // "a unique branch" (lanes outlive the branches that opened them), so a
    // colour legend answers a question nobody should be asking — the ref
    // pills on the rows are the only branch key, the convention every graph
    // tool shares. The three released wordings are pinned literally because
    // the keys no longer exist to be read back through `t()`.
    const REMOVED_LEGEND = ['Branch colors', '分支颜色说明', 'Colors follow the line, not the branch', '颜色跟随连线，不跟随分支', 'No branches loaded', '暂无分支']
    vi.spyOn(api, 'gitGraph').mockResolvedValue(graphPage([], [{ ref: 'refs/heads/topic', name: 'topic', hashFull: HASH_A }]))
    const mounted = renderRoot(createElement(GitGraphSection, defaults))
    try {
      await flush()
      const select = mounted.container.querySelector<HTMLSelectElement>(`select[aria-label="${t('graphBranchFilter')}"]`)!
      expect(select).not.toBeNull()
      expect([...select.options].map(option => option.textContent)).toEqual([t('graphAllBranches'), 'topic'])
      const toolbar = select.parentElement!
      // The select is the toolbar's ONLY interactive control — a re-added
      // hint, legend trigger or action has to fail here.
      expect([...toolbar.querySelectorAll('select, button, input, textarea, a[href], [role="button"]')]).toEqual([select])
      for (const hint of REMOVED_READ_ONLY_HINTS) expect(mounted.container.textContent).not.toContain(hint)
      for (const wording of REMOVED_LEGEND) expect(mounted.container.textContent).not.toContain(wording)
      // The old select tooltip carried the removed read-only copy.
      expect(select.getAttribute('title')).toBeNull()
      // Nothing in the lens opens a floating card on hover any more …
      await act(async () => { toolbar.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null })) })
      expect(dialog()).toBeNull()
    } finally { mounted.unmount() }
  })

  it('still reports an empty repository without any legend affordance', async () => {
    vi.spyOn(api, 'gitGraph').mockResolvedValue(graphPage([]))
    const mounted = renderRoot(createElement(GitGraphSection, defaults))
    try {
      await flush()
      expect(mounted.container.textContent).toContain(t('graphEmpty'))
      expect(mounted.container.querySelector('button')).toBeNull()
    } finally { mounted.unmount() }
  })

  it('folds HEAD into the current branch pill and tones remotes apart from locals', async () => {
    // Entries carry the SHORT names the component renders; only the branch
    // inventory holds the full refs, and it is what marks a name as remote.
    const branches = [
      { ref: 'refs/heads/topic', name: 'topic', hashFull: HASH_A },
      { ref: 'refs/remotes/origin/main', name: 'origin/main', hashFull: HASH_A },
    ]
    const rows = [
      commit(HASH_A, ['HEAD', 'origin/main', 'topic']),
      // A DETACHED head has no local branch to fold into: only then does the
      // HEAD pill render standalone, still carrying the current marker.
      commit(HASH_B, ['HEAD', 'origin/main'], [HASH_A]),
    ]
    vi.spyOn(api, 'gitGraph').mockResolvedValue(graphPage(rows, branches))
    const mounted = renderRoot(createElement(GitGraphSection, defaults))
    try {
      await flush()
      const row = mounted.container.querySelector<HTMLElement>(`[data-graph-commit="${HASH_A}"]`)!
      const pills = [...row.querySelectorAll<HTMLElement>('[data-tone]')]
      // `data-tone` is the component's paint contract (graph.module.css maps
      // remote to the muted rung and head to the emphasised one) — jsdom loads
      // no stylesheet, so the tone attribute is what a spec can observe.
      expect(pills.map(pill => [pill.textContent, pill.getAttribute('data-tone'), pill.getAttribute('data-current')])).toEqual([
        ['origin/main', 'remote', null],
        ['topic', 'head', 'true'],
      ])
      // The current branch's pill carries TWO glyphs — the check, then the
      // branch icon; a remote pill carries just the globe. Both wear the
      // row's lane colour (slot 0 on the first tip, slot 1 on the second).
      expect(pills[1]!.querySelectorAll('svg')).toHaveLength(2)
      expect(pills[0]!.querySelectorAll('svg')).toHaveLength(1)
      expect(pills.map(pill => pill.getAttribute('data-color'))).toEqual(['0', '0'])
      const detached = mounted.container.querySelector<HTMLElement>(`[data-graph-commit="${HASH_B}"]`)!
      const detachedPills = [...detached.querySelectorAll<HTMLElement>('[data-tone]')]
      expect(detachedPills.map(pill => [pill.textContent, pill.getAttribute('data-tone'), pill.getAttribute('data-current')])).toEqual([
        ['HEAD', 'head', 'true'],
        ['origin/main', 'remote', null],
      ])
      expect(detachedPills.map(pill => pill.getAttribute('data-color'))).toEqual(['1', '1'])
    } finally { mounted.unmount() }
  })
})

describe('graph commit rows and details', () => {
  it('lays a commit row out as ONE line: rail, ref pills, then the subject', async () => {
    // The GitLens-style picture: no hash chip and no author·time on the row —
    // those live in the details card and the hover card (tested below), which
    // is also why the row carries NO native tooltip any more.
    const date = new Date(Date.now() - 5.5 * 60_000).toISOString()
    const row = { ...entry(HASH_A), subject: 'Fix the flaky test', author: 'Ada Lovelace', date, refs: ['main'] }
    vi.spyOn(api, 'gitGraph').mockResolvedValue(graphPage([row]))
    const mounted = renderRoot(createElement(GitGraphSection, defaults))
    try {
      await flush()
      const rowNode = mounted.container.querySelector<HTMLElement>(`[data-graph-commit="${HASH_A}"]`)!
      // Exactly three cells on one line: the rail svg, the pills, the subject.
      expect(rowNode.children).toHaveLength(3)
      expect(rowNode.children[0]!.tagName.toLowerCase()).toBe('svg')
      const pills = [...rowNode.querySelectorAll<HTMLElement>('[data-tone]')]
      expect(pills.map(pill => [pill.textContent, pill.getAttribute('data-tone')])).toEqual([['main', 'local']])
      expect(pills[0]!.querySelectorAll('svg')).toHaveLength(1)
      const subject = rowNode.children[2] as HTMLElement
      expect(subject.textContent).toBe('Fix the flaky test')
      expect(subject.className).toContain('subject')
      // The row says nothing about hash or author any more …
      expect(rowNode.textContent).not.toContain(HASH_A.slice(0, 7))
      expect(rowNode.textContent).not.toContain('Ada Lovelace')
      expect(rowNode.textContent).not.toContain(relativeTime(date))
      // … and the browser's own tooltip is gone: the hover card replaced it.
      expect(rowNode.getAttribute('title')).toBeNull()
    } finally { mounted.unmount() }
  })

  it('opens a medium-density hover card after a dwell and closes it on leave', async () => {
    // The information ladder: row < hover card < details card. The card shows
    // the author, both times and the SHORT hash — never the full one, which
    // belongs to the details pane alone.
    vi.useFakeTimers()
    const date = new Date(Date.now() - 5.5 * 60_000).toISOString()
    const row = { ...entry(HASH_A), subject: 'Fix the flaky test', author: 'Ada Lovelace', date, refs: ['main'] }
    vi.spyOn(api, 'gitGraph').mockResolvedValue(graphPage([row]))
    const mounted = renderRoot(createElement(GitGraphSection, defaults))
    try {
      await flush()
      const rowNode = mounted.container.querySelector<HTMLElement>(`[data-graph-commit="${HASH_A}"]`)!
      // A passing pointer opens nothing: the dwell has to elapse first.
      await act(async () => { rowNode.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      await act(async () => { vi.advanceTimersByTime(349) })
      expect(dialog()).toBeNull()
      await act(async () => { vi.advanceTimersByTime(1) })
      const card = dialog()
      expect(card).not.toBeNull()
      expect(card!.textContent).toContain('Fix the flaky test')
      expect(card!.textContent).toContain('Ada Lovelace')
      expect(card!.textContent).toContain(relativeTime(date))
      expect(card!.textContent).toContain(HASH_A.slice(0, 7))
      expect(card!.textContent).not.toContain(HASH_A)
      // The pill inside the card wears the row's lane colour.
      const pill = card!.querySelector<HTMLElement>('[data-tone]')!
      expect(pill.textContent).toBe('main')
      expect(pill.getAttribute('data-color')).toBe(rowNode.querySelector('circle')!.getAttribute('data-color'))
      // Leaving the row closes the card.
      await act(async () => { rowNode.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
      expect(dialog()).toBeNull()
    } finally { mounted.unmount() }
  })

  it('renders the commit card for a single-parent commit with a markdown body and no merge note', async () => {
    // The card moved out of the lens into `CommitDetails` (the changes tab now
    // hosts it in its bottom pane's `details` tab), so it is asserted where it
    // lives: rendered directly with the graph page's entry for the selection.
    // `renderRoot` keeps the div-detached cycle; nothing here fetches.
    const message = 'Fix the flaky test\n\n## Retry loop\n\n- bullet'
    const selected = { ...entry(HASH_A, [HASH_B]), subject: 'Fix the flaky test', author: 'Ada Lovelace', message }
    const mounted = renderRoot(createElement(CommitDetails, { entry: selected }))
    try {
      const details = mounted.container.querySelector<HTMLElement>(`section[aria-label="${t('graphDetails')}"]`)!
      expect(details).not.toBeNull()
      // The header is the section's accessible name only: the pane's tab
      // already says "commit details", so the card draws no band repeating it.
      expect(details.getAttribute('aria-label')).toBe(t('graphDetails'))
      expect(details.textContent).not.toContain(t('graphDetails'))
      expect(details.querySelector('strong')!.textContent).toBe('Fix the flaky test')
      const codes = [...details.querySelectorAll('code')]
      // The hash chip is the FULL 40-char hash, not the row's 7-char label.
      const chip = codes.find(code => code.getAttribute('title') === null)!
      expect(chip.textContent).toBe(HASH_A)
      expect(chip.textContent).toHaveLength(40)
      // Parent chips are truncated to 7 chars, the full hash riding the title.
      const parents = codes.filter(code => code.getAttribute('title') !== null)
      expect(parents.map(code => [code.textContent, code.getAttribute('title')])).toEqual([[HASH_B.slice(0, 7), HASH_B]])
      // The message renders as MARKDOWN in its own block — a heading and a list,
      // not a <pre>. The raw body's first line is the subject the title above
      // already shows, so the split dropped it: the card never duplicates it.
      const body = details.querySelector<HTMLElement>('[class*="messageBody"]')!
      expect(body).not.toBeNull()
      expect(body.querySelector('h2')!.textContent).toContain('Retry loop')
      expect(body.querySelector('li')!.textContent).toContain('bullet')
      expect(body.textContent).not.toContain('Fix the flaky test')
      expect(details.querySelector('pre')).toBeNull()
      // One parent only — no first-parent note, and its copy is gone entirely.
      expect(details.querySelector('[class*="hint"]')).toBeNull()
      for (const note of REMOVED_MERGE_NOTES) expect(details.textContent).not.toContain(note)
    } finally { mounted.unmount() }
  })

  it("shows the merge commit's parents and no explanatory note", async () => {
    const merge = { ...entry(HASH_A, [HASH_B, HASH_C]), subject: 'Merge topic', message: 'Merge topic\n\nMerge branch topic' }
    const mounted = renderRoot(createElement(CommitDetails, { entry: merge }))
    try {
      const details = mounted.container.querySelector<HTMLElement>(`section[aria-label="${t('graphDetails')}"]`)!
      const parents = [...details.querySelectorAll('code[title]')]
      expect(parents.map(code => code.getAttribute('title'))).toEqual([HASH_B, HASH_C])
      expect(parents.map(code => code.textContent)).toEqual([HASH_B.slice(0, 7), HASH_C.slice(0, 7)])
      // The parents are all the card says about a merge: the old first-parent
      // hint line is gone, so no hint element and none of the released
      // wordings can reappear.
      expect(details.querySelector('[class*="hint"]')).toBeNull()
      for (const note of REMOVED_MERGE_NOTES) expect(details.textContent).not.toContain(note)
    } finally { mounted.unmount() }
  })

  it('splits the raw body on a first line equal to the subject, else renders it whole', async () => {
    // (a) `git log %B` repeats the subject as its first line: the card shows
    // that line once (as its title), so the body must drop it.
    const withSubjectLine = { ...entry(HASH_A), subject: 'Fix the flaky test', message: 'Fix the flaky test\n\n## Retry loop\n\n- bullet' }
    expect(messageBodyOf(withSubjectLine)).toBe('## Retry loop\n\n- bullet')
    // (b) A first line that is NOT the subject is real content and survives
    // whole — dropping it would silently lose a line.
    const withOwnHeadline = { ...entry(HASH_B), subject: 'Rename helper', message: '# Old title\n\n- kept line' }
    expect(messageBodyOf(withOwnHeadline)).toBe('# Old title\n\n- kept line')
    // (c) Nothing left after the split → the card renders no message block.
    const subjectOnly = { ...entry(HASH_C), subject: 'Only a subject', message: 'Only a subject' }
    expect(messageBodyOf(subjectOnly)).toBe('')

    // The split is what the DOM renders: branch (b) keeps its own headline as
    // a heading, branch (c) renders no block at all.
    const mounted = renderRoot(createElement('div', null,
      createElement(CommitDetails, { entry: withOwnHeadline }),
      createElement(CommitDetails, { entry: subjectOnly }),
    ))
    try {
      const [kept, empty] = [...mounted.container.querySelectorAll<HTMLElement>('section')]
      expect(kept!.querySelector('h1')!.textContent).toContain('Old title')
      expect(kept!.querySelector('li')!.textContent).toContain('kept line')
      expect(empty!.querySelector('[class*="messageBody"]')).toBeNull()
    } finally { mounted.unmount() }
  })

  it('tones the card\'s pills the same way the rows do, HEAD folded into the current branch', async () => {
    // The lens owns the branch inventory that tells a remote name apart from a
    // local one; the card can only paint it because the selection carries the
    // set. Rendering the same entry WITHOUT `remotes` flips `origin/main` to
    // `local`, so the assertion pins the prop is really consumed.
    const selected = commit(HASH_A, ['HEAD', 'origin/main', 'topic'])
    const mounted = renderRoot(createElement(CommitDetails, {
      entry: selected, remotes: new Set(['origin/main']), slot: 3,
    }))
    try {
      const details = mounted.container.querySelector<HTMLElement>(`section[aria-label="${t('graphDetails')}"]`)!
      const pills = [...details.querySelectorAll<HTMLElement>('[data-tone]')]
      expect(pills.map(pill => [pill.textContent, pill.getAttribute('data-tone'), pill.getAttribute('data-current')])).toEqual([
        ['origin/main', 'remote', null],
        ['topic', 'head', 'true'],
      ])
      // The current branch's pill opens with the check glyph, and the pills
      // wear the lane colour the lens reported for the selected row.
      expect(pills[1]!.querySelectorAll('svg')).toHaveLength(2)
      expect(pills.map(pill => pill.getAttribute('data-color'))).toEqual(['3', '3'])
    } finally { mounted.unmount() }
  })
})

describe('graph end-sentinel auto-load', () => {
  it('appends one page with the opaque cursor when the sentinel intersects', async () => {
    const graph = vi.spyOn(api, 'gitGraph').mockResolvedValueOnce(page('a', true)).mockResolvedValue(page('b'))
    const io = installIntersectionObserver()
    const mounted = renderRoot(createElement(GitGraphSection, defaults))
    try {
      await flush()
      const observer = io.observers[0]!
      const sentinel = mounted.container.querySelector('[data-graph-sentinel]')
      expect(sentinel).not.toBeNull()
      expect(observer.targets).toEqual([sentinel])
      expect(observer.options?.root).toBe(mounted.container.querySelector('[aria-busy]'))
      expect(observer.options?.rootMargin).toBe('200px')
      await intersect(observer)
      await flush()
      expect(graph).toHaveBeenCalledTimes(2)
      expect(graph.mock.calls[1]![1]?.cursor).toBe('opaque')
      expect(mounted.container.querySelectorAll('[data-graph-commit]')).toHaveLength(2)
      expect(mounted.container.textContent).toContain('subject b')
    } finally { mounted.unmount(); io.restore() }
  })
  it('ignores a second intersection while an append is already in flight', async () => {
    let resolveAppend!: (value: ReturnType<typeof page>) => void
    const graph = vi.spyOn(api, 'gitGraph').mockResolvedValueOnce(page('a', true)).mockImplementationOnce(() => new Promise(yes => { resolveAppend = yes })).mockResolvedValue(page('c'))
    const io = installIntersectionObserver()
    const mounted = renderRoot(createElement(GitGraphSection, defaults))
    try {
      await flush()
      const observer = io.observers[0]!
      await intersect(observer)
      await flush()
      expect(graph).toHaveBeenCalledTimes(2)
      await intersect(observer)
      await flush()
      expect(graph).toHaveBeenCalledTimes(2)
      await act(async () => { resolveAppend(page('b')) })
      await flush()
      expect(graph.mock.calls.map(call => call[1]?.cursor)).toEqual([undefined, 'opaque'])
      expect(mounted.container.querySelectorAll('[data-graph-commit]')).toHaveLength(2)
    } finally { mounted.unmount(); io.restore() }
  })
  it('never arms auto-load without a next page or while the lens is hidden', async () => {
    const graph = vi.spyOn(api, 'gitGraph').mockResolvedValueOnce(page('a')).mockResolvedValueOnce(page('b', true)).mockResolvedValue(page('c'))
    const io = installIntersectionObserver()
    const exhausted = renderRoot(createElement(GitGraphSection, defaults))
    try {
      await flush()
      expect(graph).toHaveBeenCalledTimes(1)
      expect(exhausted.container.querySelector('[data-graph-sentinel]')).toBeNull()
      expect(io.observers).toHaveLength(0)
    } finally { exhausted.unmount() }
    const hidden = renderRoot(createElement(GitGraphSection, defaults))
    try {
      await flush()
      expect(io.observers).toHaveLength(1)
      hidden.rerender(createElement(GitGraphSection, { ...defaults, visible: false }))
      await flush()
      expect(io.observers).toHaveLength(1)
      expect(io.observers[0]!.disconnected).toBe(true)
      await intersect(io.observers[0]!)
      await flush()
      expect(graph).toHaveBeenCalledTimes(2)
      expect(graph.mock.calls.every(call => call[1]?.cursor === undefined)).toBe(true)
    } finally { hidden.unmount(); io.restore() }
  })
})
