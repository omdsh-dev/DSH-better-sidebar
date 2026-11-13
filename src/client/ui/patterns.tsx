/**
 * Shared page SHAPES — the second half of the global kit.
 *
 * `kit.tsx` owns the atoms (a button, a badge, a state line). This module owns
 * the shapes every page kept rebuilding: a key-value fact, a list row, an empty
 * page, an error with its retry, a labelled field, a mutually-exclusive choice,
 * a status line and an action footer.
 *
 * Why it exists (measured before the rewrite): the clue surface alone carried
 * 31 copies of the fact row, 14 list-row shells, 10 empty states, 14 error+
 * retry blocks, 15 stacked fields, 6 choice groups, 11 status footers and 9
 * action bars — 968 lines of CSS in 10 near-identical families, already drifted
 * apart (four spellings of the retry row, three different "selected" pictures).
 * A page that needs one of these shapes now passes props instead of re-cutting
 * the picture.
 *
 * Rules these components keep, so callers do not have to think about them:
 * - ONE border language (1px solid), flat fills only, no shadow, no gradient;
 * - a default/resting state is NOT styled (a healthy row is quiet), so a page
 *   never repaints every row to say "fine";
 * - keyboard operation is native: a navigating title is a real `<button>`, a
 *   choice is a real `<input>`, a status action is a real button;
 * - a coarse pointer gets 44px targets;
 * - every number is tabular.
 *
 * Skin contract: every paint resolves to a `--dsw-*` / `--ds-*` token
 * (`tests/theme.spec.ts` scans `patterns.module.css`).
 */
import type { CSSProperties, ReactNode } from 'react'
import clsx from 'clsx'
import { ActionButton } from './kit.tsx'
import css from './patterns.module.css'

/** `data-*` passthrough used by every component here (e2e stable locators). */
type DataAttributes = { readonly [key: `data-${string}`]: string | number | boolean | undefined }

/** Ink rung of one fact / status; absent means the neutral secondary ink. */
export type PatternTone = 'error' | 'warn' | 'success' | 'business'

/** One row of a {@link FactList}. */
export interface Fact {
  /** Stable React key and the row's data attribute. */
  readonly key: string
  /** Localized label; omitted renders the value alone (a bare fact). */
  readonly label?: string
  readonly value: ReactNode
  /** Monospace + tabular figures: ids, paths, hashes, model names. */
  readonly mono?: boolean
  readonly tone?: PatternTone
}

/** Props of {@link FactRow}. */
export interface FactRowProps {
  readonly label?: string
  readonly value: ReactNode
  readonly mono?: boolean
  readonly tone?: PatternTone
  readonly className?: string
}

/**
 * One key-value fact: the label in the quiet rung, the value in the primary one.
 *
 * Deliberately not a `<dl>`: these rows are rendered inside lists, headers and
 * definition tables whose markup the caller owns, and a nested definition list
 * would fight the surrounding semantics. The label/value pair is readable in
 * order either way.
 */
export function FactRow({ label, value, mono, tone, className }: FactRowProps): ReactNode {
  return (
    <div className={clsx(css.factRow, className)} {...(tone === undefined ? {} : { 'data-tone': tone })}>
      {label !== undefined && <span className={css.factLabel}>{label}</span>}
      <span className={clsx(css.factValue, mono === true && css.mono)}>{value}</span>
    </div>
  )
}

/** Props of {@link FactList}. */
export interface FactListProps {
  readonly facts: readonly Fact[]
  readonly className?: string
  /** Accessible name of the group; the caller owns the localized string. */
  readonly label?: string
}

/** A stack of {@link FactRow}s, skipping nothing and inventing nothing. */
export function FactList({ facts, className, label }: FactListProps): ReactNode {
  if (facts.length === 0) return null
  return (
    <div className={clsx(css.factList, className)} {...(label === undefined ? {} : { role: 'group', 'aria-label': label })}>
      {facts.map(fact => (
        <FactRow
          key={fact.key}
          label={fact.label}
          value={fact.value}
          mono={fact.mono}
          tone={fact.tone}
        />
      ))}
    </div>
  )
}

