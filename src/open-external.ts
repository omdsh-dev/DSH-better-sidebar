/**
 * External open actions for the file tree's "open with" menu: hand a path to
 * the OS file manager (reveal/select) or launch a URL scheme's registered
 * handler (vscode://, cursor://, zed://, custom schemes).
 *
 * The client runs in a browser / DSH Desktop renderer where a raw `vscode://`
 * navigation is unreliable, so both actions fan out through this host route
 * and spawn the platform opener with an argv array (no shell interpolation).
 * WSL is special: Node reports `linux`, while the actual desktop handlers live
 * on Windows, so its commands cross the interop boundary explicitly.
 */
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parentOf, requireAbsolute } from './fs-tree.ts'
import { SidebarError } from './wire.ts'

/** The two external open actions the route accepts. */
export type OpenExternalAction = 'reveal' | 'url'

/** One platform opener invocation (argv array — never a shell string). */
export interface ExternalCommand {
  command: string
  args: string[]
}

/** Injectable WSL command seams keep the command builders pure in unit tests. */
export interface WslCommandOptions {
  wsl?: boolean
  toWindowsPath?: (path: string) => string
  windowsExecutable?: (path: string) => string
}

/**
 * Injectable Windows opener NAMES — a test-only seam, never set in production.
 *
 * Pointing them at executables that cannot exist lets the REAL `spawn` drive
 * the whole fallback chain and its failure reporting on a real Windows runtime
 * (see tests/open-external-windows.spec.ts) without launching an application:
 * a binary that does not exist cannot start a browser, an editor or a console
 * window on the runner.
 */
export interface WindowsOpenerOptions {
  /** The `cmd.exe` that runs the `start` branch. */
  cmdExecutable?: string
  /** The `rundll32.exe` that runs the `url.dll,FileProtocolHandler` branch. */
  rundll32Executable?: string
}

/** Every command-builder seam: WSL path/executable projection + Windows opener names. */
export type OpenerCommandOptions = WslCommandOptions & WindowsOpenerOptions

/** Runtime seams used only to make launch/error behavior testable off-host. */
export interface LaunchExternalOptions {
  platform?: NodeJS.Platform
  wsl?: boolean
  distroName?: string
  commandOptions?: Omit<OpenerCommandOptions, 'wsl'>
  spawn?: typeof spawn
}

/** True when this Linux host is backed by Windows Subsystem for Linux. */
export function isWslRuntime(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

/** Run WSL's built-in path translator by absolute path so
 * `appendWindowsPath=false` cannot make the helper disappear from PATH. */
function wslPath(mode: '-u' | '-w', value: string): string {
  const translated = execFileSync('/usr/bin/wslpath', [mode, value], { encoding: 'utf8' }).trim()
  if (translated === '') throw new Error(`wslpath returned no translation for ${value}`)
  return translated
}

/** Linux/WSL absolute path -> Windows path understood by Explorer. */
function windowsPathOf(path: string): string {
  return wslPath('-w', path)
}

/** Windows executable path -> its WSL mount path, without relying on PATH. */
function windowsExecutableOf(path: string): string {
  return wslPath('-u', path)
}

/** Reveal/select a path in the OS file manager. On plain Linux there is no
 * common select protocol — the containing directory is opened instead.
 * Under WSL the desktop file manager is Windows Explorer. */
export function revealCommand(
  path: string,
  platform: NodeJS.Platform = process.platform,
  options: WslCommandOptions = {},
): ExternalCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: ['-R', path] }
    // Explorer expects `/select,<path>` as one argument. Keep the spawn
    // shell-free: a command shell would reinterpret valid path characters.
    case 'win32':
      return { command: 'explorer.exe', args: [`/select,${path}`] }
    // Termux (the dominant Node runtime reporting platform "android") has no
    // desktop file manager and no xdg-open; `termux-open` hands the path to
    // Android's system open-with chooser. Fall through to the parent dir like
    // Linux: Android has no select protocol either.
    case 'android': {
      const parent = parentOf(path)
      return { command: 'termux-open', args: [parent ?? path] }
    }
    default: {
      if (options.wsl) {
        const toWindowsPath = options.toWindowsPath ?? windowsPathOf
        const windowsExecutable = options.windowsExecutable ?? windowsExecutableOf
        return {
          command: windowsExecutable('C:\\Windows\\explorer.exe'),
          args: [`/select,${toWindowsPath(path)}`],
        }
      }
      const parent = parentOf(path)
      return { command: 'xdg-open', args: [parent ?? path] }
    }
  }
}

