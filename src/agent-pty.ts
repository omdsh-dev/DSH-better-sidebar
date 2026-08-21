/**
 * Agent-owned terminal registry: a uuid-keyed table of long-lived PTY
 * sessions created by the model through the `terminal_create` tool. Each
 * handle survives across tool calls (and across WebSocket disconnects from
 * the sidebar view) until the model calls `terminal_close` or the user
 * closes the corresponding sidebar tab — tmux semantics, scoped per agent
 * session.
 *
 * This is a parallel registry to {@link PtyManager}: UI tabs are keyed by
 * `${sessionId}:${tabId}` and capped per session, while agent terminals are
 * keyed by uuid and uncapped (the model is trusted to close unused ones).
 * Both registries share the same shell resolver and spawn-helper fix.
 */
import { randomUUID } from 'node:crypto'
import type { IPty } from 'node-pty'
import { ensureSpawnHelper, shellSpawnArgs } from './pty-manager.ts'
import { loadRequiredNodePty, type NodePtyModule } from './pty-deps.ts'
import { SidebarError } from './wire.ts'

/** Per-agent-terminal transcript bound (bytes kept for replay and reads). */
const TRANSCRIPT_LIMIT = 1 << 20

/** POSIX signals the registry forwards to a live pty. */
export const ALLOWED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGTSTP'] as const
/** Signal name accepted by `signal()`. */
export type AgentTerminalSignal = (typeof ALLOWED_SIGNALS)[number]

/** Default read page size (lines) when the caller omits `count`. */
export const DEFAULT_READ_COUNT = 500

/** Smallest pty dimension the registry accepts (mirrors the tool contract). */
export const TERMINAL_DIM_MIN = 2
/** Largest pty dimension the registry accepts (mirrors the tool contract). */
export const TERMINAL_DIM_MAX = 1024

/** Clamp one cols×rows pair into the supported pty range (flooring decimals). */
export function clampDims(cols: number, rows: number): { cols: number; rows: number } {
  const clamp = (value: number): number =>
    Math.min(TERMINAL_DIM_MAX, Math.max(TERMINAL_DIM_MIN, Math.floor(value)))
  return { cols: clamp(cols), rows: clamp(rows) }
}

/**
 * Serializable snapshot of one agent terminal — the shape the model sees
 * through `terminal_list` and the sidebar sees through the push endpoint.
 * Carries no pty reference and no transcript (those are reached through
 * dedicated read/attach paths), and no sessionId: ownership is registry
 * internals, scoped by the caller (list filters by session, the push
 * endpoint scopes by its query param), never part of the serialized view.
 */
export interface AgentTerminalSnapshot {
  /** Stable opaque handle the model passes back to other terminal_* tools. */
  uuid: string
  /** Display title the model chose at create time. */
  title: string
  /** The command the model asked to run at create time (verbatim). */
  command: string
  /** Whether the top-level process has exited. */
  exited: boolean
  /** Exit code if exited normally; absent until the process exits. */
  exitCode?: number | null
  /** Exit signal name if the process was killed by a signal; null otherwise. */
  exitSignal?: string | null
}

/** Map a POSIX signal number to its conventional name (best-effort). */
const SIGNAL_NAMES: Record<number, string> = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 6: 'SIGABRT',
  9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM',
  17: 'SIGCHLD', 18: 'SIGCONT', 19: 'SIGSTOP', 20: 'SIGTSTP',
}

/** Convert a raw signal number to a name (or null when absent/unknown). */
function signalNameOf(signal: number | null | undefined): string | null {
  if (signal === null || signal === undefined) return null
  return SIGNAL_NAMES[signal] ?? `signal ${signal}`
}

/** Locate the first occurrence of `needle` in `transcript`, returning its line/column. */
function locateNeedle(transcript: string, needle: string): { line: number; column: number } | undefined {
  if (needle === '') return undefined
  const idx = transcript.indexOf(needle)
  if (idx === -1) return undefined
  // Walk the transcript up to the match index, counting newlines to derive
  // the 0-based line; the column is the offset within that line.
  let line = 0
  let lineStart = 0
  for (let i = 0; i < idx; i += 1) {
    if (transcript.charCodeAt(i) === 0x0a /* \n */) {
      line += 1
      lineStart = i + 1
    }
  }
  return { line, column: idx - lineStart }
}

