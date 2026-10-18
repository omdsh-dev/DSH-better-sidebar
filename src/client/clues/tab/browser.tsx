/**
 * The clue tab's multi-source browser (lower region, S9).
 *
 * One input serves three jobs — keyword search, a direct resource URL/path
 * (resolved into candidates before anything is stored) and the empty-query
 * browse page of the current range. The range itself is SOURCE-SPECIFIC and
 * explicitly chosen (`owner/repo` for GitHub, a Drive/Wiki range for Feishu
 * docs, nothing for Feishu tasks); it is persisted per workspace+source by the
 * container, never derived from a cwd.
 *
 * What the reader can rely on:
 * - a source that is switched off is not listed here at all;
 * - a source without list support still offers pins + search + direct add —
 *   it never claims "no data";
 * - unsupported / range-needed / unauthorized / empty / network are distinct
 *   states, each with its own next step;
 * - switching source or range aborts the in-flight page and resets the cursor;
 * - the pin list is deduplicated against the page: a pinned row says so and its
 *   pin control turns into unpin;
 * - no total means prev/next only (the page counter is the local page, never a
 *   fabricated "1 / N").
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCloseOutlineRegular,
  IconEllipsisOutlineRegular,
  IconLinkOutlineRegular,
  IconPinFillRegular,
  IconPinOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ClueCandidate,
  ClueListResult,
  ClueSourceDescriptor,
  ClueSourceDisplayDescriptor,
  JsonValue,
} from '../../../clues/types.ts'
import type { ClueDetailTarget } from '../windows/detail.tsx'
import { BUILTIN_SOURCE_IDS } from '../../../clues/types.ts'
import type { BetterSidebarCluesClientFace } from '../registry.ts'
import { clueErrorMessage } from '../copy.ts'
import { t } from '../../locales.ts'
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
} from './browser-shared.tsx'
import css from './clues-tab.module.css'

/** The persisted range per source id (JSON value, absent = not chosen). */
export type ClueScopes = Readonly<Record<string, JsonValue | undefined>>

/** Props of the browser. */
export interface ClueBrowserProps {
  readonly workspaceId: string
  readonly face: BetterSidebarCluesClientFace
  readonly visible: boolean
  readonly scopes: ClueScopes
  onScopeChange(sourceId: string, scope: JsonValue | undefined): void
  onOpenDetail(target: ClueDetailTarget): void
  /** Insert one stable clue id into the draft; returns whether the chip landed. */
  onInsertClue(clueId: string, title: string): boolean
  onOpenSettings(): void
  onNotice(message: string): void
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

/** Page size of one browse/search request. */
const PAGE_SIZE = 25

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
  readonly clueId: string
}

