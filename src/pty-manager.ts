/**
 * PTY session table for the sidebar terminals. One node-pty process per
 * `${sessionId}:${tabId}` key; processes survive WebSocket disconnects
 * (page refresh, tab switch) and reconnect to the same process by key.
 * Output is mirrored into a bounded transcript ring (capped bytes) so a new
 * connection replays history before live data. Sessions die only when the
 * tab is closed or the plugin tears down.
 */
import { chmodSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { userInfo } from 'node:os'
import type { IPty } from 'node-pty'
import { loadRequiredNodePty, type NodePtyModule } from './pty-deps.ts'
import { SidebarError } from './wire.ts'

/** Per-terminal transcript bound (bytes kept for replay). */
const TRANSCRIPT_LIMIT = 1 << 20

/**
 * Restore the executable bit pnpm strips from node-pty's prebuilt
 * spawn-helper (the macOS helper that forks and sets up the pty). Without it
 * every spawn fails with `posix_spawnp failed`. Idempotent; mirrors
 * @deepseek-ai/dsh-terminal-bash's ensure-spawn-helper postinstall, run at
 * plugin activation so link-installed deployments get the fix too.
 */
export function ensureSpawnHelper(): void {
  if (process.platform === 'win32') return
  try {
    const require = createRequire(import.meta.url)
    const entry = require.resolve('node-pty')
    const packageRoot = dirname(dirname(entry))
    const candidates = [
      join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      join(packageRoot, 'build', 'Release', 'spawn-helper'),
    ]
    for (const helper of candidates) {
      if (existsSync(helper)) chmodSync(helper, 0o755)
    }
  } catch {
    // Resolution or chmod failure: the terminal surfaces its own spawn error.
  }
}

/** One live terminal. */
export interface SidebarPty {
  /** `${sessionId}:${tabId}` registry key. */
  key: string
  sessionId: string
  tabId: string
  /** The working directory the process was SPAWNED with (a reconnect that
   *  resolves a different authoritative cwd respawns instead of reusing —
   *  the page-load hydrate race can attach the real cwd after the first
   *  connect, and a shell in the wrong directory must not linger). */
  cwd: string
  pty: IPty
  /** Output accumulated since spawn (bounded; head dropped when over the limit). */
  transcript: string
  /** Whether the top-level process exited (transcript stays replayable). */
  exited: boolean
  exitCode?: number | null
}

/**
 * The terminal registry. `maxPerSession` bounds concurrent processes per
 * conversation (the client caps tabs at the same number).
 */
export class PtyManager {
  private readonly sessions = new Map<string, SidebarPty>()
  private readonly pendingCloses = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly shell: string,
    private readonly maxPerSession: number,
    private readonly shellArgs: string[] = [],
    /** The loaded node-pty module (injected so a broken install degrades instead of crashing the plugin). */
    private readonly nodePty: NodePtyModule = loadRequiredNodePty(),
  ) {}

  /** All live terminal keys of one session. */
  keysOf(sessionId: string): string[] {
    const keys: string[] = []
    for (const handle of this.sessions.values()) {
      if (handle.sessionId === sessionId) keys.push(handle.key)
    }
    return keys
  }

  /**
   * Open (or reuse) the terminal for a session/tab key. A handle whose
   * process already exited is replaced with a fresh spawn (reconnecting a
   * dead terminal must yield a live shell, not an input sink), and so is a
   * live handle whose spawn cwd differs from the now-authoritative one (the
   * first connect of a page load can arrive before the session hydrates, so
   * it fell back to the process cwd — reconnecting with the real cwd must
   * restart the shell in the right directory). Reopening also cancels any
   * pending scheduled close (a reconnect within the grace window keeps the
   * process alive).
   * @param sessionId - conversation id.
   * @param tabId - client tab id.
   * @param cwd - initial working directory (the session's cwd).
   * @param cols - initial terminal width.
   * @param rows - initial terminal height.
   * @returns the live handle.
   * @throws {SidebarError} pty-error when the per-session cap is reached.
   */
  open(
    sessionId: string,
    tabId: string,
    cwd: string,
    cols: number,
    rows: number,
    shell?: string,
    shellArgs?: string[],
  ): SidebarPty {
    const key = `${sessionId}:${tabId}`
    this.cancelClose(key)
    const existing = this.sessions.get(key)
    if (existing !== undefined && !existing.exited && existing.cwd === cwd) return existing
    if (existing !== undefined) this.close(key)
    // Zombie cleanup: a session's exited handles (shell closed, tab dropped
    // on an old host without the close frame) must not eat the quota.
    for (const [candidate, handle] of [...this.sessions]) {
      if (handle.sessionId === sessionId && handle.exited) this.close(candidate)
    }
    if (this.keysOf(sessionId).length >= this.maxPerSession) {
      throw new SidebarError('pty-error', `terminal limit reached (${this.maxPerSession}) for this session`, 400)
    }
    const handle: SidebarPty = {
      key,
      sessionId,
      tabId,
      cwd,
      pty: this.nodePty.spawn(shell ?? this.shell, shellSpawnArgs(shellArgs ?? this.shellArgs), {
        name: 'xterm-256color',
        cols: Math.max(2, Math.floor(cols)),
        rows: Math.max(2, Math.floor(rows)),
        cwd,
        env: { ...process.env },
      }),
      transcript: '',
      exited: false,
    }
    handle.pty.onData((data) => {
      handle.transcript += data
      if (handle.transcript.length > TRANSCRIPT_LIMIT) {
        handle.transcript = handle.transcript.slice(handle.transcript.length - TRANSCRIPT_LIMIT)
      }
    })
    handle.pty.onExit(({ exitCode }) => {
      handle.exited = true
      handle.exitCode = exitCode
    })
    this.sessions.set(key, handle)
    return handle
  }

  /**
   * Schedule the terminal's destruction after `delayMs`. A tab close sends
   * delay 0 (release the quota immediately); a bare socket drop (refresh,
   * crash) uses the grace period so a quick reconnect keeps the process.
   * `open()` cancels any pending close.
   */
  scheduleClose(key: string, delayMs: number): void {
    const handle = this.sessions.get(key)
    if (handle === undefined) return
    this.cancelClose(key)
    const timer = setTimeout(() => { this.close(key) }, delayMs)
    this.pendingCloses.set(key, timer)
  }

  /** Cancel a pending scheduled close (the terminal is being reopened). */
  cancelClose(key: string): void {
    const timer = this.pendingCloses.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.pendingCloses.delete(key)
    }
  }

  /** Resolve a live handle by key, or undefined. */
  get(key: string): SidebarPty | undefined {
    return this.sessions.get(key)
  }

  /** Close a terminal and drop its state (the owning tab was closed). */
  close(key: string): void {
    this.cancelClose(key)
    const handle = this.sessions.get(key)
    if (handle === undefined) return
    this.sessions.delete(key)
    try {
      handle.pty.kill()
    } catch {
      // Already exited or gone; nothing left to kill.
    }
  }

  /** Close every terminal (plugin teardown). */
  disposeAll(): void {
    for (const timer of this.pendingCloses.values()) clearTimeout(timer)
    this.pendingCloses.clear()
    for (const key of [...this.sessions.keys()]) this.close(key)
  }
}

