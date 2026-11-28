/**
 * Public vocabulary of the unified window host (`ctx.betterSidebar.windows`).
 *
 * One persistent content instance may move between a floating frame and a
 * registered native sidebar resource tab. Its stable portal target moves in
 * the DOM; the page tree never remounts. The host owns the portal, geometry,
 * z-order, maximize/restore, title bar, toolbar and the stable action row;
 * a source plugin supplies identity, content, navigation pages and the
 * before-close draft guard.
 *
 * The face is deliberately node-free: the same types are shipped in the
 * browser bundle and consumed by external client plugins. Structured content
 * rides S1's clue vocabulary (`ClueFormatRenderer`), never a forced Markdown
 * conversion by the host.
 */
import type { ReactNode } from 'react'
import type { MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { ClueEditDocument, ClueReadResult, JsonValue } from '../../clues/types.ts'
import type { ViewportSize, WindowBox, WindowSize, WindowSizePreset } from './geometry.ts'

export type { ViewportSize, WindowBox, WindowSize, WindowSizePreset }

/** How a body stacks its children (`fill` by default; opt into `scroll` for logs/tables). */
export type WindowBodyLayout = 'scroll' | 'fill'

/**
 * A structured document handed to a source-registered format renderer.
 *
 * `data` is the source's original JSON value and is passed through VERBATIM:
 * the window host never converts it to Markdown. Saving stays with the source
 * (`onSave` is wired by the caller to the source's own `saveEdit`/CLI/auth
 * path); the host only carries state and invokes callbacks.
 */
export interface WindowDocumentContent {
  readonly kind: 'document'
  readonly sourceId: string
  readonly typeId: string
  readonly format: string
  readonly document: ClueEditDocument | ClueReadResult
  /** A preview is read-only by definition; no save affordance is rendered. */
  readonly readOnly?: boolean
  /** Opt-in preview/edit switching over one retained draft; starts in preview. */
  readonly presentation?: 'modes'
  /**
   * Controlled mode of a `presentation: 'modes'` document. When supplied, the
   * host renders the tab selection from this value instead of its own state;
   * `onModeChange` is the only way the reader's selection travels back.
   *
   * A caller may open a read-only PREVIEW (`readOnly: true`) and still offer
   * the Edit tab when it defines `onModeChange`: the host only mirrors the
   * request, the caller owns the lazy load and must keep a truly read-only
   * source from offering editing at all.
   */
  readonly mode?: 'preview' | 'edit'
  /** Requested switch of a controlled document (see {@link mode}). */
  onModeChange?(mode: 'preview' | 'edit'): void
  /**
   * The caller is loading the edit form after the reader chose Edit. The host
   * shows a fixed loading line in the edit pane instead of rendering the
   * renderer over a preview payload.
   */
  readonly editLoading?: boolean
  /**
   * A caller-owned summary rendered above the mode bar and outside the
   * scrolling body (e.g. body-independent resource metadata). It stays
   * mounted across preview/edit switches.
   */
  readonly header?: ReactNode
  /** Supplement below the preview body (discussion, never part of its TOC). */
  readonly afterBody?: ReactNode
  /** Wrap only the rendered preview body, e.g. body-scoped TOC / selection actions. */
  readonly bodyWrapper?: (body: ReactNode) => ReactNode
  /** Image vocabulary scoped to this document's actual origin. */
  readonly pathImages?: MarkdownPathImages
  /**
   * The document is embedded in a larger detail surface (window chrome already
   * shows the title, toolbar already shows the source link). Source renderers
   * may omit their own duplicate title/source stamp; it changes presentation
   * only, never the source data or the write path.
   */
  readonly embedded?: boolean
  /**
   * A save owned by the source is in flight (the renderer must not claim
   * success). Merged with the window/page `saving` flags into the ONE state
   * the shell and the renderer both see.
   */
  readonly saving?: boolean
  /** The source reported its last write succeeded (rendered until the next edit). */
  readonly saved?: boolean
  /** Initial/refresh load in flight: the host renders the shared loading line. */
  readonly loading?: boolean
  /** Source-reported failure/conflict copy: rendered in the same surface, above the content. */
  readonly error?: string
  onChange?(data: JsonValue): void
  onSave?(): void
}

/** What a page renders: a plain React node, or one S1 format document. */
export type WindowContent = ReactNode | WindowDocumentContent

/**
 * One page in a window's in-surface navigation stack. Pages stay MOUNTED
 * while covered, so a caller's search text, selection and uncommitted edits
 * survive a push/back round trip.
 */
export interface WindowPage {
  /** Title shown while this page is on top; absent = the window's base title. */
  title?: string
  content: WindowContent
  /** Toolbar contents (resource actions) for this page; inherited from the window when absent. */
  actions?: ReactNode
  /** Stable action row contents; inherited from the window when absent. */
  footer?: ReactNode
  bodyLayout?: WindowBodyLayout
  /** Per-page save-in-flight state (merged with the window's own flag). */
  saving?: boolean
  /** Per-page unsaved-edit state (merged with the window's own flag). */
  dirty?: boolean
  /**
   * Synchronous leave guard for `back`/`pop`: returning false keeps the page
   * and the reader's uncommitted state. A `push` does NOT consult it — the
   * covered page stays mounted, so nothing is left or lost. A caller that
   * needs async work (save/discard/cancel) renders those choices in the same
   * surface and only then calls `pop`.
   */
  onBeforeLeave?(): boolean
}

/** Open/update options of one hosted window. */
export interface WindowOpenOptions {
  /** Stable business identity (`clue:<id>`, `pack:<id>`, …) — NOT a native tab id. */
  id: string
  /** Captured on open; omitted uses the host's current session once, never on docking. */
  sessionId?: string
  title: string
  content: WindowContent
  /** Default target size; defaults to 'collection'. */
  size?: WindowSizePreset
  /** Toolbar contents (resource actions). Never placed in the title bar. */
  actions?: ReactNode
  /** Stable action row (save/cancel/insert) below the scrolling body. */
  footer?: ReactNode
  bodyLayout?: WindowBodyLayout
  /** Where the window first appears; omitted = centred. */
  anchor?: HTMLElement | null
  /**
   * Where a NEW window first appears; defaults to 'floating'. 'sidebar' docks it
   * as a right-sidebar tab when the native sidebar and a session are available,
   * and floats it otherwise. Re-opening a live id never changes its surface.
   */
  surface?: 'floating' | 'sidebar'
  /** Floating tasks that own live activity may opt out of inactive tab docking. */
  dockable?: boolean
  /** Explicit initial pixel size, overriding the preset target (still clamped). */
  initialSize?: WindowSize
  /** Resize floor; defaults to 320×240. */
  minSize?: WindowSize
  /** Unsaved-edit state (renders the title-bar dirty marker). */
  dirty?: boolean
  /** A source-owned save is in flight (rendered explicitly). */
  saving?: boolean
  /**
   * Draft guard consulted by the close control, Escape and `handle.close()`.
   * Returning false (or a rejected promise) keeps the window and its content
   * mounted; the caller then renders save/discard/cancel in this same surface.
   */
  onBeforeClose?(): boolean | Promise<boolean>
  /**
   * Called exactly once when the window actually closes. NOT called when the
   * plugin activation tears down (`dispose`): teardown is not a user close,
   * and the source that owns the window is being unloaded with it.
   */
  onClose?(): void
}

/**
 * Update fields: omitted fields are untouched, geometry is never reset.
 *
 * Content fields (`title`/`content`/`actions`/`footer`/`bodyLayout`) patch the
 * page that is ON TOP at the time of the call — the base page while nothing is
 * pushed, the pushed page otherwise — so a live page can always be refreshed.
 * `dirty`/`saving`, geometry and the close callbacks are window-level.
 */
export interface WindowUpdate {
  title?: string
  content?: WindowContent
  actions?: ReactNode
  footer?: ReactNode
  bodyLayout?: WindowBodyLayout
  dirty?: boolean
  saving?: boolean
  /** An EXPLICIT size change (recentres around the current centre). */
  size?: WindowSizePreset
  maximized?: boolean
  onBeforeClose?(): boolean | Promise<boolean>
  onClose?(): void
}

/** Page-stack operations of one window handle. */
export interface WindowNavigation {
  /**
   * Push one page; the covered page stays mounted. Refused past the page cap
   * (20 pushed pages above the base page, depth 21).
   */
  push(page: WindowPage): void
  /** Pop the top pushed page. Returns false at the base page or when its leave guard refused. */
  pop(): boolean
  /** Alias of {@link pop} for the title-bar back control. */
  back(): boolean
  canGoBack(): boolean
  /** Total pages including the base page. */
  depth(): number
}

/**
 * The caller-owned handle of one open window. Every method resolves against
 * the record this handle was minted for: after the window closes (or after a
 * new window with the same id reopens), update/focus/close are strict no-ops.
 */
export interface WindowHandle {
  readonly id: string
  update(patch: WindowUpdate): void
  focus(): void
  close(): Promise<void>
  /** Move this instance to its original session's native sidebar; false when unavailable. */
  dock?(): boolean
  /** Float this same instance and close its native tab after moving the content. */
  float?(): void
  readonly navigation: WindowNavigation
}

/** One page as the React host renders it, with its retention key. */
export interface WindowPageView {
  readonly key: string
  readonly page: WindowPage
  readonly active: boolean
}

/** One window as the React host renders it. */
export interface WindowView {
  readonly id: string
  /** Effective title (`page.title` of the top page, else the base title). */
  readonly title: string
  readonly baseTitle: string
  readonly sessionId?: string
  readonly surface: 'floating' | 'sidebar'
  readonly canDock: boolean
  /** Native body destination. The React portal target itself never changes. */
  readonly sidebarTarget?: HTMLElement
  readonly pages: readonly WindowPageView[]
  readonly activeIndex: number
  readonly content: WindowContent
  readonly actions?: ReactNode
  readonly footer?: ReactNode
  readonly bodyLayout: WindowBodyLayout
  readonly size: WindowSizePreset
  /** Resize floor the window was opened with (the shell's gesture floor). */
  readonly minSize: WindowSize
  readonly box: WindowBox
  readonly maximized: boolean
  readonly dirty: boolean
  /**
   * Effective save-in-flight state: the window flag, the active page flag and
   * the active document descriptor's own `saving` merged into one answer.
   */
  readonly saving: boolean
  readonly canGoBack: boolean
}

/** The snapshot the React host subscribes to. */
export interface WindowHostSnapshot {
  readonly windows: readonly WindowView[]
}

/**
 * The public window face: `ctx.betterSidebar.windows`.
 *
 * Opening an id that is already open focuses the existing instance and
 * returns its handle; it never mints a second window or replaces the draft.
 */
export interface BetterSidebarWindowsClientFace {
  open(options: WindowOpenOptions): WindowHandle
}

/**
 * The host controller: the public face plus the React host's plumbing.
 * @internal The extra members are installed by this plugin's single
 * {@link WindowHost} mount; consumers only call `open`.
 */
export interface WindowHostController extends BetterSidebarWindowsClientFace {
  /** @internal Subscribe to window state (the plugin's own React host). */
  subscribe(listener: () => void): () => void
  /** @internal Current render snapshot. */
  getSnapshot(): WindowHostSnapshot
  /** @internal Re-clamp every window after a viewport change. */
  setViewport(viewport: ViewportSize): void
  /** @internal Run one window's draft guard; true = the close may proceed. */
  confirmClose(id: string): Promise<boolean>
  /** @internal Remove one window and fire its `onClose` (idempotent). */
  finishClose(id: string): void
  /** @internal Controlled geometry commit from the window frame. */
  setBox(id: string, box: WindowBox): void
  /** @internal Maximize / restore one window. */
  setMaximized(id: string, maximized: boolean): void
  /** @internal Title-bar back action. */
  popPage(id: string): boolean
  /** @internal Native sidebar bridge installed for this activation. */
  attachSidebar(sidebar: WindowSidebarAdapter): () => void
  /** @internal Move a live window without replacing its content. */
  setSurface(id: string, surface: 'floating' | 'sidebar'): boolean
  /** @internal Release the old tab after the retained DOM has moved to the floating frame. */
  completeSurfaceMove(id: string): void
  /** @internal Attach/detach the native body's DOM destination. */
  setSidebarTarget(id: string, sessionId: string, target: HTMLElement | undefined): void
  /** @internal Native close path, sharing the same draft guard. */
  closeFromSidebar(id: string, sessionId: string): Promise<boolean>
  /** @internal Drop every window on plugin teardown (no `onClose` calls). */
  dispose(): void
  /**
   * @internal Whether this host follows the live `window.innerWidth/Height`.
   * False when the caller injected a viewport (tests / exotic hosts), in
   * which case the mounted React host must not overwrite it on mount.
   */
  readonly followsLiveViewport: boolean
}

/** The native adapter owns placement only; the window host remains the state owner. */
export interface WindowSidebarAdapter {
  open(id: string, sessionId: string, title: string): void
  focus(id: string, sessionId: string): void
  close(id: string, sessionId: string): void
}

/** Options of {@link createWindowHost}. */
export interface WindowHostOptions {
  /** Resolve the default session exactly once when an identity is first opened. */
  sessionId?(): string | undefined
  /** Injectable viewport for tests / exotic hosts; defaults to `window.innerWidth/innerHeight`. */
  viewport?(): ViewportSize
}
