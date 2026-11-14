/**
 * Clues tab (S9): the entry point of the clue collection.
 *
 * Two full-height views share workspace, settings and draft-insert seams:
 *
 * - the stable workspace address of the current session (never a cwd guess);
 * - the plugin-settings document (`pluginSettings['clues']`): the last
 *   explicit range per workspace+source and the recent-use order of packs;
 * - the draft-insert seams, the S6 detail/pack/settings windows and the
 *   visible notice sink;
 * - the optional inline help opened through the header `?`;
 *
 * Visibility gating: the native tab body stays mounted while hidden
 * (`keepMounted`), so neither region issues a request unless `visible` is true.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconArchiveOutlineRegular, IconQuestionOutlineRegular, IconSearchOutlineRegular, IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TabComponentProps } from '../../service.ts'
import type { BetterSidebarService } from '../../service.ts'
import type { SidebarPrefs } from '../../../prefs-shared.ts'
import type { ClueCandidate, CluePack, JsonValue } from '../../../clues/types.ts'
import type { BetterSidebarCluesClientFace } from '../registry.ts'
import { resolveWorkspaceIdForSession, listClueWorkspaces } from '../workspace-id.ts'
import { insertClueReference, insertPackReference } from '../insert.ts'
import { notifyClue } from '../notify.ts'
import { revealClueFile } from '../file-reveal.ts'
import { api } from '../../api.ts'
import { parsePrefs, syncClueWindowSurface } from '../../prefs.ts'
import { t } from '../../locales.ts'
import { CluePacksSection } from './packs.tsx'
import { ClueBrowser } from './browser.tsx'
import { ClueHelpOverlay, clueHelpSeen, markClueHelpSeen } from './help.tsx'
import { ActionButton, EmptyState, IconButton, SidebarToolbar, WorkbenchSection } from '../../ui/index.ts'
import { openClueDetailWindow, type ClueDetailTarget } from '../windows/detail.tsx'
import { openClueCollectionForTarget } from '../windows/collect.tsx'
import { openPackManagementWindow } from '../windows/pack.tsx'
import { openClueSettingsWindow } from '../windows/settings.tsx'
import { openShareWindow } from '../windows/share.tsx'
import { LoadingIndicator } from '../../ui/LoadingIndicator.tsx'
import { SelectMenu } from '../../ui/SelectMenu.tsx'
import design from '../../ui/design.module.css'
import css from './clues-tab.module.css'

/** The plugin-settings key of the clue tab (one sparse blob). */
const CLUE_TAB_SETTINGS_KEY = 'clues'

/** The subset of the tab component props the clue page consumes. */
type CluesTabProps = Pick<TabComponentProps, 'ctx' | 'store' | 'scope' | 'visible'>

