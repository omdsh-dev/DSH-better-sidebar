/**
 * The clue tab's multi-source resources view (S9).
 *
 * One input serves three jobs — keyword search, a direct resource URL/path
 * (resolved into candidates before anything is stored) and the empty-query
 * browse page of the current range. Workspace defaults supply the GitHub
 * repository and Feishu Drive root; only an explicit user override is saved.
 * Account-wide document search keeps its own default, independent of browse.
 *
 * What the reader can rely on:
 * - a source that is switched off is not listed here at all;
 * - a source without list support still offers pins + search + direct add —
 *   it never claims "no data";
 * - unsupported / range-needed / unauthorized / empty / network are distinct
 *   states, each with its own next step;
 * - source navigation aborts the old page and restores that source's own draft;
 * - changing range resets the cursor, including a cached range changed elsewhere;
 * - the pin list is deduplicated against the page: a pinned row says so and its
 *   pin control turns into unpin;
 * - no total means prev/next only (the page counter is the local page, never a
 *   fabricated "1 / N").
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode, MouseEvent, KeyboardEvent, MutableRefObject } from 'react'
import {
  writeClipboard, IconCopyOutlineRegular, IconInspectOutlineRegular,
  IconContextInjectionOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconChecklistOutlineRegular,
  IconCloseOutlineRegular,
  IconEllipsisOutlineRegular,
  IconPinFillRegular,
  IconPinOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconPlusOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ClueCandidate,
  ClueListResult,
  ClueSourceDescriptor,
  ClueSourceDisplayDescriptor,
  CluesResolveResult,
  JsonValue,
} from '../../../clues/types.ts'
import type { ClueDetailTarget } from '../windows/detail.tsx'
import { openClueCollectionWindow } from '../windows/collect.tsx'
import { BUILTIN_SOURCE_IDS } from '../../../clues/types.ts'
import type { BetterSidebarCluesClientFace } from '../registry.ts'
import { clueErrorMessage } from '../copy.ts'
import { cluesApi, invalidateClueRequests, peekClueRequest, subscribeClueDataChanges } from '../api.ts'
import type { ClueClientListInput, ClueClientSearchInput } from '../api.ts'
import { sourceUrlOf } from '../windows/detail.tsx'
import { serializeClueToken } from '../../../clues/context/tokens.ts'
import { LoadingIndicator } from '../../ui/LoadingIndicator.tsx'
import { useDefaultClueScope } from '../default-scope.ts'
import { t } from '../../locales.ts'
import {
  EMPTY_FORM,
  ScopeFields,
  SourceNavigation,
  type ScopeForm,
  candidateKey,
  formOf,
  listNeedsScope,
  looksLikeResource,
  scopeOfForm,
  scopeSummary,
  searchNeedsScope,
  resourceIcon,
  folderScopeOf,
} from './browser-shared.tsx'
import { ResourceInlineMeta } from '../resource-summary.tsx'
import { ResourceFilters, resourceFilterState } from '../resource-filters.tsx'
import {
  ActionButton, ActionFooter, Checkbox, Disclosure, EmptyState, ErrorBlock, IconButton, ListRow, Menu, SearchField,
} from '../../ui/index.ts'
import { useListNavigation } from '../../ui/use-list-navigation.ts'
import { SourceReadiness } from '../sources/readiness.tsx'
import { useScrollLoad } from '../../ui/use-scroll-load.ts'
import { HostedWindow } from '../../windows/HostedWindow.tsx'
import type { BetterSidebarWindowsClientFace } from '../../windows/types.ts'
import css from './clues-tab.module.css'

/** The persisted range per source id (JSON value, absent = not chosen). */
type ClueScopes = Readonly<Record<string, JsonValue | undefined>>

/** Imperative seam the tab uses to start a collection from a detail window. */
interface ClueBrowserController {
  /** Add one resource to a pack through the SAME collection window/CAS flow. */
  addToPack(target: ClueDetailTarget): void
}

/** Props of the browser. */
interface ClueBrowserProps {
  readonly workspaceId: string
  readonly face: BetterSidebarCluesClientFace
  readonly windows: BetterSidebarWindowsClientFace
  readonly visible: boolean
  readonly sourcePreferences?: Readonly<Record<string, boolean>>
  /** Last source the reader chose; an unset or disabled id falls back to the first. */
  readonly initialSourceId?: string
  /** Persist the reader's explicit source choice. */
  onSourceChange?(sourceId: string): void
  readonly scopes: ClueScopes
  onScopeChange(sourceId: string, scope: JsonValue | undefined): void
  onOpenDetail(target: ClueDetailTarget): void
  /** Parent resolves this workspace locator and reveals it in the native file tree. */
  onRevealFile?(candidate: ClueCandidate): void
  /** Insert one stable clue id into the draft; returns whether the chip landed. */
  onInsertClue(clueId: string, title: string): boolean
  /** The tab registers its detail-window collection bridge here. */
  readonly controllerRef?: MutableRefObject<ClueBrowserController | null>
  onOpenSettings(): void
  onNotice(message: string): void
  onPacksChanged?(): void
  onTaskOpenChange?(open: boolean): void
}

/** How one page was requested. */
type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'search'; readonly query: string }
  | { readonly kind: 'resolve'; readonly text: string }

/** One result state (every branch names its own next step). */
type BrowserState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'page'
      readonly view: View
      readonly result: ClueListResult
    }
  | { readonly kind: 'resolved'; readonly candidates: readonly ClueCandidate[]; readonly text: string }
  | { readonly kind: 'needs-scope'; readonly reason: 'list' | 'search' }
  | { readonly kind: 'unsupported'; readonly reason: 'no-list' | 'no-search' }
  | { readonly kind: 'error'; readonly message: string }

/** A background read of the SAME page: never replaces the rows being read. */
type RefreshStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'refreshing' }
  | { readonly kind: 'error'; readonly message: string }

/** One source's mounted browse memo (bounded by `browseDrafts` below). */
interface BrowseDraft {
  query: string
  view: View
  scopeKey: string | undefined
  form: ScopeForm
  filterDraft?: { scope: JsonValue | undefined }
  /** The complete page the reader left: first page plus every appended cursor. */
  result?: ClueListResult
  /** Request key the memoized page belongs to (source/scope/view identity). */
  requestKey?: string
  /** Cursors already consumed by that page. */
  seenCursors?: readonly string[]
  /** Scroll offset of the results region when the reader left. */
  scrollTop?: number
  scopeTrail?: readonly (JsonValue | undefined)[]
}

/** Whether two requests name the same logical page. */
function sameView(left: View, right: View): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'search' && right.kind === 'search') return left.query === right.query
  if (left.kind === 'resolve' && right.kind === 'resolve') return left.text === right.text
  return true
}

/** Page size of one browse/search request. */
const PAGE_SIZE = 25

/** The identity of one page request inside one source's memo. */
function pageRequestKey(sourceId: string, scopeKey: string | undefined, view: View): string {
  return `${sourceId}\u0000${scopeKey ?? ''}\u0000${view.kind}\u0000${
    view.kind === 'search' ? view.query : view.kind === 'resolve' ? view.text : ''
  }`
}

