/**
 * Anchor selectors for the DSH AppFrame conversation slot host, newest first:
 *
 * - DSH 0.1.5-alpha.2 replaced the root `conversation` slot with a root-scoped
 *   keyed `main` slot, so the conversation renders under `main.conversation`
 *   (ConversationPanel -> `renderSlot('main.conversation')`);
 * - alpha.1 and earlier spell the same host `conversation`.
 *
 * Both keys are accepted deliberately so one build spans the alpha.1 → alpha.2
 * boundary; only one exists in any given host.
 */
const CENTER_COLUMN_SELECTOR = '#root [data-slot="main.conversation"], #root [data-slot="conversation"]'

/** Match Sidebar's existing last-resort retry cadence (issue #248). */
export const CENTER_COLUMN_REVALIDATE_MS = 1500

interface CenterColumnResolveOptions {
  /** Explicit document for tests / callers that do not yet have a cached node. */
  document?: Document
  /** Injectable DOM lookup for tests. */
  query?: () => Element | null
  /** Injectable clock for deterministic retry-boundary tests. */
  now?: () => number
  /** Injectable <html style> fingerprint for deterministic HMR tests. */
  htmlStyle?: () => string | null
  /** Override only for tests; production follows the 1.5s safety-net cadence. */
  revalidateMs?: number
}

/** Last full DOM validation for each center-column node. Weak keys avoid leaks. */
const validatedAt = new WeakMap<HTMLElement, number>()

/**
 * The html-style watcher is an HMR/layout resync signal. Remember the last
 * fingerprint per document so a style change can bypass the connected-node
 * fast path immediately, without requiring Sidebar to run a second locator.
 */
const documentStyleState = new WeakMap<Document, string | null>()

/**
 * From the matched conversation slot host, walk up through transparent slot
 * hosts to the real column: DSH slot hosts render with `display: contents`,
 * so on alpha.2 the `main.conversation` host (and any further keyed slot
 * wrappers above it) contributes no box, and the center column is the first
 * ancestor whose computed display is NOT `contents`.
 */
function columnOfSlotHost(host: Element): HTMLElement | null {
  const view = host.ownerDocument.defaultView
  let node = host.parentElement
  while (node !== null && (view?.getComputedStyle(node).display ?? '') === 'contents') {
    node = node.parentElement
  }
  return node
}

/**
 * Resolve the AppFrame center column while keeping streaming mutations cheap.
 *
 * Sidebar intentionally keeps both recovery mechanisms that predate #403:
 * the `#root` subtree MutationObserver catches boot/HMR DOM swaps, and the
 * 1.5s interval is a last-resort safety net for interleavings no observer is
 * guaranteed to see (#248). The expensive part was letting every scheduled
 * locate scan `#root` with querySelector at streaming-token cadence.
 *
 * Once a connected column is cached, normal calls therefore reuse it without
 * a document query. A full query is still forced when either:
 * - the cached node disconnects;
 * - `<html style>` changes (the existing HMR/layout resync signal); or
 * - 1.5s has elapsed since the last full validation (the safety-net cadence).
 *
 * This preserves recovery semantics while bounding whole-tree selector work
 * to low-frequency validation instead of chat mutation frequency.
 */
export function resolveCenterColumn(
  current: HTMLElement | null,
  options: CenterColumnResolveOptions = {},
): HTMLElement | undefined {
  const doc = options.document ?? current?.ownerDocument ?? document
  const now = (options.now ?? Date.now)()
  const revalidateMs = options.revalidateMs ?? CENTER_COLUMN_REVALIDATE_MS
  const htmlStyle = (options.htmlStyle ?? (() => doc.documentElement.getAttribute('style')))()

  const previousStyle = documentStyleState.get(doc)
  const styleChanged = previousStyle !== undefined && previousStyle !== htmlStyle
  documentStyleState.set(doc, htmlStyle)

  if (current !== null && current.isConnected) {
    const lastValidation = validatedAt.get(current)

    // A connected node passed in for the first time is already a trustworthy
    // cache hit. Start its safety-net window without paying an eager query.
    if (lastValidation === undefined && !styleChanged) {
      validatedAt.set(current, now)
      return current
    }

    if (!styleChanged && lastValidation !== undefined && now - lastValidation < revalidateMs) {
      return current
    }
  }

  const query = options.query ?? (() => doc.querySelector(CENTER_COLUMN_SELECTOR))
  const host = query()
  const col = host === null || host === undefined ? null : columnOfSlotHost(host)
  if (col === null || col === undefined || !col.isConnected) return undefined

  validatedAt.set(col, now)
  return col
}
