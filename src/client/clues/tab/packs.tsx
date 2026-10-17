/**
 * The clue tab's pack library (upper region, S9).
 *
 * A pack is a local collection of clue ids: this section only browses it, makes
 * one-click references and hands management to the S6 window. Two INDEPENDENT
 * actions per node:
 *
 * - the node body inserts the pack reference into the draft (`[[dsh-cluepack:<id>]]`)
 *   — never sends, never opens the editor;
 * - the bottom strip (member count + gear) opens the pack management window.
 *
 * They are sibling buttons, not nested ones, so a keyboard user can reach both
 * and no click is disambiguated through event bubbling.
 *
 * Pagination and the search filter are CLIENT-side: the host returns the whole
 * pack list for one workspace (there is no server total, so no page count is
 * invented — the bar shows page n and prev/next only when another page exists).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { VscReferences, VscSettingsGear } from 'react-icons/vsc'
import type { CluePack } from '../../../clues/types.ts'
import type { BetterSidebarCluesClientFace } from '../registry.ts'
import { clueErrorMessage } from '../copy.ts'
import { t } from '../../locales.ts'
import css from './clues-tab.module.css'

/** One page of packs (a bounded first screen, not an infinite stack). */
const PAGE_SIZE = 8

/** Props of the pack library. */
export interface CluePacksSectionProps {
  readonly workspaceId: string
  readonly face: BetterSidebarCluesClientFace
  /** Whether the page is on screen (a hidden tab body performs no query). */
  readonly visible: boolean
  /** This tab descriptor's plugin settings blob (recent-use order). */
  readonly settings: Record<string, unknown>
  /** Persist the sparse plugin settings blob (recent-use order only). */
  onSettingsChange(next: Record<string, unknown>): void
  /** Insert one pack reference into the draft; returns whether the chip landed. */
  onInsertPack(pack: CluePack): boolean
  /** Open the S6 pack management window. */
  onOpenPack(pack: CluePack): void
  /** Open the S6 share/import window. */
  onImport(): void
  onNotice(message: string): void
}

/** Read the recent-use order out of the plugin settings blob (defensive). */
function recentOf(settings: Record<string, unknown>): string[] {
  const value = settings.recentPacks
  if (!Array.isArray(value)) return []
  return value.filter((id): id is string => typeof id === 'string')
}

/** Order packs by recent use first, then by last update (newest first). */
function orderPacks(packs: readonly CluePack[], recent: readonly string[]): CluePack[] {
  const rank = new Map(recent.map((id, index) => [id, index]))
  return [...packs].sort((left, right) => {
    const leftRank = rank.get(left.id)
    const rightRank = rank.get(right.id)
    if (leftRank !== undefined || rightRank !== undefined) {
      return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER)
    }
    return right.updatedAt.localeCompare(left.updatedAt)
  })
}

