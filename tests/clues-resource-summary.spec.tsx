/**
 * Shared resource metadata header (S9 refresh).
 *
 * Contract:
 * - ResourceSummary is a quiet two-line header: an identity line (number,
 *   author, change counts, and due/path/size for non-forge sources; the state
 *   only when it is informative) plus one facts line (CI verdict, review,
 *   mergeability, branch tail). The repository prefix never repeats here - the
 *   source scope bar names it;
 * - colour is a scarce signal: nothing is filled or capped. A semantic colour
 *   appears only on the CI verdict glyph, or on the word of a destructive fact.
 *   A healthy request stays monochrome;
 * - a statically open/active resource is NOT in flight: it gets no dot at all,
 *   and no surface ever animates a resting state;
 * - the header takes an optional action seat (actions) so a detail window can
 *   keep Refresh and the original-source link without a toolbar band;
 * - a person falls back to handle/id instead of disappearing when no name is
 *   available;
 * - ResourceInlineMeta is the one-line list variant (state, number, author,
 *   due, CI verdict). It never grows a second line and never shows branches -
 *   the widest field, kept for the header;
 * - merging metadata is last-writer-wins per field, with counts/branches
 *   merged member-wise so a read snapshot does not drop earlier list data;
 * - a detail read that carries individual checks adds ONE collapsed line
 *   ("Failing 2 · 8 checks") over a failures-first list of provider names, each
 *   with its own state dot and, when the provider offered one, an outbound
 *   link. The list row never grows it.
 */
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderRoot, setupReactAct } from './test-utils.ts'
import {
  ResourceInlineMeta,
  ResourceSummary,
  branchesLabel,
  formatSize,
  mergeResourceInfo,
  numberLabel,
  personLabel,
  type ClueResourceInfo,
} from '../src/client/clues/resource-summary.tsx'

setupReactAct()

beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

const FULL: ClueResourceInfo = {
  state: 'merged',
  number: 12,
  repository: 'acme/widgets',
  author: { id: 'u-1' },
  assignees: [{ name: 'Ada Lovelace' }, { handle: 'grace' }],
  followers: [{ id: 'f-1' }],
  labels: ['bug', 'ui'],
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-02T10:30:00.000Z',
  completedAt: '2026-10-03T11:00:00.000Z',
  start: { at: '2026-10-04T08:00:00.000Z', allDay: true },
  due: { at: '2026-10-05T18:00:00.000Z' },
  branches: { head: 'feat/x', base: 'main', headRepository: 'fork' },
  counts: { comments: 2, commits: 3, changedFiles: 4, additions: 5, deletions: 6 },
  sizeBytes: 2048,
  path: 'src/a.ts',
}

function rendered(info: ClueResourceInfo | undefined) {
  return renderRoot(createElement(ResourceSummary, { info }))
}

