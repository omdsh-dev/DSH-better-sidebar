/**
 * Terminal shell-candidate configuration, read and written through DSH's own
 * config editor.
 *
 * WHY the profile document and not this plugin's prefs: the candidate list is
 * not a plugin preference — it is the `shellCandidates` array of the profile's
 * `terminal-controller` entry, which the HOST reads when it discovers shells.
 * A copy in our prefs would list shells the host refuses to launch (the host
 * resolves `shellPath` against its own discovery result and throws
 * `Selected shell is not available in this execution environment` otherwise),
 * so the only honest place to edit is the row the host itself consults.
 *
 * WHY `ctx.configEditor` and not direct file I/O: the editor serializes writes
 * with the Loader, preserves the patch document's formatting, writes
 * atomically and reconciles the RUNNING entry afterwards. Writing
 * `cordis.patch.yml` by hand would bypass all four — the list would appear to
 * save and then get clobbered or ignored until a restart.
 *
 * The service is structural on purpose (it is optional in the composition, and
 * a deployment without it must degrade to "read-only, no candidates shown"
 * rather than crash), so this module holds the pure transform and the route
 * performs the one `edit()` call.
 */

/** The loader row whose `shellCandidates` the terminal controller consumes. */
export const TERMINAL_CONTROLLER_ENTRY = 'terminal-controller'

/**
 * Candidate names the terminal controller declares by default
 * (`Config.shellCandidates` in the host's terminal-controller package).
 *
 * A profile override REPLACES the whole array, so every write must restate
 * these — dropping one silently removes a shell the user still expects.
 */
export const DEFAULT_SHELL_CANDIDATES: readonly string[] = [
  'zsh',
  'bash',
  'fish',
  'pwsh',
  'powershell',
  'cmd',
]

