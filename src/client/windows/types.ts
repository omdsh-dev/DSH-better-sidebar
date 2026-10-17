/**
 * Public vocabulary of the unified window host (`ctx.betterSidebar.windows`).
 *
 * This is the plugin's OWN persistent floating surface — NOT the removed
 * `floatWindows` feature (v0.19.0 removed the tab-dragging free-window system,
 * and this face does not restore it). The host owns the portal, geometry,
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
import type { ClueEditDocument, ClueReadResult, JsonValue } from '../../clues/types.ts'
import type { ViewportSize, WindowBox, WindowSize, WindowSizePreset } from './geometry.ts'

export type { ViewportSize, WindowBox, WindowSize, WindowSizePreset }

/** How a window body stacks its children (`scroll`: the body scrolls; `fill`: content takes the slack). */
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
  /** A save owned by the source is in flight (the renderer must not claim success). */
  readonly saving?: boolean
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
   * Synchronous leave guard for `back`/`pop`/`push` replacement: returning
   * false keeps the page and the reader's uncommitted state. A caller that
   * needs async work (save/discard/cancel) renders those choices in the same
   * surface and only then calls `pop`.
   */
  onBeforeLeave?(): boolean
}

/** Open/update options of one hosted window. */
export interface WindowOpenOptions {
  /** Stable business identity (`clue:<id>`, `pack:<id>`, …) — NOT a native tab id. */
  id: string
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
  /** Called exactly once when the window actually closes. */
  onClose?(): void
}

/** Update fields: omitted fields are untouched, geometry is never reset. */
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
  /** Push one page; the covered page stays mounted. Refused past the page cap. */
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
  readonly pages: readonly WindowPageView[]
  readonly activeIndex: number
  readonly content: WindowContent
  readonly actions?: ReactNode
  readonly footer?: ReactNode
  readonly bodyLayout: WindowBodyLayout
  readonly size: WindowSizePreset
  readonly box: WindowBox
  readonly maximized: boolean
  readonly dirty: boolean
  readonly saving: boolean
  /** Unified z-order slot (all floating windows, legacy ones included). */
  readonly z: number
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
  /** @internal Drop every window and its layer subscription on plugin teardown. */
  dispose(): void
}

/** Options of {@link createWindowHost}. */
export interface WindowHostOptions {
  /** Injectable viewport for tests / exotic hosts; defaults to `window.innerWidth/innerHeight`. */
  viewport?(): ViewportSize
}
