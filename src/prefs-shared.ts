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
   * MOBILE ADAPTATION (narrow viewports, `isNarrowWidth`): while the viewport
   * is narrow, do not auto-activate the Tasks page for background activity —
   * it suppresses BOTH triggers (`autoOpenSubagent` and `autoOpenJobs`) at
   * once, because on a phone the takeover costs the whole screen. The two
   * individual switches keep their own meaning on wide viewports.
   */
  mobileNoAutoOpen: boolean
  /**
   * MOBILE ADAPTATION (narrow viewports): open the Tasks page in the classic
   * TREE by default instead of the workflow graph — a narrow screen cannot
   * show a layered graph legibly, while the tree's indentation still reads.
   * It only picks the DEFAULT: the in-page view toggle still flips this
   * session's page ad hoc, and `tasksViewMode` keeps deciding on wide
   * viewports.
   */
  mobileDefaultTree: boolean
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
   * Whether the `code` editor paints its uncommitted changes the way VS Code
   * does (issue #212): the line number takes the tone of its change, a thin
   * colored bar sits at the left of the numbers, and hovering a line shows
   * that line's blame as a plain-text tooltip. On by default — there is ONE
   * switch for the whole feature (no per-part toggles: no author / hash /
   * date / summary switches, no end-of-line widget).
   */
  editorGitGutter: boolean
  /**
   * VS Code `files.exclude`-style glob patterns (the editor card's gear
   * popup manages the list): matched entries are REMOVED from the file tree
   * and the name search entirely — dot-prefixed rows otherwise render
   * dimmed as usual. Supported shapes: a bare name
   * (`Thumbs.db`) at any depth, a cwd-anchored path (`build/out`), a
   * doublestar head for any depth (doublestar + slash + name), and `*` /
   * `?` wildcards.
   * Excluded entries never block the breadcrumb fold either (the host probe
   * and the listing share the one compiled matcher).
   */
  explorerExclude: string[]
  /**
   * Free-form CSS injected into the page (last in the cascade, so it can
   * override the plugin's styles; use `!important` to override JS-written
   * inline CSS variables). The escape hatch for anything the settings rows
   * do not cover — applied whenever it is non-empty.
   */
  customCss: string
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

/** The stock exclude list (VS Code ships a similar files.exclude default). */
export const EXPLORER_EXCLUDE_DEFAULTS: readonly string[] = ['.DS_Store', 'Thumbs.db']

/** Fallback prefs used whenever the settings document is unreachable or malformed. */
export const SIDEBAR_PREFS_DEFAULTS: SidebarPrefs = {
  autoOpenSubagent: true,
  autoOpenJobs: true,
  tasksViewMode: 'graph',
  // Both mobile adaptations are ON by default: a phone is the case they exist
  // for, and each one only ever changes what happens on a NARROW viewport.
  mobileNoAutoOpen: true,
  mobileDefaultTree: true,
  agentOpenTools: false,
  editorExplorer: false,
  editorGitGutter: true,
  explorerExclude: [...EXPLORER_EXCLUDE_DEFAULTS],
  customCss: '',
  htmlViewerNoSandbox: false,
  htmlViewerDefaultUnsafe: false,
  tabsEnabled: {},
  viewersEnabled: {},
  pluginSettings: {},
}
