/**
 * The plugin's structural read of the HOST's browser terminal service
 * (`ctx.webTerminals`, provided by `@deepseek-ai/dsh-api-terminal-controller`'s
 * client half on the web profile).
 *
 * The plugin does NOT own a PTY stack any more (v0.21.1 yielded the terminal to
 * DSH's own right-Sidebar type): the bottom workbench's terminal drives the
 * host's session-scoped terminals through this service, and the host keeps
 * process lifetime, screen recovery and reconnection.
 *
 * Detection is STRUCTURAL and by name only — the plugin never imports the host
 * package (the client-bundle purity gate forbids `@deepseek-ai/*` value
 * imports outside the platform module table), and `webTerminals` is
 * deliberately NOT in `package.json#dsh.client.inject`: a deployment without
 * the service must still activate the plugin (a missing injected service leaves
 * the whole row `pending`), so the terminal tab degrades instead.
 *
 * The shapes mirror the pinned host package (`dsh-api-terminal-controller`
 * 0.2.0-rc.1, `lib/types/client/{index,model}.d.ts` + `lib/types/types.d.ts`):
 *
 * - `view(sessionId, key, contentId, terminalId?, shellPath?)` returns the
 *   STABLE model for one occurrence (`key` memoizes it; repeating a call is
 *   free) and allocates the terminal eagerly on first call. `contentId` is the
 *   persistence key: the service remembers `(sessionId, contentId) -> host
 *   terminal id` in `localStorage`, so passing the same `contentId` after a
 *   page reload ADOPTS the saved process instead of allocating a new one —
 *   unless an explicit `terminalId` is given, which wins.
 * - `mount()` attaches the DOM lifetime and returns a DETACH callback; the
 *   process survives unmount (only `close()` ends it).
 * - `state.render` is the next screen frame awaiting
 *   {@link HostTerminalView.acknowledge}; the service will not publish the
 *   following frame until it is acknowledged, so the emulator's write callback
 *   is what releases the stream.
 * - `write` / `resize` are refused unless the view is currently `writable`
 *   (the host serializes input across windows per attachment).
 */
import type { Context } from '../context-types.ts'

/** A host terminal identity, unique per Session and host lifetime. */
export type WebTerminalId = string

/** Host-owned terminal state; process exit never creates a replacement shell. */
export interface HostTerminalInfo {
  readonly id: WebTerminalId
  readonly title: string
  /** Initial working directory; a shell's own `cd` does not update it. */
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly state: 'running' | 'exited' | 'failed'
  readonly exitCode: number | null
  readonly error?: string
}

/** Working directory and limits shared by new and restored terminals. */
export interface HostTerminalEnvironment {
  readonly cwd: string
  readonly maxInputBytes: number
  readonly maxCols: number
  readonly maxRows: number
  readonly scrollback: number
}

/**
 * Every attachment begins with a complete bounded screen (the host serializes
 * the emulator's screen), then ordered output; `state` frames only carry
 * metadata. This is why the view REPLAYS `screen` rather than appending it.
 */
export type HostTerminalFrame =
  | { readonly type: 'snapshot'; readonly sequence: number; readonly screen: string; readonly info: HostTerminalInfo }
  | { readonly type: 'output'; readonly sequence: number; readonly data: string }
  | { readonly type: 'state'; readonly info: HostTerminalInfo }

/** Product error identifiers the host terminals UI translates. */
export type HostTerminalIssue = 'missingTerminal' | 'inputFull' | 'attachmentEnded' | 'invalidOutput' | 'terminalLimit'

/**
 * The two frame kinds that carry screen content. The host's render slot is
 * `Extract<TerminalFrame, { type: 'snapshot' | 'output' }>`: a `state` frame is
 * metadata only and never reaches the emulator.
 */
export type HostRenderFrame = Extract<HostTerminalFrame, { type: 'snapshot' | 'output' }>

/** Observable state of one occurrence. */
export interface HostTerminalViewState {
  readonly phase: 'idle' | 'loading' | 'creating' | 'connecting' | 'connected' | 'disconnected' | 'closing' | 'closed' | 'failed'
  readonly environment?: HostTerminalEnvironment | undefined
  readonly title?: string | undefined
  readonly info?: HostTerminalInfo | undefined
  /** Whether this view currently holds input/resize control. */
  readonly writable: boolean
  /** The next screen frame awaiting {@link HostTerminalView.acknowledge}. */
  readonly render?: { readonly revision: number; readonly frame: HostRenderFrame } | undefined
  readonly error?: string | undefined
  readonly issue?: HostTerminalIssue | undefined
}

