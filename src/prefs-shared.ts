/**
 * Shared "Side card" preference vocabulary (types + constants), consumed by
 * BOTH halves: the host registers the schemastery schema over these values
 * (config.ts) and the client reads/writes them through the settings RPC
 * (client/prefs.ts, client/SideCardSection.tsx). Kept free of schemastery so
 * the browser bundle never pulls the schema runtime in.
 */

/** The user-settings namespace holding the side card preferences. */
export const SIDEBAR_PREFS_NS = 'dsh-better-sidebar'

/** User-facing side card preferences (new-conversation defaults). */
export interface SidebarPrefs {
  /** Whether a brand-new conversation opens the side card by default. */
  openByDefault: boolean
  /** Default panel width as a percent of the window width (20–60). */
  defaultWidthPercent: number
  /**
   * Whether the sidebar auto-activates (opens the panel) and expands the
   * Subagent page when the current conversation spawns a new subagent.
   */
  autoOpenSubagent: boolean
  /**
   * Whether the sidebar auto-activates (opens the panel) and expands the
   * Jobs page when a NEW background job appears for the current
   * conversation (any new job id, not just the first one).
   */
  autoOpenJobs: boolean
  /**
   * Whether the model-facing agent terminal tools (terminal_create / list /
   * send / read / wait_for / resize / signal / close) are injected into the
   * model's toolset. Off by default: the feature stays dormant until the
   * user explicitly enables it in the side card settings.
   */
  agentTerminalTools: boolean
  /**
   * Custom terminal font-family stack (a CSS font-family value, e.g.
   * `'JetBrains Mono', monospace`). Empty string follows the app's theme
   * monospace font (`--ds-font-family-code`). Applied live to every
   * terminal tab; configured under the terminal card's secondary settings.
   */
  terminalFontFamily: string
  /**
   * Custom terminal font size in px (9–32). Applied live to every terminal
   * tab; configured under the terminal card's secondary settings.
   */
  terminalFontSize: number
  /**
   * Whether expanding the bottom panel for the FIRST time in a session tries
   * to open a fresh terminal tab there (the terminal quota/type still gates
   * the attempt). On by default; the switch lives under the terminal tab's
   * row in the Side card settings.
   */
  bottomPanelAutoTerminal: boolean
  /**
   * Whether chat-side file opens (tool-row path links, the produced-files
   * row, prose file mentions — every path that funnels through the client
   * runtime's `ctx.workspaces.openPath`) open in the sidebar editor instead
   * of the Host OS's default application. On by default; the editor tab's
   * own enable switch gates it too (both must be on for the takeover).
   */
  interceptOpenPath: boolean
  /**
   * Whether the HTML previewer drops its sandboxed iframe. Sandbox ON (the
   * default) renders previewed HTML in an opaque-origin iframe that cannot
   * touch the GUI; turning it OFF runs the previewed page with the GUI's
   * own origin — full read/write access to session files and internal
   * APIs. Only for trusted local content; the setting copy warns.
   */
  htmlViewerNoSandbox: boolean
  /**
   * Whether a newly opened HTML preview starts UNSANDBOXED (the per-surface
   * temporary unlock pre-applied). Off by default: previews open sandboxed
   * and the status row offers the one-tap unlock; when on, previews open
   * in the red unsandboxed state and the status row offers a one-tap
   * restore for the current file.
   */
  htmlViewerDefaultUnsafe: boolean
  /**
   * Whether the browser tab drops its sandboxed iframe. Sandbox ON (the
   * default) keeps browsed sites in an opaque origin with no GUI access;
   * turning it OFF runs any visited site with the GUI's own origin — it
   * can read session data and act as the logged-in GUI. Only for trusted
   * sites; the setting copy warns.
   */
  browserNoSandbox: boolean
  /**
   * Whether clicking an http(s) EXTERNAL link in the GUI (chat messages,
   * tool rows, prose mentions) opens the sidebar browser instead of a new
   * browser tab. On by default; gated on the browser tab's own enable
   * switch (both must be on for the takeover). Ctrl/Cmd+click always
   * bypasses the takeover.
   */
  browserInterceptLinks: boolean
  /**
   * Comma-separated allowlist of local (loopback) authorities the browser
   * tab may navigate to — `localhost`, `127.0.0.1`, `127.0.0.1:5174`, or
   * host:port pairs. Empty by default: loopback addresses stay blocked so a
   * browsed page cannot probe local services. Each entry is either a bare
   * hostname (all ports) or host:port; the GUI's own origin is always
   * allowed regardless. The iframe sandbox still renders allowed local
   * pages in an opaque origin, exactly like any other site.
   */
  browserAllowedLoopback: string
  /**
   * Per-tab enable switches, keyed by tab descriptor id (`'explorer'`,
   * `'my-plugin:db'`). An ABSENT key means enabled — only an explicit
   * `false` disables a tab type (hidden from the + menu, `openTab` refuses,
   * and derived flows like subagent auto-open / agent-terminal tabs stop).
   * Already-open tabs of a disabled type keep rendering (closing one
   * prevents reopening), matching the "existing conversations keep their
   * own layouts" rule.
   */
  tabsEnabled: Record<string, boolean>
  /**
   * Per-viewer enable switches, keyed by file viewer descriptor id
   * (`'image'`, `'my-plugin:csv'`). An ABSENT key means enabled; a disabled
   * viewer is skipped by `matchFileViewer` so files fall through to the
   * next matching viewer (or the download button when none match).
   */
  viewersEnabled: Record<string, boolean>
  /**
   * Plugin-owned settings blobs (v0.12.0+), keyed by descriptor id: each
   * registered tab/viewer that declares `settings.pluginToggles` (or writes
   * through `settings.render`'s `updatePluginSetting`) persists its values
   * here — an open map, so third-party keys need no host PrefsSchema field.
   * Values are JSON-serializable (the row controls produce strings /
   * numbers / booleans; custom panels are responsible for their own).
   */
  pluginSettings: Record<string, Record<string, unknown>>
}

/** Range contract of {@link SidebarPrefs.defaultWidthPercent}. */
export const WIDTH_PERCENT_MIN = 20
export const WIDTH_PERCENT_MAX = 60
export const WIDTH_PERCENT_DEFAULT = 30

/** Range contract of {@link SidebarPrefs.terminalFontSize}. */
export const TERMINAL_FONT_SIZE_MIN = 9
export const TERMINAL_FONT_SIZE_MAX = 32
export const TERMINAL_FONT_SIZE_DEFAULT = 13

/** Fallback prefs used whenever the settings document is unreachable or malformed. */
export const SIDEBAR_PREFS_DEFAULTS: SidebarPrefs = {
  openByDefault: true,
  defaultWidthPercent: WIDTH_PERCENT_DEFAULT,
  autoOpenSubagent: true,
  autoOpenJobs: true,
  agentTerminalTools: false,
  bottomPanelAutoTerminal: true,
  terminalFontFamily: '',
  terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
  interceptOpenPath: true,
  htmlViewerNoSandbox: false,
  htmlViewerDefaultUnsafe: false,
  browserNoSandbox: false,
  browserInterceptLinks: true,
  browserAllowedLoopback: '',
  tabsEnabled: {},
  viewersEnabled: {},
  pluginSettings: {},
}

/** Clamp one width percent into the contract range (shared by schema and client reads). */
export function clampWidthPercent(value: number): number {
  return Math.min(WIDTH_PERCENT_MAX, Math.max(WIDTH_PERCENT_MIN, Math.round(value)))
}

/** Clamp one terminal font size into the contract range (shared by schema and client reads). */
export function clampTerminalFontSize(value: number): number {
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)))
}
