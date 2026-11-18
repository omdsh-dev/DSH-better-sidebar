/**
 * The session media viewer: every image, clip, audio file and document one
 * conversation ever carried, in one page.
 *
 * Two products in one tab, and the second is the point of the feature:
 *
 *  1. **The catalogue** — the session's whole media history, folded out of its
 *     durable event log by the host (`media.list`); DSH itself has no such
 *     list, it renders media only where the chat happens to show it.
 *  2. **A durable thumbnail per row** — rendered HERE, in a `<canvas>`, and
 *     uploaded to the plugin's own store (`media.thumb.save`). DSH never
 *     deletes an attachment object, but a user reclaiming space, a rebuilt
 *     harness home or a log carried onto another machine leaves every
 *     reference dangling; a thumbnail this plugin owns keeps the conversation's
 *     media browsable through exactly that.
 *
 * Rendering a thumbnail client-side is the deliberate choice: a PNG decode is
 * the browser's job, a video frame is reachable through the very element the
 * viewer plays, and a document becomes a drawn card. A host-side `sharp` or an
 * ffmpeg binary would add a native dependency to a sidebar plugin and still
 * not cover the video case any better.
 *
 * The page never downloads an original it does not need: the grid shows the
 * stored thumbnail when there is one, and only the opened item fetches bytes.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular,
  IconDownloadOutlineRegular, IconRefreshOutlineRegular, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { VscDeviceCameraVideo, VscFileMedia, VscMusic } from 'react-icons/vsc'
import { api, downloadUrl } from './api.ts'
import { hostRouteUrl } from './host-route-url.ts'
import type { TabComponentProps } from './service.ts'
import { useSessionScope } from './session-scope.ts'
import type { SessionScope } from './api.ts'
import { leafOf, type MediaListRow, type MediaListValue, type SessionMediaKind } from '../session-media.ts'
import { t } from './locales.ts'
import css from './media-viewer.module.css'

/** Grid page size: the catalogue renders this many rows per batch. */
const PAGE_SIZE = 120

/** Thumbnail box the canvas renders into (2× the 88px card for crispness). */
const THUMB_PX = 176

/** Kinds the filter row offers, in display order. */
const KINDS: readonly SessionMediaKind[] = ['image', 'video', 'audio', 'document']

/** How long one video frame capture may take before the row is given up on. */
const VIDEO_SEEK_TIMEOUT_MS = 4_000

/**
 * The label of one kind, localized.
 * @param kind - the coarse media kind.
 * @returns the filter chip's text.
 */
function kindLabel(kind: SessionMediaKind): string {
  switch (kind) {
    case 'image': return t('mediaKindImage')
    case 'video': return t('mediaKindVideo')
    case 'audio': return t('mediaKindAudio')
    case 'document': return t('mediaKindDocument')
    default: return t('mediaKindOther')
  }
}

/**
 * The source label of one row, localized.
 * @param source - where the media entered the conversation.
 * @returns the label the card's meta line prints.
 */
function sourceLabel(source: MediaListRow['source']): string {
  switch (source) {
    case 'user': return t('mediaSourceUser')
    case 'tool': return t('mediaSourceTool')
    case 'inbox': return t('mediaSourceInbox')
    case 'presented': return t('mediaSourcePresented')
    default: return String(source)
  }
}

/**
 * Absolute URL of one row's original bytes through the plugin's own route.
 * @param scope - the session scope (the workspace resolves a delivered file).
 * @param row - the catalogue row.
 * @param download - ask for a save instead of an inline view.
 * @returns the URL.
 */
function originalUrlOf(scope: SessionScope, row: MediaListRow, download = false): string {
  const params = new URLSearchParams({ id: row.id, sessionId: scope.sessionId })
  if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
  if (download) params.set('download', '1')
  return hostRouteUrl(`sidebar/media?${params.toString()}`).href
}

/**
 * Absolute URL of one row's stored thumbnail.
 * @param id - the row's identity.
 * @returns the URL.
 */
function thumbUrlOf(id: string): string {
  return hostRouteUrl(`sidebar/media?${new URLSearchParams({ id, thumb: '1' }).toString()}`).href
}

