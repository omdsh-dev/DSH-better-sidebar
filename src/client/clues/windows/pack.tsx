/**
 * The clue pack management window (S9).
 *
 * One S6 collection window owns the whole pack lifecycle so the Tab page stays
 * a two-region browser:
 * - the pack name, edited into a draft and saved explicitly (Save/Cancel only
 *   appear while the name actually differs);
 * - its members with source glyph, title and unresolved state;
 * - the workspace binding panel, collapsed by default;
 * - an add-member page INSIDE the same window: the source choice, the search
 *   text and the cross-page selection all stay mounted while the reader picks
 *   members, and leaving the page changes no member. Keyword search runs after
 *   a 300ms trailing pause (URLs/paths stay on Enter), the candidate list grows
 *   on scroll (real cursor pages, deduped, with a bottom Retry when a later
 *   page fails) instead of carrying Prev/Next controls.
 *
 * Member and candidate rows share one cursor/keyboard context menu built on the
 * host `Menu`; it closes with its page and never owns a second browser.
 *
 * Invariants (S1/S6/S9):
 * - removing a member deletes neither the resource nor any inserted reference;
 * - a binding auto-provides references to NEW sessions and grants no access;
 * - a stale write is a CAS conflict: the draft is kept, the pack is re-read and
 *   the surface never claims the save landed.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import {
  IconContextInjectionOutlineRegular,
  IconInspectOutlineRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  IconShareOutlineRegular,
  IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  Clue,
  ClueBinding,
  ClueCandidate,
  CluePack,
  ClueSourceDescriptor,
  ClueSourceDisplayDescriptor,
  CluesBindingsResult,
  CluesLibraryResult,
  CluesPacksResult,
  CluesSourcesCatalogResult,
  JsonValue,
} from '../../../clues/types.ts'
import { BUILTIN_SOURCE_IDS } from '../../../clues/types.ts'
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
} from '../tab/browser-shared.tsx'
import type { BetterSidebarCluesClientFace } from '../registry.ts'
import type { BetterSidebarWindowsClientFace, WindowHandle } from '../../windows/types.ts'
import { categoryOf, clueErrorMessage } from '../copy.ts'
import { cluesApi, invalidateClueRequests, peekClueRequest, subscribeClueDataChanges } from '../api.ts'
import { openShareWindow } from './share.tsx'
import { openClueDetailWindow } from './detail.tsx'
import { isGithubClueSource } from '../default-scope.ts'
import { ResourceInlineMeta } from '../resource-summary.tsx'
import { ResourceFilters } from '../resource-filters.tsx'
import { SourceReadiness } from '../sources/readiness.tsx'
import { SelectMenu } from '../../ui/SelectMenu.tsx'
import { LoadingIndicator } from '../../ui/LoadingIndicator.tsx'
import {
  ActionButton, ActionFooter, Checkbox, EmptyState, ErrorBlock, IconButton, Menu, Notice, TextInput,
} from '../../ui/index.ts'
import { useScrollLoad } from '../../ui/use-scroll-load.ts'
import { t } from '../../locales.ts'
import type { ClueDetailTarget } from './detail.tsx'
import css from './pack.module.css'

/** The workspace the pack belongs to (display only; never used to guess). */
interface PackWorkspaceChoice {
  readonly workspaceId: string
  readonly title: string
}

/** The mutable guard the window's close handler reads. */
export interface PackDraftGuard {
  dirty: boolean
  /** Called by the page whenever the draft dirtiness changes. */
  notify?(dirty: boolean): void
}

/** Options of {@link openPackManagementWindow}. */
interface PackManagementOptions {
  readonly windows: BetterSidebarWindowsClientFace
  readonly workspaceId: string
  readonly face: BetterSidebarCluesClientFace
  readonly workspaces: readonly PackWorkspaceChoice[]
  readonly pack: CluePack
  onInsertClue(clueId: string, title: string): boolean
  onInsertPack(pack: CluePack): boolean
  onNotice(message: string): void
  /** Collection bridge supplied by the tab (same one the detail window uses). */
  onAddToPack?(target: ClueDetailTarget): void
  /** Persisted per-source ranges (same document the tab browser writes). */
  readonly scopes?: Readonly<Record<string, JsonValue | undefined>>
  /** Persist one explicitly chosen range (same shape as the tab browser). */
  onScopeChange?(sourceId: string, scope: JsonValue | undefined): void
}

/** One member row as the panel renders it. */
interface MemberRow {
  readonly clue: Clue
  readonly readable: boolean
}

/** One add-member page request (same three jobs as the tab browser). */
type AddView =
  | { readonly kind: 'list' }
  | { readonly kind: 'search'; readonly query: string }
  | { readonly kind: 'resolve'; readonly text: string }

/** One open row context menu (cursor or keyboard position). */
type RowMenu =
  | { readonly kind: 'member'; readonly row: MemberRow; readonly x: number; readonly y: number }
  | { readonly kind: 'candidate'; readonly candidate: ClueCandidate; readonly x: number; readonly y: number }

const ADD_PAGE_LIMIT = 20

/** Trailing wait before a keyword is searched while the reader is still typing. */
const ADD_SEARCH_DEBOUNCE_MS = 300

/** Cursor position of a right-click row menu. */
function contextMenuPoint(event: ReactMouseEvent<HTMLElement>): { x: number; y: number } {
  event.preventDefault()
  event.stopPropagation()
  return { x: event.clientX, y: event.clientY }
}

/**
 * Keyboard path of the same menu: the ContextMenu key, or Shift+F10.
 * @param event - row keydown.
 * @returns the row-local anchor point, or undefined when another key fired.
 */
function keyboardMenuPoint(event: ReactKeyboardEvent<HTMLElement>): { x: number; y: number } | undefined {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return undefined
  event.preventDefault()
  event.stopPropagation()
  const rect = event.currentTarget.getBoundingClientRect()
  return { x: rect.left + Math.min(24, rect.width / 2), y: rect.top + Math.min(rect.height, 24) }
}

/**
 * Append one cursor page, dropping rows the reader already has on screen.
 * Cursor sources may return overlapping windows; the add page is a growing
 * list, so identity (source + type + locator) is the dedupe key.
 */