/** One live agent terminal. */
export interface AgentTerminalHandle {
  /** Stable opaque handle. */
  uuid: string
  /** Owning conversation id. */
  sessionId: string
  /** Display title. */
  title: string
  /** The command written to stdin right after spawn. */
  command: string
  /** The working directory the process was spawned with. */
  cwd: string
  /** The live pty process. */
  pty: IPty
  /** Output accumulated since spawn (bounded; head dropped when over the limit). */
  transcript: string
  /** Whether the top-level process exited (transcript stays replayable). */
  exited: boolean
  /** Exit code once known. */
  exitCode?: number | null
  /** Exit signal number once known (POSIX only; undefined on Windows). */
  exitSignal?: number | null
}

/** Read result shape (mirrors the official tool-pty terminal_read contract). */
export interface AgentTerminalReadResult {
  /** The slice of transcript text for the requested page. */
  text: string
  /** Total lines in the retained transcript (the page may be a subset). */
  totalLines: number
  /** 0-based index of the first line in `text` (inclusive). */
  lineBegin: number
  /** 0-based index of the last line in `text` (exclusive). */
  lineEnd: number
}

/** Outcome of {@link AgentPtyRegistry.waitFor}. */
export type AgentTerminalWaitResult =
  | {
    /** The needle was found in the transcript. */
    kind: 'found'
    /** The matched substring. */
    needle: string
    /** 0-based line index (in the retained transcript) where the needle first appeared. */
    line: number
    /** 0-based column index within that line where the match starts. */
    column: number
    /** Elapsed wall-clock milliseconds from the wait start to the match. */
    elapsedMs: number
  }
  | {
    /** The needle did not appear before the timeout. */
    kind: 'timeout'
    /** The needle that was awaited. */
    needle: string
    /** The configured timeout in milliseconds. */
    timeoutMs: number
    /** Total lines retained when the timeout fired (call terminal_read to inspect). */
    totalLines: number
  }
  | {
    /** The terminal exited before the needle appeared. */
    kind: 'exited'
    /** The needle that was awaited. */
    needle: string
    /** The exit code, if known. */
    exitCode?: number | null
    /** The exit signal name, if the process was killed by a signal. */
    exitSignal?: string | null
  }

/** Snapshot projection of a handle (drops the pty reference and transcript). */
export function snapshotOf(handle: AgentTerminalHandle): AgentTerminalSnapshot {
  const out: AgentTerminalSnapshot = {
    uuid: handle.uuid,
    title: handle.title,
    command: handle.command,
    exited: handle.exited,
  }
  if (handle.exited) {
    out.exitCode = handle.exitCode ?? null
    out.exitSignal = signalNameOf(handle.exitSignal)
  }
  return out
}

/**
 * The agent terminal registry. The constructor takes the resolved shell
 * binary (the same `defaultShell()` the UI-tab registry uses) and runs the
 * spawn-helper chmod fix once at construction so the first agent terminal
 * does not race a lazy fixer.
 */
export class AgentPtyRegistry {
  private readonly sessions = new Map<string, AgentTerminalHandle>()
  private readonly changeListeners = new Set<() => void>()

  constructor(
    private readonly shell: string,
    private readonly shellArgs: string[] = [],
    /** The loaded node-pty module (injected so a broken install degrades instead of crashing the plugin). */
    private readonly nodePty: NodePtyModule = loadRequiredNodePty(),
  ) {
    ensureSpawnHelper()
  }