/**
 * Inputs for {@link defaultShell} resolution. Every field is optional and
 * defaults to the live process, which keeps the no-argument call sites
 * working while tests (and exotic embedders) can pin the platform, the
 * environment, and the existence probe independently — the Windows chain
 * never executes on the ubuntu CI runners, so it is only testable through
 * these injection points.
 */
export interface ShellResolutionOptions {
  /** Platform override (defaults to `process.platform`). */
  platform?: NodeJS.Platform
  /** Environment override; the resolver only reads SHELL, DSH_SIDEBAR_SHELL, PATH, ProgramW6432, ProgramFiles, LOCALAPPDATA. */
  env?: NodeJS.ProcessEnv
  /** Explicitly configured shell (the `shell` config field); wins over every automatic source. Empty means unset. */
  explicit?: string
  /** File-existence probe override (defaults to `existsSync`). */
  exists?: (path: string) => boolean
}

/**
 * Candidate directories that may contain a `pwsh.exe` on Windows: PATH
 * entries first, then the well-known machine/user install locations
 * (including preview channels and per-user MSI/portable layouts). The
 * machine-scope search reads both `ProgramW6432` and `ProgramFiles` so a
 * 32-bit Node process — whose `ProgramFiles` points at `(x86)` — still
 * finds a 64-bit PowerShell 7 install. De-duped while preserving priority
 * order.
 */
function windowsPwshCandidateDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs: string[] = []
  const pathEntries = env.PATH
  if (pathEntries !== undefined) {
    // The win32 branch always uses the Windows PATH separator; hardcoding it
    // keeps the function testable from POSIX runners without a delimiter
    // injection point.
    for (const entry of pathEntries.split(';')) {
      const trimmed = entry.trim()
      if (trimmed !== '') dirs.push(trimmed)
    }
  }
  for (const programFiles of [env.ProgramW6432, env.ProgramFiles]) {
    if (programFiles === undefined || programFiles.trim() === '') continue
    dirs.push(join(programFiles, 'PowerShell', '7'))
    dirs.push(join(programFiles, 'PowerShell', '7-preview'))
  }
  const localAppData = env.LOCALAPPDATA
  if (localAppData !== undefined && localAppData.trim() !== '') {
    dirs.push(join(localAppData, 'Microsoft', 'PowerShell', '7'))
    dirs.push(join(localAppData, 'Microsoft', 'PowerShell', '7-preview'))
    dirs.push(join(localAppData, 'Programs', 'PowerShell', '7'))
    dirs.push(join(localAppData, 'Programs', 'PowerShell', '7-preview'))
  }
  return [...new Set(dirs)]
}

/**
 * The interactive shell for this platform, resolved like a terminal
 * emulator: an explicitly configured shell (the `shell` config field) wins,
 * then `$SHELL` on POSIX (deployment override), then the account's login
 * shell from passwd, then `/bin/bash`. The passwd step matters because
 * service managers and container inits often start dsh without `SHELL`, and
 * the tab should still open the user's login shell (e.g. zsh) instead of
 * silently degrading to bash.
 *
 * Windows previously short-circuited to `powershell.exe` (the inbox 5.1)
 * before any resolution, so PowerShell 7 users always got a legacy shell
 * without `??`/`?.`/ternary and with poor ANSI/UTF-8 defaults. The Windows
 * chain is now: explicit shell → `DSH_SIDEBAR_SHELL` env override → first
 * `pwsh.exe` found on PATH or in a known install directory → the 5.1
 * fallback (machines without PowerShell 7 keep working).
 */
export function defaultShell(options: ShellResolutionOptions = {}): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const explicit = options.explicit
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim()
  if (platform === 'win32') {
    const envShell = env.DSH_SIDEBAR_SHELL
    if (envShell !== undefined && envShell.trim() !== '') return envShell.trim()
    for (const dir of windowsPwshCandidateDirs(env)) {
      const candidate = join(dir, 'pwsh.exe')
      if (exists(candidate)) return candidate
    }
    return 'powershell.exe'
  }
  const envShell = env.SHELL
  if (envShell !== undefined && envShell.trim() !== '') return envShell.trim()
  // userInfo() throws when the uid has no passwd entry (rare chroots);
  // without a login shell there is nothing better than the bash default.
  try {
    const loginShell = userInfo().shell
    if (typeof loginShell === 'string' && loginShell.trim() !== '') return loginShell
  } catch {
    // no passwd entry: fall through to /bin/bash
  }
  return '/bin/bash'
}

/**
 * A short display name for a shell executable, used as the terminal tab
 * title. `/bin/zsh` → `zsh`, `C:\...\powershell.exe` → `powershell`.
 * Falls back to the raw value when no basename can be derived.
 */
export function shellDisplayName(shell: string): string {
  const normalized = shell.replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (base === '') return shell
  return base.replace(/\.(exe|cmd|bat)$/i, '')
}

/**
 * Spawn arguments that make the shell behave like a terminal-emulator tab:
 * POSIX shells start as login shells (`-l`) so they read the profile files
 * (`~/.profile`, `~/.zprofile`); Windows PowerShell takes no login flag.
 *
 * When explicit `configured` args are supplied they REPLACE the platform
 * defaults entirely, giving deployments full control over shell startup.
 */
export function shellSpawnArgs(configured: string[] = []): string[] {
  if (configured.length > 0) return [...configured]
  return process.platform === 'win32' ? [] : ['-l']
}
