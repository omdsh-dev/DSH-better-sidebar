/**
 * Gated debug instrumentation for the fs.search engine pipeline (host half).
 * Off by default: with DSH_SEARCH_DEBUG unset nothing is logged, nothing
 * touches the disk, and no console output is emitted. Setting
 * `DSH_SEARCH_DEBUG=1` in the dsh web environment appends one line per
 * probe/search/engine-failure to `<config-dir>/search-debug.log` and mirrors
 * it to the host console.
 *
 * The log file lives under $DSH_HOME (the DSH config dir) when set, exactly
 * like pty-deps.ts resolves it; otherwise it falls back to `~/.dsh`. A
 * missing/unwritable log dir must never break a search — write errors are
 * swallowed.
 *
 * The flag is read once at module load: toggling it requires restarting the
 * host, the same as any other host-side change.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SEARCH_DEBUG = process.env.DSH_SEARCH_DEBUG === '1'

const LOG_FILE = join(
  process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh'),
  'search-debug.log',
)

/** Append one debug line (gated; no-op unless DSH_SEARCH_DEBUG=1). */
export function debugLog(msg: string): void {
  if (!SEARCH_DEBUG) return
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    // A missing/unwritable log path must never break a search.
  }
  console.log(msg)
}