/**
 * Draw one loaded element into a PNG payload at the card's scale.
 * @param source - the decoded element.
 * @param width - its intrinsic width.
 * @param height - its intrinsic height.
 * @returns the base64 PNG payload, or undefined when no canvas/context exists.
 */
function renderThumbPng(source: CanvasImageSource, width: number, height: number): string | undefined {
  if (width <= 0 || height <= 0) return undefined
  const scale = Math.min(THUMB_PX / width, THUMB_PX / height, 1)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (context === null) return undefined
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  const url = canvas.toDataURL('image/png')
  const comma = url.indexOf(',')
  return comma === -1 ? undefined : url.slice(comma + 1)
}

/**
 * Draw a document row's card: the extension on a plain page ground, so a
 * `.pdf` or a spreadsheet still reads at 88 px.
 * @param label - the text to print (its extension is what lands on the card).
 * @returns the base64 PNG payload, or undefined when no canvas/context exists.
 */
function renderLetterCard(label: string): string | undefined {
  const canvas = document.createElement('canvas')
  canvas.width = THUMB_PX
  canvas.height = THUMB_PX
  const context = canvas.getContext('2d')
  if (context === null) return undefined
  // A thumbnail has to read at 88px, so nothing smaller than a 3-letter tag.
  // The ground and ink are literal BY DESIGN: this is a picture of a document,
  // not a themed surface — a skin changing its colour would make every PDF
  // card a different shade of "paper".
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.strokeStyle = '#d8dbe2'
  context.lineWidth = 4
  context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4)
  const extension = /\.([A-Za-z0-9]+)$/u.exec(label)?.[1]?.toUpperCase() ?? 'FILE'
  context.fillStyle = '#3b4252'
  context.font = 'bold 52px sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(extension.slice(0, 5), canvas.width / 2, canvas.height / 2)
  const url = canvas.toDataURL('image/png')
  const comma = url.indexOf(',')
  return comma === -1 ? undefined : url.slice(comma + 1)
}

/**
 * Capture one image row's thumbnail by loading it through an `<img>`.
 * @param url - the original bytes' URL.
 * @returns the base64 PNG payload, or undefined when the picture cannot decode.
 */
async function thumbFromImage(url: string): Promise<string | undefined> {
  const image = new Image()
  const loaded = new Promise<boolean>((resolve) => {
    image.onload = () => { resolve(true) }
    image.onerror = () => { resolve(false) }
  })
  image.src = url
  if (!await loaded) return undefined
  return renderThumbPng(image, image.naturalWidth, image.naturalHeight)
}

/**
 * Capture one video row's thumbnail from its first decodable frame.
 * @param url - the clip's URL (the plugin route honours Range).
 * @returns the base64 PNG payload, or undefined when no frame can be read.
 */
async function thumbFromVideo(url: string): Promise<string | undefined> {
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  video.playsInline = true
  const ready = new Promise<boolean>((resolve) => {
    video.onloadeddata = () => { resolve(true) }
    video.onerror = () => { resolve(false) }
  })
  video.src = url
  if (!await ready) return undefined
  // One second in is past a black lead-in on most footage; clamp for shorter
  // clips. The timeout bounds a stream the browser never finishes seeking.
  const target = Number.isFinite(video.duration) && video.duration > 1.2 ? 1 : 0
  const seeked = new Promise<boolean>((resolve) => {
    video.onseeked = () => { resolve(true) }
    window.setTimeout(() => { resolve(false) }, VIDEO_SEEK_TIMEOUT_MS)
  })
  try {
    video.currentTime = target
  } catch {
    return undefined
  }
  if (!await seeked) return undefined
  return renderThumbPng(video, video.videoWidth, video.videoHeight)
}

/**
 * The thumbnail payload for one row.
 * @param scope - the session scope.
 * @param row - the catalogue row.
 * @returns the base64 PNG, or undefined when the row's bytes cannot be read.
 */
async function thumbPayloadOf(scope: SessionScope, row: MediaListRow): Promise<string | undefined> {
  if (row.kind === 'image') return thumbFromImage(originalUrlOf(scope, row))
  if (row.kind === 'video') return thumbFromVideo(originalUrlOf(scope, row))
  return renderLetterCard(row.name ?? leafOf(row.id))
}

