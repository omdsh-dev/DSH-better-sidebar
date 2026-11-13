/**
 * S8 copy parity: the grouped settings/source/install/authorization copy must
 * exist in EVERY shipped dictionary (zh + en + the 19 lazy-chunk languages).
 *
 * The global locales spec already enforces key-set equality against `zh`; this
 * spec pins the S8 surface specifically so a future key addition cannot ship
 * with only zh/en, and it verifies the `{placeholder}` tokens every
 * interpolation site relies on (`{source}`, `{path}`, …) survive translation —
 * a missing placeholder would silently render a value-less sentence.
 */
import { describe, expect, it } from 'vitest'
import { en, zh, type CopyKey } from '../src/client/locales.ts'
import { localeDicts } from '../src/client/chunks/locale.tsx'

/** Every S8-introduced key (settings groups + sources + states + config). */
const S8_KEYS = [
  'settingsGroupTabs', 'settingsGroupSources', 'settingsGroupAppearance',
  'clueSettingsGroupsAria',
  'clueSourcesIntro', 'clueSourcesEnableAll', 'clueSourcesDisableAll',
  'clueSourcesMentionAll', 'clueSourcesMentionNone', 'clueSourcesBatchScope',
  'clueSourceToggleAria', 'clueSourceMentionAria', 'clueSourceConfigureAria',
  'clueConfigure', 'cluePacksName', 'cluePacksMentionAria', 'cluePacksDesc',
  'clueSourcesEmpty', 'clueSourcesLoadFailed', 'clueSourcesUnavailable',
  'clueAddSource', 'clueAddSourceDesc',
  'clueSourceCatalogGithubName', 'clueSourceCatalogGithubDesc',
  'clueSourceCatalogGithubCategory',
  'clueSourceCatalogFeishuName', 'clueSourceCatalogFeishuDesc',
  'clueSourceCatalogFeishuCategory',
  'clueStateUnchecked', 'clueStateMissing', 'clueStateIncompatible',
  'clueStateInstalling', 'clueStateNotConfigured', 'clueStateNotAuthorized',
  'clueStateAuthorizing', 'clueStateAuthExpired', 'clueStateRequestFailed',
  'clueStateReady',
  'clueConfigTitle', 'clueDependencyHeading', 'clueDependencyActualPath',
  'clueDependencyVersion', 'clueDependencyCompat', 'clueDependencyRequirement',
  'clueDependencyManualPath', 'clueDependencyPathPlaceholder',
  'clueDependencyPathInvalid', 'clueDependencyClearPath',
  'clueDependencyRecheck', 'clueDependencyApplyPath', 'clueDependencyInstall',
  'clueDependencyNotInstalled', 'clueDependencyPlanTitle',
  'clueDependencyPlanTarget', 'clueDependencyPlanConfirm',
  'clueDependencyPlanPlatform', 'clueDependencyPlanDistribution',
  'clueDistributionArchive', 'clueDistributionNpm', 'clueDistributionNone',
  'clueDependencyPlanSystemInstall', 'clueDependencyPlanSystemInstallNone',
  'clueDependencyPlanSystemInstallCompatible',
  'clueDependencyPlanSystemInstallIncompatible',
  'clueDependencyPlanExpires',
  'clueDependencyInstallCancel', 'clueDependencyInstallUnavailable',
  'clueDependencyManualInstall', 'clueDependencyInstallFailed',
  'clueDependencyInstallCancelled',
  'clueStageQueued', 'clueStageDownloading', 'clueStageVerifying',
  'clueStageExtracting', 'clueStageProbing',
  'clueActionDownloadArchive', 'clueActionVerifySha256', 'clueActionExtractArchive',
  'clueActionInstallNpmLocal', 'clueActionProbeVersion', 'clueActionReplaceManagedCopy',
  'clueConnectionHeading', 'clueConnectionConfiguration', 'clueConnectionAuthorization',
  'clueConnectionAccount', 'clueConnectionAuthorize', 'clueConnectionReconnect',
  'clueConnectionGrantScope', 'clueConnectionCancel', 'clueConnectionCheck',
  'clueConnectionUrl', 'clueConnectionCode', 'clueConnectionQrPayload',
  'clueConnectionExpires', 'clueConnectionDenied', 'clueConnectionScope',
  'clueConnectionQrAria', 'clueConnectionLastKnown',
] as const satisfies readonly CopyKey[]

/** Placeholder names each interpolated S8 key must keep. */
const PLACEHOLDERS: Partial<Record<(typeof S8_KEYS)[number], readonly string[]>> = {
  clueSourceToggleAria: ['source'],
  clueSourceMentionAria: ['source'],
  clueSourceConfigureAria: ['source'],
  clueConfigTitle: ['source'],
  clueDependencyRequirement: ['minimum', 'recommended'],
  clueDependencyPlanTitle: ['name', 'version'],
  clueDependencyPlanTarget: ['path'],
  clueConnectionExpires: ['time'],
  clueDependencyPlanExpires: ['time'],
}

/** Every shipped dictionary, zh/en included. */
function dictionaries(): Record<string, Record<string, string>> {
  return { zh, en, ...localeDicts }
}

describe('S8 copy across every shipped locale', () => {
  it('carries every S8 key in zh, en and all 19 lazy dictionaries', () => {
    const dictionariesByLang = dictionaries()
    expect(Object.keys(dictionariesByLang)).toHaveLength(21)
    for (const [lang, dict] of Object.entries(dictionariesByLang)) {
      for (const key of S8_KEYS) {
        expect(dict[key], `${lang}:${key}`).toBeTypeOf('string')
        expect(dict[key]!.trim(), `${lang}:${key}`).not.toBe('')
      }
    }
  })

  it('keeps every placeholder token in every translation', () => {
    for (const [lang, dict] of Object.entries(dictionaries())) {
      for (const [key, names] of Object.entries(PLACEHOLDERS)) {
        for (const name of names) {
          expect(dict[key], `${lang}:${key} must keep {${name}}`).toContain(`{${name}}`)
        }
      }
    }
  })

  it('keeps the English and Chinese copy distinct where it should branch (no silent key fallback)', () => {
    // A few keys are exercised by the DOM specs in English; zh must actually
    // translate them rather than repeating the key name.
    for (const key of ['settingsGroupSources', 'clueStateReady', 'clueDependencyRecheck', 'clueSourceCatalogFeishuName'] as const) {
      expect(zh[key]).not.toBe(en[key])
      expect(en[key]).not.toBe(key)
    }
  })
})
