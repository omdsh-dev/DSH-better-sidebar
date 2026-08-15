/**
 * Lazy chunk route tests (src/bundle-route.ts): the /sidebar/bundle handler
 * that serves the client's split bundles. Pins the trust fence, the name
 * allowlist (no traversal), method gating, and the caching contract — ETag
 * + If-None-Match 304 so multi-MB chunks revalidate cheaply instead of
 * re-downloading.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CHUNK_NAMES, createBundleRouteHandler } from '../src/bundle-route.ts'

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

/** One handler instance over a scratch dir with a fake chunk file. */
function setup(): { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-route-'))
  writeFileSync(join(dir, 'client-editor.js'), 'window.__ModuleLoader__ && 0;')
  const handler = createBundleRouteHandler(() => true, dir)
  return { handler, dir, cleanup: () => { rmSync(dir, { recursive: true, force: true }) } }
}

describe('/sidebar/bundle route', () => {
  it('serves an allowlisted chunk with the JS content type and an ETag', async () => {
    const { handler, cleanup } = setup()
    try {
      const res = fakeRes()
      await handler(req('GET', '/sidebar/bundle/editor.js'), res as unknown as ServerResponse)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8')
      expect(res.headers['cache-control']).toBe('no-cache')
      expect(res.headers.etag).toMatch(/^"[0-9a-f]{12}"$/)
      expect(res.body).toContain('window.__ModuleLoader__')
    } finally {
      cleanup()
    }
  })

  it('revalidates with a 304 when If-None-Match matches (no re-download)', async () => {
    const { handler, cleanup } = setup()
    try {
      const first = fakeRes()
      await handler(req('GET', '/sidebar/bundle/editor.js'), first as unknown as ServerResponse)
      const etag = first.headers.etag!
      const second = fakeRes()
      await handler(req('GET', '/sidebar/bundle/editor.js', { 'if-none-match': etag }), second as unknown as ServerResponse)
      expect(second.status).toBe(304)
      expect(second.body).toBe('')
      expect(second.headers.etag).toBe(etag)
    } finally {
      cleanup()
    }
  })

  it('serves the new body after the file changed (ETag rotates)', async () => {
    const { handler, dir, cleanup } = setup()
    try {
      const first = fakeRes()
      await handler(req('GET', '/sidebar/bundle/editor.js'), first as unknown as ServerResponse)
      writeFileSync(join(dir, 'client-editor.js'), 'window.__ModuleLoader__ && 1;')
      const second = fakeRes()
      await handler(req('GET', '/sidebar/bundle/editor.js', { 'if-none-match': first.headers.etag! }), second as unknown as ServerResponse)
      expect(second.status).toBe(200)
      expect(second.headers.etag).not.toBe(first.headers.etag)
      expect(second.body).toContain('&& 1')
    } finally {
      cleanup()
    }
  })

  it('rejects unknown chunk names (including traversal attempts) with 404', async () => {
    const { handler, cleanup } = setup()
    try {
      for (const url of ['/sidebar/bundle/evil.js', '/sidebar/bundle/xlsx', '/sidebar/bundle/../secret.js', '/sidebar/bundle/xlsx.js/extra']) {
        const res = fakeRes()
        await handler(req('GET', url), res as unknown as ServerResponse)
        expect(res.status, url).toBe(404)
      }
    } finally {
      cleanup()
    }
  })

  it('404s an allowlisted name whose built file is missing', async () => {
    const { handler, cleanup } = setup()
    try {
      const res = fakeRes()
      // 'terminal' is allowlisted but the scratch fixture only ships
      // client-editor.js — the built file is missing → 404.
      await handler(req('GET', '/sidebar/bundle/terminal.js'), res as unknown as ServerResponse)
      expect(res.status).toBe(404)
    } finally {
      cleanup()
    }
  })

  it('gates non-GET/HEAD methods with 405', async () => {
    const { handler, cleanup } = setup()
    try {
      const res = fakeRes()
      await handler(req('POST', '/sidebar/bundle/editor.js'), res as unknown as ServerResponse)
      expect(res.status).toBe(405)
    } finally {
      cleanup()
    }
  })

  it('enforces the browser-trust fence with 403 before any lookup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-route-fence-'))
    try {
      const handler = createBundleRouteHandler(() => false, dir)
      const res = fakeRes()
      await handler(req('GET', '/sidebar/bundle/editor.js'), res as unknown as ServerResponse)
      expect(res.status).toBe(403)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exports the chunk allowlist (mirror of src/client/chunk-loader.ts)', () => {
    expect([...CHUNK_NAMES]).toEqual(['terminal', 'editor'])
  })
})
