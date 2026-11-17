/**
 * The content-search routes (`fs.grep` / `fs.grepReplace`) over the real
 * `/sidebar/api` dispatch: the payload shapes, the BAD-REQUEST mapping for a
 * regex that does not compile, and the replace round-trip with the mtime gate
 * the result rows carry.
 *
 * The walk itself is pinned in fs-grep.spec.ts; this spec only proves the
 * route wiring (method names, `cwd` resolution, error codes).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
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

function mount(workspace: string): SidebarWebRoute {
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
  return routes.find(route => route.path === '/sidebar/api')!
}

interface Invoked {
  ok: boolean
  status: number
  value?: {
    files?: { path: string; matches: { line: number; text: string }[] }[]
    matchesTotal?: number
    truncated?: boolean
    replaced?: number
    skipped?: { path: string; reason: string }[]
  }
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
    // The abortable methods (`fs.grep` included) subscribe to the response's
    // close event to abort an in-flight walk.
    once: () => {},
    off: () => {},
  } as never
  await route.handler(req, res)
  return { ...JSON.parse(out.body) as Invoked, status: out.status }
}

const workspaces: string[] = []
afterEach(() => {
  for (const workspace of workspaces) removeTree(workspace)
  workspaces.length = 0
})

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-grep-route-'))
  workspaces.push(workspace)
  mkdirSync(join(workspace, 'src'))
  writeFileSync(join(workspace, 'src', 'a.ts'), 'const target = 1\nconst other = 2\n')
  writeFileSync(join(workspace, 'src', 'b.md'), 'target doc\n')
  return workspace
}

describe('fs.grep route', () => {
  it('answers the grouped file/line shape and honours the include list', async () => {
    const workspace = makeWorkspace()
    const route = mount(workspace)
    const result = await invoke(route, 'fs.grep', { sessionId: 's1', query: 'target' })
    expect(result.status).toBe(200)
    expect(result.value?.files?.map(file => file.path)).toEqual(['src/a.ts', 'src/b.md'])
    expect(result.value?.files?.[0]?.matches).toEqual([{ line: 1, text: 'const target = 1', ranges: [{ start: 6, end: 12 }] }])
    expect(result.value?.matchesTotal).toBe(2)
    expect(result.value?.truncated).toBe(false)

    const filtered = await invoke(route, 'fs.grep', { sessionId: 's1', query: 'target', include: ['*.md'] })
    expect(filtered.value?.files?.map(file => file.path)).toEqual(['src/b.md'])
  })

  it('maps an invalid regex query to a bad-request (never a 500)', async () => {
    const workspace = makeWorkspace()
    const result = await invoke(mount(workspace), 'fs.grep', { sessionId: 's1', query: 'a(', regex: true })
    expect(result.status).toBe(400)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('bad-request')
  })
})

describe('fs.grepReplace route', () => {
  it('rewrites the named files and reports counts', async () => {
    const workspace = makeWorkspace()
    const route = mount(workspace)
    const mtimeMs = statSync(join(workspace, 'src', 'a.ts')).mtimeMs
    const result = await invoke(route, 'fs.grepReplace', {
      sessionId: 's1',
      query: 'target',
      replacement: 'renamed',
      files: [{ path: 'src/a.ts', mtimeMs }],
    })
    expect(result.status).toBe(200)
    expect(result.value?.replaced).toBe(1)
    expect(result.value?.skipped).toEqual([])
    expect(readFileSync(join(workspace, 'src', 'a.ts'), 'utf8')).toBe('const renamed = 1\nconst other = 2\n')
  })

  it('skips a file whose mtime no longer matches (the optimistic-concurrency gate)', async () => {
    const workspace = makeWorkspace()
    const result = await invoke(mount(workspace), 'fs.grepReplace', {
      sessionId: 's1',
      query: 'target',
      replacement: 'renamed',
      files: [{ path: 'src/a.ts', mtimeMs: 1 }],
    })
    expect(result.status).toBe(200)
    expect(result.value?.replaced).toBe(0)
    expect(result.value?.skipped).toEqual([{ path: 'src/a.ts', reason: 'changed' }])
    expect(readFileSync(join(workspace, 'src', 'a.ts'), 'utf8')).toContain('target')
  })

  it('refuses an empty file list', async () => {
    const workspace = makeWorkspace()
    const result = await invoke(mount(workspace), 'fs.grepReplace', {
      sessionId: 's1',
      query: 'target',
      replacement: 'renamed',
      files: [],
    })
    expect(result.status).toBe(400)
    expect(result.error?.code).toBe('bad-request')
  })
})