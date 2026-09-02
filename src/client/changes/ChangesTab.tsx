/**
 * The unified changes tab: one tab, two lenses on "what changed?" — Git
 * (repository truth: staged/unstaged files, commit box, history) and the
 * session round (agent truth: every file the model read, wrote, or edited).
 * Both lenses preview their selections in a shared resizable bottom pane
 * ({@link DiffPane}); git targets expand into the dedicated diff tab —
 * docked in a pane, or floated as a free window per the tab's setting.
 * The active lens and the pane height persist in the tab's meta, so the tab
 * reopens exactly where it was left.
 *
 * The session events ride the host's `changes.ops` route (the client
 * runtime exposes no event-log face): the tab pulls the delta past its
 * cursor while visible, folds it into ops, and publishes the op count to a
 * module-level cache the tab-strip badge reads.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SidebarSessionEvent } from '../../context-types.ts'
import type { TabComponentProps } from '../service.ts'
import { t } from '../locales.ts'
import { api } from '../api.ts'
import { floatTab, type SidebarDiffRef } from '../state.ts'
import { GitLens } from './GitLens.tsx'
import { SessionLens } from './SessionLens.tsx'
import { DiffPane, diffTabOf, type ChangesPreview } from './DiffPane.tsx'
import { extractFileOps, knownContentBefore, type FileOp } from './ops.ts'
import css from './changes.module.css'

/** The default preview pane height (px) before the first drag. */
const PANE_HEIGHT_DEFAULT = 300

/** Cap on accumulated events: the lens shows the recent window, not eternity
 *  (the host enforces the same bound per response). */
const EVENTS_CAP = 4000

/** Live op count per session: the tab's poller writes, the badge reads (a
 *  badge cannot fetch — it must resolve synchronously during render). */
const opCounts = new Map<string, number>()

/** The session's traced-op count as of the last poll (undefined before the
 *  tab has ever pulled; 0 hides the badge pill). */
export function opCountOf(sessionId: string): number | undefined {
  return opCounts.get(sessionId)
}

type Lens = 'git' | 'session'

/** The persisted tab meta (JSON-serializable; rides the layout). */
interface ChangesMeta {
  lens?: Lens
  previewH?: number
}

