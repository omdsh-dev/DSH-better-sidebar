/**
 * The clue detail window (S9).
 *
 * One resource, hosted by S6's unified window. The source owns the structured
 * document; the format renderer its plugin registered owns the pixels; this
 * module owns the load/save lifecycle and the explicit failure states.
 *
 * Editing rules (approved S9 spec):
 * - editable types edit in place: `clues.loadEdit` opens the baseline and
 *   `clues.saveEdit` is the ONLY write path (the renderer never writes);
 * - read-only types / missing permission show the reason plus the credential-
 *   free original-source entry when the locator carries one;
 * - INSERT and SAVE are separate actions: the footer's insert button puts a
 *   stable chip into the draft, it never sends and never saves;
 * - a save conflict keeps the draft, reports `conflict` and offers an explicit
 *   re-read instead of silently discarding the edit;
 * - an unknown format is read-only through S6's unknown-format summary; there
 *   is no generic save.
 *
 * Window identity: a stored clue uses its stable clue id; a not-yet-ensured
 * candidate uses a deterministic hash of source/type/locator, so clicking the
 * same row twice focuses the same window instead of stacking previews.
 */
import { createElement } from 'react'
import type { ReactNode } from 'react'
import type { WindowDocumentContent, WindowHandle } from '../../windows/types.ts'
import type { BetterSidebarWindowsClientFace } from '../../windows/types.ts'
import type {
  ClueEditDocument,
  ClueReadResult,
  ClueTypeDescriptor,
  JsonValue,
  Locator,
} from '../../../clues/types.ts'
import type { BetterSidebarCluesClientFace } from '../registry.ts'
import { categoryOf, clueErrorMessage, clueErrorHint } from '../copy.ts'
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
  readonly sessionId?: string
  /** Insert one stable clue id into the draft (the footer's insert action). */
  onInsertClue?(clueId: string, title: string): boolean
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

/** The live state of one detail window. */
interface DetailState {
  readonly format: string
  readonly document: ClueEditDocument | ClueReadResult
  readonly readOnly: boolean
  readonly baseRevision?: string
  readonly data: JsonValue
  readonly saving: boolean
  readonly saved: boolean
  readonly conflict: boolean
  readonly error: string | null
}

/** The loading body. */
function DetailStatus(props: { readonly text: string }): ReactNode {
  return createElement('div', { className: css.status, role: 'status' }, props.text)
}

/** One explicit failure that could not even produce a preview. */
function DetailFailure(props: { readonly message: string; readonly url: string | undefined }): ReactNode {
  return createElement(
    'div',
    { className: css.failure, role: 'alert' },
    createElement('div', { className: css.failureTitle }, t('clueDetailFailed')),
    createElement('div', { className: css.failureBody }, props.message),
    props.url === undefined
      ? null
      : createElement('a', {
          className: css.action,
          href: props.url,
          target: '_blank',
          rel: 'noreferrer',
        }, t('clueDetailOpenSource')),
  )
}

/** Whether the catalogue marks this source/type editable. */
async function editableOf(
  face: BetterSidebarCluesClientFace,
  target: ClueDetailTarget,
): Promise<boolean> {
  try {
    const catalogue = await face.api.sources()
    const source = catalogue.sources.find(candidate => candidate.sourceId === target.sourceId)
    const type: ClueTypeDescriptor | undefined =
      catalogue.types.find(candidate => candidate.typeId === target.typeId)
    return source?.capabilities.edit === true && type?.capabilities.edit === true
  } catch {
    return false
  }
}

/** Render the document descriptor of one state (shared by every refresh). */
function descriptorOf(
  target: ClueDetailTarget,
  state: DetailState,
  handlers: { onChange(data: JsonValue): void; onSave?: () => void },
): WindowDocumentContent {
  return {
    kind: 'document',
    sourceId: target.sourceId,
    typeId: target.typeId,
    format: state.format,
    document: { ...state.document, data: state.data } as ClueEditDocument | ClueReadResult,
    readOnly: state.readOnly,
    saving: state.saving,
    saved: state.saved,
    ...(state.error === null ? {} : { error: state.error }),
    onChange: handlers.onChange,
    ...(handlers.onSave === undefined ? {} : { onSave: handlers.onSave }),
  }
}

