/**
 * Serializable configuration and defaults for the sidebar host half. Loader
 * schema validation normally fills defaults; {@link resolveSidebarConfig}
 * applies the same defaults for direct callers that bypass the Loader.
 *
 * Schemastery comes from DSH, not from the public `schemastery` package, and
 * that is load-bearing rather than stylistic: only DSH's build WRAPS a
 * `meta.volatile` field in a cosmokit `Volatile` reference when it parses the
 * config. The Loader's volatile-commit path walks those references
 * (`volatileEntries` / `updateVolatile`), so a schema built with the public
 * package produces plain values, leaves the loader nothing to commit, and
 * **silently drops every live preference write** — the write reports success
 * and the effective value never changes.
 * @module dsh-better-sidebar/config
 */

import z from '@deepseek-ai/schemastery'
import {
  TITLE_BAR_STRIP_DEFAULT,
  TITLE_BAR_STRIP_MAX,
  TITLE_BAR_STRIP_MIN,
  type SidebarPrefs,
} from './prefs-shared.ts'

export {
  SIDEBAR_PREFS_DEFAULTS,
  SIDEBAR_PREFS_NS,
  TITLE_BAR_STRIP_DEFAULT,
  TITLE_BAR_STRIP_MAX,
  TITLE_BAR_STRIP_MIN,
  type SidebarPrefs,
} from './prefs-shared.ts'

/** Tunable sidebar host limits (every field optional; defaults fill in). */
export interface SidebarConfig {
  /** Read cap of one text file (bytes); larger files return truncated. */
  readLimit?: number
  /** Media route cap (bytes); larger binaries are refused. */
  mediaLimit?: number
  /**
   * Media route cap (bytes) for VIDEO files (`.mp4`, `.webm`, `.mkv`, …).
   * Clips are routinely far larger than images, so they get their own cap; the
   * route streams them with byte ranges instead of reading them whole, so this
   * is a safety bound, not a memory bound.
   */
  videoLimit?: number
  /** Upload route cap (bytes); larger files are refused without touching disk. */
  uploadLimit?: number
  /** Explorer row bound of one level. */
  listLimit?: number
}

/** Schemastery schema for the deployment-provided host limits. */
const LimitsSchema = z.object({
  readLimit: z.number().step(1).min(1).default(512 * 1024),
  mediaLimit: z.number().step(1).min(1).default(20 * 1024 * 1024),
  videoLimit: z.number().step(1).min(1).default(2 * 1024 * 1024 * 1024),
  uploadLimit: z.number().step(1).min(1).default(128 * 1024 * 1024),
  listLimit: z.number().step(1).min(1).default(1000),
})

/** Fully defaulted sidebar host settings. */
export interface ResolvedSidebarConfig {
  readLimit: number
  mediaLimit: number
  /** The media route cap for video files (see {@link SidebarConfig.videoLimit}). */
  videoLimit: number
  uploadLimit: number
  listLimit: number
}

/**
 * Apply direct-call defaults after Loader schema validation has normally run.
 *
 * @param config - Deployment-provided sidebar host settings.
 * @returns Complete settings consumed by the host half.
 */
export function resolveSidebarConfig(config: SidebarConfig | undefined): ResolvedSidebarConfig {
  return {
    readLimit: config?.readLimit ?? 512 * 1024,
    mediaLimit: config?.mediaLimit ?? 20 * 1024 * 1024,
    videoLimit: config?.videoLimit ?? 2 * 1024 * 1024 * 1024,
    uploadLimit: config?.uploadLimit ?? 128 * 1024 * 1024,
    listLimit: config?.listLimit ?? 1000,
  }
}

// ── User-facing "Side card" preferences ─────────────────────────────────────

/** Schemastery schema for the user-facing preferences (validated by the settings service). */
export const PrefsSchema: z<SidebarPrefs> = z.object({
  autoOpenSubagent: z.boolean().default(true),
  autoOpenJobs: z.boolean().default(true),
  agentOpenTools: z.boolean().default(false),
  editorExplorer: z.boolean().default(false),
  workspaceFence: z.boolean().default(true),
  titleBarScheme: z.union([z.const('auto'), z.const('web'), z.const('preset'), z.const('custom')]),
  titleBarPresetId: z.string(),
  customCss: z.string(),
  titleBarCompat: z.boolean().default(false),
  titleBarStripPx: z.number().step(1).min(TITLE_BAR_STRIP_MIN).max(TITLE_BAR_STRIP_MAX).default(TITLE_BAR_STRIP_DEFAULT),
  htmlViewerNoSandbox: z.boolean().default(false),
  htmlViewerDefaultUnsafe: z.boolean().default(false),
  // Per-feature enable switches are OPEN maps (any tab/viewer id, built-in or
  // external): an absent key means enabled, so old documents resolve to {}
  // (everything on) with no migration. Non-boolean values fail validation.
  tabsEnabled: z.dict(z.boolean()).default({}),
  viewersEnabled: z.dict(z.boolean()).default({}),
  // Plugin-owned settings blobs (v0.12.0+) are an OPEN nested map: any
  // descriptor id may carry any JSON-serializable values. This is the
  // "settings seam" opening — without it the seam would drop third-party
  // keys as unknown schema fields.
  pluginSettings: z.dict(z.dict(z.any())).default({}),
})

// ── The Loader row schema ───────────────────────────────────────────────────
//
// DSH 0.1.7 replaced the registrable settings namespace with a forms service
// over the profile's own entries: a form is addressed by the row's Loader
// entry id and read from `entry.fiber.runtime.Config`, i.e. THIS export.
// There is no longer anywhere else for the user preferences to live, so they
// are merged into the row schema beside the deployment limits.
//
// Every preference field is volatile, and BOTH halves of that matter:
//   - the Loader's `equalExceptVolatile` ignores volatile fields, so a
//     preference edit is recognised as volatile-only and takes the live-commit
//     path (`loader/volatile-update`) instead of remounting the plugin, while
//     the ordinary limit fields above keep the remount semantics they had;
//   - DSH's schemastery WRAPS a volatile field in a `Volatile` reference while
//     parsing, which is the thing that path commits into. Marking a field
//     volatile on the public schemastery build sets the same `meta` flag but
//     produces plain values, and the commit then silently has nothing to do —
//     which is why this module imports schemastery from DSH (see the header).
//
// `.volatile()` RETURNS A COPY (`extra()` does), so the marked schemas have to
// be collected — calling it for its side effect leaves every field non-volatile
// and the settings service then reports "no volatile fields" for the row.
const volatilePrefs = Object.fromEntries(
  Object.entries(PrefsSchema.dict ?? {}).map(([key, field]) => [key, field.volatile()]),
)

/**
 * Config schema of this plugin's Loader row: deployment limits plus the live
 * user preferences.
 */
export const Config = z.object({
  ...LimitsSchema.dict,
  ...volatilePrefs,
}) as z<SidebarConfig & SidebarPrefs>
