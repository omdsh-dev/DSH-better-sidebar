/**
 * Serializable configuration and defaults for the sidebar host half. Loader
 * schema validation normally fills defaults; {@link resolveSidebarConfig}
 * applies the same defaults for direct callers that bypass the Loader.
 * @module dsh-better-sidebar/config
 */

import { existsSync } from 'node:fs'
import * as os from 'node:os'
import { isAbsolute, join, posix, resolve, win32 } from 'node:path'
import z from 'schemastery'
import {
  SIDEBAR_PREFS_DEFAULTS,
  SIDEBAR_PREFS_NS,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TITLE_BAR_STRIP_DEFAULT,
  TITLE_BAR_STRIP_MAX,
  TITLE_BAR_STRIP_MIN,
  WIDTH_PERCENT_DEFAULT,
  WIDTH_PERCENT_MAX,
  WIDTH_PERCENT_MIN,
  type SidebarPrefs,
} from './prefs-shared.ts'

export {
  SIDEBAR_PREFS_DEFAULTS,
  SIDEBAR_PREFS_NS,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TITLE_BAR_STRIP_DEFAULT,
  TITLE_BAR_STRIP_MAX,
  TITLE_BAR_STRIP_MIN,
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
  /** Upload route cap (bytes); larger files are refused without touching disk. */
  uploadLimit?: number
  /** Explorer row bound of one level. */
  listLimit?: number
  /** Terminals per session. */
  terminalsPerSession?: number
  /** How long a disconnected terminal process survives awaiting a reconnect. */
  reconnectGraceMs?: number
  /**
   * Terminal shell (absolute path or bare executable name) for BOTH the UI
   * terminal tabs and the model-facing `terminal_*` tools. Empty = auto:
   * POSIX follows `$SHELL` then the account login shell; Windows follows
   * `DSH_SIDEBAR_SHELL`, then probes for `pwsh.exe`, then falls back to the
   * inbox `powershell.exe` (5.1). Set it from `cordis.patch.yml` / profile
   * plugin config, e.g. `config: { shell: /bin/zsh }`.
   */
  shell?: string
  /**
   * Optional arguments passed to the shell executable. When non-empty these
   * REPLACE the automatic platform defaults (POSIX `-l` / Windows none), so
   * the deployment has full control over how the shell starts. When omitted
   * the existing default behavior is kept.
   */
  shellArgs?: string[]
  /**
   * Additional filesystem roots the sidebar may read and write outside the
   * session workspace. Each entry is an absolute path (POSIX or Windows);
   * a leading `~` expands to the host home directory (`os.homedir()`).
   * Empty strings are ignored and duplicates are removed. When omitted the
   * default is `[<homedir>/.dsh/external]` if that directory exists,
   * otherwise no extra root. An explicit `[]` disables all extra roots.
   * Non-absolute entries fail the configuration loudly.
   */
  extraRoots?: string[]
}

/** Schemastery schema for the plugin configuration. */
export const Config: z<SidebarConfig> = z.object({
  readLimit: z.number().step(1).min(1).default(512 * 1024),
  mediaLimit: z.number().step(1).min(1).default(20 * 1024 * 1024),
  uploadLimit: z.number().step(1).min(1).default(128 * 1024 * 1024),
  listLimit: z.number().step(1).min(1).default(1000),
  terminalsPerSession: z.number().step(1).min(1).default(3),
  reconnectGraceMs: z.number().step(1).min(0).default(30_000),
  shell: z.string().default(''),
  shellArgs: z.array(z.string()).default([]),
  // No .default([]): missing and explicit [] must be distinguishable — missing
  // falls back to homedir/.dsh/external (if it exists), explicit [] disables.
  extraRoots: z.array(z.string()).default(undefined as unknown as string[]),
})

/** Fully defaulted sidebar host settings. */
export interface ResolvedSidebarConfig {
  readLimit: number
  mediaLimit: number
  uploadLimit: number
  listLimit: number
  terminalsPerSession: number
  reconnectGraceMs: number
  /** The configured terminal shell; empty means the host auto-resolves it. */
  shell: string
  /** Explicit shell arguments; empty means use the platform defaults. */
  shellArgs: string[]
  /** Expanded absolute extra roots the sidebar may access (deduped, no empty strings). */
  extraRoots: string[]
}

/**
 * Apply direct-call defaults after Loader schema validation has normally run.
 *
 * @param config - Deployment-provided sidebar host settings.
 * @returns Complete settings consumed by the host half.
 */
