/**
 * React glue for ONE plugin-drawn markdown surface (the container that holds
 * the rendered markdown). It returns three things the caller wires up:
 *
 * - `surfaceRef`: a CALLBACK REF for that container. The installer behind it
 *   runs the DOM pass from `markdown-navigation.ts` (heading slugs + collapsed
 *   explicit anchors) on mount and after every content mutation — the pattern
 *   the raw-HTML preview pass already uses, which keeps late content (the lazy
 *   mermaid chunk, shiki highlighting) covered and makes the pass self-healing
 *   when React re-renders a subtree it owns — and then applies the cross-file
 *   fragment parked for this document. A callback ref (not a `RefObject`)
 *   because the container mounts and unmounts with its host — the preview
 *   container disappears on every preview→edit flip — and only a ref callback
 *   fires on both edges (React 18 hands it `null` on unmount, which is where
 *   the observer is torn down). Its identity is keyed on (session, path) alone,
 *   so an ordinary re-render never detaches anything.
 * - `openFile`: the host delegate's file handler. The host renderer only makes
 *   a local markdown link clickable when a `MarkdownDelegateProvider` supplies
 *   this, which is why every caller wraps its markdown in that provider with
 *   `openFile={surface.openFile}`: the provider's scope IS the claim boundary,
 *   and a link rendered outside it (the host's chat prose, any other panel) is
 *   never seen by this plugin.
 * - `rewrite`: the source-side pass (`rewriteLocalMarkdownLinks`) that runs
 *   BEFORE rendering, so a heading fragment survives the host's parser and a
 *   link the plugin does not claim stays inert prose.
 */
import { useCallback, useRef } from 'react'
import type { Context } from '../context-types.ts'
import {
  jumpToFragment,
  lineOfHostFragment,
  markdownAnchorTarget,
  prepareMarkdownAnchors,
  rememberMarkdownAnchor,
  rewriteLocalMarkdownLinks,
  takeMarkdownAnchor,
} from './markdown-navigation.ts'
import { openSidebarFile } from './sidebar-file.ts'

/** The DOM marker the installer puts on the container it owns (the claim
 *  boundary is the provider scope; this makes the surface inspectable in a
 *  browser and pointable from a spec). */
export const MARKDOWN_SURFACE_ATTR = 'data-dsh-md-surface'

export interface MarkdownSurfaceOptions {
  /** Client context: the open goes through `openSidebarFile`, the plugin's own
   *  claim-aware editor path (same entry point the file tree and the chat
   *  mentions use). */
  ctx: Context
  /** The session the markdown renders in — the open scope and the key of the
   *  pending-fragment table. */
  sessionId: string
  /** The session workspace root, when the caller has a scope. Read live at
   *  click time (a session's cwd may land after the tab does). */
  cwd?: string
  /** The rendered file's absolute path: relative targets resolve against its
   *  directory. Prose surfaces (transcript, task note) omit it — their
   *  relative targets resolve against the session cwd instead. */
  path?: string
}

/** What a surface wires into its markup. */
export interface MarkdownSurfaceBinding {
  /** Callback ref for the container that holds the rendered markdown. */
  surfaceRef: (element: HTMLElement | null) => void
  /** `MarkdownDelegateProvider.openFile` for this surface. */
  openFile: (destination: string, options?: { line?: number }) => void
  /** Rewrite one markdown text before rendering it in this surface. */
  rewrite: (text: string) => string
}

/**
 * Wire one plugin markdown surface.
 * @param opts - the surface's context, session and rendered document path.
 * @returns the container ref, the delegate handler and the source rewrite.
 */
