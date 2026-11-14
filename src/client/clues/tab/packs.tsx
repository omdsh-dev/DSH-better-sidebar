/**
 * The clue tab's collection library view (S9).
 *
 * A pack is a local collection of clue ids: this section only browses it, makes
 * one-click references and hands management to the S6 window. Two INDEPENDENT
 * actions per node:
 *
 * - the title opens collection management;
 * - the explicit @ action inserts its reference into the draft, never sends.
 * They are sibling buttons with distinct accessible names. A cursor/keyboard
 * context menu (the host `Menu`) offers the same two actions plus export and a
 * confirmed delete of the pack itself; deleting a pack never touches its
 * clues, their resources or old references.
 *
 * `clues.packs.list` returns the WHOLE library for one workspace in a single
 * response (there is no cursor and no server total), so this shelf keeps that
 * one transfer and reveals it progressively: 12 rows first, then 12 more each
 * time the sentinel at the bottom enters the preload zone. That is local
 * rendering, NOT a fake server pagination — no further request is ever made,
 * and the header carries no cursor controls. The search filter is client-side
 * and resets the progressive window (12 rows, scroll to top); a reload does
 * the same.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import {
  IconCheckOutlineRegular,
  IconCloseOutlineRegular,
  IconContextInjectionOutlineRegular,
  IconDownloadOutlineRegular,
  IconFolderOpenRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconShareOutlineRegular,
  IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { CluePackArtwork } from '../artwork.tsx'
import type { CluePack } from '../../../clues/types.ts'
import type { BetterSidebarCluesClientFace } from '../registry.ts'
import type { BetterSidebarWindowsClientFace } from '../../windows/types.ts'
import { clueErrorMessage } from '../copy.ts'
import { cluesApi, invalidateClueRequests, peekClueRequest } from '../api.ts'
import { openShareWindow } from '../windows/share.tsx'
import {
  ActionButton, ConfirmDialog, EmptyState, ErrorBlock, IconButton, ListRow, LoadingIndicator, Menu,
  Notice, SearchField, StatusLine, TextInput,
} from '../../ui/index.ts'
import { useScrollLoad } from '../../ui/use-scroll-load.ts'
import { useListNavigation } from '../../ui/use-list-navigation.ts'
import { t } from '../../locales.ts'
import css from './clues-tab.module.css'

/** Rows rendered before the reader scrolls (also the per-step increment). */
const VISIBLE_STEP = 12

/** One open shelf context menu, anchored at the cursor (or the row for keys). */
interface PackMenu {
  readonly pack: CluePack
  readonly x: number
  readonly y: number
}

/** Cursor position of a right-click row menu. */
function contextMenuPoint(event: ReactMouseEvent<HTMLElement>): { x: number; y: number } {
  event.preventDefault()
  event.stopPropagation()
  return { x: event.clientX, y: event.clientY }
}

/** Keyboard path of the same menu: the ContextMenu key, or Shift+F10. */
function keyboardMenuPoint(event: ReactKeyboardEvent<HTMLElement>): { x: number; y: number } | undefined {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return undefined
  event.preventDefault()
  event.stopPropagation()
  const rect = event.currentTarget.getBoundingClientRect()
  return { x: rect.left + Math.min(24, rect.width / 2), y: rect.top + Math.min(rect.height, 24) }
}

