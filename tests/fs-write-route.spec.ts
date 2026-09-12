/**
 * Host `fs.write` route: the two guarantees the editor's save depends on.
 *
 * 1. Concurrent saves to the SAME path are independent — each writes its own
 *    uniquely named temp sibling, so one save's cleanup can never delete the
 *    other's temp file before its rename (the old shared
 *    `.dsh-sidebar-tmp-<pid>` name made the second rename fail with ENOENT).
 * 2. `expectedMtimeMs` is an optimistic-concurrency gate: a file that changed
 *    on disk since the draft was loaded refuses with `fs-conflict` (409)
 *    instead of clobbering the new bytes, and a successful save reports the
 *    fresh baseline the client adopts.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import type { SidebarWebRoute } from '../src/context-types.ts'

interface FakeContext {
  webRuntime: { trustedHosts: readonly string[] }
  webServer: {
    register: (route: SidebarWebRoute) => () => void
    registerUpgrade: () => () => void
  }
  sessions: { get: (id: string) => { header: { cwd?: string } } | undefined }
  tools: { register: () => () => void }
  effect: (fn: () => void | (() => void)) => void
  inject: (deps: readonly string[], callback: (sctx: never) => void) => () => void
  get: (key: string) => undefined
}

/** Mount the plugin against a fake context whose session cwd is `workspace`. */
function mountApi(workspace: string): SidebarWebRoute {
  const routes: SidebarWebRoute[] = []
  const ctx: FakeContext = {
    webRuntime: { trustedHosts: [] },
    webServer: { register: (route) => { routes.push(route); return () => {} }, registerUpgrade: () => () => {} },
    sessions: { get: () => ({ header: { cwd: workspace } }) },
    tools: { register: () => () => {} },
    effect: (fn) => { fn() },
    inject: () => () => {},
    get: () => undefined,
  }
  apply(ctx as never, {})
  return routes.find(route => route.path === '/sidebar/api')!
}

interface Invoked {
  ok: boolean
  status: number
  value?: { ok?: boolean; mtimeMs?: number; kind?: string; content?: string }
  error?: { code?: string; message?: string }
}

async function invoke(route: SidebarWebRoute, method: string, payload: unknown): Promise<Invoked> {
  const body = Buffer.from(JSON.stringify(payload))
  const req = {
    method: 'POST',
    url: `/sidebar/api/${method}`,
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () { yield body },
  } as never
  const out = { status: 200, body: '' }
  const res = {
    writeHead: (status: number) => { out.status = status },
    end: (chunk: unknown) => { out.body += String(chunk ?? '') },
  } as never
  await route.handler(req, res)
  return { ...JSON.parse(out.body) as Invoked, status: out.status }
}

/** Temp siblings the route may leave behind on failure. */
function tempLeftovers(dir: string): string[] {
  return readdirSync(dir).filter(name => name.includes('.dsh-write-'))
}

describe('fs.write route', () => {
  it('keeps concurrent saves to the same path independent and leaves no temp files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-write-race-'))
    try {
      const workspace = join(root, 'ws')
      mkdirSync(workspace)
      const target = join(workspace, 'race.txt')
      const route = mountApi(workspace)
      const results = await Promise.all([
        invoke(route, 'fs.write', { sessionId: 's', path: target, content: 'first' }),
        invoke(route, 'fs.write', { sessionId: 's', path: target, content: 'second' }),
        invoke(route, 'fs.write', { sessionId: 's', path: target, content: 'third' }),
      ])
      for (const result of results) {
        // The bug this pins: with ONE shared temp name, a loser's cleanup
        // rm()s the winner's temp file and its rename fails ENOENT. Windows
        // may still refuse a concurrent rename over an open file with EPERM
        // (antivirus / handle timing) — a platform quirk, not cross-talk.
        expect(result.ok || (result.error?.message ?? '').includes('EPERM'), JSON.stringify(result)).toBe(true)
      }
      // At least one rename landed (the last successful writer wins), and no
      // temp sibling survived either path.
      expect(['first', 'second', 'third']).toContain(readFileSync(target, 'utf8'))
      expect(tempLeftovers(workspace)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs repeated saves to the same path cleanly and leaves no temp files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-write-repeat-'))
    try {
      const workspace = join(root, 'ws')
      mkdirSync(workspace)
      const target = join(workspace, 'seq.txt')
      writeFileSync(target, 'v0')
      const route = mountApi(workspace)
      for (const content of ['v1', 'v2', 'v3']) {
        const result = await invoke(route, 'fs.write', { sessionId: 's', path: target, content })
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, status: 200 })
      }
      expect(readFileSync(target, 'utf8')).toBe('v3')
      expect(tempLeftovers(workspace)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a save whose baseline mtime no longer matches the file on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-write-conflict-'))
    try {
      const workspace = join(root, 'ws')
      mkdirSync(workspace)
      const target = join(workspace, 'draft.txt')
      writeFileSync(target, 'disk-v1')
      const route = mountApi(workspace)

      const read = await invoke(route, 'fs.read', { sessionId: 's', path: target })
      expect(read).toMatchObject({ ok: true, value: { kind: 'text', content: 'disk-v1' } })
      const baseline = read.value?.mtimeMs
      expect(typeof baseline).toBe('number')

      // Something else (the model, another tab, an external editor) wrote it.
      writeFileSync(target, 'disk-v2')
      utimesSync(target, new Date(), new Date(Date.now() + 2_000))

      const stale = await invoke(route, 'fs.write', {
        sessionId: 's', path: target, content: 'my-draft', expectedMtimeMs: baseline,
      })
      expect(stale).toMatchObject({ ok: false, status: 409, error: { code: 'fs-conflict' } })
      // The foreign bytes survive: the write was refused, not merged.
      expect(readFileSync(target, 'utf8')).toBe('disk-v2')
      expect(tempLeftovers(workspace)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts a save whose baseline still matches and reports the fresh baseline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-write-ok-'))
    try {
      const workspace = join(root, 'ws')
      mkdirSync(workspace)
      const target = join(workspace, 'draft.txt')
      writeFileSync(target, 'disk-v1')
      const route = mountApi(workspace)

      const read = await invoke(route, 'fs.read', { sessionId: 's', path: target })
      const saved = await invoke(route, 'fs.write', {
        sessionId: 's', path: target, content: 'disk-v2', expectedMtimeMs: read.value?.mtimeMs,
      })
      expect(saved).toMatchObject({ ok: true, status: 200, value: { ok: true } })
      expect(typeof saved.value?.mtimeMs).toBe('number')
      expect(readFileSync(target, 'utf8')).toBe('disk-v2')

      // The reported baseline is the one a follow-up save must present.
      const second = await invoke(route, 'fs.write', {
        sessionId: 's', path: target, content: 'disk-v3', expectedMtimeMs: saved.value?.mtimeMs,
      })
      expect(second).toMatchObject({ ok: true, status: 200 })
      expect(readFileSync(target, 'utf8')).toBe('disk-v3')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats an omitted baseline as no gate (older callers keep working)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-write-legacy-'))
    try {
      const workspace = join(root, 'ws')
      mkdirSync(workspace)
      const target = join(workspace, 'legacy.txt')
      writeFileSync(target, 'disk-v1')
      const route = mountApi(workspace)
      const result = await invoke(route, 'fs.write', { sessionId: 's', path: target, content: 'overwritten' })
      expect(result).toMatchObject({ ok: true, status: 200 })
      expect(readFileSync(target, 'utf8')).toBe('overwritten')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
