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
import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { WindowDocumentContent, WindowHandle } from '../../windows/types.ts'
import type { BetterSidebarWindowsClientFace } from '../../windows/types.ts'
import type {
  ClueBinding,
  ClueEditDocument,
  ClueReadResult,
  ClueTypeDescriptor,
  JsonValue,
  Locator,
} from '../../../clues/types.ts'
import type { ClueWorkspaceChoice } from '../workspace-id.ts'
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
  /** Explicit workspaces the binding panel can offer (never guessed). */
  readonly workspaces?: readonly ClueWorkspaceChoice[]
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

/**
 * A credential-free original-resource URL for one locator.
 *
 * Feishu locators carry the public web URL; GitHub locators carry only the
 * structured identity, so the canonical issue/PR URL is rebuilt from
 * host/owner/repo/kind/number (never from a title or a token). URLs with
 * embedded credentials are refused.
 */
export function sourceUrlOf(locator: JsonValue | undefined): string | undefined {
  if (locator === null || typeof locator !== 'object' || Array.isArray(locator)) return undefined
  const record = locator as Record<string, unknown>
  const raw = record.url
  if (typeof raw === 'string') {
    try {
      const parsed = new URL(raw)
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && parsed.username === ''
        && parsed.password === '') {
        return parsed.href
      }
    } catch {
      // Fall through to the structured GitHub shape.
    }
  }
  const { host, owner, repo, kind, number } = record
  if (host === 'github.com'
    && typeof owner === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner)
    && typeof repo === 'string' && /^[A-Za-z0-9._-]+$/.test(repo)
    && (kind === 'issue' || kind === 'pull')
    && typeof number === 'number' && Number.isSafeInteger(number) && number > 0) {
    return `https://github.com/${owner}/${repo}/${kind === 'pull' ? 'pull' : 'issues'}/${number}`
  }
  return undefined
}

/** The localized explanation of a source-owned read-only marker. */
export function readOnlyReasonCopy(reason: string | undefined): string {
  switch (reason) {
    case 'archived':
      return t('clueDetailReadOnlyArchived')
    case 'permission-denied':
      return t('clueDetailReadOnlyPermission')
    case 'size':
      return t('clueDetailReadOnlySize')
    default:
      return t('clueDetailReadOnly')
  }
}

/** The live state of one detail window. */
interface DetailState {
  readonly format: string
  readonly document: ClueEditDocument | ClueReadResult
  readonly readOnly: boolean
  readonly baseRevision?: string
  readonly data: JsonValue
  readonly saving: boolean
  /** The document has actual unsaved edits (a fresh load is NOT dirty). */
  readonly dirty: boolean
  readonly conflict: boolean
  readonly error: string | null
}

/** The loading body. */
function DetailStatus(props: { readonly text: string }): ReactNode {
  return createElement('div', { className: css.status, role: 'status' }, props.text)
}