/** Props of the pack library. */
export interface CluePacksSectionProps {
  readonly workspaceId: string
  readonly face: BetterSidebarCluesClientFace
  /** The window host that owns the create-pack surface. */
  readonly windows: BetterSidebarWindowsClientFace
  /** Whether the page is on screen (a hidden tab body performs no query). */
  readonly visible: boolean
  /** Reload the visible shelf after a collection mutation elsewhere in the tab. */
  readonly refreshRevision?: number
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
  /**
   * Whether this shelf's own floating task (the create-pack window) is open.
   * The tab owner pins the workspace/scope while it is true so a create that
   * outlives a workspace switch still lands in its original shelf.
   */
  onTaskOpenChange?(open: boolean): void
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
  const { workspaceId, face, windows, visible, refreshRevision, settings, onSettingsChange, onOpenPack, onImport, onNotice, onTaskOpenChange } = props
  const { onInsertPack } = props
  const createButtonRef = useRef<HTMLButtonElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  /** The committed progressive count; a burst of IO callbacks must step once. */
  const shownRef = useRef(VISIBLE_STEP)
  const loadMoreLock = useRef(false)
  /** A warm activation read paints the shelf without a hot loader. */
  const [seeded] = useState(() => face.api === cluesApi
    ? peekClueRequest<{ packs: readonly CluePack[]; revision: number }>(
        'clues.packs.list',
        workspaceId,
        { workspaceId },
      )
    : undefined)
  const [packs, setPacks] = useState<readonly CluePack[]>(() => seeded?.packs ?? [])
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>(() => seeded === undefined ? 'loading' : 'ready')
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Whether the one full-library transfer has completed at least once. */
  const loadedOnce = useRef(seeded !== undefined)
  /** The last external refresh request this shelf already applied. */
  const lastRefreshRevision = useRef(refreshRevision)
  /** The mounted library reads only while its view is on screen. */
  const activeRef = useRef(false)
  activeRef.current = visible
  const [search, setSearch] = useState('')
  const [shownCount, setShownCount] = useState(VISIBLE_STEP)
  const [packMenu, setPackMenu] = useState<PackMenu | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CluePack | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const createBusyRef = useRef(false)
  const createInputRef = useRef<HTMLInputElement | null>(null)

  // A hidden view owns no open menu.
  useEffect(() => {
    if (!visible) setPackMenu(null)
  }, [visible])