/** Load one resource into an already-open window. */
async function loadInto(
  handle: WindowHandle,
  options: ClueDetailWindowOptions,
): Promise<void> {
  const { face, workspaceId, target } = options
  const resource = target.clueId !== undefined
    ? { clueId: target.clueId, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) }
    : {
        sourceId: target.sourceId,
        typeId: target.typeId,
        locator: target.locator ?? {},
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      }
  const url = originalUrl(target.locator)
  const editable = await editableOf(face, target)

  let state: DetailState
  const readOnlyState = (result: ClueReadResult, error: string | null): DetailState => ({
    format: result.format,
    document: result,
    data: result.data,
    readOnly: true,
    saving: false,
    saved: false,
    conflict: false,
    error,
  })
  if (editable) {
    try {
      const document = await face.api.loadEdit(workspaceId, resource)
      state = {
        format: document.format,
        document,
        data: document.data,
        readOnly: false,
        ...(document.baseRevision === undefined ? {} : { baseRevision: document.baseRevision }),
        saving: false,
        saved: false,
        conflict: false,
        error: null,
      }
    } catch (failure) {
      // Editing is unavailable for a reason the reader can act on (permission,
      // missing dependency, not-found). Fall back to the read-only preview and
      // carry the reason in the error strip.
      const hint = clueErrorHint(categoryOf(failure))
      try {
        state = readOnlyState(
          await face.api.read(workspaceId, resource),
          hint ?? clueErrorMessage(failure, t('clueDetailFailed')),
        )
      } catch (readFailure) {
        handle.update({
          content: createElement(DetailFailure, {
            message: clueErrorHint(categoryOf(readFailure)) ?? clueErrorMessage(readFailure, t('clueDetailFailed')),
            url,
          }),
        })
        return
      }
    }
  } else {
    try {
      state = readOnlyState(await face.api.read(workspaceId, resource), null)
    } catch (failure) {
      handle.update({
        content: createElement(DetailFailure, {
          message: clueErrorHint(categoryOf(failure)) ?? clueErrorMessage(failure, t('clueDetailFailed')),
          url,
        }),
      })
      return
    }
  }

  const reload = (): void => {
    handle.update({ content: createElement(DetailStatus, { text: t('loading') }) })
    void loadInto(handle, options)
  }

  const save = async (): Promise<void> => {
    if (state.readOnly || state.saving) return
    state = { ...state, saving: true, error: null, conflict: false }
    render()
    try {
      const result = await face.api.saveEdit(workspaceId, {
        ...resource,
        document: {
          format: state.format,
          data: state.data,
          ...(state.baseRevision === undefined ? {} : { baseRevision: state.baseRevision }),
        },
      })
      state = {
        ...state,
        saving: false,
        saved: true,
        ...(result.revision === undefined ? {} : { baseRevision: result.revision }),
      }
      render()
    } catch (failure) {
      const conflict = categoryOf(failure) === 'conflict'
      state = {
        ...state,
        saving: false,
        saved: false,
        conflict,
        // A conflict keeps the draft: the re-read action is the reader's
        // explicit choice, never an automatic overwrite.
        error: conflict ? t('clueDetailConflict') : clueErrorMessage(failure, t('clueDetailFailed')),
      }
      render()
    }
  }

  const footerOf = (current: DetailState): ReactNode =>
    createElement(
      'div',
      { className: css.footer },
      options.onInsertClue === undefined
        ? null
        : createElement(
            'button',
            {
              type: 'button',
              className: css.action,
              onClick: () => {
                void (async () => {
                  try {
                    const clueId = target.clueId ?? (await face.api.ensure(workspaceId, {
                      sourceId: target.sourceId,
                      typeId: target.typeId,
                      locator: target.locator ?? {},
                      title: target.title,
                    })).clue.id
                    if (options.onInsertClue?.(clueId, target.title) !== true) {
                      state = { ...state, error: t('clueInsertFailed') }
                      render()
                    }
                  } catch (failure) {
                    state = { ...state, error: clueErrorMessage(failure, t('clueInsertFailed')) }
                    render()
                  }
                })()
              },
            },
            t('clueBrowserInsert'),
          ),
      current.readOnly
        ? null
        : createElement(
            'button',
            {
              type: 'button',
              className: css.action,
              disabled: current.saving,
              onClick: () => { void save() },
            },
            current.saving ? t('loading') : t('save'),
          ),
      current.conflict
        ? createElement(
            'button',
            { type: 'button', className: css.action, onClick: reload },
            t('clueDetailReload'),
          )
        : null,
    )

  function render(): void {
    const current = state
    handle.update({
      content: descriptorOf(target, current, {
        onChange: (data) => {
          state = { ...state, data, saved: false }
          render()
        },
        ...(current.readOnly ? {} : { onSave: () => { void save() } }),
      }),
      dirty: !current.readOnly && current.saved === false,
      saving: current.saving,
    })
    handle.update({ footer: footerOf(current) })
  }

  render()
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
