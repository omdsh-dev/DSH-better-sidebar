/**
 * Sidebar icon assets route tests (src/icons-route.ts): the /sidebar/icons
 * handler that serves the explorer icon-theme SVGs. Pins the trust fence,
 * the svg filename allowlist (no traversal), method gating, and the caching
 * contract — ETag + If-None-Match 304 so icon bytes revalidate cheaply.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createIconsRouteHandler } from '../src/icons-route.ts'

interface FakeRes {
  status: number
  headers: Record<string, string>
  body: string
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Buffer): void
}

function fakeRes(): FakeRes {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      if (body !== undefined) this.body = body.toString()
    },
  } as FakeRes
}

function req(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method, url, headers } as unknown as IncomingMessage
}

/** One handler instance over a scratch dir with one fake icon. */
function setup(): { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'icons-route-'))
  writeFileSync(join(dir, 'file_type_ts.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const handler = createIconsRouteHandler(() => true, dir)
  return { handler, dir, cleanup: () => { rmSync(dir, { recursive: true, force: true }) } }
}

describe('/sidebar/icons route', () => {
  it('serves an allowlisted svg with the SVG content type and an ETag', async () => {
    const { handler, cleanup } = setup()
    try {
      const res = fakeRes()
      await handler(req('GET', '/sidebar/icons/file_type_ts.svg'), res as unknown as ServerResponse)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('image/svg+xml')
      expect(res.headers['cache-control']).toBe('no-cache')
      expect(res.headers.etag).toMatch(/^"[0-9a-f]{12}"$/)
      expect(res.body).toContain('<svg')
    } finally {
      cleanup()
    }
  })

  it('revalidates with a 304 when If-None-Match matches', async () => {
    const { handler, cleanup } = setup()
    try {
      const first = fakeRes()
      await handler(req('GET', '/sidebar/icons/file_type_ts.svg'), first as unknown as ServerResponse)
      const etag = first.headers.etag!
      const second = fakeRes()
      await handler(req('GET', '/sidebar/icons/file_type_ts.svg', { 'if-none-match': etag }), second as unknown as ServerResponse)
      expect(second.status).toBe(304)
      expect(second.body).toBe('')
      expect(second.headers.etag).toBe(etag)
    } finally {
      cleanup()
    }
  })

  it('404s anything outside the svg allowlist (no traversal)', async () => {
    const { handler, cleanup } = setup()
    try {
      for (const url of [
        '/sidebar/icons/../secret.txt',
        '/sidebar/icons/evil.js',
        '/sidebar/icons/x.svg/extra',
        '/sidebar/icons/',
        '/sidebar/icons',
        '/sidebar/icons/with space.svg',
      ]) {
        const res = fakeRes()
        await handler(req('GET', url), res as unknown as ServerResponse)
        expect(res.status, url).toBe(404)
      }
    } finally {
      cleanup()
    }
  })

  it('404s an allowlisted name whose asset is missing', async () => {
    const { handler, cleanup } = setup()
    try {
      const res = fakeRes()
      await handler(req('GET', '/sidebar/icons/file_type_unknown.svg'), res as unknown as ServerResponse)
      expect(res.status).toBe(404)
    } finally {
      cleanup()
    }
  })

  it('gates non-GET/HEAD methods with 405', async () => {
    const { handler, cleanup } = setup()
    try {
      const res = fakeRes()
      await handler(req('POST', '/sidebar/icons/file_type_ts.svg'), res as unknown as ServerResponse)
      expect(res.status).toBe(405)
    } finally {
      cleanup()
    }
  })

  it('enforces the browser-trust fence with 403 before any lookup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'icons-route-fence-'))
    try {
      const handler = createIconsRouteHandler(() => false, dir)
      const res = fakeRes()
      await handler(req('GET', '/sidebar/icons/file_type_ts.svg'), res as unknown as ServerResponse)
      expect(res.status).toBe(403)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serves real packaged defaults from the repo icons/ directory', async () => {
    // This repo ships icons/ (the generator's output is committed); the
    // default icons dir for the packaged host lib is lib/../icons which is
    // this same directory in the dev tree.
    const dir = join(process.cwd(), 'icons')
    const handler = createIconsRouteHandler(() => true, dir)
    const res = fakeRes()
    await handler(req('GET', '/sidebar/icons/default_file.svg'), res as unknown as ServerResponse)
    expect(res.status).toBe(200)
    expect(res.body).toContain('<svg')
  })
})