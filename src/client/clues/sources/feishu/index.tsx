/**
 * Client registration seam for the two built-in Feishu sources.
 *
 * S9 calls {@link registerFeishuSourceClient} with `ctx.betterSidebar.clues`:
 * it registers the source identity/icon and the three format renderers
 * (`feishu.docs.xml`, `feishu.docs.markdown`, `feishu.task.document`), and
 * returns ONE idempotent disposer. A failed partial registration disposes what
 * already succeeded, so an HMR/mount retry cannot leave half a surface behind.
 *
 * LIVE LOCALE: the labels may be a getter, and S9 should pass its locale
 * subscription as `subscribe`. A locale switch then re-registers the two source
 * display names AND the three format renderers. The format renderer identity
 * is the snapshot S6's open window subscribes to (`getFormatRenderer`), so
 * re-registering is what makes an already-mounted Feishu window re-render with
 * the new copy; merely re-reading a getter would not notify it. Without
 * `subscribe`, labels are only re-resolved on the next natural render and S9
 * must dispose/re-register itself (the obligation is documented here, not
 * silently ignored).
 *
 * This module is node-free and imports the node-free S4 vocabulary only, so it
 * is safe inside the browser bundle. It does not touch the locale dictionaries;
 * S9 supplies localized labels through the options.
 */
import { createElement, type ReactNode } from 'react'
import type { ClueFormatRenderer, ClueFormatRendererProps } from '../../../../clues/types.ts'
import {
  FEISHU_FORMATS,
  FEISHU_SOURCE_IDS,
} from '../../../../clues/sources/feishu/format.ts'
import type { ClueSourceDisplayDescriptor } from '../../../../clues/types.ts'
import { FeishuDocsPreview } from './docs-preview.tsx'
import { feishuDocsIcon, feishuTasksIcon } from './icons.tsx'
import {
  resolveFeishuLabels,
  type FeishuClientLabels,
} from './labels.ts'
import { FeishuTaskEditor } from './task-editor.tsx'

/** The registration subset of `ctx.betterSidebar.clues` this module needs. */
export interface FeishuClientRegistrationFace {
  registerSourceDisplay(descriptor: ClueSourceDisplayDescriptor): () => void
  registerFormatRenderer(format: string, renderer: ClueFormatRenderer): () => void
}

/** The localized labels, either a snapshot or a live getter. */
export type FeishuLabelsSource =
  | Partial<FeishuClientLabels>
  | (() => Partial<FeishuClientLabels> | undefined)

/** Options of {@link registerFeishuSourceClient}. */
export interface RegisterFeishuSourceClientOptions {
  /** Localized copy supplied by S9 (S4 never edits locale dictionaries). */
  readonly labels?: FeishuLabelsSource
  /**
   * App-locale date/time formatter. It receives an ISO timestamp (read stamps)
   * or an epoch-millisecond string (task times) and must localize both. S9
   * passes its locale-aware formatter so these values do not silently use the
   * browser locale; S4 falls back to the app locale (`isZh()`).
   */
  readonly formatDateTime?: (value: string) => string
  /**
   * Locale-change subscription (e.g. `ctx.locale.subscribe`). When present,
   * the source display names and the format renderers are re-registered, so
   * already-open S6 windows observe a new renderer identity and re-render.
   */
  readonly subscribe?: (listener: () => void) => () => void
}

/** Resolve one labels source at the current moment. */
function labelsOf(source: FeishuLabelsSource | undefined): FeishuClientLabels {
  if (typeof source === 'function') return resolveFeishuLabels(source())
  return resolveFeishuLabels(source)
}

/** Build the docs renderer closure for one live label getter. */
function docsRenderer(
  getLabels: () => FeishuClientLabels,
  formatDateTime: ((value: string) => string) | undefined,
): ClueFormatRenderer {
  return (props: ClueFormatRendererProps): ReactNode =>
    createElement(FeishuDocsPreview, {
      ...props,
      labels: getLabels(),
      ...(formatDateTime === undefined ? {} : { formatDateTime }),
    })
}

/** Build the task renderer closure for one live label getter. */
function taskRenderer(
  getLabels: () => FeishuClientLabels,
  formatDateTime: ((value: string) => string) | undefined,
): ClueFormatRenderer {
  return (props: ClueFormatRendererProps): ReactNode =>
    createElement(FeishuTaskEditor, {
      ...props,
      labels: getLabels(),
      ...(formatDateTime === undefined ? {} : { formatDateTime }),
    })
}

/** The three format renderers at the current locale. */
function formatRenderersOf(
  getLabels: () => FeishuClientLabels,
  formatDateTime: ((value: string) => string) | undefined,
): ReadonlyMap<string, ClueFormatRenderer> {
  return new Map([
    [FEISHU_FORMATS.docsXml, docsRenderer(getLabels, formatDateTime)],
    [FEISHU_FORMATS.docsMarkdown, docsRenderer(getLabels, formatDateTime)],
    [FEISHU_FORMATS.taskDocument, taskRenderer(getLabels, formatDateTime)],
  ])
}

