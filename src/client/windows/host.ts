/**
 * State owner of the unified window host.
 *
 * The store is deliberately UI-free: one record per stable window identity
 * (`id`), geometry, maximize/restore memory, dirty/saving flags, the mounted
 * navigation page stack and a cached immutable snapshot the React host reads
 * through `useSyncExternalStore`. Public callers get a generation-bound
 * handle, so a handle whose window already closed can never mutate a later
 * window that happens to reuse the id.
 *
 * The rules the contract pins here:
 * - opening an id that is already open FOCUSES it and returns its handle —
 *   never a second window, never a replaced draft;
 * - `update` only changes the fields it names: a streamed refresh cannot move
 *   or resize a window the reader placed;
 * - a close runs `onBeforeClose` first (async allowed); false/rejection keeps
 *   the window and its content alive;
 * - the close/unmount path releases the layer subscription, so no listener
 *   outlives the plugin activation.
 */
import {
  clampWindowBox, initialWindowBox, maximizedWindowBox, placeWindowBox, resizeWindowBox,
  type ViewportSize, type WindowBox, type WindowSize,
} from './geometry.ts'
import { raiseWindowLayer } from './layer.ts'
import type {
  WindowContent, WindowDocumentContent, WindowHandle, WindowHostController, WindowHostOptions,
  WindowHostSnapshot, WindowNavigation, WindowOpenOptions, WindowPage, WindowPageView, WindowSizePreset,
  WindowUpdate, WindowView,
} from './types.ts'

/** Whether one content value is a structured document descriptor. */
export function isWindowDocumentContent(content: WindowContent): content is WindowDocumentContent {
  return typeof content === 'object'
    && content !== null
    && !Array.isArray(content)
    && (content as { kind?: unknown }).kind === 'document'
}

/** The layer key prefix the public host uses (legacy windows carry none). */
const LAYER_PREFIX = 'window-host:'

/** The unified-layer identity of one public window. */
export function windowHostLayerKey(id: string): string {
  return `${LAYER_PREFIX}${id}`
}
/**
 * Navigation is a bounded in-surface stack, not an unbounded history: at most
 * 20 pages may stack ABOVE the base page (depth 21).
 */
const MAX_WINDOW_PAGES = 20
/** Guard against pathological hosts that report no viewport at all. */
const FALLBACK_VIEWPORT: ViewportSize = { width: 1_280, height: 800 }

interface PageEntry {
  readonly key: string
  readonly page: WindowPage
}

interface WindowRecord {
  readonly id: string
  /** The window's own (base) title; a pushed page may override it while on top. */
  title: string
  /** The base page: open options and later `update` patches land here. */
  base: WindowPage
  /** Pushed pages, bottom → top. The base page is NOT in this array. */
  pages: PageEntry[]
  size: WindowSizePreset
  minSize: WindowSize
  box: WindowBox
  /** Geometry to restore after maximize/restore. */
  restoreBox: WindowBox | undefined
  maximized: boolean
  dirty: boolean
  saving: boolean
  onBeforeClose: (() => boolean | Promise<boolean>) | undefined
  onClose: (() => void) | undefined
  handle: WindowHandle | undefined
  /** One in-flight draft guard per window (double Escape must not run it twice). */
  pendingClose: Promise<boolean> | undefined
  /** The element focused when the window opened, restored when it closes. */
  opener: HTMLElement | undefined
}

/** One finite, positive viewport dimension (a broken host must not leak NaN into geometry). */
function dimensionOf(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
}

/** Sanitize an untrusted viewport (window metrics or an injected test seam). */
function sanitizeViewport(viewport: ViewportSize): ViewportSize {
  return {
    width: dimensionOf(viewport.width, FALLBACK_VIEWPORT.width),
    height: dimensionOf(viewport.height, FALLBACK_VIEWPORT.height),
  }
}

function defaultViewport(): ViewportSize {
  if (typeof window === 'undefined') return FALLBACK_VIEWPORT
  return sanitizeViewport({
    width: window.innerWidth,
    height: window.innerHeight,
  })
}

