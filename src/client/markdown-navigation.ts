/**
 * Cross-file / anchor navigation for the markdown the PLUGIN draws (the editor
 * preview, the side-chat transcript, the changes reading pane, a task note).
 *
 * THE HOST CONTRACT this module works against (DSH 0.2.0-rc.1,
 * `@deepseek-ai/dsh-client-ui-primitives`): `MarkdownText` renders a local
 * destination as a clickable file link ONLY when a surrounding
 * `MarkdownDelegateProvider` supplies `openFile` — otherwise the link is plain
 * text, and there is no `a[href]` for a click listener to intercept. Worse for
 * us, its `parseFileLink` accepts a fragment ONLY in the line grammar
 * (`#L24` / `#L24-L30`); a heading fragment (`./other.md#标题`) makes the whole
 * destination invalid, so the link would render as inert prose. That is why
 * this module owns a SOURCE rewrite as well as a DOM pass — the same shape
 * `markdown-images.ts` already has (images are rewritten into absolute
 * `/sidebar/file` URLs because the renderer refuses relative ones):
 *
 * - {@link rewriteLocalMarkdownLinks} (source, before rendering): a claimed
 *   link's non-line fragment is carried past the host parser as `%23` (an
 *   encoded `#`, decoded back by the host into the path it hands `openFile`);
 *   a local destination the plugin does NOT claim gets a `?` appended, which
 *   `parseFileLink` refuses — the link keeps rendering as plain text instead of
 *   becoming a file-mention button that would do nothing.
 * - {@link markdownAnchorTarget} (pure judge): turns either shape back into
 *   "same document fragment" / "file to open" / "not ours".
 * - {@link assignHeadingIds} + {@link hideEmptyAnchors} (DOM, after rendering):
 *   GitHub-style heading slugs (the renderer ships bare `h1..h6`), and the
 *   explicit `<a id="x"></a>` anchors collapsed without losing their id.
 *
 * Relative targets resolve against the RENDERED DOCUMENT's own directory (a
 * link in `/ws/docs/README.md` is relative to `/ws/docs`), falling back to the
 * session cwd for prose surfaces that render no file at all.
 *
 * Cross-file fragments travel through {@link rememberMarkdownAnchor}: the click
 * happens on the SOURCE document's surface while the jump belongs to the TARGET
 * document, which does not exist yet — so the fragment is parked by session +
 * absolute path and taken by the target's own surface once it mounts. The
 * host's routing is untouched.
 *
 * KNOWN NARROW EDGES (deliberate, recorded rather than fixed — neither one
 * corrupts anything):
 * - A destination containing an ESCAPED parenthesis (`[x](./a\(1\).md)`) or a
 *   single-quoted title (`[x](./a.md 'title')`) does not match the link grammar
 *   below, so {@link rewriteLocalMarkdownLinks} never claims it. It keeps
 *   rendering as plain text — exactly what it did before this feature existed,
 *   i.e. no regression, but also no jump.
 * - A `#L24` line destination is left to the host (it rides `options.line`), so
 *   nothing scrolls the opened file to line 24.
 */
import { maskCodeRegions } from './markdown-code.ts'
import { normalizeLocalPath } from './markdown-images.ts'
import { isAbsolutePath } from './paths.ts'

/** Vertical breathing room above a jumped-to heading (px). */
const SCROLL_TOP_PADDING = 8

/** How long a parked cross-file fragment stays eligible (ms). A click whose
 *  open never lands must not make an unrelated later open of the same file
 *  jump; the newest click for a key always replaces the previous one. */
const PENDING_TTL_MS = 15_000

/** The fragment separator this module writes into a source destination
 *  (`%23` = an encoded `#`) so a heading fragment survives the host's parser. */
const ENCODED_HASH = '%23'

/** What a clicked link inside a plugin markdown surface resolves to. */
export type MarkdownAnchorTarget =
  | {
    /** A fragment of the SAME document: scroll the preview's own scroller. */
    kind: 'same-page'
    /** The percent-decoded fragment (`''` for a bare `#` — the document top). */
    fragment: string
  }
  | {
    /** A markdown file to open in the sidebar. */
    kind: 'file'
    /** Absolute target path (`.`/`..` collapsed), or the cwd-relative spelling
     *  when the surface has no base to resolve against. */
    path: string
    /** The percent-decoded fragment to land on once the file has rendered. */
    fragment: string
  }

