/**
 * The selection-settings document's pure contract: one unknown persisted
 * record becomes a complete, bounded settings value with the documented
 * defaults, and no stale/removed action id or malformed custom action leaks
 * through. The prompts the popup runs are read from the same value, so the
 * built-in defaults are asserted here too.
 *
 * No UI is involved: `selectionSettingsOf` is the normalization boundary
 * every reader (settings form, popup, side-chat opener) shares.
 */
import { describe, expect, it } from 'vitest'
import {
  REWRITE_ACTIONS,
  REWRITE_PROMPTS,
  selectionPrompt,
  selectionSettingsOf,
  type SelectionSettings,
} from '../src/selection-settings.ts'

/** The defaults a missing or malformed record must produce. */
const DEFAULTS: SelectionSettings = {
  enabled: true,
  autoRun: true,
  disabled: {},
  menuOrder: ['rewrite', 'translate'],
  rewriteOrder: [...REWRITE_ACTIONS],
  prompts: {},
  customActions: [],
  translationLanguage: '',
  translationModel: '',
}

/** Run the real normalizer over one raw `clues.selection` value. */
function settingsOf(selection: unknown): SelectionSettings {
  return selectionSettingsOf({
    pluginSettings: { clues: { selection: selection as Record<string, unknown> } },
  })
}

describe('selectionSettingsOf', () => {
  it('starts from complete defaults when the persisted record is absent or malformed', () => {
    const malformed: Parameters<typeof selectionSettingsOf>[0][] = [
      {},
      { pluginSettings: {} },
      { pluginSettings: { clues: {} } },
      { pluginSettings: { clues: { selection: null } } },
      { pluginSettings: { clues: { selection: ['not', 'a', 'record'] } } },
      { pluginSettings: { clues: { selection: 'not a record' } } },
      {
        pluginSettings: {
          clues: {
            selection: {
              enabled: 'no',
              autoRun: 0,
              menuOrder: 'rewrite',
              rewriteOrder: 42,
              prompts: [],
              disabled: null,
              customActions: 'none',
            },
          },
        },
      },
    ]

    for (const prefs of malformed) expect(selectionSettingsOf(prefs)).toEqual(DEFAULTS)
  })

  it('keeps valid persisted values and normalizes both action orders', () => {
    const settings = settingsOf({
      enabled: false,
      autoRun: false,
      menuOrder: ['translate', 'translate', 'bogus', 'rewrite'],
      rewriteOrder: ['shorten', 'removed-action', 'shorten', 'custom-a', 'custom-a'],
      customActions: [{ id: 'custom-a', name: 'Formal', prompt: 'Rewrite formally' }],
      prompts: { expand: 'Expand carefully', translate: 'not a rewrite action', broken: 7 },
      disabled: { expand: true, translate: false, broken: 'yes' },
      translationLanguage: 'ja',
      translationModel: 'vendor/model',
      unexpected: { nested: true },
    })

    expect(settings.enabled).toBe(false)
    expect(settings.autoRun).toBe(false)
    // Duplicates and unknown ids are dropped; every default follows in its
    // canonical order, and an accepted custom id rides at the end.
    expect(settings.menuOrder).toEqual(['translate', 'rewrite'])
    expect(settings.rewriteOrder).toEqual(['shorten', 'custom-a', 'expand', 'humanize', 'continue'])
    expect(settings.prompts).toEqual({ expand: 'Expand carefully' })
    expect(settings.disabled).toEqual({ expand: true })
    expect(settings.translationLanguage).toBe('ja')
    expect(settings.translationModel).toBe('vendor/model')
    expect(settings.customActions).toEqual([
      { id: 'custom-a', name: 'Formal', prompt: 'Rewrite formally' },
    ])
  })

  it('accepts only uniquely identified custom actions with a non-blank name and prompt', () => {
    const settings = settingsOf({
      customActions: [
        { id: 'custom-formal', name: 'Formal', prompt: 'Rewrite formally' },
        { id: 'custom-formal', name: 'Duplicate', prompt: 'Ignored duplicate' },
        { id: 'custom-bad!', name: 'Bad id', prompt: 'Ignored id' },
        { id: 'not-custom', name: 'Bad prefix', prompt: 'Ignored prefix' },
        { id: 'custom-empty', name: '   ', prompt: 'Ignored blank name' },
        { id: 'custom-blank', name: 'Name', prompt: '  ' },
        { id: 'custom-ok_1', name: 'Tighten', prompt: 'Tighten it' },
      ],
    })

    expect(settings.customActions).toEqual([
      { id: 'custom-formal', name: 'Formal', prompt: 'Rewrite formally' },
      { id: 'custom-ok_1', name: 'Tighten', prompt: 'Tighten it' },
    ])
  })

  it('bounds the custom-action list and each persisted name and prompt', () => {
    const settings = settingsOf({
      customActions: [
        { id: 'custom-long', name: 'n'.repeat(150), prompt: 'p'.repeat(9_000) },
        ...Array.from({ length: 25 }, (_, index) => ({
          id: `custom-${String(index)}`,
          name: `Name ${String(index)}`,
          prompt: `Prompt ${String(index)}`,
        })),
      ],
    })

    expect(settings.customActions).toHaveLength(20)
    expect(settings.customActions[0]).toMatchObject({ id: 'custom-long' })
    expect(settings.customActions[0]?.name).toHaveLength(100)
    expect(settings.customActions[0]?.prompt).toHaveLength(8_192)
    // The cap applies before validation: the 20th accepted entry wins.
    expect(settings.customActions.at(-1)?.id).toBe('custom-18')
  })
})

describe('selectionPrompt', () => {
  it('prefers a custom action, then a stored rewrite prompt, then the built-in default', () => {
    const settings = settingsOf({
      prompts: { expand: 'Expand with context', shorten: 'Shorten aggressively' },
      customActions: [{ id: 'custom-formal', name: 'Formal', prompt: 'Use a formal register' }],
    })

    expect(selectionPrompt(settings, 'custom-formal')).toBe('Use a formal register')
    expect(selectionPrompt(settings, 'expand')).toBe('Expand with context')
    expect(selectionPrompt(settings, 'shorten')).toBe('Shorten aggressively')
    expect(selectionPrompt(settings, 'humanize')).toBe(REWRITE_PROMPTS.humanize)
    expect(selectionPrompt(settings, 'continue')).toBe(REWRITE_PROMPTS.continue)
    expect(selectionPrompt(settings, 'translate')).toBe('')
    expect(selectionPrompt(settings, 'missing')).toBe('')
  })

  it('ships a non-empty built-in prompt for every rewrite action', () => {
    const settings = settingsOf({})
    for (const id of REWRITE_ACTIONS) {
      expect(selectionPrompt(settings, id)).toBe(REWRITE_PROMPTS[id])
      expect(selectionPrompt(settings, id)).not.toBe('')
    }
  })
})