function sameBox(a: WindowBox, b: WindowBox): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
}

/** The element to give focus back to once a window closes. */
function activeOpener(): HTMLElement | undefined {
  if (typeof document === 'undefined') return undefined
  const active = document.activeElement
  return active instanceof HTMLElement ? active : undefined
}

/**
 * Create one window host. Constructed once per client plugin activation by
 * {@link ../service.ts}; mounted exactly once by the client half.
 */
export function createWindowHost(options: WindowHostOptions = {}): WindowHostController {
  const viewportOf = options.viewport ?? defaultViewport
  let records: WindowRecord[] = []
  let cached: WindowHostSnapshot = { windows: [] }
  let lastViewport: ViewportSize | undefined
  let pageSequence = 0
  const listeners = new Set<() => void>()

  const viewport = (): ViewportSize => lastViewport ?? sanitizeViewport(viewportOf())

  const currentRecord = (id: string): WindowRecord | undefined =>
    records.find(record => record.id === id)

  const layerKey = windowHostLayerKey

  function retire(record: WindowRecord): void {
    if (currentRecord(record.id) !== record) return
    records = records.filter(candidate => candidate !== record)
    notify()
    const opener = record.opener
    if (opener !== undefined && opener.isConnected && typeof opener.focus === 'function') {
      opener.focus()
    }
    if (record.onClose !== undefined) {
      try {
        record.onClose()
      } catch (error) {
        console.error(`[dsh-better-sidebar] window "${record.id}" onClose error:`, error)
      }
    }
  }

  function notify(): void {
    cached = { windows: records.map(viewOf) }
    for (const listener of [...listeners]) listener()
  }

  function viewOf(record: WindowRecord): WindowView {
    const pages: WindowPageView[] = [
      { key: 'base', page: record.base, active: record.pages.length === 0 },
      ...record.pages.map((entry, index) => ({
        key: entry.key,
        page: entry.page,
        active: index === record.pages.length - 1,
      })),
    ]
    const activeIndex = pages.length - 1
    const active = pages[activeIndex]?.page ?? record.base
    const actions = active.actions !== undefined ? active.actions : record.base.actions
    const footer = active.footer !== undefined ? active.footer : record.base.footer
    // ONE save-in-flight answer for the shell AND the renderer: a window/page
    // flag and a document descriptor's own `saving` are the same state, not
    // two channels that can disagree.
    const saving = record.saving
      || active.saving === true
      || (isWindowDocumentContent(active.content) && active.content.saving === true)
    return {
      id: record.id,
      title: active.title ?? record.title,
      baseTitle: record.title,
      pages,
      activeIndex,
      content: active.content,
      ...(actions === undefined ? {} : { actions }),
      ...(footer === undefined ? {} : { footer }),
      bodyLayout: active.bodyLayout ?? record.base.bodyLayout ?? 'scroll',
      size: record.size,
      minSize: record.minSize,
      box: record.box,
      maximized: record.maximized,
      dirty: record.dirty || active.dirty === true,
      saving,
      canGoBack: record.pages.length > 0,
    }
  }

  /** The page a `update` patch lands on: what the reader currently sees. */
  function activePageOf(record: WindowRecord): WindowPage {
    const top = record.pages[record.pages.length - 1]
    return top === undefined ? record.base : top.page
  }

  function confirmClose(record: WindowRecord): Promise<boolean> {
    if (record.pendingClose !== undefined) return record.pendingClose
    const pending = (async (): Promise<boolean> => {
      if (record.onBeforeClose === undefined) return true
      try {
        return (await record.onBeforeClose()) !== false
      } catch (error) {
        console.error(`[dsh-better-sidebar] window "${record.id}" onBeforeClose error:`, error)
        return false
      }
    })()
    record.pendingClose = pending
    void pending.finally(() => {
      if (record.pendingClose === pending) record.pendingClose = undefined
    })
    return pending
  }

  async function requestClose(record: WindowRecord): Promise<void> {
    if (currentRecord(record.id) !== record) return
    const allowed = await confirmClose(record)
    if (allowed) retire(record)
  }

  function applyMaximized(record: WindowRecord, maximized: boolean): void {
    if (record.maximized === maximized) return
    if (maximized) {
      record.restoreBox = record.box
      record.maximized = true
      record.box = maximizedWindowBox(viewport())
    } else {
      record.maximized = false
      record.box = clampWindowBox(record.restoreBox ?? record.box, viewport(), record.minSize)
      record.restoreBox = undefined
    }
    notify()
  }

  function applyUpdate(record: WindowRecord, patch: WindowUpdate): void {
    // Content patches land on the page the reader sees (base while nothing is
    // pushed): a pushed page must be refreshable without pop/re-push, which
    // would throw away its mounted state.
    const page = activePageOf(record)
    if (patch.title !== undefined) {
      if (record.pages.length === 0) record.title = patch.title
      else page.title = patch.title
    }
    if ('content' in patch) page.content = patch.content
    if ('actions' in patch) page.actions = patch.actions
    if ('footer' in patch) page.footer = patch.footer
    if (patch.bodyLayout !== undefined) page.bodyLayout = patch.bodyLayout
    if (patch.dirty !== undefined) record.dirty = patch.dirty
    if (patch.saving !== undefined) record.saving = patch.saving
    if ('onBeforeClose' in patch) record.onBeforeClose = patch.onBeforeClose
    if ('onClose' in patch) record.onClose = patch.onClose
    if (patch.size !== undefined && patch.size !== record.size) {
      record.size = patch.size
      if (record.maximized) {
        // Keep the remembered restore geometry in step with an explicit size
        // change: restoring must land on the size the caller last asked for.
        record.restoreBox = resizeWindowBox(
          record.restoreBox ?? record.box,
          patch.size,
          viewport(),
          record.minSize,
        )
      } else {
        record.box = resizeWindowBox(record.box, patch.size, viewport(), record.minSize)
      }
    }
    if (patch.maximized !== undefined) applyMaximized(record, patch.maximized)
    notify()
  }

  function leaveAllowed(page: WindowPage): boolean {
    if (page.onBeforeLeave === undefined) return true
    try {
      return page.onBeforeLeave() !== false
    } catch (error) {
      console.error('[dsh-better-sidebar] window page onBeforeLeave error:', error)
      return false
    }
  }

  function pushPage(record: WindowRecord, page: WindowPage): void {
    if (currentRecord(record.id) !== record) return
    if (record.pages.length >= MAX_WINDOW_PAGES) {
      console.warn(`[dsh-better-sidebar] window "${record.id}" reached its ${MAX_WINDOW_PAGES}-page navigation cap`)
      return
    }
    pageSequence += 1
    record.pages.push({ key: `page-${pageSequence}`, page })
    notify()
  }

  function popPage(record: WindowRecord): boolean {
    if (currentRecord(record.id) !== record) return false
    const top = record.pages[record.pages.length - 1]
    if (top === undefined) return false
    if (!leaveAllowed(top.page)) return false
    record.pages.pop()
    notify()
    return true
  }

  function createHandle(record: WindowRecord): WindowHandle {
    const navigation: WindowNavigation = {
      push(page: WindowPage): void { pushPage(record, page) },
      pop(): boolean { return popPage(record) },
      back(): boolean { return popPage(record) },
      canGoBack(): boolean { return currentRecord(record.id) === record && record.pages.length > 0 },
      depth(): number { return currentRecord(record.id) === record ? record.pages.length + 1 : 0 },
    }
    return {
      id: record.id,
      update(patch: WindowUpdate): void {
        if (currentRecord(record.id) !== record) return
        applyUpdate(record, patch)
      },
      focus(): void {
        if (currentRecord(record.id) !== record) return
        raiseWindowLayer(layerKey(record.id))
      },
      close(): Promise<void> {
        return requestClose(record)
      },
      navigation,
    }
  }

  function open(options: WindowOpenOptions): WindowHandle {
    if (typeof options.id !== 'string' || options.id.trim() === '') {
      throw new Error('[dsh-better-sidebar] a window needs a non-empty id')
    }
    if (typeof options.title !== 'string') {
      throw new Error(`[dsh-better-sidebar] window "${options.id}" needs a title`)
    }
    const existing = currentRecord(options.id)
    if (existing !== undefined) {
      // Identity means identity: focus the live instance, keep its content,
      // its navigation stack and its unsaved draft exactly as they are.
      raiseWindowLayer(layerKey(existing.id))
      return existing.handle ?? createHandle(existing)
    }
    const preset: WindowSizePreset = options.size ?? 'collection'
    const minSize: WindowSize = options.minSize ?? { width: 320, height: 240 }
    const current = viewport()
    const box = options.initialSize === undefined
      ? initialWindowBox({
        preset,
        viewport: current,
        ...(options.anchor === undefined ? {} : { anchor: options.anchor }),
        min: minSize,
      })
      : placeWindowBox({
        size: options.initialSize,
        viewport: current,
        ...(options.anchor === undefined ? {} : { anchor: options.anchor }),
        min: minSize,
      })
    const pages: PageEntry[] = []
    const record: WindowRecord = {
      id: options.id,
      title: options.title,
      base: {
        content: options.content,
        ...(options.actions === undefined ? {} : { actions: options.actions }),
        ...(options.footer === undefined ? {} : { footer: options.footer }),
        ...(options.bodyLayout === undefined ? {} : { bodyLayout: options.bodyLayout }),
      },
      pages,
      size: preset,
      minSize,
      box,
      restoreBox: undefined,
      maximized: false,
      dirty: options.dirty === true,
      saving: options.saving === true,
      onBeforeClose: options.onBeforeClose,
      onClose: options.onClose,
      handle: undefined,
      pendingClose: undefined,
      opener: activeOpener(),
    }
    record.handle = createHandle(record)
    records = [...records, record]
    notify()
    return record.handle
  }

  return {
    open,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot(): WindowHostSnapshot {
      return cached
    },
    setViewport(next: ViewportSize): void {
      lastViewport = sanitizeViewport(next)
      let changed = false
      for (const record of records) {
        if (record.maximized) {
          const box = maximizedWindowBox(lastViewport)
          if (!sameBox(record.box, box)) {
            record.box = box
            changed = true
          }
        } else {
          const box = clampWindowBox(record.box, lastViewport, record.minSize)
          if (!sameBox(record.box, box)) {
            record.box = box
            changed = true
          }
        }
        if (record.restoreBox !== undefined) {
          const restore = clampWindowBox(record.restoreBox, lastViewport, record.minSize)
          if (!sameBox(record.restoreBox, restore)) {
            record.restoreBox = restore
            changed = true
          }
        }
      }
      if (changed) notify()
    },
    confirmClose(id: string): Promise<boolean> {
      const record = currentRecord(id)
      return record === undefined ? Promise.resolve(true) : confirmClose(record)
    },
    finishClose(id: string): void {
      const record = currentRecord(id)
      if (record !== undefined) retire(record)
    },
    setBox(id: string, box: WindowBox): void {
      const record = currentRecord(id)
      if (record === undefined || record.maximized) return
      const next = clampWindowBox(box, viewport(), record.minSize)
      if (sameBox(record.box, next)) return
      record.box = next
      notify()
    },
    setMaximized(id: string, maximized: boolean): void {
      const record = currentRecord(id)
      if (record !== undefined) applyMaximized(record, maximized)
    },
    popPage(id: string): boolean {
      const record = currentRecord(id)
      return record === undefined ? false : popPage(record)
    },
    dispose(): void {
      records = []
      cached = { windows: [] }
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
    followsLiveViewport: options.viewport === undefined,
  }
}
