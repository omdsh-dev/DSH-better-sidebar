/**
 * The clue detail window (S9).
 *
 * One resource, hosted by S6's unified window. The source owns the structured
 * document; the format renderer its plugin registered owns the pixels; this
 * module owns the load/save lifecycle and the explicit failure states.
 *
 * Reading and editing are SEPARATE paths:
 * - opening renders the cached/read document first (`clues.read`) and never
 *   calls `clues.loadEdit`; the Edit tab is a lazy request;
 * - `clues.loadEdit` runs only when the reader chooses Edit, and its document
 *   is the ONLY save baseline (a read preview is never saved over);
 * - every mode switch is controlled here (`mode` / `onModeChange`), so a saved
 *   draft or a dirty preview can never silently fall back to a stale read;
 * - Refresh is a non-destructive toolbar action: it keeps the current content
 *   and invalidates exactly this resource's cached read before re-reading;
 * - the header (`ResourceSummary`) renders the source-owned metadata snapshot
 *   independent of the body, and the source renderer omits its duplicate
 *   title/source chrome when embedded.
 *
 * Editing rules (approved S9 spec):
 * - `clues.saveEdit` is the ONLY write path (the renderer never writes);
 * - read-only types / missing permission show the reason plus the credential-
 *   free original-source entry when the locator carries one;
 * - INSERT and SAVE are separate actions: the footer's insert action puts a
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
import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { IconRefreshOutlineRegular, IconRightUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { ActionButton, IconButton } from '../../ui/kit.tsx'
import { Disclosure, ErrorBlock } from '../../ui/patterns.tsx'
import type { WindowDocumentContent, WindowHandle } from '../../windows/types.ts'
import type { BetterSidebarWindowsClientFace } from '../../windows/types.ts'
import type {
  ClueBinding,
  ClueCommentCapabilities,
  ClueCommentCreateResult,
  ClueDiscussionPage,
  ClueEditDocument,
  ClueReadResult,
  ClueTypeDescriptor,
  JsonValue,
  Locator,
} from '../../../clues/types.ts'
import {
  FEISHU_FORMATS,
  parseTaskDocument,
  type FeishuTaskTime,
} from '../../../clues/sources/feishu/format.ts'
import { cluesApi, isSameClueResource, type ClueClientResourceInput, type ClueDataChange } from '../api.ts'
import * as clueApiModule from '../api.ts'
import type { ClueWorkspaceChoice } from '../workspace-id.ts'
import type { BetterSidebarCluesClientFace } from '../registry.ts'
import { categoryOf, clueErrorMessage, clueErrorHint } from '../copy.ts'
import { preferredClueWindowSurface, type ClueWindowSurface } from '../../prefs.ts'
import { t } from '../../locales.ts'
import { supportsWindowEditing } from '../../windows/format-content.tsx'
import { SelectMenu } from '../../ui/SelectMenu.tsx'
import { LoadingIndicator } from '../../ui/LoadingIndicator.tsx'
import {
  ResourceSummary,
  formatResourceTime,
  mergeResourceInfo,
  type ClueResourceInfo,
  type ClueResourceTime,
} from '../resource-summary.tsx'
import { ClueError } from '../../../clues/error.ts'
import { ResourceDiscussion } from './comments.tsx'
import { ResourceSelectionActions, type ClueSelectionActionTarget } from '../selection-actions.tsx'
import { BUILTIN_SOURCE_IDS } from '../../../clues/types.ts'
import css from './detail.module.css'

/**
 * One data-change event of the shared clue cache: a library write (a save or
 * ensure changed the workspace) or an actual authorization boundary (the
 * account/credentials behind a source changed). The cache branch exports the
 * listener and notifier; this module resolves them lazily until integration.
 */
export type ClueDetailDataChange = ClueDataChange

export type ClueDetailDataChangeListener = (change: ClueDetailDataChange) => void

/**
 * The synchronous read-cache seam the cache branch exposes from
 * `client/clues/api.ts` (`peekClueRead` / `invalidateClueRead` /
 * `subscribeClueDataChanges`). The module is resolved lazily so this branch
 * compiles before that integration lands; once it lands the lookups resolve to
 * the shared cache with no call-site change.
 */
export interface ClueDetailReadCache {
  peek(workspaceId: string, input: ClueClientResourceInput): ClueReadResult | undefined
  invalidate(workspaceId: string, input: ClueClientResourceInput): void
  /** Production shared-cache subscription; tests may inject a fake listener. */
  subscribe?(listener: ClueDetailDataChangeListener): () => void
}

interface ClueCacheModule {
  peekClueRead?(workspaceId: string, input: ClueClientResourceInput): ClueReadResult | undefined
  invalidateClueRead?(workspaceId: string, input: ClueClientResourceInput): void
  subscribeClueDataChanges?(listener: ClueDetailDataChangeListener): () => void
}

const cacheModule = clueApiModule as unknown as ClueCacheModule

const defaultReadCache: ClueDetailReadCache = {
  peek: (workspaceId, input) => cacheModule.peekClueRead?.(workspaceId, input),
  invalidate: (workspaceId, input) => { cacheModule.invalidateClueRead?.(workspaceId, input) },
  subscribe: listener => cacheModule.subscribeClueDataChanges?.(listener) ?? (() => undefined),
}

/** Injected fakes never share the real cache: peeking would cross-contaminate. */
const noReadCache: ClueDetailReadCache = {
  peek: () => undefined,
  invalidate: () => undefined,
}

/** One clue resource address the browser can open. */
export interface ClueDetailTarget {
  readonly sourceId: string
  readonly typeId: string
  /** The persisted stable id, when the row already is a clue. */
  readonly clueId?: string
  readonly locator?: Locator
  readonly title: string
  /** Source/UI subtitle snapshot; persisted through `ensure`. */
  readonly subtitle?: string
  /** Source-owned display metadata already known by the opening row. */
  readonly info?: ClueResourceInfo
}

/** Options of {@link openClueDetailWindow}. */
interface ClueDetailWindowOptions {
  readonly windows: BetterSidebarWindowsClientFace
  readonly face: BetterSidebarCluesClientFace
  readonly workspaceId: string
  readonly target: ClueDetailTarget
  readonly sessionId?: string
  readonly surface?: ClueWindowSurface
  /** Explicit workspaces the binding panel can offer (never guessed). */
  readonly workspaces?: readonly ClueWorkspaceChoice[]
  /** Test/integration seam for the shared synchronous read cache. */
  readonly readCache?: ClueDetailReadCache
  /** Insert one stable clue id into the draft (the footer's insert action). */
  onInsertClue?(clueId: string, title: string): boolean
  /**
   * Add this resource to a clue pack. The tab supplies this by reusing its
   * browser collection window (selection + one explicit CAS write); the detail
   * window never grows a second write path.
   */
  onAddToPack?(target: ClueDetailTarget): void
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

/** A credential-free http(s) URL, or undefined (never a fabricated href). */
function httpUrlOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const parsed = new URL(value)
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === ''
      && parsed.password === '') {
      return parsed.href
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * A source-body URL (Feishu docs `sourceUrl`, task `url`) for locators that
 * do not carry one. It only feeds the credential-free "open source" link.
 */
function sourceUrlFromData(data: JsonValue | undefined): string | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>
  return httpUrlOf(record.sourceUrl) ?? httpUrlOf(record.url)
}