export function ChangesTab({ ctx, store, scope, tab, visible, onOpenFile, onOpenDiff }: TabComponentProps) {
  const meta = (tab.meta ?? {}) as ChangesMeta
  const [lens, setLens] = useState<Lens>(meta.lens === 'session' ? 'session' : 'git')
  const [preview, setPreview] = useState<ChangesPreview | null>(null)
  const [paneHeight, setPaneHeight] = useState<number>(
    typeof meta.previewH === 'number' && meta.previewH >= 140 ? meta.previewH : PANE_HEIGHT_DEFAULT,
  )

  // ── Session-event accumulation: one pull on mount, then a 2.5s delta
  //    poll while visible (paused otherwise; the next visible tick catches
  //    up). The cursor is the last delivered seq, so each poll ships only
  //    what the accumulator lacks. ────────────────────────────────────────
  const eventsRef = useRef<readonly SidebarSessionEvent[]>([])
  // The fold of eventsRef as of the last poll. extractFileOps parses every
  // accumulated tool/call (up to EVENTS_CAP events); running it once per
  // poll and REUSING the result across renders (the render used to re-fold
  // the whole window, twice per tick, and the fresh array defeated the
  // downstream memo on every poll) keeps the 2.5s tick at one fold.
  const opsRef = useRef<readonly FileOp[]>([])
  const seqRef = useRef(0)
  const pollGen = useRef(0)
  const [opsError, setOpsError] = useState(false)
  const [tick, setTick] = useState(0)
  const pull = useCallback(async (): Promise<void> => {
    const generation = pollGen.current
    try {
      const { events, lastSeq } = await api.changesOps(scope, seqRef.current)
      if (generation !== pollGen.current) return
      if (events.length > 0) {
        const merged = [...eventsRef.current, ...events]
        eventsRef.current = merged.length > EVENTS_CAP ? merged.slice(merged.length - EVENTS_CAP) : merged
      }
      if (lastSeq > seqRef.current) seqRef.current = lastSeq
      const folded = extractFileOps(eventsRef.current)
      opsRef.current = folded
      opCounts.set(scope.sessionId, folded.length)
      setOpsError(false)
      setTick(value => value + 1)
    } catch {
      // Offline / route unavailable: keep the last fold; surface it inline
      // only while nothing has ever loaded.
      if (generation === pollGen.current) setOpsError(true)
    }
  }, [scope.sessionId, scope.cwd])
  useEffect(() => {
    pollGen.current += 1
    eventsRef.current = []
    opsRef.current = []
    seqRef.current = 0
    setOpsError(false)
  }, [scope.sessionId])
  useEffect(() => {
    void pull()
    if (!visible) return
    const timer = window.setInterval(() => { void pull() }, 2_500)
    return () => { window.clearInterval(timer) }
  }, [visible, pull])
  // tick only forces the re-render; the fold reads the ref directly.
  void tick
  const ops = opsRef.current

  /** Persist a meta patch onto the tab (lens choice, pane height). */
  const patchMeta = (patch: ChangesMeta): void => {
    ctx.get('betterSidebar')?.updateTab(tab.id, {
      meta: { ...(tab.meta as ChangesMeta | undefined ?? {}), ...patch },
    })
  }

  const chooseLens = (next: Lens): void => {
    if (next === lens) return
    setLens(next)
    patchMeta({ lens: next })
  }

  /** Preview one git change (worktree file or commit) from the Git lens. */
  const previewGit = (ref: SidebarDiffRef): void => {
    setPreview({ kind: 'git', ref })
  }

  /** Preview one session op (with its best-effort prior content snapshot). */
  const previewOp = (path: string, op: FileOp): void => {
    setPreview({ kind: 'op', path, op, prior: knownContentBefore(ops, path, op) })
  }

  /** Expand the current git preview into the dedicated diff tab: docked
   *  into the shell's diff pane, or floated as a free window centered on
   *  the viewport when the tab's diff-open setting asks for it (default). */
  const expandPreview = (): void => {
    if (preview?.kind !== 'git') return
    const diffTab = diffTabOf(preview.ref)
    onOpenDiff?.(diffTab)
    if (store.getPrefs().changesDiffFloat !== false) {
      const x = Math.round(window.innerWidth / 2)
      const y = Math.round(window.innerHeight / 2)
      store.reduce(state => floatTab(state, diffTab.id, x, y))
    }
  }

  const previewKey = (target: ChangesPreview): string => target.kind === 'git'
    ? (target.ref.kind === 'worktree'
        ? `git:w:${target.ref.path}:${target.ref.staged ? 's' : 'u'}`
        : `git:c:${target.ref.hashFull}`)
    : `op:${target.op.callId}`

  return (
    <div className={css.root}>
      <div className={css.lensBar}>
        <div className={css.lensSwitch} role="group" aria-label={t('changes')}>
          <button
            type="button"
            className={css.lensButton}
            data-active={lens === 'git' ? 'true' : undefined}
            aria-pressed={lens === 'git'}
            onClick={() => { chooseLens('git') }}
          >
            {t('changesGitLens')}
          </button>
          <button
            type="button"
            className={css.lensButton}
            data-active={lens === 'session' ? 'true' : undefined}
            aria-pressed={lens === 'session'}
            onClick={() => { chooseLens('session') }}
          >
            {t('changesSessionLens')}
          </button>
        </div>
      </div>
      {lens === 'git'
        ? (
          <GitLens
            scope={scope}
            store={store}
            visible={visible}
            onOpenFile={onOpenFile ?? (() => { /* no-op */ })}
            onPreview={previewGit}
            selectedRef={preview !== null && preview.kind === 'git' ? preview.ref : null}
          />
        )
        : (
          <SessionLens
            ops={ops}
            loadError={opsError && ops.length === 0}
            onPreview={previewOp}
            selectedCallId={preview !== null && preview.kind === 'op' ? preview.op.callId : null}
          />
        )}
      {preview !== null && (
        <DiffPane
          key={previewKey(preview)}
          target={preview}
          scope={scope}
          height={paneHeight}
          onHeightCommit={(height) => { setPaneHeight(height); patchMeta({ previewH: height }) }}
          onClose={() => { setPreview(null) }}
          onExpand={expandPreview}
        />
      )}
    </div>
  )
}