/** Props of {@link ListRow}. */
export interface ListRowProps extends DataAttributes {
  /** Glyph or status dot at the leading edge. */
  readonly leading?: ReactNode
  readonly title: ReactNode
  /**
   * `data-*` for the title element itself. The title owns the ellipsis, so a
   * caller's locator must land on the title, not on a wrapper inside it — a
   * nested span would inherit the truncation but not the measured style.
   */
  readonly titleData?: DataAttributes
  /**
   * Accessible name of the title button when the visible title alone would be
   * ambiguous ("Release clues" → "Manage pack: Release clues"). Ignored for a
   * plain title, which is text rather than a control.
   */
  readonly titleLabel?: string
  /** Secondary line under the title (a subtitle, not a second fact column). */
  readonly subtitle?: ReactNode
  /** Facts at the trailing edge, before the actions. */
  readonly meta?: ReactNode
  /** Row actions; hidden until the row is hovered or focused. */
  readonly actions?: ReactNode
  /**
   * `button` makes the title the row's single navigation target — the shape a
   * browse result uses. `plain` (default) leaves the title as text, for a row
   * whose whole surface is a click target of the caller's own control.
   */
  readonly titleAs?: 'plain' | 'button'
  readonly onTitleClick?: () => void
  readonly selected?: boolean
  /** A row that exists but is not actionable yet (unresolved reference). */
  readonly dimmed?: boolean
  readonly onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void
  /**
   * Roving-focus membership for {@link useListNavigation}: the title button
   * carries `data-list-primary` and is the list's one Tab stop when `true`,
   * and leaves the tab order when `false`. The hook's contract is exactly
   * "mark each title with data-list-primary", so the row honours it here
   * instead of making every caller reach into the button.
   */
  readonly primary?: boolean
  readonly className?: string
}

/**
 * The one list-row shell: leading glyph, title (optionally a real button),
 * subtitle, trailing facts, hover-revealed actions.
 *
 * Selected and dimmed are the only two visual states; everything else is the
 * untouched surface, because a list of 25 rows must not repaint itself.
 */
export function ListRow(props: ListRowProps): ReactNode {
  const {
    leading, title, titleData, titleLabel, subtitle, meta, actions, titleAs = 'plain', onTitleClick,
    selected, dimmed, onContextMenu, primary, className, ...dataProps
  } = props
  return (
    <div
      {...dataProps}
      className={clsx(css.listRow, className)}
      {...(selected === true ? { 'data-selected': 'true' } : {})}
      {...(dimmed === true ? { 'data-dimmed': 'true' } : {})}
      onContextMenu={onContextMenu}
    >
      {leading !== undefined && <span className={css.listRowLeading}>{leading}</span>}
      {titleAs === 'button'
        ? (
            // A navigating row puts the subtitle INSIDE the button: the whole
            // two-line caption is then one click target and one accessible
            // name, exactly like the browse rows this replaces.
            <button
              type="button"
              {...titleData}
              className={clsx(css.listRowMain, css.listRowTitle)}
              {...(titleLabel === undefined ? {} : { 'aria-label': titleLabel, title: titleLabel })}
              {...(primary === undefined ? {} : { 'data-list-primary': true, tabIndex: primary ? 0 : -1 })}
              onClick={onTitleClick}
            >
              <span className={css.listRowName}>{title}</span>
              {subtitle !== undefined && <span className={css.listRowSubtitle}>{subtitle}</span>}
            </button>
          )
        : (
            <span className={css.listRowMain}>
              <span {...titleData} className={css.listRowName} style={TITLE_TEXT as CSSProperties}>{title}</span>
              {subtitle !== undefined && <span className={css.listRowSubtitle}>{subtitle}</span>}
            </span>
          )}
      {meta !== undefined && <span className={css.listRowMeta}>{meta}</span>}
      {actions !== undefined && <span className={css.listRowActions}>{actions}</span>}
    </div>
  )
}

/** A text title must not inherit the button's pointer cursor. */
const TITLE_TEXT = { cursor: 'inherit' } as const

/** The title text itself: truncation happens here, on whatever owns the row. */

