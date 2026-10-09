/**
 * The editor's uncommitted-change gutter (issue #212), kept deliberately
 * close to what VS Code shows and nothing more: the line-number gutter tints
 * a changed line's number, a 2px bar sits at the left edge of the numbers
 * (added / modified / deleted), and hovering a line reveals that line's
 * blame as a PLAIN TEXT tooltip (author · time, then the commit summary). No
 * end-of-line author widget, no badges, no animation, no gradient.
 *
 * Three rules shape the wiring:
 *  - ONE git status source. `useGitStatus` (the plugin's shared store, also
 *    behind the file tree's ink) decides WHICH files changed and whether a
 *    file is untracked; this module never starts a second poller. The line
 *    map itself comes from `git diff --no-color` through the existing
 *    unified-diff parser (`diff/rows.ts`), so a line's class is git's own
 *    answer — context rows are never marked.
 *  - Only the `code` viewer carries the extensions (the caller passes null
 *    for every other viewer and when the user switched the feature off), and
 *    the bar/number colors come from the same `--dsw-alias-state-*` tones the
 *    file tree already uses for its rows.
 *  - Blame is fetched ON HOVER for the hovered line only, memoized per
 *    session + path + line. Scrolling never re-requests a range, a file is
 *    never prefetched, and the memo is dropped whenever the file's change set
 *    is recomputed OR cleared — a new diff means new commits may be involved,
 *    and a vanished diff (the file was committed or discarded) must not leave
 *    the pre-commit line answering the next hover.
 */
import { useEffect, useMemo, useState } from 'react'
import { RangeSet, Compartment, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, GutterMarker, gutter, gutterLineClass, hoverTooltip, type Tooltip } from '@codemirror/view'
import { api, type GitBlameLine, type SessionScope } from './api.ts'
import { parseUnifiedDiff, unifiedSegments } from './diff/rows.ts'
import { relativeTime } from './locales.ts'
import { useGitStatus } from './ui/git-status.ts'
import css from './sidebar.module.css'

/** The change class of one line, as the gutter paints it. */
export type GitLineKind = 'add' | 'mod' | 'del'

/** The line-number ink of each class (the file tree's own tone mapping:
 *  added/untracked green, modified amber, deleted red). */
export const GIT_LINE_CLASS: Record<GitLineKind, string> = {
  add: css.editorGitAdd ?? '',
  mod: css.editorGitMod ?? '',
  del: css.editorGitDel ?? '',
}

/** The class of the thin left bar's filled element, per class. */
const GIT_BAR_CLASS: Record<GitLineKind, string> = {
  add: css.editorGitBarAdd ?? '',
  mod: css.editorGitBarMod ?? '',
  del: css.editorGitBarDel ?? '',
}

/** Structural class of the bar gutter (also the DOM hook tests query). */
export const GIT_BAR_GUTTER_CLASS = 'cm-dsh-git-gutter'

const EMPTY_KINDS: ReadonlyMap<number, GitLineKind> = new Map()

/**
 * The changed NEW-side lines of a `git diff` patch, as line number → class.
 *
 * The patch is read through the shared unified-diff engine, so the pairing
 * rules (a rewritten line is one `mod`, not a `del` plus an `add`) are the
 * same ones every other diff surface in the plugin renders. Deletions have no
 * line of their own on the new side: each unpaired deletion is anchored to
 * the line ABOVE the gap — where VS Code draws it too — and to line 1 when
 * the deleted run sits at the head of the file. Context rows contribute
 * nothing, and the anchor never overwrites a line an addition or a rewrite
 * already claimed.
 * @param diffText - `git diff --no-color` output (unified, `-U3`).
 * @returns the changed lines (1-based, worktree side).
 */
export function gitLineKinds(diffText: string): Map<number, GitLineKind> {
  const kinds = new Map<number, GitLineKind>()
  if (diffText === '') return kinds
  for (const file of parseUnifiedDiff(diffText).files) {
    for (const segment of unifiedSegments(file)) {
      if (segment.kind !== 'hunk') continue
      let lastNew = 0
      for (const row of segment.rows) {
        if (row.newLine !== undefined) lastNew = row.newLine
        if (row.kind === 'add' && row.newLine !== undefined) {
          kinds.set(row.newLine, 'add')
        } else if (row.kind === 'mod' && row.newLine !== undefined) {
          // The deleted half of a rewritten pair carries no new-side line;
          // only the addition half maps onto the buffer.
          kinds.set(row.newLine, 'mod')
        } else if (row.kind === 'del') {
          const anchor = Math.max(1, lastNew)
          if (!kinds.has(anchor)) kinds.set(anchor, 'del')
        }
      }
    }
  }
  return kinds
}

/** Every line of a file that git does not track yet is an addition. */
export function addedLineKinds(lineCount: number): Map<number, GitLineKind> {
  const kinds = new Map<number, GitLineKind>()
  for (let line = 1; line <= lineCount; line += 1) kinds.set(line, 'add')
  return kinds
}