describe('ResourceSummary', () => {
  it('keeps the issue number visible alongside status in compact source rows', () => {
    const view = renderRoot(createElement(ResourceInlineMeta, { info: { state: 'open', repository: 'acme/demo', number: 42 } }))
    expect(view.container.textContent).toContain('#42')
    // The scope bar above the list already names the repository.
    expect(view.container.textContent).not.toContain('demo')
    view.unmount()
  })

  it('shows task completion even when no other metadata exists', () => {
    const view = rendered({ state: 'completed' })
    expect(view.container.querySelector('[data-clue-resource-state-chip="completed"]')?.textContent).toBe('Completed')
    view.unmount()
  })

  it('renders the compact identity line and leaves secondary fields out', () => {
    const view = rendered(FULL)
    const summary = view.container.querySelector<HTMLElement>('[data-clue-resource-summary]')!
    expect(summary).not.toBeNull()
    expect(summary.dataset.clueResourceState).toBe('merged')
    expect(summary.dataset.clueResourceNumber).toBe('12')
    expect(summary.dataset.clueResourceRepository).toBe('acme/widgets')
    expect(summary.querySelector<HTMLElement>('[data-clue-resource-item="number"]')?.textContent).toBe('#12')
    // No name: the provider id is still useful, not an empty cell.
    expect(summary.querySelector<HTMLElement>('[data-clue-resource-item="author"]')?.textContent).toContain('u-1')
    expect(summary.querySelector<HTMLElement>('[data-clue-resource-item="changes"]')?.textContent).toContain('+5')
    expect(summary.querySelector<HTMLElement>('[data-clue-resource-item="changes"]')?.textContent).toContain('−6')
    expect(summary.querySelector<HTMLElement>('[data-clue-resource-item="size"]')?.textContent).toContain('2.0 KB')
    expect(summary.querySelector<HTMLElement>('[data-clue-resource-item="path"]')?.textContent).toContain('src/a.ts')
    // Branches live on the facts line, never on the identity line.
    expect(summary.querySelector<HTMLElement>('[data-clue-resource-item="branches"]')?.textContent).toBe('feat/x → main')
    expect(summary.querySelector('[data-clue-change-request]')?.contains(summary.querySelector('[data-clue-resource-item="branches"]'))).toBe(true)
    // Secondary fields stay out of the preview header: no chips, no disclosure.
    for (const key of ['assignees', 'followers', 'labels', 'created', 'updated', 'completed', 'start', 'comments', 'commits', 'files', 'repository']) {
      expect(summary.querySelector('[data-clue-resource-item="' + key + '"]')).toBeNull()
    }
    expect(summary.querySelector('[data-clue-resource-details]')).toBeNull()
    expect(summary.textContent).not.toContain('Ada Lovelace')
    expect(summary.textContent).not.toContain('bug, ui')
    view.unmount()
  })

  it('drops a resting state from both surfaces: open is the list default, not news', () => {
    for (const state of ['open', 'active'] as const) {
      const summary = rendered({ state, number: 7 })
      expect(summary.container.querySelector('[data-clue-resource-state-chip]')).toBeNull()
      summary.unmount()
      const row = renderRoot(createElement(ResourceInlineMeta, { info: { state, number: 7 } }))
      expect(row.container.querySelector('[data-clue-resource-inline-state]')).toBeNull()
      row.unmount()
    }
  })

  it('renders no running spinner for a resting state', () => {
    // The host ongoing StateDot is an animated ring. A statically open pull
    // request is not in flight, so a list of them must stay still.
    const view = renderRoot(createElement(ResourceInlineMeta, {
      info: { state: 'active', number: 1, repository: 'o/r', checks: 'success' },
    }))
    expect(view.container.querySelector('[data-clue-resource-inline-state]')).toBeNull()
    view.unmount()
  })

  it('renders nothing when the snapshot is absent or has no displayable field', () => {
    const absent = rendered(undefined)
    expect(absent.container.textContent).toBe('')
    absent.unmount()
    const empty = rendered({})
    expect(empty.container.textContent).toBe('')
    empty.unmount()
  })

  it('renders nothing without a snapshot and without actions', () => {
    const view = renderRoot(createElement(ResourceSummary, {}))
    expect(view.container.textContent).toBe('')
    view.unmount()
  })

  it('seats the window actions inside the header, after the metadata', () => {
    const view = renderRoot(createElement(ResourceSummary, {
      info: { state: 'open', number: 7 },
      actions: createElement('button', { 'data-test-action': '' }, 'Refresh'),
    }))
    const summary = view.container.querySelector<HTMLElement>('[data-clue-resource-summary]')!
    const action = summary.querySelector<HTMLElement>('[data-test-action]')!
    expect(action.textContent).toBe('Refresh')
    // The action sits in its own seat, not inside the metadata block.
    const body = summary.firstElementChild!
    expect(body.contains(action)).toBe(false)
    view.unmount()
  })

  it('shows a header that carries only actions when no resource fact is known', () => {
    const view = renderRoot(createElement(ResourceSummary, { info: {}, actions: createElement('button', null, 'act') }))
    expect(view.container.querySelector('[data-clue-resource-summary]')).not.toBeNull()
    view.unmount()
  })

  it('does not add a title or a repository when the source did not supply one', () => {
    const view = rendered({ state: 'completed', author: { name: 'Ada' } })
    const summary = view.container.querySelector('[data-clue-resource-summary]')!
    expect(summary.querySelector('h1, h2, h3')).toBeNull()
    expect(summary.querySelector('[data-clue-resource-item="number"]')).toBeNull()
    expect(summary.querySelector('[data-clue-resource-item="repository"]')).toBeNull()
    expect(summary.textContent).toContain('Ada')
    view.unmount()
  })

  it('escapes source strings instead of rendering markup', () => {
    const view = rendered({ path: '<img src=x onerror=1>', author: { name: '<script>alert(1)</script>' } })
    expect(view.container.querySelector('script')).toBeNull()
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.textContent).toContain('<script>alert(1)</script>')
    expect(view.container.textContent).toContain('<img src=x onerror=1>')
    view.unmount()
  })

  it('lists individual checks failures-first behind one quiet disclosure', () => {
    const view = rendered({
      state: 'open',
      number: 7,
      checks: 'failure',
      checkRuns: [
        { name: 'build', state: 'success' },
        { name: 'lint', state: 'failure', url: 'https://ci.example/lint' },
        { name: 'docs', state: 'pending' },
        { name: 'audit', state: 'error' },
      ],
    })
    const details = view.container.querySelector<HTMLDetailsElement>('details[data-clue-check-list]')
    expect(details).not.toBeNull()
    expect(details?.dataset.clueCheckList).toBe('4')
    // The individual jobs are detail: the header states them, it does not open
    // by itself and it never grows past one line until asked.
    expect(details?.open).toBe(false)
    expect(details?.querySelector('summary')?.textContent).toBe('Failing 2 · 4 checks')
    const rows = [...details!.querySelectorAll('li')]
    expect(rows.map(row => row.dataset.clueCheck)).toEqual(['failure', 'error', 'pending', 'success'])
    const link = details!.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://ci.example/lint')
    expect(link?.getAttribute('target')).toBe('_blank')
    // A check without a provider link is plain text, never a dead anchor.
    expect(rows[1]?.querySelector('a')).toBeNull()
    view.unmount()
  })

  it('keeps the disclosure out of a healthy header without checks', () => {
    const view = rendered({ state: 'open', number: 7, checks: 'success' })
    expect(view.container.querySelector('details[data-clue-check-list]')).toBeNull()
    view.unmount()
  })

  it('never grows the one-line list row with individual checks', () => {
    const view = renderRoot(createElement(ResourceInlineMeta, {
      info: { state: 'open', number: 7, checkRuns: [{ name: 'build', state: 'success' }] },
    }))
    expect(view.container.querySelector('details')).toBeNull()
    expect(view.container.querySelectorAll('li')).toHaveLength(0)
    view.unmount()
  })
})

