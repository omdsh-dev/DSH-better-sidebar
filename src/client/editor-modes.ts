import type { EditorViewMode } from './editor-buffers.ts'
import type { EditorMode } from './service.ts'

const MARKDOWN_MODES = ['visual', 'edit'] as const
const HTML_MODES = ['preview', 'edit'] as const
const NO_MODES: readonly EditorMode[] = []

/** Ordered toolbar modes for each built-in text viewer. */
export function editorModesFor(viewerId: string): readonly EditorMode[] {
  if (viewerId === 'markdown') return MARKDOWN_MODES
  if (viewerId === 'html') return HTML_MODES
  return NO_MODES
}

/** Initial mode when a text viewer opens without a stored dirty draft. */
export function defaultEditorMode(viewerId: string): EditorViewMode {
  return viewerId === 'markdown' ? 'visual' : 'preview'
}

/**
 * Keep a restored dirty draft inside the modes its current viewer exposes.
 * Historical Markdown preview drafts now reopen in Visual mode; HTML never
 * inherits Markdown's Visual mode.
 */
export function restoredEditorMode(viewerId: string, stored: EditorViewMode): EditorViewMode {
  if (viewerId === 'markdown') return stored === 'edit' ? 'edit' : 'visual'
  return stored === 'visual' ? 'edit' : stored
}
