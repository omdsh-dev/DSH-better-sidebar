/**
 * The raw byte routes are STREAMED, and there is no size cap left.
 *
 * Both halves of that matter and both are pinned here with a REAL node:http
 * server, because the properties under test are wire properties:
 *
 * - `/sidebar/file` and `/sidebar/html` used to `readFile()` the whole file
 *   and `res.end()` it, with a 20 MiB `mediaLimit` refusing anything larger.
 *   A 21 MiB file therefore answered 400 before a single byte moved. Now it
 *   streams, so what this spec asserts is that the bytes arrive, that the
 *   length is right, and that the headers survived the rewrite.
 * - `writeHead` commits the response, so the ORDER matters: the file is opened
 *   and awaited BEFORE the status line goes out. An unopenable file must still
 *   produce the plugin's JSON error envelope rather than a 200 with an empty
 *   body — that is the regression the `headersSent` guard in wire.ts exists to
 *   prevent on the failure side.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { writeError, writeJson } from '../src/wire.ts'
import type { SidebarWebRoute } from '../src/context-types.ts'
import { removeTree } from './temp-tree.ts'

interface FakeContext {
  connection: { requestRejection: () => undefined }
  webServer: {
    register: (route: SidebarWebRoute) => () => void
    registerUpgrade: () => () => void
  }
  sessions: { get: (id: string) => { header: { cwd?: string } } | undefined }
  tools: { register: () => () => void }
  effect: (fn: () => void | (() => void)) => void
  inject: (deps: readonly string[], callback: (sctx: never) => void) => () => void
  on: () => () => void
  get: (key: string) => undefined
}

/** The size the retired `mediaLimit` refused (20 MiB), plus a margin. */
const OVER_OLD_LIMIT = 21 * 1024 * 1024

const roots: string[] = []
const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    // Drop the keep-alive sockets before closing: `close()` alone waits for
    // them, and undici holds them open far longer than a test should.
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
  for (const root of roots.splice(0)) removeTree(root)
})

