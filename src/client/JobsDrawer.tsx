/**
 * The background-jobs bottom drawer of the Tasks page and its output popover.
 *
 * Drawer: the tree's jobs (owner-labeled, fed by the `session/jobs` push
 * mirror) collapse into a bottom bar that AUTO-COLLAPSES once the tree has
 * many agents — the manual toggle always wins afterwards.
 *
 * Popover: clicking a row opens a DRAGGABLE, portalled output card (see
 * AnchoredPopover) instead of docking a pane inside the page. It shows the
 * output the MODEL has read (event replay — never the model's job_output
 * cursor), with a copy action, a follow-latest switch, the two-click kill,
 * and a terminal-style tail while the job runs.
 *
 * Every control is a host primitive (Button / Tag / Switch / StateDot).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconChevronUpOutlineRegular, IconCopyOutlineRegular, IconStopFillRegular, StateDot, Switch, Tag,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarJobView } from '../context-types.ts'
import {
  formatJobDuration,
  isJobLive,
  jobDotState,
  jobStatusLabel,
  type TreeJob,
} from './subagent-jobs.ts'
import { api, type JobOutputResult } from './api.ts'
import { t } from './locales.ts'
import css from './tasks-graph.module.css'

/** Refresh cadence of an open job-output popover while its job runs. */
const JOB_POLL_MS = 2000
/** How long the kill button stays armed before it needs re-confirming. */
const JOB_KILL_ARM_MS = 3000
/** The agent count at which the drawer starts collapsed. */
export const JOBS_DRAWER_COLLAPSE_AT = 8

/** The Tag tone of one job status. */
function jobTone(job: SidebarJobView): TagTone {
  if (job.status === 'running') return 'info'
  if (job.status === 'completed') return 'success'
  if (job.status === 'failed') return 'danger'
  return 'neutral'
}

export interface JobsDrawerProps {
  rows: readonly TreeJob[]
  /** Agent count of the tree (root included) — the auto-collapse signal. */
  agentCount: number
  /** Open the output popover of one row (anchor = the row's main button). */
  onOpenOutput(row: TreeJob, anchor: HTMLElement): void
  /** The job whose output popover is currently open (row highlight). */
  openJobId?: string
}

export function JobsDrawer(props: JobsDrawerProps): ReactNode {
  const { rows, agentCount, onOpenOutput, openJobId } = props
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
        <span className={css.jobsDrawerChev} data-open={open ? 'true' : 'false'} aria-hidden="true">
          <IconChevronUpOutlineRegular size={12} />
        </span>
      </button>
      {!autoOpen && <div className={css.jobsAutoNote}>{t('jobsAutoCollapsed')}</div>}
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
              ...(job.detail !== undefined && job.detail !== '' ? [job.detail] : []),
              formatJobDuration(elapsed, t),
            ].filter(Boolean).join(' · ')
            return (
              <div
                key={job.id}
                className={css.jobsRow}
                data-settled={live ? 'false' : 'true'}
                data-open={openJobId === job.id ? 'true' : 'false'}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className={css.jobsRowMain}
                  aria-label={`${job.label} ${jobStatusLabel(job.status, t)} ${secondary}`}
                  title={t('jobViewOutput')}
                  onClick={(event) => { onOpenOutput(row, event.currentTarget) }}
                >
                  <StateDot state={jobDotState(job.status)} size={6} />
                  <Tag tone="quiet">{job.kind}</Tag>
                  <span className={css.jobsLabel} title={job.label}>{job.label}</span>
                  <Tag tone={jobTone(job)}>{jobStatusLabel(job.status, t)}</Tag>
                  <span className={css.jobsMeta}>{secondary}</span>
                </Button>
                {/*
                  The terminate column is reserved by EVERY row (settled ones
                  included): the button lives inside a fixed 28px box, so
                  revealing it on hover/focus or arming the confirm never
                  re-flows the row's text.
                */}
                <span className={css.jobsKillSlot}>
                  {job.status === 'running' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className={css.jobsKill}
                      data-armed={armed ? 'true' : 'false'}
                      icon={<IconStopFillRegular size={11} />}
                      aria-label={armed ? t('jobKillConfirm') : t('jobKill')}
                      title={armed ? t('jobKillConfirm') : t('jobKill')}
                      disabled={killing}
                      onClick={() => {
                        if (armed) void kill(row)
                        else setArmedId(job.id)
                      }}
                    >
                      {armed ? t('jobKillConfirm') : undefined}
                    </Button>
                  )}
                  {killFailed && <span className={css.jobsKillError}>{t('jobKillError')}</span>}
                </span>
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
 * {@link JOB_POLL_MS} while the job runs and the page is visible. The reader
 * can copy the output and turn the terminal-style tail off; the kill action
 * keeps its two-click confirm.
 */
