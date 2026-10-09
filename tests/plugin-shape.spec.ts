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
    const configured = (schema as unknown as {
      (input: Record<string, unknown> | undefined): Record<string, unknown>
    })({ readLimit: 1024 })
    expect(configured.readLimit).toBe(1024)
  })

  it('registers the side card preferences schema with the documented defaults', async () => {
    const { PrefsSchema, SIDEBAR_PREFS_NS, SIDEBAR_PREFS_DEFAULTS } = await import('../src/config.ts')
    expect(SIDEBAR_PREFS_NS).toBe('dsh-better-sidebar')
    const resolved = (PrefsSchema as unknown as {
      (input: Record<string, unknown> | undefined): Record<string, unknown>
    })(undefined)
    expect(resolved.openByDefault).toBeUndefined()
    expect(resolved.defaultWidthPercent).toBeUndefined()
    expect(resolved.changesDiffFloat).toBeUndefined()
    expect(resolved.autoOpenSubagent).toBe(true)
    // A new background job auto-opens the Jobs page too.
    expect(resolved.autoOpenJobs).toBe(true)
    // The sidebar-open tool defaults OFF (dormant until the user enables it
    // in the side card settings).
    expect(resolved.agentOpenTools).toBe(false)
    // customCss (the user-space escape hatch) is declared WITHOUT a schema
    // default — the client's parsePrefs supplies '' — so a document that
    // never stored it resolves without the field.
    expect(resolved.customCss).toBeUndefined()
    // The title-bar compatibility keys are GONE (the whole strip mechanism
    // was removed): a resolved document no longer declares them, so the
    // settings form stops offering them.
    expect(resolved.titleBarScheme).toBeUndefined()
    expect(resolved.titleBarPresetId).toBeUndefined()
    expect(resolved.titleBarCompat).toBeUndefined()
    expect(resolved.titleBarStripPx).toBeUndefined()
    // The enable-switch maps resolve to {} (everything on) for old documents.
    expect(resolved.tabsEnabled).toEqual({})
    expect(resolved.viewersEnabled).toEqual({})
    // The separate file-window mode is the default (each file opens its own
    // tab; the merged editor-explorer is opt-in).
    expect(resolved.editorExplorer).toBe(false)
    // The workspace fence is GONE: `workspaceFence` is no longer a declared
    // schema field, so a resolved document does not carry it. A legacy stored
    // value passes through the OPEN object schema untouched (and is inert).
    expect(resolved.workspaceFence).toBeUndefined()
    const legacy = (PrefsSchema as unknown as {
      (input: Record<string, unknown> | undefined): Record<string, unknown>
    })({ workspaceFence: true })
    expect(legacy.workspaceFence).toBe(true)
    // Same contract for the retired title-bar keys: a settings document
    // written before the removal still carries them, and resolving it must
    // neither throw nor drop the rest of the document — the values pass
    // through untouched and are inert (the client's parsePrefs drops them;
    // tests/prefs.spec.ts). This is the "old preference data is ignored
    // safely" nail for the removal.
    const retired = {
      titleBarScheme: 'preset',
      titleBarPresetId: 'dsh-desktop',
      titleBarCompat: true,
      titleBarStripPx: 56,
    }
    const withRetired = (PrefsSchema as unknown as {
      (input: Record<string, unknown> | undefined): Record<string, unknown>
    })({ ...retired, agentOpenTools: true })
    expect(withRetired).toMatchObject({ ...retired, agentOpenTools: true })
    expect(withRetired.autoOpenSubagent).toBe(true)
    expect(withRetired.explorerExclude).toEqual(['.DS_Store', 'Thumbs.db'])
    // A stored overridden value resolves through (the range contract is
    // enforced by the settings service on write); the new pref keeps its
    // default when the stored document predates it.
    const overridden = (PrefsSchema as unknown as {
      (input: Record<string, unknown> | undefined): Record<string, unknown>
    })({ openByDefault: false, defaultWidthPercent: 45, changesDiffFloat: true })
    // Schemastery's object schema is OPEN: a document written by an older
    // plugin version still carrying the retired keys resolves them through
    // verbatim. They are inert — the typed value the client consumes
    // (parsePrefs) drops them (tests/prefs.spec.ts) — and the defaults no
    // longer declare them.
    // customCss is declared WITHOUT a schema default (the client's parsePrefs
    // supplies it), so it is absent from a resolved document that never
    // stored it.
    const { customCss, ...schemaDefaults } = SIDEBAR_PREFS_DEFAULTS
    void customCss
    expect(overridden).toEqual({ ...schemaDefaults, openByDefault: false, defaultWidthPercent: 45, changesDiffFloat: true })
  })
})
