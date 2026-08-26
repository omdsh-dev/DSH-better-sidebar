/**
 * The controlled file tree behind the files window's tree panel (TreePanel
 * wraps it with the search box): a lazy VSCode-style tree rooted at the
 * session's working directory. Levels load on expansion (one API call per
 * directory), directories sort first, hidden entries render dimmed. Loaded
 * levels are cached per session/workspace so opening another file tab paints
 * the same tree immediately instead of flashing through a loading frame. The
 * expansion set lives in the per-session state (owned by the caller); the
 * caller also owns the refresh affordance — a `refreshTick` bump wipes the
 * shared level cache so the visible set reloads.
 *
 * Row actions: hovering a row reveals an @-reference button on the far
 * right (appends `@<relative path>` to the composer draft), and right-click
 * opens a context menu: file rows offer the caller's open escapes
 * (new tab / to the side, only when the callbacks exist) and a download
 * action (the host serves raw bytes, binary-safe); directory rows offer
 * inline direct-child creation and file/folder import; every row can copy the
 * relative or absolute path (with a brief "copied" label replacing the
 * button after a successful write).
 *
 * Uploads start here (drag-drop or the context menu picker) but run in the
 * caller: every request is reported through `onUploadRequest(dir, items)`
 * (VSCode semantics — a drop on a file row targets its parent directory),
 * and `busy` gates new drags while one upload is in flight.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  IconChevronRightOutline14, IconCodeOutline16, IconCopyOutline16, IconDownloadOutline16,
  IconLinkOutline16, IconTrashOutline16, Menu, type MenuEntry, type MenuItem, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { SiCursor, SiZedindustries } from 'react-icons/si'
import {
  VscFolder, VscFolderOpened, VscLinkExternal, VscNewFile, VscNewFolder, VscPin, VscPinned,
} from 'react-icons/vsc'
import { api, downloadUrl, type FsEntry } from './api.ts'
import { FileTypeIcon } from './file-icons.tsx'
import { IconUploadOutline16, IconVscode16 } from './icons.tsx'
import type { OpenWithTarget } from './open-with.ts'
import { relativeTo } from './paths.ts'
import { t } from './locales.ts'
import { uploadItemsFromDrop, type UploadItem } from './upload.ts'
import css from './sidebar.module.css'

interface LevelData {
  entries?: FsEntry[]
  error?: string
}

/** Resolved lazy levels shared by file-tree instances in the same workspace.
 *  Loading placeholders stay instance-local so a tab never waits on another
 *  tab's in-flight request without receiving its completion. */
const LEVEL_CACHE_LIMIT = 12
const levelCache = new Map<string, Record<string, LevelData>>()

/** Stable cache identity for one session workspace. */
function levelCacheKey(sessionId: string, cwd: string | undefined): string {
  return JSON.stringify([sessionId, cwd ?? null])
}

/** Read and touch one cache entry so the bounded map evicts inactive scopes. */
function readLevelCache(key: string): Record<string, LevelData> | undefined {
  const cached = levelCache.get(key)
  if (cached === undefined) return undefined
  levelCache.delete(key)
  levelCache.set(key, cached)
  return cached
}

/** Store one resolved level and evict the least-recently-used scope. */
function writeLevelCache(key: string, path: string, level: LevelData): Record<string, LevelData> {
  const next = { ...(levelCache.get(key) ?? {}), [path]: level }
  levelCache.delete(key)
  levelCache.set(key, next)
  while (levelCache.size > LEVEL_CACHE_LIMIT) {
    const oldest = levelCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    levelCache.delete(oldest)
  }
  return next
}

/** Root label: the last path segment (mirror of the host rootLabel). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/** The containing directory of an absolute row path (never the root edge here). */
function parentOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at <= 0 ? path : path.slice(0, at)
}

/** Only OS file drags belong to the upload surface; in-app drags (tab reorder,
 *  split zones) must pass through untouched to the pane's tab-drop handling
 *  (mirror of Sidebar.tsx's panel-host shield gate). */
function isFileDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false
}

/** Keep primary-pointer row selection from focusing and auto-scrolling the
 *  row. Keyboard focus remains available through tabIndex and key handlers. */
function preserveTreeViewportOnMouseDown(event: MouseEvent<HTMLElement>): void {
  if (event.button !== 0) return
  const target = event.target
  if (target instanceof Element && target.closest('button') !== null) return
  event.preventDefault()
}

/** How long the row's "copied" label stays after a successful write. */
const COPIED_MS = 1200