/**
 * The source-owned display title of a read/edit document. The window title is
 * the ONE visible title (embedded renderers hide their duplicate heading), so
 * a direct-URL target like `owner/repo#42` must adopt the real title once the
 * source returns it. Empty/absent values never erase the current title.
 */
function sourceTitleOf(data: JsonValue | undefined): string | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const title = (data as Record<string, unknown>).title
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
}

/** The localized explanation of a source-owned read-only marker. */
function readOnlyReasonCopy(reason: string | undefined): string {
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

/** The loading body. */
function DetailStatus(props: { readonly text: string }): ReactNode {
  return createElement('div', { className: css.status }, createElement(LoadingIndicator, { label: props.text }))
}

/** One explicit failure that could not even produce a preview. */
function DetailFailure(props: {
  readonly message: string
  readonly url: string | undefined
  onRetry?(): void
}): ReactNode {
  return createElement(
    'div',
    { className: css.failure },
    createElement(ErrorBlock, {
      message: t('clueDetailFailed'),
      detail: props.message,
      ...(props.onRetry === undefined ? {} : { retryLabel: t('retry'), onRetry: props.onRetry }),
    }),
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

/**
 * Whether the catalogue marks this source/type editable.
 * `undefined` means the catalogue could not be read: the caller still tries
 * the edit document and falls back to a preview if the source refuses.
 */
async function editableOf(
  face: BetterSidebarCluesClientFace,
  target: ClueDetailTarget,
): Promise<{ editable: boolean | undefined; comments?: ClueCommentCapabilities }> {
  try {
    const catalogue = await face.api.sources()
    const source = catalogue.sources.find(candidate => candidate.sourceId === target.sourceId)
    const type: ClueTypeDescriptor | undefined =
      catalogue.types.find(candidate => candidate.typeId === target.typeId)
    return { editable: source?.capabilities.edit === true && type?.capabilities.edit === true,
      ...(source?.capabilities.comments === undefined ? {} : { comments: source.capabilities.comments }) }
  } catch {
    return { editable: undefined }
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

/** Normalize one source instant (epoch-millis string or ISO) to ISO. */
function instantInfoOf(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  const millis = Number(value)
  if (Number.isFinite(millis)) return new Date(millis).toISOString()
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
}

/** One task instant as the shared display shape. */
function taskTimeInfo(time: FeishuTaskTime | null): ClueResourceTime | undefined {
  if (time === null) return undefined
  const millis = Number(time.timestamp)
  if (!Number.isFinite(millis)) return undefined
  return {
    at: new Date(millis).toISOString(),
    ...(time.isAllDay ? { allDay: true } : {}),
  }
}

/**
 * Fill metadata gaps from the source-owned task body (the read/edit payload is
 * authoritative for completion even when a list row had no snapshot yet), and
 * patch the normalized completion fields after a successful save.
 */
export function deriveTaskInfo(
  format: string,
  data: JsonValue,
  base: ClueResourceInfo | undefined,
  mode: 'fill' | 'saved' = 'fill',
  savedAt?: string,
): ClueResourceInfo | undefined {
  if (format !== FEISHU_FORMATS.taskDocument) return base
  const task = parseTaskDocument(data)
  if (task === undefined) return base
  // The task body is the authoritative date projection: a null start/due must
  // CLEAR an older target/list snapshot, and a changed body value must win
  // over it. Drop the old date fields before spreading the remaining metadata
  // (author/labels/counts) so stale values cannot survive the omission.
  const { start: _previousStart, due: _previousDue, completedAt: _previousCompletedAt, ...rest } = base ?? {}
  const start = taskTimeInfo(task.start)
  const due = taskTimeInfo(task.due)
  const bodyCompletedAt = instantInfoOf(task.completedAt)
  const knownCompletedAt = base?.state === 'completed' ? base.completedAt : undefined
  // Reopening clears the completion instant; an already-completed task keeps
  // the provider's actual instant instead of rewriting it on every save.
  const completedAt = task.completed
    ? (bodyCompletedAt
        ?? (mode === 'saved'
          ? (knownCompletedAt ?? savedAt ?? new Date().toISOString())
          : knownCompletedAt))
    : undefined
  return {
    ...rest,
    state: task.completed ? 'completed' : 'active',
    ...(start === undefined ? {} : { start }),
    ...(due === undefined ? {} : { due }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(base?.updatedAt === undefined && mode === 'saved' && savedAt !== undefined
      ? { updatedAt: savedAt }
      : {}),
  }
}

/** The full metadata snapshot of one document result (task body fills gaps). */
function infoOf(
  format: string,
  data: JsonValue,
  ...sources: ReadonlyArray<ClueResourceInfo | undefined>
): ClueResourceInfo | undefined {
  return deriveTaskInfo(format, data, mergeResourceInfo(...sources))
}

/** Source-attached display snapshot (public type lands with the backend branch). */
function attachedInfo(value: object): ClueResourceInfo | undefined {
  return (value as { readonly info?: ClueResourceInfo }).info
}

/** Mutable draft flag shared with the window's close guard. */
interface DetailGuard {
  dirty: boolean
  saving: boolean
  reportBlocked?(): void
}

/** The edit document this window has loaded; the read preview is never a baseline. */
interface EditState {
  readonly format: string
  readonly document: ClueEditDocument
  readonly data: JsonValue
  readonly baseRevision?: string
  /** The loaded data serialized: `dirty` means "actually changed by the reader". */
  readonly baseline: string
  readonly supported: boolean
  readonly locked?: string
  readonly dirty: boolean
  readonly saving: boolean
}

/** The live state of one detail window. */
interface DetailState {
  readonly mode: 'preview' | 'edit'
  readonly read: ClueReadResult | null
  readonly edit: EditState | null
  readonly info?: ClueResourceInfo
  readonly editable: boolean | undefined
  readonly readLoading: boolean
  readonly refreshing: boolean
  readonly editLoading: boolean
  readonly error: string | null
  readonly conflict: boolean
  readonly saved: boolean
  /** An auth boundary blocked writes until a fresh source base is loaded. */
  readonly authBlocked: boolean
  readonly closeWarning: boolean
  /** A successful save invalidated the read: don't show it as the preview. */
  readonly readStale: boolean
  readonly failure: { readonly message: string; readonly url?: string } | null
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
      // Reading the bindings is part of the binding surface, not a pack save:
      // say so instead of borrowing the pack's failure copy.
      setFailure(clueErrorMessage(error, t('clueBindingFailed')))
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
      // Bindings are workspace-scoped: a clue stored in workspace A cannot be
      // bound in workspace B until it exists there. Name that next step
      // instead of surfacing a generic (and misleading) save failure.
      setFailure(change === 'add' && categoryOf(error) === 'not-found'
        ? t('clueBindingNotInWorkspace')
        : clueErrorMessage(error, t('clueBindingFailed')))
    } finally {
      setBusy(false)
    }
  }

  const bound = bindings.length > 0
  return createElement(
    'section',
    { className: css.binding, 'data-clue-binding-panel': 'clue' },
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
          createElement(SelectMenu, {
             className: css.select,
             ariaLabel: t('cluePackBindingChoose'),
             value: workspaceId, disabled: busy,
             options: workspaces.map(workspace => ({ value: workspace.workspaceId, label: workspace.title })),
             onChange: setWorkspaceId,
           }),
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

/** Format registration can disappear while a detail remains open. */
function LiveDetailFooter(props: {
  face: BetterSidebarCluesClientFace
  format: string
  data: JsonValue
  render(editable: boolean): ReactNode
}): ReactNode {
  const { face, format, data } = props
  const subscribe = useCallback((listener: () => void) => face.subscribe(listener), [face])
  const getSnapshot = useCallback(() => supportsWindowEditing(face, format, data), [face, format, data])
  const editable = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return props.render(editable)
}

/**
 * Detail windows this module has already loaded, keyed by window id. The host
 * returns the SAME `WindowHandle` for an already-open id (it focuses the live
 * instance instead of replacing it), so handle identity tells us whether this
 * call created a window that still needs its first load. Calling `loadInto`
 * on an existing window would overwrite the reader's unsaved draft.
 */
const loadedDetailWindows = new Map<string, WindowHandle>()

/** The controller of one freshly opened detail window. */
interface DetailController {
  readonly initialContent: WindowDocumentContent | ReactNode
  /** The hot-cache source title, adopted before the first paint. */
  readonly initialTitle: string
  attach(handle: WindowHandle, guard: DetailGuard): void
  /** Release the shared-cache listener and abort in-flight source calls. */
  dispose(): void
}

/** Build the state machine of one detail window. */
function createDetailController(options: ClueDetailWindowOptions): DetailController {
  const { face, workspaceId, target } = options
  const readCache = options.readCache ?? (face.api === cluesApi ? defaultReadCache : noReadCache)
  const resource = resourceOf(options)
  const bodyResource = { ...resource, includeDiscussion: false as const }
  // A window keeps the session captured when it opened; never borrow the
  // active composer/session later when the reader selects its retained body.
  const selectionTarget: ClueSelectionActionTarget | undefined = options.sessionId === undefined || options.sessionId === ''
    ? undefined
    : { workspaceId, sessionId: options.sessionId, resource }
  // Optional methods keep existing third-party API fakes body-only.
  const discussionApi = face.api as typeof face.api & {
    commentsList?(workspaceId: string, input: ClueClientResourceInput & { cursor?: string; parentId?: string }, signal?: AbortSignal): Promise<ClueDiscussionPage>
    commentsCreate?(workspaceId: string, input: ClueClientResourceInput & { body: string; replyToId?: string; requestId: string }, signal?: AbortSignal): Promise<ClueCommentCreateResult>
  }
  let commentsCapabilities: ClueCommentCapabilities | undefined
  let discussion: ClueDiscussionPage | undefined
  let commentsLoading = false
  let commentCreating = false
  let commentsError: string | undefined
  let commentsRetry: { cursor?: string; parentId?: string } = {}
  let commentsAbort: AbortController | undefined
  let commentsSequence = 0
  let referenceBusy = false
  let bodyMoreLoading = false
  let bodyMoreError: string | undefined
  let bodyMoreAbort: AbortController | undefined
  const commentCursors = new Set<string>()
  const cache = readCache
  const initialRead = cache.peek(workspaceId, bodyResource) ?? cache.peek(workspaceId, resource)
  const initialTitle = sourceTitleOf(initialRead?.data) ?? target.title
  let sourceUrl = sourceUrlOf(target.locator)
    ?? (initialRead === undefined ? undefined : sourceUrlFromData(initialRead.data))
  let currentTitle = initialTitle
  let handle: WindowHandle | undefined
  let guard: DetailGuard = { dirty: false, saving: false }
  let readSequence = 0
  let editSequence = 0
  let started = false
  let disposed = false
  /** Remount the binding panel after a save/library event so it re-reads CAS. */
  let bindingsRevision = 0
  let readAbort: AbortController | undefined
  let editAbort: AbortController | undefined
  let unsubscribeChanges: (() => void) | undefined
  /** Bumped on every auth boundary; a late save result may not be adopted. */
  let authGeneration = 0

  let state: DetailState = {
    mode: 'preview',
    read: initialRead ?? null,
    edit: null,
    info: infoOf(
      initialRead?.format ?? '',
      initialRead?.data ?? null,
      target.info,
      initialRead === undefined ? undefined : attachedInfo(initialRead),
    ),
    editable: undefined,
    readLoading: initialRead === undefined,
    refreshing: false,
    editLoading: false,
    error: null,
    conflict: false,
    saved: false,
    authBlocked: false,
    closeWarning: false,
    readStale: false,
    failure: null,
  }

  /** The document a preview should show: a dirty/saved draft wins over a stale read. */
  function previewSource(): { format: string; document: ClueReadResult | ClueEditDocument } | undefined {
    const edit = state.edit
    if (edit !== null && (edit.dirty || state.readStale || state.read === null)) {
      return { format: edit.format, document: { ...edit.document, data: edit.data } }
    }
    if (state.read !== null) return { format: state.read.format, document: state.read }
    if (edit !== null) return { format: edit.format, document: { ...edit.document, data: edit.data } }
    return undefined
  }

  /** The source currently on screen (edit draft or preview). */
  function activeSource(): {
    format: string
    document: ClueReadResult | ClueEditDocument
    readOnly: boolean
  } | undefined {
    if (state.mode === 'edit' && state.edit !== null) {
      return {
        format: state.edit.format,
        document: { ...state.edit.document, data: state.edit.data },
        readOnly: false,
      }
    }
    const source = previewSource()
    return source === undefined ? undefined : { ...source, readOnly: true }
  }

  /** Whether this source can offer the Edit tab at all. */
  function canOfferEdit(): boolean {
    if (state.editable === false || state.failure !== null || state.edit?.locked !== undefined) return false
    const source = state.mode === 'edit' && state.edit !== null ? activeSource() : previewSource()
    if (source === undefined) return false
    return supportsWindowEditing(face, source.format, source.document.data)
  }

  /** One task body completion patch after save (other formats keep the snapshot). */
  function savedInfo(
    format: string,
    data: JsonValue,
    savedAt: string,
    authoritative?: ClueResourceInfo,
  ): ClueResourceInfo | undefined {
    return deriveTaskInfo(
      format,
      data,
      mergeResourceInfo(
        state.info,
        state.edit === null ? undefined : attachedInfo(state.edit.document),
        authoritative,
      ),
      'saved',
      savedAt,
    )
  }

  function headerNode(): ReactNode {
    // Always render the seat: a source that reports no metadata still keeps
    // Refresh and the original-source link inside the header.
    return createElement(ResourceSummary, { info: state.info, actions: headerActions() })
  }

  function failureContent(): ReactNode {
    const failure = state.failure
    if (failure === null) return null
    const header = headerNode()
    return createElement(
      'div',
      { className: css.view, 'data-clue-detail-view': 'failure' },
      header ?? null,
      createElement(DetailFailure, {
        message: failure.message,
        url: failure.url,
        onRetry: () => { void loadRead({ force: true }) },
      }),
    )
  }

  function pendingContent(): ReactNode {
    const header = headerNode()
    return createElement(
      'div',
      { className: css.view, 'data-clue-detail-view': 'pending' },
      header ?? null,
      createElement(DetailStatus, { text: t('loading') }),
    )
  }

  /** The window content of the current state (document descriptor or a plain status node). */
  function content(): WindowDocumentContent | ReactNode {
    if (state.failure !== null) return failureContent()
    const source = activeSource()
    if (source === undefined) return pendingContent()
    const offerEdit = canOfferEdit()
    const editing = offerEdit && state.mode === 'edit' && state.edit !== null
    const descriptor: WindowDocumentContent = {
      kind: 'document',
      sourceId: target.sourceId,
      typeId: target.typeId,
      format: source.format,
      document: source.document,
      readOnly: source.readOnly,
      presentation: 'modes',
      embedded: true,
      header: headerNode(),
      afterBody: afterBody(),
      ...(selectionTarget === undefined ? {} : {
        bodyWrapper: (body: ReactNode) => createElement(ResourceSelectionActions, selectionTarget, body),
      }),
      ...(offerEdit
        ? {
            mode: state.mode,
            onModeChange: (next: 'preview' | 'edit') => { changeMode(next) },
            editLoading: state.mode === 'edit' && state.editLoading,
          }
        : { mode: 'preview' as const }),
      saving: state.edit?.saving === true,
      saved: state.saved && state.edit?.dirty !== true,
      ...(state.error === null && !state.closeWarning ? {} : { error: errorCopy() }),
      onChange: (data: JsonValue) => { applyEdit(data) },
      // The host receives the save callback for its embedded Ctrl/Cmd+Enter
      // handler; the format host does NOT forward it to the renderer when
      // `embedded` is true, so the footer remains the only Save control.
      ...(!editing || !state.edit?.dirty ? {} : { onSave: () => { void save() } }),
    }
    return descriptor
  }

  /** Body continuation and discussion are outside the body-only outline scope. */
  function afterBody(): ReactNode {
    return createElement('div', { 'data-clue-detail-after-body': '', 'data-md-toc-exclude': '' },
      state.mode === 'preview' && state.read?.nextOffset !== undefined
        ? createElement('div', { className: css.continuation },
            bodyMoreError === undefined ? null : createElement('div', { role: 'alert' }, bodyMoreError),
            createElement('button', { type: 'button', className: css.action, disabled: bodyMoreLoading || state.refreshing,
              'data-clue-body-more': '', onClick: () => { void loadBodyMore() } }, bodyMoreLoading ? t('loading') : t('clueDiscussionReadMore' as import('../../locales.ts').CopyKey)))
        : null,
      commentsCapabilities?.read !== true || discussionApi.commentsList === undefined
        ? null
        : createElement(ResourceDiscussion, {
            key: `discussion:${authGeneration}`,
            page: discussion, capabilities: { ...commentsCapabilities, create: commentsCapabilities.create && discussionApi.commentsCreate !== undefined }, loading: commentsLoading,
            ...(commentsError === undefined ? {} : { error: commentsError }),
            readOnly: state.read?.freshness === 'snapshot',
            ...(selectionTarget === undefined ? {} : { selectionTarget }),
            onLoad: (cursor?: string, parentId?: string) => {
              const next = cursor === undefined && commentsError !== undefined ? commentsRetry : { cursor, parentId }
              void loadComments(next.cursor, next.parentId)
            },
            onCreate: createComment,
          }))
  }

  async function loadComments(cursor?: string, parentId?: string): Promise<void> {
    if (disposed || commentCreating || commentsCapabilities?.read !== true || discussionApi.commentsList === undefined || commentsLoading) return
    const token = ++commentsSequence
    commentsAbort?.abort()
    const controller = new AbortController()
    commentsAbort = controller
    commentsLoading = true
    commentsError = undefined
    commentsRetry = { ...(cursor === undefined ? {} : { cursor }), ...(parentId === undefined ? {} : { parentId }) }
    render()
    try {
      const page = await discussionApi.commentsList(workspaceId, { ...resource,
        ...(cursor === undefined ? {} : { cursor }), ...(parentId === undefined ? {} : { parentId }) }, controller.signal)
      if (controller.signal.aborted || token !== commentsSequence) return
      if (page.status !== 'ok') {
        if (discussion === undefined) discussion = page
        commentsError = page.error?.message ?? t('clueDiscussionUnavailable' as import('../../locales.ts').CopyKey)
        return
      }
      const cursorKey = (value: string): string => `${parentId ?? ''}\u0000${value}`
      const consumed = cursor === undefined ? new Set<string>() : new Set(commentCursors)
      if (cursor !== undefined) consumed.add(cursorKey(cursor))
      if (page.nextCursor !== undefined && consumed.has(cursorKey(page.nextCursor))) throw new ClueError('failed', t('clueDiscussionCursorError' as import('../../locales.ts').CopyKey))
      const items = new Map((cursor === undefined ? [] : discussion?.items ?? []).map(item => [item.id, item]))
      for (const item of page.items) items.set(item.id, item)
      if (parentId !== undefined) {
        const parent = items.get(parentId)
        if (parent !== undefined) items.set(parentId, { ...parent, nextRepliesCursor: page.nextCursor })
        discussion = { ...(discussion ?? page), items: [...items.values()], complete: false }
      } else discussion = { ...page, items: [...items.values()] }
      commentCursors.clear()
      for (const value of consumed) commentCursors.add(value)
    } catch (failure) {
      if (!controller.signal.aborted && token === commentsSequence) commentsError = clueErrorMessage(failure, t('error'))
    } finally {
      if (token === commentsSequence) {
        commentsLoading = false
        render()
      }
    }
  }

  async function createComment(body: string, replyToId: string | undefined, requestId: string): Promise<void> {
    if (discussionApi.commentsCreate === undefined || commentsCapabilities?.create !== true
      || (replyToId !== undefined && commentsCapabilities.reply === 'none') || state.read?.freshness === 'snapshot') {
      throw new ClueError('auth-required', t('clueStateNotAuthorized'))
    }
    const generation = authGeneration
    // Feishu document reply IDs address child entries, while its provider
    // write API only accepts the whole-document comment card's root ID.
    // Native task replies and every other source retain the selected ID.
    const providerReplyToId = target.sourceId === BUILTIN_SOURCE_IDS.feishuDocs && commentsCapabilities.reply === 'quote'
      ? discussion?.items.find(comment => comment.id === replyToId)?.replyToId ?? replyToId
      : replyToId
    commentCreating = true
    let result: ClueCommentCreateResult
    try {
      result = await discussionApi.commentsCreate(workspaceId, { ...resource, body, requestId,
        ...(providerReplyToId === undefined ? {} : { replyToId: providerReplyToId }) })
    } finally { if (generation === authGeneration) commentCreating = false }
    if (generation !== authGeneration || disposed) throw new ClueError('auth-required', t('clueStateNotAuthorized'))
    // A pre-write page must never overwrite the newly posted comment.
    commentsSequence += 1
    commentsAbort?.abort()
    commentsLoading = false
    commentsError = undefined
    commentsRetry = {}
    if (discussion !== undefined) {
      const items = new Map(discussion.items.map(item => [item.id, item]))
      const fresh = !items.has(result.comment.id)
      items.set(result.comment.id, result.comment)
      discussion = { ...discussion, items: [...items.values()],
        ...(discussion.total === undefined ? {} : { total: discussion.total + (fresh ? 1 : 0) }) }
      render()
    } else void loadComments()
  }

  /** Never splice byte pages from different revisions or opaque structured bodies. */
  async function loadBodyMore(): Promise<void> {
    const previous = state.read
    const offset = previous?.nextOffset
    if (previous === null || offset === undefined || bodyMoreLoading || state.refreshing) return
    const controller = new AbortController()
    bodyMoreAbort = controller
    bodyMoreLoading = true
    bodyMoreError = undefined
    render()
    try {
      const next = await face.api.read(workspaceId, { ...bodyResource, offset }, controller.signal)
      if (controller.signal.aborted || state.read !== previous) return
      if (previous.revision === undefined || next.revision !== previous.revision || next.format !== previous.format) {
        throw new ClueError('failed', t('clueBodyVersionChanged' as import('../../locales.ts').CopyKey))
      }
      if (next.nextOffset !== undefined && next.nextOffset <= offset) throw new ClueError('failed', t('clueDiscussionCursorError' as import('../../locales.ts').CopyKey))
      let data: JsonValue
      if (typeof previous.data === 'string' && typeof next.data === 'string') data = previous.data + next.data
      else if (previous.data !== null && next.data !== null && typeof previous.data === 'object' && typeof next.data === 'object'
        && !Array.isArray(previous.data) && !Array.isArray(next.data)) {
        const key = typeof previous.data.text === 'string' && typeof next.data.text === 'string' ? 'text'
          : typeof previous.data.content === 'string' && typeof next.data.content === 'string' ? 'content' : undefined
        if (key === undefined) throw new ClueError('failed', t('clueBodyContinuationUnsupported' as import('../../locales.ts').CopyKey))
        data = { ...previous.data, [key]: String(previous.data[key]) + String(next.data[key]) }
      } else throw new ClueError('failed', t('clueBodyContinuationUnsupported' as import('../../locales.ts').CopyKey))
      state = { ...state, read: { ...next, data,
        ...(previous.text === undefined || next.text === undefined ? {} : { text: previous.text + next.text }) } }
    } catch (failure) {
      if (!controller.signal.aborted) bodyMoreError = clueErrorMessage(failure, t('error'))
    } finally {
      if (bodyMoreAbort === controller) { bodyMoreLoading = false; render() }
    }
  }

  function errorCopy(): string {
    return [
      state.error,
      state.closeWarning ? t(state.edit?.saving === true ? 'windowSaving' : 'clueDetailUnsaved') : null,
    ].filter((value): value is string => value !== null && value !== '').join('\n')
  }

  /**
   * The header's action seat: Refresh and the original-source link.
   *
   * These used to own a toolbar band of its own under the title bar, with the
   * cache age as a third always-visible element. That band cost a full row of
   * chrome above a two-line header; the age now rides the Refresh tooltip and
   * the two controls sit at the end of the metadata block.
   */
  function headerActions(): ReactNode {
    const disabled = guard.dirty || state.edit?.saving === true || state.editLoading
      || state.refreshing || state.readLoading
    const cached = state.read === null ? undefined : state.read.fetchedAt
    return createElement(
      'div',
      { className: css.headerActions, 'data-clue-detail-toolbar': '' },
      createElement(IconButton, {
        size: 'sm',
        icon: state.refreshing
          ? createElement(LoadingIndicator, { inline: true, size: 14, label: t('clueResourceRefreshing') })
          : createElement(IconRefreshOutlineRegular, { size: 14 }),
        'data-clue-detail-refresh': '',
        ...(cached === undefined ? {} : { 'data-clue-detail-cached': cached }),
        'aria-busy': state.refreshing,
        disabled,
        label: t('refresh'),
        title: cached === undefined
          ? t('refresh')
          : t('clueResourceCached') + ' ' + formatResourceTime(cached),
        onClick: () => { refresh() },
      }),
      sourceUrl === undefined
        ? null
        : createElement('a', {
            className: css.sourceLink,
            'data-clue-detail-source': '',
            href: sourceUrl,
            target: '_blank',
            rel: 'noreferrer',
          }, createElement(IconRightUpOutlineRegular, { size: 12 }), t('clueDetailOpenSource')),
    )
  }

  function footer(): ReactNode {
    const currentEdit = state.edit
    const currentFormat = currentEdit?.format ?? previewSource()?.format ?? ''
    const currentData = currentEdit?.data ?? state.read?.data ?? null
    const detailWorkspaces: readonly ClueWorkspaceChoice[] =
      options.workspaces !== undefined && options.workspaces.length > 0
        ? options.workspaces
        : [{ workspaceId, title: workspaceId }]
    return createElement(LiveDetailFooter, {
      face,
      format: currentFormat,
      data: currentData,
      render: formatEditable => createElement(
        'div',
        { className: css.footer, 'data-clue-detail-footer': '', 'aria-busy': referenceBusy || currentEdit?.saving === true },
        target.clueId === undefined
          ? null
          : createElement(Disclosure, {
              className: css.bindingDetails,
              summary: t('cluePackBindingHeading'),
              'data-clue-detail-advanced': '',
              'data-clue-binding-revision': String(bindingsRevision),
            },
              createElement(ClueBindingPanel, {
                key: `clue-binding:${target.clueId}:${bindingsRevision}`,
                face,
                clueId: target.clueId,
                workspaces: detailWorkspaces,
                initialWorkspaceId: workspaceId,
              })),
        createElement(
          'div',
          { className: css.footerActions, role: 'group', 'aria-label': t('clueDetailActions' as import('../../locales.ts').CopyKey) },
          !guard.dirty
            ? null
            : createElement(
                ActionButton,
                {
                  size: 'sm',
                  disabled: currentEdit?.saving === true,
                  onClick: () => {
                    // Explicit discard: the ONLY path that drops the draft.
                    guard.dirty = false
                    handle?.update({ dirty: false })
                    void handle?.close()
                  },
                },
                t('clueDetailDiscard'),
              ),
          currentEdit !== null && (state.conflict || state.authBlocked)
            ? createElement(
                ActionButton,
                { size: 'sm', 'data-clue-detail-reread': '', onClick: () => { void reloadEdit() } },
                t('clueDetailReload'),
              )
            : null,
          // Every source/format saves through this ONE stable footer action;
          // embedded renderers never receive `onSave`/draw their own button.
          // An auth boundary blocks writes until a fresh base is re-read.
          currentEdit === null || !currentEdit.dirty || !formatEditable || !canOfferEdit()
          || state.authBlocked
            ? null
            : createElement(
                ActionButton,
                {
                  size: 'sm',
                  variant: 'primary',
                  'data-clue-detail-save': '',
                  disabled: currentEdit.saving || !formatEditable,
                  onClick: () => { void save() },
                },
                currentEdit.saving
                  ? createElement(LoadingIndicator, { inline: true, size: 12, label: t('windowSaving') })
                  : t('save'),
              ),
          options.onAddToPack === undefined
            ? null
            : createElement(
                ActionButton,
                {
                  size: 'sm',
                  'data-clue-detail-add-to-pack': '',
                  disabled: referenceBusy || (target.clueId === undefined && state.read === null),
                  onClick: () => {
                    // Never build a collection target from a pre-auth/fallback
                    // snapshot; the candidate needs its authoritative read.
                    if (target.clueId === undefined && state.read === null) return
                    // The collection row must see the freshly observed title
                    // and metadata, not the possibly stale opening target.
                    options.onAddToPack?.({
                      ...target,
                      title: currentTitle,
                      ...(state.info === undefined ? {} : { info: state.info }),
                    })
                  },
                },
                t('clueBrowserAddToPack'),
              ),
          options.onInsertClue === undefined
            ? null
            : createElement(
                ActionButton,
                {
                  size: 'sm',
                  variant: currentEdit?.dirty === true && formatEditable ? 'outline' : 'primary',
                  'data-clue-detail-insert': '',
                  disabled: referenceBusy || (target.clueId === undefined && state.read === null),
                  onClick: () => { void insertReference() },
                },
                t('clueBrowserInsert'),
              ),
        ),
      ),
    })
  }

  function render(): void {
    if (handle === undefined) return
    const dirty = state.edit?.dirty === true
    const saving = state.edit?.saving === true
    guard.dirty = dirty
    guard.saving = saving
    handle.update({
      title: currentTitle,
      content: content(),
      dirty,
      saving,
    })
    handle.update({ footer: footer() })
  }

  /** One read; `force` is the explicit Refresh/retry path. */
  async function loadRead(input: { force?: boolean; silent?: boolean } = {}): Promise<void> {
    bodyMoreAbort?.abort()
    bodyMoreLoading = false
    bodyMoreError = undefined
    if (input.force === true && face.api.readRefresh === undefined) cache.invalidate(workspaceId, bodyResource)
    const token = ++readSequence
    readAbort?.abort()
    const controller = new AbortController()
    readAbort = controller
    const hadRead = state.read !== null
    if (input.force === true) state = { ...state, refreshing: true }
    else if (!hadRead) state = { ...state, readLoading: true }
    render()
    try {
      const result = input.force === true && face.api.readRefresh !== undefined
        ? await face.api.readRefresh(workspaceId, bodyResource, controller.signal)
        : await face.api.read(workspaceId, bodyResource, controller.signal)
      if (token !== readSequence || controller.signal.aborted) return
      const readTitle = sourceTitleOf(result.data)
      // Refresh/open reads may land after the reader started typing: the
      // shared title follows the source only when there is no unsaved draft.
      if (readTitle !== undefined && state.edit?.dirty !== true) currentTitle = readTitle
      sourceUrl = sourceUrl ?? sourceUrlFromData(result.data)
      state = {
        ...state,
        read: result,
        info: infoOf(result.format, result.data, state.info, attachedInfo(result)),
        readLoading: false,
        refreshing: false,
        readStale: false,
        authBlocked: false,
        failure: null,
        // A non-destructive refresh must not erase an edit/save error.
        ...(state.edit?.dirty === true || state.conflict ? {} : { error: null }),
      }
      render()
    } catch (failure) {
      if (token !== readSequence || controller.signal.aborted) return
      const message = clueErrorHint(categoryOf(failure)) ?? clueErrorMessage(failure, t('clueDetailFailed'))
      if (state.read === null && state.edit === null) {
        state = {
          ...state,
          readLoading: false,
          refreshing: false,
          failure: { message, ...(sourceUrl === undefined ? {} : { url: sourceUrl }) },
        }
      } else {
        // Keep the current body; only say the refresh failed.
        state = { ...state, readLoading: false, refreshing: false, error: message }
      }
      render()
    } finally {
      if (readAbort === controller) readAbort = undefined
    }
  }

  /** The catalogue decides whether Edit is offered at all; a failed read keeps the fallback. */
  async function loadCatalogue(): Promise<void> {
    const generation = authGeneration
    const catalogue = await editableOf(face, target)
    if (generation !== authGeneration || disposed) return
    const editable = catalogue.editable
    commentsCapabilities = catalogue.comments
    if (commentsCapabilities?.read === true && discussionApi.commentsList !== undefined) void loadComments()
    if (editable === false) {
      // Never yank an editor away from a reader who already started one: the
      // source still owns the final refusal on save. The catalogue only
      // decides whether a NEW edit may start.
      if (state.edit !== null) return
      state = {
        ...state,
        editable: false,
        ...(state.error === null ? { error: t('clueDetailReadOnlyType') } : {}),
      }
    } else if (editable === true) {
      state = { ...state, editable: true }
    }
    render()
  }

  /** Lazily fetch the edit document; the ONLY place `loadEdit` is called before a save. */
  async function loadEditDocument(): Promise<void> {
    if (state.editable === false || state.editLoading) return
    const token = ++editSequence
    editAbort?.abort()
    const controller = new AbortController()
    editAbort = controller
    state = {
      ...state,
      mode: 'edit',
      editLoading: true,
      error: null,
      saved: false,
      closeWarning: false,
    }
    render()
    try {
      const document = await face.api.loadEdit(workspaceId, resource, controller.signal)
      if (token !== editSequence || controller.signal.aborted) return
      const locked = lockedReasonOf(document)
      const supported = supportsWindowEditing(face, document.format, document.data)
      const info = infoOf(document.format, document.data, state.info, attachedInfo(document))
      const editTitle = sourceTitleOf(document.data)
      if (editTitle !== undefined) currentTitle = editTitle
      sourceUrl = sourceUrl ?? sourceUrlFromData(document.data)
      if (locked !== undefined || !supported) {
        state = {
          ...state,
          mode: 'preview',
          editLoading: false,
          info,
          // Repeating the same load cannot make an unknown format renderable
          // or an archived resource writable; drop the Edit offer.
          editable: false,
          error: locked === undefined ? t('clueDetailReadOnlyType') : readOnlyReasonCopy(locked),
        }
        render()
        return
      }
      const baseline = JSON.stringify(document.data)
      state = {
        ...state,
        mode: 'edit',
        editLoading: false,
        info,
        error: null,
        conflict: false,
        authBlocked: false,
        edit: {
          format: document.format,
          document,
          data: document.data,
          ...(document.baseRevision === undefined ? {} : { baseRevision: document.baseRevision }),
          baseline,
          supported,
          ...(locked === undefined ? {} : { locked }),
          dirty: false,
          saving: false,
        },
      }
      render()
    } catch (failure) {
      if (token !== editSequence || controller.signal.aborted) return
      state = {
        ...state,
        mode: 'preview',
        editLoading: false,
        error: clueErrorHint(categoryOf(failure)) ?? clueErrorMessage(failure, t('clueDetailFailed')),
      }
      render()
    } finally {
      if (editAbort === controller) editAbort = undefined
    }
  }

  /** Switch preview/edit; Edit is lazy and a preview click cancels an in-flight load. */
  function changeMode(next: 'preview' | 'edit'): void {
    if (next === 'preview') {
      if (state.mode === 'preview' && !state.editLoading) return
      editSequence += 1
      editAbort?.abort()
      editAbort = undefined
      state = { ...state, mode: 'preview', editLoading: false }
      render()
      return
    }
    if (!canOfferEdit() || state.mode === 'edit' || state.editLoading) return
    if (state.edit !== null) {
      state = { ...state, mode: 'edit', error: state.conflict ? state.error : null }
      render()
      return
    }
    void loadEditDocument()
  }

  /** One controlled edit; a read preview can never reach this path. */
  function applyEdit(data: JsonValue): void {
    const edit = state.edit
    if (edit === null || edit.saving || !canOfferEdit()) return
    state = {
      ...state,
      edit: { ...edit, data, dirty: JSON.stringify(data) !== edit.baseline },
      saved: false,
      closeWarning: false,
    }
    render()
  }

  /** Save the edit document through the source's own concurrency baseline. */
  async function save(): Promise<void> {
    const edit = state.edit
    if (edit === null || edit.saving || !edit.dirty || !canOfferEdit()) return
    if (state.authBlocked) return
    if (!supportsWindowEditing(face, edit.format, edit.data)) return
    const submitted = edit.data
    const saveGeneration = authGeneration
    state = {
      ...state,
      edit: { ...edit, saving: true },
      error: null,
      conflict: false,
      closeWarning: false,
      saved: false,
    }
    render()
    try {
      const result = await face.api.saveEdit(workspaceId, {
        ...resource,
        document: {
          format: edit.format,
          data: submitted,
          ...(edit.baseRevision === undefined ? {} : { baseRevision: edit.baseRevision }),
        },
      })
      if (saveGeneration !== authGeneration) return
      const info = savedInfo(edit.format, submitted, result.savedAt, attachedInfo(result))
      const savedTitle = sourceTitleOf(submitted)
      // The shared title shows the SAVED edit title, never an unsaved draft.
      if (savedTitle !== undefined) currentTitle = savedTitle
      sourceUrl = sourceUrl ?? sourceUrlFromData(submitted)
      // The shared read cache holds the OLD body now: drop exactly this
      // resource (other offsets/resource reads stay warm).
      cache.invalidate(workspaceId, resource)
      state = {
        ...state,
        info,
        edit: state.edit === null
          ? null
          : {
              ...state.edit,
              data: submitted,
              baseline: JSON.stringify(submitted),
              dirty: false,
              saving: false,
              ...(result.revision === undefined ? {} : { baseRevision: result.revision }),
            },
        saved: true,
        conflict: false,
        authBlocked: false,
        error: null,
        closeWarning: false,
        readStale: true,
      }
      // A successful save invalidates the library/bindings cache; remount the
      // already-open binding panel so it stops holding the pre-save CAS revision.
      bindingsRevision += 1
      render()
      // Re-read the authoritative preview body; until it lands a preview shows
      // the just-saved edit draft, never the stale read.
      void loadRead({ force: true })
    } catch (failure) {
      if (saveGeneration !== authGeneration) return
      const conflict = categoryOf(failure) === 'conflict'
      state = {
        ...state,
        edit: state.edit === null ? null : { ...state.edit, saving: false, dirty: true },
        conflict,
        error: conflict ? t('clueDetailConflict') : clueErrorMessage(failure, t('clueDetailFailed')),
      }
      render()
    }
  }

  /** Explicit conflict re-read: replaces the draft ONLY after the reader chose it. */
  async function reloadEdit(): Promise<void> {
    if (state.edit === null) {
      await loadRead({ force: true })
      return
    }
    if (state.editLoading || state.edit.saving) return
    const token = ++editSequence
    editAbort?.abort()
    const controller = new AbortController()
    editAbort = controller
    state = { ...state, editLoading: true, conflict: false, error: null }
    render()
    try {
      const document = await face.api.loadEdit(workspaceId, resource, controller.signal)
      if (token !== editSequence || controller.signal.aborted) return
      const locked = lockedReasonOf(document)
      const supported = supportsWindowEditing(face, document.format, document.data)
      const info = infoOf(document.format, document.data, state.info, attachedInfo(document))
      const reloadedTitle = sourceTitleOf(document.data)
      if (reloadedTitle !== undefined) currentTitle = reloadedTitle
      sourceUrl = sourceUrl ?? sourceUrlFromData(document.data)
      if (locked !== undefined || !supported) {
        state = {
          ...state,
          mode: 'preview',
          edit: null,
          editLoading: false,
          info,
          editable: false,
          authBlocked: false,
          error: locked === undefined ? t('clueDetailReadOnlyType') : readOnlyReasonCopy(locked),
        }
      } else {
        state = {
          ...state,
          mode: 'edit',
          editLoading: false,
          info,
          error: null,
          authBlocked: false,
          readStale: true,
          edit: {
            format: document.format,
            document,
            data: document.data,
            ...(document.baseRevision === undefined ? {} : { baseRevision: document.baseRevision }),
            baseline: JSON.stringify(document.data),
            supported,
            dirty: false,
            saving: false,
          },
        }
      }
      render()
      void loadRead({ force: true })
    } catch (failure) {
      if (token !== editSequence) return
      state = {
        ...state,
        editLoading: false,
        error: clueErrorHint(categoryOf(failure)) ?? clueErrorMessage(failure, t('clueDetailFailed')),
      }
      render()
    }
  }

  /** A shared-cache event: a library write refreshes bindings; auth drops stale reads. */
  function handleDataChange(change: ClueDetailDataChange): void {
    if (change.kind === 'library') {
      if (change.workspaceId !== undefined && change.workspaceId !== workspaceId) return
      // Another detail window (or this one) saved/ensured: the panel must
      // reload its CAS revision instead of retrying with the stale one.
      bindingsRevision += 1
      render()
      return
    }

    if (change.kind === 'resource') {
      if ((change.workspaceId !== undefined && change.workspaceId !== workspaceId)
        || !isSameClueResource(workspaceId, resource, change.resource) || commentCreating) return
      commentsSequence += 1
      commentsAbort?.abort()
      commentsLoading = false
      void loadComments()
      if (!guard.dirty && !state.refreshing) void loadRead({ force: true })
      return
    }

    // An AUTH boundary is global: no response issued under the old identity may
    // land in this window. Invalidate first, bump both sequences, abort the
    // in-flight calls, then either preserve a dirty draft (writes blocked) or
    // drop the stale read and fetch the new account's resource.
    authGeneration += 1
    commentCreating = false
    commentsSequence += 1
    commentsAbort?.abort()
    bodyMoreAbort?.abort()
    bodyMoreLoading = false
    discussion = undefined
    commentsCapabilities = undefined
    commentsLoading = false
    commentsError = undefined
    commentCursors.clear()
    readSequence += 1
    editSequence += 1
    readAbort?.abort()
    readAbort = undefined
    editAbort?.abort()
    editAbort = undefined
    cache.invalidate(workspaceId, resource)
    const edit = state.edit
    if (edit !== null && (edit.dirty || edit.saving)) {
      state = {
        ...state,
        read: null,
        readLoading: false,
        refreshing: false,
        editLoading: false,
        conflict: false,
        saved: false,
        readStale: true,
        authBlocked: true,
        // The old identity's write cannot be adopted even if it resolves; keep
        // the draft visible but no longer "saving" under the new account.
        edit: edit.saving ? { ...edit, saving: false } : edit,
        error: t('clueStateNotAuthorized'),
      }
      render()
      void loadCatalogue()
      return
    }
    currentTitle = target.title
    sourceUrl = sourceUrlOf(target.locator)
    state = {
      ...state,
      mode: 'preview',
      read: null,
      edit: null,
      info: infoOf('', null, target.info),
      readLoading: true,
      refreshing: false,
      editLoading: false,
      conflict: false,
      saved: false,
      readStale: true,
      authBlocked: false,
      // Edit capability belongs to the NEW identity: re-read the catalogue.
      editable: undefined,
      error: null,
      failure: null,
    }
    render()
    void loadCatalogue()
    void loadRead()
  }

  /** Non-destructive toolbar Refresh (dirty/saving windows can never discard). */
  function refresh(): void {
    if (guard.dirty || state.edit?.saving === true || state.editLoading || state.refreshing) return
    void loadRead({ force: true })
    if (commentsCapabilities?.read === true) void loadComments()
  }

  /** Insert one reference; first persistence carries subtitle/info snapshots. */
  async function insertReference(): Promise<void> {
    // A candidate with no authoritative read must not persist the opening
    // fallback (or a pre-auth snapshot) as the stable clue.
    if (referenceBusy || (target.clueId === undefined && state.read === null)) return
    referenceBusy = true
    render()
    try {
      const clueId = target.clueId ?? (await face.api.ensure(workspaceId, ensureInput())).clue.id
      if (options.onInsertClue?.(clueId, currentTitle) !== true) {
        state = { ...state, error: t('clueInsertFailed') }
        render()
      }
    } catch (failure) {
      state = { ...state, error: clueErrorMessage(failure, t('clueInsertFailed')) }
    } finally {
      referenceBusy = false
      render()
    }
  }

  /** Carry the known title/subtitle/info into the persisted clue on first use. */
  function ensureInput(): Parameters<BetterSidebarCluesClientFace['api']['ensure']>[1] {
    const input: Parameters<BetterSidebarCluesClientFace['api']['ensure']>[1] & {
      readonly subtitle?: string
      readonly info?: ClueResourceInfo
    } = {
      sourceId: target.sourceId,
      typeId: target.typeId,
      locator: target.locator ?? {},
      title: currentTitle,
      ...(target.subtitle === undefined ? {} : { subtitle: target.subtitle }),
      ...(state.info === undefined ? {} : { info: state.info }),
    }
    return input
  }

  function attach(nextHandle: WindowHandle, nextGuard: DetailGuard): void {
    handle = nextHandle
    guard = nextGuard
    guard.reportBlocked = () => {
      state = { ...state, closeWarning: true }
      render()
    }
    unsubscribeChanges = cache.subscribe?.(handleDataChange)
    render()
    if (!started) {
      started = true
      void loadCatalogue()
      void loadRead()
    }
  }

  function dispose(): void {
    disposed = true
    commentsSequence += 1
    commentsAbort?.abort()
    bodyMoreAbort?.abort()
    unsubscribeChanges?.()
    unsubscribeChanges = undefined
    readAbort?.abort()
    readAbort = undefined
    editAbort?.abort()
    editAbort = undefined
  }

  return { initialContent: content(), initialTitle, attach, dispose }
}

/** The workspace-scoped resource input of one target. */
function resourceOf(options: ClueDetailWindowOptions): ClueClientResourceInput {
  const { target, sessionId } = options
  if (target.clueId !== undefined) {
    return { clueId: target.clueId, ...(sessionId === undefined ? {} : { sessionId }) }
  }
  return {
    sourceId: target.sourceId,
    typeId: target.typeId,
    locator: target.locator ?? {},
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

/**
 * Open (or focus) the detail window of one resource.
 * @param options - window host, clue face, workspace and the resource address.
 * @returns the window handle.
 */
export function openClueDetailWindow(options: ClueDetailWindowOptions): WindowHandle {
  const { windows, target } = options
  const id = clueDetailWindowId(target)
  const guard: DetailGuard = { dirty: false, saving: false }
  const previous = loadedDetailWindows.get(id)
  const controller = createDetailController(options)
  const handle = windows.open({
    id,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    surface: options.surface ?? preferredClueWindowSurface(),
    title: controller.initialTitle,
    size: 'document',
    bodyLayout: 'fill',
    // Initial content is built synchronously from the target snapshot + hot
    // cache: a warm row renders without a spinner-only first frame.
    content: controller.initialContent,
    onBeforeClose: () => {
      if (!guard.dirty && !guard.saving) return true
      // Keep the window (and the draft) and say why: the reader chooses
      // "discard" in the footer or saves first.
      guard.reportBlocked?.()
      return false
    },
    onClose: () => {
      controller.dispose()
      loadedDetailWindows.delete(id)
    },
  })
  if (previous !== undefined && previous === handle) {
    // `open` returned the EXISTING instance (the host focuses it): touching
    // its content here would replace an unsaved draft. Focus only.
    handle.focus()
    return handle
  }
  loadedDetailWindows.set(id, handle)
  controller.attach(handle, guard)
  return handle
}
