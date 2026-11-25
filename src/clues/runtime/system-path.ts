/** Bounded desktop/launchd PATH completion; never executes shell startup files. */
import { opendirSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/** Only one bounded NVM directory scan is performed during runtime startup. */
function nvmVersions(directory: string): string[] {
  const names: string[] = []
  try {
    const handle = opendirSync(directory)
    try {
      for (let count = 0; count < 64; count += 1) {
        const entry = handle.readSync()
        if (entry === null) break
        if (entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name)) names.push(entry.name)
      }
    } finally { handle.closeSync() }
  } catch { /* NVM is optional; do not turn discovery into a runtime failure. */ }
  return names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 32)
}

/**
 * Preserve inherited PATH order, then append the executable's directory and
 * conventional user/system bins. The returned snapshot is shared by discovery
 * and child processes so `/usr/bin/env node` npm shims see the same PATH.
 */
export function systemPathEnvironment(env: NodeJS.ProcessEnv, options: {
  readonly platform?: NodeJS.Platform
  readonly execPath?: string
  readonly userHome?: string
  readonly readNvmVersions?: (directory: string) => readonly string[]
} = {}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform
  const P = platform === 'win32' ? win32 : posix
  const delimiter = platform === 'win32' ? ';' : ':'
  const userHome = options.userHome ?? homedir()
  const execPath = options.execPath ?? process.execPath
  const paths: string[] = []
  const seen = new Set<string>()
  const add = (value: string | undefined): void => {
    if (value === undefined || !P.isAbsolute(value)) return
    const normalized = P.normalize(value)
    const key = platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key) || paths.length >= 256) return
    seen.add(key)
    paths.push(normalized)
  }
  for (const value of (env.PATH ?? env.Path ?? '').split(delimiter)) add(value)
  add(P.dirname(execPath))
  add(env.PNPM_HOME)
  if (platform === 'win32') {
    if (env.APPDATA !== undefined) add(P.join(env.APPDATA, 'npm'))
    if (env.LOCALAPPDATA !== undefined) add(P.join(env.LOCALAPPDATA, 'pnpm'))
    add(P.join(userHome, '.bun', 'bin'))
    add(P.join(userHome, 'scoop', 'shims'))
    if (env.ProgramFiles !== undefined) add(P.join(env.ProgramFiles, 'nodejs'))
  } else {
    for (const suffix of ['.local/bin', '.bun/bin', '.npm-global/bin', 'Library/pnpm', '.local/share/pnpm']) {
      add(P.join(userHome, suffix))
    }
    for (const directory of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) add(directory)
    const root = env.NVM_DIR !== undefined && P.isAbsolute(env.NVM_DIR) ? env.NVM_DIR : P.join(userHome, '.nvm')
    const versions = P.join(root, 'versions', 'node')
    for (const version of (options.readNvmVersions ?? nvmVersions)(versions).slice(0, 32)) {
      if (/^v\d+\.\d+\.\d+$/.test(version)) add(P.join(versions, version, 'bin'))
    }
  }
  // Windows environment names are case-insensitive. Keep a single spelling so
  // Node cannot select the older Path instead of this completed snapshot.
  const result = { ...env }
  if (platform === 'win32') {
    for (const name of Object.keys(result)) if (name.toLowerCase() === 'path') delete result[name]
  }
  result.PATH = paths.join(delimiter)
  return result
}
