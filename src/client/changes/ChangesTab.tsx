/**
 * The unified changes tab: one tab, two lenses on "what changed?" — Git
 * (repository truth: staged/unstaged files, commit box, history) and the
 * session round (agent truth: every file the model read, wrote, or edited).
 * A 36px header carries the host conversation Tabs and the current
 * lens's refresh action; both lenses preview their selections in a shared
 * resizable bottom pane ({@link DiffPane}), and git targets expand into the
 * dedicated diff tab docked in the workbench's diff pane. The bottom pane is
 * ONE region with a tab strip when a Git Graph commit supplies a second view:
 * `details` (that commit's card, {@link CommitDetails}) and `diff` (the shared
 * preview). Every other preview — a worktree file, a history row, a session op
 * — keeps the pane diff-only, exactly as before. The active lens, the pane
 * height and the pane tab persist in the tab's meta, so the tab reopens
 * exactly where it was left.
 *
 * The session events ride the host's `changes.ops` route (the client runtime
 * exposes no event-log face): the tab pulls the delta past its cursor and
 * folds it into ops, and publishes the op count to a module-level cache the
 * tab-strip badge reads. The pull is one catch-up whenever the tab becomes
 * visible and then a cadence ONLY while the session lens is on screen — the
 * git lens has no use for the session event log (and the shared git-status
 * store owns its own poller).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarSessionEvent } from '../../context-types.ts'
import type { TabComponentProps } from '../service.ts'
import { t } from '../locales.ts'
import { api } from '../api.ts'
import { usePolling } from '../use-polling.ts'
import type { SidebarDiffRef } from '../state.ts'
import { IconButton, Notice } from '../ui/index.ts'
import { GitLens } from './GitLens.tsx'
import { CommitDetails } from './CommitDetails.tsx'
import type { GraphDetailsSelection } from './GitGraphSection.tsx'
import { SessionLens } from './SessionLens.tsx'
import { DiffPane, clampPaneHeight, diffTabOf, type ChangesPreview } from './DiffPane.tsx'
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

type Lens = 'git' | 'graph' | 'session'

/** The bottom pane's views: `details` (a graph commit's card, hosted while a
 *  graph selection lives), `content` (an op target's file-content view) and
 *  `diff` (what changed). Which of the latter two exist depends on the target
 *  — a read op has no diff — so an id persisted here may be unlisted for the
 *  current target; the pane falls back to its built-in home then. */
type PaneTabId = 'details' | 'content' | 'diff'

/** The persisted tab meta (JSON-serializable; rides the layout). */
interface ChangesMeta {
  lens?: Lens
  previewH?: number
  paneTab?: PaneTabId
}

/** What the user selected to preview: a git ref, or the IDENTITY of a session
 *  op. Holding the callId (not the op object) is what makes the pane follow
 *  the op as it settles: every render re-derives the op from the latest fold,
 *  so a running call turns into its result without the user re-clicking. */
type PreviewSelection =
  | { kind: 'git'; ref: SidebarDiffRef }
  | { kind: 'op'; path: string; callId: string }