describe('ResourceInlineMeta', () => {
  it('leaves assignees and followers out of the quiet row', () => {
    const view = renderRoot(createElement(ResourceInlineMeta, { info: { state: 'completed', assignees: [{ name: 'Owner' }], followers: [{ id: 'f-1' }] } }))
    expect(view.container.querySelector('[data-clue-resource-inline-assignees]')).toBeNull()
    expect(view.container.querySelector('[data-clue-resource-inline-followers]')).toBeNull()
    expect(view.container.textContent).not.toContain('Owner')
    view.unmount()
  })

  it('renders only the compact state/number/author/due/CI row', () => {
    const view = renderRoot(createElement(ResourceInlineMeta, { info: FULL }))
    const inline = view.container.querySelector<HTMLElement>('[data-clue-resource-inline]')!
    expect(inline.dataset.clueResourceState).toBe('merged')
    const state = inline.querySelector<HTMLElement>('[data-clue-resource-inline-state]')!
    expect(state.getAttribute('aria-label')).toBe('Merged')
    expect(state.textContent).toBe('Merged')
    expect(inline.querySelector('[data-clue-resource-inline-author]')?.textContent).toBe('u-1')
    expect(inline.querySelector('[data-clue-resource-inline-due]')).not.toBeNull()
    expect(inline.querySelector('[data-clue-resource-inline-identity]')?.textContent).toBe('#12')
    // The parent supplies the subtitle row; this component adds no extra line
    // and no branch (the widest field belongs to the header).
    expect(inline.querySelector('[data-clue-resource-inline-branches]')).toBeNull()
    expect(inline.textContent).not.toContain('feat/x')
    view.unmount()
  })

  it('marks a failing rollup in the row: a coloured glyph plus the word', () => {
    const view = renderRoot(createElement(ResourceInlineMeta, {
      info: { state: 'open', number: 1, repository: 'o/r', checks: 'failure' },
    }))
    const ci = view.container.querySelector<HTMLElement>('[data-clue-resource-inline-checks] [data-checks]')!
    expect(ci.dataset.checks).toBe('failure')
    expect(ci.dataset.ink).toBe('error')
    expect(ci.textContent).toContain('Failing')
    expect(ci.getAttribute('aria-label')).toBe('CI: Failing')
    view.unmount()
  })

  it('marks a passing rollup with a dot only: the word would repeat on every row', () => {
    const view = renderRoot(createElement(ResourceInlineMeta, {
      info: { state: 'open', number: 1, repository: 'o/r', checks: 'success', author: { name: 'Ada' } },
    }))
    const ci = view.container.querySelector<HTMLElement>('[data-clue-resource-inline-checks="success"]')!
    expect(ci).not.toBeNull()
    // The dot still separates "passing" from "no CI reported"; the word does not
    // repeat down a list where most rows pass. The accessible name keeps it.
    expect(ci.textContent).toBe('')
    expect(ci.querySelector('[data-checks]')!.getAttribute('aria-label')).toBe('CI: Passed')
    expect(view.container.textContent).not.toContain('Passed')
    // The row itself still renders its other facts.
    expect(view.container.textContent).toContain('#1')
    expect(view.container.textContent).toContain('Ada')
    view.unmount()
  })

  it('marks a running rollup in the row: the reader is waiting on it', () => {
    const view = renderRoot(createElement(ResourceInlineMeta, {
      info: { state: 'open', number: 1, repository: 'o/r', checks: 'pending' },
    }))
    expect(view.container.querySelector<HTMLElement>('[data-clue-resource-inline-checks]')!
      .dataset.clueResourceInlineChecks).toBe('pending')
    view.unmount()
  })

  it('renders nothing for an empty snapshot', () => {
    const view = renderRoot(createElement(ResourceInlineMeta, { info: {} }))
    expect(view.container.textContent).toBe('')
    view.unmount()
  })
})

