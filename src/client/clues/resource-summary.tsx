/**
 * Shared display metadata of one clue resource (S9).
 *
 * The header follows the host's own detail surfaces (the file preview's single
 * quiet row), not a badge-heavy card:
 *
 *   line 1  number · author · change counts     (due/path/size for other sources)
 *   line 2  CI verdict · review · mergeability · branches
 *   line 3  a collapsed check disclosure        (only when a detail read asks)
 *
 * Colour budget: ink carries the text, and a semantic colour appears only on a
 * 12px verdict glyph. Nothing is filled, so a header never becomes a stack of
 * capsules and the identity line stays the loudest thing on screen. The one
 * exception is a destructive fact (CI failing, changes requested, conflicts):
 * its word turns the error ink, because that is the fact a reader must not
 * miss. A healthy request stays monochrome — "everything is fine" does not
 * deserve colour.
 *
 * Animation budget: only a CI rollup that is genuinely still running spins.
 * A statically open pull request or an active task is NOT in flight, so it gets
 * a still dot instead of the host's spinner (which would otherwise animate in
 * every row of a list).
 *
 * `ResourceSummary` is the detail header (full snapshot plus an action seat);
 * `ResourceInlineMeta` is the one-line list variant. Both read the SAME
 * projections and the SAME `ChecksVerdict`, so a row and the header it opens
 * cannot disagree.
 *
 * The vocabulary comes from the public clue contract (the host half and the
 * browser bundle share it); this module only renders it.
 */
import { useId, useState, type ReactNode } from 'react'
import type {
  ClueCheckState,
  CluePerson,
  ClueResourceBranches,
  ClueResourceCheck,
  ClueResourceCounts,
  ClueResourceInfo,
  ClueResourceState,
  ClueResourceTime,
} from '../../clues/types.ts'
import { IconCheckOutlineRegular, IconChevronRightOutlineRegular, IconClockOutlineRegular, IconCloseOutlineRegular, IconRightUpOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives/client'
import { t } from '../locales.ts'
import css from './resource-summary.module.css'

export type {
  ClueCheckState,
  CluePerson,
  ClueResourceBranches,
  ClueResourceCheck,
  ClueResourceCounts,
  ClueResourceInfo,
  ClueResourceState,
  ClueResourceTime,
}

// ── Value projections ──────────────────────────────────────────────────────

/** The visible label of one person; id/handle fallback keeps a sparse snapshot useful. */
export function personLabel(person: CluePerson | undefined): string | undefined {
  if (person === undefined) return undefined
  const name = typeof person.name === 'string' && person.name.trim() !== '' ? person.name : undefined
  if (name !== undefined) return name
  const handle = typeof person.handle === 'string' && person.handle.trim() !== '' ? person.handle : undefined
  if (handle !== undefined) return handle.startsWith('@') ? handle : `@${handle}`
  const id = typeof person.id === 'string' && person.id.trim() !== '' ? person.id : undefined
  return id
}

/** Provider identity with a visible initial even when the avatar cannot load. */
export function ResourcePerson({ person, linked = false }: { person: CluePerson; linked?: boolean }): ReactNode {
  const [failedSrc, setFailedSrc] = useState<string>()
  const label = personLabel(person) ?? t('clueResourceUnknownPerson')
  const avatar = person.avatarUrl?.startsWith('https://') === true ? person.avatarUrl : undefined
  const content = <>
    <span className={css.avatar} aria-hidden="true">
      {avatar !== undefined && failedSrc !== avatar
        ? <img src={avatar} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => { setFailedSrc(avatar) }} />
        : Array.from(label.replace(/^@/, ''))[0]?.toLocaleUpperCase()}
    </span>
    <span className={css.personName}>{label}</span>
  </>
  return linked && person.url !== undefined && person.url.startsWith('https://')
    ? <a className={css.person} href={person.url} target="_blank" rel="noreferrer" title={label}>{content}</a>
    : <span className={css.person} title={label}>{content}</span>
}