/** The config-editor face this plugin consumes (structural subset). */
export interface ShellConfigEditorFace {
  readonly documentPath: string
  entries(): Array<{ options: { id: string; config?: Record<string, unknown> } }>
  edit(
    entry: unknown,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/** One loader entry as this module needs to address it. */
export interface ShellConfigEntry {
  options: { id: string; config?: Record<string, unknown> }
}

/** The wire shape the settings panel renders. */
export interface ShellCandidateView {
  /** Candidate names the host declares itself (read-only in the panel). */
  native: readonly string[]
  /** Extra candidates the profile adds on top of the native set. */
  custom: readonly string[]
  /** The profile document that carries them (shown to the user for orientation). */
  documentPath: string
}

/**
 * The display label of one shell candidate: its basename, without `.exe`.
 *
 * A candidate may be typed as a bare name (`nu`), a Windows path
 * (`C:\Apps\nu.exe`) or a POSIX path (`/usr/bin/nu`). The user typed one
 * THING and should see one THING back: the executable's own name. The full
 * string stays in the config (this is a label, never a value written back), so a
 * path keeps launching the exact binary it names while the chip reads `nu`.
 * @param value - a candidate as typed.
 * @returns the executable name alone (empty when there is nothing to show).
 */
export function shellLabelOf(value: string): string {
  const unquoted = value.trim().replace(/^["']/u, '').replace(/["']$/u, '')
  const base = unquoted.slice(Math.max(unquoted.lastIndexOf('/'), unquoted.lastIndexOf('\\')) + 1)
  return base.replace(/\.exe$/iu, '')
}

/**
 * The comparison key of one shell name or path: its basename, without `.exe`,
 * lower-cased.
 *
 * This is the HOST's own identity rule, reproduced so the panel and the default
 * match agree with what the host will actually launch. `discoverShells` names a
 * shell `executableName(path)` (the segment after the last separator) and
 * dedupes by `shellKind` (that name minus `.exe`, lower-cased), so
 * `C:\\Apps\\nu.exe`, `/usr/local/bin/nu` and `nu` are ONE shell to the host.
 * Comparing raw strings instead would make a candidate typed as a path
 * unmatchable by a default stored as a name — the two fields would silently
 * drift apart and the default would fall back to the host's own choice.
 * @param value - a candidate as typed, or a shell name the host reported.
 * @returns the key both sides compare on ('' when there is nothing to compare).
 */
export function shellKeyOf(value: string): string {
  return shellLabelOf(value).toLowerCase()
}

/** The `shellCandidates` a row currently declares (absent = no override). */
export function readCandidates(config: Record<string, unknown>): string[] {
  const raw = config.shellCandidates
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is string => typeof value === 'string')
}

/**
 * Order-preserving, duplicate-free list under the HOST's identity rule.
 *
 * The host considers `bash`, `bash.exe` and `/usr/bin/bash` one shell
 * (`shellKind`, see {@link shellKeyOf}), so a list that kept all three would
 * offer three menu rows for one executable and write candidates discovery
 * immediately collapses.
 * @param values - candidate names or paths, in the order they should appear.
 * @returns the first spelling of each shell.
 */
export function uniqueShells(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = shellKeyOf(value)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(value.trim())
  }
  return out
}

/** The panel's view of one row's config. */
export function candidateView(editor: Pick<ShellConfigEditorFace, 'documentPath'>, config: Record<string, unknown>): ShellCandidateView {
  const nativeKeys = new Set(DEFAULT_SHELL_CANDIDATES.map(shellKeyOf))
  return {
    native: [...DEFAULT_SHELL_CANDIDATES],
    // A custom entry is "extra" only by KEY: a row that spells a default as
    // `bash.exe` (or repeats it after a rename) is not a second shell, and
    // listing it here would render a removable chip for something the user can
    // never remove.
    custom: uniqueShells(readCandidates(config)).filter(value => !nativeKeys.has(shellKeyOf(value))),
    documentPath: editor.documentPath,
  }
}

/**
 * Apply one panel request to the row's config, returning the next raw config.
 *
 * Every branch restates `DEFAULT_SHELL_CANDIDATES`: the profile override is a
 * whole-array replacement, so an add that only wrote the new name would delete
 * the six defaults from the user's list, and a remove that filtered the raw
 * array alone would do the same on the next write.
 *
 * @param current - the row's current config (never mutated).
 * @param action - `addCandidate` / `removeCandidate`, plus the name in `value`.
 * @throws Error for an unknown action or a missing/blank name (the route turns
 *   it into a 400 rather than writing a half-formed override).
 */
export function applyCandidateAction(
  current: Record<string, unknown>,
  action: unknown,
  value: unknown,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current }
  const name = typeof value === 'string' ? value.trim() : ''
  if (action === 'addCandidate') {
    if (name === '') throw new Error('a shell name is required')
    // `uniqueShells`, not `uniqueCandidates`: adding `bash.exe` on a host whose
    // default candidate is `bash` is a no-op, not a second menu row (the host
    // dedupes by `shellKind` anyway).
    next.shellCandidates = uniqueShells([...DEFAULT_SHELL_CANDIDATES, ...readCandidates(current), name])
    return next
  }
  if (action === 'removeCandidate') {
    if (name === '') throw new Error('a shell name is required')
    // Native candidates are NOT removable: they are the host's own defaults,
    // and writing a list without one of them would hide a shell the user never
    // asked to hide. The panel does not offer the control either. The test is
    // by KEY, so spelling one as a path (`/usr/bin/bash`) is refused too —
    // otherwise a path-shaped synonym would pass the check and then be filtered
    // out of the write, leaving the list unchanged with a success answer.
    if (DEFAULT_SHELL_CANDIDATES.some(candidate => shellKeyOf(candidate) === shellKeyOf(name))) {
      throw new Error(`"${name}" is a built-in candidate and cannot be removed`)
    }
    const key = shellKeyOf(name)
    const kept = readCandidates(current).filter(candidate => shellKeyOf(candidate) !== key)
    next.shellCandidates = uniqueShells([...DEFAULT_SHELL_CANDIDATES, ...kept])
    return next
  }
  throw new Error('unsupported shell action')
}