describe('metadata projections', () => {
  it('falls back through name -> handle -> id', () => {
    expect(personLabel({ name: 'Ada', handle: 'ada', id: 'u1' })).toBe('Ada')
    expect(personLabel({ handle: 'ada', id: 'u1' })).toBe('@ada')
    expect(personLabel({ id: 'u1' })).toBe('u1')
    expect(personLabel(undefined)).toBeUndefined()
  })

  it('derives only the labels the provider actually supplied', () => {
    // A number names itself; the repository prefix is the scope bar job.
    expect(numberLabel({ repository: 'o/r', number: 7 })).toBe('#7')
    expect(numberLabel({ repository: 'o/r' })).toBe('o/r')
    expect(numberLabel({ number: 7 })).toBe('#7')
    expect(numberLabel({})).toBeUndefined()
    // Repository qualifiers on a branch are a fork owner: noise here.
    expect(branchesLabel({ head: 'feat/x', base: 'main', headRepository: 'fork' })).toBe('feat/x → main')
    expect(branchesLabel({ head: 'feat/x' })).toBe('feat/x')
    expect(branchesLabel({ base: 'main' })).toBeUndefined()
    expect(branchesLabel({})).toBeUndefined()
    expect(branchesLabel(undefined)).toBeUndefined()
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2.0 KB')
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('merges later snapshots over earlier ones, member-wise for counts/branches', () => {
    const merged = mergeResourceInfo(
      { repository: 'o/r', counts: { comments: 1, commits: 2 }, branches: { head: 'feat/x' } },
      { number: 9, counts: { comments: 4 }, branches: { base: 'main' } },
      undefined,
    )
    expect(merged).toEqual({
      repository: 'o/r',
      number: 9,
      counts: { comments: 4, commits: 2 },
      branches: { head: 'feat/x', base: 'main' },
    })
    expect(mergeResourceInfo(undefined, undefined)).toBeUndefined()
  })

  it('shows CI, review and merge on one facts line, colouring only the destructive ones', () => {
    const view = rendered({
      state: 'open', number: 7, repository: 'acme/widgets',
      checks: 'failure', review: 'changes-requested', mergeable: 'conflicting',
    })
    try {
      const line = view.container.querySelector<HTMLElement>('[data-clue-change-request]')!
      expect(line).not.toBeNull()
      const facts = [...line.querySelectorAll<HTMLElement>('[data-clue-change-request-fact]')]
      expect(facts.map(fact => fact.dataset.clueChangeRequestFact)).toEqual(['checks', 'review', 'merge'])
      expect(facts[0]!.textContent).toContain('Failing')
      expect(facts[0]!.querySelector<HTMLElement>('[data-checks]')!.dataset.ink).toBe('error')
      expect(facts[1]!.textContent).toBe('Changes requested')
      expect(facts[1]!.dataset.ink).toBe('error')
      expect(facts[2]!.textContent).toBe('Conflicts')
      expect(facts[2]!.dataset.ink).toBe('error')
      expect(line.querySelector('[data-clue-change-request-row]')).toBeNull()
    } finally {
      view.unmount()
    }
  })

  it('keeps a healthy request monochrome and says only what is gated', () => {
    const view = rendered({ state: 'open', number: 7, checks: 'success', review: 'approved', mergeable: 'mergeable' })
    try {
      const facts = [...view.container.querySelectorAll<HTMLElement>('[data-clue-change-request-fact]')]
      // Mergeable is the default, so it is silent; approval is the one gate worth a word.
      expect(facts.map(fact => fact.dataset.clueChangeRequestFact)).toEqual(['checks', 'review'])
      expect(facts[0]!.textContent).toContain('Passed')
      const verdict = facts[0]!.querySelector<HTMLElement>('[data-checks]')!
      expect(verdict.dataset.checks).toBe('success')
      // Healthy facts carry no ink attribute at all: the CSS keeps them tertiary.
      expect(verdict.dataset.ink).toBeUndefined()
      expect(facts[1]!.textContent).toBe('Approved')
      expect(facts[1]!.dataset.ink).toBeUndefined()
    } finally {
      view.unmount()
    }
  })

  it('stays silent on a default: review-required and an uncomputed mergeability are not facts', () => {
    const view = rendered({ state: 'open', number: 7, checks: 'pending', review: 'review-required', mergeable: 'unknown' })
    try {
      const facts = [...view.container.querySelectorAll<HTMLElement>('[data-clue-change-request-fact]')]
      // GitHub reports UNKNOWN while it is still computing; that is a transient, not news.
      expect(facts.map(fact => fact.dataset.clueChangeRequestFact)).toEqual(['checks'])
      expect(facts[0]!.textContent).toContain('Running')
      expect(facts[0]!.querySelector<HTMLElement>('[data-checks]')!.dataset.checks).toBe('pending')
    } finally {
      view.unmount()
    }
  })

  it('omits the facts line when no change-request fact was reported', () => {
    const view = rendered({ state: 'merged', number: 7, repository: 'acme/widgets' })
    try {
      expect(view.container.querySelector('[data-clue-change-request]')).toBeNull()
    } finally {
      view.unmount()
    }
  })
})
