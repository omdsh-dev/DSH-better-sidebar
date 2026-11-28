/**
 * The plugin's GLOBAL UI atoms — the one place the files page, the changes
 * page, the tasks page and every future page take their row chrome, badges,
 * state lines and confirmations from.
 *
 * Why they exist: the repo carried 14 duplicated empty/error/hint classes
 * across four stylesheets (two of them byte-identical), two copies of the
 * Cancel/Confirm modal, five icon-button recipes (including a class-NAME
 * collision: `.iconButton` was a 28px circle in one sheet and a 24px square
 * in another) and five chip/toggle recipes. These components own those
 * pictures ONCE, cut to the plugin's native scale (see
 * `docs/plans/2026-09-27-files-changes-uiux.md` §1): 12px body, 11px meta,
 * 28px controls/rows, 2/3/4/8px radii, one accent.
 *
 * Skin contract: every paint comes from `kit.module.css` and resolves to a
 * `--dsw-*` / `--ds-*` token (`tests/theme.spec.ts` scans the sheet).
 */
import { forwardRef, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { FileTypeIcon, Modal } from '@deepseek-ai/dsh-client-ui-primitives/client'
import { LoadingIndicator } from './LoadingIndicator.tsx'
import design from './design.module.css'
import css from './kit.module.css'

type DataAttributes = { readonly [key: `data-${string}`]: string | number | boolean | undefined }

/**
 * A 28px (`md`) or 24px (`sm`) square glyph button — the ONE icon button of
 * the plugin. Callers that need a pressed state pass `active`; the danger
 * tone only recolors the glyph/hover, never the geometry.
 */
export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'size'> & DataAttributes & {
  icon: ReactNode
  /** Accessible name; also the default hover title. */
  label: string
  title?: string
  onClick(event: MouseEvent<HTMLButtonElement>): void
  size?: 'md' | 'sm'
  active?: boolean
  disabled?: boolean
  danger?: boolean
  className?: string | undefined
}>(function IconButton(props, ref): ReactNode {
  const { icon, label, title, onClick, size = 'md', active, disabled, danger, className, ...nativeProps } = props
  return (
    <button
      {...nativeProps}
      ref={ref}
      type="button"
      className={clsx(css.iconButton, size === 'sm' ? css.iconButtonSm : css.iconButtonMd,
        active === true && css.iconButtonActive, danger === true && css.iconButtonDanger, className)}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      aria-pressed={active ?? nativeProps['aria-pressed']}
      onClick={(event) => { onClick(event) }}
    >
      {icon}
    </button>
  )
})

/** A shared text action. Busy actions keep their label and width while waiting. */
export const ActionButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & DataAttributes & {
  variant?: 'outline' | 'primary' | 'ghost'
  busy?: boolean
  size?: 'sm' | 'md'
  danger?: boolean
}>(function ActionButton({ variant = 'outline', busy, disabled, className, children, type = 'button', size = 'md', danger, ...props }, ref): ReactNode {
  return <button {...props} ref={ref} type={type} disabled={disabled || busy}
    aria-busy={busy || undefined}
    className={clsx(css.button, variant === 'primary' && css.buttonPrimary, variant === 'ghost' && css.buttonGhost, size === 'sm' && css.buttonSm, danger && css.confirmDanger, className)}>
    {busy && <span className={css.buttonSpinner} aria-hidden={true}><LoadingIndicator inline size={14} label="" role="presentation" /></span>}
    <span className={css.buttonLabel}>{children}</span>
  </button>
})

/**
 * A small toggle chip (filters, list switches). `count` renders as a trailing
 * figure in the meta rung; the chip's rest / hover / selected states are three
 * different pictures (a bare fill swap reads as hover).
 */
export function Chip(props: {
  children: ReactNode
  active?: boolean
  count?: number
  title?: string
  disabled?: boolean
  onClick(): void
  className?: string | undefined
}): ReactNode {
  return (
    <button
      type="button"
      className={clsx(css.chip, props.active === true && css.chipActive, props.className)}
      data-active={props.active === true ? 'true' : undefined}
      aria-pressed={props.active === true}
      title={props.title}
      disabled={props.disabled}
      onClick={() => { props.onClick() }}
    >
      <span className={css.chipLabel}>{props.children}</span>
      {props.count !== undefined && <span className={css.chipCount}>{props.count}</span>}
    </button>
  )
}

/**
 * Props of {@link FileAttachmentChip}.
 */
export interface FileAttachmentChipProps {
  /** File name shown as the chip's title. */
  readonly name: string
  /** Human-readable size ("312 KB"); omitted when the host cannot know it. */
  readonly size?: string
  /** Path that picks the host's file-type glyph; defaults to `name`. */
  readonly path?: string
  /** Native tooltip, typically the attachment's full path. */
  readonly title?: string
  /** The message still names the attachment but it can no longer be resolved. */
  readonly unavailable?: boolean
  readonly className?: string | undefined
}

/**
 * The ONE static file attachment: the host's file-type glyph, the name and the
 * size on the same 22px band as {@link Chip}. It is a picture, not a control —
 * there is no button, no hover, no focus — because an attachment inside a
 * message is data the reader reads, unlike the filter chips that act.
 */
export function FileAttachmentChip(props: FileAttachmentChipProps): ReactNode {
  const { name, size, path, title, unavailable, className } = props
  return (
    <span
      className={clsx(css.fileChip, className)}
      title={title}
      {...(unavailable === true ? { 'data-unavailable': 'true' } : {})}
    >
      <span className={css.fileChipIcon} aria-hidden="true"><FileTypeIcon path={path ?? name} size={16} /></span>
      <span className={css.fileChipName}>{name}</span>
      {size !== undefined && <span className={css.fileChipSize}>{size}</span>}
    </span>
  )
}

/**
 * The ONE download affix: a real anchor carrying `download`, so the file goes
 * to disk instead of opening a tab. `button` is the bordered pill a fallback
 * pane offers as its way out; `inline` is the underlined escape hatch a notice
 * bar puts beside its sentence. Four surfaces cut this recipe by hand before
 * (binary download, media fallback, PDF toolbar, large-file notice).
 */
export function DownloadLink(props: {
  href: string
  children: ReactNode
  variant?: 'button' | 'inline'
  className?: string | undefined
}): ReactNode {
  const { href, children, variant = 'button', className } = props
  return (
    <a
      className={clsx(css.downloadLink, variant === 'inline' && css.downloadLinkInline, className)}
      href={href}
      download
    >
      {children}
    </a>
  )
}

/**
 * A 28px section band: a label (with an optional count) that may carry ONE
 * trailing action. The hairline under it is the page's only section divider.
 */
export function SectionHeader(props: {
  label: ReactNode
  count?: number
  action?: ReactNode
  className?: string | undefined
  children?: ReactNode
}): ReactNode {
  return (
    <div className={clsx(css.sectionHeader, props.className)}>
      <span className={css.sectionLabel}>{props.label}</span>
      {props.count !== undefined && <span className={css.sectionCount}>{props.count}</span>}
      {props.children}
      {props.action !== undefined && <span className={css.sectionAction}>{props.action}</span>}
    </div>
  )
}

/**
 * The plugin's state lines: empty / loading / error / warn / hint.
 * `tone` picks the geometry (`page` = centered 16px block, `well` = the
 * compact 4/12/8 line inside a list, `inline` = 10px micro copy).
 */
export function Notice(props: {
  kind: 'empty' | 'loading' | 'error' | 'warn' | 'hint'
  tone?: 'page' | 'well' | 'inline'
  role?: string
  className?: string | undefined
  children: ReactNode
}): ReactNode {
  const tone = props.tone ?? 'well'
  if (props.kind === 'loading') {
    return <LoadingIndicator label={props.children} inline={tone === 'inline'} centered={tone === 'page'} role={props.role}
      className={clsx(css.notice, tone === 'page' ? css.noticePage : tone === 'inline' ? css.noticeInline : css.noticeWell,
        css.noticeHint, props.className)} />
  }
  return (
    <div
      className={clsx(css.notice, tone === 'page' ? css.noticePage : tone === 'inline' ? css.noticeInline : css.noticeWell,
        props.kind === 'error' && css.noticeError, props.kind === 'warn' && css.noticeWarn,
        props.kind === 'hint' && css.noticeHint, props.className)}
      data-kind={props.kind}
      role={props.role ?? (props.kind === 'error' ? 'alert' : undefined)}
    >
      {props.children}
    </div>
  )
}

/**
 * The ONE confirmation dialog: a quiet single-question body and a
 * Cancel/Confirm footer, with `busy` locking both actions while the action
 * runs. Destructive callers pass `danger` so the primary button reads as one.
 */
export function ConfirmDialog(props: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm(): void
  onClose(): void
}): ReactNode {
  return (
    <Modal
      open={props.open}
      onClose={() => { if (!props.busy) props.onClose() }}
      backdropBlur={false}
      title={props.title}
      className={clsx(design.surface, css.confirmDialog)}
      contentClassName={css.confirmContent}
      closeLabel={props.cancelLabel}
      footer={(
        <>
          <ActionButton className={css.confirmAction} disabled={props.busy} onClick={props.onClose}>{props.cancelLabel}</ActionButton>
          <ActionButton className={css.confirmAction} danger={props.danger} variant="primary" busy={props.busy} onClick={props.onConfirm}>{props.confirmLabel}</ActionButton>
        </>
      )}
    >
      <p className={css.confirmDesc}>{props.description}</p>
    </Modal>
  )
}

/**
 * The status vocabulary shared by git rows, session-op rows and diff kinds.
 * `neutral` is the fallback for a kind the caller has no tone for.
 */
export type StatusTone =
  | 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed'
  | 'conflict' | 'read' | 'write' | 'edit' | 'neutral'

/** A compact status badge: a git letter, an op kind, a diff tag. */
export function StatusBadge(props: {
  tone: StatusTone
  title?: string
  className?: string | undefined
  children: ReactNode
}): ReactNode {
  return (
    <span className={clsx(css.statusBadge, props.className)} data-tone={props.tone} title={props.title}>
      {props.children}
    </span>
  )
}
