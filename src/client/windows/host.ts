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
import { WINDOW_LAYER_BASE_Z, raiseWindowLayer, subscribeWindowLayer, windowLayerZ } from './layer.ts'
import type {
  WindowHandle, WindowHostController, WindowHostOptions,
  WindowHostSnapshot, WindowNavigation, WindowOpenOptions, WindowPage, WindowPageView, WindowSizePreset,
  WindowUpdate, WindowView,
} from './types.ts'

export type { BetterSidebarWindowsClientFace, WindowHandle } from './types.ts'

/** The layer key prefix the public host uses (legacy windows carry none). */
const LAYER_PREFIX = 'window-host:'
/** Navigation is a bounded in-surface stack, not an unbounded history. */
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

function defaultViewport(): ViewportSize {
  if (typeof window === 'undefined') return FALLBACK_VIEWPORT
  return {
    width: Math.max(1, window.innerWidth || FALLBACK_VIEWPORT.width),
    height: Math.max(1, window.innerHeight || FALLBACK_VIEWPORT.height),
  }
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
  let layerUnsubscribe: (() => void) | undefined
  const listeners = new Set<() => void>()

  const viewport = (): ViewportSize => lastViewport ?? viewportOf()

  const currentRecord = (id: string): WindowRecord | undefined =>
    records.find(record => record.id === id)

  const layerKey = (id: string): string => `${LAYER_PREFIX}${id}`

  function ensureLayerSubscription(): void {
    if (layerUnsubscribe !== undefined) return
    layerUnsubscribe = subscribeWindowLayer(() => {
      // A window mounting/unmounting/raising changes the unified z slots the
      // snapshot publishes. Only notify while windows exist (the subscription
      // itself is released when the last one closes).
      if (records.length > 0) notify()
    })
  }

  function releaseLayerIfEmpty(): void {
    if (records.length > 0 || layerUnsubscribe === undefined) return
    layerUnsubscribe()
    layerUnsubscribe = undefined
  }

  function retire(record: WindowRecord): void {
    if (currentRecord(record.id) !== record) return
    records = records.filter(candidate => candidate !== record)
    releaseLayerIfEmpty()
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
      box: record.box,
      maximized: record.maximized,
      dirty: record.dirty || active.dirty === true,
      saving: record.saving || active.saving === true,
      z: windowLayerZ(layerKey(record.id)) ?? WINDOW_LAYER_BASE_Z,
      canGoBack: record.pages.length > 0,
    }
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
    if (patch.title !== undefined) record.title = patch.title
    if ('content' in patch) record.base.content = patch.content
    if ('actions' in patch) record.base.actions = patch.actions
    if ('footer' in patch) record.base.footer = patch.footer
    if (patch.bodyLayout !== undefined) record.base.bodyLayout = patch.bodyLayout
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
    ensureLayerSubscription()
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
      lastViewport = {
        width: Math.max(1, Math.round(next.width)),
        height: Math.max(1, Math.round(next.height)),
      }
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
      releaseLayerIfEmpty()
      cached = { windows: [] }
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}
