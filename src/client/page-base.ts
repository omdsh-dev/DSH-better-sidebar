/**
 * Where dsh's root is, as seen from the page.
 *
 * dsh registers every host route at its own root (`/sidebar/...`), but a reverse proxy may publish
 * dsh under a path (`https://host/<site>/`). The served index then carries a `<base href>` naming
 * that mount, and a root-absolute URL (`/sidebar/api/x`) would skip the base tag and ask the host's
 * bare root, where nothing of dsh's listens. Without a `<base>` the page is at the root and every
 * root-relative path is right as it is — so these helpers change nothing there.
 *
 * Same rule as `pageBase`/`dshUrl` in `@deepseek-ai/dsh-client-connection/client`
 * (`vendor/deepseek-harness/packages/client/connection/src/client/page-base.ts`), kept local: a
 * plugin's client bundle may not value-import another plugin's (the purity gate in dsh's
 * `tsdown.client.ts`), and the installed connection package may predate the helper.
 */

/** The page's `<base href>` as an absolute URL ending in `/`, or null when the page has none. */
export function pageBase(): string | null {
  const doc = (globalThis as { document?: { querySelector?: (selector: string) => { href?: string } | null } }).document
  const href = doc?.querySelector?.('base[href]')?.href
  if (typeof href !== 'string' || !/^https?:\/\//.test(href)) return null
  return href.endsWith('/') ? href : `${href}/`
}

/**
 * A root-relative dsh path placed under the page's mount when it has one.
 * @param path - a path as dsh registers it, `/sidebar/api/list`.
 * @returns the absolute URL under `<base href>`, or `path` unchanged when the page has no base.
 */
export function dshUrl(path: string): string {
  const base = pageBase()
  if (base === null || !path.startsWith('/') || path.startsWith('//')) return path
  return new URL(path.slice(1), base).href
}

/**
 * The origin-plus-mount prefix (`https://host/site.example`, no trailing slash) for callers that
 * concatenate a root path themselves; the bare origin when the page has no base.
 * @returns an absolute prefix a `/sidebar/...` path can be appended to.
 */
export function dshRoot(): string {
  const base = pageBase()
  if (base === null) return (globalThis as { location?: { origin?: string } }).location?.origin ?? ''
  return base.slice(0, -1)
}
