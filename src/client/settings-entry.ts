/**
 * Settings entry selection for dsh-better-sidebar.
 *
 * The plugin's preferences surface has two possible homes:
 *
 * - **Family mode** (`webUiSettings` present — the dsh-web-ui family bundle
 *   with dsh-web-ui-settings is installed): the settings live in the family
 *   "Web UI 插件" group as the `web-ui.plugin.item` card, and the plugin's
 *   own "Side card" section in the DSH Settings shell (the generic gear nav
 *   row) is NOT registered, so there is exactly one settings entry.
 * - **Standalone mode**: the "Side card" section (`settings.section`) with
 *   the localized nav icon, as before.
 *
 * Detection happens once at apply time via `ctx.get('webUiSettings')`. In
 * the family bundle the aggregate patch rows are ordered so dsh-web-ui-
 * settings applies first (its row leads the aggregate patch), which makes
 * the service visible at better-sidebar apply time. Mixed standalone
 * installs have no ordering guarantee: when the service is not yet
 * registered, the section (gear) is registered as usual and the family card
 * stays inert until the family slot is declared — both entries may appear,
 * which is harmless duplication and resolves on the next reload.
 */
import type { Context } from '../context-types.ts'
import { LOCALE_NS, t } from './locales.ts'
import { registerSettingsNavIcon } from './settings-nav-icon.ts'
import { SideCardSection } from './SideCardSection.tsx'
import { FamilySettingsCard } from './FamilySettingsCard.tsx'
import type { SidebarStore } from './state.ts'
import type { BetterSidebarService } from './service.ts'

/** Which settings entry the plugin registers. */
export type SettingsEntryTarget = 'family-card' | 'section'

/** Pick the settings entry for the current deployment (pure). */
export function settingsEntryTarget(hasFamilySettings: boolean): SettingsEntryTarget {
  return hasFamilySettings ? 'family-card' : 'section'
}

/** The business face both entry components need. */
export interface SettingsEntryDeps {
  store: SidebarStore
  service: BetterSidebarService
}

/** The family card order inside the Web UI plugin group (aionui's band). */
export const FAMILY_CARD_ORDER = 110

/**
 * Register the plugin's settings entry for this deployment.
 * @param ctx - client root context (slots/effect).
 * @param opts - the injected business face + the family detection result.
 */
export function registerSettingsEntry(
  ctx: Context,
  opts: SettingsEntryDeps & { hasFamilySettings: boolean },
): void {
  const { store, service, hasFamilySettings } = opts
  if (settingsEntryTarget(hasFamilySettings) === 'family-card') {
    // The family group card hosts the settings; no settings.section row.
    ctx.slots.inject('web-ui.plugin.item', () => ctx.slots.register({
      name: 'web-ui.plugin.item',
      id: 'better-sidebar',
      order: FAMILY_CARD_ORDER,
      locale: LOCALE_NS,
      label: () => t('settingsNav'),
      inject: () => ({ store, service }),
    }, FamilySettingsCard))
    return
  }
  // Standalone: the "Side card" section in the DSH Settings shell. DSH 0.1.x
  // does not yet carry an icon through the settings.section registration
  // contract: its shell renders a generic gear for every external section.
  // Mark only this plugin's localized nav row so layout.css can paint the
  // requested Side card SVG; the disposer clears the marker on HMR disable.
  ctx.effect(
    () => registerSettingsNavIcon(() => t('settingsNav')),
    'dsh-better-sidebar: settings navigation icon',
  )
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'better-sidebar',
    order: 100,
    label: () => t('settingsNav'),
    inject: () => ({ store, service }),
  }, SideCardSection))
}
