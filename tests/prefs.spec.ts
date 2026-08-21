import { describe, expect, it } from 'vitest'
import { loadExternalDisable, loadPrefs, type SidebarSettingsClient } from '../src/client/prefs.ts'
import { allLeaves, createSidebarStore, defaultWidthFor, makeDefaultState } from '../src/client/state.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'

/** A fake settings wire face whose settingsGet resolves to one raw value. */
const wire = (value: unknown): SidebarSettingsClient => ({
  settingsGet: async () => ({ value, revision: 1 }),
  settingsUpdate: async () => ({ value, revision: 2 }),
})

/** A fake wire carrying an explicit externalDisable flag. */
const wireWithDisable = (externalDisable: boolean): SidebarSettingsClient => ({
  settingsGet: async () => ({ value: {}, revision: 1, externalDisable }),
  settingsUpdate: async () => ({ value: {}, revision: 2 }),
})

const rejecting = (): SidebarSettingsClient => ({
  settingsGet: async () => { throw new Error('route rejected') },
  settingsUpdate: async () => { throw new Error('route rejected') },
})

describe('side card preferences', () => {
  it('falls back to the defaults when the settings route rejects', async () => {
    expect(await loadPrefs(rejecting())).toEqual(SIDEBAR_PREFS_DEFAULTS)
  })

  it('falls back to the defaults when the value is absent or malformed', async () => {
    expect(await loadPrefs(wire(undefined))).toEqual(SIDEBAR_PREFS_DEFAULTS)
    expect(await loadPrefs(wire('garbage'))).toEqual(SIDEBAR_PREFS_DEFAULTS)
  })

  it('parses a valid value and clamps the percent into the contract range', async () => {
    expect(await loadPrefs(wire({ openByDefault: false, defaultWidthPercent: 80, autoOpenSubagent: false, agentTerminalTools: true })))
      .toEqual({
        openByDefault: false,
        defaultWidthPercent: 60,
        autoOpenSubagent: false,
        autoOpenJobs: true,
        agentTerminalTools: true,
        bottomPanelAutoTerminal: true,
        terminalFontFamily: '',
        terminalFontSize: 13,
        interceptOpenPath: true,
        editorExplorer: false,
        terminalShell: '',
        terminalShellArgs: '',
        titleBarScheme: 'auto',
        titleBarPresetId: '',
        customCss: '',
        titleBarCompat: false,
        titleBarStripPx: 40,
        htmlViewerNoSandbox: false,
        htmlViewerDefaultUnsafe: false,
        browserNoSandbox: false,
        browserInterceptLinks: true,
        browserInterceptHttp: true,
        browserInterceptHttps: false,
        tabsEnabled: {},
        viewersEnabled: {},
        pluginSettings: {},
      })
  })

  it('falls back per-field when a stored field is malformed', async () => {
    expect(await loadPrefs(wire({ openByDefault: 'yes', defaultWidthPercent: 33, autoOpenSubagent: 'no', agentTerminalTools: 'yes' })))
      .toEqual({
        openByDefault: false,
        defaultWidthPercent: 33,
        autoOpenSubagent: true,
        autoOpenJobs: true,
        agentTerminalTools: false,
        bottomPanelAutoTerminal: true,
        terminalFontFamily: '',
        terminalFontSize: 13,
        interceptOpenPath: true,
        editorExplorer: false,
        terminalShell: '',
        terminalShellArgs: '',
        titleBarScheme: 'auto',
        titleBarPresetId: '',
        customCss: '',
        titleBarCompat: false,
        titleBarStripPx: 40,
        htmlViewerNoSandbox: false,
        htmlViewerDefaultUnsafe: false,
        browserNoSandbox: false,
        browserInterceptLinks: true,
        browserInterceptHttp: true,
        browserInterceptHttps: false,
        tabsEnabled: {},
        viewersEnabled: {},
        pluginSettings: {},
      })
  })

  it('defaults autoOpenSubagent to true and agentTerminalTools to false when the stored value is absent or malformed', async () => {
    expect(await loadPrefs(wire({ openByDefault: false, defaultWidthPercent: 40 })))
      .toEqual({
        openByDefault: false,
        defaultWidthPercent: 40,
        autoOpenSubagent: true,
        autoOpenJobs: true,
        agentTerminalTools: false,
        bottomPanelAutoTerminal: true,
        terminalFontFamily: '',
        terminalFontSize: 13,
        interceptOpenPath: true,
        editorExplorer: false,
        terminalShell: '',
        terminalShellArgs: '',
        titleBarScheme: 'auto',
        titleBarPresetId: '',
        customCss: '',
        titleBarCompat: false,
        titleBarStripPx: 40,
        htmlViewerNoSandbox: false,
        htmlViewerDefaultUnsafe: false,
        browserNoSandbox: false,
        browserInterceptLinks: true,
        browserInterceptHttp: true,
        browserInterceptHttps: false,
        tabsEnabled: {},
        viewersEnabled: {},
        pluginSettings: {},
      })
    expect((await loadPrefs(wire({ openByDefault: true, defaultWidthPercent: 40, autoOpenSubagent: 1 }))).autoOpenSubagent)
      .toBe(true)
    // The terminal-tools feature is OFF by default; only an explicit true turns it on.
    expect((await loadPrefs(wire({ openByDefault: true, defaultWidthPercent: 40 }))).agentTerminalTools)
      .toBe(false)
    expect((await loadPrefs(wire({ openByDefault: true, defaultWidthPercent: 40, agentTerminalTools: 1 }))).agentTerminalTools)
      .toBe(false)
    expect((await loadPrefs(wire({ openByDefault: true, defaultWidthPercent: 40, agentTerminalTools: true }))).agentTerminalTools)
      .toBe(true)
    // The job auto-open is ON by default; only an explicit false turns it off.
    expect((await loadPrefs(wire({ openByDefault: true, defaultWidthPercent: 40, autoOpenJobs: 1 }))).autoOpenJobs)
      .toBe(true)
    expect((await loadPrefs(wire({ openByDefault: true, defaultWidthPercent: 40, autoOpenJobs: false }))).autoOpenJobs)
      .toBe(false)
  })

  it('defaults interceptOpenPath to true; only an explicit false turns the takeover off', async () => {
    // Absent or malformed → on (the takeover is the safe default).
    expect((await loadPrefs(wire({}))).interceptOpenPath).toBe(true)
    expect((await loadPrefs(wire({ interceptOpenPath: 'yes' }))).interceptOpenPath).toBe(true)
    expect((await loadPrefs(wire({ interceptOpenPath: 0 }))).interceptOpenPath).toBe(true)
    // Explicit booleans survive verbatim.
    expect((await loadPrefs(wire({ interceptOpenPath: false }))).interceptOpenPath).toBe(false)
    expect((await loadPrefs(wire({ interceptOpenPath: true }))).interceptOpenPath).toBe(true)
  })

  it('defaults editorExplorer to false; only an explicit true enables the merged editor-explorer', async () => {
    // Absent or malformed → off (separate file windows are the default).
    expect((await loadPrefs(wire({}))).editorExplorer).toBe(false)
    expect((await loadPrefs(wire({ editorExplorer: 'yes' }))).editorExplorer).toBe(false)
    expect((await loadPrefs(wire({ editorExplorer: 1 }))).editorExplorer).toBe(false)
    // Explicit booleans survive verbatim.
    expect((await loadPrefs(wire({ editorExplorer: false }))).editorExplorer).toBe(false)
    expect((await loadPrefs(wire({ editorExplorer: true }))).editorExplorer).toBe(true)
  })

  it('defaults the title-bar scheme to the conservative auto with no preset or custom CSS', async () => {
    // Absent or malformed → auto (plain web keeps the untouched layout).
    expect((await loadPrefs(wire({}))).titleBarScheme).toBe('auto')
    expect((await loadPrefs(wire({ titleBarScheme: 'weird' }))).titleBarScheme).toBe('auto')
    expect((await loadPrefs(wire({ titleBarScheme: 1 }))).titleBarScheme).toBe('auto')
    expect((await loadPrefs(wire({}))).titleBarPresetId).toBe('')
    expect((await loadPrefs(wire({ titleBarPresetId: 5 }))).titleBarPresetId).toBe('')
    expect((await loadPrefs(wire({}))).customCss).toBe('')
    expect((await loadPrefs(wire({ customCss: 7 }))).customCss).toBe('')
    // Valid values survive verbatim (including the explicit web scheme).
    const picked = await loadPrefs(wire({ titleBarScheme: 'preset', titleBarPresetId: 'dsh-desktop', customCss: 'html { }' }))
    expect(picked.titleBarScheme).toBe('preset')
    expect(picked.titleBarPresetId).toBe('dsh-desktop')
    expect(picked.customCss).toBe('html { }')
    expect((await loadPrefs(wire({ titleBarScheme: 'web' }))).titleBarScheme).toBe('web')
  })

  it('migrates LEGACY documents that ALREADY HAVE VALUES into the custom scheme', async () => {
    // A pre-scheme document with the manual compat flag on maps to the
    // custom scheme, keeping the strip px the user chose.
    const migrated = await loadPrefs(wire({ titleBarCompat: true, titleBarStripPx: 56 }))
    expect(migrated.titleBarScheme).toBe('custom')
    expect(migrated.titleBarStripPx).toBe(56)
    // A non-default strip px alone (only reachable through the old gear
    // popup) also counts as "already has values" → custom.
    const stripOnly = await loadPrefs(wire({ titleBarStripPx: 48 }))
    expect(stripOnly.titleBarScheme).toBe('custom')
    expect(stripOnly.titleBarStripPx).toBe(48)
    // A stored scheme always wins over the legacy fields (round-trip of the
    // mirrored write: preset stays preset even though the mirror is true).
    const roundTrip = await loadPrefs(wire({ titleBarScheme: 'preset', titleBarCompat: true }))
    expect(roundTrip.titleBarScheme).toBe('preset')
    // Legacy off / absent / default strip → the conservative auto scheme.
    expect((await loadPrefs(wire({ titleBarCompat: false }))).titleBarScheme).toBe('auto')
    expect((await loadPrefs(wire({ titleBarStripPx: 40 }))).titleBarScheme).toBe('auto')
    expect((await loadPrefs(wire({}))).titleBarScheme).toBe('auto')
  })

  it('defaults titleBarStripPx to 40 and clamps stored values into the contract range', async () => {
    // Absent or malformed → 40 (the strip default).
    expect((await loadPrefs(wire({}))).titleBarStripPx).toBe(40)
    expect((await loadPrefs(wire({ titleBarStripPx: 'yes' }))).titleBarStripPx).toBe(40)
    // Out-of-range numbers clamp into 0–120.
    expect((await loadPrefs(wire({ titleBarStripPx: -5 }))).titleBarStripPx).toBe(0)
    expect((await loadPrefs(wire({ titleBarStripPx: 200 }))).titleBarStripPx).toBe(120)
    expect((await loadPrefs(wire({ titleBarStripPx: 47.6 }))).titleBarStripPx).toBe(48)
    // In-range values survive verbatim.
    expect((await loadPrefs(wire({ titleBarStripPx: 0 }))).titleBarStripPx).toBe(0)
    expect((await loadPrefs(wire({ titleBarStripPx: 64 }))).titleBarStripPx).toBe(64)
  })

  it('defaults the link-takeover protocol flags: http on, https off, master on', async () => {
    // Absent or malformed → the per-protocol defaults.
    expect((await loadPrefs(wire({}))).browserInterceptLinks).toBe(true)
    expect((await loadPrefs(wire({}))).browserInterceptHttp).toBe(true)
    expect((await loadPrefs(wire({}))).browserInterceptHttps).toBe(false)
    expect((await loadPrefs(wire({ browserInterceptHttp: 'yes' }))).browserInterceptHttp).toBe(true)
    expect((await loadPrefs(wire({ browserInterceptHttps: 0 }))).browserInterceptHttps).toBe(false)
    // Explicit booleans survive verbatim.
    expect((await loadPrefs(wire({ browserInterceptHttp: false }))).browserInterceptHttp).toBe(false)
    expect((await loadPrefs(wire({ browserInterceptHttps: true }))).browserInterceptHttps).toBe(true)
    // The master is independent of the protocol flags (an explicit master
    // false stays "never take over" regardless of the flags).
    expect((await loadPrefs(wire({ browserInterceptLinks: false, browserInterceptHttp: true, browserInterceptHttps: true }))))
      .toMatchObject({ browserInterceptLinks: false, browserInterceptHttp: true, browserInterceptHttps: true })
  })

  it('resolves the terminal font prefs (family passthrough, size clamp)', async () => {
    // Absent → theme default (empty family) + default size.
    expect((await loadPrefs(wire({}))).terminalFontFamily).toBe('')
    expect((await loadPrefs(wire({}))).terminalFontSize).toBe(13)
    // A custom family survives verbatim; a malformed one falls back.
    expect((await loadPrefs(wire({ terminalFontFamily: '"JetBrains Mono", monospace' }))).terminalFontFamily)
      .toBe('"JetBrains Mono", monospace')
    expect((await loadPrefs(wire({ terminalFontFamily: 42 }))).terminalFontFamily).toBe('')
    // The size clamps into 9–32 (rounded); non-numbers fall back.
    expect((await loadPrefs(wire({ terminalFontSize: 5 }))).terminalFontSize).toBe(9)
    expect((await loadPrefs(wire({ terminalFontSize: 40 }))).terminalFontSize).toBe(32)
    expect((await loadPrefs(wire({ terminalFontSize: 15.6 }))).terminalFontSize).toBe(16)
    expect((await loadPrefs(wire({ terminalFontSize: 'big' }))).terminalFontSize).toBe(13)
    expect((await loadPrefs(wire({ terminalFontSize: 18 }))).terminalFontSize).toBe(18)
  })

  it('validates the per-tab / per-viewer enable maps (absent keys mean enabled)', async () => {
    // A non-object map falls back to {} (everything enabled).
    expect((await loadPrefs(wire({ tabsEnabled: 'nope' }))).tabsEnabled).toEqual({})
    expect((await loadPrefs(wire({ viewersEnabled: [1, 2] }))).viewersEnabled).toEqual({})
    // Non-boolean entries are dropped; boolean entries survive verbatim.
    const parsed = await loadPrefs(wire({
      tabsEnabled: { git: false, explorer: true, bad: 'yes' },
      viewersEnabled: { image: false, code: 1 },
    }))
    expect(parsed.tabsEnabled).toEqual({ git: false, explorer: true })
    expect(parsed.viewersEnabled).toEqual({ image: false })
  })

  it('seeds new-session defaults from the store prefs (open flag + width)', () => {
    const store = createSidebarStore()
    // Node environment: no window → the width falls back to PANEL_DEFAULT,
    // while the open flag still follows the preference.
    store.setPrefs({ openByDefault: false, defaultWidthPercent: 45, autoOpenSubagent: true, autoOpenJobs: true, agentTerminalTools: false, bottomPanelAutoTerminal: true, terminalFontFamily: '', terminalFontSize: 13, interceptOpenPath: true, editorExplorer: true, terminalShell: '', terminalShellArgs: '', titleBarScheme: 'auto', titleBarPresetId: '', customCss: '', titleBarCompat: false, titleBarStripPx: 40, htmlViewerNoSandbox: false, htmlViewerDefaultUnsafe: false, browserNoSandbox: false, browserInterceptLinks: true, browserInterceptHttp: true, browserInterceptHttps: false, tabsEnabled: {}, viewersEnabled: {}, pluginSettings: {} })
    store.setSession('fresh-session')
    expect(store.getPrefs()).toEqual({ openByDefault: false, defaultWidthPercent: 45, autoOpenSubagent: true, autoOpenJobs: true, agentTerminalTools: false, bottomPanelAutoTerminal: true, terminalFontFamily: '', terminalFontSize: 13, interceptOpenPath: true, editorExplorer: true, terminalShell: '', terminalShellArgs: '', titleBarScheme: 'auto', titleBarPresetId: '', customCss: '', titleBarCompat: false, titleBarStripPx: 40, htmlViewerNoSandbox: false, htmlViewerDefaultUnsafe: false, browserNoSandbox: false, browserInterceptLinks: true, browserInterceptHttp: true, browserInterceptHttps: false, tabsEnabled: {}, viewersEnabled: {}, pluginSettings: {} })
    const snapshot = store.getSnapshot()
    expect(snapshot.sessionId).toBe('fresh-session')
    expect(snapshot.state?.panelOpen).toBe(false)
    expect(snapshot.state?.width).toBe(400)
    // The default prefs keep the panel closed (openByDefault defaults off).
    const openStore = createSidebarStore()
    openStore.setSession('another-fresh')
    expect(openStore.getSnapshot().state?.panelOpen).toBe(false)
  })

  it('seeds a brand-new session COLLAPSED on narrow viewports (the panel is a full-screen drawer there)', () => {
    // Stub a narrow window (the file otherwise runs without one): only
    // innerWidth is read while seeding a fresh session.
    const original = (globalThis as Record<string, unknown>).window
    ;(globalThis as Record<string, unknown>).window = {
      innerWidth: 390,
      clearTimeout: () => {},
      setTimeout: (_fn: () => void) => 0,
    }
    try {
      const store = createSidebarStore()
      // The narrow viewport keeps a fresh session collapsed for the FIRST
      // seeding only (a later user expansion persists).
      store.setSession('narrow-fresh')
      expect(store.getSnapshot().state?.panelOpen).toBe(false)
      // The width seeding still follows the window (clamped to the floor).
      expect(store.getSnapshot().state?.width).toBe(280)
    } finally {
      if (original === undefined) delete (globalThis as Record<string, unknown>).window
      else (globalThis as Record<string, unknown>).window = original
    }
  })

  it('skips the default seed tab when the editor (files window) type is disabled', () => {
    const store = createSidebarStore()
    store.setPrefs({ openByDefault: true, defaultWidthPercent: 30, autoOpenSubagent: true, autoOpenJobs: true, agentTerminalTools: false, bottomPanelAutoTerminal: true, terminalFontFamily: '', terminalFontSize: 13, interceptOpenPath: true, editorExplorer: true, terminalShell: '', terminalShellArgs: '', titleBarScheme: 'auto', titleBarPresetId: '', customCss: '', titleBarCompat: false, titleBarStripPx: 40, htmlViewerNoSandbox: false, htmlViewerDefaultUnsafe: false, browserNoSandbox: false, browserInterceptLinks: true, browserInterceptHttp: true, browserInterceptHttps: false, tabsEnabled: { editor: false }, viewersEnabled: {}, pluginSettings: {} })
    store.setSession('no-editor')
    const state = store.getSnapshot().state!
    const tabs = allLeaves(state.splits).flatMap(leaf => leaf.tabs)
    expect(tabs).toHaveLength(0)
    expect(state.splits.kind).toBe('leaf')
    // Re-enabling seeds the files window (editor home tab) again — in BOTH
    // editorExplorer modes.
    for (const editorExplorer of [true, false]) {
      const openStore = createSidebarStore()
      openStore.setPrefs({ openByDefault: true, defaultWidthPercent: 30, autoOpenSubagent: true, autoOpenJobs: true, agentTerminalTools: false, bottomPanelAutoTerminal: true, terminalFontFamily: '', terminalFontSize: 13, interceptOpenPath: true, editorExplorer, terminalShell: '', terminalShellArgs: '', titleBarScheme: 'auto', titleBarPresetId: '', customCss: '', titleBarCompat: false, titleBarStripPx: 40, htmlViewerNoSandbox: false, htmlViewerDefaultUnsafe: false, browserNoSandbox: false, browserInterceptLinks: true, browserInterceptHttp: true, browserInterceptHttps: false, tabsEnabled: {}, viewersEnabled: {}, pluginSettings: {} })
      openStore.setSession(`with-editor-${editorExplorer}`)
      const openTabs = allLeaves(openStore.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
      expect(openTabs.map(tab => tab.type)).toEqual(['editor'])
    }
  })

  it('seeds the empty editor home tab (files window) in both editorExplorer modes', () => {
    for (const editorExplorer of [true, false]) {
      const store = createSidebarStore()
      store.setPrefs({ openByDefault: true, defaultWidthPercent: 30, autoOpenSubagent: true, autoOpenJobs: true, agentTerminalTools: false, bottomPanelAutoTerminal: true, terminalFontFamily: '', terminalFontSize: 13, interceptOpenPath: true, editorExplorer, terminalShell: '', terminalShellArgs: '', titleBarScheme: 'auto', titleBarPresetId: '', customCss: '', titleBarCompat: false, titleBarStripPx: 40, htmlViewerNoSandbox: false, htmlViewerDefaultUnsafe: false, browserNoSandbox: false, browserInterceptLinks: true, browserInterceptHttp: true, browserInterceptHttps: false, tabsEnabled: {}, viewersEnabled: {}, pluginSettings: {} })
      store.setSession(`fresh-${editorExplorer}`)
      const tabs = allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
      expect(tabs).toHaveLength(1)
      expect(tabs[0]!.type).toBe('editor')
      expect(tabs[0]!.title).toBe('Files')
      expect(tabs[0]!.path).toBeUndefined()
      expect(tabs[0]!.meta).toEqual({ treeOpen: true })
    }
  })

  it('derives the default width from the window percent with clamps', () => {
    expect(defaultWidthFor(1440, 30)).toBe(432)
    expect(defaultWidthFor(800, 30)).toBe(280) // the panel floor
    expect(defaultWidthFor(1440, 100)).toBe(1440) // the viewport cap
  })

  it('makeDefaultState honors the open flag', () => {
    expect(makeDefaultState().panelOpen).toBe(true)
    expect(makeDefaultState(400, false).panelOpen).toBe(false)
    expect(makeDefaultState(400, false).width).toBe(400)
    // The 'none' seed starts with an empty pane (no default tab).
    expect(makeDefaultState(400, true, 'none').splits.kind).toBe('leaf')
    expect((makeDefaultState(400, true, 'none').splits as { tabs: unknown[] }).tabs).toHaveLength(0)
  })
})

describe('external disable (aionui-panel provider choice)', () => {
  it('reads true when the host reports the aionui provider active', async () => {
    expect(await loadExternalDisable(wireWithDisable(true))).toBe(true)
  })

  it('reads false when the host reports no external disable', async () => {
    expect(await loadExternalDisable(wireWithDisable(false))).toBe(false)
  })

  it('reads false when the flag is absent or the wire rejects', async () => {
    expect(await loadExternalDisable(wire({}))).toBe(false)
    expect(await loadExternalDisable(rejecting())).toBe(false)
  })
})
