/**
 * The two-segment node card of the Tasks graph: a TOP segment that says WHAT
 * the node is (kind badge, name, mono meta, optional task line) and a BOTTOM
 * bar that says WHAT IT IS DOING (state dot + the merged process activity —
 * or, when there is no activity to show, the state word — plus the fold
 * chevron once the node has settled).
 *
 * The state word YIELDS to the activity line: "运行中 · 正在读取文件" and
 * "已完成 · 已读取文件" both printed the state twice inside one 22px strip,
 * and the dot beside them already carries it. `idle` and `error` keep their
 * word — neither "waiting for a turn" nor "failed" is implied by any activity
 * wording, so dropping them would hide the one thing that bar has to say.
 *
 * Both modes share the model but NOT the card: the TREE keeps its compact
 * indent row (its own disclosure, its own keyboard recipe), so this module is
 * graph-only. Its two pieces are separate components because every node kind
 * (agent / workflow run / fold aggregate) composes them differently while the
 * geometry stays identical — the layout reserves the height of exactly these
 * rows (`tasks-graph-layout.ts`).
 *
 * Colour: the group colour of a node is its tree DEPTH, from the plugin's own
 * token-only ramp (`.depth0…3` in tasks-graph.module.css). The host ships no
 * chart palette and the skin contract forbids literal colours, so the ramp is
 * mixed from `--dsw-alias-state-business-primary`; a workflow member's PHASE
 * badge uses the ink family instead, so the two groupings never share a hue.
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronUpOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TasksNodeState } from './tasks-model.ts'
import { nodeDotState, stateLabel } from './tasks-shared.tsx'
import { t } from './locales.ts'
import css from './tasks-graph.module.css'

/** The five kinds of card the graph draws. */
export type CardKind = 'main' | 'subagent' | 'teammate' | 'workflow' | 'fold'
/** Which aggregate a fold card is (`done` = finished/failed, `idle` = waiting). */
export type CardFoldKind = 'done' | 'idle'

/**
 * The kind badge's word: the SAME vocabulary the rest of the page uses (the
 * header already calls the root "主代理"), so no sixth word is invented for it.
 *
 * The two aggregates say different things, because they hold different work:
 * `done` keeps "✓ N 已完成" (finished and failed rows alike) while `idle`
 * counts its waiting members. One mixed row could only have hedged
 * ("✓ 2 已完成 · 3 待命"), which is exactly what splitting them removed.
 *
 * The badge is where an aggregate's COUNT lives, so it interpolates the real
 * number: the idle branch used to print the literal copy 'N 个待命', which
 * read as an unfilled placeholder on every idle aggregate.
 * @param kind - card kind.
 * @param count - folded member count (the fold aggregate's badge only).
 * @param foldKind - which aggregate (`done` unless stated).
 */
export function cardKindLabel(kind: CardKind, count = 0, foldKind: CardFoldKind = 'done'): string {
  switch (kind) {
    case 'main': return t('subagentMainAgent')
    case 'subagent': return t('tasksKindSubagent')
    case 'teammate': return t('tasksKindTeammate')
    case 'workflow': return t('tasksKindWorkflow')
    case 'fold': return foldKind === 'idle'
      ? t('tasksFoldIdleGroup', { count })
      : t('tasksFoldCompleted', { count })
  }
}

/**
 * The depth class of a node's group colour (levels past 3 share the last one).
 * Typed `string | undefined` because the CSS-module map is an open record: a
 * typo'd class name would otherwise pass `tsc` as a `string`.
 */
export function depthClass(depth: number): string | undefined {
  if (depth <= 0) return css.depth0
  if (depth === 1) return css.depth1
  if (depth === 2) return css.depth2
  return css.depth3
}

/** The phase class of a workflow member's badge (phases past 3 share the last one). */
export function phaseClass(index: number): string | undefined {
  if (index <= 0) return css.phase0
  if (index === 1) return css.phase1
  if (index === 2) return css.phase2
  return css.phase3
}

