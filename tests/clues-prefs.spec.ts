/**
 * Clue preference contract (S1): the three switches, their defaults and the
 * "absent entry means ON" rule read from BOTH halves.
 *
 * The host registers the schema (so a stored document resolves to complete
 * values and the fields join the existing volatile chain), while the client's
 * typed parse is the second line: any malformed field falls back to its
 * default and unknown keys never reach the UI.
 */
import { describe, expect, it } from 'vitest'
import { Config, PrefsSchema } from '../src/config.ts'
import { parsePrefs } from '../src/client/prefs.ts'
import {
  SIDEBAR_PREFS_DEFAULTS,
  isCluePacksMentionEnabled,
  isClueSourceEnabled,
  isClueSourceMentionEnabled,
  type SidebarPrefs,
} from '../src/prefs-shared.ts'
import { CLUE_PREF_KEYS } from '../src/clues/types.ts'

/** Resolve the schema the way the Loader's form does. */
function resolveSchema(input: Record<string, unknown> | undefined): Record<string, unknown> {
  return (PrefsSchema as unknown as (value: Record<string, unknown> | undefined) => Record<string, unknown>)(input)
}

describe('clue preference defaults', () => {
  it('declares the documented defaults', () => {
    expect(SIDEBAR_PREFS_DEFAULTS.clueSourcesEnabled).toEqual({})
    expect(SIDEBAR_PREFS_DEFAULTS.clueSourcesMentionEnabled).toEqual({})
    expect(SIDEBAR_PREFS_DEFAULTS.cluePacksMentionEnabled).toBe(true)
    expect(CLUE_PREF_KEYS).toEqual({
      sourcesEnabled: 'clueSourcesEnabled',
      sourcesMentionEnabled: 'clueSourcesMentionEnabled',
      packsMentionEnabled: 'cluePacksMentionEnabled',
    })
  })

  it('resolves the schema defaults for an empty document', () => {
    const resolved = resolveSchema(undefined)
    expect(resolved.clueSourcesEnabled).toEqual({})
    expect(resolved.clueSourcesMentionEnabled).toEqual({})
    expect(resolved.cluePacksMentionEnabled).toBe(true)
  })

  it('resolves stored maps and booleans through the host schema', () => {
    const resolved = resolveSchema({
      clueSourcesEnabled: { 'builtin.files': false, 'x.source': true },
      clueSourcesMentionEnabled: { 'x.source': false },
      cluePacksMentionEnabled: false,
    })
    expect(resolved.clueSourcesEnabled).toEqual({ 'builtin.files': false, 'x.source': true })
    expect(resolved.clueSourcesMentionEnabled).toEqual({ 'x.source': false })
    expect(resolved.cluePacksMentionEnabled).toBe(false)
  })

  it('joins the volatile preference chain (a switch edit never remounts the plugin)', () => {
    // The Loader commits preference edits through the `meta.volatile` fields
    // of the row config. A clue switch that stayed non-volatile would take the
    // remount path (and be silently dropped from the live-commit walk).
    const fields = (Config as unknown as {
      dict: Record<string, { meta?: { volatile?: boolean } }>
    }).dict
    for (const key of Object.values(CLUE_PREF_KEYS)) {
      expect(fields[key]?.meta?.volatile, key).toBe(true)
    }
  })
})

describe('client parse of the clue switches', () => {
  it('falls back to the defaults when the fields are absent', () => {
    const parsed = parsePrefs({})
    expect(parsed.clueSourcesEnabled).toEqual({})
    expect(parsed.clueSourcesMentionEnabled).toEqual({})
    expect(parsed.cluePacksMentionEnabled).toBe(true)
    expect(parsed).toEqual(SIDEBAR_PREFS_DEFAULTS)
  })

  it('drops non-object maps and non-boolean entries', () => {
    const parsed = parsePrefs({
      clueSourcesEnabled: { on: true, off: false, bad: 'yes' },
      clueSourcesMentionEnabled: ['nope'],
      cluePacksMentionEnabled: 'yes',
    })
    expect(parsed.clueSourcesEnabled).toEqual({ on: true, off: false })
    expect(parsed.clueSourcesMentionEnabled).toEqual({})
    expect(parsed.cluePacksMentionEnabled).toBe(true)
  })

  it('keeps an explicit false for the pack switch', () => {
    expect(parsePrefs({ cluePacksMentionEnabled: false }).cluePacksMentionEnabled).toBe(false)
  })
})

describe('shared missing-entry-means-ON helpers', () => {
  const prefs = (overrides: Partial<SidebarPrefs>): SidebarPrefs => ({ ...SIDEBAR_PREFS_DEFAULTS, ...overrides })

  it('enables an unlisted source and honors only an explicit false', () => {
    expect(isClueSourceEnabled(prefs({}), 'builtin.files')).toBe(true)
    expect(isClueSourceEnabled(prefs({ clueSourcesEnabled: { 'builtin.files': false } }), 'builtin.files')).toBe(false)
    expect(isClueSourceEnabled(prefs({ clueSourcesEnabled: { other: false } }), 'builtin.files')).toBe(true)
  })

  it('enables unlisted @ entries and defaults the pack switch to true', () => {
    expect(isClueSourceMentionEnabled(prefs({}), 'builtin.files')).toBe(true)
    expect(isClueSourceMentionEnabled(prefs({ clueSourcesMentionEnabled: { 'builtin.files': false } }), 'builtin.files')).toBe(false)
    expect(isCluePacksMentionEnabled(prefs({}))).toBe(true)
    expect(isCluePacksMentionEnabled(prefs({ cluePacksMentionEnabled: false }))).toBe(false)
  })
})