/** A URL scheme (`https:`, `mailto:`, `data:`). */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
/** A Windows drive prefix: `C:\x.md` matches {@link SCHEME_RE} but is a path. */
const DRIVE_RE = /^[A-Za-z]:[\\/]/
/** The extensions a markdown link may claim (this batch claims markdown only —
 *  a `.txt`/`.png`/`.ts` link keeps the browser's own behavior). */
const MARKDOWN_EXT_RE = /\.(?:md|markdown)$/i
/** The host's own fragment grammar for a line destination (`#L24`, `#L24-L30`). */
const HOST_LINE_FRAGMENT_RE = /^L[1-9]\d*(?:-L[1-9]\d*)?$/

/** Whether a fragment is the host's line destination rather than an anchor. */
export function isHostLineFragment(fragment: string): boolean {
  return HOST_LINE_FRAGMENT_RE.test(fragment)
}

/** Percent-decode one URL piece, tolerating a malformed escape (a literal `%`). */
function decodePercent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** The directory part of a path, trailing separator included (`''` when none). */
function directoryOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? '' : path.slice(0, at + 1)
}

/** Join a directory and a relative path with `/` (normalized by the caller). */
function joinPath(directory: string, relative: string): string {
  if (directory === '') return relative
  return `${directory.replace(/[\\/]+$/, '')}/${relative}`
}

/** One destination's fragment separator: its offset and its length. */
interface FragmentSeparator {
  at: number
  length: number
}

/**
 * Find a destination's fragment separator — a literal `#` (as authored, or as
 * the host hands a decoded destination back to `openFile`) or the encoded
 * `%23` this module writes into the source. Returns null when there is none.
 */
function separatorOf(destination: string): FragmentSeparator | null {
  const literal = destination.indexOf('#')
  const encoded = destination.indexOf(ENCODED_HASH)
  if (literal === -1 && encoded === -1) return null
  if (literal === -1) return { at: encoded, length: ENCODED_HASH.length }
  if (encoded === -1 || literal < encoded) return { at: literal, length: 1 }
  return { at: encoded, length: ENCODED_HASH.length }
}

/**
 * The characters GitHub's heading slug DROPS beyond punctuation and symbols:
 * pictographs (every emoji), the variation selectors that follow a good many of
 * them (`🖼️` is U+1F5BC + U+FE0F — GitHub's own pipeline renders an emoji as an
 * `<img>`, so neither character reaches the slug text), regional-indicator pairs
 * (flag emoji, which are `\p{So}` but outside `Extended_Pictographic`), and the
 * control/format/unassigned characters. Combining marks are deliberately NOT
 * here — `\p{M}` survives, as it does on GitHub.
 */
// eslint-disable-next-line no-misleading-character-class -- the ranges are deliberate, not a mis-ordered surrogate pair
const DROPPED_EXTRA_RE = /[\p{Extended_Pictographic}\u{1F000}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\p{C}]/gu

/**
 * The GitHub heading slug of one heading's text — the id GitHub itself would
 * give that heading, so the anchors a README's table of contents carries
 * resolve. GitHub's slugger (`github-slugger`) lower-cases ASCII, drops
 * punctuation and symbols, and turns EACH space into its own `-`; it does not
 * trim and does not collapse runs, which is why `## 🛠️ Development & Build`
 * has the id `-development--build` (the leading dash is the space the emoji
 * left behind, the double dash is the removed `&`). Letters, digits and
 * combining marks of ANY script survive, so a Chinese heading keeps its own
 * text as its id.
 *
 * The one deliberate difference from `github-slugger` is where the emoji are
 * removed: GitHub strips them while rendering the heading (to `<img>`), before
 * the slugger ever sees the text, so a slugger run on plain text would keep
 * `🚀` and produce `🚀-安装` instead of GitHub's real `-安装`. This function
 * drops them here, in the same pass, which yields GitHub's actual ids.
 * @param text - the heading's rendered text.
 * @returns the slug (`''` for a heading with no letters or digits at all).
 */
export function githubHeadingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(DROPPED_EXTRA_RE, '')
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-')
}

/**
 * Give every heading under `root` a slug `id`, in document order, `-1`/`-2`
 * suffixed on repeats. Authored ids are kept AND reserved first, so a generated
 * slug can never collide with an explicit anchor later in the document; a
 * heading whose text carries no letters or digits is left alone (an empty id
 * resolves nothing). Idempotent: a second pass over the same tree — the
 * mutation re-runs the surface installer depends on — changes nothing.
 * @param root - the surface container (React owns the tree; ids live outside
 *   React's props, so React never removes them).
 */
