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
// The host's own shell-identity rule, shared with the settings route so the
// client and the host agree on what "the same shell" means (a bare name, an
// absolute path and an `.exe`-suffixed spelling are one shell).
import { shellKeyOf } from '../terminal-shells.ts'

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
  /**
   * The shell this process actually runs. The Host is the only authority on
   * what it started (a launch preference only expresses intent), so this is
   * what a tab title may follow. OPTIONAL: older Host builds omit it.
   */
  readonly shell?: HostShellChoice | undefined
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

/** One shell the host offers for new terminals. */
export interface HostShellChoice {
  readonly name: string
  readonly path: string
  /** Launch arguments the host resolved from the shell kind. */
  readonly args: readonly string[]
}

/** The host's shell catalog and remembered selection. */
export interface HostShellCatalog {
  readonly shells: readonly HostShellChoice[]
  /**
   * The shell the host will use when none is named. `undefined` is the host's
   * own "nothing remembered yet" answer, so it stays a required member.
   */
  readonly selectedShell: string | undefined
}

/** The service slice this plugin consumes. */
export interface WebTerminalsFace {
  /**
   * Shells the host can launch for a session (the guide card's native menu).
   * Optional: a host that only exposes the terminal view leaves the plugin
   * card as a plain tile.
   */
  launchShells?(sessionId: string, signal: AbortSignal): Promise<HostShellCatalog>
  /** Remember the shell choice for terminals opened afterwards. */
  selectShell?(path: string): void
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

/** The persisted `tab.meta` field identifying ONE terminal tab instance. */
export const INSTANCE_FIELD = 'terminalInstance'

/** The persisted `tab.meta` field holding the content-identity generation. */
const RUN_FIELD = 'terminalRun'

/**
 * The persisted `tab.meta` field holding the shell this tab was PINNED to.
 *
 * A tab remembers the shell a reader picked for IT, not the deployment-wide
 * default: the rebuild below would otherwise start the default shell on the
 * next mount and silently undo the pick. The host's own remembered preference
 * (`localStorage`) cannot carry this either — several bottom terminals share it
 * and the last one to switch would rewrite all of them.
 */
export const SHELL_FIELD = 'terminalShell'

/**
 * The content identity of the bottom terminal at `run`.
 *
 * The host keys its recovery binding on `(sessionId, contentId)`, so a stable
 * value is what makes a page reload adopt the SAME host terminal instead of
 * allocating a new one. A "new terminal" (the run bump) deliberately changes
 * it: the old binding points at a process that is gone — a host restart, or a
 * terminal closed elsewhere — and reusing it would wedge the tab on
 * `missingTerminal` forever.
 *
 * The SAME value is the occurrence key the host memoizes one view by
 * (`view(sessionId, key, contentId)`), so a run bump has to move both: the
 * namespace is what keeps it from colliding with a host layout tab id (`tab1`).
 *
 * The bottom workbench hosts SEVERAL terminals (#774 follow-up), so each tab
 * carries its own `instance`, spliced in before the run suffix: two tabs never
 * share an id and therefore never share a shell. A tab WITHOUT an instance —
 * one persisted before the follow-up — keeps the byte-identical legacy
 * identity, so its host binding still reattaches.
 * @param run - the content-identity generation (0 for a tab's first terminal).
 * @param instance - the tab's own instance id (`undefined` on legacy tabs).
 */
export function bottomTerminalContentId(run: number, instance?: string): string {
  const base = instance === undefined || instance === '' ? TERMINAL_NS : `${TERMINAL_NS}:${instance}`
  return run === 0 ? base : `${base}#${run}`
}

/** The per-tab instance id a tab carries (absent/legacy tabs read as `undefined`). */
export function terminalInstanceOf(tab: { meta?: unknown }): string | undefined {
  const meta = tab.meta !== null && typeof tab.meta === 'object' && !Array.isArray(tab.meta)
    ? tab.meta as Record<string, unknown>
    : {}
  const instance = meta[INSTANCE_FIELD]
  return typeof instance === 'string' && instance !== '' ? instance : undefined
}

/** The content-identity generation a tab carries (absent/corrupt reads as 0). */
export function terminalRunOf(tab: { meta?: unknown }): number {
  const meta = tab.meta !== null && typeof tab.meta === 'object' && !Array.isArray(tab.meta)
    ? tab.meta as Record<string, unknown>
    : {}
  const run = meta[RUN_FIELD]
  return typeof run === 'number' && Number.isSafeInteger(run) && run >= 0 ? run : 0
}

/**
 * The shell path a tab is pinned to (absent/corrupt reads as `undefined`).
 *
 * A pin belongs to ONE tab: it is what a reader picked for that terminal, and it
 * has to outlive the rebuild that applies it. `undefined` means "no pick" — the
 * tab follows the descriptor's default shell instead.
 * @param tab - the tab whose `meta` is being read.
 * @returns the pinned shell path, or `undefined` when the tab carries none.
 */
export function terminalShellOf(tab: { meta?: unknown }): string | undefined {
  const meta = tab.meta !== null && typeof tab.meta === 'object' && !Array.isArray(tab.meta)
    ? tab.meta as Record<string, unknown>
    : {}
  const shell = meta[SHELL_FIELD]
  return typeof shell === 'string' && shell !== '' ? shell : undefined
}

/**
 * The `tab.meta` patch that mints the tab's next terminal.
 *
 * The instance has to survive the bump: `patchTab` REPLACES `meta` wholesale,
 * so returning only the run field would drop `terminalInstance` and collapse
 * the tab onto the legacy identity — where every tab that bumped its run lands
 * on the same key (`…terminal-bottom#1`) and the host, which memoizes one view
 * per `(sessionId, key)`, would hand two tabs the SAME shell. Legacy tabs carry
 * no instance and get none here, so their identity stays byte-identical.
 */
export function nextTerminalMeta(tab: { meta?: unknown }, shellPath?: string): Record<string, unknown> {
  const instance = terminalInstanceOf(tab)
  // `patchTab` replaces `meta` wholesale, so every field the tab must keep has
  // to be restated here: the instance (identity) and the pinned shell (a pick
  // that has to survive the rebuild). An omitted `shellPath` keeps the pin the
  // tab already carried.
  const pinned = shellPath ?? terminalShellOf(tab)
  const shell = pinned === undefined ? {} : { [SHELL_FIELD]: pinned }
  const run = { [RUN_FIELD]: terminalRunOf(tab) + 1 }
  return instance === undefined ? { ...shell, ...run } : { [INSTANCE_FIELD]: instance, ...shell, ...run }
}

/** Shell names spelled differently on a tab chip than as an executable. */
const SHELL_SHORT_NAMES: Readonly<Record<string, string>> = { powershell: 'pwsh' }

/**
 * Shorten a host shell name for a tab chip.
 *
 * The host reports `shell.name` as it found the executable (`cmd.exe`,
 * `powershell`), which is longer than a chip wants and inconsistent about the
 * extension; this maps it to the familiar spelling.
 * @param name - `HostTerminalInfo.shell.name`, as the Host reported it.
 * @returns the bare, mapped name (e.g. `cmd.exe` → `cmd`, `powershell` → `pwsh`).
 */
export function shortShellName(name: string): string {
  const bare = name.replace(/\.exe$/iu, '')
  return SHELL_SHORT_NAMES[bare.toLowerCase()] ?? bare
}

/**
 * Find the host PATH for a shell named by the settings blob.
 *
 * The settings panel stores a NAME because that is what survives a re-install
 * (`bash` is `bash.exe` on one machine and `/bin/bash` on the next), but the host
 * only accepts a PATH it can find in its own discovery result — anything else
 * throws "Selected shell is not available in this execution environment" when
 * the PTY starts. This is the bridge between the two.
 *
 * Matching uses {@link shellKeyOf}, the host's OWN identity rule (basename,
 * no `.exe`, lower-cased), because the candidate box accepts a bare name OR an
 * absolute path: a user who types `C:\Apps\nu.exe` as the default and one who
 * types `nu` mean the same shell, and the host reports it as `nu.exe` either
 * way. Both short spellings stay accepted too — the panel may hold `powershell`
 * (a candidate name) or `pwsh` (the shortened chip label).
 * @param catalog - the host's discovery result, when it disclosed one.
 * @param name - the shell name (or path) from the descriptor's settings blob.
 * @returns the matching absolute path, or `undefined` when the host does not
 *   offer that shell (the caller then falls back to the host's own choice).
 */
export function matchShellPath(catalog: HostShellCatalog | undefined, name: string): string | undefined {
  const wanted = shellKeyOf(name)
  if (catalog === undefined || wanted === '') return undefined
  const found = catalog.shells.find(shell => shellKeyOf(shell.name) === wanted
    || shellKeyOf(shortShellName(shell.name)) === wanted)
  return found?.path
}

/**
 * End a tab's current host terminal and leave it ready to start another one.
 *
 * Closing first is what makes a shell switch mean something: the host allocates
 * a replacement PTY from its REMEMBERED shell preference, and a process that
 * already exists never re-reads it. The run bump then gives the replacement its
 * own content identity, so the host cannot adopt the binding that points at the
 * just-closed process (which would wedge the tab on `missingTerminal`).
 * @param ctx - the client context.
 * @param service - the probed host terminal service.
 * @param tab - the tab whose terminal is being replaced.
 * @param sessionId - the tab's session.
 * @param shellPath - the shell to pin the replacement to; an omitted value keeps
 *   whatever the tab already carried (so a plain restart does not un-pin it).
 */
export function restartBottomTerminal(
  ctx: Context,
  service: WebTerminalsFace,
  tab: { readonly id: string; readonly meta?: unknown },
  sessionId: string,
  shellPath?: string,
): void {
  const id = bottomTerminalContentId(terminalRunOf(tab), terminalInstanceOf(tab))
  service.close(sessionId, id, id)
  // The meta patch is what actually mints the replacement: the view memo keys
  // on the content identity, so a new run rebuilds the model against a fresh
  // occurrence and the host allocates a new process.
  ctx.get('betterSidebar')?.updateTab(tab.id, { meta: nextTerminalMeta(tab, shellPath) }, sessionId)
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
  const id = bottomTerminalContentId(terminalRunOf(tab), terminalInstanceOf(tab))
  service.close(sessionId, id, id)
}
