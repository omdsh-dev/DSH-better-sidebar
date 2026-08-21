/**
 * file:line link integration — click-to-jump for chat references.
 *
 * Inline `<code>` tokens in chat replies that parse as `path:line`,
 * `path:line:col`, `path:start-end` or `path#L123` are decorated with a link
 * look (business blue + pointer + hover underline) and, on click, open the
 * file in THIS sidebar's editor, scrolling the start line into the viewport
 * center and highlighting the whole range.
 *
 * Hard-won behavioral rules baked in (all verified against live sessions):
 * - CONVERGENCE LOOP, not one-shot: on a freshly mounted editor CodeMirror
 *   first renders an UNMEASURED viewport; a centered scroll dispatched into
 *   that state is silently swallowed. The selection + centered scroll is
 *   re-dispatched (idempotent) every tick until the target line is rendered
 *   AND on-screen — then (and only then) the overlay is painted.
 * - The overlay repaint is SYNCHRONOUS on DOM churn and re-queries the LIVE
 *   editor: an rAF-throttled repaint deadlocks in backgrounded windows
 *   (frozen rAF → queued flag never clears → observer goes deaf), and an
 *   observer anchored at the scroller watches a detached tree after an
 *   editor remount. Body-anchored + live re-query self-heals both.
 * - The overlay follows editor churn only until the user's NEXT click or
 *   wheel action; a click inside the editor also sweeps it (IDE semantics:
 *   placing the caret replaces the selection). No zombie resurrections.
 * - Landing always happens in the RIGHT sidebar: openTab lands in the active
 *   pane, so when that pane lives in the bottom panel a right-panel tab is
 *   activated first.
 * - The jump loop bails on any user pointerdown/wheel before convergence —
 *   never fight the user's own scrolling.
 */
import type { Context } from '../context-types.ts'
import type { BetterSidebarService } from './service.ts'
import type { OpenTabSeed } from './service.ts'
import { api, type SessionScope } from './api.ts'

// ── file:line parsing ───────────────────────────────────────────────────────

interface FileRef {
  path: string
  line?: number
  endLine?: number
  column?: number
}

/** Whether a string plausibly names a file (not an arbitrary code token). */
function looksLikePath(text: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(text)) return true // Windows drive (D:\...)
  if (text.startsWith('/') || text.startsWith('\\')) return true // POSIX / UNC absolute
  // Relative path: must contain a separator AND end with a file-like
  // extension, so slash-joined word lists (`compress/csv/.../auto-label`)
  // are never mistaken for paths. Absolute paths above stay recognized
  // regardless of extension.
  if (/[\\/]/.test(text) && /\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(text)) return true
  return false
}

/**
 * Parse a file reference out of an inline-code token's text.
 * Supported shapes: `path`, `path:line`, `path:line:col`, `path:start-end`,
 * `path#Lline` (also `#L1-L2` ranges). The path part must look like a real
 * path so ordinary prose (`12:30`) is never treated as a jump target.
 */
function parseFileRef(raw: string): FileRef | null {
  const text = raw.trim()
  if (text === '' || text.length > 512) return null

  // GitHub-style `path#L123` (also `path#L123-L456` ranges).
  const hash = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(text)
  if (hash !== null && looksLikePath(hash[1]!)) {
    return {
      path: hash[1]!,
      line: Number(hash[2]),
      endLine: hash[3] !== undefined ? Number(hash[3]) : undefined,
    }
  }

  // `path:line:column`
  const col = /^(.*):(\d+):(\d+)$/.exec(text)
  if (col !== null && looksLikePath(col[1]!)) {
    return { path: col[1]!, line: Number(col[2]), column: Number(col[3]) }
  }

  // `path:startLine-endLine` (a line range; reversed bounds are normalized)
  const range = /^(.*):(\d+)-(\d+)$/.exec(text)
  if (range !== null && looksLikePath(range[1]!)) {
    const a = Number(range[2])
    const b = Number(range[3])
    return { path: range[1]!, line: Math.min(a, b), endLine: Math.max(a, b) }
  }

  // `path:line` (the trailing `:digits` is the line, not a drive letter)
  const line = /^(.*):(\d+)$/.exec(text)
  if (line !== null && looksLikePath(line[1]!)) {
    return { path: line[1]!, line: Number(line[2]) }
  }

  // Bare path (no line)
  if (looksLikePath(text)) return { path: text }
  return null
}