export function resolveSidebarConfig(config: SidebarConfig | undefined): ResolvedSidebarConfig {
  const rawExtra = config?.extraRoots
  let extraRootsInput: string[]
  if (rawExtra === undefined) {
    // Default extra root: <homedir>/.dsh/external if it exists on the host.
    // Explicit [] must stay [] (fully disabled), so the existence check only
    // applies to the implicit default.
    const fallback = join(os.homedir(), '.dsh', 'external')
    extraRootsInput = existsSync(fallback) ? [fallback] : []
  } else {
    // Explicit config: keep as-is (existence not checked here, directory may
    // be mounted later); pure function over the config value.
    extraRootsInput = rawExtra
  }
  const seen = new Set<string>()
  const extraRoots: string[] = []
  for (let entry of extraRootsInput) {
    if (typeof entry !== 'string') continue
    if (entry === '') continue
    // Trim surrounding whitespace: configuration values seldom intend it.
    const trimmed = entry.trim()
    if (trimmed === '') continue
    entry = trimmed
    let expanded = entry
    if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
      expanded = expanded.replace(/^~(?=[\/\\]|$)/, os.homedir())
    } else if (expanded.startsWith('~')) {
      // A bare ~ prefix without a separator is still treated as homedir
      // expansion (e.g. "~" already handled; "~foo" is ambiguous and is not
      // expanded as user-specific homes — keep the strict check above and
      // let the absolute-path check fail loudly for non-absolute "~foo").
    }
    // Entry must be absolute after expansion (POSIX and Windows both accepted).
    const absolute = isAbsolute(expanded) || posix.isAbsolute(expanded) || win32.isAbsolute(expanded)
    if (!absolute) {
      throw new Error(`extraRoots entry "${entry}" is not an absolute path after ~ expansion: "${expanded}"`)
    }
    // Normalize to a canonical absolute path for deduplication and later
    // realpath comparisons. Use the platform-appropriate resolver so a Windows
    // absolute on a POSIX host (or vice versa) is not mangled by the wrong
    // resolver. POSIX-checked first: on POSIX a path like "/foo" is both
    // posix and win32 absolute, but must stay POSIX.
    let normalized: string
    if (posix.isAbsolute(expanded)) normalized = posix.resolve(expanded)
    else if (win32.isAbsolute(expanded)) normalized = win32.resolve(expanded)
    else normalized = resolve(expanded)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    extraRoots.push(normalized)
  }
  return {
    readLimit: config?.readLimit ?? 512 * 1024,
    mediaLimit: config?.mediaLimit ?? 20 * 1024 * 1024,
    uploadLimit: config?.uploadLimit ?? 128 * 1024 * 1024,
    listLimit: config?.listLimit ?? 1000,
    terminalsPerSession: config?.terminalsPerSession ?? 3,
    reconnectGraceMs: config?.reconnectGraceMs ?? 30_000,
    shell: config?.shell?.trim() ?? '',
    shellArgs: config?.shellArgs ?? [],
    extraRoots,
  }
}

// ── User-facing "Side card" preferences ─────────────────────────────────────

/** Schemastery schema for the user-facing preferences (validated by the settings service). */
export const PrefsSchema: z<SidebarPrefs> = z.object({
  openByDefault: z.boolean().default(false),
  defaultWidthPercent: z.number().step(1).min(WIDTH_PERCENT_MIN).max(WIDTH_PERCENT_MAX).default(WIDTH_PERCENT_DEFAULT),
  autoOpenSubagent: z.boolean().default(true),
  autoOpenJobs: z.boolean().default(true),
  agentTerminalTools: z.boolean().default(false),
  agentOpenTools: z.boolean().default(false),
  bottomPanelAutoTerminal: z.boolean().default(true),
  terminalFontFamily: z.string().default(''),
  terminalFontSize: z.number().step(1).min(TERMINAL_FONT_SIZE_MIN).max(TERMINAL_FONT_SIZE_MAX).default(TERMINAL_FONT_SIZE_DEFAULT),
  interceptOpenPath: z.boolean().default(true),
  editOpensDiff: z.boolean().default(true),
  editorExplorer: z.boolean().default(false),
  terminalShell: z.string().default(''),
  terminalShellArgs: z.string().default(''),
  titleBarScheme: z.union([z.const('auto'), z.const('web'), z.const('preset'), z.const('custom')]),
  titleBarPresetId: z.string(),
  customCss: z.string(),
  titleBarCompat: z.boolean().default(false),
  titleBarStripPx: z.number().step(1).min(TITLE_BAR_STRIP_MIN).max(TITLE_BAR_STRIP_MAX).default(TITLE_BAR_STRIP_DEFAULT),
  htmlViewerNoSandbox: z.boolean().default(false),
  htmlViewerDefaultUnsafe: z.boolean().default(false),
  browserNoSandbox: z.boolean().default(false),
  browserInterceptLinks: z.boolean().default(true),
  browserInterceptHttp: z.boolean().default(true),
  browserInterceptHttps: z.boolean().default(false),
  browserAllowedLoopback: z.string().default(''),
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
