/**
 * The better-sidebar card inside the dsh-web-ui family "Web UI 插件" settings
 * group (the `web-ui.plugin.item` child slot declared by dsh-web-ui-settings).
 *
 * The family group is the settings entry when the family bundle is present:
 * this card hosts the SAME declarative settings surface as the standalone
 * "Side card" settings section (see {@link SideCardSection}), so the two
 * entry points never drift — the card is a thin adapter that hands the
 * shared store/service to the section component. The slot passes the
 * `web-ui.plugin.item` runtime share at render time; this card only consumes
 * the injected business face, exactly like the section does.
 */
import { createElement } from 'react'
import type { SidebarStore } from './state.ts'
import type { BetterSidebarService } from './service.ts'
import { SideCardSection } from './SideCardSection.tsx'

/** Injected business face: the shared store (prefs cache) + the sidebar service (registries). */
export interface FamilySettingsCardInjected {
  store: SidebarStore
  service: BetterSidebarService
}

/**
 * Render the better-sidebar settings inside the family plugin card.
 * @param props - the injected store/service (the slot runtime share is ignored).
 */
export function FamilySettingsCard({ store, service }: FamilySettingsCardInjected) {
  return createElement(SideCardSection, { store, service })
}