function mergeCandidates(
  current: readonly ClueCandidate[],
  incoming: readonly ClueCandidate[],
): ClueCandidate[] {
  if (incoming.length === 0) return [...current]
  const seen = new Set(current.map(candidateKey))
  const appended = incoming.filter((candidate) => {
    const key = candidateKey(candidate)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return appended.length === 0 ? [...current] : [...current, ...appended]
}

/** Member rows of a pack, resolving titles through the local library. */
function memberRowsOf(pack: CluePack, clues: readonly Clue[]): MemberRow[] {
  const clueById = new Map(clues.map(clue => [clue.id, clue]))
  return pack.members
    .map((id): MemberRow | undefined => {
      const clue = clueById.get(id)
      return clue === undefined ? undefined : { clue, readable: clue.unresolved === undefined }
    })
    .filter((row): row is MemberRow => row !== undefined)
}

/** The window id of one pack (a second open focuses the same surface). */
function packWindowId(packId: string): string {
  return `pack:${packId}`
}

/**
 * Open (or focus) the pack management window.
 * @param options - window host, clue face, the workspaces and the pack.
 */
export function openPackManagementWindow(options: PackManagementOptions): WindowHandle {
  const guard: PackDraftGuard = { dirty: false }
  const titleFor = (dirty: boolean): string =>
    dirty ? `${options.pack.name} · ${t('cluePackUnsaved')}` : options.pack.name
  const handle: WindowHandle = options.windows.open({
    id: packWindowId(options.pack.id),
    title: titleFor(false),
    size: 'collection',
    content: <PackManagementPage {...options} guard={guard} />,
    onBeforeClose: () => {
      if (!guard.dirty) return Promise.resolve(true)
      // Never refuse silently: the title bar carries the dirty marker and the
      // localized "unsaved name" suffix, so the reader sees what blocks the
      // close and can save or Cancel in the surface below.
      handle.update({ dirty: true, title: titleFor(true) })
      return Promise.resolve(false)
    },
  })
  guard.notify = (dirty: boolean): void => {
    handle.update({ dirty, title: titleFor(dirty) })
  }
  return handle
}

/** The interactive pack management surface. */
export function PackManagementPage(
  props: PackManagementOptions & { readonly guard: PackDraftGuard },
): ReactNode {
  const { workspaceId, face, workspaces, guard } = props
  const initialBindingTarget = workspaces[0]?.workspaceId ?? ''
  /**
   * Remounting a pack window paints the activation's warm library/pack/
   * catalogue reads synchronously; only a cold or invalidated family shows a
   * loader. The reads themselves still come from the shared cache below.
   */
  const [seeded] = useState(() => {
    if (face.api !== cluesApi) return undefined
    const library = peekClueRequest<CluesLibraryResult>('clues.clues', workspaceId, { workspaceId })
    const packs = peekClueRequest<CluesPacksResult>('clues.packs.list', workspaceId, { workspaceId })
    const sources = peekClueRequest<CluesSourcesCatalogResult>('clues.sources', undefined, {})
    return library === undefined || packs === undefined || sources === undefined
      ? undefined
      : { library, packs, sources }
  })
  const initialPackOf = (seed: typeof seeded): CluePack =>
    seed?.packs.packs.find(candidate => candidate.id === props.pack.id) ?? props.pack
  const [pack, setPack] = useState(() => initialPackOf(seeded))
  const [name, setName] = useState(() => initialPackOf(seeded).name)
  const [members, setMembers] = useState<readonly MemberRow[]>(() => seeded === undefined
    ? []
    : memberRowsOf(initialPackOf(seeded), seeded.library.clues))
  const [seededBindings] = useState(() => face.api === cluesApi && initialBindingTarget !== ''
    ? peekClueRequest<CluesBindingsResult>('clues.bindings.list', initialBindingTarget, {
        workspaceId: initialBindingTarget,
      })
    : undefined)
  const [bindings, setBindings] = useState<readonly ClueBinding[]>(() =>
    (seededBindings?.bindings ?? []).filter(binding =>
      binding.target.kind === 'pack' && binding.target.packId === props.pack.id))
  const [bindingTarget, setBindingTarget] = useState<string>(initialBindingTarget)
  const [bindingBusy, setBindingBusy] = useState(false)
  const [bindingsError, setBindingsError] = useState(false)
  const [bindingsAttempt, setBindingsAttempt] = useState(0)
  const [sources, setSources] = useState<readonly ClueSourceDescriptor[]>(() => seeded?.sources.sources ?? [])
  const [displays, setDisplays] = useState<readonly ClueSourceDisplayDescriptor[]>(() => face.getSourceDisplays())
  const [loading, setLoading] = useState(seeded === undefined)
  /** Whether a warm library/pack/catalogue read has already painted the page. */
  const loadedOnce = useRef(seeded !== undefined)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [nameSaved, setNameSaved] = useState(false)
  const renameBusy = useRef(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addSourceId, setAddSourceId] = useState<string | null>(null)
  const [addQuery, setAddQuery] = useState('')
  const [addCandidates, setAddCandidates] = useState<readonly ClueCandidate[]>([])
  const [addNext, setAddNext] = useState<string | undefined>(undefined)
  const [addLoading, setAddLoading] = useState(false)
  const [addMoreLoading, setAddMoreLoading] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [addMoreError, setAddMoreError] = useState<string | null>(null)
  const [addNeedsScope, setAddNeedsScope] = useState<'list' | 'search' | null>(null)
  const [addView, setAddView] = useState<AddView>({ kind: 'list' })
  const [addSelected, setAddSelected] = useState<ReadonlyMap<string, ClueCandidate>>(new Map())
  const [addScopes, setAddScopes] = useState<Readonly<Record<string, JsonValue | undefined>>>(
    () => props.scopes ?? {},
  )
  const [automaticScopes, setAutomaticScopes] = useState<Readonly<Record<string, JsonValue>>>({})
  const [addScopeOpen, setAddScopeOpen] = useState(false)
  const [addScopeForm, setAddScopeForm] = useState<ScopeForm>(EMPTY_FORM)
  const [addScopeError, setAddScopeError] = useState<string | null>(null)
  /** IME composition in the add-page search box: never auto-search mid-word. */
  const [composing, setComposing] = useState(false)
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null)
  const addAbort = useRef<AbortController | undefined>(undefined)
  /** Monotonic request identity: a response from an older generation is inert. */
  const addRequestSeq = useRef(0)
  /** Cursors already consumed by this view; a repeat would loop forever. */
  const addSeenCursors = useRef(new Set<string>())
  /** Synchronous latch for near-bottom triggers (state lands one render later). */
  const addLoadMoreLock = useRef(false)
  const addScrollRef = useRef<HTMLDivElement | null>(null)
  const addSentinelRef = useRef<HTMLDivElement | null>(null)
  /** The pending trailing keyword search of the add-page box. */
  const addSearchTimer = useRef<number | undefined>(undefined)
  /** The last keyword auto-searched: editing back to it must not re-query. */
  const lastAutoSearch = useRef('')
  const addViewRef = useRef<AddView>(addView)
  addViewRef.current = addView
  const sourcesRef = useRef(sources)
  sourcesRef.current = sources
  /** The current pack, readable from the shared data-change listener. */
  const packRef = useRef(pack)
  packRef.current = pack
  /** Monotonic identity for one silent member-library refresh. */
  const memberRefreshSeq = useRef(0)

  /**
   * Refresh ONLY the member rows through the local clue library.
   *
   * A detail save / ensure invalidates that library and publishes a shared
   * data-change event. The pack window adopts it without a loader, without
   * re-reading the external pack list or the source catalogue, and without
   * remounting the member list.
   */
  const refreshMembers = useCallback(async (): Promise<void> => {
    if (face.api !== cluesApi) return
    const token = ++memberRefreshSeq.current
    try {
      const library = await face.api.clues(workspaceId)
      if (token !== memberRefreshSeq.current) return
      setMembers(memberRowsOf(packRef.current, library.clues))
    } catch {
      // A failed silent refresh is not an empty pack: keep the current rows.
    }
  }, [face, workspaceId])

  // ONE shared business bus: a library change from a detail save/ensure updates
  // this open window's member rows in place. An auth-boundary change first drops
  // rows that may describe the previous identity, then re-reads the local
  // library. The pack list, sources and the add page are intentionally untouched.
  useEffect(() => {
    if (face.api !== cluesApi) return
    const unsubscribe = subscribeClueDataChanges((change) => {
      if (change.workspaceId !== undefined && change.workspaceId !== workspaceId) return
      if (change.kind === 'auth') setMembers([])
      void refreshMembers()
    })
    return () => {
      memberRefreshSeq.current += 1
      unsubscribe()
    }
  }, [face, workspaceId, refreshMembers])

  /**
   * Drop the add page's data and invalidate any in-flight request. Used when
   * the source, query or range changes: the old rows belong to another view
   * and a late response must not append itself to the new one.
   */
  const resetAdd = useCallback((): void => {
    addRequestSeq.current += 1
    addAbort.current?.abort()
    addAbort.current = undefined
    addSeenCursors.current.clear()
    addLoadMoreLock.current = false
    setAddCandidates([])
    setAddNext(undefined)
    setAddLoading(false)
    setAddMoreLoading(false)
    setAddError(null)
    setAddMoreError(null)
    setAddNeedsScope(null)
  }, [])

  const pendingName = name !== pack.name

  useEffect(() => {
    guard.dirty = pendingName
    guard.notify?.(pendingName)
  }, [guard, pendingName])

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    // A warm page refreshes in place; only a cold window owns the loader.
    if (!loadedOnce.current) setLoading(true)
    setError(null)
    setSaveError(null)
    setConflict(false)
    try {
      const [library, packsResult, catalogue] = await Promise.all([
        face.api.clues(workspaceId),
        face.api.packsList(workspaceId),
        face.api.sources(signal),
      ])
      if (signal?.aborted === true) return
      const fresh = packsResult.packs.find(candidate => candidate.id === props.pack.id)
      if (fresh !== undefined) {
        setPack(fresh)
        setName(current => (current === props.pack.name ? fresh.name : current))
      }
      const clueById = new Map(library.clues.map(clue => [clue.id, clue]))
      const current = fresh ?? props.pack
      setMembers(current.members
        .map((id): MemberRow | undefined => {
          const clue = clueById.get(id)
          return clue === undefined ? undefined : { clue, readable: clue.unresolved === undefined }
        })
        .filter((row): row is MemberRow => row !== undefined))
      setSources(catalogue.sources)
      setDisplays(face.getSourceDisplays())
      loadedOnce.current = true
      setLoading(false)
    } catch (failure) {
      if (signal?.aborted === true) return
      setError(clueErrorMessage(failure, t('error')))
      setLoading(false)
    }
  }, [face, workspaceId, props.pack])

  useEffect(() => {
    const controller = new AbortController()
    if (!loadedOnce.current) void load(controller.signal)
    const unsubscribe = face.subscribe(() => { setDisplays(face.getSourceDisplays()) })
    return () => {
      controller.abort()
      unsubscribe()
      addAbort.current?.abort()
    }
  }, [load, face])

  // Bindings live in the workspace that AUTO-PROVIDES the reference, so the
  // panel reads and writes the SELECTED target workspace, not the pack's own.
  useEffect(() => {
    if (bindingTarget === '') return
    const cached = face.api === cluesApi
      ? peekClueRequest<CluesBindingsResult>('clues.bindings.list', bindingTarget, {
          workspaceId: bindingTarget,
        })
      : undefined
    if (cached !== undefined) {
      setBindingsError(false)
      setBindings(cached.bindings.filter(binding =>
        binding.target.kind === 'pack' && binding.target.packId === props.pack.id))
      return
    }
    const controller = new AbortController()
    setBindingsError(false)
    void face.api.bindingsList(bindingTarget).then((result) => {
      if (controller.signal.aborted) return
      setBindings(result.bindings.filter(binding =>
        binding.target.kind === 'pack' && binding.target.packId === props.pack.id))
    }).catch(() => {
      if (controller.signal.aborted) return
      // A failed read is NOT "unbound": say that the request failed and keep
      // Retry reachable instead of silently offering Bind.
      setBindingsError(true)
    })
    return () => { controller.abort() }
  }, [face, bindingTarget, props.pack.id, bindingsAttempt])

  const displayName = (sourceId: string): string =>
    displays.find(display => display.sourceId === sourceId)?.name
    ?? sources.find(source => source.sourceId === sourceId)?.name
    ?? sourceId

  const saveName = useCallback(async (): Promise<void> => {
    if (renameBusy.current || name.trim() === '' || name.trim() === pack.name) return
    renameBusy.current = true
    setNameSaved(false)
    setSaving(true)
    setConflict(false)
    setSaveError(null)
    try {
      const result = await face.api.packsRename(workspaceId, {
        packId: pack.id,
        name: name.trim(),
        expectedRevision: pack.revision,
      })
      setPack(result.pack)
      setName(result.pack.name)
      setNameSaved(true)
      setSaveError(null)
    } catch (failure) {
      // A stale revision is a CONFLICT (re-read and retry). Every other
      // failure (network, permission, missing pack) is an ordinary request
      // failure and must not claim the pack changed elsewhere.
      const conflict = categoryOf(failure) === 'conflict'
      setConflict(conflict)
      setSaveError(conflict ? null : t('cluePackSaveFailed'))
      props.onNotice(clueErrorMessage(failure, t('cluePackSaveFailed')))
    } finally {
      renameBusy.current = false
      setSaving(false)
    }
  }, [face, workspaceId, pack, name, props])

  const removeMember = useCallback(async (clueId: string): Promise<void> => {
    try {
      const result = await face.api.packsRemoveMember(workspaceId, {
        packId: pack.id,
        clueId,
        expectedRevision: pack.revision,
      })
      setPack(result.pack)
      setMembers(current => current.filter(row => row.clue.id !== clueId))
      props.onNotice(t('cluePackMemberRemoved'))
    } catch (failure) {
      props.onNotice(clueErrorMessage(failure, t('cluePackSaveFailed')))
    }
  }, [face, workspaceId, pack, props])

  const addBinding = useCallback(async (): Promise<void> => {
    if (bindingTarget === '') return
    setBindingBusy(true)
    try {
      const result = await face.api.bindingsAdd(bindingTarget, {
        target: { kind: 'pack', packId: pack.id },
      })
      setBindings(result.bindings.filter(binding =>
        binding.target.kind === 'pack' && binding.target.packId === pack.id))
    } catch (failure) {
      props.onNotice(clueErrorMessage(failure, t('cluePackSaveFailed')))
    } finally {
      setBindingBusy(false)
    }
  }, [face, pack, bindingTarget, props])

  const removeBinding = useCallback(async (): Promise<void> => {
    setBindingBusy(true)
    try {
      const result = await face.api.bindingsRemove(bindingTarget, {
        target: { kind: 'pack', packId: pack.id },
      })
      setBindings(result.bindings.filter(binding =>
        binding.target.kind === 'pack' && binding.target.packId === pack.id))
    } catch (failure) {
      props.onNotice(clueErrorMessage(failure, t('cluePackSaveFailed')))
    } finally {
      setBindingBusy(false)
    }
  }, [face, pack, bindingTarget, props])

  // ── add-member page ────────────────────────────────────────────────────────

  const enabledSources = sources.filter(source => face.isSourceEnabled(source.sourceId))
  const enabledSourceKey = enabledSources.map(source => source.sourceId).join('\u0000')
  // `null` is the settings tombstone of a cleared range, never a scope value.
  const addScope = addSourceId === null ? undefined : addScopes[addSourceId] ?? automaticScopes[addSourceId]
  const addSummary = addSourceId === null ? undefined : scopeSummary(addSourceId, addScope)

  useEffect(() => {
    if (!addOpen) return
    const unsubscribe = face.subscribe(() => { setDisplays(face.getSourceDisplays()) })
    return () => { unsubscribe() }
  }, [addOpen, face])

  useEffect(() => {
    if (addSourceId === null) return
    setAddScopeForm(formOf(addSourceId, addScopes[addSourceId] ?? automaticScopes[addSourceId]))
    setAddScopeError(null)
  }, [addSourceId, addScopes, automaticScopes])

  // A source switched off elsewhere leaves the page: drop the active one (the
  // cross-source selection itself is preserved).
  useEffect(() => {
    if (addSourceId === null) return
    if (enabledSourceKey.split('\u0000').includes(addSourceId)) return
    resetAdd()
    setAddSourceId(null)
  }, [addSourceId, enabledSourceKey, resetAdd])

  // A range chosen elsewhere (the tab's own browser) reaches this open window
  // through the same persisted document.
  useEffect(() => {
    setAddScopes(props.scopes ?? {})
  }, [props.scopes])

  /**
   * Load one add-page view. Without a cursor this REPLACES the rows (source,
   * query or range reset); with a cursor it appends the next page. Cursor
   * pages are a growing list, never a previous/next stack.
   */
  const loadAdd = useCallback(async (
    sourceId: string,
    requested: AddView,
    cursor?: string,
    scopesOverride?: Readonly<Record<string, JsonValue | undefined>>,
  ): Promise<void> => {
    const source = sources.find(candidate =>
      candidate.sourceId === sourceId && face.isSourceEnabled(candidate.sourceId))
    if (source === undefined) return
    const fresh = cursor === undefined
    const seq = addRequestSeq.current + 1
    addRequestSeq.current = seq
    addAbort.current?.abort()
    const controller = new AbortController()
    addAbort.current = controller
    if (fresh) {
      addLoadMoreLock.current = false
      addSeenCursors.current.clear()
      setAddCandidates([])
      setAddNext(undefined)
    }
    setAddError(null)
    setAddMoreError(null)
    setAddNeedsScope(null)
    const rawScope = (scopesOverride ?? addScopes)[sourceId]
    // A tombstone (`null`) means "no range chosen", not an explicit null scope.
    let scope: JsonValue | undefined = rawScope === null ? undefined : rawScope
    if (scope === undefined && requested.kind !== 'resolve') {
      if (isGithubClueSource(sourceId)) {
        if (fresh) setAddLoading(true)
        try {
          const result = await face.api.defaultScope(workspaceId, { sourceId }, controller.signal)
          if (controller.signal.aborted || seq !== addRequestSeq.current) return
          scope = result.scope
          if (scope !== undefined) {
            const inferred = scope
            setAutomaticScopes(current => ({ ...current, [sourceId]: inferred }))
          }
        } catch (failure) {
          if (!controller.signal.aborted && seq === addRequestSeq.current) {
            setAddError(clueErrorMessage(failure, t('error')))
            setAddLoading(false)
            setAddMoreLoading(false)
          }
          return
        }
      } else if (sourceId === BUILTIN_SOURCE_IDS.feishuDocs && requested.kind === 'list') {
        scope = { kind: 'drive-root' }
      }
    }
    // Resolving a complete resource URL/path names its own resource and never
    // depends on the browse range; list/search keep the tab browser's rules.
    if (requested.kind !== 'resolve') {
      const blocked = requested.kind === 'list'
        ? listNeedsScope(sourceId, scope)
        : searchNeedsScope(sourceId, scope, requested.query)
      if (blocked) {
        setAddView(requested)
        setAddNext(undefined)
        setAddLoading(false)
        setAddMoreLoading(false)
        setAddNeedsScope(requested.kind === 'search' ? 'search' : 'list')
        return
      }
    }
    if (requested.kind === 'list' && !source.capabilities.list) {
      setAddCandidates([])
      setAddNext(undefined)
      setAddError(t('clueBrowserUnsupported'))
      setAddLoading(false)
      setAddMoreLoading(false)
      return
    }
    if (requested.kind === 'search' && !source.capabilities.search) {
      setAddCandidates([])
      setAddNext(undefined)
      setAddError(t('clueBrowserSearchUnsupported'))
      setAddLoading(false)
      setAddMoreLoading(false)
      return
    }
    if (fresh) setAddLoading(true)
    else setAddMoreLoading(true)
    try {
      if (requested.kind === 'resolve') {
        const resolved = await face.api.resolve(workspaceId, { text: requested.text }, controller.signal)
        if (controller.signal.aborted || seq !== addRequestSeq.current) return
        setAddCandidates(resolved.candidates)
        setAddNext(undefined)
        setAddView(requested)
        return
      }
      const params = {
        sourceId,
        ...(rawScope === undefined || rawScope === null ? {} : { scope: rawScope }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: ADD_PAGE_LIMIT,
      }
      const result = requested.kind === 'list'
        ? await face.api.list(workspaceId, params, controller.signal)
        : await face.api.search(workspaceId, { ...params, query: requested.query }, controller.signal)
      if (controller.signal.aborted || seq !== addRequestSeq.current) return
      // Same guard as the tab browser: a source that re-issues an already
      // consumed cursor would otherwise append forever. Keep every loaded row
      // (the looping page is not merged) and surface the failure at the bottom
      // with an explicit Retry; `addNext` stays untouched so Retry can resume
      // if the source recovers.
      if (cursor !== undefined) addSeenCursors.current.add(cursor)
      if (result.nextCursor !== undefined && addSeenCursors.current.has(result.nextCursor)) {
        throw new Error('Repeated clue cursor')
      }
      setAddCandidates(current => fresh ? result.items : mergeCandidates(current, result.items))
      setAddNext(result.nextCursor)
      setAddView(requested)
    } catch (failure) {
      if (controller.signal.aborted || seq !== addRequestSeq.current) return
      const message = clueErrorMessage(failure, t('error'))
      // An append failure keeps every row already read and offers Retry at the
      // bottom of the list; a first-page failure owns the page-level error.
      if (fresh) setAddError(message)
      else setAddMoreError(message)
    } finally {
      if (seq === addRequestSeq.current) {
        setAddLoading(false)
        setAddMoreLoading(false)
      }
    }
  }, [addScopes, face, sources, workspaceId])

  /**
   * Ask for the next cursor page when the sentinel approaches. The lock is
   * synchronous because the scroll observer can fire several times before the
   * `addMoreLoading` render lands.
   */
  const loadMoreAdd = useCallback((): void => {
    if (addSourceId === null || addNext === undefined) return
    if (addLoadMoreLock.current) return
    addLoadMoreLock.current = true
    void loadAdd(addSourceId, addView, addNext).finally(() => {
      addLoadMoreLock.current = false
    })
  }, [addNext, addSourceId, addView, loadAdd])

  useScrollLoad({
    scrollRef: addScrollRef,
    sentinelRef: addSentinelRef,
    enabled: addOpen && addSourceId !== null,
    hasMore: addNext !== undefined && addMoreError === null,
    loading: addLoading || addMoreLoading,
    onLoad: loadMoreAdd,
    // Re-arm after an append, a reset, or a failed append until Retry clears it.
    version: `${addSourceId ?? ''}\u0000${addView.kind}\u0000${addNext ?? ''}\u0000${addCandidates.length}\u0000${addMoreError ?? ''}`,
  })

  /** Cancel the pending trailing keyword search (page/source switch, Enter, clear). */
  const cancelAddSearch = useCallback((): void => {
    if (addSearchTimer.current === undefined) return
    window.clearTimeout(addSearchTimer.current)
    addSearchTimer.current = undefined
  }, [])

  // The window can close with a trailing search still queued.
  useEffect(() => () => { cancelAddSearch() }, [cancelAddSearch])

  /**
   * Automatic keyword search: 300ms trailing, keywords only. A resource URL or
   * path stays on Enter/button (resolve names the resource directly), an empty
   * box returns to browsing, and IME composition never fires a request.
   */
  useEffect(() => {
    if (!addOpen || addSourceId === null || composing) return
    const text = addQuery.trim()
    if (text === '' || looksLikeResource(text)) return
    const source = sourcesRef.current.find(candidate => candidate.sourceId === addSourceId)
    if (source?.capabilities.search !== true) return
    const current = addViewRef.current
    if (current.kind === 'search' && current.query === text) return
    if (lastAutoSearch.current === text) return
    const timer = window.setTimeout(() => {
      addSearchTimer.current = undefined
      lastAutoSearch.current = text
      resetAdd()
      void loadAdd(addSourceId, { kind: 'search', query: text })
    }, ADD_SEARCH_DEBOUNCE_MS)
    addSearchTimer.current = timer
    return () => {
      if (addSearchTimer.current !== timer) return
      window.clearTimeout(timer)
      addSearchTimer.current = undefined
    }
  }, [addQuery, composing, addOpen, addSourceId, loadAdd, resetAdd])

  // A row menu belongs to the page that opened it.
  useEffect(() => { setRowMenu(null) }, [addOpen, addSourceId])

  const pickSource = useCallback((sourceId: string): void => {
    // The cross-source selection is intentionally NOT cleared: it is the
    // whole point of the add page. A queued keyword search belongs to the old
    // source and must never reach the new one.
    cancelAddSearch()
    lastAutoSearch.current = ''
    resetAdd()
    setAddSourceId(sourceId)
    setAddQuery('')
    setAddScopeOpen(false)
    setRowMenu(null)
    void loadAdd(sourceId, { kind: 'list' })
  }, [cancelAddSearch, loadAdd, resetAdd])

  const applyAddScope = useCallback((): void => {
    if (addSourceId === null) return
    const built = scopeOfForm(addSourceId, addScopeForm)
    if (built.error !== undefined) {
      setAddScopeError(built.error)
      return
    }
    cancelAddSearch()
    lastAutoSearch.current = ''
    const nextScopes = { ...addScopes, [addSourceId]: built.scope }
    setAddScopes(nextScopes)
    props.onScopeChange?.(addSourceId, built.scope)
    setAddScopeError(null)
    setAddScopeOpen(false)
    resetAdd()
    void loadAdd(addSourceId, addView, undefined, nextScopes)
  }, [addSourceId, addScopeForm, addScopes, addView, cancelAddSearch, loadAdd, props, resetAdd])

  const submitAddQuery = useCallback((): void => {
    if (addSourceId === null) return
    cancelAddSearch()
    const text = addQuery.trim()
    lastAutoSearch.current = text
    resetAdd()
    void loadAdd(
      addSourceId,
      text === ''
        ? { kind: 'list' }
        : looksLikeResource(text) ? { kind: 'resolve', text } : { kind: 'search', query: text },
    )
  }, [addQuery, addSourceId, cancelAddSearch, loadAdd, resetAdd])

  /** The box changed: clearing it returns to browsing immediately. */
  const changeAddQuery = useCallback((value: string): void => {
    setAddQuery(value)
    if (value.trim() !== '') return
    cancelAddSearch()
    lastAutoSearch.current = ''
    if (addSourceId === null || addViewRef.current.kind === 'list') return
    resetAdd()
    void loadAdd(addSourceId, { kind: 'list' })
  }, [addSourceId, cancelAddSearch, loadAdd, resetAdd])

  const toggleAddSelection = useCallback((candidate: ClueCandidate): void => {
    const key = candidateKey(candidate)
    setAddSelected((current) => {
      const next = new Map(current)
      if (next.has(key)) next.delete(key)
      else next.set(key, candidate)
      return next
    })
  }, [])

  const openMemberDetail = useCallback((row: MemberRow): void => {
    openClueDetailWindow({
      windows: props.windows, face, workspaceId,
      target: { sourceId: row.clue.sourceId, typeId: row.clue.typeId, clueId: row.clue.id, title: row.clue.title, info: row.clue.info, subtitle: row.clue.subtitle },
      workspaces, onInsertClue: props.onInsertClue,
      ...(props.onAddToPack === undefined ? {} : { onAddToPack: props.onAddToPack }),
    })
  }, [face, props.onAddToPack, props.onInsertClue, props.windows, workspaceId, workspaces])

  const openCandidateDetail = useCallback((candidate: ClueCandidate): void => {
    openClueDetailWindow({
      windows: props.windows, face, workspaceId,
      target: {
        sourceId: candidate.sourceId,
        typeId: candidate.typeId,
        ...(candidate.clueId === undefined ? {} : { clueId: candidate.clueId }),
        locator: candidate.locator,
        title: candidate.title,
          info: candidate.info, subtitle: candidate.subtitle,
      },
      workspaces, onInsertClue: props.onInsertClue,
      ...(props.onAddToPack === undefined ? {} : { onAddToPack: props.onAddToPack }),
    })
  }, [face, props.onAddToPack, props.onInsertClue, props.windows, workspaceId, workspaces])

  const onRowMenuSelect = useCallback((id: string): void => {
    const menu = rowMenu
    setRowMenu(null)
    if (menu === null) return
    if (menu.kind === 'member') {
      if (id === 'preview') openMemberDetail(menu.row)
      else if (id === 'insert') props.onInsertClue(menu.row.clue.id, menu.row.clue.title)
      else if (id === 'remove') void removeMember(menu.row.clue.id)
      return
    }
    if (id === 'preview') openCandidateDetail(menu.candidate)
    else if (id === 'select') toggleAddSelection(menu.candidate)
  }, [openCandidateDetail, openMemberDetail, props, removeMember, rowMenu, toggleAddSelection])

  const addMembers = useCallback(async (): Promise<void> => {
    if (addSelected.size === 0) return
    setSaving(true)
    try {
      let revision = pack.revision
      let latest = pack
      for (const candidate of addSelected.values()) {
        const ensured = await face.api.ensure(workspaceId, {
          sourceId: candidate.sourceId,
          typeId: candidate.typeId,
          locator: candidate.locator,
          title: candidate.title,
          info: candidate.info, subtitle: candidate.subtitle,
        })
        const result = await face.api.packsAddMember(workspaceId, {
          packId: pack.id,
          clueId: ensured.clue.id,
          expectedRevision: revision,
        })
        revision = result.packRevision
        latest = result.pack
      }
      setPack(latest)
      setAddSelected(new Map())
      setAddOpen(false)
      await load()
      props.onNotice(t('cluePackMembersAdded', { name: latest.name }))
    } catch (failure) {
      props.onNotice(clueErrorMessage(failure, t('cluePackSaveFailed')))
    } finally {
      setSaving(false)
    }
  }, [addSelected, face, workspaceId, pack, load, props])

  const bound = bindings.length > 0
  /** Explicit discard of the name draft (member writes are already committed). */
  const discardDraft = (): void => {
    setName(pack.name)
    setConflict(false)
    setSaveError(null)
  }

  /** Rows of the shared row menu (member or add-page candidate). */
  const rowMenuItems: readonly MenuEntry[] = rowMenu === null
    ? []
    : rowMenu.kind === 'member'
      ? [
          { id: 'preview', label: t('preview'), icon: <IconInspectOutlineRegular size={14} /> },
          { id: 'insert', label: t('clueBrowserInsert'), icon: <IconContextInjectionOutlineRegular size={14} /> },
          { type: 'separator', id: 'sep' },
          {
            id: 'remove',
            label: t('cluePackRemoveMember', { title: rowMenu.row.clue.title }),
            icon: <IconTrashOutlineRegular size={14} />,
          },
        ]
      : [
          { id: 'preview', label: t('preview'), icon: <IconInspectOutlineRegular size={14} /> },
          {
            id: 'select',
            label: t('clueBrowserSelectRow', { title: rowMenu.candidate.title }),
            icon: <IconPlusOutlineRegular size={14} />,
            disabled: addSelected.has(candidateKey(rowMenu.candidate)),
          },
        ]

  return (
    <div className={css.root} data-clue-pack-window>
      <div className={css.content} ref={addScrollRef} data-clue-pack-scroll>
        {!addOpen && (
          <div className={css.head}>
            <TextInput
              className={css.nameInput}
              value={name}
              aria-label={t('cluePackName')}
              disabled={saving || loading}
              onChange={(event) => { setName(event.target.value); setNameSaved(false) }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
                if (!pendingName) return
                event.preventDefault()
                void saveName()
              }}
            />
            <div className={css.headActions}>
              <IconButton
                icon={<IconShareOutlineRegular size={14} />}
                label={t('clueShareExport')}
                onClick={() => {
                  openShareWindow({ windows: props.windows, workspaceId, face, packIds: [pack.id] })
                }}
              />
            </div>
          </div>
        )}

        {loading && <LoadingIndicator />}
        {error !== null && <Notice kind="error">{error}</Notice>}
        {saveError !== null && <Notice kind="error">{saveError}</Notice>}
        {conflict && (
          <ErrorBlock message={t('cluePackConflict')} retryLabel={t('retry')} onRetry={() => {
            // A CAS conflict means the pack library (and its members'
            // titles/bindings) changed elsewhere; refresh those families,
            // not the whole activation cache.
            invalidateClueRequests(workspaceId, [
              'clues.clues',
              'clues.packs.list',
              'clues.bindings.list',
            ])
            void load()
          }} />
        )}

        <div className={css.sectionHead}>
          <h3 className={css.sectionTitle}>{t('cluePackMembers', { n: members.length })}</h3>
          <button
            type="button"
            className={css.action}
            aria-pressed={addOpen}
            onClick={() => {
              if (addOpen) {
                cancelAddSearch()
                setRowMenu(null)
              }
              setAddOpen(value => !value)
            }}
          >
            {addOpen ? t('cluePackBack') : t('cluePackAddMembers')}
          </button>
        </div>

        {addOpen ? (
          <div className={css.addPage} data-clue-add-member>
            <SourceNavigation
              sources={enabledSources}
              displays={displays}
              activeId={addSourceId ?? ''}
              onChange={pickSource}
            />
            {enabledSources.length === 0 && <EmptyState title={t('clueBrowserAllDisabled')} />}


            {addSourceId === null ? (
              <EmptyState title={t('cluePackPickSource')} />
            ) : (
              <>
                <div className={css.scopeBar}>
                  {addSourceId === BUILTIN_SOURCE_IDS.feishuTasks
                    ? <span className={css.scopeHint}>{t('clueBrowserScopeTasksHint')}</span>
                    : (
                      <>
                        <button
                          type="button"
                          className={css.action}
                          aria-expanded={addScopeOpen}
                          aria-label={t('clueBrowserScopeEdit')}
                          title={`${t('clueBrowserScopeHeading')}: ${addSummary ?? t('clueBrowserScopeNeeded')}`}
                          onClick={() => { setAddScopeOpen(value => !value) }}
                        >
                          {t('clueBrowserScopeEdit')}
                        </button>
                        <span className={css.scopeHint}>{addSummary ?? t('clueBrowserScopeNeeded')}</span>
                      </>
                    )}
                </div>

                {addScopeOpen && addSourceId !== BUILTIN_SOURCE_IDS.feishuTasks && (
                  <form
                    className={css.scopeEditor}
                    onSubmit={(event) => { event.preventDefault(); applyAddScope() }}
                  >
                    <ScopeFields
                      sourceId={addSourceId}
                      form={addScopeForm}
                      onChange={(next) => { setAddScopeForm(next) }}
                    />
                    {addScopeError !== null && <span className={css.fieldError} role="alert">{addScopeError}</span>}
                    <div className={css.scopeActions}>
                      <button type="submit" className={css.primary}>{t('clueBrowserScopeApply')}</button>
                      <button
                        type="button"
                        className={css.action}
                        onClick={() => { setAddScopeOpen(false); setAddScopeError(null) }}
                      >
                        {t('cancel')}
                      </button>
                    </div>
                  </form>
                )}

                <div className={css.queryRow}>
                  <label className={css.searchBox}>
                    <IconSearchOutlineRegular size={14} />
                    <TextInput
                      type="text"
                      className={css.searchInput}
                      value={addQuery}
                      placeholder={t('clueBrowserSearchPlaceholder')}
                      aria-label={t('clueBrowserSearchPlaceholder')}
                      onChange={(event) => { changeAddQuery(event.target.value) }}
                      onCompositionStart={() => { setComposing(true); cancelAddSearch() }}
                      onCompositionEnd={() => { setComposing(false) }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
                        event.preventDefault()
                        submitAddQuery()
                      }}
                    />
                  </label>
                  <button type="button" className={css.action} onClick={submitAddQuery}>
                    {looksLikeResource(addQuery.trim()) ? t('clueBrowserResolveAction') : t('clueBrowserSearchAction')}
                  </button>
                </div>
                {/* Setup is actionable below the query row: a probe must never
                    insert a checking row that moves the search box. */}
                {enabledSources.find(source => source.sourceId === addSourceId) !== undefined && <ResourceFilters
                  source={enabledSources.find(source => source.sourceId === addSourceId)!} scope={addScope}
                  mode={addView.kind === 'search' ? 'search' : 'list'} onChange={next => {
                    if (addSourceId === null) return
                    cancelAddSearch()
                    const nextScopes = { ...addScopes, [addSourceId]: next }
                    setAddScopes(nextScopes)
                    props.onScopeChange?.(addSourceId, next)
                    resetAdd()
                    void loadAdd(addSourceId, addView, undefined, nextScopes)
                  }} />}
                {enabledSources.find(source => source.sourceId === addSourceId) !== undefined && <SourceReadiness
                  key={addSourceId} source={enabledSources.find(source => source.sourceId === addSourceId)!}
                  display={displays.find(display => display.sourceId === addSourceId)}
                  windows={props.windows} visible={addOpen} onReady={() => { if (addSourceId !== null) void loadAdd(addSourceId, addView) }} />}

                {addNeedsScope !== null && (
                  <EmptyState data-add-state="needs-scope"
                    title={addNeedsScope === 'search' ? t('clueBrowserSearchScopeNeeded') : t('clueBrowserScopeNeeded')} />
                )}
                {addView.kind === 'search'
                  && addSourceId === BUILTIN_SOURCE_IDS.feishuDocs
                  && addScope === undefined && (
                  <div className={css.scopeHint} data-add-global-search>
                    {t('clueBrowserSearchGlobalHint')}
                  </div>
                )}
                {addLoading && <LoadingIndicator />}
                {addError !== null && <ErrorBlock message={addError} />}
                {!addLoading && addError === null && addNeedsScope === null && addCandidates.length === 0 && (
                  <EmptyState title={addView.kind === 'search' ? t('clueBrowserNoResults') : t('clueBrowserEmpty')} />
                )}
                <div className={css.addScroll} data-clue-add-scroll>
                  <ul className={css.addList}>
                    {addCandidates.map((candidate) => {
                      const key = candidateKey(candidate)
                      return (
                        <li
                          key={key}
                          className={css.addRow}
                          onContextMenu={(event) => {
                            setRowMenu({ kind: 'candidate', candidate, ...contextMenuPoint(event) })
                          }}
                          onKeyDown={(event) => {
                            const point = keyboardMenuPoint(event)
                            if (point !== undefined) setRowMenu({ kind: 'candidate', candidate, ...point })
                          }}
                        >
                          <label className={css.addLabel}>
                            <Checkbox
                              checked={addSelected.has(key)}
                              aria-label={t('clueBrowserSelectRow', { title: candidate.title })}
                              onChange={() => { toggleAddSelection(candidate) }}
                            />
                            <span className={css.memberGlyph} aria-hidden="true">{resourceIcon(candidate, displays)}</span>
                            <span className={css.addTitle}>{candidate.title}</span>
                            <span className={css.memberSource}><ResourceInlineMeta info={candidate.info} />{candidate.info?.state === undefined ? candidate.subtitle : null}</span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                  {addMoreLoading && <LoadingIndicator inline />}
                  {addMoreError !== null && (
                    <ErrorBlock data-clue-add-more-error message={addMoreError} retryLabel={t('retry')} onRetry={() => {
                      // Retry only the paged resource reads; shelves, pins and
                      // runtime observations are unrelated to this failure.
                      invalidateClueRequests(workspaceId, [
                        'clues.list',
                        'clues.search',
                        'clues.resolve',
                      ])
                      loadMoreAdd()
                    }} />
                  )}
                  <div ref={addSentinelRef} data-clue-add-sentinel aria-hidden="true" />
                </div>

              </>
            )}
          </div>
        ) : (
          <div className={css.body}>
            {members.length === 0
              ? <EmptyState title={t('cluePackNoMembers')} />
              : (
                <ul className={css.memberList}>
                  {members.map(row => (
                    <li
                      key={row.clue.id}
                      className={css.memberRow}
                      data-clue-pack-member={row.clue.id}
                      data-unresolved={row.readable ? undefined : 'true'}
                      onContextMenu={(event) => {
                        setRowMenu({ kind: 'member', row, ...contextMenuPoint(event) })
                      }}
                      onKeyDown={(event) => {
                        const point = keyboardMenuPoint(event)
                        if (point !== undefined) setRowMenu({ kind: 'member', row, ...point })
                      }}
                    >
                      <span className={css.memberGlyph} aria-hidden="true">{resourceIcon(row.clue, displays)}</span>
                      <button
                        type="button"
                        className={css.memberTitle}
                        title={row.clue.title}
                        onClick={() => { openMemberDetail(row) }}
                      >
                        {row.clue.title}
                      </button>
                      <span className={css.memberSource}><ResourceInlineMeta info={row.clue.info} />{row.clue.info?.state === undefined ? displayName(row.clue.sourceId) : null}</span>
                      {row.readable
                        ? null
                        : <span className={css.memberState}>{t('cluePackMemberUnresolved')}</span>}
                      <IconButton
                        icon={<IconContextInjectionOutlineRegular size={16} />}
                        label={t('clueBrowserInsertRow', { title: row.clue.title })}
                        title={t('clueBrowserInsert')} onClick={() => { props.onInsertClue(row.clue.id, row.clue.title) }} />
                      <IconButton
                        icon={<IconTrashOutlineRegular size={14} />}
                        label={t('cluePackRemoveMember', { title: row.clue.title })}
                        disabled={saving}
                        onClick={() => { void removeMember(row.clue.id) }} />
                    </li>
                  ))}
                </ul>
              )}

            <details className={css.binding} data-clue-binding-panel>
              <summary className={css.sectionTitle}>{t('cluePackBindingHeading')}</summary>
              {bindingsError
                ? (
                  <ErrorBlock message={t('clueStateRequestFailed')} retryLabel={t('retry')}
                    onRetry={() => { setBindingsAttempt(value => value + 1) }} />
                )
                : bound
                ? (
                  <div className={css.bindingRow}>
                    <span className={css.bindingState}>{t('cluePackBound')}</span>
                    <button
                      type="button"
                      className={css.action}
                      disabled={bindingBusy}
                      onClick={() => { void removeBinding() }}
                    >
                      {t('cluePackUnbind')}
                    </button>
                  </div>
                )
                : (
                  <div className={css.bindingRow}>
                    <SelectMenu
                      className={css.select}
                      ariaLabel={t('cluePackBindingChoose')}
                      value={bindingTarget}
                      disabled={bindingBusy}
                      onChange={setBindingTarget}
                      options={workspaces.map(workspace => ({ value: workspace.workspaceId, label: workspace.title }))}
                    />
                    <button
                      type="button"
                      className={css.action}
                      disabled={bindingBusy || workspaces.length === 0}
                      onClick={() => { void addBinding() }}
                    >
                      {t('cluePackBind')}
                    </button>
                  </div>
                )}
            </details>

          </div>
        )}

      </div>

              {addOpen && addSelected.size > 0 && (
                <ActionFooter bleed data-clue-pack-add-footer
                  start={t('clueBrowserSelected', { n: addSelected.size })}
                  end={<ActionButton variant="primary" busy={saving} onClick={() => { void addMembers() }}>
                    {t('cluePackAddSelected')}
                  </ActionButton>} />
              )}

      {!addOpen && (
        <ActionFooter bleed data-clue-pack-footer
          start={<span data-clue-pack-save-status>{pendingName ? t('unsaved') : nameSaved ? t('saved') : null}</span>}
          end={pendingName ? (
            <>
              <ActionButton disabled={saving} onClick={discardDraft}>{t('cancel')}</ActionButton>
              <ActionButton variant="primary" busy={saving} disabled={name.trim() === ''}
                onClick={() => { void saveName() }}>{t('save')}</ActionButton>
            </>
          ) : (
            <ActionButton variant="primary" disabled={saving || loading || error !== null}
              onClick={() => { props.onInsertPack(pack) }}>{t('cluePackInsert')}</ActionButton>
          )} />
      )}

      <Menu
        className={css.menuAnchor}
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={rowMenuItems}
        onSelect={onRowMenuSelect}
        portal
        compact
        align="start"
        anchorPoint={rowMenu === null ? undefined : { x: rowMenu.x, y: rowMenu.y }}
        anchor={<span />}
      />
    </div>
  )
}
