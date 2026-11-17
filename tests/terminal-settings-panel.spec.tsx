/**
 * The terminal card's settings panel (src/client/TerminalSettingsPanel.tsx).
 *
 * Four contracts, in the order a deployment can break them:
 *
 * 1. THE DEFAULT SHELL OFFERS WHAT THE HOST CAN LAUNCH. Its rows come from
 *    `webTerminals.launchShells` — the host's own discovery — and never from
 *    the configured candidate list: a picker that offers a shell the host
 *    cannot spawn would only produce a selection that gets refused. It also
 *    always STATES a value: the stored name when the host still discovers it,
 *    otherwise the host's own current choice, because a shell is always in
 *    effect and a blank row would misrepresent it.
 * 2. THE CANDIDATE LIST IS THE HOST'S, not ours. Every mutation goes over
 *    `/sidebar/api/terminal.shells.update` and the answer's view replaces local
 *    state — the panel never predicts the resulting array, so a profile whose
 *    write is normalized elsewhere still shows what the host now reads. A
 *    candidate typed as a PATH shows its short label AND the stored value: the
 *    user has to be able to check which of the two they entered.
 * 3. THE BOX'S BROWSER is the paste-or-browse way in (`ShellPathPicker`): the
 *    dialog keeps an editable box (pasting a path stays first class) and lists
 *    the session's directories underneath.
 * 4. A DEPLOYMENT WITHOUT THE SERVICE still gets a usable panel, and the two
 *    settings fail INDEPENDENTLY: no config editor leaves the candidate half
 *    explained away while the default picker keeps reading discovery, and no
 *    terminal service leaves the default row explained while the candidate
 *    list keeps working.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSettingsPanelProps } from '../src/client/TerminalSettingsPanel.tsx'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { setupReactAct, renderRoot } from './test-utils.ts'
import { api } from '../src/client/api.ts'
import { t } from '../src/client/locales.ts'
import type { Context } from '../src/context-types.ts'
import type { SidebarSettingsRenderProps } from '../src/client/service.ts'
import { DEFAULT_SHELL_KEY, storedDefaultShell, TerminalSettingsPanel } from '../src/client/TerminalSettingsPanel.tsx'
import { DEFAULT_SHELL_CANDIDATES, type ShellCandidateView } from '../src/terminal-shells.ts'
import type { HostShellCatalog } from '../src/client/terminal-client.ts'

setupReactAct()

const VIEW: ShellCandidateView = {
  native: [...DEFAULT_SHELL_CANDIDATES],
  custom: ['nu', 'elvish'],
  documentPath: '/home/u/.dsh/profiles/web/cordis.patch.yml',
}

/** What a host on this machine actually discovers on Windows. */
const CATALOG: HostShellCatalog = {
  shells: [
    { path: 'C:\\WINDOWS\\system32\\cmd.exe', name: 'cmd.exe', args: [] },
    { path: 'C:\\Program Files\\Git\\bin\\bash.exe', name: 'bash.exe', args: ['-i'] },
    { path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', name: 'pwsh.exe', args: ['-NoLogo'] },
  ],
  selectedShell: 'C:\\Program Files\\Git\\bin\\bash.exe',
}

/** A client context carrying only what the panel probes. */
/** A client context carrying the two services the panel probes: the terminal
 *  catalog and the native seat's mounted-session feed (the panel reads its
 *  session from the seat, NOT from the store — that is the regression). */
function ctxWithCatalog(catalog: HostShellCatalog | null, sessionId: string | undefined): Context {
  return {
    get: (name: string) => {
      if (name === 'webTerminals' && catalog !== null) {
        return {
          view: () => null,
          close: () => {},
          recover: async () => [],
          launchShells: async (): Promise<HostShellCatalog> => catalog,
          selectShell: () => {},
        }
      }
      if (name === 'sidebarRight') {
        return { mounted: { getSnapshot: () => sessionId, subscribe: () => () => {} } }
      }
      return undefined
    },
  } as unknown as Context
}

/** The store face the panel reads its session id from. */
function storeWith(sessionId: string | undefined): { getSnapshot: () => { sessionId: string | undefined } } {
  return { getSnapshot: () => ({ sessionId }) }
}

interface MountOptions {
  view?: ShellCandidateView | null
  /** `null` = this deployment has no terminal service. */
  catalog?: HostShellCatalog | null
  /** `undefined` = the descriptor handed no context at all. */
  withCtx?: boolean
  /**
   * `true` mounts with NO active session. Distinct from `sessionId: undefined`,
   * which is indistinguishable from "use the default" in an options object and
   * would silently mount a session anyway.
   */
  noSession?: boolean
  sessionId?: string
}

/** Mount the panel with the candidate read and the shell discovery pinned. */
async function mount(
  pluginSettings: Record<string, unknown> = {},
  options: MountOptions = {},
): Promise<{ container: HTMLElement; writes: Array<[string, unknown]>; closes: () => number; unmount: () => void }> {
  vi.spyOn(api, 'terminalShells').mockResolvedValue(options.view === undefined ? VIEW : options.view)
  const writes: Array<[string, unknown]> = []
  let closed = 0
  const catalog = options.catalog === undefined ? CATALOG : options.catalog
  const sid = options.noSession === true ? undefined : options.sessionId ?? 's1'
  const rendered = renderRoot(createElement(TerminalSettingsPanel, {
    store: storeWith(sid) as never,
    service: {} as never,
    prefs: {} as never,
    pluginSettings,
    updatePluginSetting: (key: string, value: unknown) => { writes.push([key, value]) },
    close: () => { closed += 1 },
    ...(options.withCtx === false ? {} : { terminalCtx: ctxWithCatalog(catalog, sid) }),
  } satisfies SidebarSettingsRenderProps))
  // Three rounds: mount, the candidate read, the shell discovery.
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return {
    container: rendered.container,
    writes,
    closes: () => closed,
    unmount: rendered.unmount,
  }
}

/** The default-shell trigger (the only `.picker` button). */
function picker(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[class*="picker"]')
  if (button === null) throw new Error('the default-shell trigger is missing')
  return button
}

/** The portalled menu rows. */
function menuRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')]
}