/** The persisted section state, with the explorer defaults applied. */
function sectionLayoutOf(blob: Record<string, unknown>): { browse: boolean; packs: boolean } {
  const raw = blob.layout
  const layout = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  return { browse: layout.browse !== false, packs: layout.packs === true }
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
  const [sourcePreferences, setSourcePreferences] = useState(() => store.getPrefs().clueSourcesEnabled)
  const [helpOpen, setHelpOpen] = useState<boolean>(() => !clueHelpSeen())
  const [browserTaskOpen, setBrowserTaskOpen] = useState(false)
  const [packTaskOpen, setPackTaskOpen] = useState(false)
  const taskOpen = browserTaskOpen || packTaskOpen
  const [packsRevision, setPacksRevision] = useState(0)
  const refreshPacks = useCallback(() => { setPacksRevision(value => value + 1) }, [])
  const helpButtonRef = useRef<HTMLButtonElement | null>(null)
  const restoreHelpFocusRef = useRef(false)
  const resolvedSessionRef = useRef<string | undefined>(undefined)
  const retry = useCallback(() => { setResolved(false); setAttempt(value => value + 1) }, [])

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
    if (!visible || taskOpen) return
    // A task window belongs to the workspace it opened for. Re-resolve the
    // session after it closes, so async failures can retain the same draft.
    // A hidden native tab is still mounted. Re-resolving its identity would
    // unmount both regions and discard searches, selection and create drafts.
    if (resolved && resolvedSessionRef.current === scope.sessionId) return
    const controller = new AbortController()
    let active = true
    setResolved(false)
    if (resolvedSessionRef.current !== scope.sessionId) setWorkspaceChoice(undefined)
    void resolveWorkspaceIdForSession(ctx, scope.sessionId, controller.signal).then((id) => {
      if (!active || controller.signal.aborted) return
      resolvedSessionRef.current = scope.sessionId
      setWorkspaceId(id)
      setResolved(true)
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [ctx, scope.sessionId, visible, attempt, resolved, taskOpen])

  // Follow the shared preferences document (another settings surface may write
  // while this tab is mounted).
  useEffect(() => {
    const sync = (): void => {
      const prefs = store.getPrefs()
      syncClueWindowSurface(prefs)
      setSourcePreferences(prefs.clueSourcesEnabled)
      const next = blobOf(prefs)
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

  const persistSettings = useCallback((next: Record<string, unknown>, quiet = false): void => {
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
      // A failed layout/source preference is a quiet revert on the next open;
      // it must not overwrite a more important action notice.
      if (!quiet) notifyClue(t('clueSettingsSaveFailed'))
    })
  }, [store])

  /** The workspace both regions browse (an explicit choice wins over the session's). */
  const browseWorkspaceId = workspaceChoice ?? workspaceId
  const workspaces = useMemo(() => listClueWorkspaces(ctx), [ctx])
  // The UI's own layout state: toggles must merge into what the reader SEES,
  // not into a store snapshot an in-flight settings response may have moved.
  const [sections, setSections] = useState(() => sectionLayoutOf(settings))
  const activeSource = typeof settings.activeSource === 'string' ? settings.activeSource : undefined
  const currentWorkspace = workspaces.find(workspace => workspace.workspaceId === browseWorkspaceId)

  /** Flip one explorer section from the rendered state, then persist it. */
  const toggleSection = useCallback((key: 'browse' | 'packs', open: boolean): void => {
    const next = { ...sections, [key]: open }
    setSections(next)
    const current = blobOf(store.getPrefs())
    persistSettings({ ...current, layout: next }, true)
  }, [sections, persistSettings, store])

  /** Remember the source the reader chose (restored on the next open). */
  const rememberSource = useCallback((sourceId: string): void => {
    const current = blobOf(store.getPrefs())
    if (current.activeSource === sourceId) return
    persistSettings({ ...current, activeSource: sourceId }, true)
  }, [persistSettings, store])

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

  /** Every detail/pack surface uses the ONE collect window; this page only
   * supplies the target and the shelf refresh on success. */
  const openAddToPack = useCallback((target: ClueDetailTarget): void => {
    if (service === undefined || face === undefined || browseWorkspaceId === undefined) return
    void openClueCollectionForTarget({
      windows: service.windows,
      face,
      workspaceId: browseWorkspaceId,
      target,
      onNotice: notifyClue,
      onAdded: refreshPacks,
      onCommitted: refreshPacks,
    })
  }, [service, face, browseWorkspaceId, refreshPacks])

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
      onAddToPack: openAddToPack,
    })
  }, [service, face, browseWorkspaceId, scope.sessionId, insertClue, openAddToPack, ctx])

  const revealFile = useCallback((candidate: ClueCandidate): void => {
    if (service === undefined) {
      notifyClue(t('clueBrowserRevealUnavailable' as import('../../locales.ts').CopyKey))
      return
    }
    void revealClueFile({ ctx, store, service, candidate, sessionId: scope.sessionId }).then(result => {
      if (result.status === 'queued') notifyClue(t('clueBrowserRevealQueued' as import('../../locales.ts').CopyKey))
      else if (result.status === 'unavailable') notifyClue(t(result.reason === 'tree-root-mismatch'
        ? 'clueBrowserRevealRootMismatch' as import('../../locales.ts').CopyKey
        : 'clueBrowserRevealUnavailable' as import('../../locales.ts').CopyKey))
    })
  }, [ctx, store, service, scope.sessionId])

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
      onAddToPack: openAddToPack,
      scopes,
      onScopeChange,
    })
  }, [service, face, browseWorkspaceId, ctx, insertClue, insertPack, openAddToPack, scopes, onScopeChange])

  const openImport = useCallback((): void => {
    if (service === undefined || browseWorkspaceId === undefined) return
    openShareWindow({ windows: service.windows, workspaceId: browseWorkspaceId, face: service.clues, direction: 'import' })
  }, [service, browseWorkspaceId])

  const openSettings = useCallback((): void => {
    if (service === undefined) return
    openClueSettingsWindow({ windows: service.windows, store, service, group: 'sources' })
  }, [service, store])

  useEffect(() => {
    if (visible && !helpOpen && restoreHelpFocusRef.current) {
      restoreHelpFocusRef.current = false
      helpButtonRef.current?.focus()
    }
  }, [visible, helpOpen])

  const closeHelp = useCallback((): void => {
    markClueHelpSeen()
    restoreHelpFocusRef.current = true
    setHelpOpen(false)
  }, [])

  const ready = resolved && workspaceId !== undefined && face !== undefined && service !== undefined
  const utilityButtons = (
    <>
      <IconButton ref={helpButtonRef} size="sm" label={t('clueTabHelpAria')} aria-expanded={helpOpen}
        onClick={() => { if (helpOpen) closeHelp(); else setHelpOpen(true) }} icon={<IconQuestionOutlineRegular size={14} />} />
      <IconButton size="sm" label={t('clueTabSettingsAria')} onClick={openSettings} icon={<IconSettingsOutlineRegular size={14} />} />
    </>
  )
  const showTopToolbar = workspaces.length > 1 || !ready

  return (
    <div className={`${design.surface} ${css.root}`} data-clue-tab>
      <div className={css.workbench}>
      {showTopToolbar && (
        <SidebarToolbar
          className={css.header}
          start={workspaces.length > 1
            ? (
              <SelectMenu
                className={css.workspaceSelect}
                ariaLabel={t('clueTabWorkspaceAria')}
                value={browseWorkspaceId ?? ''}
                disabled={taskOpen}
                onChange={setWorkspaceChoice}
                options={workspaces.map(workspace => ({ value: workspace.workspaceId, label: workspace.title }))}
              />
            )
            : currentWorkspace !== undefined && (
              <span className={css.workspaceLabel} title={currentWorkspace.title}>{currentWorkspace.title}</span>
            )}
          end={!ready ? utilityButtons : undefined}
        />
      )}

      {visible && helpOpen && <ClueHelpOverlay onClose={closeHelp} />}

      {!resolved && (
        <LoadingIndicator className={css.state} />
      )}
      {resolved && workspaceId === undefined && (
        <EmptyState tone="page" title={t('clueTabNoWorkspace')}
          actions={<ActionButton size="sm" onClick={retry}>{t('retry')}</ActionButton>} />
      )}
      {resolved && workspaceId !== undefined && !ready && (
        <EmptyState tone="page" title={t('clueTabUnavailable')} />
      )}

      {ready && browseWorkspaceId !== undefined && (
        <div className={css.regions} key={browseWorkspaceId}>
          <WorkbenchSection
            title={t('clueViewBrowse')}
            icon={<IconSearchOutlineRegular size={14} />}
            open={sections.browse}
            onOpenChange={open => { toggleSection('browse', open) }}
            actions={utilityButtons}
            className={css.browseSection}
            bodyClassName={css.browseBody}
          >
            <div className={css.browseRegion} data-clue-browse-region>
              <ClueBrowser
                onPacksChanged={refreshPacks}
                onTaskOpenChange={setBrowserTaskOpen}
                sourcePreferences={sourcePreferences}
                workspaceId={browseWorkspaceId}
                face={face}
                windows={service.windows}
                visible={visible && sections.browse}
                initialSourceId={activeSource}
                onSourceChange={rememberSource}
                scopes={scopes}
                onScopeChange={onScopeChange}
                onOpenDetail={openDetail}
                onRevealFile={revealFile}
                onInsertClue={insertClue}
                onOpenSettings={openSettings}
                onNotice={notifyClue}
              />
            </div>
          </WorkbenchSection>
          <WorkbenchSection
            title={t('clueViewPacks')}
            icon={<IconArchiveOutlineRegular size={14} />}
            open={sections.packs}
            onOpenChange={open => { toggleSection('packs', open) }}
            // Cap the shelf only while resources also has the floor; alone, it fills.
            size={sections.browse ? 'compact' : 'fill'}
            className={css.packSection}
            bodyClassName={css.packBody}
          >
            <div className={css.packRegion} data-clue-pack-region>
              <CluePacksSection
                onTaskOpenChange={setPackTaskOpen}
                workspaceId={browseWorkspaceId}
                face={face}
                windows={service.windows}
                visible={visible && sections.packs}
                settings={settings}
                refreshRevision={packsRevision}
                onSettingsChange={persistSettings}
                onInsertPack={insertPack}
                onOpenPack={openPack}
                onImport={openImport}
                onNotice={notifyClue}
              />
            </div>
          </WorkbenchSection>
        </div>
      )}

      </div>

    </div>
  )
}