export function JobOutputPopoverContent(props: {
  ownerSessionId: string
  job: SidebarJobView
  active: boolean
}): ReactNode {
  const { ownerSessionId, job, active } = props
  const [state, setState] = useState<'loading' | JobOutputResult | 'error'>('loading')
  const [follow, setFollow] = useState(true)
  const [copied, setCopied] = useState(false)
  const [armed, setArmed] = useState(false)
  const [killing, setKilling] = useState(false)
  const [killFailed, setKillFailed] = useState(false)
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const preRef = useRef<HTMLPreElement>(null)
  const live = isJobLive(job)

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
    if (!active || !live) return
    const timer = window.setInterval(() => { void load() }, JOB_POLL_MS)
    return () => { window.clearInterval(timer) }
    // isJobLive reads only job.status; the job object churns on every catalog
    // refresh and must not restart the poll interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, active, job.status])

  useEffect(() => () => { controllerRef.current?.abort() }, [])

  // The armed kill disarms itself, like the drawer's button.
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => { setArmed(false) }, JOB_KILL_ARM_MS)
    return () => { window.clearTimeout(timer) }
  }, [armed])

  // Terminal-tail behavior: each refresh pins the view to the newest output
  // while the reader keeps the follow switch on.
  useEffect(() => {
    if (!live || !follow || typeof state !== 'object' || state.text.length === 0) return
    const pre = preRef.current
    if (pre !== null) pre.scrollTop = pre.scrollHeight
    // Same as the poll effect: only the status transition matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, job.status, follow])

  const text = typeof state === 'object' ? state.text : ''

  /** Two-click kill from the popover (then re-read so the row settles). */
  const kill = async (): Promise<void> => {
    setKilling(true)
    setKillFailed(false)
    try {
      await api.jobKill({ sessionId: ownerSessionId }, job.id)
      setArmed(false)
      await load()
    } catch {
      setKillFailed(true)
    } finally {
      setKilling(false)
    }
  }

  return (
    <div className={css.popCard} data-popover-handle>
      <div className={css.popHead}>
        <span>{t('jobs')}</span>
        <span className={css.popHeadActions} data-popover-no-drag>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconCopyOutlineRegular size={12} />}
            aria-label={copied ? t('jobCopied') : t('jobCopyOutput')}
            title={copied ? t('jobCopied') : t('jobCopyOutput')}
            disabled={text === ''}
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(() => {
                setCopied(true)
                window.setTimeout(() => { setCopied(false) }, 1500)
              })
            }}
          />
        </span>
      </div>
      <div className={css.jobPopTitle}>
        <StateDot state={jobDotState(job.status)} size={6} />
        <span className={css.popTitle} title={job.label}>{job.label}</span>
        <Tag tone={jobTone(job)}>{jobStatusLabel(job.status, t)}</Tag>
      </div>
      <div className={css.jobPopMeta}>
        <Tag tone="quiet">{job.kind}</Tag>
        {job.detail !== undefined && job.detail !== '' && <span>{job.detail}</span>}
        <span className={css.popHint}>{t('jobDragHint')}</span>
      </div>
      {state === 'loading' && <div className={css.popHint}>{t('loading')}</div>}
      {state === 'error' && <div className={css.popError}>{t('jobOutputError')}</div>}
      {typeof state === 'object' && (
        <>
          {state.text.length > 0
            ? <pre ref={preRef} className={`${css.popPre} ${css.jobPopPre}`} data-popover-no-drag>{state.text}</pre>
            : state.read
              ? <div className={css.popHint}>{t('jobNoOutput')}</div>
              : <div className={css.popHint}>{t('jobNotReadYet')}</div>}
          {state.truncated && <div className={css.popHint}>{t('jobOutputTruncated')}</div>}
        </>
      )}
      <div className={css.jobPopActions} data-popover-no-drag>
        {/*
          The host Switch draws a bare track, so its wording rides beside it —
          the same `jobFollowTail` copy the switch already carries as its
          accessible name.
        */}
        <span className={css.jobPopFollow}>
          <Switch
            checked={follow}
            onChange={setFollow}
            label={t('jobFollowTail')}
            disabled={!live}
          />
          <span className={css.jobPopFollowLabel}>{t('jobFollowTail')}</span>
        </span>
        {live && (
          <Button
            variant="outline"
            size="sm"
            className={armed ? css.jobPopKillArmed : undefined}
            icon={<IconStopFillRegular size={11} />}
            disabled={killing}
            onClick={() => {
              if (armed) void kill()
              else setArmed(true)
            }}
          >
            {armed ? t('jobKillConfirm') : t('jobKill')}
          </Button>
        )}
      </div>
      {killFailed && <div className={css.popError}>{t('jobKillError')}</div>}
    </div>
  )
}