/** The multi-source browser. */
export function ClueBrowser(props: ClueBrowserProps): ReactNode {
  const { workspaceId, face, visible, scopes } = props
  const { onScopeChange, onOpenDetail, onInsertClue, onOpenSettings, onNotice } = props

  const [sources, setSources] = useState<readonly ClueSourceDescriptor[]>([])
  const [displays, setDisplays] = useState<readonly ClueSourceDisplayDescriptor[]>([])
  const [cataloguePhase, setCataloguePhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [catalogueError, setCatalogueError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<View>({ kind: 'list' })
  const [state, setState] = useState<BrowserState>({ kind: 'idle' })
  const [cursorStack, setCursorStack] = useState<string[]>([])
  const [scopeOpen, setScopeOpen] = useState(false)
  const [form, setForm] = useState<ScopeForm>(EMPTY_FORM)
  const [scopeError, setScopeError] = useState<string | null>(null)
  const [pins, setPins] = useState<readonly { readonly clueId: string }[]>([])
  const [titles, setTitles] = useState<ReadonlyMap<string, PinnedRow>>(new Map())
  const [pinsOpen, setPinsOpen] = useState(true)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<ReadonlyMap<string, ClueCandidate>>(new Map())
  const [packChoices, setPackChoices] = useState<readonly { id: string; name: string }[]>([])
  const [packChoicesError, setPackChoicesError] = useState(false)
  const [busy, setBusy] = useState(false)
  const pinsRevisionRef = useRef<number | undefined>(undefined)
  const abortRef = useRef<AbortController | undefined>(undefined)
  /** The last request that actually went to the wire (Retry replays it). */
  const lastRequestRef = useRef<{ view: View; cursor: string | undefined }>({
    view: { kind: 'list' },
    cursor: undefined,
  })

  const enabled = useMemo(
    () => sources.filter(source => face.isSourceEnabled(source.sourceId)),
    [sources, face],
  )
  const active = useMemo(
    () => enabled.find(source => source.sourceId === activeId) ?? enabled[0],
    [enabled, activeId],
  )
  const activeSourceId = active?.sourceId
  const activeScope = activeSourceId === undefined ? undefined : scopes[activeSourceId]

  // ── catalogue + local library/pins ─────────────────────────────────────────

  const loadCatalogue = useCallback(async (signal?: AbortSignal): Promise<void> => {
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

  const refreshLocal = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const [pinResult, library] = await Promise.all([
        face.api.pinsList(workspaceId),
        face.api.clues(workspaceId),
      ])
      if (signal?.aborted === true) return
      pinsRevisionRef.current = pinResult.revision
      setPins(pinResult.pins.map(pin => ({ clueId: pin.clueId })))
      const next = new Map<string, PinnedRow>()
      for (const clue of library.clues) {
        next.set(clue.id, { title: clue.title, sourceId: clue.sourceId, typeId: clue.typeId, clueId: clue.id })
      }
      setTitles(next)
    } catch {
      // The pin strip is a convenience: a failed read leaves the page working.
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

  // Source switching: abort the old page, reset the cursor and the input view.
  useEffect(() => {
    if (!visible) return
    abortRef.current?.abort()
    setCursorStack([])
    setQuery('')
    setView({ kind: 'list' })
    setState({ kind: 'idle' })
  }, [visible, activeSourceId])

  useEffect(() => {
    if (activeSourceId === undefined) return
    setForm(formOf(activeSourceId, scopes[activeSourceId]))
    setScopeError(null)
  }, [activeSourceId, scopes])

  // ── one page ───────────────────────────────────────────────────────────────

  const run = useCallback(async (requested: View, cursor: string | undefined): Promise<void> => {
    if (active === undefined) return
    // A direct resource URL/path resolves WITHOUT any browse range: it names
    // its own resource, so a source whose range is still unchosen must never
    // block the independent resolve action.
    if (requested.kind !== 'resolve') {
      const blocked = requested.kind === 'list'
        ? listNeedsScope(active.sourceId, activeScope)
        : searchNeedsScope(active.sourceId, activeScope)
      if (blocked) {
        setState({ kind: 'needs-scope', reason: requested.kind === 'search' ? 'search' : 'list' })
        return
      }
    }
    lastRequestRef.current = { view: requested, cursor }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setState({ kind: 'loading' })
    try {
      if (requested.kind === 'resolve') {
        const resolved = await face.api.resolve(workspaceId, { text: requested.text }, controller.signal)
        if (controller.signal.aborted) return
        setState({ kind: 'resolved', candidates: resolved.candidates, text: requested.text })
        return
      }
      if (requested.kind === 'list' && !active.capabilities.list) {
        setState({ kind: 'unsupported', reason: 'no-list' })
        return
      }
      if (requested.kind === 'search' && !active.capabilities.search) {
        setState({ kind: 'unsupported', reason: 'no-search' })
        return
      }
      const params = {
        sourceId: active.sourceId,
        ...(activeScope === undefined ? {} : { scope: activeScope }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: PAGE_SIZE,
      }
      const result = requested.kind === 'list'
        ? await face.api.list(workspaceId, params, controller.signal)
        : await face.api.search(workspaceId, { ...params, query: requested.query }, controller.signal)
      if (controller.signal.aborted) return
      setState({ kind: 'page', view: requested, result })
    } catch (failure) {
      if (controller.signal.aborted) return
      setState({ kind: 'error', message: clueErrorMessage(failure, t('error')) })
    }
  }, [active, activeScope, face, workspaceId])

  // ONE loader: the current view + cursor decide what is fetched. A browse
  // range that is still unchosen blocks list/search — but never a direct
  // resource resolve, and a Feishu browse-only root blocks only SEARCH.
  useEffect(() => {
    if (!visible || active === undefined) return
    void run(view, cursorStack[cursorStack.length - 1])
    // `activeScope` changes identity only when the persisted range changes.
  }, [visible, active, activeScope, view, cursorStack, run])

  const onScopeApply = useCallback((): void => {
    if (activeSourceId === undefined) return
    const built = scopeOfForm(activeSourceId, form)
    if (built.error !== undefined) {
      setScopeError(built.error)
      return
    }
    setScopeError(null)
    setCursorStack([])
    onScopeChange(activeSourceId, built.scope)
    setScopeOpen(false)
  }, [activeSourceId, form, onScopeChange])

  const onSubmitQuery = useCallback((): void => {
    const text = query.trim()
    setCursorStack([])
    if (text === '') {
      setView({ kind: 'list' })
      return
    }
    setView(looksLikeResource(text) ? { kind: 'resolve', text } : { kind: 'search', query: text })
  }, [query])

  // ── pins / insert / selection ──────────────────────────────────────────────

  const ensureClueId = useCallback(async (candidate: ClueCandidate): Promise<string> => {
    const ensured = await face.api.ensure(workspaceId, {
      sourceId: candidate.sourceId,
      typeId: candidate.typeId,
      locator: candidate.locator,
      title: candidate.title,
    })
    return ensured.clue.id
  }, [face, workspaceId])

  const pinnedIds = useMemo(() => new Set(pins.map(pin => pin.clueId)), [pins])

  const applyPins = useCallback((result: { pins: readonly { clueId: string }[]; revision: number }): void => {
    pinsRevisionRef.current = result.revision
    setPins(result.pins.map(pin => ({ clueId: pin.clueId })))
  }, [])

  const togglePin = useCallback(async (candidate: ClueCandidate): Promise<void> => {
    setBusy(true)
    try {
      const clueId = candidate.clueId ?? await ensureClueId(candidate)
      const expectedRevision = pinsRevisionRef.current
      const mutation = { clueId, ...(expectedRevision === undefined ? {} : { expectedRevision }) }
      applyPins(pinnedIds.has(clueId)
        ? await face.api.pinsRemove(workspaceId, mutation)
        : await face.api.pinsAdd(workspaceId, mutation))
      void refreshLocal()
    } catch (failure) {
      onNotice(clueErrorMessage(failure, t('cluePinFailed')))
    } finally {
      setBusy(false)
    }
  }, [ensureClueId, face, workspaceId, pinnedIds, applyPins, refreshLocal, onNotice])

  const unpinById = useCallback(async (clueId: string): Promise<void> => {
    setBusy(true)
    try {
      const expectedRevision = pinsRevisionRef.current
      applyPins(await face.api.pinsRemove(workspaceId, {
        clueId,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }))
      void refreshLocal()
    } catch (failure) {
      onNotice(clueErrorMessage(failure, t('cluePinFailed')))
    } finally {
      setBusy(false)
    }
  }, [face, workspaceId, applyPins, refreshLocal, onNotice])

  const insertCandidate = useCallback(async (candidate: ClueCandidate): Promise<void> => {
    setBusy(true)
    try {
      const clueId = candidate.clueId ?? await ensureClueId(candidate)
      if (!onInsertClue(clueId, candidate.title)) onNotice(t('clueInsertFailed'))
      else void refreshLocal()
    } catch (failure) {
      onNotice(clueErrorMessage(failure, t('clueInsertFailed')))
    } finally {
      setBusy(false)
    }
  }, [ensureClueId, onInsertClue, refreshLocal, onNotice])

  const insertSelected = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      for (const candidate of selected.values()) {
        const clueId = candidate.clueId ?? await ensureClueId(candidate)
        if (!onInsertClue(clueId, candidate.title)) {
          onNotice(t('clueInsertFailed'))
          break
        }
      }
      setSelected(new Map())
      setSelectionMode(false)
      void refreshLocal()
    } catch (failure) {
      onNotice(clueErrorMessage(failure, t('clueInsertFailed')))
    } finally {
      setBusy(false)
    }
  }, [selected, ensureClueId, onInsertClue, refreshLocal, onNotice])

  const loadPackChoices = useCallback(async (): Promise<void> => {
    try {
      const result = await face.api.packsList(workspaceId)
      setPackChoices(result.packs.map(pack => ({ id: pack.id, name: pack.name })))
      setPackChoicesError(false)
    } catch (failure) {
      // A failed list is not "no packs": say so and keep Retry reachable.
      setPackChoices([])
      setPackChoicesError(true)
      onNotice(clueErrorMessage(failure, t('error')))
    }
  }, [face, workspaceId, onNotice])

  const addSelectedToPack = useCallback(async (packId: string): Promise<void> => {
    if (packId === '') return
    setBusy(true)
    try {
      // Sequential on purpose: every mutation returns the pack's new revision,
      // and the next member must send it as the CAS baseline.
      let revision: number | undefined
      let packName = ''
      for (const candidate of selected.values()) {
        const clueId = candidate.clueId ?? await ensureClueId(candidate)
        const result = await face.api.packsAddMember(workspaceId, {
          packId,
          clueId,
          ...(revision === undefined ? {} : { expectedRevision: revision }),
        })
        revision = result.packRevision
        packName = result.pack.name
      }
      onNotice(t('cluePackMembersAdded', { name: packName }))
      setSelected(new Map())
      setSelectionMode(false)
      void refreshLocal()
    } catch (failure) {
      onNotice(clueErrorMessage(failure, t('cluePackSaveFailed')))
    } finally {
      setBusy(false)
    }
  }, [selected, ensureClueId, face, workspaceId, refreshLocal, onNotice])

  // ── render helpers ─────────────────────────────────────────────────────────

  const displayName = (sourceId: string): string => {
    const source = sources.find(candidate => candidate.sourceId === sourceId)
    return source === undefined ? sourceId : sourceLabel(source, displays)
  }

  const pinnedRows: readonly PinnedRow[] = pins
    .map(pin => titles.get(pin.clueId))
    .filter((row): row is PinnedRow => row !== undefined)

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
    candidate.clueId !== undefined && pinnedIds.has(candidate.clueId)

  const candidates: readonly ClueCandidate[] =
    state.kind === 'page' ? state.result.items : state.kind === 'resolved' ? state.candidates : []

  const hasNext = state.kind === 'page' && state.result.nextCursor !== undefined
  const page = cursorStack.length + 1
  const summary = active === undefined ? undefined : scopeSummary(active.sourceId, activeScope)

  return (
    <section className={css.browser} aria-labelledby="clue-browser-heading">
      <div className={css.sectionHead}>
        <h3 id="clue-browser-heading" className={css.sectionTitle}>{t('clueBrowserHeading')}</h3>
        <div className={css.sectionTools}>
          <button
            type="button"
            className={css.toolButton}
            aria-pressed={selectionMode}
            onClick={() => {
              setSelectionMode(value => !value)
              setSelected(new Map())
            }}
          >
            {selectionMode ? t('clueBrowserSelectDone') : t('clueBrowserSelect')}
          </button>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('clueTabSettingsAria')}
            title={t('clueTabSettingsAria')}
            onClick={onOpenSettings}
          >
            <IconEllipsisOutlineRegular size={14} />
          </button>
        </div>
      </div>

      {cataloguePhase === 'loading' && <div className={css.stateLine} role="status">{t('loading')}</div>}
      {cataloguePhase === 'error' && (
        <div className={css.stateLine}>
          <span>{catalogueError ?? t('error')}</span>
          <button type="button" className={css.stateAction} onClick={() => { void loadCatalogue() }}>{t('retry')}</button>
        </div>
      )}
      {cataloguePhase === 'ready' && enabled.length === 0 && (
        <div className={css.stateLine}>
          <span>{t('clueBrowserAllDisabled')}</span>
          <button type="button" className={css.stateAction} onClick={onOpenSettings}>{t('clueBrowserOpenSettings')}</button>
        </div>
      )}

      {enabled.length > 0 && active !== undefined && (
        <div className={css.browserBody}>
          <nav className={css.sourceNav} aria-label={t('clueBrowserHeading')}>
            {enabled.map(source => {
              const current = source.sourceId === active.sourceId
              return (
                <button
                  key={source.sourceId}
                  type="button"
                  className={css.sourceTab}
                  aria-current={current ? 'true' : undefined}
                  data-active={current ? 'true' : 'false'}
                  onClick={() => { setActiveId(source.sourceId) }}
                >
                  <span className={css.sourceGlyph} aria-hidden="true">{sourceIcon(source.sourceId, displays)}</span>
                  <span className={css.sourceName}>{sourceLabel(source, displays)}</span>
                </button>
              )
            })}
          </nav>

          <div className={css.browserMain}>
            <div className={css.scopeBar}>
              <span className={css.scopeLabel}>
                {`${t('clueBrowserScopeHeading')}: ${summary ?? t('clueBrowserScopeNeeded')}`}
              </span>
              {active.sourceId === BUILTIN_SOURCE_IDS.feishuTasks
                ? <span className={css.scopeHint}>{t('clueBrowserScopeTasksHint')}</span>
                : (
                  <button
                    type="button"
                    className={css.toolButton}
                    aria-expanded={scopeOpen}
                    onClick={() => { setScopeOpen(value => !value) }}
                  >
                    {t('clueBrowserScopeEdit')}
                  </button>
                )}
            </div>

            {scopeOpen && active.sourceId !== BUILTIN_SOURCE_IDS.feishuTasks && (
              <form
                className={css.scopeEditor}
                onSubmit={(event) => { event.preventDefault(); onScopeApply() }}
              >
                <ScopeFields sourceId={active.sourceId} form={form} onChange={(next) => { setForm(next) }} />
                {scopeError !== null && <span className={css.fieldError} role="alert">{scopeError}</span>}
                <div className={css.scopeActions}>
                  <button type="submit" className={css.primaryButton}>{t('clueBrowserScopeApply')}</button>
                  <button type="button" className={css.toolButton} onClick={() => { setScopeOpen(false); setScopeError(null) }}>
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
                  value={query}
                  placeholder={t('clueBrowserSearchPlaceholder')}
                  aria-label={t('clueBrowserSearchPlaceholder')}
                  onChange={(event) => { setQuery(event.target.value) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      onSubmitQuery()
                    }
                  }}
                />
              </label>
              <button type="button" className={css.primaryButton} onClick={onSubmitQuery}>
                {t('clueBrowserSearchAction')}
              </button>
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('refresh')}
                title={t('refresh')}
                onClick={() => { setCursorStack([]); setView({ kind: 'list' }) }}
              >
                <IconRefreshOutlineRegular size={14} />
              </button>
            </div>

            <PinsPanel
              pinned={pinnedRows}
              open={pinsOpen}
              onToggle={() => { setPinsOpen(value => !value) }}
              displayName={displayName}
              busy={busy}
              onOpenDetail={(row) => {
                onOpenDetail({ sourceId: row.sourceId, typeId: row.typeId, clueId: row.clueId, title: row.title })
              }}
              onInsert={(row) => {
                if (!onInsertClue(row.clueId, row.title)) onNotice(t('clueInsertFailed'))
              }}
              onUnpin={(row) => { void unpinById(row.clueId) }}
            />

            <div className={css.resultArea} data-clue-browser-state={state.kind}>
              {state.kind === 'idle' && <div className={css.stateLine}>{t('clueBrowserSearchNeeded')}</div>}
              {state.kind === 'loading' && <div className={css.stateLine} role="status">{t('loading')}</div>}
              {state.kind === 'needs-scope' && (
                <div className={css.stateLine}>
                  <span>{state.reason === 'search' ? t('clueBrowserSearchScopeNeeded') : t('clueBrowserScopeNeeded')}</span>
                  <button type="button" className={css.stateAction} onClick={() => { setScopeOpen(true) }}>
                    {t('clueBrowserScopeEdit')}
                  </button>
                </div>
              )}
              {state.kind === 'unsupported' && (
                <div className={css.stateLine}>
                  {state.reason === 'no-list' ? t('clueBrowserUnsupported') : t('clueBrowserSearchUnsupported')}
                </div>
              )}
              {state.kind === 'error' && (
                <div className={css.stateLine}>
                  <span>{state.message}</span>
                  <button
                    type="button"
                    className={css.stateAction}
                    onClick={() => {
                      const last = lastRequestRef.current
                      void run(last.view, last.cursor)
                    }}
                  >
                    {t('retry')}
                  </button>
                </div>
              )}
              {state.kind === 'page' && state.result.items.length === 0 && (
                <div className={css.stateLine}>
                  {state.view.kind === 'search' ? t('clueBrowserNoResults') : t('clueBrowserEmpty')}
                </div>
              )}
              {state.kind === 'resolved' && (
                <div className={css.resolveHead}>
                  <span>{t('clueBrowserResolveHeading')}</span>
                  <span className={css.scopeHint}>{t('clueBrowserResolveHint')}</span>
                </div>
              )}
              {state.kind === 'resolved' && state.candidates.length === 0 && (
                <div className={css.stateLine}>{t('clueBrowserResolveEmpty')}</div>
              )}

              {candidates.length > 0 && (
                <ul className={css.resultList}>
                  {candidates.map(candidate => {
                    const pinned = rowPinned(candidate)
                    const key = candidateKey(candidate)
                    return (
                      <li key={key} className={css.resultRow} data-pinned={pinned ? 'true' : 'false'}>
                        {selectionMode && (
                          <input
                            type="checkbox"
                            className={css.rowCheckbox}
                            checked={selected.has(key)}
                            aria-label={t('clueBrowserSelectRow', { title: candidate.title })}
                            onChange={() => { selectionToggle(candidate) }}
                          />
                        )}
                        <span className={css.rowGlyph} aria-hidden="true">{sourceIcon(candidate.sourceId, displays)}</span>
                        <button
                          type="button"
                          className={css.rowTitle}
                          title={candidate.title}
                          onClick={() => {
                            onOpenDetail({
                              sourceId: candidate.sourceId,
                              typeId: candidate.typeId,
                              ...(candidate.clueId === undefined ? {} : { clueId: candidate.clueId }),
                              locator: candidate.locator,
                              title: candidate.title,
                            })
                          }}
                        >
                          <span className={css.rowName}>{candidate.title}</span>
                          {candidate.subtitle !== undefined && candidate.subtitle !== '' && (
                            <span className={css.rowSubtitle}>{candidate.subtitle}</span>
                          )}
                        </button>
                        {pinned && <span className={css.pinnedBadge}>{t('clueBrowserPinnedBadge')}</span>}
                        <span className={css.rowActions}>
                          <button
                            type="button"
                            className={css.iconButton}
                            aria-label={t('clueBrowserInsertRow', { title: candidate.title })}
                            title={t('clueBrowserInsert')}
                            disabled={busy}
                            onClick={() => { void insertCandidate(candidate) }}
                          >
                            <IconLinkOutlineRegular size={14} />
                          </button>
                          <button
                            type="button"
                            className={css.iconButton}
                            aria-label={pinned
                              ? t('clueBrowserUnpinRow', { title: candidate.title })
                              : t('clueBrowserPinRow', { title: candidate.title })}
                            title={pinned ? t('clueBrowserUnpin') : t('clueBrowserPin')}
                            disabled={busy}
                            onClick={() => { void togglePin(candidate) }}
                          >
                            {pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}
                          </button>
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}

              {state.kind === 'page' && (
                <div className={css.pageBar}>
                  {state.result.total !== undefined && (
                    <span className={css.pageLabel}>{t('clueBrowserTotal', { n: state.result.total })}</span>
                  )}
                  <button
                    type="button"
                    className={css.toolButton}
                    disabled={cursorStack.length === 0}
                    onClick={() => { setCursorStack(current => current.slice(0, -1)) }}
                  >
                    <IconChevronLeftOutlineRegular size={14} />
                    {t('cluePagePrev')}
                  </button>
                  <span className={css.pageLabel}>{t('cluePageOf', { n: page })}</span>
                  <button
                    type="button"
                    className={css.toolButton}
                    disabled={!hasNext}
                    onClick={() => {
                      const next = state.kind === 'page' ? state.result.nextCursor : undefined
                      if (next !== undefined) setCursorStack(current => [...current, next])
                    }}
                  >
                    {t('cluePageNext')}
                    <IconChevronRightOutlineRegular size={14} />
                  </button>
                  {state.result.limited === true && <span className={css.scopeHint}>{t('clueBrowserLimited')}</span>}
                </div>
              )}
            </div>

            {selectionMode && selected.size > 0 && (
              <div className={css.batchBar} role="region" aria-label={t('clueBrowserSelected', { n: selected.size })}>
                <span className={css.batchCount}>{t('clueBrowserSelected', { n: selected.size })}</span>
                <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { void insertSelected() }}>
                  {t('clueBrowserInsertSelected')}
                </button>
                <select
                  className={css.select}
                  aria-label={t('clueBrowserAddToPack')}
                  value=""
                  disabled={busy}
                  onFocus={() => { if (packChoices.length === 0) void loadPackChoices() }}
                  onChange={(event) => {
                    const packId = event.target.value
                    if (packId !== '') void addSelectedToPack(packId)
                  }}
                >
                  <option value="">
                    {packChoicesError ? t('error') : packChoices.length === 0 ? t('clueBrowserNoPacks') : t('clueBrowserAddToPack')}
                  </option>
                  {packChoices.map(pack => <option key={pack.id} value={pack.id}>{pack.name}</option>)}
                </select>
                {packChoicesError && (
                  <button type="button" className={css.stateAction} onClick={() => { void loadPackChoices() }}>
                    {t('retry')}
                  </button>
                )}
                <button type="button" className={css.toolButton} onClick={() => { setSelected(new Map()) }}>
                  <IconCloseOutlineRegular size={14} />
                  {t('cancel')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

/** The collapsible pin strip. */
function PinsPanel(props: {
  readonly pinned: readonly PinnedRow[]
  readonly open: boolean
  readonly busy: boolean
  onToggle(): void
  displayName(sourceId: string): string
  onOpenDetail(row: PinnedRow): void
  onInsert(row: PinnedRow): void
  onUnpin(row: PinnedRow): void
}): ReactNode {
  const { pinned, open, busy } = props
  return (
    <div className={css.pins}>
      <button type="button" className={css.pinsHead} aria-expanded={open} onClick={props.onToggle}>
        <IconPinFillRegular size={14} />
        <span>{t('clueBrowserPinsHeading')}</span>
        <span className={css.pinsCount}>{pinned.length}</span>
        <IconChevronRightOutlineRegular size={14} />
      </button>
      {open && (
        <div className={css.pinsBody}>
          {pinned.length === 0
            ? <span className={css.stateLine}>{t('clueBrowserNoPins')}</span>
            : (
              <ul className={css.pinList}>
                {pinned.map(row => (
                  <li key={row.clueId} className={css.pinRow}>
                    <button
                      type="button"
                      className={css.rowTitle}
                      title={row.title}
                      onClick={() => { props.onOpenDetail(row) }}
                    >
                      <span className={css.rowName}>{row.title}</span>
                      <span className={css.rowSubtitle}>{props.displayName(row.sourceId)}</span>
                    </button>
                    <span className={css.rowActions}>
                      <button
                        type="button"
                        className={css.iconButton}
                        aria-label={t('clueBrowserInsertRow', { title: row.title })}
                        title={t('clueBrowserInsert')}
                        disabled={busy}
                        onClick={() => { props.onInsert(row) }}
                      >
                        <IconLinkOutlineRegular size={14} />
                      </button>
                      <button
                        type="button"
                        className={css.iconButton}
                        aria-label={t('clueBrowserUnpinRow', { title: row.title })}
                        title={t('clueBrowserUnpin')}
                        disabled={busy}
                        onClick={() => { props.onUnpin(row) }}
                      >
                        <IconPinFillRegular size={14} />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}
    </div>
  )
}
