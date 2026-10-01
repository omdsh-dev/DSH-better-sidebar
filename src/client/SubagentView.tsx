/**
 * Subagent page: the FULL agent topology of the current tree's main session.
 *
 * The root is resolved by walking the durable parent chain upward from the
 * current session to the first non-subagent session — the MAIN session — and
 * every subagent under it shares this one topology view, no matter how deep
 * the current selection is (including a subagent transcript opened in the
 * main view). The main agent renders as the root node card (click it to jump
 * back to the main session), with its subagents hanging below it in clearly
 * LAYERED levels: tree connector lines (first level included) and per-level
 * indentation show the hierarchy, and the currently-open session is
 * highlighted in place. Every branch is expanded automatically.
 *
 * The child rows come from DSH 0.1.7's host-computed `subagentCatalog`
 * projection (folded per parent by ./subagent-catalog.ts), which the client
 * loads for every session with the connection — there is no per-parent
 * observe/refresh handshake to run any more. What a row no longer carries is
 * derived: a branch stays open until the child's own catalog is known-empty,
 * and live status comes from the `subagents.live` batch channel.
 *
 * Each node card carries live status (state dot, durable label, mode and
 * activity); while a child RUNS, its card additionally shows the LAST text
 * output and LAST tool call pulled from its history tail, auto-refreshing
 * every few seconds while the page is visible. Clicking a card jumps
 * straight into the child transcript (`openChild`); the page stays open
 * and the topology remains rooted at the main session.
 *
 * The background-jobs section below the tree is fed by the plugin's
 * `jobs.list` route, one polled read per tree session (the registry's fence
 * admits a job only to its owner, and 0.1.7 stopped mirroring jobs into the
 * client snapshot).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import {
  IconRefreshOutlineRegular, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  Context,
  SidebarSessionList,
  SidebarSessionSummary,
  SidebarSubagentAddress,
  SidebarSubagentCatalogEntry,
  SidebarJobView,
} from '../context-types.ts'
import {
  countSubagentDescendants,
  isSideThreadSummary,
  rootAncestor,
} from './subagent-detect.ts'
import {
  childActivity,
  isKnownLeaf,
  subagentCatalogs,
  type SubagentCatalogView,
} from './subagent-catalog.ts'
import { type LastActivity } from '../subagent-activity.ts'
import { SIDE_LABEL_PREFIX } from '../sidechat-core.ts'
import {
  collectTreeJobs,
  formatJobDuration,
  isJobLive,
  orderJobs,
  jobDotState,
  jobStatusLabel,
  treeSessionIds,
  type TreeJob,
} from './subagent-jobs.ts'
import { api, isForbiddenError, type JobOutputResult } from './api.ts'
import { usePolling } from './use-polling.ts'
import { IconStopOutline16 } from './icons.tsx'
import { t } from './locales.ts'
import css from './SubagentView.module.css'

/** Refresh cadence of the live "last text + tool call" lines while a child runs. */
const POLL_MS = 3000
/** Refresh cadence of the tree's background-job lists (one read per tree session). */
const JOBS_POLL_MS = 3000
/** Preview cap of one tool-call argument line. */
const ARGS_PREVIEW = 60
/** Refresh cadence of an expanded job-output panel while its job runs. */
const JOB_POLL_MS = 2000
/** How long the kill button stays armed before it needs re-confirming. */
const JOB_KILL_ARM_MS = 3000

/** The direct subagent children of one parent (durable `origin` rows;
 *  Side Chat threads ride the same origin but are tab-strip conversations,
 *  never topology). */
function directChildren(
  byId: Readonly<Record<string, SidebarSessionSummary>>,
  parentSessionId: string,
): SidebarSessionSummary[] {
  return Object.values(byId).filter(
    summary => summary.origin === 'subagent' && summary.parentId === parentSessionId
      && !isSideThreadSummary(summary),
  )
}

/** Human label of one catalog child: durable label, then summary title, then id. */
function childLabel(
  entry: SidebarSubagentCatalogEntry,
  summary: SidebarSessionSummary | undefined,
): string {
  return entry.label ?? summary?.displayTitle ?? entry.id
}

