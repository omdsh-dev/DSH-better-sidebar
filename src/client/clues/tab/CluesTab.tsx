/**
 * Clues tab (S9): the entry point of the clue collection.
 *
 * TWO independent regions — the pack library above, the multi-source browser
 * below — with no decorative connector between them. The page owns the things
 * both regions share and nothing else:
 *
 * - the stable workspace address of the current session (never a cwd guess);
 * - the plugin-settings document (`pluginSettings['clues']`): the last
 *   explicit range per workspace+source and the recent-use order of packs;
 * - the draft-insert seams, the S6 detail/pack/settings windows and the
 *   visible notice sink;
 * - the help overlay (first visit once per browser, then the header `?`).
 *
 * Visibility gating: the native tab body stays mounted while hidden
 * (`keepMounted`), so neither region issues a request unless `visible` is true.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconQuestionOutlineRegular, IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TabComponentProps } from '../../service.ts'
import type { BetterSidebarService } from '../../service.ts'
import type { SidebarPrefs } from '../../../prefs-shared.ts'
import type { CluePack, JsonValue } from '../../../clues/types.ts'
import type { BetterSidebarCluesClientFace } from '../registry.ts'
import { resolveWorkspaceIdForSession, listClueWorkspaces } from '../workspace-id.ts'
import { insertClueReference, insertPackReference } from '../insert.ts'
import { notifyClue } from '../notify.ts'
import { api } from '../../api.ts'
import { parsePrefs } from '../../prefs.ts'
import { t } from '../../locales.ts'
import { CluePacksSection } from './packs.tsx'
import { ClueBrowser } from './browser.tsx'
import { ClueHelpOverlay, clueHelpSeen, markClueHelpSeen } from './help.tsx'
import { openClueDetailWindow, type ClueDetailTarget } from '../windows/detail.tsx'
import { openPackManagementWindow } from '../windows/pack.tsx'
import { openClueSettingsWindow } from '../windows/settings.tsx'
import { openShareWindow } from '../windows/share.tsx'
import css from './clues-tab.module.css'

/** The plugin-settings key of the clue tab (one sparse blob). */
export const CLUE_TAB_SETTINGS_KEY = 'clues'

/** The subset of the tab component props the clue page consumes. */
export type CluesTabProps = Pick<TabComponentProps, 'ctx' | 'store' | 'scope' | 'visible'>

/** The persisted clue-tab settings shape. */
export interface ClueTabSettings {
  /** workspaceId -> sourceId -> persisted range value. */
  readonly scopes?: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>
  /** Most recently inserted/opened pack ids (ordering only). */
  readonly recentPacks?: readonly string[]
}

/** Read the sparse settings blob out of the live preferences. */
function blobOf(prefs: SidebarPrefs): Record<string, unknown> {
  const blob = prefs.pluginSettings[CLUE_TAB_SETTINGS_KEY]
  return blob === undefined ? {} : { ...blob }
}

