/**
 * The clue detail window (S9, read-only preview in this milestone).
 *
 * One resource, hosted by S6's unified window: the source owns the structured
 * document, the format renderer its plugin registered owns the pixels, and this
 * module owns only the load + the explicit failure states. Saving and editing
 * arrive with the package-management milestone; until then the window states
 * that it is a preview and never offers a generic save.
 *
 * Failure copy keeps the actionable S1 categories apart: a missing source
 * plugin, an unauthorized source and a permission denial are different
 * problems with different next steps, and a read failure never blanks the
 * window.
 *
 * Window identity: a stored clue uses its stable clue id; a not-yet-ensured
 * candidate uses a deterministic hash of its source/type/locator, so clicking
 * the same row twice focuses the same window instead of stacking previews.
 */
import { createElement } from 'react'
import type { ReactNode } from 'react'
import type { WindowDocumentContent, WindowHandle } from '../../windows/types.ts'
import type { BetterSidebarWindowsClientFace } from '../../windows/types.ts'
import type { ClueReadResult, JsonValue, Locator } from '../../../clues/types.ts'
import type { BetterSidebarCluesClientFace } from '../registry.ts'
import { categoryOf, clueErrorHint } from '../copy.ts'
import { t } from '../../locales.ts'
import css from './detail.module.css'

/** One clue resource address the browser can open. */
export interface ClueDetailTarget {
  readonly sourceId: string
  readonly typeId: string
  /** The persisted stable id, when the row already is a clue. */
  readonly clueId?: string
  readonly locator?: Locator
  readonly title: string
}

/** Options of {@link openClueDetailWindow}. */
export interface ClueDetailWindowOptions {
  readonly windows: BetterSidebarWindowsClientFace
  readonly face: BetterSidebarCluesClientFace
  readonly workspaceId: string
  readonly target: ClueDetailTarget
  /** Override the source/type of an existing clue row (rows always carry both). */
  readonly sessionId?: string
}

/** A small stable hash of one locator (deterministic window identity). */
function locatorHash(locator: JsonValue | undefined): string {
  const text = JSON.stringify(locator ?? {})
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

/** The window id of one detail target (stable across repeated opens). */
export function clueDetailWindowId(target: ClueDetailTarget): string {
  return target.clueId !== undefined
    ? `clue:${target.clueId}`
    : `clue-preview:${target.sourceId}:${target.typeId}:${locatorHash(target.locator)}`
}

/** A credential-free original-resource URL carried by a locator, if any. */
function originalUrl(locator: JsonValue | undefined): string | undefined {
  if (locator === null || typeof locator !== 'object' || Array.isArray(locator)) return undefined
  const url = (locator as { url?: unknown }).url
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined
}

/** The loading body. */
function DetailStatus(props: { readonly text: string }): ReactNode {
  return createElement('div', { className: css.status, role: 'status' }, props.text)
}

/** One explicit load failure (category-aware copy + optional original entry). */
function DetailFailure(props: {
  readonly message: string
  readonly category: string
  readonly url: string | undefined
  onRetry(): void
}): ReactNode {
  const hint = clueErrorHint(props.category)
  return createElement(
    'div',
    { className: css.failure, role: 'alert', 'data-clue-detail-failure': props.category },
    createElement('div', { className: css.failureTitle }, t('clueDetailFailed')),
    createElement('div', { className: css.failureBody }, hint ?? props.message),
    createElement(
      'div',
      { className: css.failureActions },
      createElement('button', { type: 'button', className: css.action, onClick: props.onRetry }, t('retry')),
      props.url === undefined
        ? null
        : createElement('a', {
            className: css.action,
            href: props.url,
            target: '_blank',
            rel: 'noreferrer',
          }, t('clueDetailOpenSource')),
    ),
  )
}

/** Build the S6 document descriptor of one read result (M2: read-only). */
function documentOf(target: ClueDetailTarget, result: ClueReadResult): WindowDocumentContent {
  return {
    kind: 'document',
    sourceId: target.sourceId,
    typeId: target.typeId,
    format: result.format,
    document: result,
    readOnly: true,
  }
}

/** Load one resource into an already-open window. */
async function loadInto(
  handle: WindowHandle,
  options: ClueDetailWindowOptions,
): Promise<void> {
  const { face, workspaceId, target } = options
  try {
    const result = await face.api.read(workspaceId, target.clueId !== undefined
      ? {
          clueId: target.clueId,
          ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        }
      : {
          sourceId: target.sourceId,
          typeId: target.typeId,
          locator: target.locator ?? {},
          ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        })
    handle.update({
      content: documentOf(target, result),
      dirty: false,
      saving: false,
    })
  } catch (error) {
    const category = categoryOf(error)
    handle.update({
      content: createElement(DetailFailure, {
        category,
        message: error instanceof Error ? error.message : String(error),
        url: originalUrl(target.locator),
        onRetry: () => { reload(handle, options) },
      }),
      dirty: false,
      saving: false,
    })
  }
}

/** Re-open the loading state and read again (the explicit retry action). */
function reload(handle: WindowHandle, options: ClueDetailWindowOptions): void {
  handle.update({ content: createElement(DetailStatus, { text: t('loading') }) })
  void loadInto(handle, options)
}

/**
 * Open (or focus) the detail window of one resource.
 * @param options - window host, clue face, workspace and the resource address.
 * @returns the window handle.
 */
export function openClueDetailWindow(options: ClueDetailWindowOptions): WindowHandle {
  const { windows, target } = options
  const handle = windows.open({
    id: clueDetailWindowId(target),
    title: target.title,
    size: 'document',
    content: createElement(DetailStatus, { text: t('loading') }),
  })
  void loadInto(handle, options)
  return handle
}
