/**
 * Inline-code file mentions for the Side Chat transcript — the plugin-side
 * mirror of the host's produced-path vocabulary
 * (`ui-deliverables/turn-deliverables.ts`, `producedFileMentions`).
 *
 * The main conversation makes `` `src/client/api.ts` `` clickable because the
 * chat view hands `MarkdownText` a resolver over the paths the turn PRODUCED.
 * The side chat rendered the same answers as dead code, and the host's resolver
 * is deliberately cheap: it never stats the filesystem, it only matches the
 * turn's produced/delivered paths and declines an ambiguous basename. A compact
 * transcript can rebuild exactly that vocabulary from its own rows, which is
 * what this module does — no request per token, no guess at what "looks like" a
 * path.
 *
 * Only two row shapes carry evidence of production, and only the MUTATION tools
 * count (see {@link MUTATION_PATH_KEYS}):
 * - a successful `write` / `edit` / `str_replace_editor` call's target path,
 * - a `deliverables` row (`files[].path`, the authoritative delivery record).
 */
import type { SidechatTranscriptRow } from './sidechat-transcript.ts'
import { parseArgsObject } from './sidechat-transcript.ts'
import { baseName } from './paths.ts'

/**
 * The call-argument key naming the target of each MUTATION tool — the plugin's
 * mirror of the host's produced-path set (`ui-deliverables/turn-deliverables.ts`
 * `mutationPath`: write / edit / str_replace_editor). Reads and searches are
 * deliberately absent: a `read` target or a `grep`/`glob` root is not a file
 * this thread PRODUCED, and the directories those calls name would otherwise
 * become openable "mentions" that land the editor on a folder.
 */
const MUTATION_PATH_KEYS: Readonly<Record<string, string>> = {
  write: 'file_path',
  edit: 'file_path',
  str_replace_editor: 'path',
}

/** The `str_replace_editor` commands that MUTATE a file (host
 *  `editorMutationPath`): `view` reads, and any other command mutates nothing,
 *  so neither may put its target into the produced vocabulary. */
const EDITOR_MUTATION_COMMANDS: ReadonlySet<string> = new Set(['create', 'str_replace', 'insert'])

/** The non-blank path a list of arguments names, or undefined. */
function pathValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * The file one tool row produced, or undefined when the call is not a mutation
 * of a file (see {@link MUTATION_PATH_KEYS} and
 * {@link EDITOR_MUTATION_COMMANDS}).
 * @param row - one mapped `tool` row.
 * @returns the produced path exactly as the call spelled it.
 */
function producedTargetOf(row: Extract<SidechatTranscriptRow, { kind: 'tool' }>): string | undefined {
  const pathKey = MUTATION_PATH_KEYS[row.name]
  if (pathKey === undefined) return undefined
  const args = parseArgsObject(row.args)
  if (args === undefined) return undefined
  if (row.name === 'str_replace_editor') {
    const command = args.command
    if (typeof command !== 'string' || !EDITOR_MUTATION_COMMANDS.has(command)) return undefined
  }
  return pathValue(args[pathKey])
}

/**
 * Every path this thread produced, in first-seen order and deduplicated: the
 * target of a successful (`failed !== true`) mutation call, plus every
 * delivered file. Nothing else — see {@link MUTATION_PATH_KEYS}.
 * @param rows - the thread's mapped transcript rows.
 * @returns the produced paths exactly as the producing row spelled them
 * (relative call arguments stay relative; delivery events are absolute).
 */
export function producedFilePaths(rows: readonly SidechatTranscriptRow[]): string[] {
  const seen = new Set<string>()
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim() !== '') seen.add(value)
  }
  for (const row of rows) {
    if (row.kind === 'tool') {
      if (row.failed === true) continue
      add(producedTargetOf(row))
    } else if (row.kind === 'deliverables') {
      for (const file of row.files) add(file.path)
    }
  }
  return [...seen]
}

/**
 * The produced path one inline-code token names, or undefined when it names
 * none — the token must equal the path or its basename, and EXACTLY ONE
 * produced path may match (two `dup.ts` under different directories are
 * ambiguous, so the token stays inert rather than opening a guess).
 * @param paths - the thread's produced paths ({@link producedFilePaths}).
 * @param token - the authored inline-code text, exactly as written.
 * @returns the matching produced path, or undefined for an inert token.
 */
export function resolveProducedPath(paths: readonly string[], token: string): string | undefined {
  const wanted = token.trim()
  if (wanted === '') return undefined
  let match: string | undefined
  for (const path of paths) {
    if (path !== wanted && baseName(path) !== wanted) continue
    if (match !== undefined) return undefined
    match = path
  }
  return match
}