/** Props of {@link EmptyState}. */
export interface EmptyStateProps extends DataAttributes {
  readonly icon?: ReactNode
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly actions?: ReactNode
  /** `page` centres in a whole pane; `well` is the compact block inside a list. */
  readonly tone?: 'page' | 'well'
  readonly className?: string
}

/** The one empty state: glyph, one-line title, optional description, actions. */
export function EmptyState({ icon, title, description, actions, tone = 'well', className, ...dataProps }: EmptyStateProps): ReactNode {
  return (
    <div {...dataProps} className={clsx(css.empty, tone === 'page' ? css.emptyPage : css.emptyWell, className)}>
      {icon !== undefined && <span className={css.emptyIcon}>{icon}</span>}
      <span className={css.emptyTitle}>{title}</span>
      {description !== undefined && <span className={css.emptyDescription}>{description}</span>}
      {actions !== undefined && <span className={css.emptyActions}>{actions}</span>}
    </div>
  )
}

/** Props of {@link ErrorBlock}. */
export interface ErrorBlockProps extends DataAttributes {
  readonly message: ReactNode
  /** A sanitized second line (a reason code, a dependency id) — never a secret. */
  readonly detail?: ReactNode
  readonly retryLabel?: string
  readonly onRetry?: () => void
  /** A retry already in flight: the button stays, disabled, and says so. */
  readonly busy?: boolean
  readonly className?: string
}

/**
 * Error + its retry, as ONE block.
 *
 * The retry belongs to the message: separated, a reader can miss which line it
 * belongs to, and the four hand-written spellings this replaces had already
 * drifted in exactly that way (two put the button above, two below).
 */
export function ErrorBlock({ message, detail, retryLabel, onRetry, busy, className, ...dataProps }: ErrorBlockProps): ReactNode {
  return (
    <div {...dataProps} className={clsx(css.errorBlock, className)} role="alert">
      <span className={css.errorBody}>
        <span className={css.errorMessage}>{message}</span>
        {detail !== undefined && <span className={css.errorDetail}>{detail}</span>}
      </span>
      {onRetry !== undefined && retryLabel !== undefined && (
        <span className={css.errorAction}>
          {/* The kit's own action recipe: a retry is a button, not a fifth
              spelling of one. */}
          <ActionButton size="sm" busy={busy === true} onClick={onRetry}>{retryLabel}</ActionButton>
        </span>
      )}
    </div>
  )
}

/** Props of {@link Field}. */
export interface FieldProps {
  readonly label: ReactNode
  readonly description?: ReactNode
  readonly error?: ReactNode
  readonly htmlFor?: string
  /** `stacked` (default) puts the label above; `inline` puts it beside. */
  readonly layout?: 'stacked' | 'inline'
  readonly children: ReactNode
  readonly className?: string
}

/**
 * A labelled control with its description and its error.
 *
 * Replaces the 15 stacked label+control blocks that each re-declared the same
 * three typographic rungs. The label is a real `<label>` when `htmlFor` is
 * given, so clicking it focuses the control.
 */
export function Field({ label, description, error, htmlFor, layout = 'stacked', children, className }: FieldProps): ReactNode {
  return (
    <div className={clsx(css.field, layout === 'inline' && css.fieldInline, className)}>
      {htmlFor === undefined
        ? <span className={css.fieldLabel}>{label}</span>
        : <label className={css.fieldLabel} htmlFor={htmlFor}>{label}</label>}
      <div className={css.fieldControl}>{children}</div>
      {description !== undefined && <span className={css.fieldDescription}>{description}</span>}
      {error !== undefined && <span className={css.fieldError} role="alert">{error}</span>}
    </div>
  )
}

/** One option of a {@link ChoiceCard} group. */
export interface ChoiceOption {
  readonly value: string
  readonly title: ReactNode
  readonly meta?: ReactNode
  readonly icon?: ReactNode
  readonly disabled?: boolean
}

/** Props of {@link ChoiceCard}. */
export interface ChoiceCardProps {
  readonly type: 'radio' | 'checkbox'
  /** The form field name shared by the group. */
  readonly name: string
  readonly options: readonly ChoiceOption[]
  /** Selected values; a radio group passes at most one. */
  readonly selected: readonly string[]
  readonly onChange: (value: string, checked: boolean) => void
  readonly label?: string
  /** Locks the whole group, the way a native `<fieldset disabled>` does. */
  readonly disabled?: boolean
  readonly className?: string
}