/** One explicit failure that could not even produce a preview. */
function DetailFailure(props: {
  readonly message: string
  readonly url: string | undefined
  onRetry?(): void
}): ReactNode {
  return createElement(
    'div',
    { className: css.failure, role: 'alert' },
    createElement('div', { className: css.failureTitle }, t('clueDetailFailed')),
    createElement('div', { className: css.failureBody }, props.message),
    createElement(
      'div',
      { className: css.failureActions },
      props.onRetry === undefined
        ? null
        : createElement('button', {
            type: 'button',
            className: css.action,
            onClick: props.onRetry,
          }, t('retry')),
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

/**
 * Whether the catalogue marks this source/type editable.
 * `undefined` means the catalogue could not be read: the caller still tries
 * the edit document and falls back to a preview if the source refuses.
 */
async function editableOf(
  face: BetterSidebarCluesClientFace,
  target: ClueDetailTarget,
): Promise<boolean | undefined> {
  try {
    const catalogue = await face.api.sources()
    const source = catalogue.sources.find(candidate => candidate.sourceId === target.sourceId)
    const type: ClueTypeDescriptor | undefined =
      catalogue.types.find(candidate => candidate.typeId === target.typeId)
    return source?.capabilities.edit === true && type?.capabilities.edit === true
  } catch {
    return undefined
  }
}

/** The source-owned read-only marker in one edit document, when present. */
function lockedReasonOf(document: ClueEditDocument): string | undefined {
  const data = document.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>
  if (record.readOnly !== true) return undefined
  return typeof record.readOnlyReason === 'string' ? record.readOnlyReason : ''
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
    saved: !state.dirty,
    ...(state.error === null ? {} : { error: state.error }),
    onChange: handlers.onChange,
    ...(handlers.onSave === undefined ? {} : { onSave: handlers.onSave }),
  }
}

/** Props of the single-clue workspace binding panel. */
interface ClueBindingPanelProps {
  readonly face: BetterSidebarCluesClientFace
  readonly clueId: string
  readonly workspaces: readonly ClueWorkspaceChoice[]
  readonly initialWorkspaceId: string
}

/**
 * The binding panel of ONE persisted clue.
 *
 * It reuses the pack panel's copy and mutation contract with the clue target
 * (`{kind:'clue', clueId}`): a binding only auto-provides a reference to NEW
 * sessions and never grants access, and unbinding deletes neither the clue
 * nor the references old sessions already carry. A not-yet-ensured candidate
 * has no stable binding identity, so the caller renders no panel for it.
 */
function ClueBindingPanel(props: ClueBindingPanelProps): ReactNode {
  const { face, clueId, workspaces, initialWorkspaceId } = props
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId)
  const [bindings, setBindings] = useState<readonly ClueBinding[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const revisionRef = useRef<number | undefined>(undefined)

  const apply = useCallback((result: {
    readonly bindings: readonly ClueBinding[]
    readonly revision: number
  }): void => {
    revisionRef.current = result.revision
    setBindings(result.bindings.filter(binding =>
      binding.target.kind === 'clue' && binding.target.clueId === clueId))
  }, [clueId])

  useEffect(() => {
    let active = true
    setFailure(null)
    void face.api.bindingsList(workspaceId).then((result) => {
      if (!active) return
      apply(result)
    }).catch((error: unknown) => {
      if (!active) return
      setFailure(clueErrorMessage(error, t('cluePackSaveFailed')))
    })
    return () => { active = false }
  }, [apply, face, workspaceId])

  const mutate = async (change: 'add' | 'remove'): Promise<void> => {
    setBusy(true)
    setFailure(null)
    try {
      const input = {
        target: { kind: 'clue' as const, clueId },
        ...(revisionRef.current === undefined ? {} : { expectedRevision: revisionRef.current }),
      }
      const result = change === 'add'
        ? await face.api.bindingsAdd(workspaceId, input)
        : await face.api.bindingsRemove(workspaceId, input)
      apply(result)
    } catch (error) {
      setFailure(clueErrorMessage(error, t('cluePackSaveFailed')))
    } finally {
      setBusy(false)
    }
  }

  const bound = bindings.length > 0
  return createElement(
    'section',
    { className: css.binding, 'data-clue-binding-panel': 'clue' },
    createElement('h3', { className: css.bindingHeading }, t('cluePackBindingHeading')),
    createElement('p', { className: css.bindingHint }, t('cluePackBindingHint')),
    createElement('p', { className: css.bindingHint }, t('cluePackBindingUnbindHint')),
    bound
      ? createElement(
          'div',
          { className: css.bindingRow },
          createElement('span', { className: css.bindingState }, t('cluePackBound')),
          createElement('button', {
            type: 'button',
            className: css.action,
            disabled: busy,
            onClick: () => { void mutate('remove') },
          }, t('cluePackUnbind')),
        )
      : createElement(
          'div',
          { className: css.bindingRow },
          createElement(
            'select',
            {
              className: css.select,
              'aria-label': t('cluePackBindingChoose'),
              value: workspaceId,
              onChange: (event: { target: { value: string } }) => { setWorkspaceId(event.target.value) },
            },
            workspaces.map(workspace => createElement(
              'option',
              { key: workspace.workspaceId, value: workspace.workspaceId },
              workspace.title,
            )),
          ),
          createElement('button', {
            type: 'button',
            className: css.action,
            disabled: busy || workspaces.length === 0,
            onClick: () => { void mutate('add') },
          }, t('cluePackBind')),
        ),
    failure === null
      ? null
      : createElement('div', { className: css.bindingFailure, role: 'alert' }, failure),
  )
}

/** Mutable draft flag shared with the window's close guard. */
interface DetailGuard {
  dirty: boolean
}

/**
 * Detail windows this module has already loaded, keyed by window id. The host
 * returns the SAME `WindowHandle` for an already-open id (it focuses the live
 * instance instead of replacing it), so handle identity tells us whether this
 * call created a window that still needs its first load. Calling `loadInto`
 * on an existing window would overwrite the reader's unsaved draft.
 */
const loadedDetailWindows = new Map<string, WindowHandle>()

/** Load one resource into an already-open window. */
async function loadInto(
  handle: WindowHandle,
  options: ClueDetailWindowOptions,
  guard: DetailGuard,
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
  const url = sourceUrlOf(target.locator)
  const editable = await editableOf(face, target)
  const retry = (): void => {
    handle.update({ content: createElement(DetailStatus, { text: t('loading') }) })
    void loadInto(handle, options, guard)
  }

  let state: DetailState
  const readOnlyState = (result: ClueReadResult, error: string | null): DetailState => ({
    format: result.format,
    document: result,
    data: result.data,
    readOnly: true,
    saving: false,
    dirty: false,
    conflict: false,
    error,
  })
  if (editable !== false) {
    try {
      const document = await face.api.loadEdit(workspaceId, resource)
      const locked = lockedReasonOf(document)
      state = {
        format: document.format,
        document,
        data: document.data,
        readOnly: locked !== undefined,
        ...(document.baseRevision === undefined ? {} : { baseRevision: document.baseRevision }),
        saving: false,
        // A load is the saved baseline: an untouched window is closable.
        dirty: false,
        conflict: false,
        // A source may hand back an editable TYPE whose concrete resource is
        // locked (archived repository, read-only permission, oversized body):
        // say why instead of offering a save the source will refuse.
        error: locked === undefined ? null : readOnlyReasonCopy(locked),
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
            onRetry: retry,
          }),
        })
        return
      }
    }
  } else {
    try {
      state = readOnlyState(await face.api.read(workspaceId, resource), t('clueDetailReadOnlyType'))
    } catch (failure) {
      handle.update({
        content: createElement(DetailFailure, {
          message: clueErrorHint(categoryOf(failure)) ?? clueErrorMessage(failure, t('clueDetailFailed')),
          url,
          onRetry: retry,
        }),
      })
      return
    }
  }

  const reload = (): void => {
    handle.update({ content: createElement(DetailStatus, { text: t('loading') }) })
    void loadInto(handle, options, guard)
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
        dirty: false,
        ...(result.revision === undefined ? {} : { baseRevision: result.revision }),
      }
      render()
    } catch (failure) {
      const conflict = categoryOf(failure) === 'conflict'
      state = {
        ...state,
        saving: false,
        // A failed save keeps the draft (and the dirty marker) exactly as it
        // was; only a successful write establishes a new baseline.
        dirty: true,
        conflict,
        // A conflict keeps the draft: the re-read action is the reader's
        // explicit choice, never an automatic overwrite.
        error: conflict ? t('clueDetailConflict') : clueErrorMessage(failure, t('clueDetailFailed')),
      }
      render()
    }
  }

  const detailWorkspaces: readonly ClueWorkspaceChoice[] =
    options.workspaces !== undefined && options.workspaces.length > 0
      ? options.workspaces
      : [{ workspaceId, title: workspaceId }]

  const footerOf = (current: DetailState): ReactNode =>
    createElement(
      'div',
      { className: css.footer },
      target.clueId === undefined
        ? null
        : createElement(ClueBindingPanel, {
            key: `clue-binding:${target.clueId}`,
            face,
            clueId: target.clueId,
            workspaces: detailWorkspaces,
            initialWorkspaceId: workspaceId,
          }),
      createElement(
        'div',
        { className: css.footerActions },
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
        url === undefined
          ? null
          : createElement('a', {
              className: css.action,
              href: url,
              target: '_blank',
              rel: 'noreferrer',
            }, t('clueDetailOpenSource')),
        current.readOnly || !guard.dirty
          ? null
          : createElement(
              'button',
              {
                type: 'button',
                className: css.action,
                onClick: () => {
                  // Explicit discard: the ONLY path that drops the draft.
                  guard.dirty = false
                  handle.update({ dirty: false })
                  void handle.close()
                },
              },
              t('clueDetailDiscard'),
            ),
      ),
    )

  function render(): void {
    const current = state
    guard.dirty = !current.readOnly && current.dirty
    handle.update({
      content: descriptorOf(target, current, {
        onChange: (data) => {
          state = { ...state, data, dirty: true }
          render()
        },
        ...(current.readOnly ? {} : { onSave: () => { void save() } }),
      }),
      dirty: !current.readOnly && current.dirty,
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
  const id = clueDetailWindowId(target)
  const guard: DetailGuard = { dirty: false }
  const previous = loadedDetailWindows.get(id)
  const handle = windows.open({
    id,
    title: target.title,
    size: 'document',
    content: createElement(DetailStatus, { text: t('loading') }),
    onBeforeClose: () => {
      if (!guard.dirty) return true
      // Keep the window (and the draft) and say why: the reader chooses
      // "discard" in the footer or saves first.
      handle.update({ content: createElement(DetailStatus, { text: t('clueDetailUnsaved') }) })
      return false
    },
    onClose: () => { loadedDetailWindows.delete(id) },
  })
  if (previous !== undefined && previous === handle) {
    // `open` returned the EXISTING instance (the host focuses it): touching
    // its content here would replace an unsaved draft. Focus only.
    handle.focus()
    return handle
  }
  loadedDetailWindows.set(id, handle)
  void loadInto(handle, options, guard)
  return handle
}
