/**
 * Pure HTML-preview target decision for the editor. The HTML preview iframe
 * deliberately renders the SAVED file through the /sidebar/html route URL:
 * a route URL keeps the frame cross-origin by construction, whereas a
 * `srcdoc` frame inherits the parent origin once the sandbox is disabled.
 * The one safe exception is a DIRTY draft under an ENABLED sandbox — a
 * sandboxed srcdoc frame (no allow-same-origin) stays in an opaque origin,
 * so unsaved edits can be previewed without opening a same-origin hole.
 * Kept dependency-free so the decision is unit-testable in isolation.
 */

export interface HtmlPreviewTarget {
  /** The cross-origin route URL of the saved file. */
  src?: string
  /** The unsaved draft, rendered only when the sandbox keeps it opaque. */
  srcDoc?: string
}

/** Inputs the decision needs; `routeUrl` is the precomputed /sidebar/html URL. */
export interface HtmlPreviewInput {
  /** Whether the file is HTML (only HTML has the draft-preview mode). */
  isHtml: boolean
  /** Whether the editor holds unsaved changes. */
  dirty: boolean
  /** The unsaved draft text (null while clean). */
  draft: string | null
  /** Whether the user disabled the preview sandbox for this surface. */
  sandboxOff: boolean
  routeUrl: string
}

/**
 * Decide what the preview iframe should render.
 * @param input - file kind, dirty/draft state, sandbox flag and the route URL.
 * @returns `srcDoc` for a dirty draft under an enabled sandbox; `src` (the
 * saved-file route) in every other state, including a dirty draft with the
 * sandbox disabled — srcdoc would inherit the GUI origin there.
 */
export function htmlPreviewTarget(input: HtmlPreviewInput): HtmlPreviewTarget {
  if (input.isHtml && input.dirty && input.draft !== null && !input.sandboxOff) {
    return { srcDoc: input.draft }
  }
  return { src: input.routeUrl }
}