/** Structural equality for the small settings blob (avoids render loops). */
function sameBlob(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** The tab body. */
export function CluesTab({ ctx, store, scope, visible }: CluesTabProps): ReactNode {
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined)
  /** Explicit browse-workspace choice (S9 §2: switching changes only the view). */
  const [workspaceChoice, setWorkspaceChoice] = useState<string | undefined>(undefined)
  const [resolved, setResolved] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [settings, setSettings] = useState<Record<string, unknown>>(() => blobOf(store.getPrefs()))
  const [helpOpen, setHelpOpen] = useState<boolean>(() => !clueHelpSeen())
  const helpButtonRef = useRef<HTMLButtonElement | null>(null)
  const retry = useCallback(() => { setAttempt(value => value + 1) }, [])

  // The service face (tabs/windows) and the clue client face both live on the
  // published service; a deployment without it shows the explicit empty state.
  const service = (() => {
    try {
      return ctx.get('betterSidebar') as BetterSidebarService | undefined
    } catch {
      return undefined
    }
  })()
  const face: BetterSidebarCluesClientFace | undefined = service?.clues

  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    let active = true
    setResolved(false)
    setWorkspaceChoice(undefined)
    void resolveWorkspaceIdForSession(ctx, scope.sessionId, controller.signal).then((id) => {
      if (!active || controller.signal.aborted) return
      setWorkspaceId(id)
      setResolved(true)
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [ctx, scope.sessionId, visible, attempt])

  // Follow the shared preferences document (another settings surface may write
  // while this tab is mounted).
  useEffect(() => {
    const sync = (): void => {
      const next = blobOf(store.getPrefs())
      setSettings(current => (sameBlob(current, next) ? current : next))
    }
    sync()
    return store.subscribe(sync)
  }, [store])

  /**
   * Sequence of this tab's settings writes. The route is last-write-wins and
   * the response carries the whole resolved document, so only the NEWEST
   * write may adopt it: an older response landing late would otherwise restore
   * a range another writer (the pack window, a second tab) already replaced.
   */
  const settingsWrite = useRef(0)

  const persistSettings = useCallback((next: Record<string, unknown>): void => {
    setSettings(next)
    // Optimistic shared-document update, then the authoritative revision.
    const prefs = store.getPrefs()
    store.setPrefs({ ...prefs, pluginSettings: { ...prefs.pluginSettings, [CLUE_TAB_SETTINGS_KEY]: next } })
    const write = ++settingsWrite.current
    void api.settingsUpdate({ pluginSettings: { [CLUE_TAB_SETTINGS_KEY]: next } }).then((result) => {
      if (result.value !== undefined && write === settingsWrite.current) {
        store.setPrefs(parsePrefs(result.value))
      }
    }).catch(() => {
      notifyClue(t('clueSettingsSaveFailed'))
    })
  }, [store])

  /** The workspace both regions browse (an explicit choice wins over the session's). */
  const browseWorkspaceId = workspaceChoice ?? workspaceId
  const workspaces = useMemo(() => listClueWorkspaces(ctx), [ctx])

  const scopes = useMemo<Readonly<Record<string, JsonValue | undefined>>>(() => {
    const value = settings.scopes
    if (value === null || typeof value !== 'object' || browseWorkspaceId === undefined) return {}
    const forWorkspace = (value as Record<string, unknown>)[browseWorkspaceId]
    if (forWorkspace === null || typeof forWorkspace !== 'object') return {}
    // `null` is the persisted TOMBSTONE of a cleared range: the host's settings
    // merge is a deep patch, so deleting the key would leave the old range in
    // place. Normalize it away at this boundary so every consumer still sees
    // "no range chosen" instead of a null scope.
    const visible: Record<string, JsonValue | undefined> = {}
    for (const [sourceId, scope] of Object.entries(forWorkspace)) {
      if (scope !== null) visible[sourceId] = scope as JsonValue
    }
    return visible
  }, [settings, browseWorkspaceId])

  /**
   * Persist one explicitly chosen range.
   *
   * The pack window holds this callback for its whole lifetime, so the
   * `settings` render snapshot it captured can be older than a range the tab
   * (or another surface) wrote in the meantime. Merge into the LIVE document
   * at call time — never into the snapshot — so one writer cannot roll the
   * other's range back.
   */
  const onScopeChange = useCallback((sourceId: string, range: JsonValue | undefined): void => {
    if (browseWorkspaceId === undefined) return
    const current = blobOf(store.getPrefs())
    const all = (current.scopes !== null && typeof current.scopes === 'object'
      ? current.scopes as Record<string, Record<string, JsonValue | undefined>>
      : {})
    const forWorkspace = { ...(all[browseWorkspaceId] ?? {}) }
    if (range === undefined || range === null) forWorkspace[sourceId] = null
    else forWorkspace[sourceId] = range
    persistSettings({ ...current, scopes: { ...all, [browseWorkspaceId]: forWorkspace } })
  }, [browseWorkspaceId, persistSettings, store])

  const insertClue = useCallback((clueId: string, title: string): boolean => {
    const inserted = insertClueReference(ctx, scope.sessionId, { kind: 'clue', id: clueId, title })
    if (!inserted) notifyClue(t('clueInsertFailed'))
    return inserted
  }, [ctx, scope.sessionId])

  const insertPack = useCallback((pack: CluePack): boolean => {
    const inserted = insertPackReference(ctx, scope.sessionId, pack.id, pack.name)
    if (!inserted) notifyClue(t('clueInsertFailed'))
    return inserted
  }, [ctx, scope.sessionId])

  const openDetail = useCallback((target: ClueDetailTarget): void => {
    if (service === undefined || face === undefined || browseWorkspaceId === undefined) return
    openClueDetailWindow({
      windows: service.windows,
      face,
      workspaceId: browseWorkspaceId,
      target,
      sessionId: scope.sessionId,
      workspaces: listClueWorkspaces(ctx),
      onInsertClue: insertClue,
    })
  }, [service, face, browseWorkspaceId, scope.sessionId, insertClue, ctx])

  const openPack = useCallback((pack: CluePack): void => {
    if (service === undefined || face === undefined || browseWorkspaceId === undefined) return
    openPackManagementWindow({
      windows: service.windows,
      workspaceId: browseWorkspaceId,
      face,
      workspaces: listClueWorkspaces(ctx),
      pack,
      onInsertClue: insertClue,
      onInsertPack: insertPack,
      onNotice: notifyClue,
      scopes,
      onScopeChange,
    })
  }, [service, face, browseWorkspaceId, ctx, insertClue, insertPack, scopes, onScopeChange])

  const openImport = useCallback((): void => {
    if (service === undefined || browseWorkspaceId === undefined) return
    openShareWindow({ windows: service.windows, workspaceId: browseWorkspaceId, face: service.clues, direction: 'import' })
  }, [service, browseWorkspaceId])

  const openSettings = useCallback((): void => {
    if (service === undefined) return
    openClueSettingsWindow({ windows: service.windows, store, service, group: 'sources' })
  }, [service, store])

  const closeHelp = useCallback((): void => {
    markClueHelpSeen()
    setHelpOpen(false)
    helpButtonRef.current?.focus()
  }, [])

  const ready = resolved && workspaceId !== undefined && face !== undefined && service !== undefined

  return (
    <div className={css.root} data-clue-tab>
      <div className={css.header}>
        <h2 className={css.heading}>{t('clueTabTitle')}</h2>
        <div className={css.headerActions}>
          {workspaces.length > 1 && (
            <select
              className={css.workspaceSelect}
              aria-label={t('clueTabWorkspaceAria')}
              value={browseWorkspaceId ?? ''}
              onChange={(event) => { setWorkspaceChoice(event.target.value) }}
            >
              {workspaces.map(workspace => (
                <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
              ))}
            </select>
          )}
          <button
            ref={helpButtonRef}
            type="button"
            className={css.iconButton}
            aria-label={t('clueTabHelpAria')}
            title={t('clueTabHelpAria')}
            aria-haspopup="dialog"
            onClick={() => { setHelpOpen(true) }}
          >
            <IconQuestionOutlineRegular size={16} />
          </button>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('clueTabSettingsAria')}
            title={t('clueTabSettingsAria')}
            onClick={openSettings}
          >
            <IconSettingsOutlineRegular size={16} />
          </button>
        </div>
      </div>

      {!resolved && (
        <div className={css.state} role="status">{t('loading')}</div>
      )}
      {resolved && workspaceId === undefined && (
        <div className={css.state}>
          <span>{t('clueTabNoWorkspace')}</span>
          <button type="button" className={css.stateAction} onClick={retry}>{t('retry')}</button>
        </div>
      )}
      {resolved && workspaceId !== undefined && !ready && (
        <div className={css.state}>
          <span>{t('clueTabUnavailable')}</span>
        </div>
      )}

      {ready && browseWorkspaceId !== undefined && (
        <div className={css.regions}>
          <CluePacksSection
            workspaceId={browseWorkspaceId}
            face={face}
            visible={visible}
            settings={settings}
            onSettingsChange={persistSettings}
            onInsertPack={insertPack}
            onOpenPack={openPack}
            onImport={openImport}
            onNotice={notifyClue}
          />
          <div className={css.divider} role="separator" aria-hidden="true" />
          <ClueBrowser
            workspaceId={browseWorkspaceId}
            face={face}
            visible={visible}
            scopes={scopes}
            onScopeChange={onScopeChange}
            onOpenDetail={openDetail}
            onInsertClue={insertClue}
            onOpenSettings={openSettings}
            onNotice={notifyClue}
          />
        </div>
      )}

      {/*
        Mount the help overlay only while this tab is the visible surface.
        Native tab bodies are keepMounted forever: a hidden clues tab would
        otherwise keep a document-level capture Escape listener alive and
        swallow Escape from the ACTIVE tab (the mount lane caught this as the
        CodeMirror search panel failing to close after the clues sweep).
      */}
      {visible && helpOpen && <ClueHelpOverlay onClose={closeHelp} />}
    </div>
  )
}
