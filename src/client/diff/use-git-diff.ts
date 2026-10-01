/**
 * The ONE loader behind every git diff surface: the changes tab's inline
 * preview pane (`changes/DiffPane.tsx`) and the dedicated diff tab
 * (`DiffTab.tsx`) used to carry byte-identical copies of three behaviors —
 * the staged-side fallback (an empty requested side retries the other one),
 * the untracked full-addition fallback (`git diff` never lists an untracked
 * file, so its content is read through the media route), and the per-file
 * fold-content cache the on-demand hunk expansion shares between sibling
 * folds. They live here once so a fix in one surface cannot miss the other.
 *
 * The hook is inert (`loading:false`, no fetch) for a `null` ref, which is
 * how the preview pane hosts non-git (session-op) targets.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionScope } from '../api.ts'
import { api } from '../api.ts'
import type { SidebarDiffRef } from '../state.ts'
import { resolveSidebarPath } from '../paths.ts'
import { displayPath, foldRowsFromContents, type DiffFile, type DiffRow, type FoldSegment } from './rows.ts'

/** The loaded state of one git diff target. */
export interface GitDiffTarget {
  /** A fetch is in flight (true only while nothing has loaded yet, or after a refresh drops the data). */
  loading: boolean
  error: string | null
  /** The patch text; `''` = the file genuinely has no text change. */
  diffText: string | null
  /** Untracked-file content rendered as a full addition (undefined otherwise). */
  untracked: string | undefined
  /** Re-read the diff (and drop the fold cache) with the next tick. */
  refresh(): void
  /** The on-demand fold loader `DiffFiles` forwards to its rows (undefined without a ref). */
  resolveFold: ((file: DiffFile, segment: FoldSegment) => Promise<readonly DiffRow[]>) | undefined
}

/**
 * Load one git diff target (worktree change or commit patch) and expose its
 * on-demand fold expansion. `ref === null` keeps every value inert.
 */
export function useGitDiffTarget(ref: SidebarDiffRef | null, scope: SessionScope): GitDiffTarget {
  const [tick, setTick] = useState(0)
  const [loading, setLoading] = useState(ref !== null)
  const [error, setError] = useState<string | null>(null)
  const [diffText, setDiffText] = useState<string | null>(null)
  const [untracked, setUntracked] = useState<string | undefined>(undefined)
  // The staged flag of the side ACTUALLY rendered: when the requested side's
  // diff came back empty the load falls back to the other side, and the fold
  // expansion must read that side's revisions (else the sliced line numbers
  // land on the wrong contents).
  const [effectiveStaged, setEffectiveStaged] = useState<boolean | null>(null)

  // Granular scope fields: the scope object's identity churns, only these
  // three gate the target (the same rule the sibling call sites used).
  const sessionId = scope.sessionId
  const cwd = scope.cwd
  const repoRoot = ref?.repoRoot
  const gitScope = useMemo<SessionScope>(
    () => ({ sessionId, cwd, ...(repoRoot !== undefined ? { repoRoot } : {}) }),
    [sessionId, cwd, repoRoot],
  )

  useEffect(() => {
    if (ref === null) return
    let cancelled = false
    const paneScope: SessionScope = { sessionId, cwd, ...(ref.repoRoot !== undefined ? { repoRoot: ref.repoRoot } : {}) }
    setLoading(true)
    setError(null)
    setDiffText(null)
    setUntracked(undefined)
    setEffectiveStaged(null)
    const load = async (): Promise<void> => {
      try {
        if (ref.kind === 'commit') {
          const result = await api.gitCommitDiff(paneScope, ref.hashFull, ref.worktree)
          if (!cancelled) setDiffText(result.diff)
          return
        }
        let result = await api.gitDiff(paneScope, ref.path, ref.staged, ref.worktree)
        if (result.diff === '') {
          // The requested side is empty — try the OTHER side once (the change
          // may have moved sides after the preview target was minted).
          const other = await api.gitDiff(paneScope, ref.path, !ref.staged, ref.worktree)
          if (other.diff !== '') {
            result = other
            if (!cancelled) setEffectiveStaged(!ref.staged)
          }
        }
        if (result.diff !== '') {
          if (!cancelled) setDiffText(result.diff)
          return
        }
        // Empty diff: an untracked file (git diff never lists it) falls back
        // to a full-file addition from its content. A child-repo path is
        // relative to ref.repoRoot, not the session cwd or the linked-worktree
        // root, so the read resolves against whichever the ref carries.
        if (ref.untracked === true && !ref.staged) {
          const text = await api.fsRead(paneScope, resolveSidebarPath(ref.repoRoot ?? ref.worktree ?? cwd, ref.path))
          if (!cancelled) {
            setDiffText('')
            if (text.kind === 'text') setUntracked(text.content)
          }
          return
        }
        if (!cancelled) setDiffText('')
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [ref, sessionId, cwd, tick])

  // ── On-demand git fold expansion: a fold's hidden rows come from both
  //    sides' full contents (git.show / fsRead), fetched ONCE per file so
  //    sibling folds share the request, then sliced by each fold's line
  //    ranges. The cache dies with the target or a refresh tick. ────────────
  const foldContents = useRef(new Map<string, Promise<{ old: string; new: string }>>())
  useEffect(() => { foldContents.current = new Map() }, [ref, tick])
  const resolveFold = useMemo(() => {
    if (ref === null) return undefined
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
        if (ref.kind === 'commit') {
          // The patch's -m --first-parent shape: old side from the parent,
          // new side from the commit (a root commit's parent read fails → '').
          const [oldSide, newSide] = await Promise.all([
            file.oldPath === '/dev/null'
              ? Promise.resolve({ content: null })
              : api.gitShow(gitScope, `${ref.hashFull}^`, displayPath(file.oldPath), ref.worktree),
            file.newPath === '/dev/null'
              ? Promise.resolve({ content: null })
              : api.gitShow(gitScope, ref.hashFull, displayPath(file.newPath), ref.worktree),
          ])
          return ofSides(oldSide.content, newSide.content)
        }
        // Worktree change: staged is HEAD vs index, unstaged is index vs
        // worktree (the worktree side reads the live file).
        const staged = effectiveStaged ?? ref.staged
        if (staged) {
          const [oldSide, newSide] = await Promise.all([
            file.oldPath === '/dev/null'
              ? Promise.resolve({ content: null })
              : api.gitShow(gitScope, 'HEAD', displayPath(file.oldPath), ref.worktree),
            file.newPath === '/dev/null'
              ? Promise.resolve({ content: null })
              : api.gitShow(gitScope, ':0', displayPath(file.newPath), ref.worktree),
          ])
          return ofSides(oldSide.content, newSide.content)
        }
        const [oldSide, worktree] = await Promise.all([
          file.oldPath === '/dev/null'
            ? Promise.resolve({ content: null })
            : api.gitShow(gitScope, ':0', displayPath(file.oldPath), ref.worktree),
          api.fsRead(gitScope, resolveSidebarPath(ref.repoRoot ?? ref.worktree ?? cwd, displayPath(file.newPath))).catch(() => null),
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
  }, [ref, gitScope, effectiveStaged, cwd])

  const refresh = useCallback((): void => { setTick(value => value + 1) }, [])

  return { loading, error, diffText, untracked, refresh, resolveFold }
}