  /** Restart the progressive window at the top of the list. */
  const resetVisible = useCallback((): void => {
    loadMoreLock.current = false
    setShownCount(VISIBLE_STEP)
    const scroll = scrollRef.current
    if (scroll !== null) scroll.scrollTop = 0
  }, [])

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (!activeRef.current) return
    // The first read owns the shelf's loading placeholder. Later reads refresh
    // in place: rows, progressive window and scroll position stay put.
    const background = loadedOnce.current
    if (background) setRefreshing(true)
    else setPhase('loading')
    setError(null)
    try {
      // ONE transfer: the API has no cursor, so the whole workspace library
      // arrives here and `shownCount` is the only paging state.
      const result = await face.api.packsList(workspaceId)
      if (signal?.aborted === true) return
      loadedOnce.current = true
      setPacks(result.packs)
      setPhase('ready')
    } catch (failure) {
      if (signal?.aborted === true) return
      // A failed refresh keeps the last library instead of claiming it is empty.
      if (loadedOnce.current) setPhase('ready')
      else setPhase('error')
      setError(clueErrorMessage(failure, t('error')))
    } finally {
      if (!signal?.aborted) setRefreshing(false)
    }
  }, [face, workspaceId])

  useEffect(() => {
    // A collapsed or hidden shelf performs no query. Expanding/revealing keeps
    // the loaded library (and its scroll) as-is; only a mutation reported
    // through `refreshRevision` asks for a fresh transfer.
    if (!visible) return
    const revisionChanged = lastRefreshRevision.current !== refreshRevision
    if (loadedOnce.current && !revisionChanged) {
      // A revision written while the shelf was collapsed/hidden still needs
      // one background refresh; an unchanged family stays a pure paint.
      if (face.api === cluesApi
        && peekClueRequest('clues.packs.list', workspaceId, { workspaceId }) === undefined) {
        void load()
        return
      }
      // A warm cache is a paint: clear a spinner left by a refresh that was
      // cancelled when the shelf hid/collapsed. Rows, scroll and filter stay.
      setRefreshing(false)
      return
    }
    lastRefreshRevision.current = refreshRevision
    const controller = new AbortController()
    void load(controller.signal)
    return () => {
      controller.abort()
      // Same cleanup contract as the browser page: hiding/collapsing aborts the
      // background read and clears its busy state, without dropping the rows,
      // progressive window or scroll position.
      if (!activeRef.current) setRefreshing(false)
    }
  }, [load, visible, refreshRevision, face, workspaceId])

  const visiblePacks = useMemo(() => {
    const query = search.trim().toLowerCase()
    const filtered = query === '' ? packs : packs.filter(pack => pack.name.toLowerCase().includes(query))
    return orderPacks(filtered, recentOf(settings))
  }, [packs, search, settings])

  const shown = useMemo(
    () => visiblePacks.slice(0, shownCount),
    [visiblePacks, shownCount],
  )
  shownRef.current = shownCount
  const navigation = useListNavigation(shown.map(pack => pack.id))
  const hasMore = shownCount < visiblePacks.length

  /**
   * One step per render. `useScrollLoad` may invoke onLoad several times before
   * a state update lands (observer + scroll fallback coalescing), and queueing
   * a second functional update would grow the window by more than 12.
   */
  const loadMore = useCallback((): void => {
    if (loadMoreLock.current || shownRef.current >= visiblePacks.length) return
    loadMoreLock.current = true
    setShownCount(Math.min(shownRef.current + VISIBLE_STEP, visiblePacks.length))
  }, [visiblePacks.length])

  // Re-arm after the committed count changes (or the filter reset it).
  useEffect(() => {
    loadMoreLock.current = false
  }, [shownCount])

  useScrollLoad({
    scrollRef,
    sentinelRef,
    enabled: visible,
    hasMore,
    loading: phase === 'loading',
    onLoad: loadMore,
    // Re-arm after a page arrives AND after the filter changes while the
    // progressive window is still at its default size.
    version: `${search}\u0000${packs.length}\u0000${shownCount}`,
  })

  const rememberUse = useCallback((packId: string): void => {
    const recent = recentOf(settings).filter(id => id !== packId)
    recent.unshift(packId)
    onSettingsChange({ ...settings, recentPacks: recent.slice(0, 20) })
  }, [settings, onSettingsChange])

  const openCreate = useCallback((): void => {
    setCreateError(null)
    setCreating(true)
    onTaskOpenChange?.(true)
    queueMicrotask(() => { createInputRef.current?.focus() })
  }, [onTaskOpenChange])

  const cancelCreate = useCallback((): void => {
    if (createBusyRef.current) return
    setCreating(false)
    setNewName('')
    setCreateError(null)
    onTaskOpenChange?.(false)
    createButtonRef.current?.focus()
  }, [onTaskOpenChange])

  const submitCreate = useCallback(async (): Promise<void> => {
    if (createBusyRef.current) return
    const name = newName.trim() === '' ? t('cluePacksUntitled') : newName.trim()
    createBusyRef.current = true
    setCreateBusy(true)
    setCreateError(null)
    try {
      const created = await face.api.packsCreate(workspaceId, { name })
      setPacks(current => [...current.filter(candidate => candidate.id !== created.pack.id), created.pack])
      resetVisible()
      setNewName('')
      setCreating(false)
      onTaskOpenChange?.(false)
    } catch (failure) {
      const message = clueErrorMessage(failure, t('cluePackSaveFailed'))
      setCreateError(message)
      onNotice(message)
    } finally {
      createBusyRef.current = false
      setCreateBusy(false)
    }
  }, [face, newName, onNotice, onTaskOpenChange, resetVisible, workspaceId])

  /** Delete the pack only: its clues, the resources and old references stay. */
  const removePack = useCallback(async (): Promise<void> => {
    if (deleteTarget === null || deleting) return
    setDeleting(true)
    try {
      await face.api.packsDelete(workspaceId, {
        packId: deleteTarget.id,
        expectedRevision: deleteTarget.revision,
      })
      setPacks(current => current.filter(candidate => candidate.id !== deleteTarget.id))
      setDeleteTarget(null)
    } catch (failure) {
      onNotice(clueErrorMessage(failure, t('clueStateRequestFailed')))
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, deleting, face, workspaceId, onNotice])

  const packMenuItems: readonly MenuEntry[] = packMenu === null
    ? []
    : [
        {
          id: 'open',
          label: t('cluePacksManageAria', { name: packMenu.pack.name }),
          icon: <IconFolderOpenRegular size={14} />,
        },
        {
          id: 'insert',
          label: t('cluePacksInsertAria', { name: packMenu.pack.name }),
          icon: <IconContextInjectionOutlineRegular size={14} />,
        },
        {
          id: 'export',
          label: t('clueShareExport'),
          icon: <IconShareOutlineRegular size={14} />,
        },
        { type: 'separator', id: 'sep' },
        {
          id: 'delete',
          label: t('delete'),
          icon: <IconTrashOutlineRegular size={14} />,
          danger: true,
        },
      ]

  const onPackMenuSelect = useCallback((id: string): void => {
    const menu = packMenu
    setPackMenu(null)
    if (menu === null) return
    const pack = menu.pack
    if (id === 'open') onOpenPack(pack)
    else if (id === 'insert') { if (onInsertPack(pack)) rememberUse(pack.id) }
    else if (id === 'export') {
      openShareWindow({ windows, workspaceId, face, packIds: [pack.id] })
    } else if (id === 'delete') setDeleteTarget(pack)
  }, [face, onInsertPack, onOpenPack, packMenu, rememberUse, windows, workspaceId])

  return (
    <>
    <section className={css.packs} aria-label={t('clueViewPacks')}>
      <div className={css.packToolbar}>
        <SearchField className={css.packSearch} type="search" value={search}
          placeholder={t('cluePacksSearchPlaceholder')} aria-label={t('cluePacksSearchPlaceholder')}
          onChange={event => { setSearch(event.target.value); resetVisible() }}
          onKeyDown={event => {
            if (event.key === 'Escape' && search !== '') {
              event.preventDefault(); event.stopPropagation(); setSearch(''); resetVisible()
            }
          }} />
        <IconButton size="sm" label={t('clueShareImport')} onClick={onImport}
          icon={<IconDownloadOutlineRegular size={14} />} />
        <IconButton size="sm"
          label={refreshing ? t('clueBrowserRefreshing') : t('refresh')}
          aria-busy={refreshing || undefined} data-clue-refresh-status={refreshing ? 'refreshing' : undefined}
          disabled={phase === 'loading' || refreshing} onClick={() => {
            invalidateClueRequests(workspaceId, 'clues.packs.list'); void load()
          }}
          icon={refreshing ? <LoadingIndicator inline size={12} label="" role="presentation" /> : <IconRefreshOutlineRegular size={14} />} />
        <ActionButton ref={createButtonRef} size="sm" aria-pressed={creating} onClick={openCreate}>
          <IconPlusOutlineRegular size={14} />{t('cluePacksNew')}
        </ActionButton>
      </div>

      {creating && (
        <form
          className={css.inlineCreate}
          data-clue-pack-inline-create
          aria-busy={createBusy}
          onSubmit={(event) => { event.preventDefault(); void submitCreate() }}
        >
          <span className={css.inlineCreateRow}>
            <CluePackArtwork size={16} />
            <TextInput
              ref={createInputRef}
              className={css.inlineCreateInput}
              value={newName}
              disabled={createBusy}
              placeholder={t('cluePacksNamePlaceholder')}
              aria-label={t('cluePacksNamePlaceholder')}
              onChange={(event) => { setNewName(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !createBusy) {
                  event.preventDefault()
                  event.stopPropagation()
                  cancelCreate()
                }
              }}
            />
            <IconButton
              size="sm"
              label={t('cluePacksCreate')}
              disabled={createBusy}
              onClick={() => { void submitCreate() }}
              icon={createBusy ? <LoadingIndicator inline size={12} label="" role="presentation" /> : <IconCheckOutlineRegular size={14} />}
            />
            <IconButton
              size="sm"
              label={t('cancel')}
              disabled={createBusy}
              onClick={cancelCreate}
              icon={<IconCloseOutlineRegular size={14} />}
            />
          </span>
          {createError !== null && <Notice kind="error" tone="inline">{createError}</Notice>}
        </form>
      )}

      <div ref={scrollRef} className={css.packScroll} data-clue-pack-scroll>
        {phase === 'loading' && <StatusLine plain text={<LoadingIndicator inline />} />}
        {error !== null && (
          <ErrorBlock
            message={error}
            retryLabel={t('retry')}
            data-clue-pack-error
            onRetry={() => {
              invalidateClueRequests(workspaceId, 'clues.packs.list')
              void load()
            }}
          />
        )}
        {phase === 'ready' && visiblePacks.length === 0 && !creating && (
          <EmptyState
            icon={<CluePackArtwork size={24} />}
            title={search.trim() === '' ? t('cluePacksEmpty') : t('cluePacksNoMatch')}
            actions={search.trim() === ''
              ? <ActionButton size="sm" onClick={openCreate}>{t('cluePacksNew')}</ActionButton>
              : <ActionButton size="sm" onClick={() => { setSearch(''); resetVisible() }}>{t('clueClearSearch')}</ActionButton>}
          />
        )}

        {shown.length > 0 && (
          <ul className={css.packList} aria-label={t('cluePacksHint')} ref={navigation.ref}
            onKeyDown={navigation.onKeyDown} onFocusCapture={navigation.onFocusCapture} onClickCapture={navigation.onClickCapture}>
            {shown.map((pack, index) => (
              <li
                key={pack.id}
                onContextMenu={(event) => {
                  setPackMenu({ pack, ...contextMenuPoint(event) })
                }}
                onKeyDown={(event) => {
                  const point = keyboardMenuPoint(event)
                  if (point !== undefined) setPackMenu({ pack, ...point })
                }}
              >
                <ListRow
                  title={pack.name}
                  titleData={{ 'data-clue-pack-name': pack.name }}
                  titleLabel={t('cluePacksManageAria', { name: pack.name })}
                  titleAs="button"
                  primary={navigation.itemTabIndex(index) === 0}
                  onTitleClick={() => { onOpenPack(pack) }}
                  leading={<CluePackArtwork size={16} />}
                  meta={<span>{t('cluePacksMembers', { n: pack.members.length })}</span>}
                  actions={(
                    <IconButton
                      size="sm"
                      label={t('cluePacksInsertAria', { name: pack.name })}
                      title={t('cluePackInsert')}
                      onClick={() => { if (onInsertPack(pack)) rememberUse(pack.id) }}
                      icon={<IconContextInjectionOutlineRegular size={14} />}
                    />
                  )}
                />
              </li>
            ))}
          </ul>
        )}

        <div ref={sentinelRef} data-clue-pack-sentinel aria-hidden="true" />
      </div>
    </section>

    <Menu
      open={packMenu !== null}
      onClose={() => { setPackMenu(null) }}
      items={packMenuItems}
      onSelect={onPackMenuSelect}
      portal
      compact
      align="start"
      anchorPoint={packMenu === null ? undefined : { x: packMenu.x, y: packMenu.y }}
      anchor={<span />}
    />

    {deleteTarget !== null && (
      <ConfirmDialog
        open
        title={t('delete')}
        description={t('cluePackDeleteConfirm', { name: deleteTarget.name })}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        danger
        busy={deleting}
        onConfirm={() => { void removePack() }}
        onClose={() => { if (!deleting) setDeleteTarget(null) }}
      />
    )}
    </>
  )
}
