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
 * display names and the renderers resolve the new copy on their next render.
 * Without `subscribe`, labels are a snapshot and S9 must dispose/re-register
 * itself (the obligation is documented here, not silently ignored).
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
   * Locale-change subscription (e.g. `ctx.locale.subscribe`). When present,
   * the source display names are re-registered and the renderers re-read the
   * label getter on every render.
   */
  readonly subscribe?: (listener: () => void) => () => void
}

/** Resolve one labels source at the current moment. */
function labelsOf(source: FeishuLabelsSource | undefined): FeishuClientLabels {
  if (typeof source === 'function') return resolveFeishuLabels(source())
  return resolveFeishuLabels(source)
}

/** Build the docs renderer closure for one live label getter. */
function docsRenderer(getLabels: () => FeishuClientLabels): ClueFormatRenderer {
  return (props: ClueFormatRendererProps): ReactNode =>
    createElement(FeishuDocsPreview, { ...props, labels: getLabels() })
}

/** Build the task renderer closure for one live label getter. */
function taskRenderer(getLabels: () => FeishuClientLabels): ClueFormatRenderer {
  return (props: ClueFormatRendererProps): ReactNode =>
    createElement(FeishuTaskEditor, { ...props, labels: getLabels() })
}

/** Register the two source display rows; returns only their disposers. */
function registerDisplays(
  face: FeishuClientRegistrationFace,
  labels: FeishuClientLabels,
): Array<() => void> {
  return [
    face.registerSourceDisplay({
      sourceId: FEISHU_SOURCE_IDS.docs,
      name: labels.docsName,
      icon: feishuDocsIcon,
    }),
    face.registerSourceDisplay({
      sourceId: FEISHU_SOURCE_IDS.tasks,
      name: labels.tasksName,
      icon: feishuTasksIcon,
    }),
  ]
}

/**
 * Register both Feishu source displays and all three format renderers.
 * @param face - the client clue registry (`ctx.betterSidebar.clues`).
 * @param options - localized copy (optionally live) + locale subscription.
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
  const disposeDisplays = (): void => {
    while (displayDisposers.length > 0) {
      const dispose = displayDisposers.pop()
      try {
        dispose?.()
      } catch {
        // Best-effort per row; a broken disposer must not strand the others.
      }
    }
  }
  const disposeFormats = (): void => {
    while (formatDisposers.length > 0) {
      const dispose = formatDisposers.pop()
      try {
        dispose?.()
      } catch {
        // Same per-registration contract.
      }
    }
  }
  const refreshDisplays = (): void => {
    const previous = currentLabels
    currentLabels = getLabels()
    disposeDisplays()
    try {
      displayDisposers = registerDisplays(face, currentLabels)
    } catch (error) {
      // Keep the previous language visible rather than leaving no source row.
      currentLabels = previous
      try {
        displayDisposers = registerDisplays(face, previous)
      } catch {
        displayDisposers = []
      }
      throw error
    }
  }
  let unsubscribe: (() => void) | undefined
  try {
    displayDisposers = registerDisplays(face, currentLabels)
    formatDisposers.push(face.registerFormatRenderer(FEISHU_FORMATS.docsXml, docsRenderer(getLabels)))
    formatDisposers.push(face.registerFormatRenderer(FEISHU_FORMATS.docsMarkdown, docsRenderer(getLabels)))
    formatDisposers.push(face.registerFormatRenderer(FEISHU_FORMATS.taskDocument, taskRenderer(getLabels)))
    if (options.subscribe !== undefined) {
      try {
        unsubscribe = options.subscribe(() => {
          try {
            refreshDisplays()
          } catch {
            // A locale refresh failure must not break the whole sidebar; the
            // previous display rows remain registered.
          }
        })
      } catch {
        unsubscribe = undefined
      }
    }
  } catch (error) {
    disposeDisplays()
    disposeFormats()
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
    disposeDisplays()
    disposeFormats()
  }
}

export { DEFAULT_FEISHU_LABELS, resolveFeishuLabels, type FeishuClientLabels } from './labels.ts'
export { FeishuDocsPreview } from './docs-preview.tsx'
export { FeishuTaskEditor } from './task-editor.tsx'
export { FeishuDocsGlyph, FeishuTasksGlyph, feishuDocsIcon, feishuTasksIcon } from './icons.tsx'