/** The add-candidate text box inside the PANEL (not the dialog's). */
function addInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]')
  if (input === null) throw new Error('the add-candidate input is missing')
  return input
}

/** Replace the add-candidate draft the way typing does. */
async function type(container: HTMLElement, text: string): Promise<void> {
  const input = addInput(container)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Every aria-label on a button inside the panel. */
function labels(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
    .map(button => button.getAttribute('aria-label') ?? '')
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const element of document.querySelectorAll('body > div')) element.remove()
})

describe('terminal settings: the stored default shell', () => {
  it('reads a name back and treats an empty string as unset', () => {
    expect(storedDefaultShell({ [DEFAULT_SHELL_KEY]: 'bash' })).toBe('bash')
    // An empty string is "no default", NOT a name: the picker then falls back
    // to whatever the host itself would start.
    expect(storedDefaultShell({ [DEFAULT_SHELL_KEY]: '' })).toBeUndefined()
    expect(storedDefaultShell({})).toBeUndefined()
    expect(storedDefaultShell({ [DEFAULT_SHELL_KEY]: 7 })).toBeUndefined()
  })
})

describe('terminal settings: the default-shell picker', () => {
  it('offers ONLY the shells the host discovered, in discovery order', async () => {
    const { container, unmount } = await mount()
    try {
      await act(async () => { picker(container).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      // The candidate list mentions zsh / fish / powershell, none of which this
      // host can launch: offering them would produce a refused selection.
      expect(menuRows().map(row => row.textContent)).toEqual(['cmd', 'bash', 'pwsh'])
    } finally { unmount() }
  })

  it('shows the host default when nothing is stored, never a blank row', async () => {
    // `CATALOG.selectedShell` is bash, so an unset preference reads as bash —
    // a shell is always in effect and the row has to say which.
    const { container, unmount } = await mount()
    try {
      expect(picker(container).textContent).toBe('bash')
    } finally { unmount() }
  })

  it('prefers the stored name when the host still discovers it', async () => {
    const { container, unmount } = await mount({ [DEFAULT_SHELL_KEY]: 'cmd' })
    try {
      expect(picker(container).textContent).toBe('cmd')
    } finally { unmount() }
  })

  it('matches a stored path or short alias to the shell it names', async () => {
    // A stored value can arrive as a path (the user typed one into the
    // candidate box) or as the switcher's `pwsh` alias; both name a discovered
    // shell and must read as selected rather than as a fallback.
    const asPath = await mount({ [DEFAULT_SHELL_KEY]: 'C:\\Program Files\\Git\\bin\\bash.exe' })
    try {
      expect(picker(asPath.container).textContent).toBe('bash')
    } finally { asPath.unmount() }

    const asAlias = await mount({ [DEFAULT_SHELL_KEY]: 'pwsh' })
    try {
      // The stored alias resolves to pwsh.exe, whose own short name is `pwsh`.
      expect(picker(asAlias.container).textContent).toBe('pwsh')
    } finally { asAlias.unmount() }
  })

  it('falls back to the host default when the stored shell is no longer discovered', async () => {
    const { container, unmount } = await mount({ [DEFAULT_SHELL_KEY]: 'nu' })
    try {
      expect(picker(container).textContent).toBe('bash')
    } finally { unmount() }
  })

  it('writes the picked NAME, not the host path', async () => {
    const { container, writes, unmount } = await mount()
    try {
      await act(async () => { picker(container).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const row = menuRows().find(candidate => candidate.textContent === 'cmd')
      expect(row).toBeDefined()
      await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      // A NAME survives the binary moving between machines/versions; the view
      // re-resolves it against discovery on every launch.
      expect(writes).toEqual([[DEFAULT_SHELL_KEY, 'cmd']])
    } finally { unmount() }
  })
})

describe('terminal settings: the candidate list', () => {
  it('renders natives as read-only chips, with a remove control only on customs', async () => {
    const { container, unmount } = await mount()
    try {
      const native = [...container.querySelectorAll<HTMLElement>('[title]')]
        .filter(chip => chip.textContent !== null && DEFAULT_SHELL_CANDIDATES.includes(chip.textContent.trim()))
      expect(native.map(chip => chip.textContent?.trim())).toEqual([...DEFAULT_SHELL_CANDIDATES])
      // No remove button inside a native chip: hiding a host default is not on offer.
      for (const chip of native) expect(chip.querySelector('button')).toBeNull()

      expect(labels(container)).toContain(`${t('terminalCandidateRemove')} nu`)
      expect(labels(container)).toContain(`${t('terminalCandidateRemove')} elvish`)
    } finally { unmount() }
  })

  it('adds a trimmed name over the route and adopts the answer', async () => {
    const next: ShellCandidateView = { ...VIEW, custom: ['nu', 'elvish', 'xonsh'] }
    const update = vi.spyOn(api, 'terminalShellsUpdate').mockResolvedValue(next)
    const { container, unmount } = await mount()
    try {
      const input = addInput(container)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, '  xonsh  ')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`button[aria-label="${t('terminalCandidateAdd')}"]`)!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(update).toHaveBeenCalledWith('addCandidate', 'xonsh')
      // The rendered list is the ANSWER's, not a locally predicted one.
      expect(container.textContent).toContain('xonsh')
      expect(addInput(container).value, 'the draft is cleared on success').toBe('')
    } finally { unmount() }
  })

  it('shows BOTH the short label and the stored path', async () => {
    // A path candidate has two identities the user needs at once: the label the
    // switcher will show, and the string the host will try to launch.
    const withPath: ShellCandidateView = {
      ...VIEW,
      custom: ['/usr/local/bin/nu', 'C:\\Program Files\\elvish\\elvish.exe'],
    }
    const { container, unmount } = await mount({}, { view: withPath })
    try {
      const text = container.textContent ?? ''
      expect(text).toContain('nu')
      expect(text, 'the stored path stays readable').toContain('/usr/local/bin/nu')
      expect(text).toContain('C:\\Program Files\\elvish\\elvish.exe')
      // The remove control still names the FULL value, so the route gets back
      // exactly what was written.
      expect(labels(container)).toContain(`${t('terminalCandidateRemove')} /usr/local/bin/nu`)
    } finally { unmount() }
  })

  it('previews the label a typed path will get', async () => {
    const { container, unmount } = await mount()
    try {
      // No preview while the draft is still a bare name: nothing changes.
      await type(container, 'nu')
      expect(container.querySelector('[data-dsh-terminal-label-preview]')).toBeNull()
      await type(container, 'C:\\Apps\\nu.exe')
      expect(container.querySelector('[data-dsh-terminal-label-preview]')?.textContent)
        .toBe(t('terminalCandidateLabelPreview', { name: 'nu' }))
    } finally { unmount() }
  })

  it('starts another entry without writing anything', async () => {
    // The list is an array: committing one candidate must not close the door on
    // the next, and "add another" is not a write of its own.
    const update = vi.spyOn(api, 'terminalShellsUpdate')
    const { container, unmount } = await mount()
    try {
      await type(container, 'xonsh')
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`button[aria-label="${t('terminalCandidateAddMore')}"]`)!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(update).not.toHaveBeenCalled()
      expect(addInput(container).value, 'the box is cleared for the next shell').toBe('')
    } finally { unmount() }
  })

  it('removes a custom name over the route', async () => {
    const next: ShellCandidateView = { ...VIEW, custom: ['elvish'] }
    const update = vi.spyOn(api, 'terminalShellsUpdate').mockResolvedValue(next)
    const { container, unmount } = await mount()
    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`button[aria-label="${t('terminalCandidateRemove')} nu"]`)!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(update).toHaveBeenCalledWith('removeCandidate', 'nu')
      // The remove controls ARE the custom names, one-to-one: after the write
      // the only one left names the surviving custom candidate.
      expect(labels(container).filter(label => label.startsWith(t('terminalCandidateRemove'))))
        .toEqual([`${t('terminalCandidateRemove')} elvish`])
    } finally { unmount() }
  })

  it('surfaces a refused write as an alert without dropping the list', async () => {
    vi.spyOn(api, 'terminalShellsUpdate').mockRejectedValue(new Error('"bash" is a built-in candidate and cannot be removed'))
    const { container, unmount } = await mount()
    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`button[aria-label="${t('terminalCandidateRemove')} nu"]`)!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('built-in candidate')
      // The last known list survives a failed write.
      expect(container.textContent).toContain('elvish')
    } finally { unmount() }
  })

  it('does not dispatch an empty draft', async () => {
    const update = vi.spyOn(api, 'terminalShellsUpdate')
    const { container, unmount } = await mount()
    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`button[aria-label="${t('terminalCandidateAdd')}"]`)!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(update).not.toHaveBeenCalled()
    } finally { unmount() }
  })
})