export function ChangesTab({ ctx, store, scope, tab, visible, onOpenFile, onOpenDiff }: TabComponentProps) {
  const meta = (tab.meta ?? {}) as ChangesMeta
  const lensId = useId()
  const [lens, setLens] = useState<Lens>(meta.lens === 'session' ? 'session' : 'git')
  const [selection, setSelection] = useState<PreviewSelection | null>(null)
  /** The Git Graph's selected commit (its card + the ref tones it needs), or
   *  null while nothing is selected there. Null keeps the pane diff-only. */
  const [graphDetails, setGraphDetails] = useState<GraphDetailsSelection | null>(null)
  /** The pane's active tab: null only before anything picks one, so the FIRST
   *  graph commit lands on `details` while a tab already chosen (including one
   *  restored from the meta) is kept — the `diff` default with no strip. */
  const [bottomTab, setBottomTab] = useState<PaneTabId | null>(
    meta.paneTab === 'details' || meta.paneTab === 'content' || meta.paneTab === 'diff' ? meta.paneTab : null,
  )
  const [paneHeight, setPaneHeight] = useState<number>(() => clampPaneHeight(
    typeof meta.previewH === 'number' ? meta.previewH : PANE_HEIGHT_DEFAULT,
  ))

  // ── Session-event accumulation: one catch-up pull when the tab becomes
  //    visible, then a 2.5s delta poll while the SESSION lens is on screen.
  //    The cursor is the last delivered seq, so each poll ships only what the
  //    accumulator lacks; once primed, the poll WAITS host-side for the next
  //    tool event (25s ceiling) instead of replaying an unchanged window. ────
  const eventsRef = useRef<readonly SidebarSessionEvent[]>([])
  // The fold of eventsRef as of the last poll. extractFileOps parses every
  // accumulated tool call (up to EVENTS_CAP events); running it once per
  // poll and REUSING the result across renders keeps the 2.5s tick at one
  // fold, and an unchanged answer never hands downstream memos a new array.
  const opsRef = useRef<readonly FileOp[]>([])
  const seqRef = useRef(-1)
  const primedRef = useRef(false)
  const pollGen = useRef(0)
  /** One delta request in flight at a time (the poller is fixed-interval, so a
   *  slow host would otherwise run two pulls over the same cursor and append
   *  the same delta twice). A pull that arrives while one is running is a
   *  no-op: the in-flight answer already carries everything up to now. */
  const pullingRef = useRef(false)
  const [opsError, setOpsError] = useState(false)
  const [tick, setTick] = useState(0)
  const pull = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const generation = pollGen.current
    if (pullingRef.current) return
    pullingRef.current = true
    try {
      const { events, lastSeq } = await api.changesOps(scope, primedRef.current ? seqRef.current : undefined, signal, primedRef.current)
      // An aborted poll belongs to a torn-down run: its answer must never
      // publish state (the transport may deliver it anyway).
      if (generation !== pollGen.current || signal?.aborted === true) return
      primedRef.current = true
      // Nothing new: KEEP the previous fold's identity. Re-folding an unchanged
      // window produced a fresh array every tick, which defeated every
      // downstream memo (the session lens re-encodes each op body to size it).
      if (events.length === 0 && lastSeq <= seqRef.current && opsRef.current.length > 0) {
        setOpsError(false)
        return
      }
      if (events.length > 0) {
        const merged = [...eventsRef.current, ...events]
        eventsRef.current = merged.length > EVENTS_CAP ? merged.slice(merged.length - EVENTS_CAP) : merged
      }
      if (lastSeq > seqRef.current) seqRef.current = lastSeq
      const folded = extractFileOps(eventsRef.current, scope.cwd)
      opsRef.current = folded
      opCounts.set(scope.sessionId, folded.length)
      setOpsError(false)
      setTick(value => value + 1)
    } catch {
      // Offline / route unavailable: keep the last fold; surface it inline
      // only while nothing has ever loaded.
      if (generation === pollGen.current && signal?.aborted !== true) setOpsError(true)
    } finally {
      if (generation === pollGen.current) pullingRef.current = false
    }
    // Granular scope fields: the scope object's identity churns, only its
    // sessionId / cwd fields gate the poll target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.sessionId, scope.cwd])
  useEffect(() => {
    pollGen.current += 1
    pullingRef.current = false
    eventsRef.current = []
    opsRef.current = []
    seqRef.current = -1
    primedRef.current = false
    setOpsError(false)
    return () => { pollGen.current += 1 }
  }, [scope.sessionId])
  // One catch-up whenever the tab becomes visible (the badge count follows the
  // tab being opened); the CADENCE below runs only while this lens is showing.
  useEffect(() => { if (visible) void pull() }, [visible, pull])
  usePolling(visible && lens === 'session', pull, { intervalMs: 2_500 })
  // tick only forces the re-render; the fold reads the ref directly.
  void tick
  const ops = opsRef.current

  /** The preview target of the current selection, re-derived every render so
   *  an op that settled (or fell out of the window) is reflected immediately. */
  const previewTarget = useMemo<ChangesPreview | null>(() => {
    if (selection === null) return null
    if (selection.kind === 'git') return selection
    const op = ops.find(candidate => candidate.callId === selection.callId)
    if (op === undefined) return null
    return { kind: 'op', path: selection.path, op, prior: knownContentBefore(ops, selection.path, op) }
  }, [selection, ops])

  /** Persist a meta patch onto the tab (lens choice, pane height, pane tab). */
  const patchMeta = (patch: ChangesMeta): void => {
    ctx.get('betterSidebar')?.updateTab(tab.id, {
      meta: { ...(tab.meta as ChangesMeta | undefined ?? {}), ...patch },
    }, scope.sessionId)
  }

  /** Switch the bottom pane's tab (a strip click) and persist the choice
   *  beside lens / previewH, so the pane reopens on the same view. */
  const chooseBottomTab = (next: PaneTabId): void => {
    if (next === bottomTab) return
    setBottomTab(next)
    patchMeta({ paneTab: next })
  }

  /** The graph lens's selected commit, or null. Its arrival is what arms the
   *  pane's two-tab strip, and the FIRST one of a tab's life lands on `details`
   *  (the graph's own card); a tab the user already worked on keeps its tab. */
  const reportGraphDetails = (selection: GraphDetailsSelection | null): void => {
    setGraphDetails(selection)
    if (selection !== null && bottomTab === null) chooseBottomTab('details')
  }

  const chooseLens = (next: Lens): void => {
    if (next === lens) return
    setLens(next)
    patchMeta({ lens: next })
  }

  /** Preview one git change (worktree file or commit) from the Git lens. */
  const previewGit = (ref: SidebarDiffRef): void => {
    setSelection({ kind: 'git', ref })
    chooseBottomTab('diff')
  }

  /** Preview one commit from the GRAPH lens: the pane stays on whatever tab
   *  the user is on (the default is decided when the entry arrives). */
  const previewGraphCommit = (ref: SidebarDiffRef): void => {
    setSelection({ kind: 'git', ref })
  }

  /** Preview one session op by callId (the tab re-derives it each render). A
   *  READ lands on the content tab — nothing changed, so there is no diff —
   *  a write/edit lands on the diff. */
  const previewOp = (path: string, op: FileOp): void => {
    setSelection({ kind: 'op', path, callId: op.callId })
    chooseBottomTab(op.kind === 'read' ? 'content' : 'diff')
  }

  /** Expand the current git preview into the dedicated diff tab, docked
   *  into the workbench's diff pane. */
  const expandPreview = (): void => {
    if (previewTarget?.kind !== 'git') return
    onOpenDiff?.(diffTabOf(previewTarget.ref))
  }

  const previewKey = (target: ChangesPreview): string => target.kind === 'git'
    ? (target.ref.kind === 'worktree'
        ? `git:w:${target.ref.path}:${target.ref.staged ? 's' : 'u'}`
        : `git:c:${target.ref.hashFull}`)
    : `op:${target.op.callId}`

  return (
    <div className={css.root}>
      <div className={css.head}>
        {/* ponytail: conversation Tabs are private in DSH 0.2.0-rc.2; reuse
            their CSS classes until the host exports the component. */}
        <div className="wSkVaW_tabs" role="tablist" aria-label={t('changes')}>
          {(['git', 'session'] as const).map(value => (
            <button
              key={value}
              id={`${lensId}-${value}`}
              type="button"
              role="tab"
              aria-selected={lens === value}
              aria-controls={`${lensId}-${value}-panel`}
              tabIndex={lens === value ? 0 : -1}
              className={`wSkVaW_tab${lens === value ? ' wSkVaW_tabActive' : ''}`}
              onClick={() => { chooseLens(value) }}
              onKeyDown={event => {
                let next: Lens
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = value === 'git' ? 'session' : 'git'
                else if (event.key === 'Home') next = 'git'
                else if (event.key === 'End') next = 'session'
                else return
                event.preventDefault()
                chooseLens(next)
                event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[id="${lensId}-${next}"]`)?.focus()
              }}
            >
              {t(value === 'git' ? 'changesGitLens' : 'changesSessionLens')}
            </button>
          ))}
        </div>
        {/* The Git lens refreshes from its own Changes header (#944); only the
            session lens needs the tab-level action. */}
        {lens === 'session' && <IconButton
          className={css.headAction}
          size="sm"
          icon={<IconRefreshOutlineRegular size={14} />}
          label={t('refresh')}
          onClick={() => { void pull() }}
        />}
      </div>
      {/* Both lenses stay MOUNTED and only the active one is shown: the Git
          lens then keeps its expanded groups, its commit draft and the Graph
          section's scroll and selection while the session lens is on screen
          (the graph's own `visible` gate keeps it from fetching meanwhile).
          The host keeps tab bodies the same way (`keepMounted`). */}
      <div className={css.lensBody} id={`${lensId}-git-panel`} role="tabpanel"
        aria-labelledby={`${lensId}-git`} hidden={lens !== 'git'}>
        <GitLens
          ctx={ctx}
          scope={scope}
          store={store}
          visible={visible}
          active={lens === 'git'}
          onOpenFile={onOpenFile ?? (() => { /* no-op */ })}
          onPreview={previewGit}
          selectedRef={previewTarget !== null && previewTarget.kind === 'git' ? previewTarget.ref : null}
          onGraphPreview={previewGraphCommit}
          onClearPreview={() => { setSelection(null) }}
          onDetailsChange={reportGraphDetails}
        />
      </div>
      <div className={css.lensBody} id={`${lensId}-session-panel`} role="tabpanel"
        aria-labelledby={`${lensId}-session`} hidden={lens !== 'session'}>
        <SessionLens
          ops={ops}
          loadError={opsError && ops.length === 0}
          onPreview={previewOp}
          selectedCallId={selection !== null && selection.kind === 'op' ? selection.callId : null}
        />
      </div>
      {previewTarget !== null && (
        <DiffPane
          key={previewKey(previewTarget)}
          target={previewTarget}
          ctx={ctx}
          scope={scope}
          height={paneHeight}
          onHeightCommit={(height) => { setPaneHeight(height); patchMeta({ previewH: height }) }}
          onClose={() => { setSelection(null) }}
          onExpand={expandPreview}
          // The tab set is PINNED, not derived: the three views are the same
          // panel in every lens (details of the selected commit, the file's own
          // content, the patch). A view with nothing to show renders its empty
          // state instead of vanishing, and the lens above never changes the
          // strip.
          tabs={[
            { id: 'details', label: t('graphDetails') },
            { id: 'content', label: t('changesContentTab') },
            { id: 'diff', label: t('changesDiffTab') },
          ]}
          activeTab={bottomTab ?? 'diff'}
          onSelectTab={(id) => { if (id === 'details' || id === 'content' || id === 'diff') chooseBottomTab(id) }}
          bodies={{
            details: graphDetails === null
              ? <div className={css.altBody}><Notice kind="empty" tone="page">{t('changesNoCommit')}</Notice></div>
              : <CommitDetails entry={graphDetails.entry} remotes={graphDetails.remotes} slot={graphDetails.slot} />,
          }}
        />
      )}
      {selection !== null && selection.kind === 'op' && previewTarget === null && (
        <div className={css.paneGone}>
          <Notice kind="warn">{t('changesOpGone')}</Notice>
          <IconButton
            size="sm"
            icon={<IconRefreshOutlineRegular size={14} />}
            label={t('changesClosePreview')}
            onClick={() => { setSelection(null) }}
          />
        </div>
      )}
    </div>
  )
}
