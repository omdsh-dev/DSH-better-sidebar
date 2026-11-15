/**
 * The built-in raster image viewer: continuous pixel-accurate zoom, pan, and
 * three measurement tools (distance, single-axis distance, covered area).
 *
 * Why this owns images again: DSH's `ui-sidebar-documentpreview` renders
 * images but cannot name a pixel boundary or say how many pixels a line spans.
 * The plugin's own viewer keeps the bitmap at its natural size and applies ONE
 * `translate(tx,ty) scale(s)` transform, so 100% is exactly one image pixel per
 * CSS pixel, and `image-rendering: pixelated` keeps every magnified pixel a
 * whole device-pixel block (no interpolation, no invented pixels).
 *
 * Measurement semantics follow Photoshop's edge coordinates and the reader's
 * request: the two boundary lines snap to pixel borders, and the length is the
 * number of pixels between them (both end pixels included). A 5 px tall image
 * measured from its top border (0) to its bottom border (5) reads 5 px and its
 * endpoint labels are rows 0 and 4. See `image-view.ts` for the model.
 *
 * The geometry SVG lives INSIDE the bitmap's scaled container. That is not a
 * detail: drawing the lines in a separate screen-space SVG used to leave them a
 * fraction of a pixel off the bitmap's pixel borders at fractional zoom
 * (1756.2% was visibly off; 3200% was on). Sharing one transform makes the
 * measurement and the pixel it names move as one object at every zoom.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  SyntheticEvent,
} from 'react'
import {
  IconPlusOutlineRegular,
  IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { downloadUrl } from '../api.ts'
import {
  IconEraseOutline16,
  IconFitWindowOutline16,
  IconHandOutline16,
  IconMeasureAreaOutline16,
  IconMeasureAxisOutline16,
  IconMeasureLineOutline16,
  IconMinusOutline16,
} from '../icons.tsx'
import {
  PIXEL_GRID_MIN_SCALE,
  autoScrollDelta,
  clampTransform,
  constrainAxis,
  coveredRect,
  distanceOf,
  distanceToRectBorder,
  distanceToSegment,
  edgeToStage,
  endpointPixel,
  fitTransform,
  formatZoom,
  pixelUnderStage,
  quantizeZoom,
  snapToEdge,
  stageToEdge,
  zoomAt,
  type EdgePoint,
  type ImageSize,
  type PixelPoint,
  type StagePoint,
  type StageSize,
  type ViewTransform,
} from '../image-view.ts'
import { t } from '../locales.ts'
import type { FileViewerProps } from '../service.ts'
import css from '../sidebar.module.css'

/** One measurement kind: a free line, an axis-locked line, or their rectangle. */
type MeasureTool = 'distance' | 'axis' | 'rect'

/** The active input mode of the stage. */
type Tool = 'pan' | 'erase' | MeasureTool

/** One committed measurement, in snapped image edge coordinates. */
interface Annotation {
  id: number
  kind: MeasureTool
  a: EdgePoint
  b: EdgePoint
}

/** The measurement being dragged (not yet committed). */
type Draft = Omit<Annotation, 'id'>

/** One in-flight pointer gesture. */
type Interaction =
  | {
    mode: 'pan'
    pointerId: number
    start: StagePoint
    view: ViewTransform
    /** Which physical button started the gesture (right = temporary pan). */
    button: 'left' | 'middle' | 'right'
    /** Whether a right-button gesture has passed the drag threshold. */
    moved: boolean
  }
  | {
    mode: 'measure'
    pointerId: number
    kind: MeasureTool
    a: EdgePoint
    b: EdgePoint
  }

/** One in-flight measuring gesture (auto-scroll re-targets its end point). */
type MeasureInteraction = Extract<Interaction, { mode: 'measure' }>

/** How far a label sits from the geometry it annotates, in CSS px. */
const LABEL_GAP = 24

/** How far a right-button drag must travel before it is a pan, not a menu click. */
const RIGHT_DRAG_THRESHOLD = 4

/** How close a click must land to a measurement before the eraser targets it. */
const ERASE_HIT_RADIUS = 8

/** The hovered measurement under the eraser, drawn this thick (CSS px). */
const ERASE_HIGHLIGHT_STROKE = 6

/** How much one wheel notch multiplies the scale (trackpad events are finer). */
const WHEEL_ZOOM_RATE = 0.0015

/** Which part of a label sits on its anchor point. */
type LabelAnchor = 'center' | 'top-left' | 'top-right' | 'bottom-right' | 'top-center' | 'right-center' | 'left-center'

