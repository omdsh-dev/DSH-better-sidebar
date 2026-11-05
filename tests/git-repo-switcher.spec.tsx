/**
 * Multi-repository picker in the Git lens (a workspace CONTAINER, i.e. a
 * project directory that is not itself a repository but holds several).
 *
 * Contract:
 * - `git.status` reports `repositories` (every discovered root). When it holds
 *   more than one, the lens renders a labeled <select> ("Repository") above
 *   the Changes section: each option pairs the display-only disambiguation
 *   label (`buildRepositoryLabels(roots, scope.cwd, hostHome)` — deeper roots
 *   carry their relative parent, so same-named checkouts stay tellable apart)
 *   with its absolute root as the value. The ⋯ → Repository submenu shares the
 *   same label list.
 * - The picker's value is the RESOLVED status root, and both spellings of one
 *   checkout fold (forward/back slashes, trailing separator, Windows case).
 *   When that root is no longer among the retained choices (the server fell
 *   back), it renders as a DISABLED stand-in option with its own short label —
 *   the stale request or the first option is never silently presented as the
 *   selection.
 * - Changing the picker re-pins the scope through the same `chooseRepo` the
 *   submenu uses, so the next status read carries that root and the picker
 *   survives the following read (a selected child still reports the full
 *   `repositories` list).
 * - A single-repository workspace renders NO picker: the row must not steal
 *   vertical space from the ordinary case.
 */
// @vitest-environment jsdom
import { act } from 'react-dom/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { api, type GitStatusResult, type SessionScope } from '../src/client/api.ts'
import { GitLens } from '../src/client/changes/GitLens.tsx'
import { t } from '../src/client/locales.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()
afterEach(() => { vi.restoreAllMocks() })

const CWD = 'C:/work'
const ADMIN = 'C:/work-admin'
const DOCS = 'C:/work-docs'
const DEEP_A = 'C:/work/pack/alpha'
const DEEP_B = 'C:/work/pack/beta'
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }
const picker = (container: HTMLElement): HTMLSelectElement => {
  const node = container.querySelector<HTMLSelectElement>(`[data-scm-repos] select[aria-label="${t('gitRepository')}"]`)
  if (node === null) throw new Error('repository picker missing')
  return node
}
const options = (node: HTMLSelectElement): HTMLOptionElement[] => [...node.options].filter(option => !option.disabled)

/** One container-workspace snapshot: the resolved root plus every discovered root. */
const snapshot = (root: string, repositories: string[]): GitStatusResult =>
  ({ isRepo: true, branch: 'main', root, entries: [], repositories })

/** Mount the lens over a mocked host; `scopes` records every status request. */
async function mount(options: { sessionId: string; repositories?: string[]; resolvedRoot?: (scope: SessionScope) => string }) {
  const scopes: SessionScope[] = []
  const repositories = options.repositories ?? [CWD, ADMIN, DOCS]
  const resolvedRoot = options.resolvedRoot ?? (scope => scope.repoRoot ?? CWD)
  vi.spyOn(api, 'gitStatus').mockImplementation(async scope => {
    scopes.push(scope)
    return snapshot(resolvedRoot(scope), repositories)
  })
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([{ path: CWD, branch: 'main', current: true, changes: 0 }])
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitCommitModel').mockResolvedValue({ pinned: false })
  vi.spyOn(api, 'gitGraph').mockResolvedValue({
    isRepo: true, root: CWD, entries: [], branches: [], hasMore: false, snapshot: 'one',
  })
  const view = renderRoot(
    <GitLens scope={{ sessionId: options.sessionId, cwd: CWD }} store={createSidebarStore()} visible
      selectedRef={null} onOpenFile={() => {}} onPreview={() => {}} />,
  )
  await flush()
  await flush()
  return { ...view, scopes }
}

it('lists every discovered repository and re-pins the scope through the picker', async () => {
  const view = await mount({ sessionId: 'scm-repos-multi' })
  const node = picker(view.container)
  expect(options(node).map(option => option.value)).toEqual([CWD, ADMIN, DOCS])
  // Siblings outside the session cwd's directory carry their parent context;
  // the base itself stays short.
  expect(options(node).map(option => option.textContent)).toEqual(['work', 'work-admin (C:\\)', 'work-docs (C:\\)'])
  expect(node.value).toBe(CWD)

  await act(async () => { node.value = ADMIN; node.dispatchEvent(new Event('change', { bubbles: true })) })
  await flush()
  await flush()

  // The change went through `chooseRepo`: the next status read targets that root...
  expect(view.scopes.at(-1)?.repoRoot).toBe(ADMIN)
  // ...and the picker survives the following snapshot, still listing all roots.
  expect(picker(view.container).value).toBe(ADMIN)
  expect(options(picker(view.container)).map(option => option.value)).toEqual([CWD, ADMIN, DOCS])
})

it('folds separator, trailing slash and case when naming the current checkout', async () => {
  // The status snapshot reports the git spelling (`C:/work`); the retained
  // option may be `C:\WORK\`. Both name the same checkout, so the picker
  // selects the original spelling instead of falling to the first option.
  const view = await mount({ sessionId: 'scm-repos-spelling', repositories: ['C:\\WORK\\', ADMIN] })
  expect(picker(view.container).value).toBe('C:\\WORK\\')
})

it('renders no picker for a single-repository workspace', async () => {
  const view = await mount({ sessionId: 'scm-repos-single', repositories: [CWD] })
  expect(view.container.querySelector('[data-scm-repos]')).toBeNull()
  // The ordinary panel is intact: the Changes section is still there.
  expect(view.container.querySelector('[data-scm-section="changes"]')).not.toBeNull()
})

it('labels deeper repositories with their relative parent and shares the list with the menu', async () => {
  const view = await mount({ sessionId: 'scm-repos-labels', repositories: [CWD, DEEP_A, DEEP_B] })
  expect(options(picker(view.container)).map(option => option.textContent))
    .toEqual(['work', 'alpha (pack)', 'beta (pack)'])
  // The ⋯ → Repository submenu reads the same label list.
  act(() => { view.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('gitMoreActions')}"]`)!.click() })
  const parent = [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
    .find(button => button.textContent?.trim() === t('gitRepository'))
  expect(parent).not.toBeUndefined()
  act(() => { parent!.click() })
  const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menu"] button[role="menuitem"]')]
  expect(items.map(item => item.textContent)).toEqual(['work', 'alpha (pack)', 'beta (pack)'])
})

it('shows the server-fallback root as a disabled stand-in, never as a silent first option', async () => {
  // Picking ADMIN while the server resolves it to a checkout outside the
  // retained list: the picker must name THAT root (short label, disabled), not
  // quietly select the first option or keep the stale request.
  const FALLBACK = '/elsewhere/checkout'
  const view = await mount({
    sessionId: 'scm-repos-fallback',
    resolvedRoot: scope => scope.repoRoot === ADMIN ? FALLBACK : (scope.repoRoot ?? CWD),
  })
  await act(async () => {
    const node = picker(view.container)
    node.value = ADMIN
    node.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
  await flush()
  // A scope change resets the status slot, so the picker remounts; re-query.
  const node = picker(view.container)
  expect(node.value).toBe(FALLBACK)
  const standIn = node.selectedOptions[0]!
  expect(standIn.disabled).toBe(true)
  expect(standIn.textContent).toBe('checkout (elsewhere)')
  expect(options(node).map(option => option.value)).toEqual([CWD, ADMIN, DOCS])
})
