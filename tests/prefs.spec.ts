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
    expect(await loadPrefs(wire({ autoOpenSubagent: false, agentOpenTools: true })))
      .toEqual({
        autoOpenSubagent: false,
        autoOpenJobs: true,
        tasksViewMode: 'graph',
        mobileNoAutoOpen: true,
        mobileDefaultTree: true,
        agentOpenTools: true,
        editorExplorer: false,
        editorGitGutter: true,
        explorerExclude: ['.DS_Store', 'Thumbs.db'],
        customCss: '',
        htmlViewerNoSandbox: false,
        htmlViewerDefaultUnsafe: false,
        tabsEnabled: {},
        viewersEnabled: {},
        pluginSettings: {},
      })
  })

  it('falls back per-field when a stored field is malformed', async () => {
    expect(await loadPrefs(wire({ autoOpenSubagent: 'no', agentOpenTools: 'yes' })))
      .toEqual({
        autoOpenSubagent: true,
        autoOpenJobs: true,
        tasksViewMode: 'graph',
        mobileNoAutoOpen: true,
        mobileDefaultTree: true,
        agentOpenTools: false,
        editorExplorer: false,
        editorGitGutter: true,
        explorerExclude: ['.DS_Store', 'Thumbs.db'],
        customCss: '',
        htmlViewerNoSandbox: false,
        htmlViewerDefaultUnsafe: false,
        tabsEnabled: {},
        viewersEnabled: {},
        pluginSettings: {},
      })
  })

  it('defaults autoOpenSubagent to true and the agent toggles to false when the stored value is absent or malformed', async () => {
    expect(await loadPrefs(wire({})))
      .toEqual({
        autoOpenSubagent: true,
        autoOpenJobs: true,
        tasksViewMode: 'graph',
        mobileNoAutoOpen: true,
        mobileDefaultTree: true,
        agentOpenTools: false,
        editorExplorer: false,
        editorGitGutter: true,
        explorerExclude: ['.DS_Store', 'Thumbs.db'],
        customCss: '',
        htmlViewerNoSandbox: false,
        htmlViewerDefaultUnsafe: false,
        tabsEnabled: {},
        viewersEnabled: {},
        pluginSettings: {},
      })
    expect((await loadPrefs(wire({ autoOpenSubagent: 1 }))).autoOpenSubagent)
      .toBe(true)
    // The sidebar-open tool is OFF by default; only an explicit true turns it on.
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

  it('defaults both mobile adaptations to on; only an explicit false disarms one', async () => {
    // Absent or malformed → ON: a phone is exactly the case these exist for,
    // and each one only changes what happens on a NARROW viewport.
    for (const key of ['mobileNoAutoOpen', 'mobileDefaultTree'] as const) {
      expect((await loadPrefs(wire({})))[key]).toBe(true)
      expect((await loadPrefs(wire({ [key]: 'yes' })))[key]).toBe(true)
      expect((await loadPrefs(wire({ [key]: 1 })))[key]).toBe(true)
      // Explicit booleans survive verbatim.
      expect((await loadPrefs(wire({ [key]: false })))[key]).toBe(false)
      expect((await loadPrefs(wire({ [key]: true })))[key]).toBe(true)
    }
  })

  it('defaults explorerExclude to the stock junk list; only a valid string array overrides it', async () => {
    // Absent or malformed → the stock list.
    expect((await loadPrefs(wire({}))).explorerExclude).toEqual(['.DS_Store', 'Thumbs.db'])
    expect((await loadPrefs(wire({ explorerExclude: 'node_modules' }))).explorerExclude).toEqual(['.DS_Store', 'Thumbs.db'])
    expect((await loadPrefs(wire({ explorerExclude: { a: 1 } }))).explorerExclude).toEqual(['.DS_Store', 'Thumbs.db'])
    // Non-string entries drop out; blanks drop out; entries trim.
    expect((await loadPrefs(wire({ explorerExclude: ['node_modules', 42, '  *.log  ', '', null] }))).explorerExclude)
      .toEqual(['node_modules', '*.log'])
    // An explicit empty array means "exclude nothing" and survives verbatim.
    expect((await loadPrefs(wire({ explorerExclude: [] }))).explorerExclude).toEqual([])
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

  it('no longer exposes a workspaceFence pref (the containment guard is gone)', async () => {
    // The field was retired together with the fence: whatever a stored
    // document (or a legacy profile) still carries, the typed prefs the client
    // consumes do not have it — there is nothing left to arm or disarm.
    expect('workspaceFence' in await loadPrefs(wire({}))).toBe(false)
    expect('workspaceFence' in await loadPrefs(wire({ workspaceFence: true }))).toBe(false)
    expect('workspaceFence' in await loadPrefs(wire({ workspaceFence: false }))).toBe(false)
  })

  it('defaults customCss to the empty string; only a stored string survives', async () => {
    // The custom-CSS escape hatch is inert until the user writes something.
    expect((await loadPrefs(wire({}))).customCss).toBe('')
    expect((await loadPrefs(wire({ customCss: 7 }))).customCss).toBe('')
    expect((await loadPrefs(wire({ customCss: 'html { }' }))).customCss).toBe('html { }')
  })

  it('IGNORES the retired title-bar keys: a stored document that still carries them parses', async () => {
    // The whole title-bar strip mechanism (and its four preference keys) was
    // removed. A settings document written by an older version still carries
    // them — the host schema is OPEN, so they resolve through it untouched
    // (see plugin-shape.spec.ts), and this typed face is what makes them
    // inert: parsePrefs builds its result from DECLARED fields only, so the
    // retired keys never reach the client and never come back on a write.
    const stored = {
      titleBarScheme: 'preset',
      titleBarPresetId: 'dsh-desktop',
      titleBarCompat: true,
      titleBarStripPx: 56,
    }
    const parsed = await loadPrefs(wire({ ...stored, agentOpenTools: true }))
    expect(parsed).toEqual({ ...SIDEBAR_PREFS_DEFAULTS, agentOpenTools: true })
    for (const key of Object.keys(stored)) {
      expect(key in parsed, `${key} must not survive into the parsed prefs`).toBe(false)
    }
    // A malformed retired value is just as harmless (nothing reads it).
    const junk = await loadPrefs(wire({ titleBarScheme: 42, titleBarStripPx: 'yes' }))
    expect(junk).toEqual(SIDEBAR_PREFS_DEFAULTS)
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
    const decision = await loadBootDecision(wire({ customCss: 'html { }' }))
    expect(decision.suspended).toBe(false)
    expect(decision.prefs.customCss).toBe('html { }')
  })
})