/**
 * Mutually-exclusive (or multiple) choices that need a title AND a line of
 * explanation — the shape a plain segmented control cannot carry.
 *
 * The native `<input>` stays in the DOM: form semantics, keyboard operation,
 * screen-reader announcements and `:checked` styling all come for free, and
 * only its picture is replaced by {@link ChoiceCard}'s own mark.
 */
export function ChoiceCard({ type, name, options, selected, onChange, label, disabled, className }: ChoiceCardProps): ReactNode {
  return (
    <fieldset className={clsx(css.choiceGrid, className)} role={type === 'radio' ? 'radiogroup' : 'group'}
      disabled={disabled} {...(label === undefined ? {} : { 'aria-label': label })}>
      {options.map(option => {
        const checked = selected.includes(option.value)
        return (
          <label className={css.choice} data-type={type} data-value={option.value} key={option.value}>
            <input
              type={type}
              className={css.choiceInput}
              name={name}
              value={option.value}
              checked={checked}
              disabled={disabled === true || option.disabled === true}
              onChange={event => { onChange(option.value, event.target.checked) }}
            />
            <span className={css.choiceMark} aria-hidden="true">
              <svg className={css.choiceMarkGlyph} viewBox="0 0 12 12" width="9" height="9">
                {type === 'radio'
                  ? <circle cx="6" cy="6" r="2.5" fill="currentColor" />
                  : <path d="m2 6 2.5 2.5L10 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
              </svg>
            </span>
            {option.icon !== undefined && <span className={css.choiceIcon}>{option.icon}</span>}
            <span className={css.choiceBody}>
              <span className={css.choiceTitle}>{option.title}</span>
              {option.meta !== undefined && <span className={css.choiceMeta}>{option.meta}</span>}
            </span>
          </label>
        )
      })}
    </fieldset>
  )
}

/** Props of {@link StatusLine}. */
export interface StatusLineProps {
  readonly text: ReactNode
  readonly tone?: PatternTone
  readonly icon?: ReactNode
  readonly meta?: ReactNode
  readonly action?: ReactNode
  /** `status` announces changes politely; omit for a purely static footnote. */
  readonly role?: 'status'
  /** Drop the horizontal padding when the caller's container already has it. */
  readonly plain?: boolean
  readonly className?: string
}

/** The one footer/status line: text, optional meta, one trailing action. */
export function StatusLine({ text, tone, icon, meta, action, role, plain, className }: StatusLineProps): ReactNode {
  return (
    <div
      className={clsx(css.statusLine, plain === true && css.statusLinePlain, className)}
      {...(tone === undefined ? {} : { 'data-tone': tone })}
      {...(role === undefined ? {} : { role })}
    >
      {icon !== undefined && <span className={css.statusLineIcon}>{icon}</span>}
      <span className={css.statusLineText} title={typeof text === 'string' ? text : undefined}>{text}</span>
      {meta !== undefined && <span className={css.statusLineMeta}>{meta}</span>}
      {action !== undefined && <span className={css.statusLineAction}>{action}</span>}
    </div>
  )
}

/** Props of {@link ActionFooter}. */
export interface ActionFooterProps {
  /** Leading content: a count, a hint, the progress copy. */
  readonly start?: ReactNode
  /** Trailing actions, in reading order. */
  readonly end?: ReactNode
  /** Reach the edges of a gutter-padded window root so the hairline spans the window. */
  readonly bleed?: boolean
  readonly className?: string
}

/**
 * The stable action row at the bottom of a window or a section.
 *
 * Its separator is the page's ONE horizontal hairline at that edge, so callers
 * pass actions and never re-declare the border.
 */
export function ActionFooter({ start, end, bleed, className }: ActionFooterProps): ReactNode {
  return (
    <div className={clsx(css.actionFooter, bleed === true && css.actionFooterBleed, className)}>
      {start !== undefined && <span className={css.actionFooterStart} role="status">{start}</span>}
      {end !== undefined && <span className={css.actionFooterEnd}>{end}</span>}
    </div>
  )
}
