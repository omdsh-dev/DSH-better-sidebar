/**
 * Responsive multi-repository switcher in the Git lens (a workspace CONTAINER:
 * a project directory that is not itself a repository but holds several).
 *
 * Contract:
 * - The same discovered-root list renders as horizontal chips while every
 *   label fits on one line, and as one native <select> once it does not. The
 *   decision is content-driven (hidden natural-width measurement row), never a
 *   fixed viewport breakpoint; a hidden tab keeps the chips form.
 * - Chips and options share the display-only labels from
 *   buildRepositoryLabels(roots, scope.cwd, hostHome): deeper roots carry their
 *   relative parent, so same-named checkouts stay tellable apart.
 * - The selected value is the RESOLVED status root; both spellings of one
 *   checkout fold. When that root is no longer among the retained choices (the
 *   server fell back), it renders as a DISABLED stand-in with its own short
 *   label — never as a silent first option.
 * - Selecting a root re-pins the scope through the existing chooseRepo, so the
 *   next status read carries that root and the switcher survives the read.
 * - The ⋯ → Repository submenu keeps the same label list as the folded fallback.
 * - A single-repository workspace renders no switcher.
 */
// @vitest-environment jsdom
import { act } from 'react-dom/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { api, type GitStatusEntry, type GitStatusResult, type SessionScope } from '../src/client/api.ts'
import { GitLens } from '../src/client/changes/GitLens.tsx'
import type { SidebarDiffRef } from '../src/client/state.ts'
import { t } from '../src/client/locales.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()

const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')

/** Restore the real layout readers after a test that stubbed them. */
function restoreWidths(): void {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth
  if (originalClientWidth !== undefined) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  if (originalScrollWidth !== undefined) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth)
}

/** jsdom reports 0 for both; tests inject the row/content widths explicitly. */
function stubWidths(host: number, content: number): void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return this.hasAttribute('data-scm-repos') ? host : 0 },
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() { return this.hasAttribute('data-repo-measure') ? content : 0 },
  })
}

afterEach(() => { vi.restoreAllMocks(); restoreWidths() })

const CWD = 'C:/work'
const ADMIN = 'C:/work-admin'
const DOCS = 'C:/work-docs'
const DEEP_A = 'C:/work/pack/alpha'
const DEEP_B = 'C:/work/pack/beta'
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }

const chips = (container: HTMLElement): HTMLButtonElement[] =>
  [...container.querySelectorAll<HTMLButtonElement>('[data-scm-repos] [data-scm-repo]')]

const picker = (container: HTMLElement): HTMLSelectElement => {
  const node = container.querySelector<HTMLSelectElement>('[data-scm-repos] select[aria-label="' + t('gitRepository') + '"]')
  if (node === null) throw new Error('repository select missing')
  return node
}

const options = (node: HTMLSelectElement): HTMLOptionElement[] => [...node.options].filter(option => !option.disabled)

/** One container-workspace snapshot: the resolved root plus every discovered root. */
const snapshot = (root: string, repositories: string[], entries: GitStatusEntry[] = []): GitStatusResult =>
  ({ isRepo: true, branch: 'main', root, entries, repositories })

/** Mount the lens over a mocked host; scopes records every status request. */
async function mount(options: {
  sessionId: string
  repositories?: string[]
  resolvedRoot?: (scope: SessionScope) => string
  widths?: { host: number; content: number }
  entries?: GitStatusEntry[]
  onPreview?: (ref: SidebarDiffRef) => void
}) {
  if (options.widths !== undefined) stubWidths(options.widths.host, options.widths.content)
  const scopes: SessionScope[] = []
  const repositories = options.repositories ?? [CWD, ADMIN, DOCS]
  const resolvedRoot = options.resolvedRoot ?? (scope => scope.repoRoot ?? CWD)
  vi.spyOn(api, 'gitStatus').mockImplementation(async scope => {
    scopes.push(scope)
    return snapshot(resolvedRoot(scope), repositories, options.entries)
  })
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([{ path: CWD, branch: 'main', current: true, changes: 0 }])
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitCommitModel').mockResolvedValue({ pinned: false })
  vi.spyOn(api, 'gitGraph').mockResolvedValue({
    isRepo: true, root: CWD, entries: [], branches: [], hasMore: false, snapshot: 'one',
  })
  const view = renderRoot(
    <GitLens scope={{ sessionId: options.sessionId, cwd: CWD }} visible
      selectedRef={null} onOpenFile={() => {}} onPreview={options.onPreview ?? (() => {})} />,
  )
  await flush()
  await flush()
  return { ...view, scopes }
}

function openMoreSubmenu(container: HTMLElement, label: string): HTMLButtonElement[] {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="' + t('gitMoreActions') + '"]')
  if (trigger === null) throw new Error('More Actions button not found')
  act(() => { trigger.click() })
  const parent = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find(button => button.textContent?.trim() === label)
  if (parent === undefined) throw new Error('submenu parent not found: ' + label)
  act(() => { parent.click() })
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menu"][data-submenu-layout] button[role="menuitem"]')]
}

