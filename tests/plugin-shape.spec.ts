import { describe, expect, it } from 'vitest'
import Loader from '@cordisjs/plugin-loader'
import * as sidebar from '../src/index.ts'

/**
 * Run the real namespace export through `Loader.unwrapExports`; a stray
 * default would discard `name`, `inject`, `Config`, and `apply`. Same guard
 * the official plugin repos ship (dsh-external/turtle-ui,
 * packages/ui/jsonrpc).
 */
describe('dsh-better-sidebar plugin export shape', () => {
  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/Config/apply', () => {
    expect('default' in sidebar).toBe(false)
    expect(typeof sidebar.apply).toBe('function')

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(sidebar) as Record<string, unknown>
    expect(unwrapped).toBe(sidebar)
    expect(unwrapped.name).toBe('dsh-better-sidebar')
    expect(unwrapped.inject).toEqual(['webServer', 'sessions', 'webRuntime', 'tools'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('exports the schemastery Config with the documented tunable fields', () => {
    const schema = sidebar.Config
    expect(schema).toBeDefined()
    // The resolved defaults mirror the pre-config constants.
    const resolved = (schema as unknown as {
      (input: Record<string, unknown> | undefined): Record<string, unknown>
    })(undefined)
    expect(resolved.readLimit).toBe(512 * 1024)
    expect(resolved.mediaLimit).toBe(20 * 1024 * 1024)
    expect(resolved.listLimit).toBe(1000)
    expect(resolved.terminalsPerSession).toBe(3)
    expect(resolved.reconnectGraceMs).toBe(30_000)
    // The terminal shell config defaults to auto-resolution (empty shell =
    // the platform chain in defaultShell()).
    expect(resolved.shell).toBe('')
    // Shell args default to an empty list; non-empty values replace the
    // automatic platform login flag.
    expect(resolved.shellArgs).toEqual([])
    const configured = (schema as unknown as {
      (input: Record<string, unknown> | undefined): Record<string, unknown>
    })({ shell: 'pwsh.exe' })
    expect(configured.shell).toBe('pwsh.exe')
    const configuredWithArgs = (schema as unknown as {
      (input: Record<string, unknown> | undefined): Record<string, unknown>
    })({ shell: '/bin/zsh', shellArgs: ['--noprofile', '--no-rc'] })
    expect(configuredWithArgs.shell).toBe('/bin/zsh')
    expect(configuredWithArgs.shellArgs).toEqual(['--noprofile', '--no-rc'])
  })

  it('registers the side card preferences schema with the documented defaults', async () => {
    const { PrefsSchema, SIDEBAR_PREFS_NS } = await import('../src/config.ts')
    expect(SIDEBAR_PREFS_NS).toBe('dsh-better-sidebar')
    const resolved = (PrefsSchema as unknown as {
      (input: Record<string, unknown> | undefined): Record<string, unknown>
    })(undefined)
    expect(resolved.openByDefault).toBe(false)
    expect(resolved.defaultWidthPercent).toBe(35)
    expect(resolved.autoOpenSubagent).toBe(true)
    // A new background job auto-opens the Jobs page too.
    expect(resolved.autoOpenJobs).toBe(true)
    // The terminal tools default OFF (the feature is dormant until the user
    // enables it in the side card settings).
    expect(resolved.agentTerminalTools).toBe(false)
    // The terminal font customizations default to the theme (empty family)
    // and 13px.
    expect(resolved.terminalFontFamily).toBe('')
    expect(resolved.terminalFontSize).toBe(13)
    // The position-compat scheme is declared WITHOUT a schema default so a
    // stored document that predates it resolves without the field — the
    // CLIENT parsePrefs then applies the conservative `auto` default (or
    // migrates the legacy boolean), which is exactly what makes old
    // documents migrate instead of silently flipping to a scheme. The
    // legacy strip keeps its schema default of 40px.
    expect(resolved.titleBarScheme).toBeUndefined()
    expect(resolved.titleBarPresetId).toBeUndefined()
    expect(resolved.customCss).toBeUndefined()
    expect(resolved.titleBarCompat).toBe(false)
    expect(resolved.titleBarStripPx).toBe(40)
    // The enable-switch maps resolve to {} (everything on) for old documents.
    expect(resolved.tabsEnabled).toEqual({})
    expect(resolved.viewersEnabled).toEqual({})
    // The separate file-window mode is the default (each file opens its own
    // tab; the merged editor-explorer is opt-in).
    expect(resolved.editorExplorer).toBe(false)
    // A stored overridden value resolves through (the range contract is
    // enforced by the settings service on write); the new pref keeps its
    // default when the stored document predates it.
    const overridden = (PrefsSchema as unknown as {
      (input: Record<string, unknown> | undefined): Record<string, unknown>
    })({ openByDefault: false, defaultWidthPercent: 45 })
    expect(overridden).toEqual({ openByDefault: false, defaultWidthPercent: 45, autoOpenSubagent: true, autoOpenJobs: true, agentTerminalTools: false, bottomPanelAutoTerminal: true, terminalFontFamily: '', terminalFontSize: 13, interceptOpenPath: true, editorExplorer: false, terminalShell: '', terminalShellArgs: '', titleBarCompat: false, titleBarStripPx: 40, htmlViewerNoSandbox: false, htmlViewerDefaultUnsafe: false, browserNoSandbox: false, browserInterceptLinks: true, browserInterceptHttp: true, browserInterceptHttps: false, tabsEnabled: {}, viewersEnabled: {}, pluginSettings: {} })
  })
})