export function assignHeadingIds(root: ParentNode): void {
  const headings = [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')]
  const taken = new Set<string>()
  for (const heading of headings) {
    if (heading.id !== '') taken.add(heading.id)
  }
  for (const heading of headings) {
    if (heading.id !== '') continue
    const base = githubHeadingSlug(heading.textContent ?? '')
    if (base === '') continue
    let id = base
    for (let suffix = 1; taken.has(id); suffix += 1) id = `${base}-${suffix}`
    heading.id = id
    taken.add(id)
  }
}

/**
 * Collapse the explicit anchors GitHub-style READMEs carry (`<a id="x"></a>`):
 * an `<a>` with an id, no child elements and no text is marked `hidden` — out
 * of the way visually, still in the DOM, so `#x` deep links (and the jump
 * helper below) still resolve. Anchors with any content are untouched.
 * @param root - the surface container.
 */
export function hideEmptyAnchors(root: ParentNode): void {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[id]')) {
    if (anchor.children.length > 0) continue
    if ((anchor.textContent ?? '').trim() !== '') continue
    anchor.hidden = true
  }
}

/** One post-render pass: heading ids plus empty-anchor collapsing. */
export function prepareMarkdownAnchors(root: ParentNode): void {
  assignHeadingIds(root)
  hideEmptyAnchors(root)
}

/**
 * The pure link judge: what a destination inside a plugin markdown surface
 * means, or null to leave it entirely alone.
 *
 * Fed either shape the pipeline produces — a destination as authored (the
 * source rewriter's input) or the decoded destination the host hands
 * `openFile` (where this module's `%23` has already become a `#`).
 * @param destination - the link destination (a raw `href`-style string).
 * @param docPath - the absolute path of the markdown document being rendered;
 *   relative targets resolve against its directory. Absent for prose surfaces.
 * @param cwd - the session workspace root, the base for prose surfaces.
 * @returns the resolved target, or null for every link the plugin does not own.
 */
export function markdownAnchorTarget(
  destination: string,
  docPath: string | undefined,
  cwd: string | undefined,
): MarkdownAnchorTarget | null {
  const raw = destination.trim()
  if (raw === '') return null
  const separator = separatorOf(raw)
  const pathPart = separator === null ? raw : raw.slice(0, separator.at)
  const fragment = separator === null ? '' : decodePercent(raw.slice(separator.at + separator.length))
  // `#标题` / `#` — the document's own fragment.
  if (pathPart === '') return { kind: 'same-page', fragment }
  // `https://…`, `mailto:…`, `data:…` — never ours (a drive letter is a path).
  if (SCHEME_RE.test(pathPart) && !DRIVE_RE.test(pathPart)) return null
  // `//host/x.md` — a scheme-relative URL, i.e. remote too.
  if (pathPart.startsWith('//')) return null
  const path = decodePercent(pathPart)
  if (!MARKDOWN_EXT_RE.test(path)) return null
  return { kind: 'file', path: resolveTargetPath(path, docPath, cwd), fragment }
}

/**
 * Resolve a claimed markdown destination against the document that authored it.
 * Absolute paths (POSIX, drive, UNC) are normalized in place; a relative path
 * joins the document's own directory (or the session cwd); with neither base
 * known the relative spelling is handed on untouched for the opener to resolve
 * against the session cwd.
 */
function resolveTargetPath(path: string, docPath: string | undefined, cwd: string | undefined): string {
  if (isAbsolutePath(path)) return normalizeLocalPath(path)
  const directory = docPath !== undefined && docPath !== '' ? directoryOf(docPath) : (cwd ?? '')
  if (directory === '') return path.replace(/^(?:\.\/)+/, '').replace(/\\/g, '/')
  return normalizeLocalPath(joinPath(directory, path))
}

/**
 * Whether a destination's path part is a LOCAL path the host would otherwise
 * turn into a clickable file link (once a surface provides `openFile`). Remote
 * URLs, scheme-relative URLs and anything already carrying a query (which
 * `parseFileLink` refuses on its own) are excluded.
 */
function isLocalDestination(pathPart: string): boolean {
  if (pathPart === '' || pathPart.includes('?')) return false
  if (pathPart.startsWith('//')) return false
  if (SCHEME_RE.test(pathPart) && !DRIVE_RE.test(pathPart)) return false
  return true
}

