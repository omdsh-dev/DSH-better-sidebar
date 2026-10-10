/**
 * Host `fs.write` route: the two guarantees the editor's save depends on.
 *
 * 1. Concurrent saves to the SAME path are independent — each writes its own
 *    uniquely named temp sibling, so one save's cleanup can never delete the
 *    other's temp file before its rename (the old shared
 *    `.dsh-sidebar-tmp-<pid>` name made the second rename fail with ENOENT).
 *    This guarantee ALREADY landed on dev (2e22b90, `.dsh-sidebar-tmp-<uuid>`);
 *    the case below pins dev's naming, it does not carry a fix of its own.
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
import { encodeText } from '../src/text-encoding.ts'
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
  /** The assistant-live buffer subscribes on mount (dev's apply). */
  on: () => () => void
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
    on: () => () => {},
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

/** Temp siblings the route may leave behind on failure (dev's per-save name,
 *  landed by 2e22b90 — this PR keeps it as-is). */
function tempLeftovers(dir: string): string[] {
  return readdirSync(dir).filter(name => name.includes('.dsh-sidebar-tmp-'))
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

  // #871: the editor transports an LF document (CodeMirror has no other line
  // model), so writing it verbatim turned ONE edited line into a whole-file diff
  // on every CRLF checkout. The route now restores the style the file already
  // had — the SAME guarantee the host's own `edit` tool gives (dsh-fs-local's
  // restoreLineEndings), which the host's `write` tool does not.
  it('keeps a CRLF file CRLF when the editor saves its LF document (#871)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-write-crlf-'))
    try {
      const workspace = join(root, 'ws')
      mkdirSync(workspace)
      const target = join(workspace, 'win.txt')
      writeFileSync(target, 'one\r\ntwo\r\nthree\r\n')
      const route = mountApi(workspace)
      const result = await invoke(route, 'fs.write', {
        sessionId: 's',
        path: target,
        content: 'one\ntwo edited\nthree\n',
      })
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, status: 200 })
      const written = readFileSync(target, 'utf8')
      expect(written).toBe('one\r\ntwo edited\r\nthree\r\n')
      // No bare LF may survive — that is precisely the whole-file diff.
      expect(written.replaceAll('\r\n', '')).not.toContain('\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The detector's own boundary, pinned on purpose (#876 review, residual 1):
  // a first line longer than the 4096-char vote window carries no vote, so the
  // route reads the file as LF and rewrites its CRLF lines — the whole point of
  // #871, lost for this shape. It is the HOST backend's criterion as well (the
  // model's `edit` tool reaches the same verdict), so the plugin does not fork
  // its own rule: the case is a documented decision, not an accident. Design
  // doc §4 has the boundary table, §6 the tradeoff.
  it('rewrites a >4 KiB first line to LF — the detector window boundary, by design', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-write-window-'))
    try {
      const workspace = join(root, 'ws')
      mkdirSync(workspace)
      const target = join(workspace, 'bundled.js')
      const firstLine = 'a'.repeat(5000)
      writeFileSync(target, `${firstLine}\r\nb\r\n`)
      const route = mountApi(workspace)
      const result = await invoke(route, 'fs.write', {
        sessionId: 's',
        path: target,
        content: `${firstLine}\nb edited\n`,
      })
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, status: 200 })
      const written = readFileSync(target, 'utf8')
      expect(written).toBe(`${firstLine}\nb edited\n`)
      expect(written).not.toContain('\r')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves an LF file LF — a save never introduces CR', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-write-lf-'))
    try {
      const workspace = join(root, 'ws')
      mkdirSync(workspace)
      const target = join(workspace, 'posix.sh')
      writeFileSync(target, 'one\ntwo\n')
      const route = mountApi(workspace)
      const result = await invoke(route, 'fs.write', {
        sessionId: 's',
        path: target,
        content: 'one\ntwo edited\n',
      })
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, status: 200 })
      const written = readFileSync(target, 'utf8')
      expect(written).toBe('one\ntwo edited\n')
      expect(written).not.toContain('\r')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('composes the EOL restore with the encoding restore (GBK + CRLF, no \\r\\r\\n)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-write-gbk-crlf-'))
    try {
      const workspace = join(root, 'ws')
      mkdirSync(workspace)
      const target = join(workspace, 'legacy.cmd')
      writeFileSync(target, encodeText('@echo off\r\necho 中文\r\n', 'gbk'))
      const route = mountApi(workspace)
      // An LF document (what the editor always sends) into a GBK + CRLF file:
      // both restores have to fire for the bytes to match.
      const result = await invoke(route, 'fs.write', {
        sessionId: 's',
        path: target,
        content: '@echo off\necho 中文 saved\n',
      })
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, status: 200 })
      expect(readFileSync(target).equals(encodeText('@echo off\r\necho 中文 saved\r\n', 'gbk'))).toBe(true)
      // Redundant with the byte comparison, but keeps the intent readable when
      // that assertion ever gets relaxed.
      expect(readFileSync(target).toString('utf8')).not.toContain('\r\r')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