// ── CodeMirror plumbing ─────────────────────────────────────────────────────

const setGitLineKinds = StateEffect.define<ReadonlyMap<number, GitLineKind>>()

/** The changed lines of the open buffer (empty while the file is clean). */
const gitLineKindsField = StateField.define<ReadonlyMap<number, GitLineKind>>({
  create: () => EMPTY_KINDS,
  update: (value, transaction) => {
    let next = value
    for (const effect of transaction.effects) {
      if (effect.is(setGitLineKinds)) next = effect.value
    }
    return next
  },
})

/** Marker carrying the line-number ink; `gutterLineClass` copies its class
 *  onto every gutter element of that line (numbers included). */
class GitNumberMarker extends GutterMarker {
  readonly elementClass: string

  constructor(kind: GitLineKind) {
    super()
    this.elementClass = GIT_LINE_CLASS[kind]
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof GitNumberMarker && other.elementClass === this.elementClass
  }
}

/** Marker carrying the thin bar element drawn inside the bar gutter. */
class GitBarMarker extends GutterMarker {
  constructor(private readonly kind: GitLineKind | null) {
    super()
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof GitBarMarker && other.kind === this.kind
  }

  override toDOM(): Node {
    const bar = document.createElement('div')
    bar.className = this.kind === null
      ? css.editorGitBarSpacer ?? ''
      : `${css.editorGitBar ?? ''} ${GIT_BAR_CLASS[this.kind]}`
    return bar
  }
}

/** The per-line classes of the line-number gutter (one entry per line). */
const gitLineNumberClasses = gutterLineClass.compute([gitLineKindsField], (state: EditorState) => {
  const ranges = []
  for (const [line, kind] of state.field(gitLineKindsField)) {
    if (line < 1 || line > state.doc.lines) continue
    ranges.push(new GitNumberMarker(kind).range(state.doc.line(line).from))
  }
  return RangeSet.of(ranges, true)
})

/** The bar gutter, ordered BEFORE the line numbers by the caller. */
const gitBarGutter = gutter({
  class: `${css.editorGitBarGutter ?? ''} ${GIT_BAR_GUTTER_CLASS}`,
  lineMarker: (view, block) => {
    const kind = view.state.field(gitLineKindsField).get(view.state.doc.lineAt(block.from).number)
    return kind === undefined ? null : new GitBarMarker(kind)
  },
  lineMarkerChange: update => update.startState.field(gitLineKindsField) !== update.state.field(gitLineKindsField),
  // A hidden spacer keeps the bar's 2px reserved while the file is clean, so
  // the numbers never shift sideways when a change appears.
  initialSpacer: () => new GitBarMarker(null),
})

/**
 * The blame tooltip's surface. CodeMirror's own base theme paints
 * `.cm-tooltip` light gray (`#f5f5f5` over `#bbb`, hardcoded), which on a dark
 * skin is a light box holding light label text — so the one tooltip this
 * editor can show takes its surface from the same tokens as every other
 * layer.
 */
const gitGutterTheme = EditorView.theme({
  '.cm-tooltip': {
    border: '1px solid var(--dsw-alias-border-l2)',
    backgroundColor: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
  },
})

/** What the blame tooltip needs from the view that owns it. */
export interface GitGutterHost {
  scope: SessionScope
  path: string
}

/** Build the gutter extensions for one view (empty = the feature is off). */
export function gitGutterExtensions(host: GitGutterHost | null): Extension[] {
  if (host === null) return []
  const source = (view: EditorView, pos: number): Promise<Tooltip | null> => {
    const line = view.state.doc.lineAt(pos)
    return loadBlameLine(host.scope, host.path, line.number).then((entry) => {
      if (entry === null) return null
      return {
        pos: line.from,
        end: line.to,
        above: true,
        create: () => ({ dom: blameTooltipDom(entry) }),
      }
    })
  }
  return [gitLineKindsField, gitLineNumberClasses, gitBarGutter, gitGutterTheme, hoverTooltip(source, { hoverTime: 250 })]
}

/** Push one change set into a live view (no-op without the extensions). */
export function applyGitLineKinds(view: EditorView, kinds: ReadonlyMap<number, GitLineKind>): void {
  if (!view.state.field(gitLineKindsField, false)) return
  view.dispatch({ effects: setGitLineKinds.of(kinds) })
}

/**
 * A Compartment holding the gutter extensions. Created once per editor view;
 * flipping the setting dispatches `reconfigure(host)`, so the document, undo
 * history, scroll and keymaps survive (host `null` = nothing is installed and
 * no decoration exists at all).
 */
export class CmGitGutterCompartment {
  private readonly compartment = new Compartment()

