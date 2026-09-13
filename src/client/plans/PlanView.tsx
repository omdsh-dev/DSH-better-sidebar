/**
 * The Plan page: the plan revisions presented in this session, one document
 * at a time. The page holds no plan text and folds nothing — the route ships
 * the revisions the host derived from the session log, and every poll simply
 * replaces the list. Re-rendering an unchanged list is cheap because the
 * markdown work below is keyed on the body string, so an idle tick costs a
 * shallow compare and no DOM churn.
 *
 * One rule the poller must keep, because this list is the only copy the page
 * has: an answer that carries no revisions NEVER clears what is shown — a
 * host restart or a transient failure must not wipe the history.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { PLAN_CHANGED_EVENT, type PlanEntry, type PlanStatus } from '../../plan-events.ts'
import { api } from '../api.ts'
import { analyzeMarkdownHtml } from '../markdown-html.ts'
import { MarkdownDocument, type MarkdownHtmlMedia } from '../MarkdownHtml.tsx'
import { relativeTime, t } from '../locales.ts'
import type { TabComponentProps } from '../service.ts'
import { usePolling } from '../use-polling.ts'
import css from './plan.module.css'

/** The visible tick. Slower than the changes lens: a plan changes on
 *  submission and on review, and both are user-paced moments. */
const PLAN_POLL_MS = 5_000

/** How long the "copied" feedback stays on the button. */
const COPIED_FEEDBACK_MS = 1_500

/** One status's label key and ink class, looked up instead of branched twice. */
const STATUS_META: Record<PlanStatus, { key: 'planStatusApproved' | 'planStatusUnadopted' | 'planStatusPending'; cls: string }> = {
  approved: { key: 'planStatusApproved', cls: css.statusApproved ?? '' },
  unadopted: { key: 'planStatusUnadopted', cls: css.statusUnadopted ?? '' },
  pending: { key: 'planStatusPending', cls: css.statusPending ?? '' },
}

export function PlanView({ scope, visible }: TabComponentProps) {
  const [plans, setPlans] = useState<readonly PlanEntry[]>([])
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  // The revision the user picked by hand. Cleared whenever a NEW revision
  // arrives, so a submission always lands on the page (see `pull`).
  const [pinned, setPinned] = useState<string | undefined>(undefined)
  const latestRef = useRef<string | undefined>(undefined)
  const pollGen = useRef(0)

  const pull = useCallback(async (): Promise<void> => {
    const generation = pollGen.current
    try {
      const entries = await api.plansEvents(scope)
      if (generation !== pollGen.current) return
      // An empty answer is "unknown", not "no plans": the session's log can be
      // unreadable for a moment (a host restart, a rehydrating store), and
      // blanking a list the reader is looking at is worse than a stale one.
      // Nothing on screen yet means the empty state speaks for itself.
      //
      // It still CLEARS the failure flag: "no plans" is a successful answer,
      // and leaving the flag set would keep the error on screen after a
      // recovered host — for every session that has no plans, which is most.
      // Behind the generation guard, so a stale answer cannot clear the
      // current session's flag.
      if (entries.length === 0) {
        setFailed(false)
        return
      }
      // A revision arriving is an explicit "review me": drop a manual pick so
      // the page shows what was just presented.
      const latest = entries.at(-1)?.callId
      if (latest !== latestRef.current) {
        latestRef.current = latest
        setPinned(undefined)
      }
      setPlans(entries)
      setFailed(false)
    } catch {
      // Offline / route unavailable: keep the last list and only say so while
      // nothing has ever loaded.
      if (generation === pollGen.current) setFailed(true)
    }
    // Granular scope fields: the scope object's identity churns, only its
    // sessionId / cwd gate the poll target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.sessionId, scope.cwd])

  // A new session starts from its own log — never from the previous one's.
  useEffect(() => {
    pollGen.current += 1
    latestRef.current = undefined
    setPlans([])
    setPinned(undefined)
    setFailed(false)
  }, [scope.sessionId])

  usePolling(visible, pull, { intervalMs: PLAN_POLL_MS, mode: 'self-scheduling', immediate: true })
  // The push feed lives in the core bundle while this page is a lazy chunk, so
  // a submission is relayed across that boundary through the window (the file
  // tree's refresh relay uses the same channel). Hidden pages skip it — the
  // visibility flip re-pulls anyway.
  useEffect(() => {
    const onChange = (): void => { if (visible) void pull() }
    window.addEventListener(PLAN_CHANGED_EVENT, onChange)
    return () => { window.removeEventListener(PLAN_CHANGED_EVENT, onChange) }
  }, [pull, visible])

  const entry = pinned === undefined
    ? plans.at(-1)
    : plans.find(plan => plan.callId === pinned) ?? plans.at(-1)

  // Keyed on the body string: a fresh PlanEntry object per poll must not
  // re-run the markdown analysis (or the sanitizer behind it).
  const body = entry?.body
  const info = useMemo(() => (body === undefined ? null : analyzeMarkdownHtml(body)), [body])
  // Memoized on primitives — MarkdownDocument sanitizes per `media` identity,
  // so a fresh object per render would re-sanitize every plan on every tick.
  // The path is a synthetic file in the session's workspace: a plan has no
  // file of its own, and the media rewriter resolves relative images against
  // the path's DIRECTORY, so the workspace root is the only sensible base.
  const media = useMemo<MarkdownHtmlMedia>(
    () => ({ scope, path: scope.cwd === undefined ? '' : `${scope.cwd}/plan.md`, origin: window.location.origin }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope.sessionId, scope.cwd],
  )
  // Labels are read per render so a locale switch follows.
  const codeLabels = { copyLabel: t('copy'), copiedLabel: t('copied') }

  /** Copy the plan's raw text (never the rendered HTML) and flash the label. */
  const copy = async (): Promise<void> => {
    if (entry === undefined) return
    const written = await writeClipboard(entry.body)
    if (!written) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
  }

  if (entry === undefined) {
    return (
      <div className={css.root}>
        <div className={css.empty}>
          <div>{failed ? t('planLoadError') : t('planEmpty')}</div>
          {!failed && <div className={css.emptyHint}>{t('planEmptyDesc')}</div>}
        </div>
      </div>
    )
  }

  return (
    <div className={css.root}>
      <div className={css.toolbar}>
        <select
          className={css.select}
          value={entry.callId}
          aria-label={t('plan')}
          onChange={(event) => { setPinned(event.target.value) }}
        >
          {plans.map((plan, index) => (
            <option key={plan.callId} value={plan.callId}>{`v${index + 1} · ${plan.title ?? t('plan')}`}</option>
          ))}
        </select>
        <span className={`${css.status ?? ''} ${STATUS_META[entry.status].cls}`}>{t(STATUS_META[entry.status].key)}</span>
        <span className={css.time}>{relativeTime(new Date(entry.time).toISOString())}</span>
        <button type="button" className={css.copy} onClick={() => { void copy() }}>
          {copied ? t('copied') : t('planCopy')}
        </button>
      </div>
      <div className={css.body}>
        {info !== null && (
          <MarkdownDocument key={entry.callId} info={info} media={media} codeLabels={codeLabels} />
        )}
      </div>
    </div>
  )
}
