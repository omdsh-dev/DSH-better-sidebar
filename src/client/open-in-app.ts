/**
 * The client half of "open with an application" — a thin adapter over DSH's
 * OWN open-in-app capability, replacing the plugin's former home-grown
 * vocabulary (URL templates, SSH hosts, custom editors, a spawn route).
 *
 * Two host facilities back this, and the adapter simply picks the right one:
 *
 * - The Host Remote (`ctx.remote.session`): `canOpenWorkspacePath()` reports
 *   whether this deployment can hand a path to a native desktop,
 *   `workspacePathApplications({path})` lists the OS handlers REGISTERED for
 *   one file, and `openWorkspacePath({path, action?, application?})` opens a
 *   path or reveals it in the file manager. The host validates the path and
 *   the application id before spawning anything.
 * - The host's webServer routes: `GET /open-in-app/apps` is the probed
 *   application CATALOG (menu order) and `POST /open-in-app/open` launches
 *   one catalog app on a DIRECTORY — the "open this workspace in VS Code"
 *   gesture. Catalog ids are not file-handler ids, so `open()` tries the
 *   Remote first and falls back to the catalog route.
 *
 * Everything degrades to "no control" when the host says the desktop is
 * unavailable: the caller hides the section instead of offering dead rows.
 */
import { hostT } from './locales.ts'

/** The host route paths (see `@deepseek-ai/dsh-host-open-in-app/shared`). */
const APPS_PATH = '/open-in-app/apps'
const ICON_PATH = '/open-in-app/icon'
const OPEN_PATH = '/open-in-app/open'

/** One application that can open the path. */
export interface OpenInAppEntry {
  /** Host-side id: an OS handler id for files, a catalog id for directories. */
  id: string
  /** Display name (the OS reports handlers; the catalog id is localized). */
  name: string
  /** PNG/SVG data URL for a handler, an icon route for a catalog app, else null. */
  icon: string | null
  /** Whether the OS reports it as the default handler (files only). */
  isDefault: boolean
}

/** The adapter the pages consume. */
export interface OpenInApp {
  /** Whether the host can open paths on a desktop; null until probed. */
  available(): boolean | null
  /** Probe availability once (shared across callers). */
  probe(): Promise<boolean>
  /** The installed-application catalog, in host menu order (directories). */
  directoryApps(): Promise<readonly OpenInAppEntry[]>
  /** The OS handlers registered for one file, or null when the query failed. */
  fileApps(path: string): Promise<readonly OpenInAppEntry[] | null>
  /** Open a path with its default handler, or with one explicit application. */
  open(path: string, application?: string): Promise<boolean>
  /** Reveal a path in the OS file manager. */
  reveal(path: string): Promise<boolean>
}

/** The slice of `ctx.remote.session` this module calls (structurally typed). */
interface SessionRemote {
  canOpenWorkspacePath(): Promise<{ ok: boolean; value?: boolean }>
  workspacePathApplications(request: { path: string }): Promise<{ ok: boolean; value?: readonly RawFileApplication[] }>
  openWorkspacePath(request: { path: string; action?: 'reveal'; application?: string }): Promise<{ ok: boolean }>
}

/** The host's `NativeFileApplication` shape. */
interface RawFileApplication {
  id: string
  name: string
  default: boolean
  icon: string | null
}

/** A ctx that can resolve client services (the cordis client root). */
interface CtxLike {
  get(name: string): unknown
}

/** The host's `open-in-app` locale namespace, read through the plugin's bridge. */
function appLabel(id: string): string {
  const text = hostT('open-in-app', `app.${id}`)
  if (text !== undefined) return text
  // The namespace may be absent (host older than the capability): fall back to
  // a readable form of the id itself.
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/**
 * The remote namespace, or undefined when the client assembly lacks it.
 *
 * Cordis throws when a service (or a nested property of one) is read without
 * a matching `inject` entry — the client bundle declares `remote` and
 * `remote.session` for exactly this call, but a composition that mounts the
 * sidebar without the Host Remote assembly must degrade to "no control"
 * instead of taking a render down with it, so the read is guarded.
 */
function remoteOf(ctx: CtxLike): SessionRemote | undefined {
  try {
    const remote = ctx.get('remote') as { session?: SessionRemote } | undefined | null
    const session = remote?.session
    return session !== undefined && typeof session.openWorkspacePath === 'function' ? session : undefined
  } catch {
    return undefined
  }
}

/** Build the adapter for one client ctx. */
export function createOpenInApp(ctx: CtxLike): OpenInApp {
  const remote = remoteOf(ctx)
  /** Tri-state availability; one shared probe per page. */
  let availability: boolean | null = null
  let probing: Promise<boolean> | null = null

  const probe = async (): Promise<boolean> => {
    if (availability !== null) return availability
    if (remote === undefined) {
      availability = false
      return false
    }
    probing ??= remote.canOpenWorkspacePath()
      .then(result => {
        availability = result.ok && result.value === true
        return availability
      })
      .catch(() => {
        availability = false
        return false
      })
      .finally(() => { probing = null })
    return probing
  }

  const directoryApps = async (): Promise<readonly OpenInAppEntry[]> => {
    if (!await probe()) return []
    try {
      const response = await fetch(APPS_PATH)
      if (!response.ok) return []
      const payload = await response.json() as { apps?: unknown }
      const ids = Array.isArray(payload.apps) ? payload.apps.filter((id): id is string => typeof id === 'string') : []
      return ids.map(id => ({
        id,
        name: appLabel(id),
        icon: `${ICON_PATH}/${encodeURIComponent(id)}`,
        isDefault: false,
      }))
    } catch {
      return []
    }
  }

  const fileApps = async (path: string): Promise<readonly OpenInAppEntry[] | null> => {
    if (remote === undefined || !await probe()) return null
    try {
      const result = await remote.workspacePathApplications({ path })
      if (!result.ok || result.value === undefined) return null
      return result.value.map(app => ({
        id: app.id,
        name: app.name,
        icon: app.icon,
        isDefault: app.default,
      }))
    } catch {
      return null
    }
  }

  const openViaRemote = async (path: string, application: string | undefined): Promise<boolean> => {
    if (remote === undefined) return false
    try {
      const result = await remote.openWorkspacePath({
        path,
        ...(application !== undefined ? { application } : {}),
      })
      return result.ok
    } catch {
      return false
    }
  }

  const open = async (path: string, application?: string): Promise<boolean> => {
    if (await openViaRemote(path, application)) return true
    // A catalog id is not a file-handler id: the host's directory route is the
    // one that launches "VS Code on this folder".
    if (application === undefined) return false
    try {
      const response = await fetch(OPEN_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: application, path }),
      })
      return response.ok
    } catch {
      return false
    }
  }

  const reveal = async (path: string): Promise<boolean> => {
    if (remote === undefined) return false
    try {
      const result = await remote.openWorkspacePath({ path, action: 'reveal' })
      return result.ok
    } catch {
      return false
    }
  }

  return {
    available: () => availability,
    probe,
    directoryApps,
    fileApps,
    open,
    reveal,
  }
}
