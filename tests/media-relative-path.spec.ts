/**
 * Regression spec for #618 — the media route must accept the path spelling a
 * native file address carries.
 *
 * Since the native right-Sidebar migration a file tab is seeded by a
 * `dsh-resource://file/session/<sid>/<path>` address, which spells an
 * IN-WORKSPACE file relative to the session root. `/sidebar/file` used to
 * demand an absolute path (`requireAbsolute` → 400), so every image / PDF /
 * download viewer opened from the file tree or the chat answered 400 and the
 * pane stayed blank — while the text channel (`fs.read`) kept working because
 * it has always joined a relative target onto the session cwd.
 *
 * These cases drive the REAL route through a fake context (the harness
 * smoke.spec.ts uses) over a temporary workspace, and assert the workspace
 * fence is intact: a relative target may only resolve INSIDE the session
 * workspace.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { htmlUrl, mediaUrl } from '../src/client/api.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

/** PNG magic bytes: enough for the route, which serves bytes as they are. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])

/**
 * One scratch workspace (`<root>/ws`) plus a sibling directory outside it.
 * Built at module scope because the route harness below mounts during
 * collection — a `beforeAll` cwd would still be empty when the mount captured it.
 */
const root = mkdtempSync(join(tmpdir(), 'dsh-media-relative-'))
const ws = join(root, 'ws')
const outside = join(root, 'outside')
mkdirSync(join(ws, 'docs', 'img'), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(ws, 'chart.png'), PNG)
writeFileSync(join(ws, 'docs', 'img', 'inline.png'), PNG)
writeFileSync(join(ws, 'docs', 'index.html'), '<!doctype html><p>ok</p>')
writeFileSync(join(outside, 'secret.png'), PNG)

/** Whether this host may create symlinks (Windows CI often cannot). */
const canSymlink = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'dsh-media-symlink-probe-'))
  try {
    writeFileSync(join(probe, 'target'), 'x')
    symlinkSync(join(probe, 'target'), join(probe, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
})()

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The plugin mounted against a fake context; the session's cwd is `cwd`. */
function mount(cwd: string): SidebarWebRoute[] {
  const routes: SidebarWebRoute[] = []
  const ctx = {
    webRuntime: { trustedHosts: [] },
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: (route: SidebarWebUpgradeRoute) => { void route; return () => {} },
    },
    sessions: { get: () => ({ header: { cwd } }) },
    tools: { register: () => () => {} },
    // The vendored cordis runs registration effects immediately.
    effect: (fn: () => void | (() => void)) => { fn() },
    // No settings service in this context: the namespace registration never
    // runs, so the workspace fence keeps its documented default (enabled).
    inject: () => () => {},
    on: () => () => {},
    get: () => undefined,
  }
  apply(ctx as never)
  return routes
}

interface Reply {
  status: number
  headers: Record<string, string>
  body: Buffer
}

/** Drive one mounted route with a GET. */
async function get(routes: SidebarWebRoute[], path: string, url: string): Promise<Reply> {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`route ${path} is not mounted`)
  const out: Reply = { status: 0, headers: {}, body: Buffer.alloc(0) }
  const req = { method: 'GET', url, headers: { host: '127.0.0.1:3080' } } as never
  const res = {
    writeHead: (status: number, headers?: Record<string, string>) => {
      out.status = status
      out.headers = headers ?? {}
    },
    end: (chunk?: string | Buffer) => {
      if (chunk !== undefined) out.body = Buffer.from(chunk)
    },
  } as never
  await route.handler(req, res)
  return out
}

/** A `/sidebar/file` URL with a raw (unencoded) query spelling. */
function fileRoute(path: string, extra: Record<string, string> = {}): string {
  return `/sidebar/file?${new URLSearchParams({ sessionId: 's1', path, ...extra }).toString()}`
}

/** The error code of a JSON error reply. */
function errorCode(reply: Reply): string {
  return (JSON.parse(reply.body.toString()) as { error: { code: string } }).error.code
}

describe('/sidebar/file accepts a workspace-relative target (#618)', () => {
  const routes = mount(ws)

  it('serves a workspace-relative path with no client cwd (the native-address case)', async () => {
    const reply = await get(routes, '/sidebar/file', fileRoute('chart.png'))
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('image/png')
    expect(reply.body).toEqual(PNG)
  })

  it('serves a nested workspace-relative path', async () => {
    const reply = await get(routes, '/sidebar/file', fileRoute('docs/img/inline.png', { cwd: ws }))
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual(PNG)
  })

  it('keeps accepting an absolute path', async () => {
    const reply = await get(routes, '/sidebar/file', fileRoute(join(ws, 'chart.png')))
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual(PNG)
  })

  it('honours ?download=1 on a relative path', async () => {
    const reply = await get(routes, '/sidebar/file', fileRoute('chart.png', { download: '1' }))
    expect(reply.status).toBe(200)
    expect(reply.headers['content-disposition']).toBe("attachment; filename*=UTF-8''chart.png")
  })

  it('still fences a relative target that climbs out of the workspace', async () => {
    const reply = await get(routes, '/sidebar/file', fileRoute('../outside/secret.png'))
    expect(reply.status).toBe(403)
    expect(errorCode(reply)).toBe('forbidden')
  })

  it('still fences an absolute target outside the workspace', async () => {
    const reply = await get(routes, '/sidebar/file', fileRoute(join(outside, 'secret.png')))
    expect(reply.status).toBe(403)
    expect(errorCode(reply)).toBe('forbidden')
  })

  it('rejects a missing relative path as an fs error, not a bad-request', async () => {
    const reply = await get(routes, '/sidebar/file', fileRoute('nope.png'))
    expect(reply.status).toBe(400)
    expect(errorCode(reply)).toBe('fs-error')
  })

  it.runIf(canSymlink)('refuses a symlink whose real target is outside', async () => {
    const link = join(ws, 'link.png')
    symlinkSync(join(outside, 'secret.png'), link)
    const reply = await get(routes, '/sidebar/file', fileRoute('link.png'))
    expect(reply.status).toBe(403)
  })

  it('serves what the client media-URL builder produces from a native seed', async () => {
    // The two halves of the fix must agree: the tab's path is the
    // workspace-relative spelling the address carries, and the builder turns
    // it into the URL the route above answers.
    const reply = await get(routes, '/sidebar/file', mediaUrl({ sessionId: 's1', cwd: ws }, 'docs/img/inline.png'))
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual(PNG)
  })

  it('serves the HTML route for the URL the html builder produces', async () => {
    const reply = await get(routes, '/sidebar/html', htmlUrl({ sessionId: 's1', cwd: ws }, 'docs/index.html'))
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(reply.body.toString()).toContain('ok')
  })
})