/** Localized lifecycle label of one normalized state. */
export function stateLabel(state: ClueResourceState): string {
  switch (state) {
    case 'open': return t('clueResourceStateOpen')
    case 'closed': return t('clueResourceStateClosed')
    case 'merged': return t('clueResourceStateMerged')
    case 'draft': return t('clueResourceStateDraft')
    case 'active': return t('clueResourceStateActive')
    case 'completed': return t('clueResourceStateCompleted')
  }
}

/** One localized instant; all-day values keep the provider's date-only meaning. */
export function formatResourceTime(value: string, allDay?: boolean): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  try {
    return new Intl.DateTimeFormat(undefined, allDay === true
      ? { year: 'numeric', month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
  } catch {
    return value
  }
}

/** Bytes as a short human-readable value (never a fake precision). */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The one identity of a resource: `#42`, or the repository alone when the
 * provider exposed no number.
 *
 * The owner/repository prefix is deliberately absent. The source scope bar
 * above the list already names the repository, and repeating it spent the
 * widest part of every row on the same words.
 */
export function numberLabel(info: ClueResourceInfo): string | undefined {
  if (info.number !== undefined) return `#${info.number}`
  const repository = info.repository
  return repository === undefined || repository === '' ? undefined : repository
}

/**
 * `head → base` only when the provider exposed a head branch.
 *
 * Repository qualifiers are dropped: a fork's owner is noise in a one-line
 * header, and the base repository is the one the scope bar already shows.
 */
export function branchesLabel(branches: ClueResourceBranches | undefined): string | undefined {
  const head = branches?.head === undefined || branches.head === '' ? undefined : branches.head
  if (head === undefined) return undefined
  const base = branches?.base === undefined || branches.base === '' ? undefined : branches.base
  return base === undefined ? head : `${head} → ${base}`
}

/** Merge metadata snapshots; later sources win field-by-field (nested counts/branches merge). */
export function mergeResourceInfo(...sources: ReadonlyArray<ClueResourceInfo | undefined>): ClueResourceInfo | undefined {
  let merged: ClueResourceInfo | undefined
  for (const source of sources) {
    if (source === undefined) continue
    merged = {
      ...(merged ?? {}),
      ...source,
      ...(source.counts === undefined ? {} : { counts: { ...(merged?.counts ?? {}), ...source.counts } }),
      ...(source.branches === undefined ? {} : { branches: { ...(merged?.branches ?? {}), ...source.branches } }),
    }
  }
  return merged
}

// ── Presentational vocabulary ──────────────────────────────────────────────

/**
 * Whether a state is worth a dot and a word.
 *
 * `open`/`active` is the resting state of every forge resource and of every
 * unfinished task: it is what the row's own list is already full of, and the
 * scope bar's filter says so. Printing it on every row spent the widest part of
 * the line on the same word. `merged`, `closed`, `draft` and `completed` are
 * the states that actually change what a reader will find inside.
 */
function stateIsInformative(state: ClueResourceState): boolean {
  return state !== 'open' && state !== 'active'
}

/** The host `StateDot` semantic of one state; never `ongoing` (see module note). */
function stateDot(state: ClueResourceState): 'done' | 'warning' | 'error' | 'idle' {
  switch (state) {
    case 'open':
    case 'merged':
    case 'completed':
      return 'done'
    case 'draft':
      return 'warning'
    default:
      return 'idle'
  }
}

/** Localized CI value; the one mapping shared by the verdict and the list row. */
function checksValueOf(checks: ClueResourceCheck['state']): string {
  switch (checks) {
    case 'success': return t('cluePrChecksSuccess')
    case 'failure': return t('cluePrChecksFailure')
    case 'pending': return t('cluePrChecksPending')
    case 'expected': return t('cluePrChecksExpected')
    case 'error': return t('cluePrChecksError')
    case 'skipped': return t('cluePrChecksSkipped')
    case 'neutral': return t('cluePrChecksNeutral')
    case 'cancelled': return t('cluePrChecksCancelled')
    case 'unknown': return t('cluePrMergeUnknown')
  }
}

/** The ink of one CI word: destructive verdicts earn colour, the rest stay quiet. */
function checksInk(checks: NonNullable<ClueResourceInfo['checks']>): 'error' | undefined {
  return checks === 'failure' || checks === 'error' ? 'error' : undefined
}

/**
 * The one CI glyph, in the host's own state vocabulary.
 *
 * A dot — not a filled 12px badge — because that is the only shape DSH uses to
 * say "this state is fine": `done` for a settled pass, `error` for a failure,
 * `idle` for a queued rollup. Only a rollup that is genuinely running spins;
 * it is the one fact here that is in flight.
 */
function checksGlyph(checks: ClueResourceCheck['state']): ReactNode {
  switch (checks) {
    case 'success': return <IconCheckOutlineRegular size={12} />
    case 'failure':
    case 'error': return <IconCloseOutlineRegular size={12} />
    case 'pending': return <StateDot state="ongoing" size={10} />
    case 'expected': return <IconClockOutlineRegular size={12} />
    default: return <span className={css.quietMark}>−</span>
  }
}

/**
 * CI rollup: a coloured glyph plus its word, never a capsule.
 *
 * `word=false` keeps the glyph only. A row list uses that for a passing
 * rollup: the dot still separates "passing" from "no CI reported" (a real
 * distinction — most rows in a live repository have no checks at all) while the
 * word, repeated on every healthy row, would drown the one row that failed.
 */
function ChecksVerdict(props: {
  readonly checks: NonNullable<ClueResourceInfo['checks']>
  readonly word?: boolean
}): ReactNode {
  const value = checksValueOf(props.checks)
  const name = `${t('cluePrChecks')}: ${value}`
  const ink = checksInk(props.checks)
  return (
    <span
      className={css.checks}
      role="img"
      aria-label={name}
      title={name}
      {...(ink === undefined ? {} : { 'data-ink': ink })}
      data-checks={props.checks}
    >
      <span className={css.checksGlyph} data-check-tone={checkTone(props.checks)}>{checksGlyph(props.checks)}</span>
      {props.word === false ? null : <span>{value}</span>}
    </span>
  )
}

/**
 * Display rank of one check. A detail header answers "is anything broken?"
 * before "what ran?", so failures and errors come first and a green wall never
 * buries the one red job.
 */
const CHECK_RANK: Readonly<Record<ClueResourceCheck['state'], number>> = {
  failure: 0, error: 1, cancelled: 2, pending: 3, expected: 4, unknown: 5, success: 6, skipped: 7, neutral: 8,
}

/** The ranked copy of one check list (stable: equal ranks keep provider order). */
function rankedChecks(checks: readonly ClueResourceCheck[]): readonly ClueResourceCheck[] {
  return [...checks].sort((left, right) => CHECK_RANK[left.state] - CHECK_RANK[right.state])
}

/** Whether one check is a verdict a reader must not miss. */
function checkFailed(state: ClueResourceCheck['state']): boolean {
  return state === 'failure' || state === 'error'
}

/**
 * The individual checks of a detail read, collapsed behind one quiet line.
 *
 * The header states the rollup; the individual jobs are detail, so they live in
 * a disclosure instead of growing the header by up to 20 rows. Each row is a
 * glyph plus the provider's own name, and a check with a provider link opens it
 * in a new tab — the same affordance the original-source link has.
 */
function CheckList(props: { readonly checks: readonly ClueResourceCheck[] }): ReactNode {
  const ranked = rankedChecks(props.checks)
  const failing = ranked.filter(check => checkFailed(check.state)).length
  return (
    <details className={css.checksDisclosure} data-clue-check-list={String(ranked.length)}>
      <summary className={css.checksSummary}>
        <span className={css.checksChevron} aria-hidden="true">
          <IconChevronRightOutlineRegular size={12} />
        </span>
        {failing > 0 && (
          <span className={css.checksFailing} data-ink="error">
            {t('cluePrChecksFailure')} {failing}
          </span>
        )}
        {failing > 0 ? ' · ' : null}
        <span>{t('cluePrChecksCount', { count: ranked.length })}</span>
      </summary>
      <CheckRows checks={ranked} />
    </details>
  )
}

function checkTone(state: ClueResourceCheck['state']): 'pass' | 'fail' | 'wait' | 'other' {
  if (state === 'success') return 'pass'
  if (checkFailed(state)) return 'fail'
  if (state === 'pending' || state === 'expected') return 'wait'
  return 'other'
}

function CheckRows({ checks, detailed = false }: { checks: readonly ClueResourceCheck[]; detailed?: boolean }): ReactNode {
  return <ul className={detailed ? css.checkRows : css.checksList}>
        {checks.map((check, index) => {
          const state = checksValueOf(check.state)
          const label = `${check.name} · ${state}`
          return (
            <li className={css.checkRow} data-clue-check={check.state} key={`${index}:${check.name}`}>
              <span className={css.checkGlyph} data-check-tone={checkTone(check.state)}
                 role={detailed ? undefined : 'img'} aria-hidden={detailed ? true : undefined} aria-label={detailed ? undefined : state} title={state}>
                {checksGlyph(check.state)}
              </span>
              {check.url === undefined ? (
                <span className={css.checkName} title={check.name}>{check.name}</span>
              ) : (
                <a
                  className={css.checkName}
                  href={check.url}
                  target="_blank"
                  rel="noreferrer"
                  title={label}
                >
                  {check.name}
                </a>
              )}
              {detailed && <span className={css.checkRowState} data-check-tone={checkTone(check.state)}>{state}</span>}
            </li>
          )
        })}
      </ul>
}

/** One plain fact of the second line (review / mergeability). */
interface InkFact {
  readonly key: 'review' | 'merge'
  readonly text: string
  readonly ink: 'error' | undefined
}

/**
 * The facts that are worth a word — the ones that change what happens next.
 *
 * A default is not news, so the two "nothing has gone wrong yet" values stay
 * silent: `review-required` means no one has reviewed, and `mergeable` /
 * `unknown` mean GitHub has nothing to block on (it reports `UNKNOWN` while it
 * is still computing, which is a transient, not a fact). What remains is the
 * blocking signal (`changes-requested`), the positive gate (`approved`), and a
 * conflict. A header for a healthy request therefore reads as one short line
 * instead of a row of "fine, fine, fine".
 */
function inkFacts(info: ClueResourceInfo): InkFact[] {
  const facts: InkFact[] = []
  if (info.review === 'approved') {
    facts.push({ key: 'review', text: t('cluePrReviewApproved'), ink: undefined })
  } else if (info.review === 'changes-requested') {
    facts.push({ key: 'review', text: t('cluePrReviewChanges'), ink: 'error' })
  }
  if (info.mergeable === 'conflicting') {
    facts.push({ key: 'merge', text: t('cluePrConflict'), ink: 'error' })
  }
  return facts
}

/** Additions/deletions only; the other counts are list-row detail. */
function ChangeCounts({ counts }: { counts: ClueResourceCounts }): ReactNode {
  if (counts.additions === undefined && counts.deletions === undefined) return null
  return <span className={css.changes} data-clue-resource-item="changes">
    {counts.additions !== undefined && <span data-check-tone="pass">+{counts.additions.toLocaleString()}</span>}
    {counts.deletions !== undefined && <span data-check-tone="fail">−{counts.deletions.toLocaleString()}</span>}
  </span>
}

/** One dot plus its word, shared by the header and the list row. */
function StateChip(props: { readonly state: ClueResourceState; readonly dot: number; readonly attribute: string }): ReactNode {
  const label = stateLabel(props.state)
  return (
    <span
      className={css.state}
      {...{ [props.attribute]: props.state }}
      role="img"
      aria-label={label}
      title={label}
    >
      <StateDot state={stateDot(props.state)} size={props.dot} />
      <span>{label}</span>
    </span>
  )
}

// ── Components ─────────────────────────────────────────────────────────────

/** Props of {@link ResourceSummary}. */
interface ResourceSummaryProps {
  /** The source-owned snapshot; absent/empty renders nothing but the action seat. */
  readonly info?: ClueResourceInfo
  /**
   * The one action seat of the header, rendered inline at the end of the
   * metadata block. A detail window puts Refresh and the original-source link
   * here instead of opening a toolbar band of its own.
   */
  readonly actions?: ReactNode
  readonly className?: string
  readonly github?: boolean
  readonly title?: string
  readonly separateChecks?: boolean
}

/**
 * The detail header: at most two quiet lines plus the action seat.
 *
 * Line one carries identity (state when it is informative, number, author,
 * change counts, and for non-forge sources the due date, path or size); line
 * two carries the facts a reader acts on. A window title or a body heading
 * already states the subject, so neither line repeats it.
 */
export function ResourceSummary({ info, actions, className, github, title, separateChecks }: ResourceSummaryProps): ReactNode {
  const number = info === undefined ? undefined : numberLabel(info)
  const author = personLabel(info?.author)
  const branches = branchesLabel(info?.branches)
  const counts = info?.counts
  const due = info?.due === undefined ? undefined : formatResourceTime(info.due.at, info.due.allDay)
  const facts = info === undefined || separateChecks === true ? [] : inkFacts(info)
  const state = info?.state !== undefined && (github === true || stateIsInformative(info.state)) ? info.state : undefined
  const hasIdentity = info !== undefined && (state !== undefined || number !== undefined
    || author !== undefined || counts?.additions !== undefined || counts?.deletions !== undefined || due !== undefined
    || info.path !== undefined || info.sizeBytes !== undefined)
  const hasFacts = info !== undefined
    && ((separateChecks !== true && info.checks !== undefined) || facts.length > 0 || branches !== undefined)
  const checkRuns = separateChecks !== true && info?.checkRuns !== undefined && info.checkRuns.length > 0 ? info.checkRuns : undefined
  // The action seat is itself something to show: a window whose source reports
  // no metadata still keeps Refresh and the original-source link here.
  if (!hasIdentity && !hasFacts && checkRuns === undefined && actions === undefined && title === undefined) return null
  return (
    <section
      className={className === undefined ? css.summary : css.summary + ' ' + className}
      data-clue-resource-summary
      data-clue-resource-github={github === true ? '' : undefined}
      {...(info?.state === undefined ? {} : { 'data-clue-resource-state': info.state })}
      {...(info?.number === undefined ? {} : { 'data-clue-resource-number': String(info.number) })}
      {...(info?.repository === undefined ? {} : { 'data-clue-resource-repository': info.repository })}
    >
      <div className={css.body}>
        {title !== undefined && <h2 className={css.resourceTitle}>{title}</h2>}
        {hasIdentity && info !== undefined && (
          <div className={css.identity}>
            {state !== undefined && (
              <span className={github === true ? css.githubState : undefined} data-clue-resource-state-chip={state} data-clue-resource-item="state">
                <StateChip state={state} dot={8} attribute="data-clue-resource-state-mark" />
              </span>
            )}
            {number !== undefined && <span className={css.number} data-clue-resource-item="number">{number}</span>}
            {author !== undefined && <span className={css.author} data-clue-resource-item="author">
              {github === true && info.author !== undefined ? <ResourcePerson person={info.author} linked /> : author}
            </span>}
            {github === true && info.createdAt !== undefined && <time className={css.meta} dateTime={info.createdAt}>{formatResourceTime(info.createdAt, true)}</time>}
            {counts !== undefined && <ChangeCounts counts={counts} />}
            {due !== undefined && <span className={css.meta} data-clue-resource-item="due">{t('clueResourceDue')} {due}</span>}
            {info.path !== undefined && (
              <span className={css.path} data-clue-resource-item="path" title={info.path}>{info.path}</span>
            )}
            {info.sizeBytes !== undefined && (
              <span className={css.meta} data-clue-resource-item="size">{formatSize(info.sizeBytes)}</span>
            )}
          </div>
        )}
        {hasFacts && info !== undefined && (
          <div className={css.facts} data-clue-change-request>
            {separateChecks !== true && info.checks !== undefined && (
              <span data-clue-change-request-fact="checks">
                <ChecksVerdict checks={info.checks} />
              </span>
            )}
            {facts.map(fact => (
              <span
                className={css.fact}
                data-clue-change-request-fact={fact.key}
                {...(fact.ink === undefined ? {} : { 'data-ink': fact.ink })}
                key={fact.key}
              >
                {fact.text}
              </span>
            ))}
            {branches !== undefined && (
              <span className={css.branch} data-clue-resource-item="branches" title={branches}>
                {github === true ? <><code>{info.branches?.head}</code>{info.branches?.base !== undefined && <> → <code>{info.branches.base}</code></>}</> : branches}
              </span>
            )}
          </div>
        )}
        {checkRuns !== undefined && <CheckList checks={checkRuns} />}
      </div>
      {actions !== undefined && <div className={css.actions}>{actions}</div>}
    </section>
  )
}

function mergeGate(info: ClueResourceInfo) {
  if (info.state === 'merged' || info.state === 'closed') return { key: info.state, label: stateLabel(info.state) } as const
  if (info.state === 'draft') return { key: 'wait', label: stateLabel('draft') } as const
  if (info.mergeable === 'conflicting') return { key: 'fail', label: t('cluePrConflict') } as const
  if (info.mergeStatus === 'behind') return { key: 'wait', label: t('cluePrMergeBehind') } as const
  if (info.review === 'changes-requested' || info.mergeStatus === 'blocked' || (info.checks !== undefined && checksInk(info.checks) === 'error')) {
    return { key: 'fail', label: t('cluePrMergeBlocked') } as const
  }
  if (info.review === 'review-required' || info.checks === 'pending' || info.checks === 'expected') return { key: 'wait', label: t('cluePrMergeWaiting') } as const
  if (info.state === 'open' && info.mergeStatus === 'ready' && info.mergeable === 'mergeable') return { key: 'pass', label: t('cluePrMergeReady') } as const
  return { key: 'other', label: t('cluePrMergeUnknown') } as const
}

/** One read-only PR overview. The rollup always outranks a bounded sample of runs. */
export function PullRequestStatus({ info, sourceUrl, onDiscussion }: {
  info: ClueResourceInfo
  sourceUrl?: string
  onDiscussion?: () => void
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const runs = info.checkRuns ?? []
  const sample = info.checkCount !== undefined && info.checkCount > runs.length
  const tones = { fail: 0, wait: 0, pass: 0, other: 0 }
  for (const check of runs) tones[checkTone(check.state)]++
  const checkLink = sourceUrl === undefined ? undefined : sourceUrl.replace(/\/$/, '') + '/checks'
  const checkToggle = runs.length > 0
  const gate = mergeGate(info)
  const review = info.review === 'approved' ? t('cluePrReviewApproved')
    : info.review === 'changes-requested' ? t('cluePrReviewChanges')
      : info.review === 'review-required' ? t('cluePrReviewRequired') : '—'
  const checksContent = <>
    <span className={css.gateLabel}>{t('cluePrChecks')}{checkToggle && <IconChevronRightOutlineRegular size={12} />}</span>
    {info.checks !== undefined ? <ChecksVerdict checks={info.checks} />
      : <span className={css.gateValue}>{info.checkCount === 0 ? t('cluePrChecksNone') : t('cluePrMergeUnknown')}</span>}
    <span className={css.checkMeter} aria-hidden="true">
      {runs.length > 0 && !sample
        ? (Object.entries(tones) as [keyof typeof tones, number][]).map(([tone, count]) => count > 0
          && <span key={tone} data-check-tone={tone} style={{ flexGrow: count }} />)
        : <span data-check-tone={info.checks === undefined ? 'other' : checkTone(info.checks)} />}
    </span>
  </>
  return <section className={css.gate} data-clue-pr-status data-md-toc-exclude aria-label={t('cluePrMerge')}>
    <div className={css.gateHeadline} data-clue-pr-merge={gate.key}>
      <span className={css.gateIcon} aria-hidden="true" data-check-tone={gate.key}>
        {gate.key === 'pass' || gate.key === 'merged' ? <IconCheckOutlineRegular size={16} />
          : gate.key === 'fail' || gate.key === 'closed' ? <IconCloseOutlineRegular size={16} /> : <IconClockOutlineRegular size={16} />}
      </span>
      <div><span className={css.gateCaption}>{t('cluePrMerge')}</span><strong>{gate.label}</strong></div>
    </div>
    <div className={css.gateFacts} data-clue-change-request>
      {checkToggle ? <button type="button" className={css.gateCell} aria-expanded={expanded}
        aria-controls={listId} data-clue-change-request-fact="checks" onClick={() => { setExpanded(!expanded) }}>
        {checksContent}
      </button> : <div className={css.gateCell} data-clue-change-request-fact="checks">{checksContent}</div>}
      {onDiscussion === undefined ? <div className={css.gateCell}>
        <span className={css.gateLabel}>{t('clueResourceComments')}</span>
        <span className={css.gateValue}>{info.counts?.comments?.toLocaleString() ?? '—'}</span>
      </div> : <button type="button" className={css.gateCell} onClick={onDiscussion}>
        <span className={css.gateLabel}>{t('clueResourceComments')}<IconRightUpOutlineRegular size={12} /></span>
        <span className={css.gateValue}>{info.counts?.comments?.toLocaleString() ?? '—'}</span>
      </button>}
      <div className={css.gateCell} data-clue-change-request-fact="review">
        <span className={css.gateLabel}>{t('cluePrReview')}</span>
        <span className={css.gateValue} data-check-tone={info.review === 'approved' ? 'pass' : info.review === 'changes-requested' ? 'fail' : undefined}>{review}</span>
      </div>
    </div>
    {checkToggle && <div id={listId} className={css.gateChecks} hidden={!expanded} data-clue-check-list={runs.length}>
      <div className={css.checkListHead}>
        <span>{sample ? t('cluePrChecksPartial', { shown: runs.length.toLocaleString(), total: info.checkCount!.toLocaleString() })
          : t('cluePrChecksCount', { count: runs.length })}</span>
        {sample && checkLink !== undefined && <a href={checkLink} target="_blank" rel="noreferrer">GitHub <IconRightUpOutlineRegular size={12} /></a>}
      </div>
      {expanded && <CheckRows checks={rankedChecks(runs)} detailed />}
    </div>}
    {sample && !checkToggle && <div className={css.checkListHead}>
      <span>{t('cluePrChecksPartial', { shown: '0', total: info.checkCount!.toLocaleString() })}</span>
      {checkLink !== undefined && <a href={checkLink} target="_blank" rel="noreferrer">GitHub <IconRightUpOutlineRegular size={12} /></a>}
    </div>}
  </section>
}

/** Props of {@link ResourceInlineMeta}. */
interface ResourceInlineMetaProps {
  readonly info?: ClueResourceInfo
  readonly className?: string
}

/**
 * The compact row-list variant: state (when informative) / number / author / due / CI.
 *
 * The parent supplies the search-hit copy around it; this row never grows a
 * second line and never repeats the repository the scope bar already names.
 * Branches stay out: they are the widest field and the header shows them.
 */
export function ResourceInlineMeta({ info, className }: ResourceInlineMetaProps): ReactNode {
  if (info === undefined) return null
  const author = personLabel(info.author)
  const identity = numberLabel(info)
  const due = info.due === undefined ? undefined : formatResourceTime(info.due.at, info.due.allDay)
  const state = info.state !== undefined && stateIsInformative(info.state) ? info.state : undefined
  const hasAny = identity !== undefined || state !== undefined || info.checks !== undefined
    || author !== undefined || due !== undefined
  if (!hasAny) return null
  return (
    <span
      className={className === undefined ? css.inline : css.inline + ' ' + className}
      data-clue-resource-inline
      {...(info.state === undefined ? {} : { 'data-clue-resource-state': info.state })}
    >
      {state !== undefined && <StateChip state={state} dot={6} attribute="data-clue-resource-inline-state" />}
      {identity !== undefined && <span data-clue-resource-inline-identity>{identity}</span>}
      {author !== undefined && (
        <span data-clue-resource-inline-author title={t('clueResourceAuthor')}>{info.author?.avatarUrl === undefined
          ? author : <ResourcePerson person={info.author} />}</span>
      )}
      {due !== undefined && (
        <span data-clue-resource-inline-due title={t('clueResourceDue')}>{due}</span>
      )}
      {info.checks !== undefined && (
        <span data-clue-resource-inline-checks={info.checks}>
          {/* A passing rollup is the line's background, not its headline: dot
              only, so the word never repeats down the whole list. */}
          <ChecksVerdict checks={info.checks} word={info.checks !== 'success'} />
        </span>
      )}
    </span>
  )
}
