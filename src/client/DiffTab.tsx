/**
 * The diff tab: one change opened from the changes tab, like VSCode's diff
 * editor. A worktree ref loads the file's unified diff (`git diff`, staged or
 * not; untracked files — which git diff never covers — render as a full-file
 * addition from their content), a commit ref loads the commit's full patch
 * (`git.show`-style). The header carries a refresh button because the tab
 * stays mounted while the changes tab's staging/discard operations change the
 * very content it shows. Rendering goes through the shared {@link DiffFiles}
 * renderer — the same one the changes tab's inline preview uses.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionScope } from './api.ts'
import { api } from './api.ts'
import type { SidebarDiffRef } from './state.ts'
import { DiffFiles } from './diff/DiffFiles.tsx'
import { displayPath, foldRowsFromContents, type DiffFile, type DiffRow, type FoldSegment } from './diff/rows.ts'
import { t } from './locales.ts'
import { resolveSidebarPath } from './produced-files.ts'
import css from './sidebar.module.css'

/** The loaded diff surface (untracked content rendered as a full addition). */
interface DiffData {
  diff: string
  untracked?: string
}

export function DiffTab(props: { sessionId: string; cwd: string | undefined; diff: SidebarDiffRef }) {
  const { sessionId, cwd, diff } = props
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<DiffData | null>(null)
  const [tick, setTick] = useState(0)
  // The staged flag of the side ACTUALLY rendered: when the requested side's
  // diff came back empty the load falls back to the other side, and the fold
  // expansion must read that side's revisions (else the sliced line numbers
  // land on the wrong contents).
  const [effectiveStaged, setEffectiveStaged] = useState<boolean | null>(null)

  const refresh = useCallback((): void => { setTick(value => value + 1) }, [])

  useEffect(() => {
    let cancelled = false
    const scope: SessionScope = { sessionId, cwd, ...(diff.repoRoot !== undefined ? { repoRoot: diff.repoRoot } : {}) }
    setLoading(true)
    setError(null)
    setData(null)
    setEffectiveStaged(null)
    const load = async (): Promise<void> => {
      try {
        if (diff.kind === 'commit') {
          const result = await api.gitCommitDiff(scope, diff.hashFull, diff.worktree)
          if (!cancelled) setData({ diff: result.diff })
          return
        }
        let result = await api.gitDiff(scope, diff.path, diff.staged, diff.worktree)
        if (result.diff === '') {
          // The requested side is empty — try the OTHER side once: the ref
          // may predate the staged-flag fix, or the change moved sides (a
          // file staged after its tab opened). Both sides empty means the
          // file genuinely has no text changes.
          const other = await api.gitDiff(scope, diff.path, !diff.staged, diff.worktree)
          if (other.diff !== '') {
            result = other
            if (!cancelled) setEffectiveStaged(!diff.staged)
          }
        }
        if (result.diff !== '') {
          if (!cancelled) setData({ diff: result.diff })
          return
        }
        // Empty diff: an untracked file (git diff never lists it) falls back
        // to a full-file addition; anything else is a genuine no-text-change.
        if (diff.untracked === true && !diff.staged) {
          // A child-repo path is relative to diff.repoRoot, not the session
          // cwd or the linked-worktree root; resolve against whichever the
          // diff ref carries so the untracked fallback reads the right file.
          const text = await api.fsRead(scope, resolveSidebarPath(diff.repoRoot ?? diff.worktree ?? cwd, diff.path))
          if (!cancelled) {
            setData(text.kind === 'text' ? { diff: '', untracked: text.content } : { diff: '' })
          }
          return
        }
        if (!cancelled) setData({ diff: '' })
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [sessionId, cwd, diff, tick])

  // ── On-demand git fold expansion: a fold's hidden rows come from both
  //    sides' full contents (git.show / fsRead), fetched ONCE per file so
  //    sibling folds share the request, then sliced by each fold's line
  //    ranges. The cache dies with the ref or a refresh tick. ──────────────
  const foldContents = useRef(new Map<string, Promise<{ old: string; new: string }>>())
  useEffect(() => { foldContents.current = new Map() }, [diff, tick])
  const foldLoader = useMemo(() => {
    const sidesOf = (file: DiffFile): Promise<{ old: string; new: string }> => {
      // Both sides empty cannot cover a non-empty fold — treat it as a failed
      // fetch so the fold degrades to the unavailable marker instead of
      // silently expanding to nothing (the symptom of a bad rev or path
      // reading null on both sides).
      const ofSides = (oldContent: string | null, newContent: string | null): { old: string; new: string } => {
        if ((oldContent ?? '') === '' && (newContent ?? '') === '') throw new Error('no content on either side')
        return { old: oldContent ?? '', new: newContent ?? '' }
      }
      const fetchSides = async (): Promise<{ old: string; new: string }> => {
        const scope: SessionScope = { sessionId, cwd, ...(diff.repoRoot !== undefined ? { repoRoot: diff.repoRoot } : {}) }
        if (diff.kind === 'commit') {
          // The patch's -m --first-parent shape: old side from the parent,
          // new side from the commit (a root commit's parent read fails → '').
          const [oldSide, newSide] = await Promise.all([
            file.oldPath === '/dev/null'
              ? Promise.resolve({ content: null })
              : api.gitShow(scope, `${diff.hashFull}^`, displayPath(file.oldPath), diff.worktree),
            file.newPath === '/dev/null'
              ? Promise.resolve({ content: null })
              : api.gitShow(scope, diff.hashFull, displayPath(file.newPath), diff.worktree),
          ])
          return ofSides(oldSide.content, newSide.content)
        }
        // Worktree change: staged is HEAD vs index, unstaged is index vs
        // worktree (the worktree side reads the live file).
        const staged = effectiveStaged ?? diff.staged
        if (staged) {
          const [oldSide, newSide] = await Promise.all([
            file.oldPath === '/dev/null'
              ? Promise.resolve({ content: null })
              : api.gitShow(scope, 'HEAD', displayPath(file.oldPath), diff.worktree),
            file.newPath === '/dev/null'
              ? Promise.resolve({ content: null })
              : api.gitShow(scope, ':0', displayPath(file.newPath), diff.worktree),
          ])
          return ofSides(oldSide.content, newSide.content)
        }
        const [oldSide, worktree] = await Promise.all([
          file.oldPath === '/dev/null'
            ? Promise.resolve({ content: null })
            : api.gitShow(scope, ':0', displayPath(file.oldPath), diff.worktree),
          api.fsRead(scope, resolveSidebarPath(diff.repoRoot ?? diff.worktree ?? cwd, displayPath(file.newPath))).catch(() => null),
        ])
        return ofSides(oldSide.content, worktree !== null && worktree.kind === 'text' ? worktree.content : null)
      }
      const path = displayPath(file.newPath === '/dev/null' ? file.oldPath : file.newPath)
      let promise = foldContents.current.get(path)
      if (promise === undefined) {
        promise = fetchSides()
        foldContents.current.set(path, promise)
      }
      return promise
    }
    return (file: DiffFile, segment: FoldSegment): Promise<readonly DiffRow[]> =>
      sidesOf(file).then(sides => foldRowsFromContents(segment, sides.old, sides.new))
  }, [sessionId, cwd, diff, effectiveStaged])

  return (
    <div className={css.gitDiffTab}>
      <div className={css.gitDiffTabHeader}>
        <span className={css.gitDiffTabTitle} title={diff.kind === 'worktree' ? diff.path : `${diff.hash} ${diff.subject}`}>
          {diff.kind === 'worktree' ? diff.path : `${diff.hash} ${diff.subject}`}
        </span>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={refresh}
        >
          <IconRefreshOutline16 size={14} />
        </button>
      </div>
      {loading && <div className={css.gitPlaceholder}>{t('loading')}</div>}
      {!loading && error !== null && <div className={css.gitError}>{t('diffLoadError')}: {error}</div>}
      {!loading && error === null && data !== null && (
        <>
          {data.untracked !== undefined
            ? <DiffFiles diff="" untrackedPath={diff.kind === 'worktree' ? diff.path : ''} untrackedContent={data.untracked} />
            : <DiffFiles diff={data.diff} resolveFold={foldLoader} />}
          {data.diff === '' && data.untracked === undefined && (
            <div className={css.gitEmpty}>{t('diffEmpty')}</div>
          )}
        </>
      )}
    </div>
  )
}