  /**
   * Spawn one agent terminal: start the shell in `cwd`, then write
   * `command + '\n'` to stdin so the command runs in the fresh shell. The
   * terminal stays alive after the command exits — the model can send more
   * input through `terminal_send` until it calls `terminal_close` or the
   * user closes the sidebar tab. An empty `command` spawns a bare shell.
   * @returns the new handle's uuid (the model-facing opaque id).
   */
  create(
    sessionId: string,
    title: string,
    command: string,
    cwd: string,
    cols = 80,
    rows = 24,
    shell?: string,
    shellArgs?: string[],
  ): string {
    const uuid = randomUUID()
    const dims = clampDims(cols, rows)
    const pty = this.nodePty.spawn(shell ?? this.shell, shellSpawnArgs(shellArgs ?? this.shellArgs), {
      name: 'xterm-256color',
      cols: dims.cols,
      rows: dims.rows,
      cwd,
      env: { ...process.env },
    })
    const handle: AgentTerminalHandle = {
      uuid,
      sessionId,
      title,
      command,
      cwd,
      pty,
      transcript: '',
      exited: false,
    }
    pty.onData((data) => {
      handle.transcript += data
      if (handle.transcript.length > TRANSCRIPT_LIMIT) {
        handle.transcript = handle.transcript.slice(handle.transcript.length - TRANSCRIPT_LIMIT)
      }
    })
    pty.onExit(({ exitCode, signal }) => {
      handle.exited = true
      handle.exitCode = exitCode
      handle.exitSignal = signal
      this.notify()
    })
    if (command !== '') {
      // Write the command + Enter so it runs in the freshly spawned shell.
      // Use \r (carriage return) — the actual character a terminal sends for
      // the Enter key — not \n (line feed). PowerShell treats a bare \n as a
      // soft line break (continuation prompt ">>") rather than a command
      // submit; \r is the cross-shell Enter semantics on both POSIX and Windows.
      try {
        pty.write(`${command}\r`)
      } catch {
        // A spawn that failed between onData and onExit surfaces its own
        // exit; the create call still returns the uuid so the model can
        // read the transcript and see the failure.
      }
    }
    this.sessions.set(uuid, handle)
    this.notify()
    return uuid
  }

  /** All live agent terminals belonging to one conversation. */
  list(sessionId: string): AgentTerminalSnapshot[] {
    const out: AgentTerminalSnapshot[] = []
    for (const handle of this.sessions.values()) {
      if (handle.sessionId === sessionId) out.push(snapshotOf(handle))
    }
    return out
  }

  /** Resolve a live handle by uuid, or throw `not-found`. */
  private expect(uuid: string): AgentTerminalHandle {
    const handle = this.sessions.get(uuid)
    if (handle === undefined) {
      throw new SidebarError('not-found', `agent terminal "${uuid}" not found`, 404)
    }
    return handle
  }

  /**
   * Resolve a live handle that belongs to `sessionId`, or throw `not-found`.
   * The model-facing tools call this before every uuid-keyed operation: a
   * uuid from another session is indistinguishable from an unknown one, so a
   * model can never reach (or probe) a terminal it does not own.
   */
  assertOwned(uuid: string, sessionId: string): AgentTerminalHandle {
    const handle = this.expect(uuid)
    if (handle.sessionId !== sessionId) {
      throw new SidebarError('not-found', `agent terminal "${uuid}" not found`, 404)
    }
    return handle
  }

  /** Resolve a handle's snapshot, or undefined if it does not exist. */
  snapshot(uuid: string): AgentTerminalSnapshot | undefined {
    const handle = this.sessions.get(uuid)
    return handle === undefined ? undefined : snapshotOf(handle)
  }

  /** Write raw text to a terminal's stdin (tmux `send-keys` semantics). */
  send(uuid: string, text: string): void {
    const handle = this.expect(uuid)
    if (handle.exited) {
      throw new SidebarError('bad-request', `agent terminal "${uuid}" has exited`, 400)
    }
    handle.pty.write(text)
  }

