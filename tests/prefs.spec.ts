import { describe, expect, it } from 'vitest'
import { loadBootDecision, loadExternalDisable, loadPrefs, type SidebarSettingsClient } from '../src/client/prefs.ts'
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

  it('parses a valid value', async () => {
    expect(await loadPrefs(wire({ autoOpenSubagent: false, agentTerminalTools: true })))
      .toEqual({
        autoOpenSubagent: false,
        autoOpenJobs: true,
        autoOpenPlan: true,
        agentTerminalTools: true, agentOpenTools: false,
        bottomPanelAutoTerminal: true,
        terminalFontFamily: '',
        terminalFontSize: 13,
        editorExplorer: false,
        workspaceFence: true,
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
        browserAllowedLoopback: '',
        tabsEnabled: {},
        viewersEnabled: {},
        pluginSettings: {},
      })
  })

  it('falls back per-field when a stored field is malformed', async () => {
    expect(await loadPrefs(wire({ autoOpenSubagent: 'no', agentTerminalTools: 'yes' })))
      .toEqual({
        autoOpenSubagent: true,
        autoOpenJobs: true,
        autoOpenPlan: true,
        agentTerminalTools: false, agentOpenTools: false,
        bottomPanelAutoTerminal: true,
        terminalFontFamily: '',
        terminalFontSize: 13,
        editorExplorer: false,
        workspaceFence: true,
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
        browserAllowedLoopback: '',
        tabsEnabled: {},
        viewersEnabled: {},
        pluginSettings: {},
      })
  })

  it('defaults autoOpenSubagent to true and agentTerminalTools to false when the stored value is absent or malformed', async () => {
    expect(await loadPrefs(wire({})))
      .toEqual({
        autoOpenSubagent: true,
        autoOpenJobs: true,
        autoOpenPlan: true,
        agentTerminalTools: false, agentOpenTools: false,
        bottomPanelAutoTerminal: true,
        terminalFontFamily: '',
        terminalFontSize: 13,
        editorExplorer: false,
        workspaceFence: true,
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
        browserAllowedLoopback: '',
        tabsEnabled: {},
        viewersEnabled: {},
        pluginSettings: {},
      })
    expect((await loadPrefs(wire({ autoOpenSubagent: 1 }))).autoOpenSubagent)
      .toBe(true)
    // The terminal-tools feature is OFF by default; only an explicit true turns it on.
    expect((await loadPrefs(wire({}))).agentTerminalTools)
      .toBe(false)
    expect((await loadPrefs(wire({ agentTerminalTools: 1 }))).agentTerminalTools)
      .toBe(false)
    expect((await loadPrefs(wire({ agentTerminalTools: true }))).agentTerminalTools)
      .toBe(true)
    // The sidebar-open tool is OFF by default too; only an explicit true turns it on.
    expect((await loadPrefs(wire({}))).agentOpenTools)
      .toBe(false)
    expect((await loadPrefs(wire({ agentOpenTools: 1 }))).agentOpenTools)
      .toBe(false)
    expect((await loadPrefs(wire({ agentOpenTools: true }))).agentOpenTools)
      .toBe(true)
    // The job auto-open is ON by default; only an explicit false turns it off.
    expect((await loadPrefs(wire({ autoOpenJobs: 1 }))).autoOpenJobs)
      .toBe(true)
    expect((await loadPrefs(wire({ autoOpenJobs: false }))).autoOpenJobs)
      .toBe(false)
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

  it('defaults workspaceFence to true; only an explicit false disarms the containment guard', async () => {
    // Absent or malformed → on (the fs routes keep refusing outside paths).
    expect((await loadPrefs(wire({}))).workspaceFence).toBe(true)
    expect((await loadPrefs(wire({ workspaceFence: 'no' }))).workspaceFence).toBe(true)
    expect((await loadPrefs(wire({ workspaceFence: 0 }))).workspaceFence).toBe(true)
    // An explicit false survives (the one-click off in the fence error notice).
    expect((await loadPrefs(wire({ workspaceFence: false }))).workspaceFence).toBe(false)
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

describe('boot decision (one fetch for prefs + external disable)', () => {
  it('answers both decisions from a single settingsGet call', async () => {
    let calls = 0
    const counting = (): SidebarSettingsClient => ({
      settingsGet: async () => { calls += 1; return { value: { autoOpenSubagent: false, editorExplorer: true }, revision: 1, externalDisable: true } },
      settingsUpdate: async () => ({ value: {}, revision: 2 }),
    })
    const decision = await loadBootDecision(counting())
    expect(calls, 'the boot path must fetch the settings document exactly once').toBe(1)
    expect(decision.suspended).toBe(true)
    expect(decision.prefs.autoOpenSubagent).toBe(false)
  })

  it('falls back to the defaults + not suspended on any failure', async () => {
    const decision = await loadBootDecision(rejecting())
    expect(decision).toEqual({ prefs: SIDEBAR_PREFS_DEFAULTS, suspended: false })
  })

  it('reads suspended false when the flag is absent', async () => {
    const decision = await loadBootDecision(wire({ terminalFontSize: 20 }))
    expect(decision.suspended).toBe(false)
    expect(decision.prefs.terminalFontSize).toBe(20)
  })
})
