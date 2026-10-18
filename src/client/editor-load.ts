/**
 * Pure editor-load planning: the decision logic the editor host needs to
 * turn a matched file viewer + a host fs.read result into a render action.
 * Kept dependency-free (no React, no fetch) so the strategy dispatch is
 * unit-testable and the wire contract (head bytes, binary flag) is pinned.
 *
 * The host flow this module drives:
 *   1. `matchFileViewer(path)` picks a viewer by extension/priority.
 *   2. `planFirstMatch` dispatches its fetchStrategy.
 *   3. An fsRead viewer fetches through the host; `planFsReadOutcome`
 *      decides what to do with the result — including the head-based
 *      re-match that lets a `detect` viewer claim a binary the extension
 *      match could not see (the builtin NUL probe on `binary-download`).
 */
import type { FileViewerDescriptor } from './service.ts'

/** One host fs.read result (mirror of the wire; `head` present when binary
 *  or when the file was too large to hand over as a document). */
export type FsReadOutcome =
  | { kind: 'text'; content: string; size: number }
  | { kind: 'binary'; size: number; head: string }
  | { kind: 'too-large'; size: number; head: string }

/** What the editor host should do next. */
export type EditorLoadAction =
  /** No renderer: show the download UI. */
  | { kind: 'binary' }
  /** Render `viewer`'s component with the carried payload. */
  | {
    kind: 'render'
    viewer: FileViewerDescriptor
    content?: string
    size?: number
    /** Present when the file is above the editable threshold: the viewer must
     *  render the read-only paged preview rather than an editor. */
    largeFile?: { size: number }
    mediaUrl?: string
    customData?: unknown
  }
  /** Fetch the file through the host (fsRead strategy). */
  | { kind: 'fetchFsRead'; viewer: FileViewerDescriptor }
  /** Call the viewer's load() and render with its return value. */
  | { kind: 'customLoad'; viewer: FileViewerDescriptor }

/** Decode the host's base64 head bytes into the sniffing buffer. */
export function decodeHead(headBase64: string): Uint8Array {
  const binary = atob(headBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Dispatch one matched viewer's fetchStrategy. A missing viewer or a
 * `binary-download` strategy both mean "no client-side renderer" → the
 * download UI. `mediaUrlOf` builds the media URL for `mediaUrl`/`none`
 * strategies (pure, but scope-bound — injected by the host).
 */
export function planFirstMatch(
  viewer: FileViewerDescriptor | undefined,
  mediaUrlOf: () => string,
): EditorLoadAction {
  if (viewer === undefined || viewer.fetchStrategy === 'binary-download') return { kind: 'binary' }
  switch (viewer.fetchStrategy) {
    case 'mediaUrl':
    case 'none':
      return { kind: 'render', viewer, mediaUrl: mediaUrlOf() }
    case 'custom':
      return { kind: 'customLoad', viewer }
    case 'fsRead':
      return { kind: 'fetchFsRead', viewer }
  }
}

/**
 * Decide what an fsRead result means for the editor.
 * - Text: the first match stands (content is valid for any fsRead viewer).
 * - Too large to edit: the viewer still renders, but with `largeFile` instead
 *   of a document — it shows the read-only paged preview. The head bytes ride
 *   the result so a `detect` viewer gets the same chance it gets on a binary
 *   read, which is what keeps a media viewer working for a huge image and what
 *   lets a plugin claim an oversized format it recognises.
 * - Binary: the host head bytes enable a re-match — a `detect` viewer (e.g.
 *   a plugin sniffing a binary format) may claim the file. `custom` viewers
 *   load their own bytes; `mediaUrl`/`none` viewers render the media route;
 *   an fsRead viewer or nothing cannot render binary → download UI.
 */
export function planFsReadOutcome(
  viewer: FileViewerDescriptor,
  result: FsReadOutcome,
  rematch: (head: Uint8Array) => FileViewerDescriptor | undefined,
  mediaUrlOf: () => string,
): EditorLoadAction {
  if (result.kind === 'text') {
    return { kind: 'render', viewer, content: result.content, size: result.size }
  }
  const claimed = rematch(decodeHead(result.head))
  if (claimed !== undefined && claimed.fetchStrategy === 'custom') {
    return { kind: 'customLoad', viewer: claimed }
  }
  if (claimed !== undefined && (claimed.fetchStrategy === 'mediaUrl' || claimed.fetchStrategy === 'none')) {
    return { kind: 'render', viewer: claimed, mediaUrl: mediaUrlOf() }
  }
  if (result.kind === 'too-large') {
    // Nobody claimed it by content: the matched text viewer renders the paged
    // preview. A `custom`/`mediaUrl` viewer can never get here with content it
    // cannot use, so an fsRead viewer is the only remaining sensible owner —
    // and the host only reaches this branch after matching one.
    if (viewer.fetchStrategy !== 'fsRead') return { kind: 'binary' }
    return { kind: 'render', viewer, size: result.size, largeFile: { size: result.size } }
  }
  return { kind: 'binary' }
}