  /**
   * Read one bounded page of the retained transcript. `offset` is a 0-based
   * line index from the start of the retained transcript (default 0);
   * `count` caps the page size (default 500). A negative `offset` reads
   * from the end (e.g. -50 reads the last 50 lines). Returns `totalLines`
   * so the model can paginate.
   */
  read(uuid: string, offset?: number, count?: number): AgentTerminalReadResult {
    const handle = this.expect(uuid)
    const lines = handle.transcript.split('\n')
    const totalLines = lines.length
    const pageSize = Math.max(1, Math.min(count ?? DEFAULT_READ_COUNT, DEFAULT_READ_COUNT))
    let start: number
    if (offset === undefined || offset === 0) {
      start = 0
    } else if (offset < 0) {
      // Negative offset: read from the end (e.g. -50 → last 50 lines).
      start = Math.max(0, totalLines + offset)
    } else {
      start = Math.min(offset, totalLines)
    }
    const end = Math.min(start + pageSize, totalLines)
    const slice = lines.slice(start, end).join('\n')
    return {
      text: slice,
      totalLines,
      lineBegin: start,
      lineEnd: end,
    }
  }

  /**
   * Resize a terminal's pty, clamped to the 2..1024 sane range.
   * @returns the dimensions actually applied (the caller echoes these, so the
   * reported value always matches the pty).
   */
  resize(uuid: string, cols: number, rows: number): { cols: number; rows: number } {
    const handle = this.expect(uuid)
    const dims = clampDims(cols, rows)
    if (!handle.exited) handle.pty.resize(dims.cols, dims.rows)
    return dims
  }

  /**
   * Wait for `needle` to appear in a terminal's transcript, or for the
   * terminal to exit, or for the timeout to elapse — whichever happens
   * first. The wait polls the live transcript every ~50ms and short-circuits
   * on `signal` abort (re-thrown as the abort reason so the tool layer
   * surfaces cancellation).
   *
   * The match scans the FULL retained transcript on each poll, not just the
   * delta since the last poll — a needle that scrolled past the most recent
   * chunk but is still within the ~1 MiB bound is still a match. The
   * returned line/column locate the FIRST occurrence (oldest), which is what
   * a user watching the terminal would have seen first.
   *
   * The implementation uses polling (not pty onData subscription) because
   * node-pty's onData fires before the registry's own onData listener
   * updates the transcript (listener order is not guaranteed), and on
   * Windows ConPTY output can arrive in bursts with batching delays that
   * make event-driven wakeups unreliable. A 50ms poll is fast enough for
   * interactive use and simple enough to be obviously correct.
   * @param uuid - terminal to watch.
   * @param needle - substring to search for (case-sensitive, verbatim).
   * @param timeoutMs - max wait; default 10000 (10s). Clamped to ≥100ms.
   * @param signal - caller-owned cancellation; aborts the wait re-throwing.
   * @returns one of `found` / `timeout` / `exited`.
   */
  async waitFor(
    uuid: string,
    needle: string,
    timeoutMs = 10_000,
    signal?: AbortSignal,
  ): Promise<AgentTerminalWaitResult> {
    if (needle === '') {
      throw new SidebarError('bad-request', 'needle must be a non-empty string', 400)
    }
    const handle = this.expect(uuid)
    const timeout = Math.max(100, Math.floor(timeoutMs))
    const start = Date.now()
    const deadline = start + timeout
    // Fast path: already exited, or the needle is already in the transcript
    // (a `terminal_send` may have produced the expected output before this
    // call even started).
    if (handle.exited) {
      return { kind: 'exited', needle, exitCode: handle.exitCode ?? null, exitSignal: signalNameOf(handle.exitSignal) }
    }
    const firstHit = locateNeedle(handle.transcript, needle)
    if (firstHit !== undefined) {
      return { kind: 'found', needle, line: firstHit.line, column: firstHit.column, elapsedMs: Date.now() - start }
    }
    // Poll loop: check the transcript every 50ms, exit on match / exit /
    // abort / timeout. The handle is read live each iteration (its transcript
    // and exited fields mutate as the pty produces output).
    while (true) {
      if (signal?.aborted) signal.throwIfAborted()
      if (handle.exited) {
        return { kind: 'exited', needle, exitCode: handle.exitCode ?? null, exitSignal: signalNameOf(handle.exitSignal) }
      }
      const hit = locateNeedle(handle.transcript, needle)
      if (hit !== undefined) {
        return { kind: 'found', needle, line: hit.line, column: hit.column, elapsedMs: Date.now() - start }
      }
      if (Date.now() >= deadline) {
        return { kind: 'timeout', needle, timeoutMs: timeout, totalLines: handle.transcript.split('\n').length }
      }
      await new Promise(resolve => {
        const t = setTimeout(resolve, 50)
        // Allow the Node process to exit even if the timer is pending.
        if (typeof t === 'object' && 'unref' in t) (t as { unref: () => void }).unref()
      })
    }
  }

