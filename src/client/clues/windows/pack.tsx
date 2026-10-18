/**
 * The clue pack management window (S9).
 *
 * One S6 collection window owns the whole pack lifecycle so the Tab page stays
 * a two-region browser:
 * - the pack name, edited into a draft and saved explicitly;
 * - its members with source glyph, title and unresolved state;
 * - the workspace binding panel (explicit workspace choice, the exact
 *   auto-provide explanation, and unbind that deletes nothing);
 * - an add-member page INSIDE the same window: the pack draft, the search text,
 *   the source choice and the cross-page selection all stay mounted while the
 *   reader picks members, and cancelling changes no member.
 *
 * Invariants (S1/S6/S9):
 * - removing a member deletes neither the resource nor any inserted reference;
 * - a binding auto-provides references to NEW sessions and grants no access;
 * - a stale write is a CAS conflict: the draft is kept, the pack is re-read and
 *   the surface never claims the save landed.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconPinFillRegular,
  IconPinOutlineRegular,
  IconSearchOutlineRegular,
  IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { VscReferences } from 'react-icons/vsc'
import type {
  Clue,
  ClueBinding,
  ClueCandidate,
  CluePack,
  ClueSourceDescriptor,
  ClueSourceDisplayDescriptor,
  JsonValue,
} from '../../../clues/types.ts'
import { BUILTIN_SOURCE_IDS } from '../../../clues/types.ts'
import {
  EMPTY_FORM,
  ScopeFields,
  type ScopeForm,
  candidateKey,
  formOf,
  listNeedsScope,
  looksLikeResource,
  scopeOfForm,
  scopeSummary,
  searchNeedsScope,
  sourceIcon,
} from '../tab/browser-shared.tsx'
import type { BetterSidebarCluesClientFace } from '../registry.ts'
import type { BetterSidebarWindowsClientFace, WindowHandle } from '../../windows/types.ts'
import { categoryOf, clueErrorMessage } from '../copy.ts'
import { openShareWindow } from './share.tsx'
import { t } from '../../locales.ts'
import css from './pack.module.css'

/** The workspace the pack belongs to (display only; never used to guess). */
export interface PackWorkspaceChoice {
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
export interface PackManagementOptions {
  readonly windows: BetterSidebarWindowsClientFace
  readonly workspaceId: string
  readonly face: BetterSidebarCluesClientFace
  readonly workspaces: readonly PackWorkspaceChoice[]
  readonly pack: CluePack
  onInsertClue(clueId: string, title: string): boolean
  onInsertPack(pack: CluePack): boolean
  onNotice(message: string): void
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

/** One pinned clue as the add page renders it. */
type PinnedCandidate = ClueCandidate & { readonly clueId: string }

const ADD_PAGE_LIMIT = 20

/** The window id of one pack (a second open focuses the same surface). */
export function packWindowId(packId: string): string {
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
  const [pack, setPack] = useState(props.pack)
  const [name, setName] = useState(props.pack.name)
  const [members, setMembers] = useState<readonly MemberRow[]>([])
  const [bindings, setBindings] = useState<readonly ClueBinding[]>([])
  const [bindingTarget, setBindingTarget] = useState<string>(workspaces[0]?.workspaceId ?? '')
  const [bindingBusy, setBindingBusy] = useState(false)
  const [sources, setSources] = useState<readonly ClueSourceDescriptor[]>([])
  const [displays, setDisplays] = useState<readonly ClueSourceDisplayDescriptor[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addSourceId, setAddSourceId] = useState<string | null>(null)
  const [addQuery, setAddQuery] = useState('')
  const [addCandidates, setAddCandidates] = useState<readonly ClueCandidate[]>([])
  const [addNext, setAddNext] = useState<string | undefined>(undefined)
  const [addCursorStack, setAddCursorStack] = useState<string[]>([])
  const [addLoading, setAddLoading] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [addNeedsScope, setAddNeedsScope] = useState<'list' | 'search' | null>(null)
  const [addView, setAddView] = useState<AddView>({ kind: 'list' })
  const [addSelected, setAddSelected] = useState<ReadonlyMap<string, ClueCandidate>>(new Map())
  const [addScopes, setAddScopes] = useState<Readonly<Record<string, JsonValue | undefined>>>(
    () => props.scopes ?? {},
  )
  const [addScopeOpen, setAddScopeOpen] = useState(false)
  const [addScopeForm, setAddScopeForm] = useState<ScopeForm>(EMPTY_FORM)
  const [addScopeError, setAddScopeError] = useState<string | null>(null)
  const [addPins, setAddPins] = useState<readonly PinnedCandidate[]>([])
  const [addPinBusy, setAddPinBusy] = useState(false)
  const addPinsRevision = useRef<number | undefined>(undefined)
  const addAbort = useRef<AbortController | undefined>(undefined)

  const pendingName = name !== pack.name

  useEffect(() => {
    guard.dirty = pendingName
    guard.notify?.(pendingName)
  }, [guard, pendingName])

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoading(true)
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
      setLoading(false)
    } catch (failure) {
      if (signal?.aborted === true) return
      setError(clueErrorMessage(failure, t('error')))
      setLoading(false)
    }
  }, [face, workspaceId, props.pack])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
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
    const controller = new AbortController()
    void face.api.bindingsList(bindingTarget).then((result) => {
      if (controller.signal.aborted) return
      setBindings(result.bindings.filter(binding =>
        binding.target.kind === 'pack' && binding.target.packId === props.pack.id))
    }).catch(() => { /* a failed read just leaves the panel unbound-looking */ })
    return () => { controller.abort() }
  }, [face, bindingTarget, props.pack.id])

  const displayName = (sourceId: string): string =>
    displays.find(display => display.sourceId === sourceId)?.name
    ?? sources.find(source => source.sourceId === sourceId)?.name
    ?? sourceId

  const saveName = useCallback(async (): Promise<void> => {
    if (name.trim() === '' || name.trim() === pack.name) return
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
  const addScope = addSourceId === null ? undefined : addScopes[addSourceId]
  const addSummary = addSourceId === null ? undefined : scopeSummary(addSourceId, addScope)

  const refreshAddPins = useCallback(async (): Promise<void> => {
    try {
      const [pinResult, library] = await Promise.all([
        face.api.pinsList(workspaceId),
        face.api.clues(workspaceId),
      ])
      addPinsRevision.current = pinResult.revision
      const byId = new Map(library.clues.map(clue => [clue.id, clue]))
      setAddPins(pinResult.pins.flatMap((pin): PinnedCandidate[] => {
        const clue = byId.get(pin.clueId)
        if (clue === undefined) return []
        return [{
          clueId: clue.id,
          sourceId: clue.sourceId,
          typeId: clue.typeId,
          locator: clue.locator,
          title: clue.title,
        }]
      }))
    } catch {
      // Pins are a convenience strip; a failed read leaves browsing usable.
    }
  }, [face, workspaceId])

  useEffect(() => {
    if (!addOpen) return
    const unsubscribe = face.subscribe(() => { setDisplays(face.getSourceDisplays()) })
    void refreshAddPins()
    return () => { unsubscribe() }
  }, [addOpen, face, refreshAddPins])

  useEffect(() => {
    if (addSourceId === null) return
    setAddScopeForm(formOf(addSourceId, addScopes[addSourceId]))
    setAddScopeError(null)
  }, [addSourceId, addScopes])

  // A source switched off elsewhere leaves the page: drop the active one (the
  // cross-source selection itself is preserved).
  useEffect(() => {
    if (addSourceId === null) return
    if (enabledSourceKey.split('\u0000').includes(addSourceId)) return
    addAbort.current?.abort()
    setAddSourceId(null)
    setAddCandidates([])
    setAddNext(undefined)
    setAddNeedsScope(null)
    setAddError(null)
  }, [addSourceId, enabledSourceKey])

  // A range chosen elsewhere (the tab's own browser) reaches this open window
  // through the same persisted document.
  useEffect(() => {
    setAddScopes(props.scopes ?? {})
  }, [props.scopes])

  const loadAdd = useCallback(async (
    sourceId: string,
    requested: AddView,
    cursor?: string,
    scopesOverride?: Readonly<Record<string, JsonValue | undefined>>,
  ): Promise<void> => {
    const source = sources.find(candidate =>
      candidate.sourceId === sourceId && face.isSourceEnabled(candidate.sourceId))
    if (source === undefined) return
    addAbort.current?.abort()
    const controller = new AbortController()
    addAbort.current = controller
    const scope = (scopesOverride ?? addScopes)[sourceId]
    // Resolving a complete resource URL/path names its own resource and never
    // depends on the browse range; list/search keep the tab browser's rules.
    if (requested.kind !== 'resolve') {
      const blocked = requested.kind === 'list'
        ? listNeedsScope(sourceId, scope)
        : searchNeedsScope(sourceId, scope)
      if (blocked) {
        setAddView(requested)
        setAddCandidates([])
        setAddNext(undefined)
        setAddError(null)
        setAddLoading(false)
        setAddNeedsScope(requested.kind === 'search' ? 'search' : 'list')
        return
      }
    }
    setAddLoading(true)
    setAddError(null)
    setAddNeedsScope(null)
    try {
      if (requested.kind === 'resolve') {
        const resolved = await face.api.resolve(workspaceId, { text: requested.text }, controller.signal)
        if (controller.signal.aborted) return
        setAddCandidates(resolved.candidates)
        setAddNext(undefined)
        setAddView(requested)
        setAddLoading(false)
        return
      }
      if (requested.kind === 'list' && !source.capabilities.list) {
        setAddCandidates([])
        setAddNext(undefined)
        setAddError(t('clueBrowserUnsupported'))
        setAddLoading(false)
        return
      }
      if (requested.kind === 'search' && !source.capabilities.search) {
        setAddCandidates([])
        setAddNext(undefined)
        setAddError(t('clueBrowserSearchUnsupported'))
        setAddLoading(false)
        return
      }
      const params = {
        sourceId,
        ...(scope === undefined ? {} : { scope }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: ADD_PAGE_LIMIT,
      }
      const result = requested.kind === 'list'
        ? await face.api.list(workspaceId, params, controller.signal)
        : await face.api.search(workspaceId, { ...params, query: requested.query }, controller.signal)
      if (controller.signal.aborted) return
      setAddCandidates(result.items)
      setAddNext(result.nextCursor)
      setAddView(requested)
      setAddLoading(false)
    } catch (failure) {
      if (controller.signal.aborted) return
      setAddError(clueErrorMessage(failure, t('error')))
      setAddLoading(false)
    }
  }, [addScopes, face, sources, workspaceId])

  const pickSource = useCallback((sourceId: string): void => {
    // The cross-source selection is intentionally NOT cleared: it is the
    // whole point of the add page.
    setAddSourceId(sourceId)
    setAddQuery('')
    setAddCursorStack([])
    setAddScopeOpen(false)
    void loadAdd(sourceId, { kind: 'list' })
  }, [loadAdd])

  const applyAddScope = useCallback((): void => {
    if (addSourceId === null) return
    const built = scopeOfForm(addSourceId, addScopeForm)
    if (built.error !== undefined) {
      setAddScopeError(built.error)
      return
    }
    const nextScopes = { ...addScopes, [addSourceId]: built.scope }
    setAddScopes(nextScopes)
    props.onScopeChange?.(addSourceId, built.scope)
    setAddScopeError(null)
    setAddScopeOpen(false)
    setAddCursorStack([])
    void loadAdd(addSourceId, addView, undefined, nextScopes)
  }, [addSourceId, addScopeForm, addScopes, addView, loadAdd, props])

  const submitAddQuery = useCallback((): void => {
    if (addSourceId === null) return
    const text = addQuery.trim()
    setAddCursorStack([])
    void loadAdd(
      addSourceId,
      text === ''
        ? { kind: 'list' }
        : looksLikeResource(text) ? { kind: 'resolve', text } : { kind: 'search', query: text },
    )
  }, [addQuery, addSourceId, loadAdd])

  const addPage = useCallback((delta: 1 | -1): void => {
    if (addSourceId === null) return
    if (delta === 1) {
      if (addNext === undefined) return
      setAddCursorStack(current => [...current, addNext])
      void loadAdd(addSourceId, addView, addNext)
      return
    }
    if (addCursorStack.length === 0) return
    const nextStack = addCursorStack.slice(0, -1)
    setAddCursorStack(nextStack)
    void loadAdd(addSourceId, addView, nextStack[nextStack.length - 1])
  }, [addCursorStack, addNext, addSourceId, addView, loadAdd])

  const toggleAddSelection = useCallback((candidate: ClueCandidate): void => {
    const key = candidateKey(candidate)
    setAddSelected((current) => {
      const next = new Map(current)
      if (next.has(key)) next.delete(key)
      else next.set(key, candidate)
      return next
    })
  }, [])

  const toggleAddPin = useCallback(async (candidate: ClueCandidate): Promise<void> => {
    setAddPinBusy(true)
    try {
      const ensured = candidate.clueId ?? (await face.api.ensure(workspaceId, {
        sourceId: candidate.sourceId,
        typeId: candidate.typeId,
        locator: candidate.locator,
        title: candidate.title,
      })).clue.id
      const expectedRevision = addPinsRevision.current
      const mutation = { clueId: ensured, ...(expectedRevision === undefined ? {} : { expectedRevision }) }
      if (addPins.some(row => row.clueId === ensured)) await face.api.pinsRemove(workspaceId, mutation)
      else await face.api.pinsAdd(workspaceId, mutation)
      await refreshAddPins()
    } catch (failure) {
      props.onNotice(clueErrorMessage(failure, t('cluePinFailed')))
    } finally {
      setAddPinBusy(false)
    }
  }, [addPins, face, props, refreshAddPins, workspaceId])

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

  return (
    <div className={css.root} data-clue-pack-window>
      <div className={css.head}>
        <input
          className={css.nameInput}
          value={name}
          aria-label={t('cluePackName')}
          onChange={(event) => { setName(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') void saveName() }}
        />
        <div className={css.headActions}>
          <button
            type="button"
            className={css.primary}
            disabled={saving || name.trim() === '' || !pendingName}
            onClick={() => { void saveName() }}
          >
            {t('save')}
          </button>
          <button
            type="button"
            className={css.action}
            onClick={() => { props.onInsertPack(pack) }}
          >
            {t('cluePackInsert')}
          </button>
          <button
            type="button"
            className={css.action}
            onClick={() => {
              openShareWindow({ windows: props.windows, workspaceId, face, packIds: [pack.id] })
            }}
          >
            {t('clueShareExport')}
          </button>
        </div>
      </div>

      {loading && <div className={css.status} role="status">{t('loading')}</div>}
      {error !== null && <div className={css.error} role="alert">{error}</div>}
      {saveError !== null && <div className={css.error} role="alert">{saveError}</div>}
      {conflict && (
        <div className={css.conflict} role="alert">
          <span>{t('cluePackConflict')}</span>
          <button type="button" className={css.action} onClick={() => { void load() }}>{t('retry')}</button>
        </div>
      )}

      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t('cluePackMembers', { n: members.length })}</h3>
        <button
          type="button"
          className={css.action}
          aria-pressed={addOpen}
          onClick={() => { setAddOpen(value => !value) }}
        >
          {addOpen ? t('cluePackBack') : t('cluePackAddMembers')}
        </button>
      </div>

      {addOpen ? (
        <div className={css.addPage} data-clue-add-member>
          <nav className={css.addNav} aria-label={t('cluePackAddMembers')}>
            {enabledSources.map(source => (
              <button
                key={source.sourceId}
                type="button"
                className={css.sourceTab}
                data-active={source.sourceId === addSourceId ? 'true' : 'false'}
                onClick={() => { pickSource(source.sourceId) }}
              >
                <span className={css.sourceGlyph} aria-hidden="true">{sourceIcon(source.sourceId, displays)}</span>
                <span>{displayName(source.sourceId)}</span>
              </button>
            ))}
          </nav>
          {enabledSources.length === 0 && <div className={css.status}>{t('clueBrowserAllDisabled')}</div>}

          {addSourceId === null ? (
            <div className={css.status}>{t('cluePackPickSource')}</div>
          ) : (
            <>
              <div className={css.scopeBar}>
                <span className={css.scopeLabel}>
                  {`${t('clueBrowserScopeHeading')}: ${addSummary ?? t('clueBrowserScopeNeeded')}`}
                </span>
                {addSourceId === BUILTIN_SOURCE_IDS.feishuTasks
                  ? <span className={css.scopeHint}>{t('clueBrowserScopeTasksHint')}</span>
                  : (
                    <button
                      type="button"
                      className={css.action}
                      aria-expanded={addScopeOpen}
                      onClick={() => { setAddScopeOpen(value => !value) }}
                    >
                      {t('clueBrowserScopeEdit')}
                    </button>
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
                  <input
                    type="text"
                    className={css.searchInput}
                    value={addQuery}
                    placeholder={t('clueBrowserSearchPlaceholder')}
                    aria-label={t('clueBrowserSearchPlaceholder')}
                    onChange={(event) => { setAddQuery(event.target.value) }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      submitAddQuery()
                    }}
                  />
                </label>
                <button type="button" className={css.primary} onClick={submitAddQuery}>
                  {t('clueBrowserSearchAction')}
                </button>
              </div>

              <div className={css.pins} data-clue-add-pins>
                <span className={css.pinsHeading}>{t('clueBrowserPinsHeading')}</span>
                {addPins.length === 0
                  ? <span className={css.status}>{t('clueBrowserNoPins')}</span>
                  : (
                    <ul className={css.pinList}>
                      {addPins.map(row => {
                        const key = candidateKey(row)
                        return (
                          <li key={row.clueId} className={css.addRow}>
                            <label className={css.addLabel}>
                              <input
                                type="checkbox"
                                checked={addSelected.has(key)}
                                aria-label={t('clueBrowserSelectRow', { title: row.title })}
                                onChange={() => { toggleAddSelection(row) }}
                              />
                              <span className={css.addTitle}>{row.title}</span>
                              <span className={css.memberSource}>{displayName(row.sourceId)}</span>
                            </label>
                          </li>
                        )
                      })}
                    </ul>
                  )}
              </div>

              {addNeedsScope !== null && (
                <div className={css.stateLine} data-add-state="needs-scope">
                  <span>
                    {addNeedsScope === 'search'
                      ? t('clueBrowserSearchScopeNeeded')
                      : t('clueBrowserScopeNeeded')}
                  </span>
                  <button
                    type="button"
                    className={css.action}
                    onClick={() => { setAddScopeOpen(true) }}
                  >
                    {t('clueBrowserScopeEdit')}
                  </button>
                </div>
              )}
              {addLoading && <div className={css.status} role="status">{t('loading')}</div>}
              {addError !== null && <div className={css.error} role="alert">{addError}</div>}
              {!addLoading && addError === null && addNeedsScope === null && addCandidates.length === 0 && (
                <div className={css.status}>
                  {addView.kind === 'search' ? t('clueBrowserNoResults') : t('clueBrowserEmpty')}
                </div>
              )}
              <ul className={css.addList}>
                {addCandidates.map((candidate) => {
                  const key = candidateKey(candidate)
                  return (
                    <li key={key} className={css.addRow}>
                      <label className={css.addLabel}>
                        <input
                          type="checkbox"
                          checked={addSelected.has(key)}
                          aria-label={t('clueBrowserSelectRow', { title: candidate.title })}
                          onChange={() => { toggleAddSelection(candidate) }}
                        />
                        <span className={css.addTitle}>{candidate.title}</span>
                        {candidate.subtitle !== undefined && candidate.subtitle !== '' && (
                          <span className={css.memberSource}>{candidate.subtitle}</span>
                        )}
                      </label>
                      <button
                        type="button"
                        className={css.iconButton}
                        disabled={addPinBusy}
                        aria-label={addPins.some(row => row.clueId === candidate.clueId)
                          ? t('clueBrowserUnpinRow', { title: candidate.title })
                          : t('clueBrowserPinRow', { title: candidate.title })}
                        title={addPins.some(row => row.clueId === candidate.clueId)
                          ? t('clueBrowserUnpin')
                          : t('clueBrowserPin')}
                        onClick={() => { void toggleAddPin(candidate) }}
                      >
                        {addPins.some(row => row.clueId === candidate.clueId)
                          ? <IconPinFillRegular size={14} />
                          : <IconPinOutlineRegular size={14} />}
                      </button>
                    </li>
                  )
                })}
              </ul>
              <div className={css.pageBar}>
                <button
                  type="button"
                  className={css.action}
                  disabled={addCursorStack.length === 0 || addLoading}
                  onClick={() => { addPage(-1) }}
                >
                  {t('cluePagePrev')}
                </button>
                <span className={css.pageLabel}>{t('cluePageOf', { n: addCursorStack.length + 1 })}</span>
                <button
                  type="button"
                  className={css.action}
                  disabled={addNext === undefined || addLoading}
                  onClick={() => { addPage(1) }}
                >
                  {t('cluePageNext')}
                </button>
              </div>
              <div className={css.foot}>
                <span className={css.status}>
                  {t('clueBrowserSelected', { n: addSelected.size })}
                </span>
                <button
                  type="button"
                  className={css.action}
                  onClick={() => { setAddOpen(false); setAddSelected(new Map()) }}
                >
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  className={css.primary}
                  disabled={saving || addSelected.size === 0}
                  onClick={() => { void addMembers() }}
                >
                  {t('cluePackAddSelected')}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className={css.body}>
          {members.length === 0
            ? <div className={css.status}>{t('cluePackNoMembers')}</div>
            : (
              <ul className={css.memberList}>
                {members.map(row => (
                  <li key={row.clue.id} className={css.memberRow} data-unresolved={row.readable ? undefined : 'true'}>
                    <span className={css.memberGlyph} aria-hidden="true"><VscReferences size={14} /></span>
                    <button
                      type="button"
                      className={css.memberTitle}
                      title={row.clue.title}
                      onClick={() => { props.onInsertClue(row.clue.id, row.clue.title) }}
                    >
                      {row.clue.title}
                    </button>
                    <span className={css.memberSource}>{displayName(row.clue.sourceId)}</span>
                    {row.readable
                      ? null
                      : <span className={css.memberState}>{t('cluePackMemberUnresolved')}</span>}
                    <button
                      type="button"
                      className={css.iconButton}
                      aria-label={t('cluePackRemoveMember', { title: row.clue.title })}
                      title={t('cluePackRemoveMember', { title: row.clue.title })}
                      onClick={() => { void removeMember(row.clue.id) }}
                    >
                      <IconTrashOutlineRegular size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}

          <section className={css.binding} data-clue-binding-panel>
            <h3 className={css.sectionTitle}>{t('cluePackBindingHeading')}</h3>
            <p className={css.bindingHint}>{t('cluePackBindingHint')}</p>
            <p className={css.bindingHint}>{t('cluePackBindingUnbindHint')}</p>
            {bound
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
                  <select
                    className={css.select}
                    aria-label={t('cluePackBindingChoose')}
                    value={bindingTarget}
                    onChange={(event) => { setBindingTarget(event.target.value) }}
                  >
                    {workspaces.map(workspace => (
                      <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={css.primary}
                    disabled={bindingBusy || workspaces.length === 0}
                    onClick={() => { void addBinding() }}
                  >
                    {t('cluePackBind')}
                  </button>
                </div>
              )}
          </section>

          <div className={css.foot}>
            <button type="button" className={css.action} onClick={discardDraft}>{t('cancel')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