/**
 * Rewrite ONE destination for the host renderer (see the module comment).
 * Idempotent: an already-rewritten `%23` destination, a line destination and a
 * fragment-less link all come back untouched.
 */
function rewriteDestination(destination: string, docPath: string | undefined, cwd: string | undefined): string {
  const separator = separatorOf(destination)
  const pathPart = separator === null ? destination : destination.slice(0, separator.at)
  const fragment = separator === null ? '' : destination.slice(separator.at + separator.length)
  if (markdownAnchorTarget(destination, docPath, cwd) === null) {
    // Not ours: a remote link keeps its own anchor; a local one is pinned back
    // to plain text (`parseFileLink` refuses a destination carrying a query),
    // so the surface's delegate never offers an action it would not serve.
    if (!isLocalDestination(pathPart)) return destination
    const rest = separator === null ? '' : destination.slice(separator.at)
    return `${pathPart}?${rest}`
  }
  // Claimed. Nothing to carry without a fragment, `%23` is already ours, and a
  // line destination belongs to the host's own grammar.
  if (separator === null || separator.length === ENCODED_HASH.length) return destination
  if (isHostLineFragment(fragment)) return destination
  // A `?` inside the fragment must be encoded too: the host refuses a
  // destination that carries a query (it looks for the `?` before decoding),
  // so an unencoded one would turn the link back into plain text.
  return `${pathPart}${ENCODED_HASH}${fragment.replace(/\?/g, '%3F')}`
}

/**
 * Make the host renderer able to SERVE the local links of one markdown text:
 * a claimed `.md`/`.markdown` destination gets its heading fragment carried as
 * `%23`, and every other local destination gets the `?` that keeps it inert.
 *
 * Code regions are masked first (see `maskCodeRegions` — fenced blocks opened
 * by ``` ``` ``` OR `~~~`, and inline code spans), so documentation that
 * demonstrates `[x](./a.md#标题)` is not mutated. Image destinations are left
 * to `rewriteLocalImageUrls` (which must run FIRST: it rewrites the definitions
 * an image uses into absolute media URLs, which this pass then ignores).
 * @param text - the markdown source about to be rendered.
 * @param docPath - the rendered document's absolute path (relative-link base).
 * @param cwd - the session workspace root, the base for prose surfaces.
 * @returns the markdown with local link destinations rewritten in place.
 */
export function rewriteLocalMarkdownLinks(
  text: string,
  docPath: string | undefined,
  cwd: string | undefined,
): string {
  const { masked, restore } = maskCodeRegions(text)

  const links = masked
    // Inline links. The negative lookbehind keeps IMAGE destinations out, and
    // the label may hold ONE nested bracket pair — `[![badge](./b.svg)](./x.md)`
    // is a README staple, and matching only up to the inner `]` would read the
    // badge's own destination as the link's. The label is re-emitted verbatim,
    // so nested content keeps whatever the image pass gave it.
    .replace(
      /(?<!!)\[((?:[^[\]]|\[[^\]]*\])*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
      (_match, label: string, destination: string, title: string) =>
        `[${label}](${rewriteDestination(destination, docPath, cwd)}${title})`,
    )
    // Reference definitions. Every local one is fair game: a definition an
    // image uses was already turned into an absolute media URL by the image
    // pass, and an absolute http(s) URL is never touched here.
    .replace(
      /^(\s*\[([^\]]+)\]:\s*)(<[^>]+>|[^\s]+)/gm,
      (_match, head: string, _label: string, destination: string) => {
        // A `<…>` destination keeps its brackets: they are what lets the path
        // carry a space, and dropping them would truncate the link.
        const bracketed = destination.startsWith('<') && destination.endsWith('>')
        const inner = bracketed ? destination.slice(1, -1) : destination
        const rewritten = rewriteDestination(inner, docPath, cwd)
        return `${head}${bracketed ? `<${rewritten}>` : rewritten}`
      },
    )

  return restore(links)
}

/**
 * The element a fragment names, or null. Both the fragment as written and its
 * slug form are tried, so `#Some Heading` and `#some-heading` both land. The
 * scan is a linear walk over `[id]` rather than a selector: ids come from
 * arbitrary markdown text and need no CSS escaping this way.
 * @param root - the surface container.
 * @param fragment - the percent-decoded fragment.
 */
