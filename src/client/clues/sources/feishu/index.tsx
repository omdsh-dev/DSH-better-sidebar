/**
 * Client registration seam for the two built-in Feishu sources.
 *
 * S9 calls {@link registerFeishuSourceClient} with `ctx.betterSidebar.clues`:
 * it registers the source identity/icon and the three format renderers
 * (`feishu.docs.xml`, `feishu.docs.markdown`, `feishu.task.document`), and
 * returns ONE idempotent disposer. A failed partial registration disposes what
 * already succeeded, so an HMR/mount retry cannot leave half a surface behind.
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

/** Options of {@link registerFeishuSourceClient}. */
export interface RegisterFeishuSourceClientOptions {
  /** Localized copy supplied by S9 (S4 never edits locale dictionaries). */
  readonly labels?: Partial<FeishuClientLabels>
}

/** Build the docs renderer closure for one label set. */
function docsRenderer(labels: FeishuClientLabels): ClueFormatRenderer {
  return (props: ClueFormatRendererProps): ReactNode =>
    createElement(FeishuDocsPreview, { ...props, labels })
}

/** Build the task renderer closure for one label set. */
function taskRenderer(labels: FeishuClientLabels): ClueFormatRenderer {
  return (props: ClueFormatRendererProps): ReactNode =>
    createElement(FeishuTaskEditor, { ...props, labels })
}

/**
 * Register both Feishu source displays and all three format renderers.
 * @param face - the client clue registry (`ctx.betterSidebar.clues`).
 * @param options - optional localized copy.
 * @returns an idempotent disposer of exactly these registrations.
 */
export function registerFeishuSourceClient(
  face: FeishuClientRegistrationFace,
  options: RegisterFeishuSourceClientOptions = {},
): () => void {
  const labels = resolveFeishuLabels(options.labels)
  const disposers: Array<() => void> = []
  const disposeAll = (): void => {
    while (disposers.length > 0) {
      const dispose = disposers.pop()
      try {
        dispose?.()
      } catch {
        // Disposal is best-effort per registration; a broken disposer must not
        // strand the remaining ones.
      }
    }
  }
  try {
    disposers.push(face.registerSourceDisplay({
      sourceId: FEISHU_SOURCE_IDS.docs,
      name: labels.docsName,
      icon: feishuDocsIcon,
    }))
    disposers.push(face.registerSourceDisplay({
      sourceId: FEISHU_SOURCE_IDS.tasks,
      name: labels.tasksName,
      icon: feishuTasksIcon,
    }))
    disposers.push(face.registerFormatRenderer(FEISHU_FORMATS.docsXml, docsRenderer(labels)))
    disposers.push(face.registerFormatRenderer(FEISHU_FORMATS.docsMarkdown, docsRenderer(labels)))
    disposers.push(face.registerFormatRenderer(FEISHU_FORMATS.taskDocument, taskRenderer(labels)))
  } catch (error) {
    disposeAll()
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposeAll()
  }
}

export { DEFAULT_FEISHU_LABELS, resolveFeishuLabels, type FeishuClientLabels } from './labels.ts'
export { FeishuDocsPreview } from './docs-preview.tsx'
export { FeishuTaskEditor } from './task-editor.tsx'
export { FeishuDocsGlyph, FeishuTasksGlyph, feishuDocsIcon, feishuTasksIcon } from './icons.tsx'