describe('terminal settings: the candidate box browser', () => {
  it('opens a dialog that can paste a path and confirm it as-is', async () => {
    const update = vi.spyOn(api, 'terminalShellsUpdate').mockResolvedValue(VIEW)
    vi.spyOn(api, 'fsTree').mockResolvedValue({ path: '/w', entries: [], truncated: false })
    const { container, unmount } = await mount()
    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`button[aria-label="${t('terminalCandidateBrowse')}"]`)!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      const dialog = document.querySelector('[data-dsh-shell-path-picker]')
      expect(dialog, 'the browser dialog is mounted').not.toBeNull()
      // The address row is crumb buttons by default; clicking its empty tail
      // switches it into a text input.
      await act(async () => {
        dialog!.querySelector<HTMLElement>('[data-dsh-path-edit]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      const box = dialog!.querySelector<HTMLInputElement>('input[type="text"]')!
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(box, 'C:\\Apps\\nu.exe')
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent === t('terminalCandidateBrowseConfirm'))!
      await act(async () => { confirm.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      // A pasted path is taken verbatim: the dialog's whole point is that it
      // needs no click-through.
      expect(update).toHaveBeenCalledWith('addCandidate', 'C:\\Apps\\nu.exe')
    } finally { unmount() }
  })

  it('lists the session directory and navigates into it', async () => {
    const tree = vi.spyOn(api, 'fsTree').mockResolvedValue({
      path: '/w',
      entries: [
        { name: 'bin', path: '/w/bin', isDir: true, hidden: false, isSymlink: false, broken: false },
        { name: 'notes.txt', path: '/w/notes.txt', isDir: false, hidden: false, isSymlink: false, broken: false },
      ],
      truncated: false,
    })
    const { container, unmount } = await mount()
    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`button[aria-label="${t('terminalCandidateBrowse')}"]`)!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => { await Promise.resolve() })
      const rows = [...document.querySelectorAll('[data-dsh-shell-path-picker] [role="option"]')]
      // Directories navigate; a plain `.txt` is not a launchable program and is
      // therefore not offered as a candidate.
      expect(rows.map(row => row.textContent)).toEqual(['bin'])
      await act(async () => { rows[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(tree).toHaveBeenCalledWith({ sessionId: 's1' }, '/w/bin', undefined)
    } finally { unmount() }
  })

  it('navigates from the location bar on Enter instead of committing it', async () => {
    // The regression: Enter in a native dialog's address bar opens that
    // location. Wiring it to `commit` made the box unusable as a locator — it
    // wrote the raw text into the candidate list and closed the dialog.
    const update = vi.spyOn(api, 'terminalShellsUpdate')
    const tree = vi.spyOn(api, 'fsTree').mockResolvedValue({
      path: '/w/bin',
      entries: [],
      truncated: false,
    })
    const { container, unmount } = await mount()
    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`button[aria-label="${t('terminalCandidateBrowse')}"]`)!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => { await Promise.resolve() })
      // Switch the crumb row into its editable text form first.
      await act(async () => {
        document.querySelector<HTMLElement>('[data-dsh-path-edit]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      const box = document.querySelector<HTMLInputElement>('[data-dsh-shell-path-picker] input[type="text"]')!
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(box, '/w/bin')
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      await act(async () => { await Promise.resolve() })
      // Enter navigated the LIST to the typed directory …
      expect(tree).toHaveBeenCalledWith({ sessionId: 's1' }, '/w/bin', undefined)
      // … and did NOT write anything or close the dialog.
      expect(update).not.toHaveBeenCalled()
      expect(document.querySelector('[data-dsh-shell-path-picker]')).not.toBeNull()
    } finally { unmount() }
  })

  it('keeps the box usable when there is no active session', async () => {
    vi.spyOn(api, 'terminalShellsUpdate').mockResolvedValue(VIEW)
    const { container, unmount } = await mount({}, { noSession: true })
    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`button[aria-label="${t('terminalCandidateBrowse')}"]`)!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      const dialog = document.querySelector('[data-dsh-shell-path-picker]')!
      // No scope means no browsing — but pasting still works, so the dialog
      // says which half is unavailable instead of refusing to open.
      expect(dialog.textContent).toContain(t('terminalCandidateBrowseUnavailable'))
      expect(dialog.querySelector('input[type="text"]')).not.toBeNull()
    } finally { unmount() }
  })
})