function findAnchorTarget(root: ParentNode, fragment: string): HTMLElement | null {
  const wanted = new Set([fragment, githubHeadingSlug(fragment)])
  wanted.delete('')
  if (wanted.size === 0) return null
  for (const element of root.querySelectorAll<HTMLElement>('[id]')) {
    if (wanted.has(element.id)) return element
  }
  return null
}

/** Whether an element can scroll its own content right now. */
function isScrollable(element: HTMLElement): boolean {
  const overflowY = window.getComputedStyle(element).overflowY
  return (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
    && element.scrollHeight > element.clientHeight
}

/**
 * The scroller a jump writes to: the nearest scrollable ancestor of the surface
 * container — the preview's own scroll box — falling back to the container
 * itself. Never `window.scrollTo` (nor `scrollIntoView`, which walks every
 * scrollable ancestor and would drag the whole sidebar).
 */
function scrollHostFor(container: HTMLElement): HTMLElement {
  for (let node: HTMLElement | null = container; node !== null; node = node.parentElement) {
    if (isScrollable(node)) return node
  }
  return container
}

/**
 * A `hidden` element has no layout box, so measuring it would report the
 * viewport origin: resolve a hidden explicit anchor through its nearest visible
 * ancestor, which is exactly where the id sits in the flow.
 */
function visibleAncestorOf(target: HTMLElement): HTMLElement {
  let node = target
  while (node.hidden && node.parentElement !== null) node = node.parentElement
  return node
}

/**
 * Scroll one element to the top of the surface's own scroller (the measured box
 * of `container`, so nothing outside it moves).
 * @param container - the surface container.
 * @param target - the element to reveal.
 */
function scrollAnchorIntoView(container: HTMLElement, target: HTMLElement): void {
  const scroller = scrollHostFor(container)
  const box = visibleAncestorOf(target)
  const offset = box.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  scroller.scrollTop = Math.max(0, offset - SCROLL_TOP_PADDING)
}

/**
 * Land `fragment` inside `container`: open a collapsed `<details>` ancestor
 * (the same courtesy the preview's own outline pays) and scroll the surface's
 * own scroller. A missing target is a silent no-op — a stale link must neither
 * throw nor move the reader.
 * @returns whether the document actually carries the fragment.
 */
export function jumpToFragment(container: HTMLElement, fragment: string): boolean {
  // A bare `#` link means "back to the top" (READMEs use it as such).
  if (fragment === '') {
    scrollHostFor(container).scrollTop = 0
    return true
  }
  const target = findAnchorTarget(container, fragment)
  if (target === null) return false
  target.closest('details:not([open])')?.setAttribute('open', '')
  scrollAnchorIntoView(container, target)
  return true
}

/** The pending cross-file fragments, keyed by session + absolute target path. */
const pendingAnchors = new Map<string, { fragment: string; at: number }>()

/** The lookup key of one document: session + its path, separator- and
 *  traversal-normalized so the two spellings a surface and the editor hold
 *  (`/p/a.md` vs `\p\a.md`, cwd-relative vs absolute) meet. */
function anchorKey(sessionId: string, cwd: string | undefined, path: string): string {
  const absolute = isAbsolutePath(path) ? path : joinPath(cwd ?? '', path)
  return `${sessionId}::${normalizeLocalPath(absolute).replace(/\\/g, '/')}`
}

/**
 * Park the fragment a cross-file link wants to land on, for the target
 * document's own surface to take once it mounts.
 * @param sessionId - the session both documents live in.
 * @param cwd - that session's workspace root (path resolution).
 * @param path - the target file (absolute, or cwd-relative).
 * @param fragment - the decoded fragment (`''` parks nothing).
 */
export function rememberMarkdownAnchor(
  sessionId: string,
  cwd: string | undefined,
  path: string,
  fragment: string,
): void {
  if (fragment === '') return
  pendingAnchors.set(anchorKey(sessionId, cwd, path), { fragment, at: Date.now() })
}

/**
 * Take (and clear) the fragment parked for one document. The entry is always
 * consumed — a surface that takes it and finds no such heading does not leave
 * it behind for a later, unrelated open.
 * @returns the fragment, or null when nothing (fresh) is parked.
 */
export function takeMarkdownAnchor(sessionId: string, cwd: string | undefined, path: string): string | null {
  const key = anchorKey(sessionId, cwd, path)
  const entry = pendingAnchors.get(key)
  if (entry === undefined) return null
  pendingAnchors.delete(key)
  return Date.now() - entry.at > PENDING_TTL_MS ? null : entry.fragment
}
