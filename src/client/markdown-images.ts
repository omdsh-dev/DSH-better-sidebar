/**
 * Local-image resolution for the plugin's markdown surfaces.
 *
 * The shared `MarkdownText` renders absolute http(s) image destinations as
 * authored; a local destination (an image-relative `./img.png`, an absolute
 * `/cwd/img.png`, or a reference definition) is handed to the owner's
 * `pathImages` vocabulary, and only a miss falls back to the documented alt
 * text. That is the DSH renderer's sanctioned rewrite hook: the owner maps an
 * authored destination to a displayable absolute URL it vouches for.
 *
 * The base is what has to change for the desktop shell. Its page origin is
 * `dsh-app://app/` while the Host listens on another origin
 * (`__DSH_TRANSPORT__.streamBaseUrl`): an absolute http URL built from that
 * transport base is a CROSS-SITE subresource, so the Host's Connection fence
 * rejects it (403) and the image falls back to alt text. Two shapes survive:
 *
 * - **Browser** (page base is http(s)): the plugin's own `/sidebar/file`
 *   media route on the page base — same-origin as before, reverse-proxy
 *   prefix included.
 * - **Desktop shell** (page base is `dsh-app://app/`): the Host's
 *   authenticated `api/file?path=` route on the page base. The shell forwards
 *   every non-static `dsh-app://app/*` request to the Host with the launch
 *   cookie, and `dsh-app://app/api/file?...` is the one local-file URL shape
 *   the renderer's image vocabulary accepts. The built-in document preview
 *   resolves its markdown images the same way.
 *
 * Raw HTML leaves (`<img src="./x.png">`) are different: they render as plain
 * DOM elements, not through `MarkdownText`, so {@link resolveLocalMediaDest}
 * hands them the plugin media route on the page base directly — a plain
 * `<img>` has no protocol vocabulary to satisfy.
 */

import type { MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionScope } from './api.ts'
import { hostHttpBase } from './desktop-env.ts'
import { hostRouteUrl } from './host-route-url.ts'
import { isAbsolutePath } from './paths.ts'

/**
 * True for a destination that is a remote URL — an absolute `scheme:` URL
 * that is not a Windows drive path (`C:\...`). http/https/data/mailto etc.
 * all match here.
 */
function isRemoteUrl(dest: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(dest) && !/^[A-Za-z]:[\\/]/.test(dest)
}

/**
 * Collapse `.`/`..` segments of an absolute local path, preserving its root
 * (POSIX `/`), its Windows drive (`C:\`), or its UNC `\\server\share`
 * prefix. The host's `requireAbsolute` (`path.resolve`) normalizes anyway,
 * but producing a canonical path here keeps the media URLs clean.
 * Shared with the markdown navigation resolver (`markdown-navigation.ts`),
 * which canonicalizes a claimed link target the same way.
 */
export function normalizeLocalPath(path: string): string {
  const drive = /^([A-Za-z]:)[\\/]/.exec(path)?.[1]
  const body = drive !== undefined ? path.slice(drive.length) : path
  const parts = body.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  if (drive !== undefined) return `${drive}\\${out.join('\\')}`
  const separator = path.startsWith('\\') ? '\\' : '/'
  const root = path.startsWith('/') ? '/' : path.startsWith('\\') ? '\\\\' : ''
  return `${root}${out.join(separator)}`
}

/**
 * The absolute spelling of one target for routes that require it (the desktop
 * shell's host `api/file`): a relative target joins the session workspace
 * root. Returns undefined when the target is relative and no root is known —
 * the caller then falls back to alt text instead of an absolute-path 400.
 * @param target - A target produced by {@link markdownImageTarget}.
 * @param cwd - The session workspace root, when known.
 * @returns The absolute target, or undefined.
 */
function absoluteTarget(target: string, cwd: string | undefined): string | undefined {
  if (isAbsolutePath(target)) return target
  if (cwd === undefined || cwd === '') return undefined
  return normalizeLocalPath(`${cwd.replace(/[\\/]+$/, '')}/${target}`)
}

/**
 * Percent-decode one authored destination exactly once (the renderer hands
 * the rewrite hook the spelling the author wrote). A malformed escape is
 * refused rather than thrown.
 * @param value - The authored destination.
 * @returns The decoded destination, or undefined for a malformed escape.
 */