/** The pack library section. */
export function CluePacksSection(props: CluePacksSectionProps): ReactNode {
  const { workspaceId, face, visible, settings, onSettingsChange, onOpenPack, onImport, onNotice } = props
  const { onInsertPack } = props
  const [packs, setPacks] = useState<readonly CluePack[]>([])
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [creatingBusy, setCreatingBusy] = useState(false)

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setPhase('loading')
    setError(null)
    try {
      const result = await face.api.packsList(workspaceId)
      if (signal?.aborted === true) return
      setPacks(result.packs)
      setPhase('ready')
    } catch (failure) {
      if (signal?.aborted === true) return
      setPhase('error')
      setError(clueErrorMessage(failure, t('error')))
    }
  }, [face, workspaceId])

  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    void load(controller.signal)
    return () => { controller.abort() }
  }, [load, visible])

  const visiblePacks = useMemo(() => {
    const query = search.trim().toLowerCase()
    const filtered = query === '' ? packs : packs.filter(pack => pack.name.toLowerCase().includes(query))
    return orderPacks(filtered, recentOf(settings))
  }, [packs, search, settings])

  const pageCount = Math.max(1, Math.ceil(visiblePacks.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const shown = visiblePacks.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE)

  const rememberUse = useCallback((packId: string): void => {
    const recent = recentOf(settings).filter(id => id !== packId)
    recent.unshift(packId)
    onSettingsChange({ ...settings, recentPacks: recent.slice(0, 20) })
  }, [settings, onSettingsChange])

  const onCreate = useCallback(async (): Promise<void> => {
    const name = newName.trim() === '' ? t('cluePacksUntitled') : newName.trim()
    setCreatingBusy(true)
    try {
      const created = await face.api.packsCreate(workspaceId, { name })
      setPacks(current => [...current, created.pack])
      setCreating(false)
      setNewName('')
      setCreatingBusy(false)
      onOpenPack(created.pack)
    } catch (failure) {
      setCreatingBusy(false)
      onNotice(clueErrorMessage(failure, t('cluePackSaveFailed')))
    }
  }, [face, workspaceId, newName, onOpenPack, onNotice])

  return (
    <section className={css.section} aria-labelledby="clue-packs-heading">
      <div className={css.sectionHead}>
        <h3 id="clue-packs-heading" className={css.sectionTitle}>{t('cluePacksHeading')}</h3>
        <div className={css.sectionTools}>
          <label className={css.searchBox}>
            <IconSearchOutlineRegular size={14} />
            <input
              type="search"
              className={css.searchInput}
              value={search}
              placeholder={t('cluePacksSearchPlaceholder')}
              aria-label={t('cluePacksSearchPlaceholder')}
              onChange={(event) => { setSearch(event.target.value); setPage(0) }}
            />
          </label>
          <button
            type="button"
            className={css.toolButton}
            onClick={() => { setCreating(value => !value); setPage(0) }}
            aria-expanded={creating}
          >
            <IconPlusOutlineRegular size={14} />
            <span>{t('cluePacksNew')}</span>
          </button>
          <button type="button" className={css.toolButton} onClick={onImport}>{t('clueShareImport')}</button>
          <button
            type="button"
            className={css.iconButton}
            onClick={() => { void load() }}
            aria-label={t('refresh')}
            title={t('refresh')}
          >
            <IconRefreshOutlineRegular size={14} />
          </button>
        </div>
      </div>

      {creating && (
        <form
          className={css.createRow}
          onSubmit={(event) => { event.preventDefault(); void onCreate() }}
        >
          <input
            className={css.textInput}
            value={newName}
            placeholder={t('cluePacksNamePlaceholder')}
            aria-label={t('cluePacksNamePlaceholder')}
            autoFocus
            onChange={(event) => { setNewName(event.target.value) }}
          />
          <button type="submit" className={css.primaryButton} disabled={creatingBusy}>
            {t('cluePacksCreate')}
          </button>
          <button type="button" className={css.toolButton} onClick={() => { setCreating(false); setNewName('') }}>
            {t('cancel')}
          </button>
        </form>
      )}

      {phase === 'loading' && <div className={css.stateLine} role="status">{t('loading')}</div>}
      {phase === 'error' && (
        <div className={css.stateLine}>
          <span>{error ?? t('error')}</span>
          <button type="button" className={css.stateAction} onClick={() => { void load() }}>{t('retry')}</button>
        </div>
      )}
      {phase === 'ready' && visiblePacks.length === 0 && (
        <div className={css.stateLine}>
          {search.trim() === '' ? t('cluePacksEmpty') : t('cluePacksNoMatch')}
        </div>
      )}

      {shown.length > 0 && (
        <ul className={css.packGrid}>
          {shown.map(pack => (
            <li key={pack.id} className={css.packCard}>
              <button
                type="button"
                className={css.packMain}
                title={t('cluePacksInsertAria', { name: pack.name })}
                aria-label={t('cluePacksInsertAria', { name: pack.name })}
                onClick={() => {
                  if (onInsertPack(pack)) rememberUse(pack.id)
                }}
              >
                <span className={css.packIcon} aria-hidden="true"><VscReferences size={16} /></span>
                <span className={css.packName}>{pack.name}</span>
              </button>
              <div className={css.packFooter}>
                <span className={css.packCount}>{t('cluePacksMembers', { n: pack.members.length })}</span>
                <button
                  type="button"
                  className={css.packEdit}
                  aria-label={t('cluePacksManageAria', { name: pack.name })}
                  title={t('cluePacksManageAria', { name: pack.name })}
                  onClick={() => { onOpenPack(pack) }}
                >
                  <VscSettingsGear size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {visiblePacks.length > PAGE_SIZE && (
        <div className={css.pageBar}>
          <button
            type="button"
            className={css.toolButton}
            disabled={currentPage === 0}
            onClick={() => { setPage(Math.max(0, currentPage - 1)) }}
          >
            {t('cluePagePrev')}
          </button>
          <span className={css.pageLabel}>{t('cluePageOf', { n: currentPage + 1 })}</span>
          <button
            type="button"
            className={css.toolButton}
            disabled={currentPage >= pageCount - 1}
            onClick={() => { setPage(Math.min(pageCount - 1, currentPage + 1)) }}
          >
            {t('cluePageNext')}
          </button>
        </div>
      )}
    </section>
  )
}