/** The wire input `cluesApi.list/search` uses for one page (no workspace). */
function pagePayload(
  sourceId: string,
  view: View,
  explicitScope: JsonValue | undefined,
  cursor?: string,
): ClueClientListInput {
  return {
    sourceId,
    ...(explicitScope === undefined ? {} : { scope: explicitScope }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(view.kind === 'search' ? { query: view.query } : {}),
    limit: PAGE_SIZE,
  }
}

/** Synchronous first-page answer from the shared read cache (no request). */
function peekPage(
  face: BetterSidebarCluesClientFace,
  workspaceId: string,
  sourceId: string,
  view: View,
  explicitScope: JsonValue | undefined,
): ClueListResult | undefined {
  if (face.api !== cluesApi || view.kind === 'resolve') return undefined
  const method = view.kind === 'search' ? 'clues.search' : 'clues.list'
  return peekClueRequest<ClueListResult>(
    method,
    workspaceId,
    { workspaceId, ...pagePayload(sourceId, view, explicitScope) },
  )
}

/** The display name of one source. */
function sourceLabel(
  source: ClueSourceDescriptor,
  displays: readonly ClueSourceDisplayDescriptor[],
): string {
  return displays.find(display => display.sourceId === source.sourceId)?.name ?? source.name
}

/** One pinned clue row (resolved through the local library). */
interface PinnedRow {
  readonly title: string
  readonly sourceId: string
  readonly typeId: string
  readonly locator: ClueCandidate['locator']
  readonly clueId: string
  readonly info?: ClueCandidate['info']
  readonly subtitle?: string
}

/** The multi-source browser. */
export function ClueBrowser(props: ClueBrowserProps): ReactNode {
  const { workspaceId, face, scopes, windows, initialSourceId, onSourceChange } = props
  const visible = props.visible
  const headingId = useId()
  const { onScopeChange, onOpenDetail, onInsertClue, onOpenSettings, onNotice, onPacksChanged } = props

  const [sources, setSources] = useState<readonly ClueSourceDescriptor[]>([])
  const [displays, setDisplays] = useState<readonly ClueSourceDisplayDescriptor[]>([])
  const [cataloguePhase, setCataloguePhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [catalogueError, setCatalogueError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(initialSourceId ?? null)
  const [query, setQuery] = useState('')
  const [composing, setComposing] = useState(false)
  const composingRef = useRef(false)
  const [filterDraft, setFilterDraft] = useState<{ scope: JsonValue | undefined } | undefined>()
  const filterDraftRef = useRef(filterDraft)
  const [scopeTrail, setScopeTrail] = useState<readonly (JsonValue | undefined)[]>([])
  const [rowMenu, setRowMenu] = useState<{ candidate: ClueCandidate; x: number; y: number } | null>(null)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [state, setState] = useState<BrowserState>({ kind: 'idle' })
  const viewRef = useRef(view)
  viewRef.current = view
  const [refresh, setRefresh] = useState<RefreshStatus>({ kind: 'idle' })
  const [moreLoading, setMoreLoading] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const requestBusy = useRef(false)
  /** The last request key this view started, so duplicated triggers coalesce. */
  const autoRunKey = useRef<string | undefined>(undefined)
  /** The request key whose page is currently on screen (not merely requested). */
  const loadedKey = useRef<string | undefined>(undefined)
  const seenCursors = useRef(new Set<string>())
  const resultScrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const scopeButtonRef = useRef<HTMLButtonElement>(null)
  const [scopeOpen, setScopeOpen] = useState(false)
  const [form, setForm] = useState<ScopeForm>(EMPTY_FORM)
  const [scopeError, setScopeError] = useState<string | null>(null)
  const [pins, setPins] = useState<readonly { readonly clueId: string }[]>([])
  const [titles, setTitles] = useState<ReadonlyMap<string, PinnedRow>>(new Map())
  const [pinsPhase, setPinsPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [pinsRetrying, setPinsRetrying] = useState(false)
  const queryInputRef = useRef<HTMLInputElement | null>(null)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const [selected, setSelected] = useState<ReadonlyMap<string, ClueCandidate>>(new Map())
  const [selectionMode, setSelectionMode] = useState(false)
  /** One bounded memo per source: drafts AND the page/cursor/scroll it left. */
  const browseDrafts = useRef(new Map<string, BrowseDraft>())
  /** Scroll offset to re-apply once the restored page has rendered. */
  const pendingScrollRestore = useRef<number | undefined>(undefined)
  const { onTaskOpenChange } = props
  useEffect(() => {
    onTaskOpenChange?.(scopeOpen)
    return () => { onTaskOpenChange?.(false) }
  }, [scopeOpen, onTaskOpenChange])
  const collectButtonRef = useRef<HTMLButtonElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingAction, setPendingAction] = useState<{ key: string; kind: 'insert' | 'pin' } | undefined>()
  const abortRef = useRef<AbortController | undefined>(undefined)
  /** The last request that actually went to the wire (Retry replays it). */
  const lastRequestRef = useRef<{ view: View; cursor: string | undefined }>({
    view: { kind: 'list' },
    cursor: undefined,
  })

  const enabled = sources.filter(source =>
    props.sourcePreferences?.[source.sourceId] !== false && face.isSourceEnabled(source.sourceId))
  const active = useMemo(
    () => enabled.find(source => source.sourceId === activeId) ?? enabled[0],
    [enabled, activeId],
  )
  const activeSourceId = active?.sourceId
  // `null` is the settings tombstone of a cleared range, never a scope value.
  const scopeKey = JSON.stringify(activeSourceId === undefined ? undefined : scopes[activeSourceId] ?? undefined)
  // Collection recency writes must not reset an unsaved range editor or re-run
  // the browser when the persisted active range itself has not changed.
  const explicitScope = useMemo<JsonValue | undefined>(
    () => scopeKey === undefined ? undefined : JSON.parse(scopeKey) as JsonValue,
    [scopeKey],
  )
  const defaults = useDefaultClueScope({ face, workspaceId, sourceId: activeSourceId,
    explicitScope, visible })
  // The account-wide document search is intentionally broader than Drive browse.
  const effectiveScopeKey = JSON.stringify(view.kind === 'search'
    && activeSourceId === BUILTIN_SOURCE_IDS.feishuDocs && explicitScope === undefined
    ? undefined : defaults.scope)
  const activeScope = useMemo<JsonValue | undefined>(
    () => effectiveScopeKey === undefined ? undefined : JSON.parse(effectiveScopeKey) as JsonValue,
    [effectiveScopeKey],
  )
  const defaultLoading = defaults.loading
  const supportsList = active?.capabilities.list === true
  const supportsSearch = active?.capabilities.search === true

  // ── catalogue + local library/pins ─────────────────────────────────────────

  const loadCatalogue = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (!visibleRef.current) return
    setCataloguePhase('loading')
    setCatalogueError(null)
    try {
      const result = await face.api.sources(signal)
      if (signal?.aborted === true) return
      setSources(result.sources)
      setCataloguePhase('ready')
    } catch (failure) {
      if (signal?.aborted === true) return
      setCataloguePhase('error')
      setCatalogueError(clueErrorMessage(failure, t('error')))
    }
  }, [face])

  const refreshLocal = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    if (!visibleRef.current) return false
    setPinsPhase('loading')
    try {
      const [pinResult, library] = await Promise.all([
        face.api.pinsList(workspaceId),
        face.api.clues(workspaceId),
      ])
      if (signal?.aborted === true) return false
      setPins(pinResult.pins.map(pin => ({ clueId: pin.clueId })))
      const next = new Map<string, PinnedRow>()
      for (const clue of library.clues) {
        next.set(clue.id, { ...clue, clueId: clue.id })
      }
      setTitles(next)
      setPinsPhase('ready')
      return true
    } catch {
      if (signal?.aborted === true) return false
      // A failed read is not an empty library; keep the last rows and retry.
      setPinsPhase('error')
      return false
    }
  }, [face, workspaceId])

  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    setDisplays(face.getSourceDisplays())
    void loadCatalogue(controller.signal)
    void refreshLocal(controller.signal)
    const unsubscribe = face.subscribe(() => { setDisplays(face.getSourceDisplays()) })
    return () => {
      controller.abort()
      unsubscribe()
    }
  }, [visible, loadCatalogue, refreshLocal, face])

  useEffect(() => {
    if (activeSourceId === undefined) return
    const draft = browseDrafts.current.get(activeSourceId)
    setForm(draft !== undefined && draft.scopeKey === scopeKey ? draft.form : formOf(activeSourceId, activeScope))
    setScopeError(null)
  }, [activeSourceId, activeScope, scopeKey])

  // ── one page ───────────────────────────────────────────────────────────────

  const run = useCallback(async (
    requested: View,
    cursor: string | undefined,
    append = false,
    options?: { readonly auto?: boolean; readonly force?: boolean },
  ): Promise<void> => {
    if (activeSourceId === undefined || !visibleRef.current) return
    if (append && requestBusy.current) return
    const requestKey = pageRequestKey(activeSourceId, scopeKey, requested)
    // The loader effect and a source-readiness callback can both ask for the
    // same page in the same tick. One reader key owns that read.
    if (!append && options?.auto === true && options.force !== true
      && autoRunKey.current === requestKey
      && (requestBusy.current || loadedKey.current === requestKey)) return
    if (requested.kind !== 'resolve') {
      if (defaultLoading) {
        if (loadedKey.current === requestKey) setRefresh({ kind: 'refreshing' })
        else setState({ kind: 'loading' })
        return
      }
      const blocked = requested.kind === 'list'
        ? listNeedsScope(activeSourceId, activeScope)
        : searchNeedsScope(activeSourceId, activeScope, requested.query)
      if (blocked) {
        setState({ kind: 'needs-scope', reason: requested.kind === 'search' ? 'search' : 'list' })
        setRefresh({ kind: 'idle' })
        return
      }
    }
    const current = stateRef.current
    const keep = !append && loadedKey.current === requestKey && (
      (current.kind === 'page' && sameView(current.view, requested))
      || (current.kind === 'resolved' && requested.kind === 'resolve' && current.text === requested.text)
    )
    const consumedCursors = append ? new Set(seenCursors.current) : new Set<string>()
    const previous = append && current.kind === 'page' ? current.result : undefined
    if (append && previous === undefined) return
    // Cache-first: a page this activation already read is shown synchronously.
    // Cursor answers merge exactly like a wire page; explicit refresh and retry
    // (`force`) always go to the wire.
    if (options?.force !== true && face.api === cluesApi) {
      if (requested.kind === 'resolve') {
        const cached = peekClueRequest<CluesResolveResult>('clues.resolve', workspaceId, {
          workspaceId,
          text: requested.text,
        })
        if (cached !== undefined) {
          autoRunKey.current = requestKey
          lastRequestRef.current = { view: requested, cursor }
          loadedKey.current = requestKey
          setMoreError(null)
          setRefresh({ kind: 'idle' })
          setState({ kind: 'resolved', candidates: cached.candidates, text: requested.text })
          return
        }
      } else {
        const method = requested.kind === 'search' ? 'clues.search' : 'clues.list'
        const payload = { workspaceId, ...pagePayload(activeSourceId, requested, explicitScope, cursor) }
        const cached = peekClueRequest<ClueListResult>(method, workspaceId, payload)
        if (cached !== undefined) {
          if (cursor !== undefined) consumedCursors.add(cursor)
          if (cached.nextCursor !== undefined && consumedCursors.has(cached.nextCursor)) {
            if (append) setMoreError(t('error'))
            else setState({ kind: 'error', message: t('error') })
            return
          }
          const items = new Map((previous?.items ?? []).map(candidate => [candidateKey(candidate), candidate]))
          for (const candidate of cached.items) items.set(candidateKey(candidate), candidate)
          autoRunKey.current = requestKey
          lastRequestRef.current = { view: requested, cursor }
          loadedKey.current = requestKey
          setMoreLoading(false)
          setMoreError(null)
          setRefresh({ kind: 'idle' })
          seenCursors.current = consumedCursors
          setState({ kind: 'page', view: requested, result: { ...cached, items: [...items.values()] } })
          return
        }
      }
    }
    autoRunKey.current = requestKey
    lastRequestRef.current = { view: requested, cursor }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    requestBusy.current = true
    setMoreError(null)
    if (append) setMoreLoading(true)
    else if (keep) {
      // A background refresh preserves the rows, selection, draft and scroll.
      // The fixed refresh indicator is the only visual state change.
      setMoreLoading(false)
      setRefresh({ kind: 'refreshing' })
    } else {
      seenCursors.current.clear()
      setMoreLoading(false)
      setRefresh({ kind: 'idle' })
      setState({ kind: 'loading' })
      if (resultScrollRef.current !== null) resultScrollRef.current.scrollTop = 0
    }
    try {
      if (requested.kind === 'resolve') {
        const resolved = await face.api.resolve(workspaceId, { text: requested.text }, controller.signal)
        if (controller.signal.aborted) return
        loadedKey.current = requestKey
        setState({ kind: 'resolved', candidates: resolved.candidates, text: requested.text })
        setRefresh({ kind: 'idle' })
        return
      }
      if (requested.kind === 'list' && !supportsList) {
        setState({ kind: 'unsupported', reason: 'no-list' })
        setRefresh({ kind: 'idle' })
        return
      }
      if (requested.kind === 'search' && !supportsSearch) {
        setState({ kind: 'unsupported', reason: 'no-search' })
        setRefresh({ kind: 'idle' })
        return
      }
      const params = pagePayload(activeSourceId, requested, explicitScope, cursor)
      const result = requested.kind === 'list'
        ? await face.api.list(workspaceId, params, controller.signal)
        : await face.api.search(workspaceId, params as ClueClientSearchInput, controller.signal)
      if (controller.signal.aborted) return
      if (cursor !== undefined) consumedCursors.add(cursor)
      if (result.nextCursor !== undefined && consumedCursors.has(result.nextCursor)) throw new Error('Repeated clue cursor')
      const items = new Map((previous?.items ?? []).map(candidate => [candidateKey(candidate), candidate]))
      for (const candidate of result.items) items.set(candidateKey(candidate), candidate)
      loadedKey.current = requestKey
      seenCursors.current = consumedCursors
      setState({ kind: 'page', view: requested, result: { ...result, items: [...items.values()] } })
      setRefresh({ kind: 'idle' })
    } catch (failure) {
      if (controller.signal.aborted) return
      if (append) setMoreError(clueErrorMessage(failure, t('error')))
      else if (keep) {
        // Never replace a readable page with an empty/error screen. The error
        // stays in the results with its own Retry.
        setRefresh({ kind: 'error', message: clueErrorMessage(failure, t('error')) })
      } else {
        setState({ kind: 'error', message: clueErrorMessage(failure, t('error')) })
        setRefresh({ kind: 'idle' })
      }
    } finally {
      if (abortRef.current === controller) {
        requestBusy.current = false
        setMoreLoading(false)
        // A hidden/aborted background refresh has no completion frame of its
        // own; clear its fixed indicator so a later show is a pure paint.
        if (controller.signal.aborted) setRefresh({ kind: 'idle' })
      }
    }
  }, [activeSourceId, supportsList, supportsSearch, activeScope, explicitScope, defaultLoading, face, workspaceId, scopeKey])

  const lastSourceRef = useRef<string | undefined>(undefined)
  // ONE loader: the current view + cursor decide what is fetched. A browse
  // range that is still unchosen blocks list/search — but never a direct
  // resource resolve, and a Feishu browse-only root blocks only SEARCH.
  useEffect(() => {
    if (!visible || activeSourceId === undefined) return
    const sourceChanged = lastSourceRef.current !== undefined && lastSourceRef.current !== activeSourceId
    lastSourceRef.current = activeSourceId
    if (sourceChanged) {
      // A preference/catalogue change can replace the active source without a
      // navigation event. Never send the removed source's request to its fallback.
      setQuery('')
      setView({ kind: 'list' })
      setState({ kind: 'idle' })
      loadedKey.current = undefined
      setRefresh({ kind: 'idle' })
      return
    }
    // Returning to a cached page is a paint. If a mutation invalidated it
    // while the tab was hidden, fall through to one background read instead
    // of showing stale rows as if nothing changed.
    if (loadedKey.current !== undefined && face.api === cluesApi
      && (view.kind === 'list' || view.kind === 'search')
      && peekPage(face, workspaceId, activeSourceId, view, explicitScope) === undefined) {
      autoRunKey.current = undefined
    }
    void run(view, undefined, false, { auto: true })
    return () => {
      abortRef.current?.abort()
      // Hiding/collapsing retains the cached rows, draft and cursor, but a
      // refresh spinner started before the hide must not survive the show.
      if (!visibleRef.current) setRefresh({ kind: 'idle' })
    }
  }, [visible, activeSourceId, activeScope, view, run, face, workspaceId, explicitScope])

  // One singleton business bus: another view's save/ensure or an auth identity
  // boundary changes what this browser may show. The library event only
  // refreshes local pins/library rows (never the external page); the auth event
  // drops every old-identity page/memo and re-reads under the new identity.
  useEffect(() => subscribeClueDataChanges((change) => {
    if (change.kind === 'library') {
      if (change.workspaceId !== undefined && change.workspaceId !== workspaceId) return
      if (visibleRef.current) void refreshLocal()
      return
    }
    if (change.kind === 'resource') return
    abortRef.current?.abort()
    // Keep each source's typed query/range draft, but drop the old identity's
    // memoized page, cursor chain and scroll position.
    for (const [sourceId, draft] of [...browseDrafts.current]) {
      browseDrafts.current.set(sourceId, {
        query: draft.query,
        view: draft.view,
        scopeKey: draft.scopeKey,
        form: draft.form,
      })
    }
    loadedKey.current = undefined
    autoRunKey.current = undefined
    seenCursors.current.clear()
    pendingScrollRestore.current = undefined
    setState({ kind: 'idle' })
    setRefresh({ kind: 'idle' })
    setMoreError(null)
    setMoreLoading(false)
    if (visibleRef.current) {
      void refreshLocal()
      if (activeSourceId !== undefined) void run(viewRef.current, undefined, false, { force: true })
    }
  }), [activeSourceId, refreshLocal, run, workspaceId])

  const selectSource = (sourceId: string): void => {
    if (sourceId === activeSourceId) return
    if (activeSourceId !== undefined) {
      browseDrafts.current.delete(activeSourceId)
      browseDrafts.current.set(activeSourceId, {
        query,
        view,
        scopeKey,
        form,
        scopeTrail,
        filterDraft: filterDraftRef.current,
        ...(state.kind === 'page' && loadedKey.current !== undefined
          ? {
              result: state.result,
              requestKey: loadedKey.current,
              seenCursors: [...seenCursors.current],
            }
          : {}),
        scrollTop: resultScrollRef.current?.scrollTop ?? 0,
      })
      if (browseDrafts.current.size > 20) {
        const oldest = browseDrafts.current.keys().next().value
        if (oldest !== undefined) browseDrafts.current.delete(oldest)
      }
    }
    const draft = browseDrafts.current.get(sourceId)
    abortRef.current?.abort()
    // Restore all request inputs in the same event before the loader sees the source.
    lastSourceRef.current = sourceId
    setActiveId(sourceId)
    onSourceChange?.(sourceId)
    setQuery(draft?.query ?? '')
    composingRef.current = false
    setComposing(false)
    const restoredFilter = draft?.scopeKey === JSON.stringify(scopes[sourceId] ?? undefined) ? draft?.filterDraft : undefined
    filterDraftRef.current = restoredFilter
    setFilterDraft(restoredFilter)
    setScopeTrail(draft?.scopeTrail ?? [])
    const nextView = draft?.view ?? { kind: 'list' }
    setView(nextView)
    setScopeOpen(false)
    setRefresh({ kind: 'idle' })
    const nextScope = scopes[sourceId]
    const nextScopeKey = JSON.stringify(nextScope === undefined ? undefined : nextScope)
    if (draft?.result !== undefined && draft.requestKey !== undefined
      && draft.scopeKey === nextScopeKey) {
      // The memo paints the page, its appended cursor pages and its scroll
      // offset at once. A cache invalidated elsewhere still gets a background
      // refresh; an unchanged cache issues no request at all.
      loadedKey.current = draft.requestKey
      seenCursors.current = new Set(draft.seenCursors ?? [])
      setState({ kind: 'page', view: nextView, result: draft.result })
      const cacheValid = face.api !== cluesApi
        || peekPage(face, workspaceId, sourceId, nextView, nextScope) !== undefined
      autoRunKey.current = cacheValid ? draft.requestKey : undefined
      pendingScrollRestore.current = draft.scrollTop ?? 0
    } else {
      loadedKey.current = undefined
      autoRunKey.current = undefined
      setState({ kind: 'idle' })
    }
  }

  // A restored page is one render behind the memo; scroll back to where the
  // reader left without touching a live refresh's scroll position.
  useEffect(() => {
    const top = pendingScrollRestore.current
    if (top === undefined) return
    pendingScrollRestore.current = undefined
    if (resultScrollRef.current !== null) resultScrollRef.current.scrollTop = top
  }, [state, activeSourceId])

  const onScopeApply = useCallback((): void => {
    if (activeSourceId === undefined) return
    const built = scopeOfForm(activeSourceId, form)
    if (built.error !== undefined) {
      setScopeError(built.error)
      return
    }
    setScopeError(null)
    setScopeTrail([])
    filterDraftRef.current = undefined
    setFilterDraft(undefined)
    onScopeChange(activeSourceId, built.scope)
    setScopeOpen(false)
  }, [activeSourceId, form, onScopeChange])

  const onSubmitQuery = useCallback((): void => {
    if (composingRef.current) return
    const pending = filterDraftRef.current
    if (pending !== undefined && activeSourceId !== undefined) {
      onScopeChange(activeSourceId, pending.scope)
      filterDraftRef.current = undefined
      setFilterDraft(undefined)
    }
    const text = query.trim()
    if (text === '') {
      setView({ kind: 'list' })
      return
    }
    setView(looksLikeResource(text) ? { kind: 'resolve', text } : { kind: 'search', query: text })
  }, [query, activeSourceId, onScopeChange])

  // Query and quick filters share one trailing edge. A native/legacy IME
  // Enter never flushes half-composed text or pending filters.
  useEffect(() => {
    if (!visible || activeSourceId === undefined || composing) return
    const text = query.trim()
    const resource = looksLikeResource(text)
    const queryChanged = !resource && !((text === '' && view.kind === 'list') || (view.kind === 'search' && view.query === text))
    if (!queryChanged && filterDraft === undefined) return
    const timer = setTimeout(() => {
      if (composingRef.current) return
      if (filterDraft !== undefined) {
        onScopeChange(activeSourceId, filterDraft.scope)
        filterDraftRef.current = undefined
        setFilterDraft(undefined)
      }
      if (queryChanged) setView(text === '' ? { kind: 'list' } : { kind: 'search', query: text })
    }, 500)
    return () => { clearTimeout(timer) }
  }, [query, composing, visible, activeSourceId, view, filterDraft, onScopeChange])

  const changeFilter = (next: JsonValue | undefined): void => {
    // Merge only changed filter keys into the latest draft, so two controls
    // changed in one tick cannot overwrite one another's values.
    const object = (value: JsonValue | undefined): Record<string, JsonValue> => typeof value === 'string'
      ? { repo: value } : value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    const previous = object(filterDraft === undefined ? activeScope : filterDraft.scope)
    const incoming = object(next)
    const merged = { ...object(filterDraftRef.current === undefined ? activeScope : filterDraftRef.current.scope) }
    for (const filter of active?.filters ?? []) {
      if (JSON.stringify(previous[filter.scopeKey]) === JSON.stringify(incoming[filter.scopeKey])) continue
      if (incoming[filter.scopeKey] === undefined) delete merged[filter.scopeKey]
      else merged[filter.scopeKey] = incoming[filter.scopeKey]!
    }
    const draft = { scope: Object.keys(merged).length === 0 ? undefined : merged }
    filterDraftRef.current = draft
    setFilterDraft(draft)
  }

  const navigateScope = (next: JsonValue | undefined, trail: readonly (JsonValue | undefined)[]): void => {
    if (activeSourceId === undefined) return
    abortRef.current?.abort()
    filterDraftRef.current = undefined
    setFilterDraft(undefined)
    setScopeTrail(trail)
    setQuery('')
    setView({ kind: 'list' })
    autoRunKey.current = undefined
    loadedKey.current = undefined
    onScopeChange(activeSourceId, next)
  }

  useEffect(() => { setRowMenu(null) }, [visible, activeSourceId, activeScope, view])

  // ── pins / insert / selection ──────────────────────────────────────────────

  const ensureClueId = useCallback(async (candidate: ClueCandidate): Promise<string> => {
    const ensured = await face.api.ensure(workspaceId, {
      sourceId: candidate.sourceId,
      typeId: candidate.typeId,
      locator: candidate.locator,
      title: candidate.title,
      info: candidate.info, subtitle: candidate.subtitle,
    })
    return ensured.clue.id
  }, [face, workspaceId])

  const pinnedIds = useMemo(() => new Set(pins.map(pin => pin.clueId)), [pins])
  const pinnedCandidateKeys = useMemo(() => new Set(
    [...titles.values()].filter(row => pinnedIds.has(row.clueId)).map(candidateKey),
  ), [titles, pinnedIds])

  const applyPins = useCallback((result: { pins: readonly { clueId: string }[]; revision: number }): void => {
    setPins(result.pins.map(pin => ({ clueId: pin.clueId })))
  }, [])

  const togglePin = useCallback(async (candidate: ClueCandidate): Promise<void> => {
    setBusy(true)
    setPendingAction({ key: candidateKey(candidate), kind: 'pin' })
    try {
      const clueId = candidate.clueId ?? await ensureClueId(candidate)
      // ensure (including a no-op match) can advance the workspace revision.
      // Invalidate the pin list first: the shared cache may hold the revision
      // from before that ensure, and an explicit pin must not spend it.
      invalidateClueRequests(workspaceId, 'clues.pins.list')
      const latest = await face.api.pinsList(workspaceId)
      const mutation = { clueId, expectedRevision: latest.revision }
      const wasPinned = pinnedIds.has(clueId) || pinnedCandidateKeys.has(candidateKey(candidate))
      applyPins(wasPinned
        ? await face.api.pinsRemove(workspaceId, mutation)
        : await face.api.pinsAdd(workspaceId, mutation))
      await refreshLocal()
    } catch (failure) {
      onNotice(clueErrorMessage(failure, t('cluePinFailed')))
    } finally {
      setBusy(false)
      setPendingAction(undefined)
    }
  }, [ensureClueId, face, workspaceId, pinnedIds, pinnedCandidateKeys, applyPins, refreshLocal, onNotice])

  const unpinById = useCallback(async (clueId: string): Promise<void> => {
    setBusy(true)
    try {
      // Same CAS contract as adding: never spend a revision cached before the
      // explicit unpin action.
      invalidateClueRequests(workspaceId, 'clues.pins.list')
      const latest = await face.api.pinsList(workspaceId)
      applyPins(await face.api.pinsRemove(workspaceId, { clueId, expectedRevision: latest.revision }))
      await refreshLocal()
    } catch (failure) {
      onNotice(clueErrorMessage(failure, t('cluePinFailed')))
    } finally {
      setBusy(false)
      setPendingAction(undefined)
    }
  }, [face, workspaceId, applyPins, refreshLocal, onNotice])

  const insertCandidate = useCallback(async (candidate: ClueCandidate): Promise<void> => {
    setBusy(true)
    setPendingAction({ key: candidateKey(candidate), kind: 'insert' })
    try {
      const clueId = candidate.clueId ?? await ensureClueId(candidate)
      if (!onInsertClue(clueId, candidate.title)) onNotice(t('clueInsertFailed'))
      else void refreshLocal()
    } catch (failure) {
      onNotice(clueErrorMessage(failure, t('clueInsertFailed')))
    } finally {
      setBusy(false)
      setPendingAction(undefined)
    }
  }, [ensureClueId, onInsertClue, refreshLocal, onNotice])

  const removeSelected = useCallback((candidate: ClueCandidate): void => {
    setSelected(current => {
      const next = new Map(current)
      next.delete(candidateKey(candidate))
      return next
    })
  }, [])

  const insertSelected = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      for (const candidate of selected.values()) {
        const clueId = candidate.clueId ?? await ensureClueId(candidate)
        if (!onInsertClue(clueId, candidate.title)) {
          onNotice(t('clueInsertFailed'))
          break
        }
        // Completed items leave the tray; a failure keeps the remaining work.
        removeSelected(candidate)
      }
      void refreshLocal()
    } catch (failure) {
      onNotice(clueErrorMessage(failure, t('clueInsertFailed')))
    } finally {
      setBusy(false)
      setPendingAction(undefined)
      // Successful chips focus the composer (the insert path owns that);
      // the tab must not pull focus back to its own search box.
    }
  }, [selected, ensureClueId, onInsertClue, refreshLocal, onNotice, removeSelected])

  /**
   * Open the single collection window with the current target snapshot. The
   * window owns destination choice and the CAS loop; the browser only mirrors
   * its pending set back onto the local tray.
   */
  const openCollection = useCallback((targets: readonly ClueCandidate[]): void => {
    if (targets.length === 0) return
    openClueCollectionWindow({
      windows,
      face,
      workspaceId,
      targets,
      ...(collectButtonRef.current === null ? {} : { anchor: collectButtonRef.current }),
      onNotice,
      onPendingChange: (pending) => {
        setSelected(new Map(pending.map(target => [candidateKey(target), target])))
      },
      onCommitted: () => {
        void refreshLocal()
        onPacksChanged?.()
      },
      onAdded: () => {
        void refreshLocal()
        onPacksChanged?.()
      },
    })
  }, [windows, face, workspaceId, onNotice, refreshLocal, onPacksChanged])

  const openRowMenu = (event: MouseEvent<HTMLElement>, candidate: ClueCandidate): void => {
    event.preventDefault()
    event.stopPropagation()
    if (!busy) setRowMenu({ candidate, x: event.clientX, y: event.clientY })
  }
  const rowMenuKey = (event: KeyboardEvent<HTMLElement>, candidate: ClueCandidate): void => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    event.stopPropagation()
    if (busy) return
    const box = event.currentTarget.getBoundingClientRect()
    setRowMenu({ candidate, x: box.left + 16, y: box.bottom })
  }
  const previewCandidate = (candidate: ClueCandidate): void => {
    const folder = folderScopeOf(candidate)
    if (folder !== undefined) { navigateScope(folder, [...scopeTrail, explicitScope]); return }
    onOpenDetail({ sourceId: candidate.sourceId, typeId: candidate.typeId,
      ...(candidate.clueId === undefined ? {} : { clueId: candidate.clueId }),
      locator: candidate.locator, title: candidate.title, info: candidate.info, subtitle: candidate.subtitle })
  }
  const copyCandidate = async (candidate: ClueCandidate): Promise<void> => {
    try {
      const text = sourceUrlOf(candidate.locator) ?? serializeClueToken('clue', candidate.clueId ?? await ensureClueId(candidate))
      if (!await writeClipboard(text)) onNotice(t('error'))
    } catch (failure) { onNotice(clueErrorMessage(failure, t('error'))) }
  }

  // ── render helpers ─────────────────────────────────────────────────────────

  const displayName = (sourceId: string): string => {
    const source = sources.find(candidate => candidate.sourceId === sourceId)
    return source === undefined ? sourceId : sourceLabel(source, displays)
  }

  const pinnedRows: readonly PinnedRow[] = pins
    .map(pin => titles.get(pin.clueId))
    .filter((row): row is PinnedRow => row !== undefined && row.sourceId === activeSourceId)

  const selectionToggle = (candidate: ClueCandidate): void => {
    const key = candidateKey(candidate)
    setSelected((current) => {
      const next = new Map(current)
      if (next.has(key)) next.delete(key)
      else next.set(key, candidate)
      return next
    })
  }

  const rowPinned = (candidate: ClueCandidate): boolean =>
    (candidate.clueId !== undefined && pinnedIds.has(candidate.clueId)) || pinnedCandidateKeys.has(candidateKey(candidate))

  const rawCandidates: readonly ClueCandidate[] =
    state.kind === 'page' ? state.result.items : state.kind === 'resolved' ? state.candidates : []
  // When pinned items are shown inline at the top of the browse list, omit
  // duplicates from the unpinned list below so each resource appears once.
  const candidates: readonly ClueCandidate[] =
    state.kind === 'page' && state.view.kind === 'list' && pinnedRows.length > 0
      ? rawCandidates.filter(candidate => !rowPinned(candidate))
      : rawCandidates

  const navigation = useListNavigation<HTMLDivElement>([
    ...pinnedRows.map(row => `pin:${row.clueId}`),
    ...candidates.map(candidateKey),
  ])

  const hasNext = state.kind === 'page' && state.result.nextCursor !== undefined
  const loadMore = useCallback((): void => {
    const current = stateRef.current
    if (current.kind !== 'page' || current.result.nextCursor === undefined || requestBusy.current) return
    void run(current.view, current.result.nextCursor, true)
  }, [run])
  useScrollLoad({ scrollRef: resultScrollRef, sentinelRef, enabled: visible,
    hasMore: hasNext && moreError === null, loading: moreLoading || state.kind === 'loading',
    onLoad: loadMore, version: state.kind === 'page' ? `${state.result.items.length}:${state.result.nextCursor ?? ''}` : state.kind })
  const summary = active === undefined ? undefined : scopeSummary(active.sourceId, state.kind === 'page' ? state.result.effectiveScope ?? activeScope : activeScope)
  const showScopeEditor = scopeOpen
  const filters = active === undefined ? undefined : resourceFilterState(active,
    filterDraft === undefined ? activeScope : filterDraft.scope, view.kind === 'search' ? 'search' : 'list')

  return (
    <>
    <section className={css.browser} aria-label={t('clueViewBrowse')}>
      <div className={css.browserToolbar} id={headingId}>
        <SourceNavigation sources={enabled} displays={displays} activeId={active?.sourceId ?? ''} onChange={selectSource} />
        {scopeTrail.length > 0 && (
          <IconButton
            size="sm"
            data-clue-scope-up
            label={t('clueBrowserScopeUp' as import('../../locales.ts').CopyKey)}
            onClick={() => { navigateScope(scopeTrail[scopeTrail.length - 1], scopeTrail.slice(0, -1)) }}
            icon={<IconChevronLeftOutlineRegular size={14} />}
          />
        )}
        {active !== undefined && active.sourceId !== BUILTIN_SOURCE_IDS.feishuTasks && (
          <button
            ref={scopeButtonRef}
            type="button"
            className={css.scopeButton}
            aria-label={`${t('clueBrowserScopeEdit')}: ${summary ?? t('clueBrowserScopeNeeded')}`}
            title={`${t('clueBrowserScopeHeading')}: ${summary ?? t('clueBrowserScopeNeeded')}`}
            aria-haspopup="dialog"
            onClick={() => { setScopeOpen(true) }}
          >
            <span>{summary ?? t('clueBrowserScopeEdit')}</span>
            <IconChevronRightOutlineRegular size={12} />
          </button>
        )}
        <span className={css.commandSpacer} />
        {active !== undefined && (
          <ResourceFilters
            source={active}
            scope={filterDraft === undefined ? activeScope : filterDraft.scope}
            mode={view.kind === 'search' ? 'search' : 'list'}
            onChange={changeFilter}
          />
        )}
        <IconButton size="sm" active={selectionMode} data-clue-selection-mode disabled={busy}
          label={t('clueBrowserSelectionMode')} onClick={() => { setSelectionMode(value => !value) }}
          icon={<IconChecklistOutlineRegular size={14} />} />
        <IconButton size="sm"
          label={refresh.kind === 'refreshing' ? t('clueBrowserRefreshing') : t('refresh')}
          title={refresh.kind === 'refreshing' ? t('clueBrowserRefreshing') : t('refresh')}
          aria-busy={refresh.kind === 'refreshing' ? 'true' : undefined}
          data-clue-refresh-status={refresh.kind === 'refreshing' ? 'refreshing' : undefined}
          disabled={state.kind === 'loading' || refresh.kind === 'refreshing'}
          onClick={() => {
            // Refresh only the page family; pack/pin/library/status reads stay
            // warm and are invalidated by their own actions.
            invalidateClueRequests(workspaceId,
              ['clues.list', 'clues.search', 'clues.resolve', 'clues.defaultScope'])
            if (explicitScope === undefined && (activeSourceId === BUILTIN_SOURCE_IDS.githubIssues || activeSourceId === BUILTIN_SOURCE_IDS.githubPulls)) {
              // The auto loader will issue the page read after the fresh
              // default range lands; clear the coalescing key so it does.
              autoRunKey.current = undefined
              defaults.refresh()
            } else void run(view, undefined, false, { force: true })
          }}
          icon={refresh.kind === 'refreshing'
            ? <LoadingIndicator inline size={12} label="" role="presentation" />
            : <IconRefreshOutlineRegular size={14} />} />
      </div>

      {/* First catalogue read owns the empty body; a background catalogue
          refresh must not insert a row above the search box. */}
      {cataloguePhase === 'loading' && sources.length === 0 && <LoadingIndicator className={css.stateLine} />}
      {cataloguePhase === 'error' && sources.length === 0 && (
        <ErrorBlock message={catalogueError ?? t('error')} retryLabel={t('retry')} onRetry={() => { void loadCatalogue() }} />
      )}
      {cataloguePhase === 'ready' && enabled.length === 0 && (
        <EmptyState tone="well" title={t('clueBrowserAllDisabled')}
          actions={<ActionButton size="sm" onClick={onOpenSettings}>{t('clueBrowserOpenSettings')}</ActionButton>} />
      )}

      {enabled.length > 0 && active !== undefined && (
        <div className={css.browserBody} onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.repeat || busy) return
      if (event.key === 'Escape' && selected.size > 0 && !scopeOpen && rowMenu === null) {
        event.preventDefault(); event.stopPropagation()
        setSelected(new Map()); queryInputRef.current?.focus()
      }
    }}>
          <div className={css.browserMain}>
            <div className={css.queryRow}>
              <SearchField
                ref={queryInputRef}
                className={css.searchField}
                value={query}
                placeholder={t('clueBrowserSearchPlaceholder')}
                aria-label={t('clueBrowserSearchPlaceholder')}
                onChange={event => { setQuery(event.target.value) }}
                onCompositionStart={() => { composingRef.current = true; setComposing(true) }}
                onCompositionEnd={() => { composingRef.current = false; setComposing(false) }}
                onKeyDown={event => {
                  if (event.defaultPrevented || composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
                  if (event.key === 'Escape' && query !== '') {
                    event.preventDefault(); event.stopPropagation()
                    setQuery(''); setView({ kind: 'list' })
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    onSubmitQuery()
                  }
                }}
                trailing={query !== ''
                  ? (
                    <>
                      <button type="button" className={css.clearSearch} aria-label={t('clueClearSearch')} title={t('clueClearSearch')}
                        onClick={() => { setQuery(''); setView({ kind: 'list' }); queryInputRef.current?.focus() }}>
                        <IconCloseOutlineRegular size={12} />
                      </button>
                      <button type="button" className={css.querySubmit} onClick={onSubmitQuery}
                        aria-label={looksLikeResource(query.trim()) ? t('clueBrowserResolveAction') : t('clueBrowserSearchAction')}
                        title={looksLikeResource(query.trim()) ? t('clueBrowserResolveAction') : t('clueBrowserSearchAction')}>
                        <IconChevronRightOutlineRegular size={14} />
                      </button>
                    </>
                  )
                  : undefined}
              />
            </div>
            {/* Setup is actionable below the search box, never a checking row
                that would move the search box while a probe is in flight. */}
            <SourceReadiness key={active.sourceId} source={active}
              display={displays.find(display => display.sourceId === active.sourceId)}
              windows={windows} visible={visible}
              onReady={() => { void run(view, undefined, false, { auto: true }) }} />
            {cataloguePhase === 'error' && sources.length > 0 && (
              <ErrorBlock message={catalogueError ?? t('error')} retryLabel={t('retry')} onRetry={() => { void loadCatalogue() }} />
            )}
            {showScopeEditor && active.sourceId !== BUILTIN_SOURCE_IDS.feishuTasks && (
              <HostedWindow windows={windows} id={`clue-scope:${workspaceId}:${headingId}`}
                title={t('clueBrowserScopeHeading')} open={showScopeEditor} onOpenChange={setScopeOpen} anchor={scopeButtonRef.current} size="compact">
              <form
                data-clue-scope-window
                className={css.scopeTask}
                onSubmit={(event) => { event.preventDefault(); onScopeApply() }}
              >
                <div className={css.scopeFields}>
                <ScopeFields sourceId={active.sourceId} form={form} onChange={(next) => { setForm(next) }} />
                {scopeError !== null && <span className={css.fieldError} role="alert">{scopeError}</span>}
                </div>
                <ActionFooter
                  bleed
                  start={(
                    <ActionButton size="sm" variant="ghost" onClick={() => {
                      onScopeChange(active.sourceId, undefined); defaults.refresh(); setScopeOpen(false)
                    }}>{t('clueScopeUseDefault')}</ActionButton>
                  )}
                  end={(
                    <>
                      <ActionButton size="sm" onClick={() => { setScopeOpen(false); setScopeError(null) }}>
                        {t('cancel')}
                      </ActionButton>
                      <ActionButton size="sm" type="submit" variant="primary">{t('clueBrowserScopeApply')}</ActionButton>
                    </>
                  )}
                />
              </form>
              </HostedWindow>
            )}

            {(pinsPhase === 'error' || pinsRetrying) && (
              <ErrorBlock message={t('clueBrowserPinsFailed')} busy={pinsRetrying}
                retryLabel={pinsRetrying ? t('loading') : t('retry')}
                onRetry={(event) => {
                  const retryButton = event.currentTarget
                  setPinsRetrying(true)
                  void refreshLocal().then(loaded => {
                    setPinsRetrying(false)
                    if (loaded && visibleRef.current && document.activeElement === retryButton) queryInputRef.current?.focus()
                  })
                }} />
            )}

            <div ref={resultScrollRef} className={css.resultArea} data-clue-browser-state={state.kind}
              data-clue-refresh={refresh.kind}
              data-clue-has-next={hasNext ? 'true' : 'false'}
              data-clue-more-loading={moreLoading ? 'true' : 'false'}
              data-clue-request-busy={requestBusy.current ? 'true' : 'false'}
              onKeyDown={event => {
                if (event.defaultPrevented || event.repeat || busy || event.key !== 'Escape') return
                if (selected.size === 0 || scopeOpen || rowMenu !== null) return
                event.preventDefault()
                event.stopPropagation()
                setSelected(new Map())
                queryInputRef.current?.focus()
              }}
              aria-busy={moreLoading || state.kind === 'loading' || refresh.kind === 'refreshing'}
              role="region" aria-label={t('clueBrowserHeading')} tabIndex={0}>
              <div
                ref={navigation.ref}
                className={css.listContainer}
                onKeyDown={navigation.onKeyDown}
                onFocusCapture={navigation.onFocusCapture}
                onClickCapture={navigation.onClickCapture}
              >
              {pinnedRows.length > 0 && (
                <div className={css.pinsInline} data-clue-pins-region>
                  <ul className={css.pinList} aria-label={t('clueBrowserPinsHeading')}>
                    {pinnedRows.map((row, index) => {
                      const rowCandidate: ClueCandidate = {
                        sourceId: row.sourceId,
                        typeId: row.typeId,
                        locator: row.locator,
                        title: row.title,
                        clueId: row.clueId,
                        ...(row.info === undefined ? {} : { info: row.info }),
                        ...(row.subtitle === undefined ? {} : { subtitle: row.subtitle }),
                      }
                      const key = candidateKey(rowCandidate)
                      return (
                        <li
                          key={row.clueId}
                          data-pinned="true"
                          onContextMenu={event => { openRowMenu(event, rowCandidate) }}
                          onKeyDown={event => { rowMenuKey(event, rowCandidate) }}
                        >
                          <ListRow
                            selected={selected.has(key)}
                            title={row.title}
                            titleLabel={row.title}
                            titleAs="button"
                            primary={navigation.itemTabIndex(index) === 0}
                            onTitleClick={() => { onOpenDetail({ ...row }) }}
                            leading={<>
                              {selectionMode && (
                                <label className={css.rowSelection}>
                                  <Checkbox
                                    checked={selected.has(key)}
                                    disabled={busy}
                                    aria-label={t('clueBrowserSelectRow', { title: row.title })}
                                    onChange={() => { selectionToggle(rowCandidate) }}
                                  />
                                </label>
                              )}
                              <span className={css.rowGlyph} aria-hidden="true">{resourceIcon(row, displays)}</span>
                            </>}
                            subtitle={row.info === undefined ? undefined : <ResourceInlineMeta info={row.info} />}
                            meta={<span className={css.pinnedBadge} title={t('clueBrowserPinnedBadge')}><IconPinFillRegular size={12} /></span>}
                            actions={<>
                              <IconButton size="sm" label={t('clueBrowserInsertRow', { title: row.title })} title={t('clueBrowserInsert')}
                                disabled={busy} onClick={() => { if (!onInsertClue(row.clueId, row.title)) onNotice(t('clueInsertFailed')) }}
                                icon={<IconContextInjectionOutlineRegular size={14} />} />
                              <IconButton size="sm" data-clue-pin="true" label={t('clueBrowserUnpinRow', { title: row.title })} title={t('clueBrowserUnpin')}
                                disabled={busy} onClick={() => { void unpinById(row.clueId) }}
                                icon={<IconPinFillRegular size={14} />} />
                              <IconButton size="sm" label={t('clueBrowserMoreRow', { title: row.title })} disabled={busy}
                                aria-haspopup="menu" aria-expanded={rowMenu !== null && candidateKey(rowMenu.candidate) === key}
                                icon={<IconEllipsisOutlineRegular size={14} />}
                                onClick={event => {
                                  const box = event.currentTarget.getBoundingClientRect()
                                  setRowMenu({ candidate: rowCandidate, x: box.left, y: box.bottom })
                                }} />
                            </>}
                          />
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
              {refresh.kind === 'error' && (
                <ErrorBlock data-clue-refresh-status="error" message={refresh.message} retryLabel={t('retry')}
                  onRetry={() => {
                const last = lastRequestRef.current
                void run(last.view, last.cursor, false, { force: true })
              }} />
              )}
              {state.kind === 'idle' && <EmptyState title={t('clueBrowserSearchNeeded')} />}
              {state.kind === 'loading' && <LoadingIndicator className={css.stateLine} />}
              {state.kind === 'needs-scope' && (
                <EmptyState title={state.reason === 'search' ? t('clueBrowserSearchScopeNeeded') : t('clueScopeNoDefault')}
                  actions={<ActionButton size="sm" onClick={() => { setScopeOpen(true) }}>{t('clueBrowserScopeEdit')}</ActionButton>} />
              )}
              {state.kind === 'unsupported' && (
                <EmptyState title={state.reason === 'no-list' ? t('clueBrowserUnsupported') : t('clueBrowserSearchUnsupported')} />
              )}
              {state.kind === 'error' && (
                <ErrorBlock message={state.message} retryLabel={t('retry')}
                  onRetry={() => {
                const last = lastRequestRef.current
                void run(last.view, last.cursor, false, { force: true })
              }} />
              )}
              {state.kind === 'page' && state.result.items.length === 0 && (
                <EmptyState
                  icon={<IconSearchOutlineRegular size={24} />}
                  title={state.view.kind === 'search' || filters?.active === true ? t('clueBrowserNoResults') : t('clueBrowserEmpty')}
                  actions={<>
                    {filters?.active === true && <ActionButton size="sm" onClick={() => { changeFilter(filters.clearedScope) }}>{t('clueClearFilters')}</ActionButton>}
                    {state.view.kind === 'search' && <ActionButton size="sm"
                      onClick={() => { setQuery(''); setView({ kind: 'list' }); queryInputRef.current?.focus() }}>{t('clueClearSearch')}</ActionButton>}
                  </>}
                />
              )}
              {state.kind === 'resolved' && (
                <div className={css.resolveHead}>
                  <span>{t('clueBrowserResolveHeading')}</span>
                  <span className={css.scopeHint}>{t('clueBrowserResolveHint')}</span>
                </div>
              )}
              {state.kind === 'resolved' && state.candidates.length === 0 && (
                <EmptyState title={t('clueBrowserResolveEmpty')} />
              )}

              {state.kind === 'page' && state.view.kind === 'search'
                && activeSourceId === BUILTIN_SOURCE_IDS.feishuDocs
                && activeScope === undefined && (
                <div className={css.scopeHint} data-clue-global-search>
                  {t('clueBrowserSearchGlobalHint')}
                </div>
              )}

              {candidates.length > 0 && (
                <ul className={css.resultList}>
                  {candidates.map((candidate, index) => {
                    const pinned = rowPinned(candidate)
                    const key = candidateKey(candidate)
                    return (
                      <li key={key} data-pinned={pinned ? 'true' : 'false'} data-pending={pendingAction?.key === key || undefined}
                        onContextMenu={event => { openRowMenu(event, candidate) }}
                        onKeyDown={event => { rowMenuKey(event, candidate) }}>
                        <ListRow
                          selected={selected.has(key)}
                          title={candidate.title}
                          titleLabel={candidate.title}
                          titleAs="button"
                          primary={navigation.itemTabIndex(pinnedRows.length + index) === 0}
                          onTitleClick={() => { previewCandidate(candidate) }}
                          leading={<>
                            {selectionMode && <label className={css.rowSelection}>
                              <Checkbox
                                checked={selected.has(key)}
                                disabled={busy}
                                aria-label={t('clueBrowserSelectRow', { title: candidate.title })}
                                onChange={() => { selectionToggle(candidate) }}
                              />
                            </label>}
                            <span className={css.rowGlyph} aria-hidden="true">{resourceIcon(candidate, displays)}</span>
                          </>}
                          subtitle={<>
                            <ResourceInlineMeta info={candidate.info} />
                            {candidate.info?.state === undefined && candidate.info?.author === undefined && candidate.info?.branches === undefined && candidate.subtitle !== candidate.title ? candidate.subtitle : null}
                          </>}
                          meta={pinned ? <span className={css.pinnedBadge} title={t('clueBrowserPinnedBadge')}><IconPinFillRegular size={12} /></span> : undefined}
                          actions={<>
                            <IconButton
                              size="sm"
                              label={t('clueBrowserInsertRow', { title: candidate.title })}
                              title={t('clueBrowserInsert')}
                              disabled={busy}
                              onClick={() => { void insertCandidate(candidate) }}
                              icon={pendingAction?.key === key && pendingAction.kind === 'insert'
                                ? <LoadingIndicator inline size={14} label="" role="presentation" /> : <IconContextInjectionOutlineRegular size={14} />}
                            />
                            <IconButton size="sm" label={t('clueBrowserMoreRow', { title: candidate.title })} disabled={busy}
                              aria-haspopup="menu" aria-expanded={rowMenu !== null && candidateKey(rowMenu.candidate) === key}
                              icon={<IconEllipsisOutlineRegular size={14} />}
                              onClick={event => {
                                const box = event.currentTarget.getBoundingClientRect()
                                setRowMenu({ candidate, x: box.left, y: box.bottom })
                              }} />
                          </>}
                        />
                      </li>
                    )
                  })}
                </ul>
              )}
              <div ref={sentinelRef} className={css.loadSentinel} data-clue-result-sentinel>
                {moreLoading && <LoadingIndicator inline />}
                {moreError !== null && <ErrorBlock message={moreError} retryLabel={t('retry')} onRetry={loadMore} />}
              </div>
              {state.kind === 'page' && state.result.limited === true && <div className={css.scopeHint}>
                {t('clueBrowserLimited')}
              </div>}
              </div>
            </div>

            {(selectionMode || selected.size > 0) && (
              <>
                <div className={css.batchBar} role="region" aria-label={t('clueBrowserSelected', { n: selected.size })} aria-busy={busy}>
                  <Disclosure
                    className={css.selectionReview}
                    summaryAriaLabel={t('clueSelectionReview')}
                    data-clue-selection-review
                    summary={<span className={css.batchCount} role="status">{t('clueBrowserSelected', { n: selected.size })}</span>}
                  >
                    <ul className={css.selectedList}>
                      {[...selected.values()].map(candidate => <li key={candidateKey(candidate)}>
                        <span className={css.selectedCopy}><span title={candidate.title}>{candidate.title}</span><small>{displayName(candidate.sourceId)}</small></span>
                        <IconButton size="sm" label={t('clueSelectionRemove', { title: candidate.title })} disabled={busy}
                          icon={<IconCloseOutlineRegular size={14} />} onClick={() => { removeSelected(candidate) }} />
                      </li>)}
                    </ul>
                  </Disclosure>
                  <div className={css.selectionActions} data-clue-selection-actions>
                    <ActionButton ref={collectButtonRef} size="sm" disabled={busy || selected.size === 0} aria-haspopup="dialog"
                      onClick={() => { openCollection([...selected.values()]) }}>
                      <IconPlusOutlineRegular size={14} />{t('clueBrowserAddToPack')}
                    </ActionButton>
                    <ActionButton size="sm" variant="primary" disabled={busy || selected.size === 0} onClick={() => { void insertSelected() }}>
                      <IconContextInjectionOutlineRegular size={14} />{t('clueBrowserInsertSelected')}
                    </ActionButton>
                  </div>
                  <IconButton size="sm" disabled={busy} label={t('cancel')} title={t('cancel')}
                    onClick={() => { setSelected(new Map()); setSelectionMode(false); queryInputRef.current?.focus() }}
                    icon={<IconCloseOutlineRegular size={14} />} />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
    <Menu open={rowMenu !== null} onClose={() => { setRowMenu(null) }} items={[
      { id: 'preview', label: rowMenu !== null && folderScopeOf(rowMenu.candidate) !== undefined ? t('clueBrowserEnterFolder' as import('../../locales.ts').CopyKey) : t('preview'), icon: <IconInspectOutlineRegular size={14} /> },
      { id: 'insert', label: t('clueBrowserInsert'), icon: <IconContextInjectionOutlineRegular size={14} />, disabled: busy },
      { id: 'collect', label: t('clueBrowserAddToPack'), icon: <IconPlusOutlineRegular size={14} />, disabled: busy },
      { id: 'pin', label: rowMenu !== null && rowPinned(rowMenu.candidate) ? t('clueBrowserUnpin') : t('clueBrowserPin'),
        icon: <IconPinOutlineRegular size={14} />, disabled: busy },
      ...(rowMenu?.candidate.sourceId === BUILTIN_SOURCE_IDS.files ? [{ id: 'reveal', label: t('clueBrowserRevealTree' as import('../../locales.ts').CopyKey), disabled: props.onRevealFile === undefined }] : []),
      { type: 'separator', id: 'source-separator' },
      ...(rowMenu !== null && sourceUrlOf(rowMenu.candidate.locator) !== undefined
        ? [{ id: 'source', label: t('clueDetailOpenSource') }] : []),
      { id: 'copy', label: t('copy'), icon: <IconCopyOutlineRegular size={14} /> },
    ]} onSelect={id => {
      const candidate = rowMenu?.candidate
      setRowMenu(null)
      if (candidate === undefined) return
      if (id === 'preview') previewCandidate(candidate)
      else if (id === 'insert') void insertCandidate(candidate)
      else if (id === 'pin') void togglePin(candidate)
      else if (id === 'reveal') props.onRevealFile?.(candidate)
      else if (id === 'copy') void copyCandidate(candidate)
      else if (id === 'source') {
        const url = sourceUrlOf(candidate.locator)
        if (url !== undefined) window.open(url, '_blank', 'noopener,noreferrer')
      } else if (id === 'collect') {
        const key = candidateKey(candidate)
        const next = selected.has(key) ? selected : new Map(selected).set(key, candidate)
        setSelected(next)
        openCollection([...next.values()])
      }
    }} portal compact align="start"
      anchorPoint={rowMenu === null ? undefined : { x: rowMenu.x, y: rowMenu.y }} anchor={<span />} />
    </>
  )
}
