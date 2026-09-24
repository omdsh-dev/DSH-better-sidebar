/**
 * Shared "Side card" preference vocabulary (types + constants), consumed by
 * BOTH halves: the host registers the schemastery schema over these values
 * (config.ts) and the client reads/writes them through the settings RPC
 * (client/prefs.ts, client/SideCardSection.tsx). Kept free of schemastery so
 * the browser bundle never pulls the schema runtime in.
 */

/** The user-settings namespace holding the side card preferences. */
export const SIDEBAR_PREFS_NS = 'dsh-better-sidebar'

/** User-facing side card preferences. */
export interface SidebarPrefs {
  /**
   * Whether the sidebar auto-activates the Tasks page when the current
   * conversation spawns a new subagent.
   */
  autoOpenSubagent: boolean
  /**
   * Whether the sidebar auto-activates the Tasks page containing the
   * background-jobs section when a NEW job appears for the current
   * conversation (any new job id, not just the first one).
   */
  autoOpenJobs: boolean
  /**
   * The Tasks page's default presentation: the workflow graph canvas or the
   * classic indentation tree (the in-page toggle still flips it ad hoc).
   */
  tasksViewMode: 'graph' | 'tree'
  /**
   * Whether the model-facing `sidebar_open` tool is injected into the
   * model's toolset — one tool that lets the model actively open a local
   * file, a local folder (as a tree rooted there), or an HTTP(S) page in
   * the calling session's sidebar. Off by default: the feature stays
   * dormant until the user explicitly enables it in the side card settings.
   */
  agentOpenTools: boolean
  /**
   * Whether the editor tab runs in merged mode: a path input replaces the
   * plain header and a toggleable file-tree panel (with a global name
   * search) docks at the tab's right edge. On by default; also makes brand
   * new sessions seed an empty editor tab (tree panel open) instead of the
   * explorer tab. The switch lives under the editor card's gear in the
   * Side card settings; off restores the pre-merge editor exactly.
   */
  editorExplorer: boolean
  /**
   * Whether the sidebar's filesystem routes enforce the workspace fence:
   * every client-supplied path must resolve (through symlinks) inside the
   * session workspace, else the route answers 403 "outside workspace". On
   * by default; turning it OFF lets the file tree / editor read+write /
   * media / HTML preview / upload routes reach ANY host path (e.g. the
   * global ~/.dsh/AGENTS.md or a linked worktree outside the session cwd)
   * — the trade-off being that any same-origin script (including
   * third-party consumer plugins) can read/write outside the workspace
   * through those routes while it is off. The switch lives under the files
   * tab's gear in the Side card settings; the fence error surfaces offer a
   * one-click global off + retry.
   */
  workspaceFence: boolean
  /**
   * Title-bar / shell compatibility scheme (the "位置兼容模式" setting):
   * - `auto` (default): CONSERVATIVE — only the standard Window Controls
   *   Overlay API (present in frameless Chromium shells that draw the
   *   native caption buttons over web content) contributes real geometry;
   *   without it nothing is modified, so plain-browser (web) behavior is
   *   untouched.
   * - `web`: EXPLICIT "DSH official web" — never adapt, not even WCO
   *   geometry (the user declares they run the plain web UI).
   * - `preset`: apply the built-in shell preset named by
   *   `titleBarPresetId` (data-driven, opt-in — see shell-presets.ts).
   * - `custom`: apply the free-form `customCss` (and the legacy
   *   `titleBarStripPx` strip).
   */
  titleBarScheme: TitleBarScheme
  /**
   * The built-in shell preset id applied while `titleBarScheme` is
   * `preset` ('' = no preset — nothing extra is applied).
   */
  titleBarPresetId: string
  /**
   * Free-form CSS injected into the page (last in the cascade, so it can
   * override the plugin's styles; use `!important` to override JS-written
   * inline CSS variables). Applied while `titleBarScheme` is `custom`.
   */
  customCss: string
  /**
   * LEGACY (kept for read-migration and downgrade mirroring only): position
   * compatibility mode flag. The UI writes `titleBarScheme` instead; a
   * stored `true` without a scheme migrates to the `custom` scheme (with
   * `titleBarStripPx` preserved).
   */
  titleBarCompat: boolean
  /**
   * LEGACY (kept for read-migration and downgrade mirroring only): the
   * reserved top strip height in px used by the `custom` scheme (0–120,
   * default 40). Drives the `--dsh-title-bar-strip` CSS variable: the
   * toggle cluster drops `strip + 3px` and the right panel's content
   * starts `strip` px below its top edge.
   */
  titleBarStripPx: number
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

/** Range contract of {@link SidebarPrefs.titleBarStripPx}. */
export const TITLE_BAR_STRIP_MIN = 0
export const TITLE_BAR_STRIP_MAX = 120
export const TITLE_BAR_STRIP_DEFAULT = 40

/** The title-bar / shell compatibility schemes (see {@link SidebarPrefs.titleBarScheme}). */
export const TITLE_BAR_SCHEMES = ['auto', 'web', 'preset', 'custom'] as const
export type TitleBarScheme = typeof TITLE_BAR_SCHEMES[number]

/** Fallback prefs used whenever the settings document is unreachable or malformed. */
export const SIDEBAR_PREFS_DEFAULTS: SidebarPrefs = {
  autoOpenSubagent: true,
  autoOpenJobs: true,
  tasksViewMode: 'graph',
  agentOpenTools: false,
  editorExplorer: false,
  workspaceFence: true,
  titleBarScheme: 'auto',
  titleBarPresetId: '',
  customCss: '',
  titleBarCompat: false,
  titleBarStripPx: TITLE_BAR_STRIP_DEFAULT,
  htmlViewerNoSandbox: false,
  htmlViewerDefaultUnsafe: false,
  tabsEnabled: {},
  viewersEnabled: {},
  pluginSettings: {},
}

/** Clamp one title-bar strip height into the contract range (shared by schema and client reads). */
export function clampTitleBarStrip(value: number): number {
  return Math.min(TITLE_BAR_STRIP_MAX, Math.max(TITLE_BAR_STRIP_MIN, Math.round(value)))
}
