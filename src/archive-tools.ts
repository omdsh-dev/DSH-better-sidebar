/**
 * Archive packing by the system's own tool, not by a writer of ours.
 *
 * This module replaces a hand-written ZIP encoder (~300 lines of local file
 * headers, central directory, CRC-32 and raw DEFLATE) plus a recursive walk.
 * Everything it did, `zip -r` does better: real DEFLATE, the platform's own
 * path handling, and streaming output that grows with the data instead of a
 * `Buffer.concat` of the whole archive.
 *
 * Two tools, tried in order, because neither is universal:
 *
 * - `zip` — what the file tree asks for, present on macOS and most Linux
 *   distributions. Always passed `-y`: without it Info-ZIP FOLLOWS symlinks,
 *   and a symlink loop (`a -> .`) then recurses until it is killed. `-y`
 *   stores the link itself, which is both loop-proof and a truer archive.
 *   (Verified against a real loop before this was written.)
 * - `tar` — present everywhere the plugin realistically runs, including
 *   Windows 10 1803+, where it is a built-in `bsdtar` and there is no `zip` at
 *   all. GNU tar and bsdtar both take the same `-czf -` invocation.
 *
 * Output always goes to stdout (`-` as the archive name) so the caller decides
 * where the bytes land; the route redirects them into a temp file, which is
 * what keeps the download streamable without holding the archive in memory.
 *
 * Nothing in this module runs a shell: `spawn` takes an argv array, and every
 * path is data. A path is never interpolated into a command string, so a
 * filename with `;` or `$(...)` in it is a filename.
 *
 * The spawn/probe functions are injectable so the test suite never depends on
 * a real `zip` being installed (AGENTS §6) — the same pattern `open-external`
 * and `search-engines` use.
 */
import { spawn } from 'node:child_process'
import { dirname, relative, sep } from 'node:path'
import { SidebarError } from './wire.ts'

/** The archive tool actually in use. */
export type ArchiveTool = 'zip' | 'tar'

/** One available tool: its binary name, the invocation flags, and its suffix. */
export interface ArchiveToolSpec {
  tool: ArchiveTool
  bin: string
  /** `-czf -` / `-r -q -X -y -`: everything before the entry names. */
  flags: readonly string[]
  /** The download-name extension this tool produces. */
  ext: string
}

/**
 * The invocation of one tool.
 *
 * `zip`'s `-` as the archive name means stdout, and the leading `-` in the
 * argv is understood as that operand rather than as an option because it
 * follows other flags.
 */
const TOOL_SPECS: Readonly<Record<ArchiveTool, ArchiveToolSpec>> = {
  zip: { tool: 'zip', bin: 'zip', flags: ['-r', '-q', '-X', '-y', '-'], ext: '.zip' },
  tar: { tool: 'tar', bin: 'tar', flags: ['-czf', '-'], ext: '.tar.gz' },
}

/** Order the tools are tried in (the `.zip` output is the better default). */
const TOOL_ORDER: readonly ArchiveTool[] = ['zip', 'tar']

/** How long one availability probe may take before the tool counts as absent. */
const PROBE_TIMEOUT_MS = 3000

/** How much stderr is kept for the failure message (tail, not head). */
export const ARCHIVE_STDERR_LIMIT = 4096

/** The spawn face this module needs (injectable for tests). */
export type ArchiveSpawn = typeof spawn

/** A resolved plan: where to run, what to run, and what to name the result. */
export interface ArchivePlan {
  spec: ArchiveToolSpec
  /** Working directory the tool runs in (the selections' common ancestor). */
  cwd: string
  /** Relative entry names, '/'-separated. */
  args: string[]
}

/**
 * Whether one candidate binary actually runs.
 *
 * `--version` rather than `--help`: Info-ZIP's `zip -h` is fine but bsdtar's
 * help exits non-zero on some builds, and a tool that cannot answer
 * `--version` is not one worth handing a user's directory to.
 */
