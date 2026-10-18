/**
 * The clue settings window (S9 gear deep link).
 *
 * DSH exposes no public "open the Settings dialog" service, so the gear hosts
 * S8's OWN component (`SideCardSection`) in the unified S6 window: the same
 * module, the same shared store and the same settings document as the host's
 * settings seat, never a second settings implementation. `openClueSettings`
 * publishes the one-shot group target so a mounted settings section (the
 * host's own dialog, if open) also lands on Clue sources.
 */
import { createElement } from 'react'
import type { SidebarStore } from '../../state.ts'
import type { BetterSidebarService } from '../../service.ts'
import type { BetterSidebarWindowsClientFace, WindowHandle } from '../../windows/types.ts'

import { SideCardSection } from '../../SideCardSection.tsx'
import { openClueSettings, type ClueSettingsGroup } from '../settings/navigation.ts'
import { t } from '../../locales.ts'

/** The settings window id (one instance; a second open focuses it). */
export const CLUE_SETTINGS_WINDOW_ID = 'clue-settings'

/** Options of {@link openClueSettingsWindow}. */
export interface OpenClueSettingsWindowOptions {
  readonly windows: BetterSidebarWindowsClientFace
  readonly store: SidebarStore
  readonly service: BetterSidebarService
  readonly group?: ClueSettingsGroup
}

/**
 * Open (or focus) the clue settings window on one group.
 * @param options - window host, the shared store/service and the landing group.
 */
export function openClueSettingsWindow(options: OpenClueSettingsWindowOptions): WindowHandle {
  const group = options.group ?? 'sources'
  // Keep the in-product deep link working for the host's own settings dialog.
  openClueSettings({ group })
  return options.windows.open({
    id: CLUE_SETTINGS_WINDOW_ID,
    title: t('settingsNav'),
    size: 'collection',
    content: createElement(SideCardSection, {
      store: options.store,
      service: options.service,
      initialGroup: group,
    }),
  })
}