/**
 * Characters `cmd.exe` interprets after Node has quoted each argv element for
 * CreateProcess: `cmd /c` parses the command line AGAIN, so `%VAR%` expands,
 * `&`/`|` split the command, `<`/`>` redirect, `^` escapes the next character,
 * `!` triggers delayed expansion and `"` re-balances the quoting. A URL
 * carrying any of them never reaches the `start` branch — it goes straight to
 * rundll32, which receives the URL as one argv element and interprets nothing.
 */
const CMD_METACHARACTERS = /[&%^!|<>"]/

/** C0/C1 control characters count as metacharacters too: `cmd.exe` treats a
 *  raw CR/LF as a command separator, and `validateExternalUrl` returns the
 *  RAW string (`new URL` strips those characters, so validation passes). */
const CMD_CONTROL_CHARACTERS = /\p{Cc}/u

/** Whether `cmd.exe` would reinterpret any part of this URL — i.e. the `start`
 *  branch must be skipped and rundll32 used directly. */
function cmdUnsafe(url: string): boolean {
  return CMD_METACHARACTERS.test(url) || CMD_CONTROL_CHARACTERS.test(url)
}

/**
 * The URL openers to try, best first — the Windows chain exists because the
 * `start` route and the rundll32 route fail in disjoint situations (#412:
 * rundll32 alone reported `{ started: true }` while nothing opened).
 *
 * Every entry is an argv array (never a shell string). macOS/Linux keep their
 * single opener and WSL keeps its single absolute-path Windows dispatcher (the
 * registered handlers live on the Windows side of the interop boundary): this
 * chain is a Windows fix, so their behavior is unchanged.
 */
export function urlCommands(
  url: string,
  platform: NodeJS.Platform = process.platform,
  options: OpenerCommandOptions = {},
): ExternalCommand[] {
  switch (platform) {
    case 'darwin':
      return [{ command: 'open', args: [url] }]
    case 'win32': {
      const chain: ExternalCommand[] = []
      if (!cmdUnsafe(url)) {
        // `start "" <url>`: the empty argument is the window TITLE. Without it
        // `start` treats the quoted URL as the title and opens a bare console
        // window instead of the registered handler.
        chain.push({ command: options.cmdExecutable ?? 'cmd.exe', args: ['/d', '/c', 'start', '', url] })
      }
      // url.dll,FileProtocolHandler launches the registered protocol handler
      // through ShellExecute (the route that historically worked for schemes
      // `start` refused, and vice versa).
      chain.push({
        command: options.rundll32Executable ?? 'rundll32.exe',
        args: ['url.dll,FileProtocolHandler', url],
      })
      return chain
    }
    // Termux: `termux-open-url` is the Android intent dispatcher for URLs
    // (termux-open would route through the content chooser first).
    case 'android':
      return [{ command: 'termux-open-url', args: [url] }]
    default:
      if (options.wsl) {
        const windowsExecutable = options.windowsExecutable ?? windowsExecutableOf
        return [{
          command: windowsExecutable('C:\\Windows\\System32\\rundll32.exe'),
          args: ['url.dll,FileProtocolHandler', url],
        }]
      }
      return [{ command: 'xdg-open', args: [url] }]
  }
}

/** Convert the built-in VSCode-family local-file URL to its Remote-WSL form.
 * A POSIX path produces `scheme://file//...`; keep one leading slash when it
 * moves behind the `wsl+<distro>` authority. Other custom schemes are left
 * alone and merely dispatched through the Windows protocol handler. */
export function wslRemoteEditorUrl(url: string, distroName: string): string {
  const match = /^(vscode(?:-insiders)?|cursor):\/\/file(\/\/.*)$/i.exec(url)
  if (match === null) return url
  const scheme = match[1]
  const remotePath = match[2]
  if (scheme === undefined || remotePath === undefined) return url
  const distro = distroName.trim()
  if (distro === '') {
    throw new SidebarError('internal', 'WSL_DISTRO_NAME is unavailable; cannot build a Remote-WSL editor URL', 500)
  }
  return `${scheme}://vscode-remote/wsl+${distro}${remotePath.slice(1)}`
}

/** Validate a URL-scheme open target: a parseable custom-scheme URL (never
 * http/https — those would only dump the URL into a browser tab). */
export function validateExternalUrl(raw: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw new SidebarError('bad-request', 'url must be a custom-scheme URL')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SidebarError('bad-request', 'invalid url')
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    throw new SidebarError('bad-request', 'only custom-scheme urls can be opened externally')
  }
  return raw
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One attempted launch that failed; kept for the aggregated error message. */
interface LaunchAttemptFailure {
  command: string
  error: unknown
}

/** The structured failure of an action whose EVERY opener candidate died:
 * `internal` on the wire, with each command and its underlying message named
 * so the UI (and a bug report) can carry the real cause. */
function launchFailure(action: OpenExternalAction, failures: readonly LaunchAttemptFailure[]): SidebarError {
  const subject = action === 'url' ? 'url' : 'path'
  const attempts = failures.map(f => `"${f.command}" (${messageOf(f.error)})`).join('; ')
  return new SidebarError('internal', `failed to launch external opener for the ${subject}: ${attempts}`, 500)
}

/**
 * Launch the first candidate that actually starts, in order.
 *
 * Success is reported only after Node emits `spawn`; a synchronous throw or an
 * `error` event (ENOENT, EACCES, …) advances to the next candidate. When every
 * candidate fails the promise rejects with a structured `SidebarError` naming
 * them all — the route must never answer `{ started: true }` for an open that
 * launched nothing (#412: that silent success is why the menu "did nothing").
 *
 * Note what this can and cannot see: a detached candidate that starts but
 * whose handler ignores the URL exits 0 (`start` and rundll32 both do), so the
 * chain reports everything it can observe — the launch itself.
 */
function launchChain(
  action: OpenExternalAction,
  chain: readonly ExternalCommand[],
  spawnExternal: typeof spawn,
): Promise<{ started: true }> {
  const failures: LaunchAttemptFailure[] = []
  return new Promise((resolve, reject) => {
    const attempt = (index: number): void => {
      const spec = chain[index]
      if (spec === undefined) {
        reject(launchFailure(action, failures))
        return
      }
      let child: ReturnType<typeof spawn>
      try {
        child = spawnExternal(spec.command, spec.args, { detached: true, stdio: 'ignore' })
      } catch (error) {
        failures.push({ command: spec.command, error })
        attempt(index + 1)
        return
      }
      let settled = false
      child.once('spawn', () => {
        if (settled) return
        settled = true
        resolve({ started: true })
      })
      child.once('error', (error) => {
        if (settled) return
        settled = true
        failures.push({ command: spec.command, error })
        attempt(index + 1)
      })
      child.unref()
    }
    attempt(0)
  })
}

/**
 * Launch one external open action detached from the host. Both actions fan out
 * through an ordered candidate chain (one entry on macOS/Linux/Android/WSL, the
 * two Windows URL routes on win32) and reject with the aggregated failure when
 * none of them starts.
 */
export function launchExternal(
  action: OpenExternalAction,
  value: string,
  options: LaunchExternalOptions = {},
): Promise<{ started: true }> {
  const platform = options.platform ?? process.platform
  const wsl = options.wsl ?? (platform === 'linux' && isWslRuntime())
  const commandOptions: OpenerCommandOptions = { ...options.commandOptions, wsl }

  // Validation stays synchronous and ahead of every spawn: a relative path or
  // a non-scheme URL throws here, so nothing is launched for a bad request.
  let chain: ExternalCommand[]
  if (action === 'reveal') {
    chain = [revealCommand(requireAbsolute(value), platform, commandOptions)]
  } else {
    let url = validateExternalUrl(value)
    if (wsl) url = wslRemoteEditorUrl(url, options.distroName ?? process.env.WSL_DISTRO_NAME ?? '')
    chain = urlCommands(url, platform, commandOptions)
  }

  return launchChain(action, chain, options.spawn ?? spawn)
}
