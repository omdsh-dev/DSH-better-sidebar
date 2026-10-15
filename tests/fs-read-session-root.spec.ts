import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import type { SidebarWebRoute } from '../src/context-types.ts'

function mountApi(cwd: string): SidebarWebRoute {
  const routes: SidebarWebRoute[] = []
  const ctx = {
    webRuntime: { trustedHosts: [] },
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: () => () => {},
    },
    sessions: { get: () => ({ header: { cwd }, snapshotEvents: () => [] }) },
    tools: { register: () => () => {} },
    effect: (fn: () => unknown) => { fn() },
    inject: () => () => {},
    on: () => () => {},
    get: () => undefined,
  }
  apply(ctx as never, {})
  return routes.find(route => route.path === '/sidebar/api')!
}

async function read(route: SidebarWebRoute, path: string): Promise<{
  ok: boolean; value?: { content?: string }; error?: { message?: string }
}> {
  const body = Buffer.from(JSON.stringify({ sessionId: 's', path }))
  const req = {
    method: 'POST', url: '/sidebar/api/fs.read', headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () { yield body },
  } as never
  let result = ''
  const res = { writeHead: () => {}, end: (chunk: unknown) => { result += String(chunk ?? '') } } as never
  await route.handler(req, res)
  return JSON.parse(result)
}

for (const subdirectory of ['sub-en', '社媒运营']) {
  describe(`fs.read session root: ${subdirectory}`, () => {
    it('reads relative paths from the session and refuses a repository-root decoy', async () => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-session-read-'))
      try {
        const repo = join(root, 'repo')
        const cwd = join(repo, subdirectory)
        mkdirSync(join(cwd, 'tools'), { recursive: true })
        execFileSync('git', ['init', '-q'], { cwd: repo })
        writeFileSync(join(cwd, 'tools', 'a.md'), 'session file\n')
        writeFileSync(join(repo, 'root-only.md'), 'wrong repository-root file\n')
        const outside = join(root, 'outside.md')
        writeFileSync(outside, 'outside file\n')
        const route = mountApi(cwd)

        expect(await read(route, 'tools/a.md')).toMatchObject({ ok: true, value: { content: 'session file\n' } })
        const missing = await read(route, 'root-only.md')
        expect(missing.ok).toBe(false)
        expect(missing.error?.message).toContain(join(cwd, 'root-only.md'))
        expect(readFileSync(join(repo, 'root-only.md'), 'utf8')).toBe('wrong repository-root file\n')
        expect(await read(route, join(cwd, 'tools', 'a.md'))).toMatchObject({ ok: true, value: { content: 'session file\n' } })
        expect(await read(route, outside)).toMatchObject({ ok: true, value: { content: 'outside file\n' } })
        expect(await read(route, '../root-only.md')).toMatchObject({ ok: true, value: { content: 'wrong repository-root file\n' } })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })
}