/** A temp workspace whose session cwd is the returned directory. */
function workspace(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-sidebar-stream-${name}-`))
  roots.push(root)
  return root
}

/** Mount the plugin and expose its routes over a real HTTP port. */
async function serve(workspace: string): Promise<{ origin: string; routes: SidebarWebRoute[] }> {
  const routes: SidebarWebRoute[] = []
  const ctx: FakeContext = {
    connection: { requestRejection: () => undefined },
    webServer: { register: (route) => { routes.push(route); return () => {} }, registerUpgrade: () => () => {} },
    sessions: { get: () => ({ header: { cwd: workspace } }) },
    tools: { register: () => () => {} },
    effect: (fn) => { fn() },
    inject: () => () => {},
    on: () => () => {},
    get: () => undefined,
  }
  apply(ctx as never, {})
  const dispatch = (req: Parameters<SidebarWebRoute['handler']>[0], res: Parameters<SidebarWebRoute['handler']>[1]): void => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    // Longest prefix first: `/sidebar/file` must not swallow `/sidebar/files`.
    const matched = routes
      .filter(route => (route.kind === 'exact' ? route.path === pathname : pathname === route.path || pathname.startsWith(`${route.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (matched === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void matched.handler(req, res)
  }
  const server = createServer((req, res) => { dispatch(req as never, res as never) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test setup: no port')
  return { origin: `http://127.0.0.1:${address.port}`, routes }
}

/** The `/sidebar/file` URL for one path. */
function fileUrl(origin: string, workspace: string, path: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ sessionId: 's', cwd: workspace, path, ...extra })
  return `${origin}/sidebar/file?${params.toString()}`
}

describe('/sidebar/file streams without a size cap', () => {
  it('serves a file well past the retired 20 MiB mediaLimit', async () => {
    const ws = workspace('large')
    const target = join(ws, 'big.bin')
    // Sparse on disk, full length on the wire: the point is the BYTE COUNT the
    // route now lets through, not the space it costs the test.
    writeFileSync(target, '')
    const { truncateSync } = await import('node:fs')
    truncateSync(target, OVER_OLD_LIMIT)
    const { origin } = await serve(ws)

    const response = await fetch(fileUrl(origin, ws, target))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(OVER_OLD_LIMIT))
    const body = await response.arrayBuffer()
    expect(body.byteLength).toBe(OVER_OLD_LIMIT)
  })

  it('streams bytes verbatim and keeps the media headers', async () => {
    const ws = workspace('small')
    const target = join(ws, 'note.txt')
    writeFileSync(target, 'hello streamed world\n')
    const { origin } = await serve(ws)

    const response = await fetch(fileUrl(origin, ws, target))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('content-length')).toBe('21')
    expect(await response.text()).toBe('hello streamed world\n')
    // A plain media request must NOT force a download disposition.
    expect(response.headers.get('content-disposition')).toBeNull()
  })

  it('adds the RFC 5987 attachment disposition for ?download=1', async () => {
    const ws = workspace('download')
    const dir = join(ws, '报告')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, '数据.txt')
    writeFileSync(target, 'x\n')
    const { origin } = await serve(ws)

    const response = await fetch(fileUrl(origin, ws, target, { download: '1' }))
    expect(response.status).toBe(200)
    const disposition = response.headers.get('content-disposition') ?? ''
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('数据.txt')}`)
    // node:http refuses a header value above U+00FF; the ASCII-only form is
    // what keeps a non-latin1 name from turning the download into a 500.
    expect([...disposition].every(char => char.codePointAt(0)! <= 0xFF)).toBe(true)
  })

  it('keeps the SVG sandbox headers on the streamed response', async () => {
    const ws = workspace('svg')
    const target = join(ws, 'vector.svg')
    writeFileSync(target, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const { origin } = await serve(ws)

    const response = await fetch(fileUrl(origin, ws, target))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe("sandbox; object-src 'none'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('answers the JSON error envelope when the file cannot be opened', async () => {
    const ws = workspace('missing')
    const { origin } = await serve(ws)
    // The header must not have been written before the stream opened, or this
    // would be a 200 with an empty body instead of a usable error.
    const response = await fetch(fileUrl(origin, ws, join(ws, 'nope.bin')))
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = await response.json() as { ok: boolean; error?: { code?: string } }
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe('fs-error')
  })

  it('refuses a directory instead of streaming it', async () => {
    const ws = workspace('directory')
    mkdirSync(join(ws, 'sub'))
    const { origin } = await serve(ws)
    const response = await fetch(fileUrl(origin, ws, join(ws, 'sub')))
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error?: { message?: string } }).error?.message).toContain('not a file')
  })

  it('survives a client that aborts mid-stream', async () => {
    const ws = workspace('abort')
    const target = join(ws, 'big.bin')
    writeFileSync(target, '')
    const { truncateSync } = await import('node:fs')
    truncateSync(target, OVER_OLD_LIMIT)
    const { origin } = await serve(ws)

    const controller = new AbortController()
    const response = await fetch(fileUrl(origin, ws, target), { signal: controller.signal })
    expect(response.status).toBe(200)
    // Read one chunk, then walk away: the host must tear the source down
    // rather than buffer the remaining 21 MiB nobody is reading.
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()
    await expect(reader.read()).rejects.toBeTruthy()
    // The server is still usable afterwards — no wedged socket, no unhandled
    // rejection from the pipeline.
    const again = await fetch(fileUrl(origin, ws, target))
    expect(again.status).toBe(200)
    expect(again.headers.get('content-length')).toBe(String(OVER_OLD_LIMIT))
    await again.body!.cancel()
  })
})

describe('/sidebar/html streams without a size cap', () => {
  it('serves a page past the retired mediaLimit with the sandbox CSP', async () => {
    const ws = workspace('html')
    const target = join(ws, 'page.html')
    // Big enough to have been refused by the old cap, and valid HTML.
    const filler = `<!-- ${'x'.repeat(1024)} -->\n`
    writeFileSync(target, `<html><body>ok</body></html>\n${filler.repeat(21 * 1024)}`)
    const { origin, routes } = await serve(ws)
    expect(routes.some(route => route.path === '/sidebar/html' && route.kind === 'prefix')).toBe(true)

    // `/sidebar/html` is served by path-encoded URL only (html-route.ts); the
    // encoding itself has its own spec, so this reuses the same pair of helpers
    // the client does rather than inventing a third spelling.
    const { encodeHtmlUrl } = await import('../src/html-route.ts')
    const url = new URL(encodeHtmlUrl('s', target), origin)
    const response = await fetch(url, { headers: { host: '127.0.0.1' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy'))
      .toBe("sandbox allow-scripts allow-popups allow-downloads allow-modals; object-src 'none'")
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(20 * 1024 * 1024)
    await response.body!.cancel()
  })

  it('serves a file reached through a symlink', async () => {
    const ws = workspace('html-link')
    const real = join(ws, 'real.css')
    writeFileSync(real, 'body { color: red }\n')
    symlinkSync(real, join(ws, 'link.css'))
    const { origin } = await serve(ws)
    // Resolved through the file route (the html route shares the resolver).
    const response = await fetch(fileUrl(origin, ws, join(ws, 'link.css')))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('body { color: red }\n')
  })
})

describe('writeJson after the header committed', () => {
  it('destroys the response instead of throwing ERR_HTTP_HEADERS_SENT', () => {
    // The failure mode this replaces: a streamed route errors mid-flight, its
    // catch block calls writeError, writeHead throws, and a truncated download
    // becomes a crashed request.
    let destroyed = false
    const res = {
      statusCode: 200,
      headersSent: true,
      writeHead: () => { throw new Error('ERR_HTTP_HEADERS_SENT') },
      write: () => true,
      end: () => { throw new Error('end after destroy') },
      destroy: () => { destroyed = true },
    }
    expect(() => { writeJson(res, 500, { ok: false }) }).not.toThrow()
    expect(destroyed).toBe(true)
    expect(() => { writeError(res, new Error('boom')) }).not.toThrow()
  })

  it('writes normally while the header is still open', () => {
    const written: string[] = []
    let status = 0
    const res = {
      statusCode: 200,
      headersSent: false,
      writeHead: (code: number) => { status = code },
      write: () => true,
      end: (chunk?: string) => { written.push(String(chunk ?? '')) },
    }
    writeJson(res, 418, { ok: false })
    expect(status).toBe(418)
    expect(written.join('')).toBe('{"ok":false}')
  })
})