function probeTool(bin: string, spawner: ArchiveSpawn): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    let child: ReturnType<ArchiveSpawn>
    try {
      child = spawner(bin, ['--version'], { stdio: 'ignore', windowsHide: true })
    } catch {
      finish(false)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(false)
    }, PROBE_TIMEOUT_MS)
    child.once('error', () => { finish(false) })
    child.once('exit', (code) => { finish(code === 0) })
  })
}

/** Probe result cache: one process-wide answer per tool. */
const availability = new Map<ArchiveTool, Promise<ArchiveToolSpec | undefined>>()

/**
 * The archive tool this host will use, or undefined when it has neither.
 *
 * The answer is cached for the process: `zip` does not appear or disappear
 * between two file-tree clicks, and a probe costs a process spawn.
 *
 * @param spawner - the spawn implementation (tests inject a fake).
 * @returns the tool spec, or undefined when no tool is available.
 */
export function resolveArchiveTool(spawner: ArchiveSpawn = spawn): Promise<ArchiveToolSpec | undefined> {
  return tryTools(TOOL_ORDER, spawner)
}

/**
 * Resolve the first available tool from an ordered list.
 *
 * @param order - tool names to try, in order.
 * @param spawner - the spawn implementation.
 * @returns the first tool that answers, or undefined.
 */
export async function tryTools(
  order: readonly ArchiveTool[],
  spawner: ArchiveSpawn = spawn,
): Promise<ArchiveToolSpec | undefined> {
  for (const tool of order) {
    const spec = TOOL_SPECS[tool]
    let pending = availability.get(tool)
    if (pending === undefined) {
      pending = probeTool(spec.bin, spawner).then(ok => (ok ? spec : undefined))
      availability.set(tool, pending)
    }
    // Sequential on purpose: the tools are tried in preference order, and a
    // parallel probe would spawn a binary we may never use.
    const found = await pending
    if (found !== undefined) return found
  }
  return undefined
}

/** Drop the cached probe results (tests, and a profile change in dev). */
export function resetArchiveToolCache(): void {
  availability.clear()
}