/**
 * The automatic capture queue: "for every row, make sure a thumbnail exists",
 * one row at a time.
 *
 * Sequential on purpose — a 300-image session must not spawn 300 decoders at
 * once. It stops when the tab is no longer visible and resumes when it is, so
 * a parked page costs nothing.
 * @param scope - the session scope, absent before one is selected.
 * @param rows - the catalogue.
 * @param visible - whether the tab is the active, open pane.
 * @param onStored - called after one thumbnail reaches the host store.
 * @returns how many rows are left, and whether the queue is running.
 */
function useThumbCapture(
  scope: SessionScope | undefined,
  rows: readonly MediaListRow[],
  visible: boolean,
  onStored: (id: string) => void,
): { pending: number; running: boolean } {
  const [pending, setPending] = useState(0)
  const [running, setRunning] = useState(false)
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())
  const busyRef = useRef(false)
  const cancelRef = useRef(false)

  useEffect(() => {
    if (!visible) {
      cancelRef.current = true
      return
    }
    cancelRef.current = false
    if (scope === undefined) return
    // Skip rows that already have a thumbnail, and rows this page already
    // failed to capture (a broken original must not be retried forever).
    const missing = rows.filter(row => !row.thumb && !failed.has(row.id))
    setPending(missing.length)
    if (missing.length === 0 || busyRef.current) return
    busyRef.current = true
    setRunning(true)
    void (async () => {
      for (const row of missing) {
        if (cancelRef.current) break
        try {
          const payload = await thumbPayloadOf(scope, row)
          if (payload === undefined) {
            setFailed(previous => new Set(previous).add(row.id))
          } else {
            await api.mediaThumbSave(row.id, payload)
            onStored(row.id)
          }
        } catch {
          setFailed(previous => new Set(previous).add(row.id))
        }
        setPending(count => Math.max(0, count - 1))
      }
      busyRef.current = false
      setRunning(false)
    })()
  }, [visible, scope, rows, failed, onStored])

  return { pending, running }
}

/**
 * The session media viewer page.
 * @param props - the tab's composed props.
 * @returns the page.
 */
