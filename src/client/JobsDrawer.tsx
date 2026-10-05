/**
 * The background-jobs bottom drawer of the Tasks page and its output popover.
 *
 * Drawer: the tree's jobs (owner-labeled, fed by the HOST's client jobs
 * service — see jobs-client.ts) collapse into a bottom bar that AUTO-COLLAPSES
 * once the tree has many agents — the manual toggle always wins afterwards.
 *
 * Window: clicking a row opens a PERSISTENT floating window (FloatingWindow —
 * draggable, resizable, closed only by its own button or Escape), because a
 * job's output is something the reader watches for minutes: the popover it
 * used to open was dismissed by any click elsewhere and had no height bound,
 * so a chatty job ran off the bottom of the screen. The window's BODY is the
 * scroll container, so the output stays readable whatever its length. It shows
 * what the host streams for an OBSERVER (never the model's consuming cursor),
 * with a copy action in the title bar, a follow-latest switch and the
 * two-click kill in the footer, and a terminal-style tail while the job runs.
 *
 * Every control is a host primitive (Button / Tag / Switch / StateDot /
 * TerminalBlock).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconChevronUpOutlineRegular, IconCopyOutlineRegular, IconStopFillRegular, StateDot, Switch, Tag,
  TerminalBlock, type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarClientJobsService, SidebarJobView, SidebarObservedJob } from '../context-types.ts'
import { terminalBlockLabels } from './block-labels.ts'
import {
  formatJobDuration,
  isJobLive,
  jobDotState,
  jobStatusLabel,
  type TreeJob,
} from './subagent-jobs.ts'
import { FloatingWindow } from './FloatingWindow.tsx'
import { t } from './locales.ts'
import css from './tasks-graph.module.css'

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
  /** The host client jobs service; absent → no kill control is offered. */
  jobs: SidebarClientJobsService | undefined
  /** The observed output of the job whose panel is open (host stream). */
  observed: SidebarObservedJob | undefined
  /** Agent count of the tree (root included) — the auto-collapse signal. */
  agentCount: number
  /** Open the output popover of one row (anchor = the row's main button). */
  onOpenOutput(row: TreeJob, anchor: HTMLElement): void
  /** The job whose output popover is currently open (row highlight). */
  openJobId?: string
}

export function JobsDrawer(props: JobsDrawerProps): ReactNode {
  const { rows, agentCount, jobs, onOpenOutput, openJobId } = props
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
    if (jobs === undefined) return
    setKillingId(row.job.id)
    setKillErrorId(undefined)
    try {
      await jobs.kill(row.ownerSessionId, row.job.id)
    } catch {
      setKillErrorId(row.job.id)
    } finally {
      setKillingId(undefined)
      setArmedId(undefined)
    }
  }, [jobs])

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
 * The output WINDOW of one job: what the host streams for an observer of this
 * job, inside the plugin's persistent floating window. The window owns the
 * frame, the geometry and the dismissal contract; this component owns the
 * content (status header rows, the terminal tail) and the footer controls
 * (follow-latest, two-click kill).
 */
export function JobOutputWindow(props: {
  /** The host client jobs service (absent → the panel only reports that). */
  jobs: SidebarClientJobsService | undefined
  job: SidebarJobView
  /** The owner session the roster carried the job under (kill + observation). */
  ownerSessionId: string
  /** The host's streamed observation of THIS job (undefined until it arrives). */
  observed: SidebarObservedJob | undefined
  /** The row's main button — where the window first appears. */
  anchor?: HTMLElement | null
  /** Close the window (the close button, or Escape). */
  onClose(): void
}): ReactNode {
  const { jobs, job, ownerSessionId, observed, anchor, onClose } = props
  const [follow, setFollow] = useState(true)
  const [copied, setCopied] = useState(false)
  const [armed, setArmed] = useState(false)
  const [killing, setKilling] = useState(false)
  const [killFailed, setKillFailed] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const live = isJobLive(job)
  const text = observed?.text ?? ''
  const labels = useMemo(() => terminalBlockLabels(), [])

  // The armed kill disarms itself, like the drawer's button.
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => { setArmed(false) }, JOB_KILL_ARM_MS)
    return () => { window.clearTimeout(timer) }
  }, [armed])

  // Terminal-tail behavior: every frame pins the BODY (the window's own scroll
  // container — the element the previous popover wrapped in a div that never
  // scrolled) to the newest output while the reader keeps follow on.
  useEffect(() => {
    if (!live || !follow || text.length === 0) return
    const body = bodyRef.current
    if (body !== null) body.scrollTop = body.scrollHeight
  }, [text, live, follow])

  /** Two-click kill from the window (the roster settles the row afterwards). */
  const kill = async (): Promise<void> => {
    if (jobs === undefined) return
    setKilling(true)
    setKillFailed(false)
    try {
      await jobs.kill(ownerSessionId, job.id)
      setArmed(false)
    } catch {
      setKillFailed(true)
    } finally {
      setKilling(false)
    }
  }

  return (
    <FloatingWindow
      title={job.label}
      onClose={onClose}
      {...(anchor === undefined ? {} : { anchor })}
      bodyRef={bodyRef}
      actions={(
        <>
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
        </>
      )}
      footer={(
        <div className={css.jobPopActions}>
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
          {killFailed && <div className={css.popError}>{t('jobKillError')}</div>}
        </div>
      )}
    >
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
      {observed === undefined && <div className={css.popHint}>{t('loading')}</div>}
      {observed !== undefined && (
        <>
          {observed.gapBefore && <div className={css.popHint}>{t('jobOutputTruncated')}</div>}
          {observed.error !== undefined && <div className={css.popError}>{t('jobOutputError')}</div>}
          {observed.text.length > 0
            ? (
              <div>
                <TerminalBlock
                  command={job.label}
                  output={observed.text}
                  running={observed.streaming}
                  runStateDot={false}
                  maxLines={Number.POSITIVE_INFINITY}
                  copyText={job.label}
                  labels={labels}
                />
              </div>
            )
            : <div className={css.popHint}>{t('jobNoOutput')}</div>}
        </>
      )}
    </FloatingWindow>
  )
}