function decodeDestination(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

/**
 * The absolute local target of one markdown destination, or undefined when
 * the destination is not a local path this vocabulary serves. Relative
 * destinations resolve against the opened file's own directory; remote URLs,
 * `#`-anchors, empty destinations and queries are refused (the renderer keeps
 * its alt-text fallback for those).
 * The result may still be RELATIVE when the opened file's path is relative
 * (an editor tab opened from a chat address can carry a workspace-relative
 * path). The plugin media route accepts that together with `cwd`; the desktop
 * shell's host file route does not — see {@link absoluteTarget}.
 * @param destination - One decoded image destination.
 * @param filePath - The path of the opened `.md` file.
 * @returns The normalized target path, or undefined.
 */
export function markdownImageTarget(destination: string, filePath: string): string | undefined {
  const dest = destination.trim()
  if (dest === '' || dest.startsWith('#') || isRemoteUrl(dest)) return undefined
  // The host's file-link grammar refuses queries and scheme-relative forms.
  if (dest.includes('?') || /^[\\/]{2}/.test(dest)) return undefined
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const directory = slash === -1 ? '/' : filePath.slice(0, slash + 1)
  const candidate = isAbsolutePath(dest) ? dest : directory + dest
  return normalizeLocalPath(candidate)
}

/**
 * Absolute URL of the plugin's session media route for one local image,
 * resolved against the page base (browser deployments).
 * @param target - Local image path (absolute, or relative to `scope.cwd` when
 * the opened file itself carries a workspace-relative path).
 * @param scope - The session scope (sessionId + cwd) for the media route.
 * @param baseUrl - The page base (`hostHttpBase()`); injected for pure tests.
 * @returns The absolute media URL.
 */
export function markdownMediaUrl(target: string, scope: SessionScope, baseUrl: string): string {
  const params = new URLSearchParams({ sessionId: scope.sessionId, path: target })
  if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
  return hostRouteUrl(`sidebar/file?${params.toString()}`, baseUrl).href
}

/**
 * Absolute URL of the Host's authenticated file route on the page base — the
 * only local-file image shape the desktop shell page can display (see the
 * module comment).
 * @param target - Absolute local path of the image.
 * @param baseUrl - The page base (`dsh-app://app/`); injected for pure tests.
 * @returns The absolute file URL.
 */
export function desktopFileUrl(target: string, baseUrl: string): string {
  const params = new URLSearchParams({ path: target })
  return hostRouteUrl(`api/file?${params.toString()}`, baseUrl).href
}

/**
 * Build the `pathImages` vocabulary for one markdown surface: `MarkdownText`
 * asks it for an authored local image destination and gets back a displayable
 * absolute URL on the page base, so the same code works in a browser and in
 * the desktop shell.
 * @param scope - The session scope (sessionId + cwd) for the plugin media route.
 * @param filePath - The path of the opened `.md` file (may be workspace-relative).
 * @param baseUrl - The page base; defaults to `hostHttpBase()`.
 * @returns The owner's local-path image vocabulary.
 */
export function createMarkdownPathImages(
  scope: SessionScope,
  filePath: string,
  baseUrl: string = hostHttpBase(),
): MarkdownPathImages {
  let desktop = false
  try {
    desktop = new URL(baseUrl).protocol === 'dsh-app:'
  } catch {
    // Non-absolute/empty base (specs, non-DOM callers): the browser branch is
    // the only one whose URL builder does not need a real scheme.
  }
  return {
    resolve: (destination: string): string | undefined => {
      const decoded = decodeDestination(destination)
      if (decoded === undefined) return undefined
      const target = markdownImageTarget(decoded, filePath)
      if (target === undefined) return undefined
      if (!desktop) return markdownMediaUrl(target, scope, baseUrl)
      // The host file route requires an ABSOLUTE path (a relative one answers
      // 400 "absolute path required"); a relative tab path is the common case
      // for files opened from chat, so join the workspace root explicitly.
      const absolute = absoluteTarget(target, scope.cwd)
      return absolute === undefined ? undefined : desktopFileUrl(absolute, baseUrl)
    },
  }
}

/**
 * Resolve one raw-HTML media destination to a displayable URL: local
 * (relative or absolute) paths become absolute page-base `/sidebar/file` URLs,
 * while remote URLs, `#`-anchors and empty destinations are returned
 * untouched. Used by the preview's raw-HTML sanitizer (`MarkdownHtml.tsx`),
 * whose `<img src>` renders as plain DOM; markdown-syntax images go through
 * {@link createMarkdownPathImages} instead.
 * @param dest - One `src`/`poster` value from the sanitized HTML.
 * @param scope - The session scope (sessionId + cwd) for the media route.
 * @param filePath - The path of the opened `.md` file (may be workspace-relative).
 * @param baseUrl - The page base (`hostHttpBase()`); injected for pure tests.
 * @returns The rewritten source (untouched for remote/anchor/empty values).
 */
export function resolveLocalMediaDest(
  dest: string,
  scope: SessionScope,
  filePath: string,
  baseUrl: string,
): string {
  const trimmed = dest.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return dest
  if (isRemoteUrl(trimmed)) return dest
  const decoded = decodeDestination(trimmed)
  if (decoded === undefined) return dest
  const target = markdownImageTarget(decoded, filePath)
  if (target === undefined) return dest
  return markdownMediaUrl(target, scope, baseUrl)
}