export function MediaViewerTab(props: TabComponentProps): ReactNode {
  const { store, scope: seatScope, visible } = props
  // The seat scope is the tab's own conversation; a media tab must never read
  // bytes through another session's workspace.
  const scope = useSessionScope(seatScope.sessionId, seatScope.cwd)
  void store
  const [state, setState] = useState<{ loading: boolean; error?: string; value?: MediaListValue }>({ loading: true })
  const [kind, setKind] = useState<SessionMediaKind | 'all'>('all')
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [open, setOpen] = useState<MediaListRow | undefined>(undefined)
  const [batches, setBatches] = useState(1)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (scope === undefined) return
    try {
      const value = await api.mediaList(scope, signal)
      setState({ loading: false, value })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setState({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }, [scope])

  useEffect(() => {
    if (!visible) return undefined
    const controller = new AbortController()
    setState(previous => ({ ...previous, loading: true }))
    void load(controller.signal)
    return () => { controller.abort() }
  }, [visible, load])

  const rows = useMemo(() => state.value?.rows ?? [], [state.value])
  const markStored = useCallback((id: string) => {
    setState(previous => previous.value === undefined ? previous : {
      ...previous,
      value: {
        ...previous.value,
        rows: previous.value.rows.map(row => (row.id === id ? { ...row, thumb: true } : row)),
      },
    })
    setThumbs(previous => (previous[id] !== undefined ? previous : { ...previous, [id]: thumbUrlOf(id) }))
  }, [])
  const capture = useThumbCapture(scope, rows, visible, markStored)

  const matching = useMemo(
    () => rows.filter(row => (kind === 'all' || row.kind === kind) && (!onlyMissing || !row.thumb)),
    [rows, kind, onlyMissing],
  )
  const filtered = useMemo(() => matching.slice(0, PAGE_SIZE * batches), [matching, batches])

  const counts = useMemo(() => {
    const table = new Map<SessionMediaKind, number>()
    let missing = 0
    for (const row of rows) {
      table.set(row.kind, (table.get(row.kind) ?? 0) + 1)
      if (!row.thumb) missing++
    }
    return { table, missing }
  }, [rows])

  /** Capture every missing thumbnail in one explicit pass (the toolbar action). */
  const captureAll = useCallback(async () => {
    if (scope === undefined) return
    setBusy(true)
    try {
      for (const row of rows) {
        if (row.thumb) continue
        try {
          const payload = await thumbPayloadOf(scope, row)
          if (payload === undefined) continue
          await api.mediaThumbSave(row.id, payload)
          markStored(row.id)
        } catch {
          // One unreadable original must not stop the batch.
        }
      }
    } finally {
      setBusy(false)
    }
  }, [scope, rows, markStored])

  /** Move the open preview by one row inside the CURRENT filter. */
  const step = useCallback((delta: number) => {
    setOpen((previous) => {
      if (previous === undefined) return previous
      const index = matching.findIndex(row => row.id === previous.id)
      if (index === -1) return previous
      return matching[index + delta] ?? previous
    })
  }, [matching])

  useEffect(() => {
    if (open === undefined) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(undefined)
      if (event.key === 'ArrowLeft') step(-1)
      if (event.key === 'ArrowRight') step(1)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open, step])

  if (scope === undefined) {
    return <div className={css.notice} data-media-viewer="no-session">{t('mediaNoSession')}</div>
  }
  if (state.value === undefined && state.loading) {
    return <div className={css.notice} data-media-viewer="loading">{t('mediaLoading')}</div>
  }
  if (state.error !== undefined) {
    return (
      <div className={css.notice} data-media-viewer="error" data-media-viewer-session={scope.sessionId}>
        <span>{t('mediaLoadFailed', { message: state.error })}</span>
        <Button size="sm" onClick={() => { void load() }}>{t('mediaRetry')}</Button>
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className={css.notice} data-media-viewer="empty" data-media-viewer-session={scope.sessionId}>
        <span>{t('mediaEmpty')}</span>
        <span className={css.noticeHint}>{t('mediaEmptyHint')}</span>
      </div>
    )
  }

  return (
    <div className={css.page} data-media-viewer="rows" data-media-viewer-session={scope.sessionId}>
      <div className={css.toolbar}>
        <div className={css.filters}>
          <FilterChip
            active={kind === 'all'}
            label={t('mediaFilterAll')}
            count={rows.length}
            onClick={() => { setKind('all'); setBatches(1) }}
          />
          {KINDS.map(candidate => (counts.table.get(candidate) ?? 0) === 0 ? null : (
            <FilterChip
              key={candidate}
              active={kind === candidate}
              label={kindLabel(candidate)}
              count={counts.table.get(candidate) ?? 0}
              onClick={() => { setKind(candidate); setBatches(1) }}
            />
          ))}
          <FilterChip
            active={onlyMissing}
            label={t('mediaFilterMissing')}
            count={counts.missing}
            onClick={() => { setOnlyMissing(previous => !previous); setBatches(1) }}
          />
        </div>
        <div className={css.actions}>
          {capture.pending > 0 && (
            <span className={css.captureHint} title={t('mediaCapturePendingHint')}>
              {t('mediaCapturePending', { n: capture.pending })}
            </span>
          )}
          <Button
            size="sm"
            onClick={() => { void captureAll() }}
            disabled={busy || capture.running || counts.missing === 0}
            title={t('mediaCaptureAllHint')}
          >
            {t('mediaCaptureAll')}
          </Button>
          <Button size="sm" onClick={() => { void load() }} title={t('mediaRefreshHint')} icon={<IconRefreshOutlineRegular size={14} />}>
            {''}
          </Button>
        </div>
      </div>

      <div className={css.grid}>
        {filtered.map(row => (
          <button
            key={row.id}
            type="button"
            className={css.card}
            data-media-card={row.kind}
            data-media-id={row.id}
            onClick={() => { setOpen(row) }}
            title={row.name ?? row.id}
          >
            <span className={css.cardFrame}>
              {(thumbs[row.id] ?? (row.thumb ? thumbUrlOf(row.id) : undefined)) !== undefined
                ? <img className={css.cardThumb} src={thumbs[row.id] ?? thumbUrlOf(row.id)} alt="" loading="lazy" />
                : (
                    <span className={css.cardPlaceholder}>
                      {row.kind === 'image'
                        ? <VscFileMedia size={22} />
                        : row.kind === 'video'
                          ? <VscDeviceCameraVideo size={22} />
                          : row.kind === 'audio'
                            ? <VscMusic size={22} />
                            : <span className={css.cardExt}>{extensionOf(row)}</span>}
                    </span>
                  )}
            </span>
            <span className={css.cardMeta}>
              <span className={css.cardName}>{row.name ?? leafOf(row.id)}</span>
              <span className={css.cardLine}>
                <StateDot state={row.original ? 'done' : 'error'} />
                <span>{row.original ? sourceLabel(row.source) : t('mediaOriginalGone')}</span>
              </span>
            </span>
          </button>
        ))}
      </div>

      {filtered.length < matching.length && (
        <div className={css.more}>
          <Button size="sm" onClick={() => { setBatches(previous => previous + 1) }}>{t('mediaLoadMore')}</Button>
        </div>
      )}

      {open !== undefined && (
        <div className={css.overlay} role="dialog" aria-label={t('mediaViewer')} data-media-preview={open.kind}>
          <div className={css.overlayBar}>
            <span className={css.overlayTitle}>{open.name ?? leafOf(open.id)}</span>
            <span className={css.overlayMeta}>
              {sourceLabel(open.source)}
              {open.bytes !== undefined && ` · ${formatBytes(open.bytes)}`}
              {open.width !== undefined && open.height !== undefined && ` · ${open.width}×${open.height}`}
            </span>
            <span className={css.overlayActions}>
              <button type="button" className={css.overlayButton} aria-label={t('mediaPrev')} title={t('mediaPrev')} onClick={() => { step(-1) }}>
                <IconChevronLeftOutlineRegular size={14} />
              </button>
              <button type="button" className={css.overlayButton} aria-label={t('mediaNext')} title={t('mediaNext')} onClick={() => { step(1) }}>
                <IconChevronRightOutlineRegular size={14} />
              </button>
              {open.original && (
                <a
                  className={css.overlayButton}
                  href={open.path !== undefined ? downloadUrl(scope, open.path) : originalUrlOf(scope, open, true)}
                  download
                  aria-label={t('download')}
                  title={t('download')}
                >
                  <IconDownloadOutlineRegular size={14} />
                </a>
              )}
              <button type="button" className={css.overlayButton} aria-label={t('close')} title={t('close')} onClick={() => { setOpen(undefined) }}>
                <IconCloseOutlineRegular size={14} />
              </button>
            </span>
          </div>
          <div className={css.overlayBody}>
            {!open.original
              ? (
                  <div className={css.overlayNotice}>
                    <span>{t('mediaOriginalGone')}</span>
                    {open.thumb && <img className={css.overlayThumbOnly} src={thumbUrlOf(open.id)} alt={open.name ?? ''} />}
                    {open.thumb && <span className={css.noticeHint}>{t('mediaThumbOnlyHint')}</span>}
                  </div>
                )
              : open.kind === 'video'
                ? <video key={open.id} className={css.overlayVideo} src={originalUrlOf(scope, open)} controls autoPlay playsInline />
                : open.kind === 'audio'
                  ? <audio key={open.id} className={css.overlayAudio} src={originalUrlOf(scope, open)} controls autoPlay />
                  : open.kind === 'image'
                    ? <img key={open.id} className={css.overlayImage} src={originalUrlOf(scope, open)} alt={open.name ?? ''} />
                    : (
                        <div className={css.overlayNotice}>
                          <span>{t('mediaUnsupportedInline')}</span>
                          <a className={css.overlayLink} href={originalUrlOf(scope, open)} target="_blank" rel="noreferrer">
                            {t('mediaOpenInTab')}
                          </a>
                        </div>
                      )}
          </div>
        </div>
      )}
    </div>
  )
}

/** One filter chip. */
function FilterChip(props: { active: boolean; label: string; count: number; onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      className={css.chip}
      data-active={props.active ? 'true' : undefined}
      aria-pressed={props.active}
      onClick={props.onClick}
    >
      <span>{props.label}</span>
      <span className={css.chipCount}>{props.count}</span>
    </button>
  )
}

/** The extension tag a document card prints, upper-cased. */
function extensionOf(row: MediaListRow): string {
  const match = /\.([A-Za-z0-9]+)$/u.exec(row.name ?? row.path ?? row.id)
  return (match?.[1] ?? 'FILE').toUpperCase().slice(0, 4)
}

/** A byte count in the reader's units. */
function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
}
