/**
 * External open actions for the file tree's "open with" menu: hand a path to
 * the OS file manager (reveal/select) or launch a URL scheme's registered
 * handler (vscode://, cursor://, zed://, custom schemes).
 *
 * The client runs in a browser / DSH Desktop renderer where a raw `vscode://`
 * navigation is unreliable, so both actions fan out through this host route
 * and spawn the platform opener with an argv array (no shell interpolation).
 * The command builders are pure — the platform is injectable — so every
 * per-platform branch is unit-testable without spawning anything.
 */
import { execSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parentOf, requireAbsolute } from './fs-tree.ts'
import { SidebarError } from './wire.ts'

/** The two external open actions the route accepts. */
export type OpenExternalAction = 'reveal' | 'url'

/** One platform opener invocation (argv array — never a shell string). */
export interface ExternalCommand {
  command: string
  args: string[]
}

/** Reveal/select a path in the OS file manager. On Linux there is no common
 *  select protocol — the containing directory is opened instead (KISS). */
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

/** Cache the Zed executable path after first lookup. */
let zedPathMemo: string | null | undefined

/**
 * Find the Zed executable on Windows by checking well-known install
 * locations and PATH entries synchronously, falling back to the
 * `zed://` protocol handler's registry entry. The registry fallback
 * uses execSync which may fail under sandboxed DSH hosts, so the
 * filesystem checks come first.
 */
export function findZedPath(): string | null {
  if (zedPathMemo !== undefined) return zedPathMemo

  const candidates: string[] = [
    // Common install paths (checked first for speed)
    'D:\\soft\\Zed\\bin\\zed.exe',
    'D:\\soft\\Zed\\bin\\Zed.exe',
    'D:\\soft\\Zed\\Zed.exe',
  ]

  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    candidates.push(
      join(localAppData, 'Programs', 'Zed', 'bin', 'zed.exe'),
      join(localAppData, 'Programs', 'Zed', 'Zed.exe'),
      join(localAppData, 'Zed', 'bin', 'zed.exe'),
      join(localAppData, 'Zed', 'Zed.exe'),
    )
  }

  const programFiles = process.env.ProgramFiles
  if (programFiles) candidates.push(join(programFiles, 'Zed', 'Zed.exe'))

  const programFilesX86 = process.env['ProgramFiles(x86)']
  if (programFilesX86) candidates.push(join(programFilesX86, 'Zed', 'Zed.exe'))

  const userProfile = process.env.USERPROFILE
  if (userProfile) {
    candidates.push(
      join(userProfile, 'scoop', 'apps', 'zed', 'current', 'Zed.exe'),
      join(userProfile, 'scoop', 'shims', 'zed.exe'),
    )
  }

  // Walk every directory in PATH
  const pathEnv = process.env.PATH || ''
  for (const dir of pathEnv.split(';')) {
    if (!dir) continue
    candidates.push(join(dir, 'zed.exe'), join(dir, 'Zed.exe'))
  }

  // Deduplicate and check existence
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    try {
      if (existsSync(candidate)) {
        zedPathMemo = candidate
        return candidate
      }
    } catch { /* permission denied — skip */ }
  }

  // Registry fallback: read the zed:// protocol handler
  try {
    const out = execSync(
      'powershell -NoProfile -Command "& {get-itemproperty \'HKCU:\\Software\\Classes\\zed\\shell\\open\\command\' \'(default)\' 2>$null} | select -expand \'(default)\' -first 1"',
      { encoding: 'utf-8', timeout: 3000, windowsHide: true },
    ).trim()
    const m = out.match(/^"([^"]+\.exe)"/)
    if (m && existsSync(m[1])) { zedPathMemo = m[1]; return m[1] }
  } catch { /* fall through */ }
  try {
    const out = execSync(
      'powershell -NoProfile -Command "& {get-itemproperty \'HKLM:\\SOFTWARE\\Classes\\zed\\shell\\open\\command\' \'(default)\' 2>$null} | select -expand \'(default)\' -first 1"',
      { encoding: 'utf-8', timeout: 3000, windowsHide: true },
    ).trim()
    const m = out.match(/^"([^"]+\.exe)"/)
    if (m && existsSync(m[1])) { zedPathMemo = m[1]; return m[1] }
  } catch { /* fall through */ }

  zedPathMemo = null
  return null
}

/** Extract a Windows file path from a `zed://file/C:/path` URL, normalizing
 *  to native backslash format. Handles both bare and leading-slash forms
 *  (`/C:/…`) that URL parsers produce. */
export function zedUrlToPath(url: string): string | null {
  const prefix = 'zed://file/'
  if (!url.startsWith(prefix)) return null
  let raw = url.slice(prefix.length)
  try { raw = decodeURI(raw) } catch { /* keep as-is */ }
  // URL parsers produce /C:/... from zed://file/C:/...
  raw = raw.replace(/^\/([a-zA-Z]:)/, '$1')
  return raw.replace(/\//g, '\\')
}

/** Hand a custom-scheme URL to the OS protocol handler. */
export function urlCommand(url: string, platform: NodeJS.Platform = process.platform): ExternalCommand {
  // Zed on Windows does not correctly parse zed://file/C:/path URLs.
  // Bypass the protocol handler and launch Zed directly with the file path.
  if (platform === 'win32' && url.startsWith('zed://')) {
    const zedPath = findZedPath()
    const filePath = zedUrlToPath(url)
    if (zedPath && filePath) {
      return { command: zedPath, args: [filePath] }
    }
    // Fall through to rundll32 if zed not found
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
 *  http/https — those would only dump the URL into a browser tab). */
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
 * stdio). Spawn failures are reported through the child's 'error' event —
 * by then the route already returned, so the event is swallowed (the OS
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