it('renders chips while the natural row fits and re-pins the scope', async () => {
  const view = await mount({ sessionId: 'scm-repos-wide', widths: { host: 600, content: 300 } })
  const buttons = chips(view.container)
  expect(buttons.map(button => button.dataset.scmRepo)).toEqual([CWD, ADMIN, DOCS])
  expect(buttons.map(button => button.textContent)).toEqual(['work', 'work-admin (C:\\)', 'work-docs (C:\\)'])
  expect(buttons.map(button => button.dataset.active)).toEqual(['true', undefined, undefined])
  expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true')
  expect(view.container.querySelector('[data-scm-repos] select')).toBeNull()

  await act(async () => { buttons[1]!.click() })
  await flush()
  await flush()

  // The click went through chooseRepo: the next status read targets that root.
  expect(view.scopes.at(-1)?.repoRoot).toBe(ADMIN)
  const after = chips(view.container)
  expect(after.map(button => button.dataset.active)).toEqual([undefined, 'true', undefined])
})

it('switches the same list to a native select when the row does not fit', async () => {
  const view = await mount({ sessionId: 'scm-repos-narrow', widths: { host: 120, content: 300 } })
  expect(chips(view.container)).toEqual([])
  const node = picker(view.container)
  expect(node.value).toBe(CWD)
  const caption = node.closest('[data-scm-repos]')!.querySelector('span')
  expect(caption?.textContent).toBe(t('gitRepository'))
  expect(options(node).map(option => option.textContent)).toEqual(['work', 'work-admin (C:\\)', 'work-docs (C:\\)'])

  await act(async () => { node.value = ADMIN; node.dispatchEvent(new Event('change', { bubbles: true })) })
  await flush()
  await flush()
  expect(view.scopes.at(-1)?.repoRoot).toBe(ADMIN)
  expect(picker(view.container).value).toBe(ADMIN)
})

it('folds separator, trailing slash and case when naming the current checkout', async () => {
  const view = await mount({ sessionId: 'scm-repos-spelling', repositories: ['C:\\WORK\\', ADMIN], widths: { host: 120, content: 300 } })
  expect(picker(view.container).value).toBe('C:\\WORK\\')
})

it('renders no switcher for a single-repository workspace', async () => {
  const view = await mount({ sessionId: 'scm-repos-single', repositories: [CWD] })
  expect(view.container.querySelector('[data-scm-repos]')).toBeNull()
  expect(view.container.querySelector('[data-scm-section="changes"]')).not.toBeNull()
})

it('labels deeper repositories with their relative parent', async () => {
  const view = await mount({ sessionId: 'scm-repos-labels', repositories: [CWD, DEEP_A, DEEP_B], widths: { host: 120, content: 300 } })
  expect(options(picker(view.container)).map(option => option.textContent))
    .toEqual(['work', 'alpha (pack)', 'beta (pack)'])
})

it('shares the same disambiguated labels with the More Repository submenu', async () => {
  const view = await mount({ sessionId: 'scm-repos-menu', repositories: [CWD, DEEP_A, DEEP_B] })
  expect(openMoreSubmenu(view.container, t('gitRepository')).map(item => item.textContent))
    .toEqual(['work', 'alpha (pack)', 'beta (pack)'])
})

it('shows the server-fallback root as a disabled stand-in, never as a silent first option', async () => {
  const FALLBACK = '/elsewhere/checkout'
  const view = await mount({
    sessionId: 'scm-repos-fallback',
    resolvedRoot: scope => scope.repoRoot === ADMIN ? FALLBACK : (scope.repoRoot ?? CWD),
    widths: { host: 120, content: 300 },
  })
  await act(async () => {
    const node = picker(view.container)
    node.value = ADMIN
    node.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
  await flush()
  const node = picker(view.container)
  expect(node.value).toBe(FALLBACK)
  const standIn = node.selectedOptions[0]!
  expect(standIn.disabled).toBe(true)
  expect(standIn.textContent).toBe('checkout (elsewhere)')
  expect(options(node).map(option => option.value)).toEqual([CWD, ADMIN, DOCS])
})

it('mints changed-file preview refs against the resolved child repository', async () => {
  // The session cwd is the CONTAINER, while the status row's path is relative
  // to the resolved child repository. The preview ref has to carry that root:
  // an untracked file has no `git diff`, so the diff pane falls back to
  // `fs.read`, and resolving its path against the session cwd reads outside
  // the repository (ENOENT, empty preview).
  const CHILD = 'C:/work/tasks-repo'
  const previews: SidebarDiffRef[] = []
  const view = await mount({
    sessionId: 'scm-repos-preview',
    repositories: [CHILD],
    resolvedRoot: () => CHILD,
    entries: [{ path: 'task/readme.md', xy: '??' }],
    onPreview: (ref) => { previews.push(ref) },
  })
  const row = view.container.querySelector<HTMLButtonElement>('button[data-path="task/readme.md"]')
  expect(row).not.toBeNull()
  await act(async () => { row!.click() })
  expect(previews).toEqual([{
    kind: 'worktree',
    path: 'task/readme.md',
    staged: false,
    untracked: true,
    // The primary checkout row is the container path itself; the repository
    // root is what an untracked file's fallback read must resolve against.
    worktree: CWD,
    repoRoot: CHILD,
  }])
})
