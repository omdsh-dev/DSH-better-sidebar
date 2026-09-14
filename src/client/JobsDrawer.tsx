/**
 * The background-jobs bottom drawer of the Tasks page: the tree's jobs
 * (owner-labeled, fed by the `session/jobs` push mirror) collapse into a
 * bottom bar that AUTO-COLLAPSES when the agent count crosses the page's
 * threshold — the manual toggle always wins afterwards. Job output no
 * longer docks inside the page: clicking a row opens an anchored popover
 * (event replay — never the model's job_output cursor). Live rows keep the
 * two-click-confirm kill.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronUpOutline14, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarJobView } from '../context-types.ts'
import {
  formatJobDuration,
  isJobLive,
  jobDotState,
  jobStatusLabel,
  type TreeJob,
} from './subagent-jobs.ts'
import { api, type JobOutputResult } from './api.ts'
import { IconStopOutline16 } from './icons.tsx'
import { t } from './locales.ts'
import css from './tasks-graph.module.css'

/** Refresh cadence of an open job-output popover while its job runs. */
const JOB_POLL_MS = 2000
/** How long the kill button stays armed before it needs re-confirming. */
const JOB_KILL_ARM_MS = 3000

export interface JobsDrawerProps {
  rows: readonly TreeJob[]
  /** Agent count of the tree (root included) — the auto-collapse signal. */
  agentCount: number
  /** Open the output popover of one row (anchor = the row's main button). */
  onOpenOutput(row: TreeJob, anchor: HTMLElement): void
}

/** The agent count at which the drawer starts collapsed. */
export const JOBS_DRAWER_COLLAPSE_AT = 8

export function JobsDrawer(props: JobsDrawerProps): ReactNode {
  const { rows, agentCount, onOpenOutput } = props
  const autoOpen = agentCount < JOBS_DRAWER_COLLAPSE_AT
  /** Manual override; undefined = follow the auto rule. */
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(undefined)
  const open = manualOpen ?? autoOpen
  const [armedId, setArmedId] = useState<string | undefined>(undefined)
  const [killingId, setKillingId] = useState<string | undefined>(undefined)
  const [killErrorId, setKillErrorId] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())

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
    <section className={css.jobsDrawer} aria-label={t('jobs')}>
      <button
        type="button"
        className={css.jobsDrawerBar}
        aria-expanded={open}
        onClick={() => { setManualOpen(!open) }}
      >
        <span>{t('jobs')}</span>
        <span className={css.jobsBigNum}>{liveCount > 0 ? liveCount : rows.length}</span>
        <span className={css.jobsDrawerCount}>{countLabel}</span>
        <span className={clsx(css.jobsDrawerChev, open && css.jobsDrawerChevOpen)} aria-hidden="true">
          <IconChevronUpOutline14 size={12} />
        </span>
      </button>
      {!autoOpen && (
        <div className={css.jobsAutoNote}>
          {t('jobsAutoCollapsed')}
        </div>
      )}
      {open && (
        <div className={css.jobsDrawerBody}>
          {rows.map((row) => {
            const { job } = row
            const live = isJobLive(job)
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
              <div key={job.id} className={clsx(css.jobsRow, !live && css.jobsRowSettled)}>
                <button
                  type="button"
                  className={css.jobsRowMain}
                  aria-label={`${job.label} ${secondary}`}
                  title={t('jobViewOutput')}
                  onClick={(event) => { onOpenOutput(row, event.currentTarget) }}
                >
                  <StateDot state={jobDotState(job.status)} size={6} />
                  <span className={css.jobsKind}>{job.kind}</span>
                  <span className={css.jobsLabel} title={job.label}>{job.label}</span>
                  <span className={css.jobsMeta}>{secondary}</span>
                </button>
                {job.status === 'running' && (
                  <button
                    type="button"
                    className={clsx(css.jobsKill, armed && css.jobsKillArmed)}
                    aria-label={armed ? t('jobKillConfirm') : t('jobKill')}
                    title={armed ? t('jobKillConfirm') : t('jobKill')}
                    disabled={killing}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (armed) void kill(row)
                      else setArmedId(job.id)
                    }}
                  >
                    {armed ? '!' : <IconStopOutline16 size={12} />}
                  </button>
                )}
                {killFailed && <span className={css.jobsKillError}>{t('jobKillError')}</span>}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/**
 * The output popover content of one job: the text the MODEL has read so far
 * (replayed from the owner session's event log), refreshed every
 * {@link JOB_POLL_MS} while the job runs and the page is visible, pinned to
 * the newest output like a terminal tail while live.
 */
export function JobOutputPopoverContent(props: {
  ownerSessionId: string
  job: SidebarJobView
  active: boolean
}): ReactNode {
  const { ownerSessionId, job, active } = props
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
      // known output; only a popover that never loaded anything shows an error.
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
  // to the newest output; a settled popover leaves scrolling to the reader.
  useEffect(() => {
    if (!isJobLive(job) || typeof state !== 'object' || state.text.length === 0) return
    const pre = preRef.current
    if (pre !== null) pre.scrollTop = pre.scrollHeight
    // Same as the poll effect above: only the status transition matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, job.status])

  return (
    <div className={css.popCard} style={{ width: 340 }}>
      <span className={css.popTitle} title={job.label}>
        <StateDot state={jobDotState(job.status)} size={8} /> {job.label}
      </span>
      <span className={css.popHint}>
        {jobStatusLabel(job.status, t)}
        {job.detail !== undefined && job.detail !== '' ? ` · ${job.detail}` : ''}
      </span>
      {state === 'loading' && <div className={css.popHint}>{t('loading')}</div>}
      {state === 'error' && <div className={css.popError}>{t('jobOutputError')}</div>}
      {typeof state === 'object' && (
        <>
          {state.text.length > 0
            ? <pre ref={preRef} className={css.popPre}>{state.text}</pre>
            : state.read
              ? <div className={css.popHint}>{t('jobNoOutput')}</div>
              : <div className={css.popHint}>{t('jobNotReadYet')}</div>}
          {state.truncated && <div className={css.popHint}>{t('jobOutputTruncated')}</div>}
        </>
      )}
    </div>
  )
}
