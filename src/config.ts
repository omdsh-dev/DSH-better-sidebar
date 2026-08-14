/**
 * Serializable configuration and defaults for the sidebar host half. Loader
 * schema validation normally fills defaults; {@link resolveSidebarConfig}
 * applies the same defaults for direct callers that bypass the Loader.
 * @module dsh-better-sidebar/config
 */

import z from 'schemastery'
import {
  GITHUB_POLL_SECONDS_DEFAULT,
  GITHUB_POLL_SECONDS_MAX,
  GITHUB_POLL_SECONDS_MIN,
  SIDEBAR_PREFS_DEFAULTS,
  SIDEBAR_PREFS_NS,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  WIDTH_PERCENT_DEFAULT,
  WIDTH_PERCENT_MAX,
  WIDTH_PERCENT_MIN,
  type SidebarPrefs,
} from './prefs-shared.ts'
import {
  GITHUB_API_BASE_DEFAULT,
  GITHUB_PER_PAGE_MAX,
  GITHUB_POLL_FLOOR_MIN,
} from './github.ts'

export {
  GITHUB_POLL_SECONDS_DEFAULT,
  GITHUB_POLL_SECONDS_MAX,
  GITHUB_POLL_SECONDS_MIN,
  SIDEBAR_PREFS_DEFAULTS,
  SIDEBAR_PREFS_NS,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  WIDTH_PERCENT_DEFAULT,
  WIDTH_PERCENT_MAX,
  WIDTH_PERCENT_MIN,
  type SidebarPrefs,
} from './prefs-shared.ts'

/** Tunable sidebar host limits (every field optional; defaults fill in). */
export interface SidebarConfig {
  /** Read cap of one text file (bytes); larger files return truncated. */
  readLimit?: number
  /** Media route cap (bytes); larger binaries are refused. */
  mediaLimit?: number
  /** Explorer row bound of one level. */
  listLimit?: number
  /** Terminals per session. */
  terminalsPerSession?: number
  /** How long a disconnected terminal process survives awaiting a reconnect. */
  reconnectGraceMs?: number
  /**
   * Explicit GitHub personal access token for the built-in GitHub tab.
   * Prefer the gh CLI login or the GITHUB_TOKEN / GH_TOKEN environment
   * variables (the resolution chain tries those when this stays unset);
   * set it only when neither works for the deployment. The token never
   * leaves the host process.
   */
  githubToken?: string
  /** GitHub REST base URL (override for GitHub Enterprise Server). */
  githubApiBase?: string
  /**
   * The human web origin the GitHub tab derives thread links from. Defaults
   * to github.com for the public API base, or the api base minus a trailing
   * /api/v3; set it explicitly for GHES deployments that serve the web UI
   * from a different origin/path than the API base implies.
   */
  githubWebBase?: string
  /**
   * Floor of the effective GitHub poll interval in seconds. The host also
   * honors GitHub's own X-Poll-Interval (which grows under load), so the
   * real cadence is never below the larger of the two.
   */
  githubPollFloorSeconds?: number
  /** Inbox threads fetched per poll (GitHub caps at 50). */
  githubPerPage?: number
  /**
   * Whether the Merge action is available in the GitHub tab. OFF by
   * default: merging is irreversible, so a deployment opts in explicitly
   * and the tab still shows CI status plus a confirmation before merging.
   */
  githubAllowMerge?: boolean
}

/** Schemastery schema for the plugin configuration. */
export const Config: z<SidebarConfig> = z.object({
  readLimit: z.number().step(1).min(1).default(512 * 1024),
  mediaLimit: z.number().step(1).min(1).default(20 * 1024 * 1024),
  listLimit: z.number().step(1).min(1).default(1000),
  terminalsPerSession: z.number().step(1).min(1).default(3),
  reconnectGraceMs: z.number().step(1).min(0).default(30_000),
  githubToken: z.string().default(''),
  githubApiBase: z.string().default(GITHUB_API_BASE_DEFAULT),
  githubWebBase: z.string().default(''),
  githubPollFloorSeconds: z.number().step(1).min(GITHUB_POLL_FLOOR_MIN).default(GITHUB_POLL_FLOOR_MIN),
  githubPerPage: z.number().step(1).min(1).max(GITHUB_PER_PAGE_MAX).default(GITHUB_PER_PAGE_MAX),
  githubAllowMerge: z.boolean().default(false),
})

/** Fully defaulted sidebar host settings. */
export interface ResolvedSidebarConfig {
  readLimit: number
  mediaLimit: number
  listLimit: number
  terminalsPerSession: number
  reconnectGraceMs: number
  githubToken?: string
  githubApiBase: string
  githubWebBase?: string
  githubPollFloorSeconds: number
  githubPerPage: number
  githubAllowMerge: boolean
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
    listLimit: config?.listLimit ?? 1000,
    terminalsPerSession: config?.terminalsPerSession ?? 3,
    reconnectGraceMs: config?.reconnectGraceMs ?? 30_000,
    ...(config?.githubToken !== undefined && config.githubToken !== '' ? { githubToken: config.githubToken } : {}),
    githubApiBase: config?.githubApiBase ?? GITHUB_API_BASE_DEFAULT,
    ...(config?.githubWebBase !== undefined && config.githubWebBase !== '' ? { githubWebBase: config.githubWebBase } : {}),
    githubPollFloorSeconds: config?.githubPollFloorSeconds ?? GITHUB_POLL_FLOOR_MIN,
    githubPerPage: config?.githubPerPage ?? GITHUB_PER_PAGE_MAX,
    githubAllowMerge: config?.githubAllowMerge ?? false,
  }
}

// ── User-facing "Side card" preferences ─────────────────────────────────────

/** Schemastery schema for the user-facing preferences (validated by the settings service). */
export const PrefsSchema: z<SidebarPrefs> = z.object({
  openByDefault: z.boolean().default(true),
  defaultWidthPercent: z.number().step(1).min(WIDTH_PERCENT_MIN).max(WIDTH_PERCENT_MAX).default(WIDTH_PERCENT_DEFAULT),
  autoOpenSubagent: z.boolean().default(true),
  autoOpenJobs: z.boolean().default(true),
  agentTerminalTools: z.boolean().default(false),
  bottomPanelAutoTerminal: z.boolean().default(true),
  terminalFontFamily: z.string().default(''),
  terminalFontSize: z.number().step(1).min(TERMINAL_FONT_SIZE_MIN).max(TERMINAL_FONT_SIZE_MAX).default(TERMINAL_FONT_SIZE_DEFAULT),
  interceptOpenPath: z.boolean().default(true),
  htmlViewerNoSandbox: z.boolean().default(false),
  htmlViewerDefaultUnsafe: z.boolean().default(false),
  browserNoSandbox: z.boolean().default(false),
  browserInterceptLinks: z.boolean().default(true),
  githubShowReviewRequested: z.boolean().default(true),
  githubShowPrActivity: z.boolean().default(true),
  githubShowComments: z.boolean().default(true),
  githubShowCi: z.boolean().default(false),
  githubShowOther: z.boolean().default(true),
  githubPollSeconds: z.number().step(1).min(GITHUB_POLL_SECONDS_MIN).max(GITHUB_POLL_SECONDS_MAX).default(GITHUB_POLL_SECONDS_DEFAULT),
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