/** The top segment: the node's identity. */
export function CardTop(props: {
  kind: CardKind
  /** Folded member count, for the aggregate's badge. */
  count?: number
  /** Which aggregate this card is, when `kind` is `fold`. */
  foldKind?: CardFoldKind
  /** Tree depth → the group colour of the badge and the card's left edge. */
  depth: number
  /** Workflow phase (a member's badge). */
  phase?: { index: number; title?: string }
  /**
   * The identity CHIP beside the kind badge — the node's own mode word
   * (一次性 / 可持续) or the one team state the badge cannot express. It shares
   * the badge row on purpose: as a mono line of its own it repeated the same
   * word on every card and spent a 16px row saying it.
   */
  chip?: string
  /** The node's name (already resolved by the model). */
  name: string
  /** The mono meta line under the name. */
  meta?: string
  /**
   * The newest assistant text of the node's own session, set as a small tail
   * under the name — the one thing a card could not say before (it lived in the
   * detail window only). `lines` is the count the LAYOUT reserved for it, so the
   * card clamps to exactly what its box was sized for and never overflows the
   * row gutter (see textTailLines).
   */
  text?: { value: string; lines: number }
  /** Extra class for the name (the aggregate recedes one rung). */
  extraClass?: string
  /** Extra rows the caller appends (the team task line). */
  children?: ReactNode
}): ReactNode {
  const { kind, count, foldKind, depth, phase, chip, text } = props
  return (
    <span className={clsx(css.cardTop, depthClass(depth))}>
      <span className={css.cardBadges}>
        <span className={css.kindBadge} data-card-kind={kind}>
          {cardKindLabel(kind, count ?? 0, foldKind ?? 'done')}
        </span>
        {phase !== undefined && (
          <span
            className={clsx(css.phaseBadge, phaseClass(phase.index))}
            title={phase.title ?? t('workflowPhaseUnnamed')}
          >
            {phase.title ?? t('workflowPhaseUnnamed')}
          </span>
        )}
        {chip !== undefined && chip !== '' && <span className={css.kindChip}>{chip}</span>}
      </span>
      <span className={clsx(css.cardName, props.extraClass)} title={props.name}>{props.name}</span>
      {props.meta !== undefined && props.meta !== '' && (
        <span className={css.cardMeta} title={props.meta}>{props.meta}</span>
      )}
      {text !== undefined && (
        <span
          className={css.cardText}
          style={{ WebkitLineClamp: text.lines }}
          title={text.value}
        >
          {text.value}
        </span>
      )}
      {props.children}
    </span>
  )
}

/** The bottom bar: the node's activity (or its state word), dot and chevron. */
export function CardBar(props: {
  state: TasksNodeState
  /** The merged process activity line (running nodes and settled summaries). */
  activity?: string
  /** Whether the node is executing (drives the sweep). */
  running?: boolean
  /** Fold the node into its parent's completed aggregate (settled nodes only). */
  onFold?: (event: { stopPropagation(): void }) => void
  /** The chevron's accessible name (defaults to the per-node fold word). */
  foldLabel?: string
  /** Render the state WORD next to the dot (off for the aggregate's action bar). */
  stateWord?: boolean
  /** Replace the whole bar's content (the aggregate's action row). */
  children?: ReactNode
}): ReactNode {
  const { state, activity, running } = props
  // An empty string is not an activity line: it would print a gap where the
  // state word used to be.
  const line = activity === undefined || activity === '' ? undefined : activity
  /**
   * Which states still print their word. The activity line REPLACES it for
   * work that the line already describes — a running node's own native status
   * and a settled node's completed summary. `idle` and `error` keep the word:
   * a teammate between turns and a failed node both read as "finished
   * something" from their summary alone, which is exactly the misreading the
   * two states must not allow.
   */
  const showStateWord = props.stateWord !== false
    && (line === undefined || state === 'idle' || state === 'error')
  return (
    <span
      className={css.cardBar}
      data-card-bar={state}
      data-running={running === true ? 'true' : undefined}
    >
      {props.children ?? (
        <>
          <StateDot state={nodeDotState(state)} size={6} className={css.barDot} />
          {showStateWord && <span className={css.barState}>{stateLabel(state)}</span>}
          {line !== undefined && (
            <span className={css.barActivity} title={line}>{line}</span>
          )}
          {props.onFold !== undefined && (
            <button
              type="button"
              className={css.barFold}
              aria-label={props.foldLabel ?? t('tasksFoldOne')}
              title={props.foldLabel ?? t('tasksFoldOne')}
              onClick={(event) => {
                // The card's own click opens the detail popover: folding must
                // never do both.
                event.stopPropagation()
                props.onFold?.(event)
              }}
            >
              {/*
                The COLLAPSE direction (chevron up = gather into the group): the
                aggregate card at the other end of the same motion offers the
                EXPAND one (chevron down). Two opposite actions must not share
                a glyph — the first cut drew both as a down chevron.
              */}
              <IconChevronUpOutlineRegular size={12} />
            </button>
          )}
        </>
      )}
    </span>
  )
}