/** `/`-joined path segments, whatever separator the platform produced. */
function toArchiveName(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

/**
 * Build the argv/cwd plan for one selection.
 *
 * The tool's working directory is the selections' deepest COMMON ancestor, and
 * every selection is passed as its path relative to that directory — so the
 * archive names reproduce the tree the user sees: one selection is named by
 * its own basename (`src/`), two same-named files from different folders land
 * under different parents, and a selection that IS the common ancestor pushes
 * the base one level up so its name keeps a component.
 *
 * This replaces the old per-path "grow parent segments until unique" logic.
 * A path relative to a common ancestor is unique by construction, so the
 * disambiguation it performed is now a property of the layout instead of an
 * algorithm.
 *
 * @param selections - absolute paths, already fenced by the caller.
 * @param spec - the resolved tool.
 * @returns the plan to spawn.
 * @throws {SidebarError} bad-request when a selection has no usable name.
 */
export function planArchive(selections: readonly string[], spec: ArchiveToolSpec): ArchivePlan {
  if (selections.length === 0) {
    throw new SidebarError('bad-request', 'no paths to archive')
  }
  let base = commonAncestor(selections)
  // A selection that IS the base would produce an empty argument. Step the
  // base up so every argument keeps at least one component — which is also
  // what gives the archive a sensible top-level entry.
  if (selections.some(selection => relative(base, selection) === '')) {
    const parent = dirname(base)
    if (parent === base) {
      throw new SidebarError('bad-request', 'cannot archive the filesystem root')
    }
    base = parent
  }
  const args = selections.map(selection => toArchiveName(relative(base, selection)))
  if (args.some(name => name === '' || name === '..' || name.startsWith('../'))) {
    throw new SidebarError('bad-request', 'selection is not below the archive root')
  }
  return { spec, cwd: base, args: [...spec.flags, ...args] }
}

/**
 * The deepest directory containing every selection.
 *
 * Walked segment by segment rather than by `dirname` until the paths agree, so
 * a single selection resolves to its OWN directory (the case the archive needs:
 * `zip -r archive.zip src` from the parent, not `zip -r archive.zip .` from
 * inside `src`).
 */
function commonAncestor(selections: readonly string[]): string {
  const [first, ...rest] = selections
  if (first === undefined) throw new SidebarError('bad-request', 'no paths to archive')
  if (rest.length === 0) return dirname(first)
  let base = first
  for (const selection of rest) {
    while (!isWithin(base, selection)) {
      const parent = dirname(base)
      if (parent === base) return parent
      base = parent
    }
  }
  return base
}

/** Whether `target` is `base` itself or lives below it (lexically). */
function isWithin(base: string, target: string): boolean {
  if (base === target) return true
  const rel = relative(base, target)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`)
}

/** The outcome of one tool run. */
export interface ArchiveRunResult {
  /** The tool's exit code (0 = success). */
  code: number
  /** The tail of stderr, for the failure message. */
  stderr: string
}

/**
 * Run one planned tool, writing the archive to an already-open file handle.
 *
 * The caller owns the file descriptor: it stays open across the spawn so the
 * tool writes straight into the temp file, and the caller closes it once this
 * promise settles (closing it earlier would truncate a running child's output).
 *
 * @param plan - the plan from {@link planArchive}.
 * @param outputFd - writable file descriptor for the archive bytes.
 * @param spawner - the spawn implementation.
 * @param onSpawn - receives the child as soon as it exists, so the caller can
 *  hold on to it (plug-in teardown kills the builds it started).
 * @returns the exit code and the stderr tail; never rejects for a tool that
 *  ran and failed (a non-zero code is a result, not an exception).
 * @throws {SidebarError} fs-error when the tool cannot be started at all.
 */
export function runArchiveTool(
  plan: ArchivePlan,
  outputFd: number,
  spawner: ArchiveSpawn = spawn,
  onSpawn?: (child: ReturnType<ArchiveSpawn>) => void,
): Promise<ArchiveRunResult> {
  return new Promise<ArchiveRunResult>((resolve, reject) => {
    const child = spawner(plan.spec.bin, plan.args, {
      cwd: plan.cwd,
      stdio: ['ignore', outputFd, 'pipe'],
      windowsHide: true,
    })
    onSpawn?.(child)
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      // Keep only the tail: the last lines are the ones that name the actual
      // problem, and an unbounded log from a failed walk is not worth holding.
      if (stderr.length > ARCHIVE_STDERR_LIMIT * 2) {
        stderr = stderr.slice(-ARCHIVE_STDERR_LIMIT)
      }
    })
    child.once('error', (error: Error) => {
      reject(new SidebarError('fs-error', `cannot run ${plan.spec.bin}: ${error.message}`))
    })
    child.once('close', (code: number | null) => {
      resolve({ code: code ?? 1, stderr: stderr.slice(-ARCHIVE_STDERR_LIMIT).trim() })
    })
  })
}

/** The default in-archive stem when the caller named nothing usable. */
const DEFAULT_STEM = 'archive'

/** Maximum stem length, so the Content-Disposition header stays sane. */
export const ARCHIVE_STEM_MAX = 100

/**
 * Sanitize a caller-supplied archive NAME into a stem, then apply the tool's
 * extension. Separators, control characters and quotes are stripped (a name
 * must never look like a path), and any archive suffix the caller guessed is
 * removed — the tool decides the real extension, not the client.
 *
 * @param raw - the requested name ('' or a bare suffix yields the default).
 * @param ext - the extension the resolved tool produces ('.zip' / '.tar.gz').
 * @returns a flat file name with that extension.
 */
export function archiveFileName(raw: string, ext: string): string {
  const stripped = raw.trim()
    .replace(/\.(?:zip|tar(?:\.gz)?|tgz)$/i, '')
    .trim()
  const cleaned = [...stripped]
    .filter((char) => {
      const code = char.codePointAt(0)!
      return char !== '/' && char !== '\\' && char !== '"' && char !== '\'' && code >= 0x20 && code !== 0x7F
    })
    .join('')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, ARCHIVE_STEM_MAX)
  return `${cleaned === '' ? DEFAULT_STEM : cleaned}${ext}`
}

/** The temporary archive file's name in the OS temp directory. */
export function archiveTempName(id: string, ext: string): string {
  return `dsh-better-sidebar-${id}${ext}`
}