/**
 * Register the two source display rows, appending each disposer as soon as its
 * registration succeeds. A failure on the second row therefore still lets the
 * caller dispose the first instead of leaking it.
 */
function installDisplays(
  face: FeishuClientRegistrationFace,
  labels: FeishuClientLabels,
  target: Array<() => void>,
): void {
  target.push(face.registerSourceDisplay({
    sourceId: FEISHU_SOURCE_IDS.docs,
    name: labels.docsName,
    icon: feishuDocsIcon,
  }))
  target.push(face.registerSourceDisplay({
    sourceId: FEISHU_SOURCE_IDS.tasks,
    name: labels.tasksName,
    icon: feishuTasksIcon,
  }))
}

/** Register one set of format renderers, appending each disposer incrementally. */
function installFormats(
  face: FeishuClientRegistrationFace,
  renderers: ReadonlyMap<string, ClueFormatRenderer>,
  target: Array<() => void>,
): void {
  for (const [format, renderer] of renderers) {
    target.push(face.registerFormatRenderer(format, renderer))
  }
}

/** Dispose a list of registrations best-effort, newest first. */
function disposeAll(disposers: Array<() => void>): void {
  while (disposers.length > 0) {
    const dispose = disposers.pop()
    try {
      dispose?.()
    } catch {
      // Best-effort per registration; a broken disposer must not strand the rest.
    }
  }
}

/**
 * Register both Feishu source displays and all three format renderers.
 * @param face - the client clue registry (`ctx.betterSidebar.clues`).
 * @param options - localized copy (optionally live), formatter + locale subscription.
 * @returns an idempotent disposer of exactly these registrations.
 */
export function registerFeishuSourceClient(
  face: FeishuClientRegistrationFace,
  options: RegisterFeishuSourceClientOptions = {},
): () => void {
  let currentLabels = labelsOf(options.labels)
  const getLabels = (): FeishuClientLabels => {
    // A getter is re-resolved on every render, so even without `subscribe` a
    // parent re-render picks the new language. A snapshot stays stable.
    if (typeof options.labels === 'function') currentLabels = labelsOf(options.labels)
    return currentLabels
  }
  let displayDisposers: Array<() => void> = []
  const formatDisposers: Array<() => void> = []
  let currentFormats: ReadonlyMap<string, ClueFormatRenderer> = new Map()

  const installCurrentFormats = (): void => {
    const next: Array<() => void> = []
    const renderers = formatRenderersOf(getLabels, options.formatDateTime)
    try {
      installFormats(face, renderers, next)
    } catch (error) {
      disposeAll(next)
      throw error
    }
    formatDisposers.push(...next)
    currentFormats = renderers
  }

  const refreshDisplays = (): void => {
    const previous = currentLabels
    currentLabels = getLabels()
    disposeAll(displayDisposers)
    try {
      installDisplays(face, currentLabels, displayDisposers)
    } catch (error) {
      // Remove any partially installed new row before restoring the old copy,
      // otherwise re-registering the same sourceId would be rejected as a
      // duplicate and leave the sidebar with a broken/partial display set.
      disposeAll(displayDisposers)
      currentLabels = previous
      try {
        installDisplays(face, previous, displayDisposers)
      } catch {
        displayDisposers = []
      }
      throw error
    }
  }

  const refreshFormats = (): void => {
    const previous = currentFormats
    disposeAll(formatDisposers)
    currentFormats = new Map()
    try {
      installCurrentFormats()
    } catch (error) {
      // The previous closures still read the live label getter, so restoring
      // them keeps open windows correct even if the new registration failed.
      const restored: Array<() => void> = []
      try {
        installFormats(face, previous, restored)
        formatDisposers.push(...restored)
        currentFormats = previous
      } catch {
        disposeAll(restored)
      }
      throw error
    }
  }

  let unsubscribe: (() => void) | undefined
  try {
    installDisplays(face, currentLabels, displayDisposers)
    installCurrentFormats()
    if (options.subscribe !== undefined) {
      try {
        unsubscribe = options.subscribe(() => {
          try {
            refreshDisplays()
          } catch {
            // A locale refresh failure must not break the whole sidebar; the
            // previous display rows remain registered.
          }
          try {
            refreshFormats()
          } catch {
            // Same contract for the renderers; open windows keep the previous
            // (live-label-reading) closures.
          }
        })
      } catch {
        unsubscribe = undefined
      }
    }
  } catch (error) {
    disposeAll(displayDisposers)
    disposeAll(formatDisposers)
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    try {
      unsubscribe?.()
    } catch {
      // Best-effort unsubscribe; disposal below still runs.
    }
    unsubscribe = undefined
    disposeAll(displayDisposers)
    disposeAll(formatDisposers)
    currentFormats = new Map()
  }
}

export { DEFAULT_FEISHU_LABELS, resolveFeishuLabels, type FeishuClientLabels } from './labels.ts'
export { FeishuDocsPreview } from './docs-preview.tsx'
export { FeishuTaskEditor } from './task-editor.tsx'
export { FeishuDocsGlyph, FeishuTasksGlyph, feishuDocsIcon, feishuTasksIcon } from './icons.tsx'
