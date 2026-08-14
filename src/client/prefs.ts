/**
 * Client-side read of the user-facing "Side card" preferences. The host owns
 * the namespace through the settings seam (in-process); the DSH settings RPC
 * domain only serves allowlisted namespaces to configuration clients, so the
 * client reads and writes THIS namespace through the plugin's own fenced
 * /sidebar routes instead (api.settingsGet/settingsUpdate). Any failure
 * (route rejected, namespace absent, a field of the wrong type, a value out
 * of the contract range) falls back to the schema defaults — the side card
 * must keep working exactly as composed when the settings surface is missing.
 */
import type { api } from './api.ts'
import {
  clampWidthPercent,
  SIDEBAR_PREFS_DEFAULTS,
  type SidebarPrefs,
} from '../prefs-shared.ts'

export { SIDEBAR_PREFS_DEFAULTS, clampWidthPercent }
export type { SidebarPrefs }

/** The settings wire face the preferences need (a subset of the plugin api). */
export type SidebarSettingsClient = Pick<typeof api, 'settingsGet' | 'settingsUpdate'>

/** Validate one raw resolved value into {@link SidebarPrefs}. Used for the
 * settings.get payload AND the settings.update response (both carry the
 * layered resolved value); any malformed field falls back to its default.
 * @param value - the raw resolved section from the settings wire.
 * @returns validated prefs (always well-formed).
 */
export function parsePrefs(value: unknown): SidebarPrefs {
  if (value === null || typeof value !== 'object') return { ...SIDEBAR_PREFS_DEFAULTS }
  const record = value as Record<string, unknown>
  return {
    openByDefault: typeof record.openByDefault === 'boolean'
      ? record.openByDefault
      : SIDEBAR_PREFS_DEFAULTS.openByDefault,
    defaultWidthPercent: typeof record.defaultWidthPercent === 'number' && Number.isFinite(record.defaultWidthPercent)
      ? clampWidthPercent(record.defaultWidthPercent)
      : SIDEBAR_PREFS_DEFAULTS.defaultWidthPercent,
    autoOpenSubagent: typeof record.autoOpenSubagent === 'boolean'
      ? record.autoOpenSubagent
      : SIDEBAR_PREFS_DEFAULTS.autoOpenSubagent,
    autoOpenJobs: typeof record.autoOpenJobs === 'boolean'
      ? record.autoOpenJobs
      : SIDEBAR_PREFS_DEFAULTS.autoOpenJobs,
    agentTerminalTools: typeof record.agentTerminalTools === 'boolean'
      ? record.agentTerminalTools
      : SIDEBAR_PREFS_DEFAULTS.agentTerminalTools,
    bottomPanelAutoTerminal: typeof record.bottomPanelAutoTerminal === 'boolean'
      ? record.bottomPanelAutoTerminal
      : SIDEBAR_PREFS_DEFAULTS.bottomPanelAutoTerminal,
    interceptOpenPath: typeof record.interceptOpenPath === 'boolean'
      ? record.interceptOpenPath
      : SIDEBAR_PREFS_DEFAULTS.interceptOpenPath,
    htmlViewerNoSandbox: typeof record.htmlViewerNoSandbox === 'boolean'
      ? record.htmlViewerNoSandbox
      : SIDEBAR_PREFS_DEFAULTS.htmlViewerNoSandbox,
    htmlViewerDefaultUnsafe: typeof record.htmlViewerDefaultUnsafe === 'boolean'
      ? record.htmlViewerDefaultUnsafe
      : SIDEBAR_PREFS_DEFAULTS.htmlViewerDefaultUnsafe,
    browserNoSandbox: typeof record.browserNoSandbox === 'boolean'
      ? record.browserNoSandbox
      : SIDEBAR_PREFS_DEFAULTS.browserNoSandbox,
    browserInterceptLinks: typeof record.browserInterceptLinks === 'boolean'
      ? record.browserInterceptLinks
      : SIDEBAR_PREFS_DEFAULTS.browserInterceptLinks,
    explorerExclude: stringArrayOf(record.explorerExclude),
    tabsEnabled: booleanMapOf(record.tabsEnabled),
    viewersEnabled: booleanMapOf(record.viewersEnabled),
  }
}

/**
 * Validate one string-list preference (the explorer exclude patterns). Only
 * non-empty trimmed strings survive; duplicates are dropped preserving
 * first-seen order; a non-array (or a malformed array) falls back to [].
 */
function stringArrayOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out
}

/**
 * Validate one enable-switch map (per-tab / per-viewer). Only boolean values
 * survive; a non-object or a non-boolean entry falls back to the empty map /
 * drops the entry — an absent key means the feature stays enabled.
 */
function booleanMapOf(value: unknown): Record<string, boolean> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, boolean> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'boolean') out[key] = item
  }
  return out
}

/**
 * Read the resolved side card preferences through the plugin's settings route.
 * @param settings - the settings wire face (the plugin api by default).
 * @returns validated prefs, or the schema defaults when the route rejects,
 * the namespace is absent, or a stored value violates the contract.
 */
export async function loadPrefs(settings: SidebarSettingsClient): Promise<SidebarPrefs> {
  try {
    const view = await settings.settingsGet()
    return parsePrefs(view.value)
  } catch {
    // Transport/fence rejection or a malformed response: keep the defaults.
    return { ...SIDEBAR_PREFS_DEFAULTS }
  }
}