/** The CSS transform that anchors a label without a background box. */
const ANCHOR_TRANSFORM: Record<LabelAnchor, string> = {
  center: 'translate(-50%, -50%)',
  'top-left': 'translate(calc(-100% - 6px), calc(-100% - 6px))',
  'top-right': 'translate(6px, calc(-100% - 6px))',
  'bottom-right': 'translate(6px, 6px)',
  'top-center': 'translate(-50%, calc(-100% - 6px))',
  'right-center': 'translate(6px, -50%)',
  // The label's right edge sits just outside the anchor: the unit suffix stays
  // next to the line while a long number grows away from it.
  'left-center': 'translate(calc(-100% - 6px), -50%)',
}

/** The host's shared menu service (structurally typed: the plugin must not
 *  depend on the host package, and an older host simply has no such service). */
interface ImageContextMenus {
  open: (
    target: {
      kind: 'image'
      value: { sessionId: string; path: string; url: string; name: string; mediaType: string }
    },
    point: { x: number; y: number },
  ) => void
  close?: () => void
}

/** The media type the host menu needs for one raster extension. */
function imageMediaType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'bmp': return 'image/bmp'
    case 'ico': return 'image/x-icon'
    default: return 'image/png'
  }
}

/** Render a measured length without trailing zeroes. */
function formatLength(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/** One measurement label: bare red text, placed by its anchor. */
function MeasureLabel(props: {
  left: number
  top: number
  text: string
  kind: 'point' | 'result'
  anchor?: LabelAnchor
}): ReactNode {
  return (
    <div
      className={props.kind === 'point' ? `${css.imageLabel} ${css.imageLabelPoint}` : `${css.imageLabel} ${css.imageLabelResult}`}
      data-image-label={props.kind}
      style={{ left: props.left, top: props.top, transform: ANCHOR_TRANSFORM[props.anchor ?? 'center'] }}
    >
      {props.text}
    </div>
  )
}

/**
 * The stage's screen size. Read from the DOM on demand: the viewer only needs
 * it when the reader zooms or pans, so a ResizeObserver-driven state store
 * would re-render for sizes nobody is using.
 */
function stageSizeOf(stage: HTMLDivElement | null): StageSize {
  if (stage === null) return { width: 0, height: 0 }
  const rect = stage.getBoundingClientRect()
  return { width: rect.width, height: rect.height }
}

export function ImagePreview(props: FileViewerProps): ReactNode {
  // A new file in the same tab must be a fresh viewer instance: measurements
  // name pixels of the old document, and a cached bitmap can fire `load`
  // before any effect-based reset would run. Keying the document body makes
  // the reset structural instead of a race.
  return (
    <ImagePreviewDocument
      key={`${props.scope.sessionId}\u0000${props.path}\u0000${props.mediaUrl ?? ''}`}
      {...props}
    />
  )
}

function ImagePreviewDocument(props: FileViewerProps): ReactNode {
  const { scope, path, title, mediaUrl } = props
  /** The host's shared menu service, when this host provides it. */
  const menus = (props.ctx as { get?: (id: string) => unknown }).get?.('contextMenus') as ImageContextMenus | undefined

  /** The decoded image size; `null` until the bitmap reports it. */
  const [image, setImage] = useState<ImageSize | null>(null)
  /** Zoom + pan. Always clamped to the current stage by the setters below. */
  const [view, setView] = useState<ViewTransform>({ scale: 1, tx: 0, ty: 0 })
  const [tool, setTool] = useState<Tool>('distance')
  /** A right-button drag is panning right now (temporary pan). */
  const [rightPanning, setRightPanning] = useState(false)
  /** The measurement under the eraser, so it can be highlighted before a click. */
  const [eraseHover, setEraseHover] = useState<number | null>(null)
  const [annotations, setAnnotations] = useState<readonly Annotation[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  /** The pixel under the pointer, for the status bar. */
  const [hover, setHover] = useState<PixelPoint | null>(null)
  const [failed, setFailed] = useState(false)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<ImageSize | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  /** Whether the view still follows the stage size (the reader has not moved it). */
  const fitRef = useRef(true)
  const interactionRef = useRef<Interaction | null>(null)
  /** A right-button drag happened, so the contextmenu that follows must not open. */
  const suppressMenuRef = useRef(false)
  const nextIdRef = useRef(0)
  /** The pointer's last stage position while a gesture runs (auto-scroll needs it). */
  const gesturePointRef = useRef<StagePoint | null>(null)
  /** The pending animation frame of the auto-scroll loop, when it is running. */
  const autoScrollRef = useRef<number | null>(null)

  /**
   * Commit a clamped view. `fit` records whether the reader owns the view:
   * a fitted image keeps refitting on panel resize, a moved one does not.
   */
  const commitView = useCallback((next: ViewTransform, fitted: boolean): void => {
    const current = imageRef.current
    if (current === null) return
    fitRef.current = fitted
    setView(clampTransform(next, current, stageSizeOf(stageRef.current)))
  }, [])

  /** Fit the whole image, centered, never past 100%. */
  const fitImage = useCallback((): void => {
    const current = imageRef.current
    if (current === null) return
    fitRef.current = true
    setView(fitTransform(current, stageSizeOf(stageRef.current)))
  }, [])

  /** Zoom by `factor` around the stage center (toolbar buttons). */
  const zoomBy = useCallback((factor: number): void => {
    const current = imageRef.current
    if (current === null) return
    const stage = stageSizeOf(stageRef.current)
    const anchor = { x: stage.width / 2, y: stage.height / 2 }
    const scale = quantizeZoom(viewRef.current.scale * factor)
    commitView(zoomAt(viewRef.current, scale, anchor), false)
  }, [commitView])

  /** Jump to 100% around the stage center. */
  const actualSize = useCallback((): void => {
    const stage = stageSizeOf(stageRef.current)
    const anchor = { x: stage.width / 2, y: stage.height / 2 }
    commitView(zoomAt(viewRef.current, 1, anchor), false)
  }, [commitView])

  const onImageLoad = useCallback((event: SyntheticEvent<HTMLImageElement>): void => {
    const width = event.currentTarget.naturalWidth
    const height = event.currentTarget.naturalHeight
    if (width <= 0 || height <= 0) return
    const decoded = { width, height }
    imageRef.current = decoded
    setImage(decoded)
    setFailed(false)
    fitRef.current = true
    setView(fitTransform(decoded, stageSizeOf(stageRef.current)))
  }, [])

  // Refit while the reader has not taken over the view. A parked tab that
  // becomes visible again (or a sidebar resize) must not leave the image
  // hanging off-center.
  useEffect(() => {
    const stage = stageRef.current
    if (stage === null || image === null) return
    const observer = new ResizeObserver(() => {
      const size = stageSizeOf(stage)
      if (fitRef.current) {
        setView(fitTransform(image, size))
        return
      }
      // The reader owns the view, but a shrunken panel must not leave the
      // image panned entirely off-screen.
      setView(previous => clampTransform(previous, image, size))
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [image])

  // Wheel zoom must prevent the page from scrolling, and React's synthetic
  // wheel listener is passive — a native non-passive listener is required.
  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return
    const onWheel = (event: WheelEvent): void => {
      const current = imageRef.current
      if (current === null) return
      event.preventDefault()
      const rect = stage.getBoundingClientRect()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1
      const factor = Math.exp(-event.deltaY * unit * WHEEL_ZOOM_RATE)
      const scale = quantizeZoom(viewRef.current.scale * factor)
      if (scale === viewRef.current.scale) return
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      fitRef.current = false
      setView(clampTransform(
        zoomAt(viewRef.current, scale, anchor),
        current,
        { width: rect.width, height: rect.height },
      ))
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => { stage.removeEventListener('wheel', onWheel) }
  }, [])

  /** One pointer event in stage coordinates. */
  const stagePointOf = (event: ReactPointerEvent<HTMLDivElement>): StagePoint => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  /** Stop the auto-scroll loop. Idempotent, and safe when it never ran. */
  const stopAutoScroll = useCallback((): void => {
    if (autoScrollRef.current !== null) {
      cancelAnimationFrame(autoScrollRef.current)
      autoScrollRef.current = null
    }
  }, [])

  // A viewer that unmounts mid-drag must not leave a frame scheduled.
  useEffect(() => stopAutoScroll, [stopAutoScroll])

  /**
   * Re-target a measuring gesture at one stage point under `view`. Used by both
   * pointer moves and the auto-scroll loop, so scrolling updates the draft with
   * exactly the rules a real pointer move would use (snap, axis lock, hover).
   */
  const measureAt = useCallback((interaction: MeasureInteraction, point: StagePoint, view: ViewTransform): void => {
    const current = imageRef.current
    if (current === null) return
    const snapped = snapToEdge(stageToEdge(view, point), current)
    // The single-axis tool may only draw along the dominant axis.
    const edge = interaction.kind === 'axis' ? constrainAxis(interaction.a, snapped) : snapped
    const pixel = pixelUnderStage(view, point, current)
    setHover(previous => (
      previous?.x === pixel?.x && previous?.y === pixel?.y ? previous : pixel
    ))
    if (edge.x === interaction.b.x && edge.y === interaction.b.y) return
    interaction.b = edge
    setDraft({ kind: interaction.kind, a: interaction.a, b: edge })
  }, [])

  /**
   * One auto-scroll frame: pan toward the pointer's edge, then re-target the
   * draft against the moved view. The pointer itself does not move, so the same
   * edge coordinates keep changing and the line/rectangle keeps growing. The
   * scroll stops at the overscroll boundary (`clampTransform`), which is also
   * why the loop cannot spin forever at an edge where nothing more can move.
   */
  const autoScrollTick = useCallback((): void => {
    autoScrollRef.current = null
    const interaction = interactionRef.current
    const current = imageRef.current
    const stage = stageRef.current
    const point = gesturePointRef.current
    if (interaction === null || interaction.mode !== 'measure' || current === null || stage === null || point === null) {
      return
    }
    const size = stageSizeOf(stage)
    const delta = autoScrollDelta(point, size)
    if (delta.x === 0 && delta.y === 0) return
    const next = clampTransform({
      scale: viewRef.current.scale,
      tx: viewRef.current.tx + delta.x,
      ty: viewRef.current.ty + delta.y,
    }, current, size)
    if (next.tx === viewRef.current.tx && next.ty === viewRef.current.ty) return
    viewRef.current = next
    fitRef.current = false
    setView(next)
    measureAt(interaction, point, next)
    autoScrollRef.current = requestAnimationFrame(autoScrollTick)
  }, [measureAt])

  /** Start auto-scrolling when the pointer is in an edge band, stop it otherwise. */
  const updateAutoScroll = useCallback((point: StagePoint): void => {
    if (autoScrollRef.current !== null) return
    const delta = autoScrollDelta(point, stageSizeOf(stageRef.current))
    if (delta.x === 0 && delta.y === 0) return
    // jsdom has no animation frames; the loop is a browser-only behaviour.
    if (typeof requestAnimationFrame !== 'function') return
    autoScrollRef.current = requestAnimationFrame(autoScrollTick)
  }, [autoScrollTick])

  /**
   * The measurement nearest a stage point, within the eraser's hit radius.
   * Distances are measured in CSS px against the drawn geometry, so the target
   * stays easy to hit at any zoom.
   */
  const eraseTargetAt = (point: StagePoint): number | null => {
    if (image === null) return null
    let target: number | null = null
    let nearest = ERASE_HIT_RADIUS
    for (const annotation of annotations) {
      let distance: number
      if (annotation.kind === 'rect') {
        const rect = coveredRect(annotation.a, annotation.b)
        distance = distanceToRectBorder(
          point,
          edgeToStage(view, { x: rect.left, y: rect.top }),
          edgeToStage(view, { x: rect.right, y: rect.bottom }),
        )
      } else {
        distance = distanceToSegment(
          point,
          edgeToStage(view, annotation.a),
          edgeToStage(view, annotation.b),
        )
      }
      if (distance <= nearest) {
        nearest = distance
        target = annotation.id
      }
    }
    return target
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = imageRef.current
    if (current === null) return
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return
    // A new gesture owns the pointer again: no frame from the old one survives.
    stopAutoScroll()
    gesturePointRef.current = null
    // A fresh gesture starts with no pending menu suppression. A plain right
    // click must always reach the platform menu (desktop hosts put copy /
    // image actions there), so the right button is NOT prevented here.
    suppressMenuRef.current = false
    if (event.button === 2) {
      event.currentTarget.setPointerCapture?.(event.pointerId)
      interactionRef.current = {
        mode: 'pan',
        pointerId: event.pointerId,
        start: stagePointOf(event),
        view: viewRef.current,
        button: 'right',
        moved: false,
      }
      return
    }
    if (event.button === 1) {
      // The middle button always pans, whatever tool is selected.
      event.preventDefault()
      event.currentTarget.setPointerCapture?.(event.pointerId)
      interactionRef.current = {
        mode: 'pan',
        pointerId: event.pointerId,
        start: stagePointOf(event),
        view: viewRef.current,
        button: 'middle',
        moved: true,
      }
      return
    }
    if (tool === 'erase') {
      // The eraser reacts to a left click only.
      event.preventDefault()
      const target = eraseTargetAt(stagePointOf(event))
      if (target !== null) {
        setAnnotations(previous => previous.filter(annotation => annotation.id !== target))
        setEraseHover(null)
      }
      return
    }
    event.preventDefault()
    // The left button pans with the hand tool and measures with any other.
    const measureTool: MeasureTool | null = tool === 'pan' ? null : tool
    if (measureTool === null) {
      event.currentTarget.setPointerCapture?.(event.pointerId)
      interactionRef.current = {
        mode: 'pan',
        pointerId: event.pointerId,
        start: stagePointOf(event),
        view: viewRef.current,
        button: 'left',
        moved: true,
      }
      return
    }
    const point = stagePointOf(event)
    const edge = stageToEdge(viewRef.current, point)
    // A measurement starts on the image, not on the padding around it; once
    // started, dragging outside snaps to the nearest border. The overscroll
    // blank is padding too, so it cannot be a start point either.
    if (edge.x < 0 || edge.y < 0 || edge.x > current.width || edge.y > current.height) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const snapped = snapToEdge(edge, current)
    interactionRef.current = { mode: 'measure', pointerId: event.pointerId, kind: measureTool, a: snapped, b: snapped }
    gesturePointRef.current = point
    setDraft({ kind: measureTool, a: snapped, b: snapped })
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = imageRef.current
    if (current === null) return
    const point = stagePointOf(event)
    const interaction = interactionRef.current
    if (interaction === null) {
      const pixel = pixelUnderStage(viewRef.current, point, current)
      setHover(previous => (
        previous?.x === pixel?.x && previous?.y === pixel?.y ? previous : pixel
      ))
      setEraseHover(tool === 'erase' ? eraseTargetAt(point) : null)
      return
    }
    if (interaction.pointerId !== event.pointerId) return
    if (interaction.mode === 'pan') {
      if (interaction.button === 'right' && !interaction.moved) {
        // Below the threshold this is still a "right click": leave the view
        // alone so the menu action never nudges the picture.
        const travel = Math.hypot(point.x - interaction.start.x, point.y - interaction.start.y)
        if (travel < RIGHT_DRAG_THRESHOLD) return
        interaction.moved = true
        suppressMenuRef.current = true
        setRightPanning(true)
        // A right-drag is a pan, not a menu gesture: dismiss a menu left open
        // by an earlier right click (the host ignores right-button downs).
        menus?.close?.()
      }
      commitView({
        scale: interaction.view.scale,
        tx: interaction.view.tx + (point.x - interaction.start.x),
        ty: interaction.view.ty + (point.y - interaction.start.y),
      }, false)
      return
    }
    gesturePointRef.current = point
    measureAt(interaction, point, viewRef.current)
    // Near a stage edge the view keeps scrolling; the draft follows it.
    updateAutoScroll(point)
  }

  /** End a gesture; `commit` turns a measurement into a persistent annotation. */
  const endInteraction = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean): void => {
    const interaction = interactionRef.current
    if (interaction === null || interaction.pointerId !== event.pointerId) return
    interactionRef.current = null
    stopAutoScroll()
    gesturePointRef.current = null
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    } catch {
      // jsdom/stale capture: releasing is best-effort.
    }
    if (interaction.mode === 'pan') {
      setRightPanning(false)
      return
    }
    setDraft(null)
    if (!commit) return
    if (interaction.a.x === interaction.b.x && interaction.a.y === interaction.b.y) return
    const id = nextIdRef.current + 1
    nextIdRef.current = id
    setAnnotations(previous => [...previous, {
      id,
      kind: interaction.kind,
      a: interaction.a,
      b: interaction.b,
    }])
  }

  /**
   * A right-drag pan suppresses the menu for its gesture. A plain right click
   * opens the host's shared image menu (copy image / download / save as /
   * reveal), exactly as the host's own preview would: the viewer supplies the
   * captured image target and the host resolves the actions.
   */
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (suppressMenuRef.current) {
      event.preventDefault()
      suppressMenuRef.current = false
      return
    }
    if (menus === undefined || mediaUrl === undefined) return
    event.preventDefault()
    menus.open({
      kind: 'image',
      value: {
        sessionId: scope.sessionId,
        path,
        url: mediaUrl,
        name: title,
        mediaType: imageMediaType(path),
      },
    }, { x: event.clientX, y: event.clientY })
  }

  const onPointerLeave = (): void => {
    if (interactionRef.current === null) {
      setHover(null)
      setEraseHover(null)
    }
  }

  /** The zoom buttons and tools are inert until the bitmap reports a size. */
  const ready = image !== null && !failed
  const zoomLabel = formatZoom(view.scale)
  const displayWidth = image === null ? 0 : image.width * view.scale
  const displayHeight = image === null ? 0 : image.height * view.scale

  /**
   * Draw one measurement (committed or draft). The SVG geometry is in IMAGE
   * edge coordinates and is rendered inside the bitmap's scaled container, so
   * a line can never drift off the pixel border it names. The labels are
   * screen-space text (they must not grow with the zoom) and are positioned
   * from the same edge→stage mapping.
   */
  const renderMeasurement = (measurement: Draft, key: number, isDraft: boolean, highlighted = false): {
    key: number
    shapes: ReactNode
    labels: ReactNode[]
  } | null => {
    const { a, b, kind } = measurement
    if (image === null) return null
    const start = edgeToStage(view, a)
    const end = edgeToStage(view, b)
    const startPixel = endpointPixel(a, b, image)
    const endPixel = endpointPixel(b, a, image)
    const lineClass = isDraft ? css.imageDraftLine : css.imageLine
    const labels: ReactNode[] = []
    const shapes: ReactNode[] = []

    if (kind === 'distance' || kind === 'axis') {
      const distance = distanceOf(a, b)
      // A tick is exactly one image pixel long: half a pixel on each side of
      // the measured border. Its direction is the line's normal, so an
      // axis-locked line gets a perpendicular tick for free.
      const iux = distance.length === 0 ? 1 : distance.dx / distance.length
      const iuy = distance.length === 0 ? 0 : distance.dy / distance.length
      const inx = -iuy
      const iny = iux
      const screenSpan = Math.hypot(end.x - start.x, end.y - start.y)
      const sux = screenSpan === 0 ? 1 : (end.x - start.x) / screenSpan
      const suy = screenSpan === 0 ? 0 : (end.y - start.y) / screenSpan
      // Put the value on the line's left / upper side, then right-align it to
      // the anchor: `px` stays outside the line and a long number grows away
      // from it instead of crossing the line.
      let snx = -suy
      let sny = sux
      if (snx > 0 || (snx === 0 && sny > 0)) {
        snx = -snx
        sny = -sny
      }
      shapes.push(
        <g
          key={`shape-${key}`}
          strokeWidth={highlighted ? ERASE_HIGHLIGHT_STROKE / view.scale : undefined}
          strokeDasharray={isDraft ? `${4 / view.scale} ${3 / view.scale}` : undefined}
        >
          <line className={lineClass} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
          <line
            className={lineClass}
            x1={a.x - inx * 0.5} y1={a.y - iny * 0.5}
            x2={a.x + inx * 0.5} y2={a.y + iny * 0.5}
          />
          <line
            className={lineClass}
            x1={b.x - inx * 0.5} y1={b.y - iny * 0.5}
            x2={b.x + inx * 0.5} y2={b.y + iny * 0.5}
          />
        </g>,
      )
      // On a horizontal measurement the endpoint labels sit above the line
      // (upper-left / upper-right) so they never cover the line or its dots.
      const horizontal = Math.abs(sux) >= Math.abs(suy)
      labels.push(
        <MeasureLabel
          key={`result-${key}`}
          kind="result"
          anchor={horizontal ? 'top-center' : 'left-center'}
          left={(start.x + end.x) / 2 + snx * LABEL_GAP}
          top={(start.y + end.y) / 2 + sny * LABEL_GAP}
          text={`${formatLength(distance.length)} px`}
        />,
        <MeasureLabel
          key={`start-${key}`}
          kind="point"
          anchor={horizontal ? 'top-left' : 'center'}
          left={horizontal ? start.x : start.x - sux * LABEL_GAP}
          top={horizontal ? start.y : start.y - suy * LABEL_GAP}
          text={`(${startPixel.x},${startPixel.y})`}
        />,
        <MeasureLabel
          key={`end-${key}`}
          kind="point"
          anchor={horizontal ? 'top-right' : 'center'}
          left={horizontal ? end.x : end.x + sux * LABEL_GAP}
          top={horizontal ? end.y : end.y + suy * LABEL_GAP}
          text={`(${endPixel.x},${endPixel.y})`}
        />,
      )
      return { key, shapes: <>{shapes}</>, labels }
    }

    const rect = coveredRect(a, b)
    if (rect.width <= 0 || rect.height <= 0) return null
    const topLeft = edgeToStage(view, { x: rect.left, y: rect.top })
    const bottomRight = edgeToStage(view, { x: rect.right, y: rect.bottom })
    const middleX = (topLeft.x + bottomRight.x) / 2
    const middleY = (topLeft.y + bottomRight.y) / 2
    shapes.push(
      <rect
        key={`rect-${key}`}
        className={isDraft ? css.imageDraftRect : css.imageRect}
        x={rect.left}
        y={rect.top}
        width={rect.width}
        height={rect.height}
        strokeWidth={highlighted ? ERASE_HIGHLIGHT_STROKE / view.scale : undefined}
        strokeDasharray={isDraft ? `${4 / view.scale} ${3 / view.scale}` : undefined}
      />,
    )
    labels.push(
      <MeasureLabel
        key={`width-${key}`}
        kind="result"
        anchor="top-center"
        left={middleX}
        top={topLeft.y}
        text={`${rect.width} px`}
      />,
      <MeasureLabel
        key={`height-${key}`}
        kind="result"
        anchor="right-center"
        left={bottomRight.x}
        top={middleY}
        text={`${rect.height} px`}
      />,
      <MeasureLabel
        key={`tl-${key}`}
        kind="point"
        anchor="top-left"
        left={topLeft.x}
        top={topLeft.y}
        text={`(${rect.left},${rect.top})`}
      />,
      <MeasureLabel
        key={`br-${key}`}
        kind="point"
        anchor="bottom-right"
        left={bottomRight.x}
        top={bottomRight.y}
        text={`(${rect.right - 1},${rect.bottom - 1})`}
      />,
    )
    return { key, shapes: <>{shapes}</>, labels }
  }

  const rendered = [
    ...annotations.map(annotation => renderMeasurement(
      annotation,
      annotation.id,
      false,
      tool === 'erase' && eraseHover === annotation.id,
    )),
    ...(draft === null ? [] : [renderMeasurement(draft, -1, true)]),
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== null)

  const geometry = image === null
    ? null
    : (
        <svg
          className={css.imageGeometry}
          viewBox={`0 0 ${image.width} ${image.height}`}
          preserveAspectRatio="none"
          shapeRendering="crispEdges"
          // The geometry is a child of the bitmap's HTML transform. A screen
          // pixel is therefore `1 / scale` user units; compensating here keeps
          // the line 3 CSS px at every zoom (the calibration ticks stay one
          // IMAGE pixel long on purpose).
          strokeWidth={3 / view.scale}
          aria-hidden="true"
        >
          {rendered.map(entry => <g key={entry.key}>{entry.shapes}</g>)}
        </svg>
      )

  return (
    <div className={css.imageViewer}>
      <div className={css.imageToolbar}>
        <button
          type="button"
          className={css.imageToolButton}
          title={t('mermaidZoomOut')}
          aria-label={t('mermaidZoomOut')}
          disabled={!ready}
          onClick={() => { zoomBy(1 / 1.25) }}
        >
          <IconMinusOutline16 size={14} />
        </button>
        <button
          type="button"
          className={`${css.imageToolButton} ${css.imageZoomValue}`}
          title={t('imageActualSize')}
          aria-label={t('imageActualSize')}
          disabled={!ready}
          onClick={actualSize}
        >
          {zoomLabel}
        </button>
        <button
          type="button"
          className={css.imageToolButton}
          title={t('mermaidZoomIn')}
          aria-label={t('mermaidZoomIn')}
          disabled={!ready}
          onClick={() => { zoomBy(1.25) }}
        >
          <IconPlusOutlineRegular size={14} />
        </button>
        <button
          type="button"
          className={css.imageToolButton}
          title={t('imageFit')}
          aria-label={t('imageFit')}
          disabled={!ready}
          onClick={fitImage}
        >
          <IconFitWindowOutline16 size={14} />
        </button>
        <span className={css.imageToolbarDivider} aria-hidden="true" />
        <button
          type="button"
          className={css.imageToolButton}
          title={t('imageToolPan')}
          aria-label={t('imageToolPan')}
          aria-pressed={tool === 'pan' || rightPanning}
          disabled={!ready}
          onClick={() => { setTool('pan') }}
        >
          <IconHandOutline16 size={14} />
        </button>
        <button
          type="button"
          className={css.imageToolButton}
          title={t('imageToolAxis')}
          aria-label={t('imageToolAxis')}
          aria-pressed={tool === 'axis' && !rightPanning}
          disabled={!ready}
          onClick={() => { setTool('axis') }}
        >
          <IconMeasureAxisOutline16 size={14} />
        </button>
        <button
          type="button"
          className={css.imageToolButton}
          title={t('imageToolDistance')}
          aria-label={t('imageToolDistance')}
          aria-pressed={tool === 'distance' && !rightPanning}
          disabled={!ready}
          onClick={() => { setTool('distance') }}
        >
          <IconMeasureLineOutline16 size={14} />
        </button>
        <button
          type="button"
          className={css.imageToolButton}
          title={t('imageToolRect')}
          aria-label={t('imageToolRect')}
          aria-pressed={tool === 'rect' && !rightPanning}
          disabled={!ready}
          onClick={() => { setTool('rect') }}
        >
          <IconMeasureAreaOutline16 size={14} />
        </button>
        <button
          type="button"
          className={css.imageToolButton}
          title={t('imageToolErase')}
          aria-label={t('imageToolErase')}
          aria-pressed={tool === 'erase'}
          disabled={!ready}
          onClick={() => { setTool('erase'); setEraseHover(null) }}
        >
          <IconEraseOutline16 size={14} />
        </button>
        <span className={css.imageToolbarSpacer} aria-hidden="true" />
        <button
          type="button"
          className={css.imageToolButton}
          title={t('imageClearMeasurements')}
          aria-label={t('imageClearMeasurements')}
          disabled={annotations.length === 0}
          onClick={() => { setAnnotations([]) }}
        >
          <IconTrashOutlineRegular size={14} />
        </button>
      </div>
      <div
        ref={stageRef}
        className={css.imageStage}
        data-tool={tool}
        data-panning={rightPanning ? 'true' : undefined}
        data-erase-hover={eraseHover !== null ? 'true' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => { endInteraction(event, true) }}
        onPointerCancel={(event) => { endInteraction(event, false) }}
        onPointerLeave={onPointerLeave}
        onContextMenu={onContextMenu}
      >
        {image !== null && (
          <div
            className={css.imageFrame}
            style={{ left: view.tx, top: view.ty, width: displayWidth, height: displayHeight }}
          />
        )}
        <div
          className={css.imageCanvas}
          style={{
            width: image?.width ?? 1,
            height: image?.height ?? 1,
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
          }}
        >
          {mediaUrl !== undefined && !failed && (
            <img
              className={css.imageBitmap}
              src={mediaUrl}
              alt={title}
              draggable={false}
              style={{
                opacity: image === null ? 0 : 1,
                imageRendering: view.scale >= 1 ? 'pixelated' : 'auto',
              }}
              onLoad={onImageLoad}
              onError={() => {
                imageRef.current = null
                setImage(null)
                setFailed(true)
              }}
              onDragStart={event => { event.preventDefault() }}
            />
          )}
          {geometry}
        </div>
        {image !== null && view.scale >= PIXEL_GRID_MIN_SCALE && (
          <div
            className={css.imageGrid}
            data-image-grid=""
            style={{
              left: view.tx,
              top: view.ty,
              width: displayWidth,
              height: displayHeight,
              backgroundSize: `${view.scale}px ${view.scale}px`,
            } as CSSProperties}
          />
        )}
        {image !== null && (
          <div className={css.imageLabels}>
            {rendered.flatMap(entry => entry.labels)}
          </div>
        )}
        {!failed && mediaUrl !== undefined && image === null && (
          <div className={css.imageNotice}>{t('loading')}</div>
        )}
        {(failed || mediaUrl === undefined) && (
          <div className={css.imageNotice}>
            <div>{t('imageLoadFailed')}</div>
            <a className={css.editorDownloadLink} href={downloadUrl(scope, path)} download>{t('download')}</a>
          </div>
        )}
      </div>
      <div className={css.imageStatus}>
        <span>{image === null ? '' : `${image.width} × ${image.height} px`}</span>
        <span className={css.imageStatusHint}>
          {annotations.length === 0 && draft === null ? t('imageHint') : ''}
        </span>
        <span>{ready ? zoomLabel : ''}</span>
        <span>{hover === null ? '' : `${hover.x}, ${hover.y}`}</span>
      </div>
    </div>
  )
}