// ── Path resolution ─────────────────────────────────────────────────────────

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')
}

/** Resolve a relative path against the session cwd (Windows and POSIX aware). */
function resolvePath(cwd: string | undefined, path: string): string {
  const cleaned = path.trim()
  if (isAbsolutePath(cleaned)) return cleaned
  const base = (cwd ?? '').replace(/[\\/]+$/, '')
  if (base === '') return cleaned
  const sep = base.includes('\\') ? '\\' : '/'
  return base + sep + cleaned.replace(/[\\/]+/g, sep)
}

function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/**
 * Monorepo-aware fuzzy resolver for RELATIVE references. A relative path like
 * `internal/biz/ctrsdcr.go` usually resolves against the session cwd root,
 * but in a multi-module workspace the real file often lives deep under a
 * sub-project (`idatacook/app/.../internal/biz/ctrsdcr.go`). When the direct
 * resolve is just `cwd + path`, we ask the sidebar's recursive file-name
 * search (rooted at the session cwd) for the basename and adopt the unique
 * match whose path ends with the requested relative suffix. Results are
 * cached per suffix so a jump does not re-scan the tree every click.
 */
const relativeResolveCache = new Map<string, string | null>()

async function resolveMonorepoPath(scope: SessionScope, refPath: string, cwd: string | undefined): Promise<string | null> {
  const direct = resolvePath(cwd, refPath)

  // Absolute references resolve to themselves; verified to exist below.
  if (isAbsolutePath(refPath)) {
    return (await pathExists(scope, direct)) ? direct : null
  }

  // Normalize the requested relative suffix and the cwd separator.
  const sep = (cwd ?? '').includes('\\') ? '\\' : '/'
  const suffix = refPath.replace(/[\\/]+/g, '/').replace(/^\.\//, '')
  const suffixSegments = suffix.split('/').filter(Boolean)
  const key = suffix

  let resolved: string | null = null
  const cached = relativeResolveCache.get(key)
  if (cached !== undefined) {
    resolved = cached
  } else {
    try {
      const { matches } = await api.fsSearch(scope, basename(refPath))
      // Prefer exact relative-suffix match; fall through to unique basename match.
      const suffixHit = matches
        .map(m => m.replace(/^\.\.\//, ''))
        .filter(m => m.split('/').filter(Boolean).join('/').endsWith(suffix === '' ? basename(refPath) : suffix))
      const candidates = suffixHit.length === 1
        ? suffixHit
        : matches.filter(m => m.split('/').filter(Boolean).pop() === basename(refPath))
      if (candidates.length === 1) {
        resolved = cwd ? resolvePath(cwd, candidates[0]!) : candidates[0]!
      } else if (candidates.length > 1 && suffixSegments.length >= 2) {
        // Several modules share the basename; narrow by the LAST N segments.
        const tail = suffixSegments.slice(-Math.min(suffixSegments.length, 3)).join('/')
        const narrowed = matches.filter(m => m.split('/').filter(Boolean).join('/').endsWith(tail))
        if (narrowed.length === 1) resolved = cwd ? resolvePath(cwd, narrowed[0]!) : narrowed[0]!
      }
    } catch {
      resolved = null
    }
    relativeResolveCache.set(key, resolved)
  }

  // Only an EXISTING absolute path may become the open target: a relative
  // reference that fails to resolve anywhere is returned as null so the
  // caller never opens a dead editor tab (the `cwd + relative` fallback is
  // only a candidate here, not a promise the file exists).
  const candidate = resolved ?? direct
  return (await pathExists(scope, candidate)) ? candidate : null
}

/** Stat one absolute candidate through the host; false when missing/unreadable
 *  or when it is a directory (a file link should open a file, never a folder). */
async function pathExists(scope: SessionScope, path: string): Promise<boolean> {
  try {
    const info = await api.fsStat(scope, path)
    return info.exists && !info.isDir
  } catch {
    return false
  }
}

// ── Sidebar state walking ───────────────────────────────────────────────────

interface TabLike {
  id: string
  path?: string
}

interface SplitNodeLike {
  kind: 'leaf' | 'split'
  id: string
  tabs?: TabLike[]
  active?: string | null
  children?: SplitNodeLike[]
}

function allLeavesOf(node: SplitNodeLike): SplitNodeLike[] {
  if (node.kind === 'leaf') return [node]
  return (node.children ?? []).flatMap(allLeavesOf)
}

function treeHasId(node: SplitNodeLike, id: string): boolean {
  if (node.id === id) return true
  if (node.kind === 'split') return (node.children ?? []).some(child => treeHasId(child, id))
  return false
}

/** Whether the target file's tab is the active tab of its pane (i.e. displayed). */
function targetTabActive(bs: BetterSidebarService, absolute: string): boolean {
  const snapshot = bs.getSnapshot()
  const state = snapshot.state as unknown as
    | { splits: SplitNodeLike; bottomSplits: SplitNodeLike }
    | undefined
  if (state === undefined) return false
  for (const leaf of [...allLeavesOf(state.splits), ...allLeavesOf(state.bottomSplits)]) {
    const tab = (leaf.tabs ?? []).find(candidate => candidate.path === absolute)
    if (tab !== undefined) return leaf.active === tab.id
  }
  return false
}

/**
 * The right sidebar must own the landing: openTab lands in the ACTIVE pane,
 * so when that pane lives in the bottom panel we activate a right-panel tab
 * first, moving the active pane into the right tree.
 */
function forceRightPanelLanding(bs: BetterSidebarService): void {
  const snapshot = bs.getSnapshot()
  const state = snapshot.state as unknown as
    | { activePane: string | null; splits: SplitNodeLike; bottomSplits: SplitNodeLike }
    | undefined
  if (state === undefined || state.activePane === null) return
  if (!treeHasId(state.bottomSplits, state.activePane)) return
  for (const leaf of allLeavesOf(state.splits)) {
    const tabs = leaf.tabs ?? []
    if (tabs.length === 0) continue
    const tabId = leaf.active ?? tabs[0]!.id
    bs.activateTab(tabId)
    return
  }
}

// ── CodeMirror access (via the public `.cmTile` DOM handle) ─────────────────

interface EditorViewLike {
  state: {
    doc: {
      length: number
      lines: number
      line(n: number): { from: number; to: number }
      lineAt(pos: number): { from: number; to: number; number: number }
    }
  }
  dispatch(spec: { selection: { anchor: number; head?: number }; scrollIntoView?: boolean; effects?: unknown }): void
  domAtPos(pos: number): { node: Node; offset: number }
  posAtCoords(coords: { x: number; y: number }): number | null
}

/** The CodeMirror view behind a `.cm-content` element, via the public cmTile. */
function contentView(content: HTMLElement): EditorViewLike | null {
  let node: HTMLElement | null = content
  while (node !== null) {
    const tile = (node as unknown as { cmTile?: { root?: { view?: EditorViewLike } } }).cmTile
    if (tile !== undefined && tile.root?.view !== undefined) return tile.root.view
    node = node.parentElement
  }
  return null
}

/** Map one rendered `.cm-line` element to its document line number (0 = unknown). */
function lineNumberOfEl(view: EditorViewLike, el: HTMLElement): number {
  const rect = el.getBoundingClientRect()
  let pos: number | null = null
  try {
    pos = view.posAtCoords({ x: rect.left + 1, y: rect.top + rect.height / 2 })
  } catch {
    pos = null
  }
  if (pos === null) return 0
  try {
    return view.state.doc.lineAt(pos).number
  } catch {
    return 0
  }
}

/**
 * Find the rendered `.cm-line` element for an exact line number. Returns null
 * while the target line is outside the rendered viewport — CodeMirror
 * virtualizes lines and `domAtPos` CLAMPS to the nearest rendered line, so an
 * unrendered target must never be trusted to a domAtPos lookup alone.
 *
 * Two passes: rect/posAtCoords mapping first (precise, needs measured
 * geometry); when geometry is degenerate (backgrounded window / occluded
 * panel — posAtCoords returns null there), fall back to `domAtPos` of the
 * line start and climb to its `.cm-line`, which is exact for RENDERED lines.
 */
function findLineElement(view: EditorViewLike, scroller: HTMLElement, target: number): HTMLElement | null {
  for (const raw of Array.from(scroller.querySelectorAll('.cm-line'))) {
    const el = raw as HTMLElement
    if (lineNumberOfEl(view, el) === target) return el
  }
  // Degenerate-geometry fallback: domAtPos lands inside the line when the
  // line IS rendered (it clamps only for unrendered positions).
  try {
    const loc = view.domAtPos(view.state.doc.line(target).from)
    let node: HTMLElement | null = loc.node instanceof HTMLElement ? loc.node : loc.node.parentElement
    for (let depth = 0; depth < 6 && node !== null; depth += 1) {
      if (node.classList.contains('cm-line')) return node
      node = node.parentElement
    }
  } catch {
    // fall through
  }
  return null
}

/** Whether an element is currently laid out (displayed, not display:none). */
function isVisible(el: HTMLElement): boolean {
  if (el.offsetParent !== null) return true
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function cssEscape(value: string): string {
  const globalCss = (window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS
  if (globalCss?.escape !== undefined) return globalCss.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

/**
 * Locate the CodeMirror content element for one absolute path: the editor
 * host's path input carries `title={path}`, so find it and take the nearest
 * ancestor that contains a `.cm-content`. Returns null when not mounted yet.
 */
function editorContentForPath(absolute: string): HTMLElement | null {
  let input: HTMLElement | null = null
  try {
    input = document.querySelector(`input[title="${cssEscape(absolute)}"]`)
  } catch {
    return null
  }
  if (input === null) return null
  let node: HTMLElement | null = input
  for (let depth = 0; depth < 8 && node !== null; depth += 1) {
    const cm = node.querySelector('.cm-content')
    if (cm !== null) return cm as HTMLElement
    node = node.parentElement
  }
  return null
}

// ── Visible line highlight (document-anchored overlay) ──────────────────────

const LINE_CLASS = 'dsh-better-sidebar-file-link-line'

interface ActiveRange {
  start: number
  end: number
  /** Repaints on any editor DOM churn anywhere. Anchored at document.body —
   *  NOT at the scroller: the editor remounts wholesale on tab switches and
   *  viewer re-matches, and an observer left on the replaced scroller
   *  silently watches a detached tree. The live editor is re-queried on
   *  EVERY repaint, so any remount is self-healing. */
  observer: MutationObserver
  /** Removes the follow behavior; called on the user's next click. */
  stopFollowing: (event: Event) => void
}

let activeRange: ActiveRange | null = null

/** Remove every overlay class in the document (detached nodes included). */
function sweepLineClasses(): void {
  for (const el of Array.from(document.querySelectorAll(`.${LINE_CLASS}`))) {
    el.classList.remove(LINE_CLASS)
  }
}

/** Drop the current range highlight (called when a new jump lands). */
function clearLineHighlight(): void {
  if (activeRange !== null) {
    activeRange.observer.disconnect()
    document.removeEventListener('pointerdown', activeRange.stopFollowing, true)
    activeRange = null
  }
  sweepLineClasses()
}

/**
 * The LIVE editor content (re-queried every call — remount-proof).
 * Connectivity (`isConnected`) is the primary signal: a rect-based
 * "visibility" check returns false for elements in backgrounded windows and
 * occluded panels (all rects collapse to 0), which silently disabled the
 * overlay repaint exactly there. Geometry is only a tiebreaker when several
 * editors are mounted (split panes): prefer one with non-zero rects.
 */
function liveVisibleContent(): HTMLElement | null {
  let fallback: HTMLElement | null = null
  for (const raw of Array.from(document.querySelectorAll('.cm-content'))) {
    const el = raw as HTMLElement
    if (!el.isConnected) continue
    if (isVisible(el)) return el
    if (fallback === null && contentView(el) !== null) fallback = el
  }
  return fallback
}

/** Re-paint the overlay on the RENDERED lines inside the active range. */
function paintRangeLines(): void {
  const ar = activeRange
  if (ar === null) return
  paintRange(ar.start, ar.end)
}

/** Range-only repaint core (works even after activeRange is gone — used by
 *  the watchdog, whose closed-over range outlives the following state). */
function paintRange(start: number, end: number): void {
  const content = liveVisibleContent()
  if (content === null) return
  const view = contentView(content)
  if (view === null) return
  const lines = Array.from(content.querySelectorAll('.cm-line')) as HTMLElement[]
  if (lines.length === 0) return
  // First pass: coordinate mapping (precise when geometry is measured).
  const nums: number[] = lines.map(el => lineNumberOfEl(view, el))
  if (nums.some(n => n === 0)) {
    // Degenerate geometry fallback: rendered lines are in DOCUMENT ORDER, so
    // one successful mapping anchors the whole block (index offsets give the
    // rest). If none mapped, try domAtPos on the target start line directly.
    const anchorIdx = nums.findIndex(n => n > 0)
    if (anchorIdx !== -1) {
      for (let i = 0; i < lines.length; i += 1) {
        if (nums[i] === 0) nums[i] = nums[anchorIdx]! + (i - anchorIdx)
      }
    } else {
      const from = view.state.doc.line(Math.max(1, Math.min(start, view.state.doc.lines))).from
      try {
        const loc = view.domAtPos(from)
        let node: HTMLElement | null = loc.node instanceof HTMLElement ? loc.node : loc.node.parentElement
        for (let depth = 0; depth < 6 && node !== null; depth += 1) {
          if (node.classList.contains('cm-line')) {
            const idx = lines.indexOf(node)
            if (idx !== -1) {
              for (let i = 0; i < lines.length; i += 1) nums[i] = start + (i - idx)
            }
            break
          }
          node = node.parentElement
        }
      } catch {
        // give up mapping; nothing will be painted this pass
      }
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    const num = nums[i]!
    if (num >= start && num <= end) lines[i]!.classList.add(LINE_CLASS)
  }
}

/** Set while a watchdog repaint loop should keep healing the overlay. */
let pendingBail = false

/**
 * Establish the range overlay once the START line is actually rendered.
 * @returns the VERIFIED start-line element, or null while the target is not
 * in the rendered viewport yet (the caller retries on later ticks).
 */
function establishRangeHighlight(view: EditorViewLike, contentEl: HTMLElement, startLine: number, endLine: number): HTMLElement | null {
  try {
    const scrollerEl = contentEl.closest('.cm-scroller')
    if (scrollerEl === null) return null
    const startEl = findLineElement(view, scrollerEl as HTMLElement, startLine)
    if (startEl === null) return null
    clearLineHighlight()
    // The overlay follows editor churn only until the user's NEXT click.
    // NOTE: a click OUTSIDE the editor only stops the following (observer
    // disconnected, painted classes stay on their elements and fade as
    // CodeMirror recycles them) — it must NEVER sweep classes: the sweep was
    // the only un-logged class remover, and any stray pointerdown (tab close
    // affordances, focus juggling) could wipe a fresh highlight invisibly.
    // Only a click INSIDE the editor sweeps (IDE semantics: placing the
    // caret replaces the selection).
    const stopFollowing = (event: Event): void => {
      document.removeEventListener('pointerdown', stopFollowing, true)
      pendingBail = true
      if (activeRange === null) return
      activeRange.observer.disconnect()
      if (event.target instanceof Element && event.target.closest('.cm-scroller') !== null) {
        sweepLineClasses()
      }
      activeRange = null
    }
    // childList-only (no attributes): the plugin's own class paints must not
    // feed back into the observer. Synchronous on purpose — an rAF-throttled
    // repaint DEADLOCKS in backgrounded windows (frozen rAF → queued flag
    // never clears → the observer goes permanently deaf).
    const repaint = (): void => { paintRange(startLine, endLine) }
    const observer = new MutationObserver(() => { repaint() })
    observer.observe(document.body, { childList: true, subtree: true })
    activeRange = { start: startLine, end: endLine, observer, stopFollowing }
    document.addEventListener('pointerdown', stopFollowing, true)
    // WATCHDOG repaint: DOM-churn observation alone proved insufficient —
    // element replacement inside CodeMirror can outpace or evade the
    // observer's repaint (seen live: painted classes vanished with zero
    // sweep calls and zero attribute mutations captured; the user perceives
    // the heal as "selected twice"). Two-phase cadence keeps any wipe window
    // under the perception threshold: 60ms for the first 2.5s (where the
    // mounts, measures and syntax passes churn hardest), 200ms afterwards,
    // hard stop at 10s or the user's first click/wheel. It never touches
    // scroll and never fights the user.
    const watchStart = Date.now()
    const watchUntil = watchStart + 10000
    const watchdog = (): void => {
      if (Date.now() > watchUntil || pendingBail) return
      repaint()
      const elapsed = Date.now() - watchStart
      window.setTimeout(watchdog, elapsed < 500 ? 30 : elapsed < 2500 ? 60 : 200)
    }
    window.setTimeout(watchdog, 30)
    repaint()
    return startEl
  } catch {
    // Best-effort decoration: never break the jump on a DOM drift.
    return null
  }
}

/**
 * Self-correcting centering passes: re-measure from live rects shortly after
 * the jump and re-center only when the (verified) start line is still visible
 * yet clearly off-center — idempotent, and never fighting the user once they
 * scrolled the line away.
 */
function scheduleCenterVerification(lineEl: HTMLElement): void {
  const verify = (): void => centerLineElement(lineEl, 10)
  window.requestAnimationFrame(() => { window.requestAnimationFrame(verify) })
  window.setTimeout(verify, 220)
}

/**
 * Center one `.cm-line` element inside its `.cm-scroller` viewport.
 * `tolerance` skips sub-pixel/near-center nudges; when the line is scrolled
 * fully OUT of view the call does nothing.
 */
function centerLineElement(el: HTMLElement, tolerance = 0): void {
  const scroller = el.closest('.cm-scroller')
  if (scroller === null) return
  const scrollerRect = scroller.getBoundingClientRect()
  const lineRect = el.getBoundingClientRect()
  if (lineRect.bottom < scrollerRect.top || lineRect.top > scrollerRect.bottom) return
  const delta = (lineRect.top + lineRect.height / 2) - (scrollerRect.top + scrollerRect.height / 2)
  if (Math.abs(delta) <= tolerance || (tolerance === 0 && delta === 0)) return
  scroller.scrollTop += delta
}

// ── Jump convergence loop ───────────────────────────────────────────────────

interface PendingJump {
  bs: BetterSidebarService
  absolute: string
  line: number
  endLine?: number
  /** Set once the first dispatch landed; arms the user-bail listeners. */
  dispatched: boolean
}

let pending: PendingJump | null = null

/**
 * One convergence attempt: re-dispatch the (idempotent) selection + centered
 * scroll and settle only once the target line is rendered AND on-screen —
 * by then the geometry is measured, the scroll sticks, and the paint
 * survives. Dispatched into CodeMirror's initial UNMEASURED viewport, a
 * centered scroll is silently swallowed ("already visible" at scrollTop 0);
 * re-dispatching every tick absorbs that race deterministically.
 */
function tryJumpNow(): boolean {
  if (pending === null) return false
  const { bs, absolute, line, endLine } = pending

  // Wait until the target file's tab is the displayed tab of its pane, so we
  // never jump a stale editor from before the tab switch.
  if (!targetTabActive(bs, absolute)) return false

  // Prefer the editor that belongs to this exact path; fall back to the first
  // visible one (single-pane layouts — the common case).
  const byPath = editorContentForPath(absolute)
  const candidates: HTMLElement[] = []
  if (byPath !== null) candidates.push(byPath)
  for (const raw of Array.from(document.querySelectorAll('.cm-content'))) {
    const el = raw as HTMLElement
    if (el !== byPath) candidates.push(el)
  }

  for (const el of candidates) {
    // Connectivity, not rect-visibility: rects collapse to zero in
    // backgrounded windows and occluded panels, which must not disqualify a
    // live editor from receiving the jump.
    if (!el.isConnected) continue
    const view = contentView(el)
    if (view === null) continue
    const doc = view.state.doc
    if (doc.length === 0) continue
    // Clamp the range into the document (friendlier than bailing on a
    // partially out-of-range request like :74-1000).
    const startLine = Math.max(1, Math.min(line, doc.lines))
    const lastLine = endLine === undefined
      ? startLine
      : Math.max(startLine, Math.min(endLine, doc.lines))
    const start = doc.line(startLine)
    const end = doc.line(lastLine)
    const head = end.to > start.from ? end.to : Math.min(start.from + 1, doc.length)

    try {
      // Prefer CodeMirror's official centered scroll effect (reached through
      // the view's own class — no CodeMirror import needed); fall back to the
      // boolean minimal scroll when the static is not reachable.
      let centerEffect: unknown
      try {
        const ctor = (view as unknown as { constructor?: { scrollIntoView?: (pos: number, options: { y: 'center' }) => unknown } }).constructor
        centerEffect = ctor?.scrollIntoView?.(start.from, { y: 'center' })
      } catch {
        centerEffect = undefined
      }
      if (centerEffect !== undefined) {
        view.dispatch({ selection: { anchor: start.from, head }, effects: centerEffect })
      } else {
        view.dispatch({ selection: { anchor: start.from }, scrollIntoView: true })
        view.dispatch({ selection: { anchor: start.from, head } })
      }
    } catch {
      // A dispatch surface drift must never break the click — the file is
      // already open at that point.
    }
    const current = pending
    if (current !== null && !current.dispatched) armBailListeners()

    // Converged? The start line must be rendered and, whenever the document
    // is scrollable, actually inside the scroller's viewport. The rect check
    // is skipped when geometry is degenerate (backgrounded window / occluded
    // panel: all rects are 0) — scrollTop then carries the convergence signal.
    const scrollerEl = el.closest('.cm-scroller')
    if (scrollerEl === null) continue
    const startEl = findLineElement(view, scrollerEl as HTMLElement, startLine)
    if (startEl === null) continue
    if (scrollerEl.scrollHeight > scrollerEl.clientHeight + 4) {
      const sr = scrollerEl.getBoundingClientRect()
      if (sr.width > 0 || sr.height > 0) {
        const lr = startEl.getBoundingClientRect()
        if (lr.bottom <= sr.top || lr.top >= sr.bottom) continue
      }
    }

    const lineEl = establishRangeHighlight(view, el, startLine, lastLine)
    if (lineEl === null) continue
    scheduleCenterVerification(lineEl)
    pending = null
    return true
  }
  return false
}

/**
 * Cancel the convergence loop the moment the user takes over (any click, any
 * wheel). Re-dispatching a centered scroll past that point would fight the
 * user's own scrolling, which is worse than a missing highlight.
 */
function armBailListeners(): void {
  const p = pending
  if (p === null || p.dispatched) return
  p.dispatched = true
  const bail = (): void => {
    document.removeEventListener('pointerdown', bail, true)
    document.removeEventListener('wheel', bail, true)
    pendingBail = true
    if (pending === p) pending = null
  }
  document.addEventListener('pointerdown', bail, true)
  document.addEventListener('wheel', bail, true)
}

/** Poll until the jump converges (or the deadline / a user action ends it). */
function scheduleJump(bs: BetterSidebarService, absolute: string, line: number, endLine?: number): void {
  pending = { bs, absolute, line, endLine, dispatched: false }
  pendingBail = false
  const deadline = Date.now() + 5000
  const tick = (): void => {
    if (pending === null) return
    if (Date.now() > deadline) {
      pending = null
      return
    }
    if (tryJumpNow()) return
    // Fast cadence: on a fresh open the editor mounts mid-poll, and every
    // saved frame between mount and the centered scroll shrinks the visible
    // top-of-file flash before the jump lands.
    window.setTimeout(tick, 50)
  }
  // Small delay so the sidebar can switch to the target tab before we scan.
  window.setTimeout(tick, 120)
}

// ── Open a resolved reference ────────────────────────────────────────────────

/** Open an already-resolved absolute path (existence-verified at decoration
 *  time) in the sidebar editor, jumping to the parsed line when present. */
function openAbsolute(service: BetterSidebarService, absolute: string, ref: FileRef | null): void {
  forceRightPanelLanding(service)
  const line = ref?.line
  const seed: OpenTabSeed = {
    type: 'editor',
    title: basename(absolute),
    path: absolute,
    id: `editor:${absolute}`,
    meta: line !== undefined ? { line, endLine: ref?.endLine, column: ref?.column } : undefined,
  }
  service.openTab(seed)
  if (line !== undefined && ref !== null) scheduleJump(service, absolute, line, ref.endLine)
}

// ── Click delegation ────────────────────────────────────────────────────────

function registerClickDelegation(service: BetterSidebarService): () => void {
  const onClick = (event: MouseEvent): void => {
    // Plain left-click only; modifiers always bypass (let the browser win).
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (event.defaultPrevented) return
    const target = event.target
    if (!(target instanceof Element)) return

    const code = target.closest('code')
    if (code === null) return
    // Never intercept code that is already a link (official file mentions)
    // or that lives inside a code block.
    if (code.closest('a') !== null || code.closest('pre') !== null) return
    // Only already-resolved references are clickable: `decorate` adds
    // LINK_CLASS + the resolved absolute path only after the token resolves
    // to an existing file, so a path-like token that fails to resolve stays
    // inert and can never open a dead editor tab.
    if (!(code instanceof HTMLElement) || !code.classList.contains(LINK_CLASS)) return

    const absolute = code.dataset.dshFileLinkPath
    if (absolute === undefined) return // decoration is still resolving; not clickable yet

    const ref = parseFileRef(code.textContent ?? '')
    event.preventDefault()
    event.stopPropagation()
    openAbsolute(service, absolute, ref)
  }

  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}

// ── Link styling for matching inline <code> elements ────────────────────────

const LINK_CLASS = 'dsh-better-sidebar-file-link'

function injectStyles(): HTMLStyleElement {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-better-sidebar'
  tag.textContent = [
    `code.${LINK_CLASS}{color:var(--dsw-alias-state-business-primary,var(--dsw-static-blue-450,#3b82f6));cursor:pointer;}`,
    `code.${LINK_CLASS}:hover{text-decoration:underline;}`,
    `.${LINE_CLASS}{background:rgba(64,140,255,.22)!important;box-shadow:inset 3px 0 0 var(--dsw-alias-state-business-primary,#3b82f6);}`,
  ].join('\n')
  document.head.appendChild(tag)
  return tag
}

function tooltipFor(ref: FileRef): string {
  if (ref.line === undefined) return '打开文件 · open file'
  const range = ref.endLine !== undefined && ref.endLine !== ref.line
    ? `${ref.line}-${ref.endLine}`
    : `${ref.line}`
  return `打开并选中第 ${range} 行 · open lines ${range}`
}

/** Resolution cache keyed by `${sessionId}\u0000${refPath}`: a React re-render
 *  swaps the <code> node, so re-resolving the same token would otherwise
 *  re-run the fuzzy search + stat on every DOM churn. Cached `null` means the
 *  token already failed to resolve and must stay plain. */
const decorationCache = new Map<string, string | null>()

/** Apply the link look + resolved absolute path marker to one <code> element. */
function applyDecoration(el: HTMLElement, ref: FileRef, absolute: string): void {
  el.classList.add(LINK_CLASS)
  el.setAttribute('title', tooltipFor(ref))
  el.dataset.dshFileLinkPath = absolute
}

/** Decorate one <code> element only when its text resolves to an existing
 *  absolute path: the click target is that real path, never a guessed
 *  cwd-join of a relative token. */
function decorate(ctx: Context, el: HTMLElement): void {
  if (el.classList.contains(LINK_CLASS)) return // already decorated
  const ref = parseFileRef(el.textContent ?? '')
  if (ref === null) return

  const snapshot = ctx.sessions.list.getSnapshot()
  const sessionId = snapshot.current
  if (sessionId === undefined) {
    // No session: nothing to resolve against; store the raw path as-is so the
    // click still opens it through the resolved-path marker.
    applyDecoration(el, ref, resolvePath(undefined, ref.path))
    return
  }
  const cwd = snapshot.byId[sessionId]?.cwd
  const scope: SessionScope = { sessionId, cwd }
  const cacheKey = `${sessionId}\u0000${ref.path}`

  const cached = decorationCache.get(cacheKey)
  if (cached !== undefined) {
    if (cached !== null) applyDecoration(el, ref, cached)
    return
  }

  void resolveMonorepoPath(scope, ref.path, cwd).then((absolute) => {
    decorationCache.set(cacheKey, absolute)
    if (absolute === null) return // not a real file: leave it plain
    if (!el.isConnected) return
    applyDecoration(el, ref, absolute)
  })
}

/** Scan the whole document once (cheap: parse only undecorated code elements). */
function scanAll(ctx: Context): void {
  for (const raw of Array.from(document.querySelectorAll('code'))) {
    decorate(ctx, raw as HTMLElement)
  }
}

/**
 * Keep the decoration alive across React re-renders: a debounced
 * MutationObserver re-scans after DOM churn (React may reset className on
 * the elements it owns; the observer re-applies the class + title).
 */
function registerStyling(ctx: Context): () => void {
  if (document.body === null) return () => { /* no-op */ }
  const tag = injectStyles()
  let timer: number | null = null
  const schedule = (): void => {
    if (timer !== null) return
    timer = window.setTimeout(() => {
      timer = null
      scanAll(ctx)
    }, 150)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  scanAll(ctx)
  return () => {
    observer.disconnect()
    if (timer !== null) window.clearTimeout(timer)
    tag.remove()
  }
}

// ── Registration ────────────────────────────────────────────────────────────

/**
 * Mount the file:line link integration. Called once per client activation
 * (HMR-safe through the returned disposers).
 */
export function registerFileLink(ctx: Context, service: BetterSidebarService): () => void {
  const disposers = [
    registerClickDelegation(service),
    registerStyling(ctx),
  ]
  return () => {
    for (const dispose of disposers) dispose()
    if (pending !== null) pending = null
    clearLineHighlight()
  }
}