/** The host's observable snapshot store face (a subset of `SnapshotStore`). */
export interface HostSnapshot<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** One terminal occurrence's model. A view survives DOM unmount. */
export interface HostTerminalView {
  readonly id: WebTerminalId
  readonly state: HostSnapshot<HostTerminalViewState>
  /** Attach the DOM lifetime; the returned detach leaves the process alive. */
  mount(): () => void
  /** Start or recover this tab (deduplicated by the service). */
  refresh(): Promise<void>
  /** Reattach with a fresh screen and regain input control. */
  connect(): void
  /** Release the next stream item after the emulator parsed this frame. */
  acknowledge(revision: number): void
  /** Serialize raw input (refused unless writable). */
  write(data: string): void
  /** Resize only from the currently writable view. */
  resize(cols: number, rows: number): void
  /** Terminate the process; the DOM lifetime is irrelevant to it. */
  close(): Promise<void>
}

/** The service slice this plugin consumes. */
export interface WebTerminalsFace {
  view(
    sessionId: string,
    key: string,
    contentId: string,
    terminalId?: WebTerminalId,
    shellPath?: string,
  ): HostTerminalView
  /**
   * Save a close intent, release the occurrence immediately and drop the
   * `(sessionId, contentId)` binding; the process cleanup outlives DOM
   * unmount and a page reload (the plugin's tab `onClose`).
   */
  close(sessionId: string, key: string, contentId: string, terminalId?: WebTerminalId): void
  /** Query host terminals without a live view or unfinished close. */
  recover(sessionId: string): Promise<HostTerminalInfo[]>
}

/**
 * The host terminal service, when this deployment mounts it.
 *
 * Structural detection (`view` + `close` + `recover` are the members this
 * plugin calls); a service that does not look like the pinned contract reads
 * as absent rather than throwing at the first keystroke.
 * @param ctx - the client context.
 */
export function webTerminals(ctx: Context): WebTerminalsFace | undefined {
  const service = ctx.get('webTerminals') as unknown as Partial<WebTerminalsFace> | undefined
  if (service === undefined || service === null) return undefined
  if (typeof service.view !== 'function' || typeof service.close !== 'function') return undefined
  if (typeof service.recover !== 'function') return undefined
  return service as WebTerminalsFace
}

/** Namespace for the plugin's own occurrence key and content identity. */
const TERMINAL_NS = 'dsh-better-sidebar:terminal-bottom'

/** The persisted `tab.meta` field holding the content-identity generation. */
const RUN_FIELD = 'terminalRun'

/**
 * The content identity of the bottom terminal at `run`.
 *
 * The host keys its recovery binding on `(sessionId, contentId)`, so a stable
 * value is what makes a page reload adopt the SAME host terminal instead of
 * allocating a new one. A "new terminal" (the run bump) deliberately changes
 * it: the old binding points at a process that is gone — a host restart, or a
 * terminal closed elsewhere — and reusing it would wedge the tab on
 * `missingTerminal` forever.
 * @param run - the content-identity generation (0 for a tab's first terminal).
 */
export function bottomTerminalContentId(run: number): string {
  return run === 0 ? TERMINAL_NS : `${TERMINAL_NS}#${run}`
}

/**
 * The occurrence key: what the host service memoizes one `TerminalView` by,
 * per session. It equals the content identity so both move together when a
 * replacement terminal is minted, and it is namespaced so it can never collide
 * with a host sidebar occurrence key (those are layout tab ids such as `tab1`).
 * @param run - the content-identity generation.
 */
export function bottomTerminalKey(run: number): string {
  return bottomTerminalContentId(run)
}

/** The content-identity generation a tab carries (absent/corrupt reads as 0). */
export function terminalRunOf(tab: { meta?: unknown }): number {
  const meta = tab.meta !== null && typeof tab.meta === 'object' && !Array.isArray(tab.meta)
    ? tab.meta as Record<string, unknown>
    : {}
  const run = meta[RUN_FIELD]
  return typeof run === 'number' && Number.isSafeInteger(run) && run >= 0 ? run : 0
}

/** The `tab.meta` patch that mints the tab's next terminal. */
export function nextTerminalMeta(tab: { meta?: unknown }): Record<string, unknown> {
  return { [RUN_FIELD]: terminalRunOf(tab) + 1 }
}

/**
 * End the tab's host terminal (the descriptor's `onClose`). Unmounting the
 * view deliberately does NOT do this — that is the host's "a view survives DOM
 * unmount" contract, and it is what lets a reload reattach — so without this
 * every closed bottom terminal would leave its shell running invisibly.
 * @param ctx - the client context.
 * @param tab - the closing tab (its `meta` names the content identity).
 * @param sessionId - the tab's session.
 */
export function closeBottomTerminal(ctx: Context, tab: { meta?: unknown }, sessionId: string): void {
  const service = webTerminals(ctx)
  if (service === undefined) return
  const run = terminalRunOf(tab)
  service.close(sessionId, bottomTerminalKey(run), bottomTerminalContentId(run))
}