  /** `of(...)` payload for EditorState.create. */
  of(host: GitGutterHost | null): Extension {
    return this.compartment.of(gitGutterExtensions(host))
  }

  /** Reconfigure for a setting flip (or a new file). */
  reconfigure(host: GitGutterHost | null): ReturnType<Compartment['reconfigure']> {
    return this.compartment.reconfigure(gitGutterExtensions(host))
  }
}

// ── Blame (hover only; memoized per session + path + line) ──────────────────

/** Upper bound on memoized blame lines; the whole memo is dropped past it. */
const BLAME_CACHE_LIMIT = 500
const blameCache = new Map<string, Promise<GitBlameLine | null>>()

const blameKey = (sessionId: string, path: string, line: number): string =>
  `${sessionId}\u0000${path}\u0000${String(line)}`

/** Drop the memo of one file (its change set was recomputed or cleared). */
export function forgetBlame(sessionId: string, path: string): void {
  const prefix = `${sessionId}\u0000${path}\u0000`
  for (const key of [...blameCache.keys()]) {
    if (key.startsWith(prefix)) blameCache.delete(key)
  }
}

/** Blame one line, or null when git has no answer (untracked file, no
 *  repository, command failure) — the tooltip then simply never shows. */
export function loadBlameLine(scope: SessionScope, path: string, line: number): Promise<GitBlameLine | null> {
  const key = blameKey(scope.sessionId, path, line)
  const memo = blameCache.get(key)
  if (memo !== undefined) return memo
  if (blameCache.size >= BLAME_CACHE_LIMIT) blameCache.clear()
  const pending = api.gitBlame(scope, path, line, line).then(
    result => result.lines.find(entry => entry.line === line) ?? null,
    () => null,
  )
  blameCache.set(key, pending)
  return pending
}

/** The tooltip body: plain text, two lines (who/when, then the summary). */
function blameTooltipDom(entry: GitBlameLine): HTMLElement {
  const dom = document.createElement('div')
  dom.className = css.editorBlame ?? ''
  const head = document.createElement('div')
  head.className = css.editorBlameHead ?? ''
  head.textContent = [entry.author, relativeTime(entry.date)].filter(part => part !== '').join(' · ')
  dom.append(head)
  if (entry.summary !== '') {
    const summary = document.createElement('div')
    summary.className = css.editorBlameSummary ?? ''
    summary.textContent = entry.summary
    dom.append(summary)
  }
  return dom
}

// ── The React side: which lines are marked ─────────────────────────────────

/** Everything the gutter needs from the editor component. */
export interface EditorGitGutterOptions {
  /** False for every viewer but `code`, and when the setting is off. */
  enabled: boolean
  scope: SessionScope
  path: string
  /** The loaded text; a reload re-reads the change set. */
  content: string | undefined
  /** Bumped after a save: the diff changed while the status entry did not. */
  revision: number
}

/**
 * The changed lines of the open file, from the SHARED git status store (which
 * decides whether the file is modified at all, and whether it is untracked)
 * plus one `git diff HEAD` request per change. Clean files, unknown files and
 * the disabled state all resolve to an empty map — no decoration.
 */
export function useEditorGitGutter(options: EditorGitGutterOptions): ReadonlyMap<number, GitLineKind> {
  const { enabled, path, content, revision } = options
  const sessionId = options.scope.sessionId
  const cwd = options.scope.cwd
  const repoRoot = options.scope.repoRoot
  const scope = useMemo<SessionScope>(
    () => ({ sessionId, cwd, ...(repoRoot !== undefined ? { repoRoot } : {}) }),
    [sessionId, cwd, repoRoot],
  )
  const status = useGitStatus(scope, { visible: enabled })
  const entry = enabled ? status.statusOf(path) : undefined
  const [kinds, setKinds] = useState<ReadonlyMap<number, GitLineKind>>(EMPTY_KINDS)

  useEffect(() => {
    // A fresh change set invalidates the file's blame memo (the lines that
    // moved may now belong to other commits) — and so does a change set that
    // DISAPPEARS, which is the branch below: once the file is committed or
    // discarded there is no diff to recompute, so an invalidation kept inside
    // the enabled branch would never run and the next hover would be answered
    // with the pre-commit line (the '[Not Committed Yet]' placeholder too).
    forgetBlame(scope.sessionId, path)
    if (!enabled || entry === undefined) {
      setKinds(EMPTY_KINDS)
      return undefined
    }
    let cancelled = false
    if (entry.tone === 'untracked') {
      setKinds(addedLineKinds(content === undefined || content === '' ? 0 : content.split('\n').length))
      return undefined
    }
    api.gitDiffHead(scope, path).then(
      (result) => { if (!cancelled) setKinds(gitLineKinds(result.diff)) },
      () => { if (!cancelled) setKinds(EMPTY_KINDS) },
    )
    return () => { cancelled = true }
  }, [enabled, scope, path, content, revision, entry])

  return kinds
}