describe('terminal settings: the breadcrumb address bar', () => {
  async function openPicker(container: HTMLElement): Promise<HTMLElement> {
    await act(async () => {
      container.querySelector<HTMLButtonElement>(`button[aria-label="${t('terminalCandidateBrowse')}"]`)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => { await Promise.resolve() })
    return document.querySelector<HTMLElement>('[data-dsh-shell-path-picker]')!
  }

  it('renders a computer icon plus one crumb button per path segment', async () => {
    vi.spyOn(api, 'fsTree').mockResolvedValue({
      path: 'C:\\Apps\\tools',
      entries: [],
      truncated: false,
    })
    const { container, unmount } = await mount()
    try {
      const dialog = await openPicker(container)
      // The default row is buttons, not a text box.
      expect(dialog.querySelector('[data-dsh-path-breadcrumb]')).not.toBeNull()
      expect(dialog.querySelector('input[type="text"]')).toBeNull()
      expect(dialog.querySelector('[data-dsh-path-computer]')).not.toBeNull()
      const crumbs = [...dialog.querySelectorAll('[data-dsh-path-crumb]')]
      expect(crumbs.map(c => c.textContent)).toEqual(['C:', 'Apps', 'tools'])
    } finally { unmount() }
  })

  it('switches to a text input when the last crumb is double-clicked', async () => {
    vi.spyOn(api, 'fsTree').mockResolvedValue({
      path: '/w/bin',
      entries: [],
      truncated: false,
    })
    const { container, unmount } = await mount()
    try {
      const dialog = await openPicker(container)
      const crumbs = [...dialog.querySelectorAll('[data-dsh-path-crumb]')]
      await act(async () => {
        crumbs[crumbs.length - 1]!
          .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      })
      const box = dialog.querySelector<HTMLInputElement>('input[type="text"]')!
      expect(box).not.toBeNull()
      expect(box.value).toBe('/w/bin')
    } finally { unmount() }
  })

  it('Escape in edit mode returns to crumbs without closing the dialog', async () => {
    vi.spyOn(api, 'fsTree').mockResolvedValue({
      path: '/w/bin',
      entries: [],
      truncated: false,
    })
    const { container, unmount } = await mount()
    try {
      const dialog = await openPicker(container)
      const crumbs = [...dialog.querySelectorAll('[data-dsh-path-crumb]')]
      await act(async () => {
        crumbs[crumbs.length - 1]!
          .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      })
      const box = dialog.querySelector<HTMLInputElement>('input[type="text"]')!
      expect(box).not.toBeNull()
      await act(async () => {
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      // Escape leaves only the address row: the picker survives and shows
      // crumb buttons again, rather than the Modal closing entirely.
      const root = document.querySelector<HTMLElement>('[data-dsh-shell-path-picker]')!
      expect(root).not.toBeNull()
      expect(root.querySelector('[data-dsh-path-breadcrumb]')).not.toBeNull()
      expect(root.querySelector('input[type="text"]')).toBeNull()
    } finally { unmount() }
  })
  it('folds the middle of a long path into a single .. button', async () => {
    vi.spyOn(api, 'fsTree').mockResolvedValue({
      path: 'C:\\a\\b\\c\\d\\e',
      entries: [],
      truncated: false,
    })
    const { container, unmount } = await mount()
    try {
      const dialog = await openPicker(container)
      // Root + last two folders stay; the levels between fold into `..`.
      const crumbs = [...dialog.querySelectorAll('[data-dsh-path-crumb]')]
      expect(crumbs.map(c => c.textContent)).toEqual(['C:', 'd', 'e'])
      const expand = dialog.querySelector('[data-dsh-path-expand]')!
      expect(expand).not.toBeNull()
      expect(expand.textContent).toBe('..')
    } finally { unmount() }
  })

  it('reveals the folded levels when .. is clicked', async () => {
    vi.spyOn(api, 'fsTree').mockResolvedValue({
      path: 'C:\\a\\b\\c\\d\\e',
      entries: [],
      truncated: false,
    })
    const { container, unmount } = await mount()
    try {
      const dialog = await openPicker(container)
      await act(async () => {
        dialog.querySelector<HTMLElement>('[data-dsh-path-expand]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      const crumbs = [...dialog.querySelectorAll('[data-dsh-path-crumb]')]
      expect(crumbs.map(c => c.textContent)).toEqual(['C:', 'a', 'b', 'c', 'd', 'e'])
      expect(dialog.querySelector('[data-dsh-path-expand]')).toBeNull()
    } finally { unmount() }
  })

  it('lists the host drives when the computer icon is clicked', async () => {
    const drives = vi.spyOn(api, 'fsDrives').mockResolvedValue({
      drives: [
        { name: 'C:', path: 'C:\\' },
        { name: 'D:', path: 'D:\\' },
      ],
    })
    const tree = vi.spyOn(api, 'fsTree').mockResolvedValue({
      path: 'D:\\',
      entries: [],
      truncated: false,
    })
    const { container, unmount } = await mount()
    try {
      const dialog = await openPicker(container)
      await act(async () => {
        dialog.querySelector<HTMLElement>('[data-dsh-path-computer]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => { await Promise.resolve() })
      expect(drives).toHaveBeenCalled()
      const options = [...dialog.querySelectorAll('[data-dsh-drive]')]
      expect(options.map(o => o.textContent)).toEqual(['C:', 'D:'])
      await act(async () => {
        options[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(tree).toHaveBeenCalledWith({ sessionId: 's1' }, 'D:\\', undefined)
      // Picking a drive snaps back to the directory list.
      expect(dialog.querySelector('[data-dsh-drives]')).toBeNull()
    } finally { unmount() }
  })
})

describe('terminal settings: the two settings fail independently', () => {
  it('explains the missing candidate list but keeps the default picker working', async () => {
    const { container, writes, unmount } = await mount({}, { view: null })
    try {
      expect(container.textContent).toContain(t('terminalCandidatesUnavailable'))
      // No chips, and no add control to offer something that cannot be saved.
      expect(container.querySelector('input[type="text"]')).toBeNull()

      // The picker still reads DISCOVERY, so setting one preference is not
      // blocked by the other being unavailable.
      await act(async () => { picker(container).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(menuRows().map(row => row.textContent)).toEqual(['cmd', 'bash', 'pwsh'])
      const row = menuRows().find(candidate => candidate.textContent === 'bash')
      await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(writes).toEqual([[DEFAULT_SHELL_KEY, 'bash']])
    } finally { unmount() }
  })

  it('explains the missing terminal service but keeps the candidate list working', async () => {
    const { container, unmount } = await mount({}, { catalog: null })
    try {
      expect(container.textContent).toContain(t('terminalDefaultShellUnavailable'))
      // The list half is unaffected: it is the HOST's config row, not the
      // terminal service.
      expect(container.textContent).toContain('elvish')
      expect(container.querySelector('input[type="text"]')).not.toBeNull()
    } finally { unmount() }
  })

  it('reports a failed candidate read instead of rendering an empty list', async () => {
    vi.spyOn(api, 'terminalShells').mockRejectedValue(new Error('route unavailable'))
    const rendered = renderRoot(createElement(TerminalSettingsPanel, {
      store: storeWith('s1') as never,
      service: {} as never,
      prefs: {} as never,
      pluginSettings: {},
      updatePluginSetting: () => {},
      close: () => {},
      terminalCtx: ctxWithCatalog(CATALOG, 's1'),
    } satisfies TerminalSettingsPanelProps))
    const { container, unmount } = rendered
    try {
      await act(async () => { await Promise.resolve() })
      await act(async () => { await Promise.resolve() })
      expect(container.textContent).toContain(t('terminalCandidatesUnavailable'))
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('route unavailable')
    } finally { unmount(); container.remove() }
  })
})

describe('terminal settings: the popup chrome', () => {
  it('renders NO Done button of its own', async () => {
    // The settings Modal around this panel already draws a Done footer
    // (SideCardSection's `footer` prop). A panel that also drew one produced
    // two stacked Done buttons, which is what this guards against.
    const { container, closes, unmount } = await mount()
    try {
      const done = [...container.querySelectorAll('button')]
        .find(button => button.textContent === t('settingsDone'))
      expect(done).toBeUndefined()
      // Closing is still a real capability — it just belongs to the Modal.
      expect(closes()).toBe(0)
    } finally { unmount() }
  })
})
