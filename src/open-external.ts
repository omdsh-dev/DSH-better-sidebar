/**
 * External open actions for the file tree's "open with" menu: hand a path to
 * the OS file manager (reveal/select) or launch a URL scheme's registered
 * handler (vscode://, cursor://, zed://, custom schemes).
 *
 * The client runs in a browser / DSH Desktop renderer where a raw `vscode://`
 * navigation is unreliable, so both actions fan out through this host route
 * and spawn the platform opener with an argv array (no shell interpolation).
 * The command builders are pure 鈥?the platform is injectable 鈥?so every
 * per-platform branch is unit-testable without spawning anything.
 */
import { spawn, execSync } from 'node:child_process'
import { parentOf, requireAbsolute } from './fs-tree.ts'
import { SidebarError } from './wire.ts'

/** The two external open actions the route accepts. */
export type OpenExternalAction = 'reveal' | 'url'

/** One platform opener invocation (argv array 鈥?never a shell string). */
export interface ExternalCommand {
  command: string
  args: string[]
}

/** Reveal/select a path in the OS file manager. On Linux there is no common
 *  select protocol 鈥?the containing directory is opened instead (KISS). */
export function revealCommand(path: string, platform: NodeJS.Platform = process.platform): ExternalCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: ['-R', path] }
    // Explorer expects `/select,<path>` as one argument. Keep the spawn
    // shell-free: a command shell would reinterpret valid path characters.
    case 'win32':
      return { command: 'explorer.exe', args: [`/select,${path}`] }
    default: {
      const parent = parentOf(path)
      return { command: 'xdg-open', args: [parent ?? path] }
    }
  }
}

/** Cache the Zed executable path after first registry lookup. */
let zedPathMemo: string | null | undefined

/** Read the Zed executable path from the Windows registry (HKCU then HKLM). */
function findZedPath(): string | null {
  if (zedPathMemo !== undefined) return zedPathMemo
  try {
    const out = execSync(
      'powershell -NoProfile -Command "& {get-itemproperty \'HKCU:\\Software\\Classes\\zed\\shell\\open\\command\' \'(default)\' 2>$null} | select -expand \'(default)\' -first 1"',
      { encoding: 'utf-8', timeout: 3000, windowsHide: true },
    ).trim()
    // The value is something like: "D:\soft\Zed\Zed.exe" "%1"
    const m = out.match(/^"([^"]+\.exe)"/)
    if (m) { zedPathMemo = m[1]; return m[1] }
  } catch { /* fall through */ }
  try {
    const out = execSync(
      'powershell -NoProfile -Command "& {get-itemproperty \'HKLM:\\SOFTWARE\\Classes\\zed\\shell\\open\\command\' \'(default)\' 2>$null} | select -expand \'(default)\' -first 1"',
      { encoding: 'utf-8', timeout: 3000, windowsHide: true },
    ).trim()
    const m = out.match(/^"([^"]+\.exe)"/)
    if (m) { zedPathMemo = m[1]; return m[1] }
  } catch { /* fall through */ }
  zedPathMemo = null
  return null
}

/** Extract a Windows file path from a `zed://file/C:/path` URL. */
function zedUrlToPath(url: string): string | null {
  // url = zed://file/C:/dsh-ecosystem/plugins/pnpm-lock.yaml
  const prefix = 'zed://file/'
  if (!url.startsWith(prefix)) return null
  const encoded = url.slice(prefix.length)  // C:/dsh-ecosystem/plugins/pnpm-lock.yaml
  try {
    return decodeURI(encoded)
  } catch {
    return encoded
  }
}

/** Hand a custom-scheme URL to the OS protocol handler. */
export function urlCommand(url: string, platform: NodeJS.Platform = process.platform): ExternalCommand {
  // Zed on Windows does not correctly parse zed://file/C:/path URLs.
  // Read the Zed install path from the registry and launch it directly
  // with the file path as a command-line argument.
  if (platform === 'win32' && url.startsWith('zed://')) {
    const zedPath = findZedPath()
    const filePath = zedUrlToPath(url)
    if (zedPath && filePath) {
      return { command: zedPath, args: [filePath] }
    }
    // Fall through to rundll32 if registry lookup failed
  }
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] }
    // url.dll,FileProtocolHandler launches the registered protocol handler;
    // `cmd /c start "" <url>` is the fallback if rundll32 misbehaves.
    case 'win32':
      return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
    default:
      return { command: 'xdg-open', args: [url] }
  }
}

/** Validate a URL-scheme open target: a parseable custom-scheme URL (never
 *  http/https 鈥?those would only dump the URL into a browser tab). */
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

/**
 * Launch one external open action and return immediately (detached, no
 * stdio). Spawn failures are reported through the child's 'error' event 鈥? * by then the route already returned, so the event is swallowed (the OS
 * dialog about a missing handler is the user-visible outcome either way).
 */
export function launchExternal(action: OpenExternalAction, value: string): { started: true } {
  const platform = process.platform
  const spec = action === 'reveal'
    ? revealCommand(requireAbsolute(value), platform)
    : urlCommand(validateExternalUrl(value), platform)
  const child = spawn(spec.command, spec.args, { detached: true, stdio: 'ignore' })
  child.on('error', () => { /* opener missing/denied: handled by the OS */ })
  child.unref()
  return { started: true }
}