/**
 * The mode word of one catalog row. DSH 0.1.7 added `unknown` (a child the
 * host's catalog fold kept without a readable descriptor): it claims NEITHER
 * mode, so the segment is omitted rather than mislabelled — printing
 * "Continuable" would be a lie, and the shipped dictionaries have no key for
 * it yet (adding one would have to touch every locale chunk).
 */
function modeLabel(mode: SidebarSubagentCatalogEntry['mode']): string | undefined {
  switch (mode) {
    case 'one-shot': return t('subagentModeOneShot')
    case 'continuable': return t('subagentModeContinuable')
    case 'unknown': return undefined
  }
}

/** The secondary line of one card: title · mode · activity (skips empty parts). */
function cardSecondary(
  summary: SidebarSessionSummary | undefined,
  entry: SidebarSubagentCatalogEntry,
  activity: 'running' | 'inactive',
): string {
  return [
    summary?.displayTitle,
    modeLabel(entry.mode),
    activity === 'running' ? t('subagentRunning') : t('subagentInactive'),
  ].filter(Boolean).join(' · ')
}

/** First `limit` characters with an ellipsis when truncated. */
function preview(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Collapse whitespace for the single-paragraph live-text preview. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Disabled "loading…" cards backed by the summary mirror while a catalog hydrates. */
function CatalogLoadingRows(props: {
  parentSessionId: string
  byId: Readonly<Record<string, SidebarSessionSummary>>
  level: number
}) {
  const { parentSessionId, byId, level } = props
  const children = directChildren(byId, parentSessionId)
  if (children.length === 0) {
    return <div className={css.subagentEmpty}>{t('loading')}</div>
  }
  return (
    <>
      {children.map(summary => (
        <div
          key={summary.id}
          role="treeitem"
          aria-disabled="true"
          aria-level={level}
          aria-label={t('loading')}
          className={`${css.subagentRow} ${css.subagentRowDisabled} ${css.subagentRowLoading}`}
        >
          <StateDot state={summary.running === true ? 'ongoing' : 'done'} className={css.subagentDot} />
          <span className={css.subagentContent}>
            <span className={css.subagentLabel}>{t('loading')}</span>
          </span>
        </div>
      ))}
    </>
  )
}

/**
 * The live lines of one RUNNING subagent card: a pure presentation of the
 * batch `subagents.live` activity. The polling lives in one place (the
 * SubagentView hook), not per card. A running child with neither output yet
 * reads "thinking…".
 */
function SubagentLiveLines(props: { live: LastActivity | undefined }) {
  const { live } = props
  if (live?.text === undefined && live?.tool === undefined) {
    return <span className={css.subagentLive}>{t('subagentThinking')}</span>
  }
  return (
    <>
      {live.tool !== undefined && (
        <span className={css.subagentLive}>
          <span className={css.subagentLiveTool}>{live.tool.name}</span>
          {live.tool.args !== '' && (
            <span className={css.subagentLiveArgs}>{preview(live.tool.args, ARGS_PREVIEW)}</span>
          )}
        </span>
      )}
      {live.text !== undefined && (
        <span className={css.subagentLiveText}>{flatten(live.text)}</span>
      )}
    </>
  )
}

/**
 * One shared live-preview poller for the whole Subagent tree. Unlike the old
 * per-card `subagents.history` timers, this sends at most ONE `subagents.live`
 * request at a time (the shared poller's self-scheduling mode arms the next
 * tick only after the previous request settles, so a slow host never sees
 * abort/restart storms); a response settling after the poller stopped (page
 * hidden, tree re-rooted) is dropped via the aborted signal.
 */
function useSubagentLive(
  rootId: string | undefined,
  active: boolean,
): Readonly<Record<string, LastActivity>> {
  const [live, setLive] = useState<Record<string, LastActivity>>({})
  // Tracy (TCH e2e v3 X07): roots whose live read was refused (403). A seat account may not read
  // `subagents.live` (dsh-passwords keeps it to the owner), and asking every tick only repeated
  // the refusal (290 × 403 in one run). The ref stops the next tick at once; the state turns the
  // poller off on the next render. Any other failure keeps the retry.
  const refusedRef = useRef<ReadonlySet<string>>(new Set())
  const [refused, setRefused] = useState<ReadonlySet<string>>(() => new Set())

  // A new tree must never inherit another root's live previews.
  useEffect(() => { setLive({}) }, [rootId])

  const poll = useCallback(async (signal: AbortSignal): Promise<void> => {
    if (rootId === undefined || refusedRef.current.has(rootId)) return
    let result: Awaited<ReturnType<typeof api.subagentsLive>>
    try {
      result = await api.subagentsLive(rootId, signal)
    } catch (error) {
      if (!signal.aborted && isForbiddenError(error)) {
        refusedRef.current = new Set(refusedRef.current).add(rootId)
        setRefused(refusedRef.current)
      }
      throw error
    }
    if (!signal.aborted) setLive(result.live)
  }, [rootId])
  usePolling(rootId !== undefined && active && !refused.has(rootId), poll, {
    intervalMs: POLL_MS,
    mode: 'self-scheduling',
    immediate: true,
  })

  return live
}

interface RowsProps {
  parentSessionId: string
  catalog: SubagentCatalogView | undefined
  catalogs: Readonly<Record<string, SubagentCatalogView>>
  byId: Readonly<Record<string, SidebarSessionSummary>>
  level: number
  /** The currently-open session id (highlighted in the topology). */
  currentSessionId: string
  /** The batch live-preview map (child id → latest activity). */
  live: Readonly<Record<string, LastActivity>>
  openChild: (address: SidebarSubagentAddress) => void
  refresh: (parentSessionId: string) => void
}

/** Render one topology level; branches are always expanded. */
function CatalogRows({
  parentSessionId, catalog, catalogs, byId, level, currentSessionId, live,
  openChild, refresh,
}: RowsProps) {
  const emptyLoading = catalog?.state === 'loading' && catalog.entries.length === 0
  // Side Chat threads are honest catalog citizens (durable descriptor, 'Side: '
  // label) but they are NOT subagent topology — filter them out here (the tab
  // strip owns them). The label lives on the entry for a continuable child and
  // on the summary for a one-shot whose descriptor carried none, so both are
  // checked.
  const visibleEntries = (catalog?.entries ?? []).filter(entry =>
    !(entry.label?.startsWith(SIDE_LABEL_PREFIX) ?? false)
    && !(byId[entry.id]?.displayTitle.startsWith(SIDE_LABEL_PREFIX) ?? false))
  return (
    <>
      {emptyLoading && (
        <CatalogLoadingRows parentSessionId={parentSessionId} byId={byId} level={level} />
      )}
      {catalog?.state === 'error' && (
        <div className={css.subagentError}>
          <span>{catalog.error?.message ?? t('error')}</span>
          <button
            type="button"
            className={css.subagentErrorRetry}
            onClick={() => { refresh(parentSessionId) }}
          >
            <IconRefreshOutlineRegular size={14} />
            {t('retry')}
          </button>
        </div>
      )}
      {visibleEntries.map((entry) => {
        const childCatalog = catalogs[entry.id]
        // A branch stays open until the child's OWN catalog loaded empty; a
        // catalog that is missing, still loading, or failed keeps its level so
        // the rows appear the moment the projection lands.
        const knownLeaf = isKnownLeaf(catalogs, entry.id)
        const summary = byId[entry.id]
        const label = childLabel(entry, summary)
        const activity = childActivity(live, entry.id)
        const secondary = cardSecondary(summary, entry, activity)
        const childLoading = childCatalog === undefined
          || (childCatalog.state === 'loading' && childCatalog.entries.length === 0)
        const address: SidebarSubagentAddress = {
          parentSessionId,
          childSessionId: entry.id,
          // DSH 0.1.7 widened the runtime address to `mode: 'unknown'` (the
          // row's own mode). This plugin's structural mirror of the address
          // still spells the 0.1.6 pair — the cast is that pending widening,
          // not a claim about a shape the host rejects.
          mode: entry.mode as SidebarSubagentAddress['mode'],
        }
        const current = entry.id === currentSessionId

        return (
          <div key={entry.id} className={css.subagentNode}>
            <div
              role="treeitem"
              tabIndex={0}
              aria-level={level}
              aria-label={`${label} ${secondary}`}
              aria-current={current ? 'true' : undefined}
              {...knownLeaf ? {} : { 'aria-expanded': true }}
              className={clsx(css.subagentRow, current && css.subagentRowActive)}
              onClick={() => { openChild(address) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  openChild(address)
                }
              }}
            >
              <StateDot
                state={activity === 'running' ? 'ongoing' : 'done'}
                className={css.subagentDot}
              />
              <span className={css.subagentContent}>
                <span className={css.subagentLabel}>{label}</span>
                <span className={css.subagentSecondary}>{secondary}</span>
                {activity === 'running' && (
                  <SubagentLiveLines live={live[entry.id]} />
                )}
              </span>
            </div>
            {!knownLeaf && (
              <div role="group" className={css.subagentChildren} aria-busy={childLoading || undefined}>
                {childCatalog === undefined
                  ? (
                    <CatalogLoadingRows
                      parentSessionId={entry.id}
                      byId={byId}
                      level={level + 1}
                    />
                  )
                  : (
                    <CatalogRows
                      parentSessionId={entry.id}
                      catalog={childCatalog}
                      catalogs={catalogs}
                      byId={byId}
                      level={level + 1}
                      currentSessionId={currentSessionId}
                      live={live}
                      openChild={openChild}
                      refresh={refresh}
                    />
                  )}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

/**
 * The shared output dock of the jobs section: ONE pane at the bottom of the
 * sidebar body (sticky, terminal-like) shows the SELECTED job's output as
 * the MODEL has read it so far (replayed from the owner session's event
 * log), refreshed every {@link JOB_POLL_MS} while the job runs and the
 * page is visible. The model's `job_output` cursor is never touched — the
 * pane can never steal the agent's bytes, and it stays empty until the
 * agent reads the job. A single dock — not a panel per row — keeps the
 * job list compact and stable when many jobs are running.
 */
function JobOutputPane(props: {
  ownerSessionId: string
  job: SidebarJobView
  /** The page is visible (active tab + open panel): skip polling otherwise. */
  active: boolean
  onClose: () => void
}) {
  const { ownerSessionId, job, active, onClose } = props
  const [state, setState] = useState<'loading' | JobOutputResult | 'error'>('loading')
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const preRef = useRef<HTMLPreElement>(null)

  const load = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const result = await api.jobOutput({ sessionId: ownerSessionId }, job.id, controller.signal)
      setState(result)
    } catch {
      // A newer pull aborted this one, or the wire failed: keep the last
      // known output; only a dock that never loaded anything shows an error.
      setState(current => (current === 'loading' ? 'error' : current))
    }
  }, [ownerSessionId, job.id])

  useEffect(() => {
    void load()
    if (!active || !isJobLive(job)) return
    const timer = window.setInterval(() => { void load() }, JOB_POLL_MS)
    return () => { window.clearInterval(timer) }
    // isJobLive reads only job.status; whole-job identity churns on every
    // catalog refresh and must not restart the poll interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, active, job.status])

  useEffect(() => () => { controllerRef.current?.abort() }, [])

  // Terminal-tail behavior: while the job runs, each refresh pins the view
  // to the newest output; a settled dock leaves scrolling to the reader.
  useEffect(() => {
    if (!isJobLive(job) || typeof state !== 'object' || state.text.length === 0) return
    const pre = preRef.current
    if (pre !== null) pre.scrollTop = pre.scrollHeight
    // Same as the poll effect above: only the status transition matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, job.status])

  return (
    <div className={css.jobsPane} role="region" aria-label={`${job.label} ${t('jobs')}`}>
      <div className={css.jobsPaneHeader}>
        <StateDot state={jobDotState(job.status)} className={css.jobsPaneDot} />
        <span className={css.jobsPaneLabel} title={job.label}>{job.label}</span>
        <span className={css.jobsPaneStatus}>
          {jobStatusLabel(job.status, t)}
          {job.detail !== undefined && job.detail !== '' ? ` · ${job.detail}` : ''}
        </span>
        <button
          type="button"
          className={css.jobsPaneClose}
          aria-label={t('close')}
          title={t('close')}
          onClick={onClose}
        >
          <IconStopOutline16 size={10} />
        </button>
      </div>
      {state === 'loading' && <div className={css.jobsPaneHint}>{t('loading')}</div>}
      {state === 'error' && (
        <div className={`${css.jobsPaneHint} ${css.jobsPaneError}`}>{t('jobOutputError')}</div>
      )}
      {typeof state === 'object' && (
        <>
          {state.text.length > 0
            ? <pre ref={preRef} className={css.jobsPanePre}>{state.text}</pre>
            : state.read
              ? <div className={css.jobsPaneHint}>{t('jobNoOutput')}</div>
              : <div className={css.jobsPaneHint}>{t('jobNotReadYet')}</div>}
          {state.truncated && <div className={css.jobsPaneHint}>{t('jobOutputTruncated')}</div>}
        </>
      )}
    </div>
  )
}

/**
 * The background-job section of the Subagent page: every job of the whole
 * current tree (main agent + subagents, owner-labeled), read through the
 * plugin's `jobs.list` route while the page is visible. Clicking a row feeds
 * its model-read output to the shared bottom dock (event replay — never the
 * model's cursor); live rows carry a two-click-confirm kill button. Renders
 * nothing while the tree has no jobs.
 */
function JobsSection(props: {
  byId: SidebarSessionList['byId']
  rootId: string | undefined
  /** The page is visible (active tab + open panel): skip polling otherwise. */
  active: boolean
}) {
  const { byId, rootId, active } = props
  // The registry's access fence admits a job to its OWNER session only, so the
  // tree's jobs are one read per tree session — fanned out on each tick and
  // keyed by owner for the (pure) collection below.
  const treeIds = useMemo(() => [...treeSessionIds(byId, rootId)], [byId, rootId])
  // Tracy: sessions whose `jobs.list` answered 403 — the account may not read
  // this session's list (dsh-passwords holds it to the seat's session grant), so they
  // are never asked again while the page lives (TCH #515). Filtered here, not
  // in the tick, so a re-render or a new tree list never re-asks them; a 503
  // or a dropped read is not a refusal and keeps the retry. The ref holds the
  // same set for the tick itself, which may run again before React renders.
  const forbiddenRef = useRef<ReadonlySet<string>>(new Set())
  const [forbiddenIds, setForbiddenIds] = useState<ReadonlySet<string>>(() => new Set())
  const pollIds = useMemo(() => treeIds.filter(id => !forbiddenIds.has(id)), [treeIds, forbiddenIds])
  const [jobsBySession, setJobsBySession] = useState<Readonly<Record<string, readonly SidebarJobView[]>>>({})
  const poll = useCallback(async (signal: AbortSignal): Promise<void> => {
    const refused: string[] = []
    const asked = pollIds.filter(id => !forbiddenRef.current.has(id))
    if (asked.length === 0) return
    const entries = await Promise.all(asked.map(async (sessionId): Promise<[string, readonly SidebarJobView[]]> => {
      try {
        const result = await api.jobsList(sessionId, signal)
        return [sessionId, result.jobs]
      } catch (error) {
        // A host without the jobs service (503) or one dropped read degrades
        // to an empty set for THIS session; the next tick retries.
        if (isForbiddenError(error)) refused.push(sessionId)
        return [sessionId, []]
      }
    }))
    if (signal.aborted) return
    setJobsBySession(Object.fromEntries(entries))
    if (refused.length > 0) {
      forbiddenRef.current = new Set([...forbiddenRef.current, ...refused])
      setForbiddenIds(forbiddenRef.current)
    }
  }, [pollIds])
  usePolling(active && pollIds.length > 0, poll, {
    intervalMs: JOBS_POLL_MS,
    mode: 'self-scheduling',
    immediate: true,
  })
  const rows = useMemo(
    () => orderJobs(collectTreeJobs(byId, jobsBySession, rootId)),
    [byId, jobsBySession, rootId],
  )
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [armedId, setArmedId] = useState<string | undefined>(undefined)
  const [killingId, setKillingId] = useState<string | undefined>(undefined)
  const [killErrorId, setKillErrorId] = useState<string | undefined>(undefined)
  // The duration clock only runs while a live row is on screen.
  const [now, setNow] = useState(() => Date.now())

  const selectedRow = useMemo(
    () => (selectedId === undefined ? undefined : rows.find(row => row.job.id === selectedId)),
    [rows, selectedId],
  )

  const liveCount = useMemo(
    () => rows.reduce((count, row) => count + (isJobLive(row.job) ? 1 : 0), 0),
    [rows],
  )
  const multiOwner = useMemo(
    () => new Set(rows.map(row => row.ownerSessionId)).size > 1,
    [rows],
  )

  // The kill button stays armed only briefly; a stray click must never kill.
  useEffect(() => {
    if (armedId === undefined) return
    const timer = window.setTimeout(() => { setArmedId(undefined) }, JOB_KILL_ARM_MS)
    return () => { window.clearTimeout(timer) }
  }, [armedId])

  useEffect(() => {
    if (liveCount === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [liveCount])

  // The docked output pane follows its job: when the selected job leaves
  // the mirror (settled and dropped, or the tree switched), close the dock.
  useEffect(() => {
    if (selectedId !== undefined && selectedRow === undefined) setSelectedId(undefined)
  }, [selectedId, selectedRow])

  // NOTE: every hook must live ABOVE the empty-state return — a hook below it
  // would flip this component's hook count when the mirror empties and crash
  // React with "Rendered fewer hooks than expected" (the #300 regression).
  const kill = useCallback(async (row: TreeJob): Promise<void> => {
    setKillingId(row.job.id)
    setKillErrorId(undefined)
    try {
      await api.jobKill({ sessionId: row.ownerSessionId }, row.job.id)
    } catch {
      setKillErrorId(row.job.id)
    } finally {
      setKillingId(undefined)
      setArmedId(undefined)
    }
  }, [])

  if (rows.length === 0) return null

  const countLabel = liveCount > 0
    ? t('jobsCountRunning', { count: rows.length, running: liveCount })
    : t('jobsCount', { count: rows.length })

  return (
    <>
      <section className={css.jobs} aria-label={t('jobs')}>
        <div className={css.jobsHeader}>
          <span className={css.jobsTitle}>{t('jobs')}</span>
          <span className={css.jobsCount}>{countLabel}</span>
        </div>
        <ul className={css.jobsList} aria-label={t('jobs')}>
          {rows.map((row) => {
            const { job } = row
            const live = isJobLive(job)
            const selected = selectedId === job.id
            const armed = armedId === job.id
            const killing = killingId === job.id
            const killFailed = killErrorId === job.id
            const elapsed = live
              ? now - job.startedAt
              : (job.finishedAt ?? job.startedAt) - job.startedAt
            const secondary = [
              ...(multiOwner ? [row.ownerTitle] : []),
              jobStatusLabel(job.status, t),
              ...(job.detail !== undefined && job.detail !== '' ? [job.detail] : []),
              formatJobDuration(elapsed, t),
            ].filter(Boolean).join(' · ')
            return (
              <li
                key={job.id}
                className={clsx(
                  css.jobsRow,
                  !live && css.jobsRowSettled,
                  selected && css.jobsRowSelected,
                )}
              >
                <button
                  type="button"
                  className={css.jobsRowMain}
                  aria-pressed={selected}
                  aria-label={`${job.label} ${secondary}`}
                  onClick={() => { setSelectedId(selected ? undefined : job.id) }}
                >
                  <StateDot state={jobDotState(job.status)} className={css.jobsDot} />
                  <span className={css.jobsContent}>
                    <span className={css.jobsLabelLine}>
                      <span className={css.jobsKind}>{job.kind}</span>
                      <span className={css.jobsLabel} title={job.label}>{job.label}</span>
                    </span>
                    <span className={css.jobsSecondary}>{secondary}</span>
                  </span>
                </button>
                {job.status === 'running' && (
                  <button
                    type="button"
                    className={armed ? `${css.jobsKill} ${css.jobsKillArmed}` : css.jobsKill}
                    aria-label={armed ? t('jobKillConfirm') : t('jobKill')}
                    title={armed ? t('jobKillConfirm') : t('jobKill')}
                    disabled={killing}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (armed) void kill(row)
                      else setArmedId(job.id)
                    }}
                  >
                    {armed ? t('jobKillConfirm') : <IconStopOutline16 size={12} />}
                  </button>
                )}
                {killFailed && <span className={css.jobsKillError}>{t('jobKillError')}</span>}
              </li>
            )
          })}
        </ul>
      </section>
      {selectedRow !== undefined && (
        <JobOutputPane
          ownerSessionId={selectedRow.ownerSessionId}
          job={selectedRow.job}
          active={active}
          onClose={() => { setSelectedId(undefined) }}
        />
      )}
    </>
  )
}

/**
 * The client's own "show this conversation" verb. DSH 0.1.6 moved child and
 * session navigation OFF `ISessions` (0.1.5's `open` / `openSubagent`, neither
 * of which exists any more — the optional calls this page used were silently
 * dead) onto the workspace face, which owns the main-view selection. The
 * pre-0.1.6 faces stay as the fallback for a host that predates the move.
 */
interface ConversationNavigation {
  openSession?(target: SidebarSubagentAddress | string): void
}

/** The per-parent catalog refresh across the two DSH generations. */
interface CatalogRefreshFace {
  refreshProjections?(sessionId: string): Promise<void>
  refreshSubagents?(sessionId: string): Promise<void>
}

/**
 * The sidebar's Subagent topology page.
 * @param props - current session id, whether the page is actually visible
 *   (active tab + open panel), the client context, and an optional
 *   jump-notify hook fired right before the child is opened (lets the sidebar
 *   shell re-open the Subagent page after the conversation switch lands on
 *   the child session).
 * @returns the main agent's topology tree, or the empty/error/loading states.
 */
export function SubagentView(props: {
  sessionId: string
  active: boolean
  ctx: Context
  onOpenChild?: (address: SidebarSubagentAddress) => void
}) {
  const { sessionId, active, ctx, onOpenChild } = props
  const sessions = ctx.sessions

  // The same list feed the official catalog consumes (`byId` lineage + the
  // host-computed projection values). A snapshot without the projection seam
  // (a pre-0.1.7 runtime) leaves every catalog absent, so the topology shows
  // the root card alone — no rows, and no empty-state copy either.
  const list = useSyncExternalStore(
    useMemo(() => (callback: () => void) => sessions.list.subscribe(callback), [sessions]),
    useCallback(() => sessions.list.getSnapshot(), [sessions]),
  )
  const byId = list.byId
  // One fold per snapshot: the views are what every row, the branch test and
  // the loading/error states read, and a fresh object per render would
  // invalidate each of their memos.
  const catalogs = useMemo(() => subagentCatalogs(list.projectionsBySession), [list.projectionsBySession])

  // The topology root: the main agent of the current session's tree.
  const rootId = useMemo(() => rootAncestor(byId, sessionId), [byId, sessionId])
  const rootCatalog = rootId === undefined ? undefined : catalogs[rootId]
  const rootSummary = rootId === undefined ? undefined : byId[rootId]
  const live = useSubagentLive(rootId, active)

  const openConversation = useCallback((target: SidebarSubagentAddress | string): void => {
    const workspace = ctx.get('uiWorkspace') as unknown as ConversationNavigation | undefined
    if (typeof workspace?.openSession === 'function') {
      workspace.openSession(target)
      return
    }
    if (typeof target === 'string') sessions.open?.(target)
    else sessions.openSubagent?.(target)
  }, [ctx, sessions])

  const openChild = useCallback((address: SidebarSubagentAddress): void => {
    // Notify the shell first: the jump switches the sidebar to the child
    // session's own layout, and the shell re-opens the Subagent page on top
    // of it (the topology stays rooted at the main agent with the child
    // highlighted) — the README "page stays open" contract.
    onOpenChild?.(address)
    try {
      openConversation(address)
    } catch (error) {
      console.error('[dsh-better-sidebar] open subagent failed:', error)
    }
  }, [openConversation, onOpenChild])

  /** Jump back to the main agent (the topology root) from its node. */
  const openMain = useCallback((): void => {
    if (rootId === undefined) return
    try {
      openConversation(rootId)
    } catch (error) {
      console.error('[dsh-better-sidebar] open session failed:', error)
    }
  }, [openConversation, rootId])

  const refresh = useCallback((parentSessionId: string): void => {
    // 0.1.7 renamed the per-parent catalog refresh to `refreshProjections`
    // (the projection store owns every session's values now); calling the
    // removed 0.1.6 name alone would make this button a silent no-op.
    const face = sessions as CatalogRefreshFace
    void (face.refreshProjections ?? face.refreshSubagents)?.(parentSessionId)
  }, [sessions])

  const totals = useMemo(
    () => rootId === undefined
      ? { count: 0, runningCount: 0 }
      : countSubagentDescendants(byId, rootId),
    [byId, rootId],
  )
  // Session summaries can announce membership before the descriptor-backed
  // catalog catches up (or a catalog that just went ready is still empty).
  const summaryBackedLoading = rootId !== undefined
    && (rootCatalog === undefined || (rootCatalog.state === 'ready' && rootCatalog.entries.length === 0))
    && directChildren(byId, rootId).length > 0
  const readyEmpty = rootCatalog?.state === 'ready'
    && rootCatalog.entries.length === 0
    && directChildren(byId, rootId ?? '').length === 0
  const countLabel = totals.count === 0
    ? undefined
    : totals.runningCount > 0
      ? t('subagentCountRunning', { count: totals.count, running: totals.runningCount })
      : t('subagentCount', { count: totals.count })

  /** Arrow-key tree navigation over the visible rows (official catalog recipe). */
  const bodyRef = useRef<HTMLDivElement>(null)
  const focusAt = useCallback((index: number): void => {
    const items = bodyRef.current?.querySelectorAll<HTMLElement>(
      '[role="treeitem"]:not([aria-disabled="true"])',
    ) ?? []
    if (items.length === 0) return
    items[(index + items.length) % items.length]?.focus()
  }, [])
  const onTreeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    const items = bodyRef.current?.querySelectorAll<HTMLElement>(
      '[role="treeitem"]:not([aria-disabled="true"])',
    ) ?? []
    const index = Array.prototype.indexOf.call(items, document.activeElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusAt(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusAt(index < 0 ? items.length - 1 : index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusAt(items.length - 1)
    }
  }, [focusAt])

  return (
    <div className={css.subagent}>
      <div className={css.subagentHeader}>
        <span className={css.subagentTitle}>
          {t('subagent')}
          {rootSummary?.displayTitle !== undefined && rootSummary.displayTitle !== ''
            ? ` · ${rootSummary.displayTitle}`
            : ''}
        </span>
        {countLabel !== undefined && <span className={css.subagentCount}>{countLabel}</span>}
        <button
          type="button"
          className={css.subagentRefresh}
          aria-label={t('refresh')}
          title={t('refresh')}
          disabled={rootId === undefined}
          onClick={() => { if (rootId !== undefined) refresh(rootId) }}
        >
          <IconRefreshOutlineRegular size={14} />
        </button>
      </div>
      <div
        ref={bodyRef}
        className={css.subagentBody}
        onKeyDown={onTreeKeyDown}
      >
        <div
          role="tree"
          aria-label={t('subagent')}
          aria-busy={summaryBackedLoading || undefined}
        >
          {rootId !== undefined && rootSummary !== undefined && (
            <div
              role="treeitem"
              tabIndex={0}
              aria-level={0}
              aria-label={`${rootSummary.displayTitle !== '' ? rootSummary.displayTitle : t('subagentMainAgent')} ${t('subagentMainAgent')}`}
              aria-current={rootId === sessionId ? 'true' : undefined}
              className={clsx(css.subagentRow, rootId === sessionId && css.subagentRowActive)}
              onClick={openMain}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  openMain()
                }
              }}
            >
              <StateDot
                state={rootSummary.running === true ? 'ongoing' : 'done'}
                className={css.subagentDot}
              />
              <span className={css.subagentContent}>
                <span className={css.subagentLabel}>
                  {rootSummary.displayTitle !== '' ? rootSummary.displayTitle : t('subagentMainAgent')}
                </span>
                <span className={css.subagentSecondary}>
                  {`${t('subagentMainAgent')} · ${rootSummary.running === true ? t('subagentRunning') : t('subagentInactive')}`}
                </span>
              </span>
            </div>
          )}
          {rootId !== undefined && (
            <div className={css.subagentChildren} role="group" aria-busy={summaryBackedLoading || undefined}>
              {summaryBackedLoading && (
                <CatalogLoadingRows parentSessionId={rootId} byId={byId} level={1} />
              )}
              {!summaryBackedLoading && (
                <CatalogRows
                  parentSessionId={rootId}
                  catalog={rootCatalog}
                  catalogs={catalogs}
                  byId={byId}
                  level={1}
                  currentSessionId={sessionId}
                  live={live}
                  openChild={openChild}
                  refresh={refresh}
                />
              )}
            </div>
          )}
          {readyEmpty && (
            <div className={css.subagentEmpty}>
              <div>{t('subagentEmpty')}</div>
              <div className={css.subagentEmptyHint}>{t('subagentEmptyDesc')}</div>
            </div>
          )}
        </div>
        <JobsSection
          byId={byId}
          rootId={rootId}
          active={active}
        />
      </div>
    </div>
  )
}