  /**
   * Send a POSIX signal to a terminal's foreground process.
   *
   * Two delivery paths, by signal kind:
   * - **Interactive control signals** (SIGINT, SIGTSTP) are delivered by
   *   writing the corresponding control character to the pty stdin. This is
   *   how a real terminal sends Ctrl+C / Ctrl+Z: the byte hits the kernel
   *   line discipline (POSIX ISIG mode) or the ConPTY input pipeline
   *   (Windows), which translates it into a SIGINT/SIGTSTP for the
   *   foreground process group. This works on every platform — calling
   *   `node-pty.kill('SIGINT')` throws on Windows and is fragile on POSIX,
   *   but writing `\x03` is universally correct.
   * - **Termination signals** (SIGKILL, SIGTERM, SIGHUP) use `pty.kill()`,
   *   which maps to the platform's process-termination path (POSIX
   *   `kill(2)`, Windows `TerminateProcess`). These cannot be faked with
   *   control characters.
   */
  signal(uuid: string, signal: AgentTerminalSignal): void {
    const handle = this.expect(uuid)
    if (handle.exited) return
    // Ctrl+C → 0x03 (ETX), Ctrl+Z → 0x1A (SUB). Writing these to the pty
    // master is the cross-platform way to deliver the signal to the
    // foreground process group through the terminal's input pipeline.
    if (signal === 'SIGINT' || signal === 'SIGTSTP') {
      const ctrlByte = signal === 'SIGINT' ? '\x03' : '\x1a'
      try {
        handle.pty.write(ctrlByte)
      } catch {
        // A pty that rejects writes is already tearing down; the next
        // onExit will mark it exited. Not an error from the caller's view.
      }
      return
    }
    // SIGKILL / SIGTERM / SIGHUP: use the process-termination path.
    try {
      handle.pty.kill(signal)
    } catch {
      // node-pty on Windows rejects named signals other than the default;
      // fall back to the default kill (TerminateProcess on Windows,
      // SIGKILL-equivalent on POSIX) so the signal still takes effect.
      try {
        handle.pty.kill()
      } catch {
        // Already exited or gone; nothing left to kill.
      }
    }
  }

  /**
   * Close a terminal and drop its state. Idempotent: a second close of the
   * same uuid is a no-op. Returns true iff a live handle was actually
   * dropped.
   */
  close(uuid: string): boolean {
    const handle = this.sessions.get(uuid)
    if (handle === undefined) return false
    this.sessions.delete(uuid)
    try {
      handle.pty.kill()
    } catch {
      // Already exited or gone; nothing left to kill.
    }
    this.notify()
    return true
  }

  /** Resolve a live handle by uuid (for the WS attach path). */
  get(uuid: string): AgentTerminalHandle | undefined {
    return this.sessions.get(uuid)
  }

  /**
   * Subscribe to registry changes (create / close / exit). The sidebar push
   * endpoint uses this to forward snapshots to the connected view. Returns
   * the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  /** Close every agent terminal (plugin teardown). */
  disposeAll(): void {
    for (const uuid of [...this.sessions.keys()]) this.close(uuid)
  }

  /** Fire every change listener (callers wrap in try/catch if needed). */
  private notify(): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener()
      } catch {
        // A listener throwing must not break the others or the registry.
      }
    }
  }
}