/**
 * The drop overlay's hero art: an arrow rising out of a notched tray
 * (upload zone — the same glyph family as the toolbar's upload icon) and a
 * tilted pair of photo cards (chat zone). Hand-drawn, colored in the
 * palette of DSH's own native drop illustration (#3964FE / #9CE5ED) so the
 * two zones read as one family; the drop overlay is this flow's one brand
 * moment, so it gets color the rest of the UI never does.
 */
const UploadDropIllustration = () => (
  <svg width="64" height="56" viewBox="0 0 64 56" fill="none" aria-hidden="true">
    <path d="M32 28V11" stroke="#3964FE" strokeWidth="5" strokeLinecap="round" />
    <path d="M23 20l9-9 9 9" stroke="#3964FE" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    <path
      d="M10 40a4 4 0 0 1 4-4h7l3.2 4.6a5 5 0 0 0 4.1 2.2h7.4a5 5 0 0 0 4.1-2.2L43 36h7a4 4 0 0 1 4 4v2a10 10 0 0 1-10 10H20A10 10 0 0 1 10 42v-2z"
      fill="#9CE5ED"
    />
  </svg>
)

/** The chat zone's art: two tilted photo cards, each with its own
 *  sun-over-mountains motif (the back card carries detail too, so it never
 *  reads as a bare blob). */
const ChatDropIllustration = () => (
  <svg width="96" height="76" viewBox="0 0 96 76" fill="none" aria-hidden="true">
    <g transform="rotate(-12 24 34)">
      <rect x="6" y="16" width="36" height="36" rx="10" fill="#9CE5ED" />
      <circle cx="16" cy="27" r="3.5" fill="white" />
      <path d="M11 44l8-9 6 6 4-4 8 9" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </g>
    <g transform="rotate(8 61 35)">
      <rect x="40" y="12" width="42" height="46" rx="10" fill="#3964FE" />
      <circle cx="55" cy="27" r="5" fill="white" />
      <path d="M46 50l10-13 7 8 6-6 9 11" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  </svg>
)

/** One explorer entry selected for permanent deletion. */
export interface FileTreeDeleteTarget {
  path: string
  kind: 'file' | 'directory' | 'symlink'
}

/** Kind of an empty entry requested from a directory context menu. */
export type FileTreeCreateKind = 'file' | 'directory'