export function useMarkdownSurface(opts: MarkdownSurfaceOptions): MarkdownSurfaceBinding {
  const { ctx, sessionId, cwd, path } = opts
  const containerRef = useRef<HTMLElement | null>(null)
  const detachRef = useRef<(() => void) | null>(null)

  /** The session workspace root: the caller's scope when it has one, else the
   *  session summary (a stripped-down host or a bare spec context may have no
   *  session list at all — the opener then resolves against its own cwd). */
  const resolveCwd = useCallback(
    (): string | undefined => cwd ?? ctx.sessions?.list?.getSnapshot?.()?.byId?.[sessionId]?.cwd,
    [ctx, sessionId, cwd],
  )

  const surfaceRef = useCallback((element: HTMLElement | null): void => {
    detachRef.current?.()
    detachRef.current = null
    containerRef.current = element
    if (element === null) return
    detachRef.current = attachMarkdownSurface(element, sessionId, path, resolveCwd)
  }, [sessionId, path, resolveCwd])

  const openFile = useCallback((destination: string, options?: { line?: number }): void => {
    const target = markdownAnchorTarget(destination, path, resolveCwd())
    if (target === null) return
    if (target.kind === 'same-page') {
      const container = containerRef.current
      if (container !== null) jumpToFragment(container, target.fragment)
      return
    }
    // `#L24` is a LINE, not an anchor: the host hands the number over as
    // `options.line` (and leaves the destination untouched), the fragment is
    // the same grammar for a caller that only has the destination. Either way
    // the line has to travel WITH the open — a line reference asks for source,
    // so the editor lands on it (and leaves preview, which renders no lines).
    // Only a heading fragment parks a jump for the document about to open.
    const line = options?.line ?? lineOfHostFragment(target.fragment)
    if (line === undefined && target.fragment !== '') {
      rememberMarkdownAnchor(sessionId, resolveCwd(), target.path, target.fragment)
    }
    try {
      openSidebarFile(ctx, sessionId, target.path, line)
    } catch (error) {
      // A failed open leaves the reader where they are (the link was claimed);
      // the parked fragment expires on its own.
      console.error('[dsh-better-sidebar] markdown file link open failed', error)
    }
  }, [ctx, sessionId, path, resolveCwd])

  const rewrite = useCallback(
    (text: string): string => rewriteLocalMarkdownLinks(text, path, resolveCwd()),
    [path, resolveCwd],
  )

  return { surfaceRef, openFile, rewrite }
}

/**
 * Install the post-render half on one container: the DOM pass, its mutation
 * re-runs, and the pending cross-file fragment.
 * @returns the disposer (observer + marker).
 */
function attachMarkdownSurface(
  container: HTMLElement,
  sessionId: string,
  path: string | undefined,
  resolveCwd: () => string | undefined,
): () => void {
  container.setAttribute(MARKDOWN_SURFACE_ATTR, '')
  prepareMarkdownAnchors(container)

  /** The fragment this surface still owes the reader (taken once, then carried
   *  here until the heading actually renders — the content may arrive a beat
   *  after the container does). */
  let pending: string | null = path === undefined || path === '' ? null : takeMarkdownAnchor(sessionId, resolveCwd(), path)
  const applyPending = (): void => {
    if (pending !== null && jumpToFragment(container, pending)) pending = null
  }
  // After the commit that mounted this container: the host's layout effects
  // (the preview's remembered-scroll restore) run first, so this is the last
  // write to the scroller.
  if (pending !== null) queueMicrotask(applyPending)

  let scheduled: number | undefined
  const observer = new MutationObserver(() => {
    if (scheduled !== undefined) return
    // Coalesce a burst of mutations into one DOM pass: each pass walks the
    // whole preview, and diagram swapping / shiki settling emit many mutations.
    scheduled = window.setTimeout(() => {
      scheduled = undefined
      prepareMarkdownAnchors(container)
      applyPending()
    }, 80)
  })
  observer.observe(container, { childList: true, subtree: true })

  return () => {
    observer.disconnect()
    if (scheduled !== undefined) window.clearTimeout(scheduled)
    container.removeAttribute(MARKDOWN_SURFACE_ATTR)
  }
}
