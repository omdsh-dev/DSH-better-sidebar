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
  IconCheckOutlineRegular,
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
} from '../../../clues/types.ts'
import type { BetterSidebarCluesClientFace } from '../registry.ts'
import type { BetterSidebarWindowsClientFace, WindowHandle } from '../../windows/types.ts'
import { clueErrorMessage } from '../copy.ts'
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
}

/** One member row as the panel renders it. */
interface MemberRow {
  readonly clue: Clue
  readonly readable: boolean
}

/** One add-member page request. */
type AddView =
  | { readonly kind: 'list' }
  | { readonly kind: 'search'; readonly query: string }

const ADD_PAGE_LIMIT = 20

/** Stable key of one candidate. */
function candidateKey(candidate: ClueCandidate): string {
  return `${candidate.sourceId}\u0000${candidate.typeId}\u0000${JSON.stringify(candidate.locator)}`
}

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
  return options.windows.open({
    id: packWindowId(options.pack.id),
    title: options.pack.name,
    size: 'collection',
    content: <PackManagementPage {...options} guard={guard} />,
    onBeforeClose: () => !guard.dirty,
  })
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
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addSourceId, setAddSourceId] = useState<string | null>(null)
  const [addQuery, setAddQuery] = useState('')
  const [addCandidates, setAddCandidates] = useState<readonly ClueCandidate[]>([])
  const [addNext, setAddNext] = useState<string | undefined>(undefined)
  const [addLoading, setAddLoading] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [addView, setAddView] = useState<AddView>({ kind: 'list' })
  const [addSelected, setAddSelected] = useState<ReadonlyMap<string, ClueCandidate>>(new Map())
  const addAbort = useRef<AbortController | undefined>(undefined)

  const pendingName = name !== pack.name

  useEffect(() => {
    guard.dirty = pendingName
  }, [guard, pendingName])

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoading(true)
    setError(null)
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
    try {
      const result = await face.api.packsRename(workspaceId, {
        packId: pack.id,
        name: name.trim(),
        expectedRevision: pack.revision,
      })
      setPack(result.pack)
      setName(result.pack.name)
    } catch (failure) {
      setConflict(true)
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

  const loadAdd = useCallback(async (sourceId: string, view: AddView, cursor?: string): Promise<void> => {
    addAbort.current?.abort()
    const controller = new AbortController()
    addAbort.current = controller
    setAddLoading(true)
    setAddError(null)
    try {
      const params = {
        sourceId,
        limit: ADD_PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      }
      const result = view.kind === 'list'
        ? await face.api.list(workspaceId, params, controller.signal)
        : await face.api.search(workspaceId, { ...params, query: view.query }, controller.signal)
      if (controller.signal.aborted) return
      setAddCandidates(result.items)
      setAddNext(result.nextCursor)
      setAddView(view)
      setAddLoading(false)
    } catch (failure) {
      if (controller.signal.aborted) return
      setAddError(clueErrorMessage(failure, t('error')))
      setAddLoading(false)
    }
  }, [face, workspaceId])

  const pickSource = useCallback((sourceId: string): void => {
    setAddSourceId(sourceId)
    setAddQuery('')
    setAddSelected(new Map())
    void loadAdd(sourceId, { kind: 'list' })
  }, [loadAdd])

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
      props.onNotice(t('cluePackMembersAdded'))
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
  }

  return (
    <div className={css.root} data-clue-pack-window>
      <div className={css.head}>
        <input
          className={css.nameInput}
          value={name}
          aria-label={t('cluePackName')}
          onChange={(event) => { setName(event.target.value) }}
          onBlur={() => { void saveName() }}
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
            {sources.map(source => (
              <button
                key={source.sourceId}
                type="button"
                className={css.sourceTab}
                data-active={source.sourceId === addSourceId ? 'true' : 'false'}
                onClick={() => { pickSource(source.sourceId) }}
              >
                {source.sourceId === addSourceId ? <IconCheckOutlineRegular size={14} /> : null}
                <span>{displayName(source.sourceId)}</span>
              </button>
            ))}
          </nav>

          {addSourceId === null ? (
            <div className={css.status}>{t('cluePackPickSource')}</div>
          ) : (
            <>
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
                      const text = addQuery.trim()
                      void loadAdd(addSourceId, text === '' ? { kind: 'list' } : { kind: 'search', query: text })
                    }}
                  />
                </label>
                <button
                  type="button"
                  className={css.primary}
                  onClick={() => {
                    const text = addQuery.trim()
                    void loadAdd(addSourceId, text === '' ? { kind: 'list' } : { kind: 'search', query: text })
                  }}
                >
                  {t('clueBrowserSearchAction')}
                </button>
              </div>
              {addLoading && <div className={css.status} role="status">{t('loading')}</div>}
              {addError !== null && <div className={css.error} role="alert">{addError}</div>}
              {!addLoading && addError === null && addCandidates.length === 0 && (
                <div className={css.status}>{t('clueBrowserEmpty')}</div>
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
                          onChange={() => {
                            setAddSelected((current) => {
                              const next = new Map(current)
                              if (next.has(key)) next.delete(key)
                              else next.set(key, candidate)
                              return next
                            })
                          }}
                        />
                        <span className={css.addTitle}>{candidate.title}</span>
                        {candidate.subtitle !== undefined && candidate.subtitle !== '' && (
                          <span className={css.memberSource}>{candidate.subtitle}</span>
                        )}
                      </label>
                    </li>
                  )
                })}
              </ul>
              <div className={css.foot}>
                <span className={css.status}>
                  {t('clueBrowserSelected', { n: addSelected.size })}
                  {addView.kind === 'search' ? ` · ${t('clueBrowserResolveHeading')}` : ''}
                </span>
                <button
                  type="button"
                  className={css.action}
                  disabled={addNext === undefined || addLoading}
                  onClick={() => { void loadAdd(addSourceId, addView, addNext) }}
                >
                  {t('cluePageNext')}
                </button>
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