export function FileTree(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  /** Files highlighted by a "Show in folder" reveal (absolute paths). */
  revealed: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** Context-menu "open in a new tab" (file rows; absent → no entry). */
  onOpenFileNewTab?: (path: string) => void
  /** Context-menu "open to the side" (file rows; absent → no entry). */
  onOpenFileSide?: (path: string) => void
  /** Context-menu delete request; caller confirms and runs it. */
  onDeleteEntry?: (target: FileTreeDeleteTarget) => void
  /**
   * The "open with" menu: resolved external targets (already SSH-filtered
   * and in menu order). Absent → the whole section is hidden.
   */
  openWithTargets?: OpenWithTarget[]
  /** Ids of targets pinned to the menu's top level (subset of the ids). */
  openWithPinned?: string[]
  /** Whether the workspace is remote (appends the SSH hint to target labels). */
  openWithSsh?: boolean
  /** Open one target externally (reveal or URL — the caller decides). */
  onOpenWith?: (targetId: string, path: string) => void
  /** Toggle one target's pinned state (the submenu row's pushpin). */
  onToggleOpenWithPin?: (targetId: string) => void
  /** Insert `@<relative path>` into the composer draft. */
  onReferenceFile: (path: string) => void
  /** Create one empty direct child; resolves with its absolute path. */
  onCreateEntry?: (dir: string, name: string, kind: FileTreeCreateKind) => Promise<{ path: string }>
  /** Open the OS file picker and import its selection into `dir`. */
  onImportFiles?: (dir: string) => void
  /** Open the OS folder picker and import its selection into `dir`. */
  onImportFolder?: (dir: string) => void
  /** Bump to wipe the level cache and reload the visible set. */
  refreshTick: number
  /** Upload into `dir` (absolute, inside the workspace); runs in the caller. */
  onUploadRequest: (dir: string, items: UploadItem[]) => void
  /** True while an upload is in flight (drops are ignored). */
  busy: boolean
  /** Whether this tree's editor tab is currently visible. Hidden tab cells
   *  stay mounted, but their scrollports must not overwrite the live viewport. */
  visible?: boolean
  /** Scroll position restored after the lazy visible levels finish loading. */
  initialScrollTop?: number
  /** Reports navigation movement so the owning editor tab can persist it. */
  onScrollTopChange?: (scrollTop: number) => void
}) {
  const { sessionId, cwd, expanded, revealed, onToggle, onOpenFile, onOpenFileNewTab, onOpenFileSide, onDeleteEntry, openWithTargets, openWithPinned, openWithSsh, onOpenWith, onToggleOpenWithPin, onReferenceFile, onCreateEntry, onImportFiles, onImportFolder, refreshTick, onUploadRequest, busy, visible = true, initialScrollTop = 0, onScrollTopChange } = props
  const cacheKey = levelCacheKey(sessionId, cwd)
  const [data, setData] = useState<Record<string, LevelData>>(() => readLevelCache(cacheKey) ?? {})
  const dataRef = useRef(data)
  /** Invalidates directory requests started before a refresh/workspace switch. */
  const requestEpochRef = useRef(0)
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{
    path: string
    isDir: boolean
    isSymlink: boolean
    isRoot: boolean
    x: number
    y: number
  } | null>(null)
  /** Inline direct-child name editor opened from one directory menu. */
  const [createDraft, setCreateDraft] = useState<{
    dir: string
    kind: FileTreeCreateKind
    name: string
    submitting: boolean
    error: string | null
  } | null>(null)
  /** Synchronous guard against two Enter events before React commits state. */
  const createSubmissionRef = useRef(false)
  /** Whether a file drag hovers the tree (drives the portaled drop zone). */
  const [dropOver, setDropOver] = useState(false)
  /** The directory a drag is hovering right now (null = body, drop to root). */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /**
   * Enter/leave depth under the tree body. dragenter/dragleave fire per
   * element along the drag path (and bubble), so a counter — DSH InputBar's
   * own pattern — is the flicker-free signal; relatedTarget is unreliable
   * across engines for drag events.
   */
  const dropDepth = useRef(0)
  /** Explorer body element; its viewport rect anchors the portaled drop zone. */
  const bodyRef = useRef<HTMLDivElement>(null)
  /** Desired position stays independent from the DOM while lazy directories
   *  are still too short to accept the restored scrollTop. */
  const desiredScrollTopRef = useRef(initialScrollTop)
  /** The persisted input already folded into `desiredScrollTopRef`. React can
   *  batch a hidden tab's meta update with its activation, so this sync must
   *  happen during render — a passive effect runs after the layout restore
   *  and would leave the old tab's previous (often zero) viewport on screen. */
  const restoredScrollInputRef = useRef({ sessionId, cwd, initialScrollTop })
  const restoredScrollInput = restoredScrollInputRef.current
  if (
    restoredScrollInput.sessionId !== sessionId
    || restoredScrollInput.cwd !== cwd
    || restoredScrollInput.initialScrollTop !== initialScrollTop
  ) {
    restoredScrollInputRef.current = { sessionId, cwd, initialScrollTop }
    desiredScrollTopRef.current = initialScrollTop
  }
  /** The body's viewport rect captured at drag entry (null = not measured). */
  const [dropRect, setDropRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null)

  /** Reset all drag state (drop landed, the drag left, or a new drag begins). */
  const resetDrop = (): void => {
    dropDepth.current = 0
    setDropOver(false)
    setDropTarget(null)
    setDropRect(null)
  }

  /**
   * Drop handlers: always swallow the event (a dropped file must never open
   * in the browser), then report the target directory to the caller. A drop
   * ends the drag without further leave events, so the depth resets here.
   * The payload collection is async (dropped folders are traversed through
   * their entry handles — captured synchronously inside uploadItemsFromDrop
   * while the dataTransfer is still live), so the request rides a then.
   */
  const reportDrop = (dir: string, data: DataTransfer | undefined): void => {
    if (busy) return
    void uploadItemsFromDrop(data).then((items) => {
      if (items.length > 0) onUploadRequest(dir, items)
    })
  }
  const handleBodyDrop = (event: DragEvent): void => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    resetDrop()
    if (cwd !== undefined) reportDrop(cwd, event.dataTransfer)
  }
  const handleDirDrop = (event: DragEvent, dir: string): void => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    resetDrop()
    reportDrop(dir, event.dataTransfer)
  }
  const handleFileDrop = (event: DragEvent, path: string): void => {
    // VSCode semantics: dropping onto a file uploads into its directory.
    handleDirDrop(event, parentOf(path))
  }
  const handleBodyDragEnter = (event: DragEvent): void => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    dropDepth.current += 1
    if (busy) return
    // First entry: anchor the portaled drop zone to the body's rect.
    if (dropDepth.current === 1) {
      const rect = bodyRef.current?.getBoundingClientRect()
      setDropRect(rect === undefined ? null : { top: rect.top, left: rect.left, width: rect.width, height: rect.height })
    }
    setDropOver(true)
  }
  const handleBodyDragLeave = (): void => {
    dropDepth.current = Math.max(0, dropDepth.current - 1)
    if (dropDepth.current > 0) return
    setDropOver(false)
    setDropTarget(null)
    setDropRect(null)
  }
  const handleBodyDragOver = (event: DragEvent): void => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
    if (busy) return
    // Rows stop propagation, so this only fires over non-row regions: the
    // drag targets the workspace root. dragover fires continuously, making
    // it the authoritative (flicker-free) place to clear the row target.
    setDropTarget(null)
  }
  const handleRowDragOver = (event: DragEvent, dir: string): void => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
    if (busy) return
    setDropTarget(dir)
  }

  const markLevelLoading = useCallback((path: string) => {
    dataRef.current = { ...dataRef.current, [path]: {} }
    setData(dataRef.current)
  }, [])

  const storeLevel = useCallback((path: string, level: LevelData, requestEpoch: number) => {
    if (requestEpoch !== requestEpochRef.current) return
    const shared = writeLevelCache(cacheKey, path, level)
    dataRef.current = { ...dataRef.current, ...shared, [path]: level }
    setData(dataRef.current)
  }, [cacheKey])

  const loadDir = useCallback((dir: string) => {
    if (dataRef.current[dir] !== undefined) return
    const cached = readLevelCache(cacheKey)
    if (cached?.[dir] !== undefined) {
      dataRef.current = { ...dataRef.current, ...cached }
      setData(dataRef.current)
      return
    }
    markLevelLoading(dir)
    const requestEpoch = requestEpochRef.current
    api.fsTree({ sessionId, cwd }, dir).then((listing) => {
      storeLevel(dir, { entries: listing.entries }, requestEpoch)
    }).catch((error: unknown) => {
      storeLevel(dir, { error: error instanceof Error ? error.message : String(error) }, requestEpoch)
    })
  }, [sessionId, cwd, cacheKey, markLevelLoading, storeLevel])

  // Clear stale rows before paint so a deleted entry cannot still be clicked
  // while the authoritative listing reloads. The epoch also prevents a
  // slower pre-refresh request from restoring an obsolete directory level.
  const lastLoadContext = useRef({ cacheKey, refreshTick })
  useLayoutEffect(() => {
    const previous = lastLoadContext.current
    if (previous.cacheKey === cacheKey && previous.refreshTick === refreshTick) return
    lastLoadContext.current = { cacheKey, refreshTick }
    requestEpochRef.current += 1
    const refreshed = previous.refreshTick !== refreshTick
    if (refreshed) levelCache.delete(cacheKey)
    const next = refreshed ? {} : readLevelCache(cacheKey) ?? {}
    dataRef.current = next
    setData(next)
  }, [cacheKey, refreshTick])

  useEffect(() => {
    // Load the visible set; already-loaded levels (kept in the cache) are
    // not refetched. Only the refresh tick wipes the cache.
    const root = cwd
    if (root === undefined) return
    loadDir(root)
    for (const dir of expanded) loadDir(dir)
  }, [cwd, expanded, refreshTick, loadDir])

  // Bring a "Show in folder" reveal into view: the ancestors expand above
  // (revealPaths), but the row may not be scrolled into sight — a reveal on
  // a long tree should surface the highlighted file. Re-runs when the tree
  // data or reveal set changes (the row appears after its level loads).
  useEffect(() => {
    if (!visible || revealed.length === 0) return
    const row = bodyRef.current?.querySelector('[data-dsh-revealed]')
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [visible, revealed, data])

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (body === null || !visible) return
    // A restored position can only be applied after every expanded level has
    // produced rows. Applying it against the initial loading placeholders
    // would clamp it to zero and lose the user's navigation context.
    const visibleDirs = cwd === undefined ? [] : [cwd, ...expanded]
    const loaded = visibleDirs.every((dir) => {
      const level = data[dir]
      return level?.entries !== undefined || level?.error !== undefined
    })
    if (!loaded) return
    body.scrollTop = desiredScrollTopRef.current
  }, [cwd, expanded, data, initialScrollTop, visible])

  /** Copy `text`; on success flip the row's copied label for a moment. */
  const copyPath = useCallback((text: string, path: string): void => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopiedPath(path)
      window.setTimeout(() => {
        setCopiedPath(current => current === path ? null : current)
      }, COPIED_MS)
    })
  }, [])

  /** The row's trailing actions: the @-reference button, or the copied label. */
  const rowActions = (entry: FsEntry): ReactNode => {
    if (copiedPath === entry.path) {
      return <span className={css.explorerCopied}>{t('copied')}</span>
    }
    return (
      <button
        type="button"
        className={css.explorerRef}
        aria-label={t('referenceFile')}
        title={t('referenceFile')}
        onClick={(event) => {
          event.stopPropagation()
          onReferenceFile(entry.path)
        }}
      >
        {t('referenceFile')}
      </button>
    )
  }

  const openRowMenu = (
    event: MouseEvent,
    target: { path: string; isDir: boolean; isSymlink: boolean; isRoot?: boolean },
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    setRowMenu({ ...target, isRoot: target.isRoot === true, x: event.clientX, y: event.clientY })
  }

  /** Download a file through the host route (raw bytes, binary-safe). */
  const downloadFile = (path: string): void => {
    const url = downloadUrl({ sessionId, cwd }, path)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  /** The menu label of one open target: a locale key for the built-ins, the
   *  user's own name for custom editors, plus the SSH hint in remote mode. */
  const openWithLabelOf = (target: OpenWithTarget): string => {
    const name = target.nameKey !== undefined ? t(target.nameKey) : target.name
    return openWithSsh === true && !target.localOnly ? `${name}${t('openWithSshSuffix')}` : name
  }

  /**
   * The "open with" menu entries: the pinned targets as DIRECT rows, then
   * the parent row with every target as a nested submenu. Both only render
   * when the caller wired the feature and at least one target is visible.
   */
  const openWithEntries = (): MenuEntry[] => {
    if (openWithTargets === undefined || onOpenWith === undefined || openWithTargets.length === 0) return []
    const pinnedIds = openWithPinned ?? []
    /** Brand marks for the built-ins (monochrome silhouettes, currentColor);
     *  reveal gets the folder glyph, custom editors a generic code mark. */
    const itemIcon = (target: OpenWithTarget): ReactNode => {
      if (target.kind === 'reveal') return <VscFolderOpened size={16} />
      if (target.id === 'vscode') return <IconVscode16 size={16} />
      if (target.id === 'cursor') return <SiCursor size={16} />
      if (target.id === 'zed') return <SiZedindustries size={16} />
      return <IconCodeOutline16 size={16} />
    }
    const pinned = openWithTargets
      .filter(target => pinnedIds.includes(target.id))
      .map<MenuItem>(target => ({
        id: `open-with:${target.id}`,
        label: openWithLabelOf(target),
        icon: itemIcon(target),
      }))
    const submenu = openWithTargets.map<MenuItem>(target => {
      const pinnedNow = pinnedIds.includes(target.id)
      return {
        id: `open-with:${target.id}`,
        label: (
          <span className={css.openWithLabel}>
            <span className={css.openWithName}>{openWithLabelOf(target)}</span>
            {/* The pushpin: a span (never a button — the Menu row itself is
                a button, so a nested interactive element would be invalid).
                Clicking it pins/unpins the target at the menu's top level
                WITHOUT selecting the row: the pin stops propagation, so the
                menu stays open and the icon flips on the next render. */}
            <span
              role="button"
              tabIndex={-1}
              className={clsx(css.openWithPin, pinnedNow && css.openWithPinActive)}
              aria-label={pinnedNow ? t('unpinOpenWith') : t('pinOpenWith')}
              title={pinnedNow ? t('unpinOpenWith') : t('pinOpenWith')}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onToggleOpenWithPin?.(target.id)
              }}
            >
              {pinnedNow ? <VscPinned size={14} /> : <VscPin size={14} />}
            </span>
          </span>
        ),
        icon: itemIcon(target),
      }
    })
    return [
      ...pinned,
      ...(pinned.length > 0 ? [{ id: 'open-with-sep', type: 'separator' } as MenuEntry] : []),
      {
        id: 'open-with-menu',
        // The primitives Menu renders no chevron for submenu parents — the
        // trailing arrow is supplied inside the label (full-width flex row,
        // right-aligned), matching how the submenu rows right-align the pin.
        label: (
          <span className={css.openWithLabel}>
            <span className={css.openWithName}>{t('openWithMenu')}</span>
            <IconChevronRightOutline14 size={14} className={css.openWithChevron} aria-hidden />
          </span>
        ),
        icon: <VscLinkExternal size={16} />,
        submenu,
      },
    ]
  }

  const root = cwd

  /** Capture the live viewport before the owning editor switches tabs. */
  const openFileAtCurrentViewport = (path: string): void => {
    const scrollTop = bodyRef.current?.scrollTop ?? desiredScrollTopRef.current
    desiredScrollTopRef.current = scrollTop
    onScrollTopChange?.(scrollTop)
    onOpenFile(path)
  }

  /** Reveal an inline direct-child name editor under the selected directory. */
  const startCreate = (dir: string, kind: FileTreeCreateKind): void => {
    if (busy || onCreateEntry === undefined) return
    if (dir !== root && !expanded.includes(dir)) onToggle(dir)
    setCreateDraft({ dir, kind, name: '', submitting: false, error: null })
  }

  /** Validate and create the current inline draft without overwriting. */
  const submitCreate = async (): Promise<void> => {
    const draft = createDraft
    if (draft === null || draft.submitting || createSubmissionRef.current || onCreateEntry === undefined) return
    const name = draft.name.trim()
    if (name === '') {
      setCreateDraft({ ...draft, error: t('createNameRequired') })
      return
    }
    if (name === '.' || name === '..' || /[\\/]/.test(name)) {
      setCreateDraft({ ...draft, error: t('createNameInvalid') })
      return
    }
    createSubmissionRef.current = true
    setCreateDraft({ ...draft, name, submitting: true, error: null })
    try {
      const created = await onCreateEntry(draft.dir, name, draft.kind)
      setCreateDraft(null)
      if (draft.kind === 'file') openFileAtCurrentViewport(created.path)
      else if (!expanded.includes(created.path)) onToggle(created.path)
    } catch (reason) {
      setCreateDraft({
        ...draft,
        name,
        submitting: false,
        error: t('createFailed', { error: reason instanceof Error ? reason.message : String(reason) }),
      })
    } finally {
      createSubmissionRef.current = false
    }
  }

  /** One inline name row at the first child position of its parent. */
  const renderCreateRow = (dir: string, depth: number): ReactNode => {
    const draft = createDraft
    if (draft === null || draft.dir !== dir) return null
    const errorId = 'dsh-file-tree-create-error'
    return (
      <div className={css.explorerCreateBlock}>
        <div className={css.explorerRow} style={{ paddingLeft: depth * 22 + 6 }}>
          {draft.kind === 'directory' ? <VscNewFolder size={14} /> : <VscNewFile size={14} />}
          <input
            autoFocus
            className={css.explorerCreateInput}
            value={draft.name}
            maxLength={255}
            aria-label={draft.kind === 'directory' ? t('newFolderName') : t('newFileName')}
            aria-invalid={draft.error !== null}
            aria-describedby={draft.error === null ? undefined : errorId}
            placeholder={draft.kind === 'directory' ? t('newFolderName') : t('newFileName')}
            disabled={draft.submitting}
            onClick={(event) => { event.stopPropagation() }}
            onChange={(event) => {
              setCreateDraft(current => current === null
                ? current
                : { ...current, name: event.target.value, error: null })
            }}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') {
                event.preventDefault()
                void submitCreate()
              } else if (event.key === 'Escape' && !draft.submitting) {
                event.preventDefault()
                setCreateDraft(null)
              }
            }}
          />
        </div>
        {draft.error !== null && (
          <div
            id={errorId}
            className={css.explorerCreateError}
            style={{ paddingLeft: depth * 22 + 24 }}
          >
            {draft.error}
          </div>
        )}
      </div>
    )
  }

  const renderLevel = (dir: string, depth: number): ReactNode => {
    const level = data[dir]
    const createRow = renderCreateRow(dir, depth)
    if (level === undefined) {
      return (
        <>
          {createRow}
          <div className={css.explorerRow} style={{ paddingLeft: depth * 22 + 6 }}>{t('loading')}</div>
        </>
      )
    }
    if (level.error !== undefined) {
      return (
        <>
          {createRow}
          <div className={clsx(css.explorerRow, css.explorerError)} style={{ paddingLeft: depth * 22 + 6 }}>
            {level.error}
          </div>
        </>
      )
    }
    const entries = level.entries ?? []
    return (
      <>
        {createRow}
        {entries.map(entry => {
          if (entry.isDir) {
            const isOpen = expanded.includes(entry.path)
            return (
              <div key={entry.path}>
                <div
                  role="button"
                  tabIndex={0}
                  className={clsx(
                    css.explorerRow, css.explorerDir, entry.hidden && css.explorerHidden,
                    dropTarget === entry.path && css.explorerRowDropTarget,
                    revealed.includes(entry.path) && css.explorerRowRevealed,
                  )}
                  data-dsh-revealed={revealed.includes(entry.path) ? 'true' : undefined}
                  style={{ paddingLeft: depth * 22 + 6 }}
                  onMouseDown={preserveTreeViewportOnMouseDown}
                  onClick={() => { onToggle(entry.path) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onToggle(entry.path)
                    }
                  }}
                  onDragOver={(event) => { handleRowDragOver(event, entry.path) }}
                  onDrop={(event) => { handleDirDrop(event, entry.path) }}
                  onContextMenu={(event) => { openRowMenu(event, entry) }}
                >
                  {isOpen ? <VscFolderOpened size={14} /> : <VscFolder size={14} />}
                  <span className={css.explorerName}>{entry.name}</span>
                  {entry.isSymlink && <IconLinkOutline16 size={12} className={css.explorerSymlink} />}
                  {rowActions(entry)}
                </div>
                {isOpen && renderLevel(entry.path, depth + 1)}
              </div>
            )
          }
          return (
            <div
              key={entry.path}
              role="button"
              tabIndex={0}
              className={clsx(
                css.explorerRow, entry.hidden && css.explorerHidden, entry.broken && css.explorerBroken,
                dropTarget === parentOf(entry.path) && css.explorerRowDropTarget,
                revealed.includes(entry.path) && css.explorerRowRevealed,
              )}
              data-dsh-revealed={revealed.includes(entry.path) ? 'true' : undefined}
              style={{ paddingLeft: depth * 22 + 6 }}
              title={entry.broken ? `${entry.path} — ${t('brokenSymlink')}` : entry.path}
              onMouseDown={preserveTreeViewportOnMouseDown}
              onClick={() => { openFileAtCurrentViewport(entry.path) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  openFileAtCurrentViewport(entry.path)
                }
              }}
              onDragOver={(event) => { handleRowDragOver(event, parentOf(entry.path)) }}
              onDrop={(event) => { handleFileDrop(event, entry.path) }}
              onContextMenu={(event) => { openRowMenu(event, entry) }}
            >
              <FileTypeIcon path={entry.path} />
              <span className={css.explorerName}>{entry.name}</span>
              {entry.isSymlink && <IconLinkOutline16 size={12} className={css.explorerSymlink} />}
              {rowActions(entry)}
            </div>
          )
        })}
      </>
    )
  }

  return (
    <div
      ref={bodyRef}
      className={css.explorerBody}
      onScroll={(event) => {
        // Browsers may report a zeroed scrollport while an inactive tab is
        // display:none. That is layout fallout, not user navigation.
        if (!visible) return
        const scrollTop = event.currentTarget.scrollTop
        desiredScrollTopRef.current = scrollTop
        onScrollTopChange?.(scrollTop)
      }}
      onDragEnter={handleBodyDragEnter}
      onDragOver={handleBodyDragOver}
      onDragLeave={handleBodyDragLeave}
      onDrop={handleBodyDrop}
    >
      {root === undefined ? (
        <div className={css.explorerEmpty}>{t('noSession')}</div>
      ) : (
        <>
          <div
            className={clsx(css.explorerRow, dropTarget === root && css.explorerRowDropTarget)}
            style={{ paddingLeft: 6 }}
            onDragOver={(event) => { handleRowDragOver(event, root) }}
            onDrop={(event) => { handleDirDrop(event, root) }}
            onContextMenu={(event) => {
              openRowMenu(event, { path: root, isDir: true, isSymlink: false, isRoot: true })
            }}
          >
            <VscFolderOpened size={14} />
            <span className={css.explorerName}>{baseName(root)}</span>
            {copiedPath === root
              ? <span className={css.explorerCopied}>{t('copied')}</span>
              : (
                <button
                  type="button"
                  className={css.explorerRef}
                  aria-label={t('referenceFile')}
                  title={t('referenceFile')}
                  onClick={(event) => {
                    event.stopPropagation()
                    onReferenceFile(root)
                  }}
                >
                  {t('referenceFile')}
                </button>
              )}
          </div>
          {data[root] !== undefined && renderLevel(root, 1)}
        </>
      )}
      {dropOver && dropRect !== null && createPortal(
        /*
         * The sidebar's drop surface, portaled to document.body at z-1001 —
         * above DSH's own whole-page drop mask (z-1000, see InputBar's
         * document-level intake) so the two never compete. It dims the WHOLE
         * viewport (the giant box-shadow spread on the zone frame is the
         * mask; the zone rect itself stays clear), teaching the zone split:
         * the dimmed conversation column still takes drops into the chat
         * natively (this layer is pointer-inert), while the clear frame
         * marks the tree as the workspace-upload zone. Deliberate exception
         * to the "panel stays below the DSH float stack" rule: transient,
         * and the drop always lands on the element beneath. The hint pill
         * docks at the TOP edge of the zone — right under the search row,
         * the first thing the eye meets — keeping the rows aimable.
         */
        <>
          <div
            className={css.uploadDropZone}
            style={{
              top: dropRect.top + 2,
              left: dropRect.left + 2,
              width: dropRect.width - 4,
              height: dropRect.height - 4,
            }}
          >
            <div className={css.uploadDropHero}>
              <UploadDropIllustration />
              <div className={css.uploadDropZonePill}>
                <IconUploadOutline16 size={14} />
                <span className={css.uploadDropZoneText}>
                  {dropTarget !== null ? t('uploadTo', { dir: dropTarget }) : t('uploadDropHint')}
                </span>
              </div>
            </div>
          </div>
          {/* The left zone's invitation, centered in the space beside the
              tree; skipped when that space is too narrow to hold it. */}
          {dropRect.left >= 200 && (
            <div className={css.uploadDropChatHint} style={{ width: dropRect.left }}>
              <div className={css.uploadDropChatCard}>
                <ChatDropIllustration />
                <span>{t('uploadDropChat')}</span>
              </div>
            </div>
          )}
        </>,
        document.body,
      )}
      {/*
        The one shared context menu, positioned at the right-click cursor
        (portal so the tree's overflow clip cannot crop it).
      */}
      <Menu
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={[
          // The open escapes head the FILE menu (dirs only get copy).
          ...(rowMenu?.isDir === false && onOpenFileNewTab !== undefined
            ? [{ id: 'open-new-tab', label: t('openFileNewTab'), icon: <IconCodeOutline16 size={16} /> }]
            : []),
          ...(rowMenu?.isDir === false && onOpenFileSide !== undefined
            ? [{ id: 'open-side', label: t('openFileSide'), icon: <VscFolderOpened size={16} /> }]
            : []),
          ...openWithEntries(),
          // Download applies to files only (the host route refuses directories).
          ...(rowMenu?.isDir === false
            ? [{ id: 'download', label: t('download'), icon: <IconDownloadOutline16 size={16} /> }]
            : []),
          // Direct-child creation and imports belong to the selected folder
          // (including the workspace root), never to a global toolbar target.
          ...(rowMenu?.isDir === true && onCreateEntry !== undefined
            ? [
                { id: 'create-file', label: t('createFile'), icon: <VscNewFile size={16} />, ...(busy ? { disabled: true } : {}) },
                { id: 'create-folder', label: t('createFolder'), icon: <VscNewFolder size={16} />, ...(busy ? { disabled: true } : {}) },
              ]
            : []),
          ...(rowMenu?.isDir === true && onImportFiles !== undefined
            ? [{ id: 'import-files', label: t('importFiles'), icon: <IconUploadOutline16 size={16} />, ...(busy ? { disabled: true } : {}) }]
            : []),
          ...(rowMenu?.isDir === true && onImportFolder !== undefined
            ? [{ id: 'import-folder', label: t('importFolder'), icon: <VscFolderOpened size={16} />, ...(busy ? { disabled: true } : {}) }]
            : []),
          ...(rowMenu?.isDir === true
            && (onCreateEntry !== undefined || onImportFiles !== undefined || onImportFolder !== undefined)
            ? [{ type: 'separator' as const, id: 'directory-actions-separator' }]
            : []),
          { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutline16 size={16} /> },
          { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={16} /> },
          ...(rowMenu !== null && !rowMenu.isRoot && onDeleteEntry !== undefined
            ? [
                { type: 'separator' as const, id: 'delete-separator' },
                {
                  id: 'delete',
                  label: rowMenu.isSymlink
                    ? t('deleteSymlink')
                    : rowMenu.isDir ? t('deleteFolder') : t('deleteFile'),
                  icon: <IconTrashOutline16 size={16} />,
                  danger: true, ...(busy ? { disabled: true } : {}),
                },
              ]
            : []),
        ]}
        onSelect={(id) => {
          const target = rowMenu
          if (target === null) return
          setRowMenu(null)
          if (id === 'open-new-tab') {
            onOpenFileNewTab?.(target.path)
            return
          }
          if (id === 'open-side') {
            onOpenFileSide?.(target.path)
            return
          }
          if (id.startsWith('open-with:')) {
            onOpenWith?.(id.slice('open-with:'.length), target.path)
            return
          }
          if (id === 'download') {
            downloadFile(target.path)
            return
          }
          if (id === 'delete') {
            onDeleteEntry?.({
              path: target.path,
              kind: target.isSymlink ? 'symlink' : target.isDir ? 'directory' : 'file',
            })
            return
          }
          if (id === 'create-file' || id === 'create-folder') {
            startCreate(target.path, id === 'create-file' ? 'file' : 'directory')
            return
          }
          if (id === 'import-files') {
            onImportFiles?.(target.path)
            return
          }
          if (id === 'import-folder') {
            onImportFolder?.(target.path)
            return
          }
          copyPath(
            id === 'relative' ? relativeTo(cwd ?? '', target.path) : target.path,
            target.path,
          )
        }}
        portal
        align="start"
        getAnchorRect={() => (rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0))}
        anchor={<span />}
      />
    </div>
  )
}
