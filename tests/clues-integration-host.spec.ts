/**
 * S9 host total-assembly integration.
 *
 * Unlike the per-subsystem specs (S1–S8), this file pins only the ONE wiring
 * step the host actually mounts: `installClueStack(ctx, { readPrefs, fence })`.
 * It proves that the assembled stack
 * - publishes the clue service and the complete built-in catalogue (local
 *   files + GitHub issues/pulls + Feishu docs/tasks, with their type ids);
 * - registers both CLI dependency definitions and both account connection
 *   definitions on the SINGLE shared runtime;
 * - mounts exactly the four raw `.cluepack` share routes on `ctx.webServer`,
 *   each fenced PER REQUEST before any work;
 * - answers the client's `clues.workspaceForSession` lookup from the host
 *   session header + workspace registry, and answers null (not an error) when
 *   there is no workspace;
 * - releases every registration through the `ctx.effect` disposers, twice.
 *
 * The harness is a STRUCTURAL fake modelled on tests/smoke.spec.ts: the real
 * installers run and may create directories under a temp profile home, but no
 * source operation (and therefore no process spawn) is ever invoked.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  Context,
  SidebarHttpRequest,
  SidebarHttpResponse,
  SidebarWebRoute,
} from '../src/context-types.ts'
import {
  CLUES_WORKSPACE_FOR_SESSION_API,
  installClueStack,
  type InstalledClueStack,
} from '../src/clues/install-stack.ts'
import { CLUES_SHARE_ROUTE_PATHS } from '../src/clues/share/index.ts'
import {
  GITHUB_CONNECTION_ID,
  GITHUB_DEPENDENCY_ID,
  GITHUB_SOURCE_IDS,
  GITHUB_TYPE_IDS,
} from '../src/clues/sources/github/index.ts'
import {
  FEISHU_CONNECTION_ID,
  FEISHU_DEPENDENCY_ID,
  FEISHU_SOURCE_IDS,
  FEISHU_TYPE_IDS,
} from '../src/clues/sources/feishu/index.ts'
import { LOCAL_FILE_SOURCE_ID, LOCAL_FILE_TYPE_IDS } from '../src/clues/local-files.ts'
import { BUILTIN_SOURCE_IDS } from '../src/clues/types.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'

/** The session store subset `installClueStack` reads. */
interface FakeSessions {
  get(id: string): { header: { cwd?: string } } | undefined
}

/** The workspace-registry subset the workspace lookup consumes. */
interface FakeWorkspaceRegistry {
  resolveByPath(path: string): Promise<{ id: string } | undefined>
}

/** One route the fake web server accepted, plus its release flag. */
interface RegisteredRoute {
  readonly route: SidebarWebRoute
  /** Set by the disposer the fake `register` returned (Cordis-like). */
  released: boolean
}

/** What one mount hands the assertions. */
interface StackHarness {
  readonly stack: InstalledClueStack
  readonly home: string
  /** Values published through `ctx.provide` (name → value). */
  readonly provided: Map<string, unknown>
  readonly routes: RegisteredRoute[]
  /** Every cleanup the fake `ctx.effect` captured, in registration order. */
  readonly cleanups: Array<() => void>
  /** Run every captured cleanup (reverse order, like Cordis unload), twice-safe. */
  dispose(): void
  /** Dispose + remove the temp profile home. */
  cleanup(): Promise<void>
}

/** One response capture the raw routes write into. */
interface CapturedResponse {
  readonly res: SidebarHttpResponse
  status: number
  headers: Record<string, string>
  body: string
}

const homes: string[] = []

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

/** Default session store matching the spec's `s1 → /repo` fixture. */
function sessionsFixture(): FakeSessions {
  return {
    get: (id) => {
      if (id === 's1') return { header: { cwd: '/repo' } }
      // A real detached session without a stored cwd: "no workspace", no throw.
      if (id === 's-blank') return { header: {} }
      return undefined
    },
  }
}

/** Default registry: only `/repo` is a registered workspace. */
function registryFixture(): FakeWorkspaceRegistry {
  return { resolveByPath: async (path) => (path === '/repo' ? { id: 'ws-1' } : undefined) }
}

/**
 * Mount the REAL clue stack on a minimal structural context.
 *
 * `effect` runs its body immediately and keeps the returned cleanup exactly
 * like the DSH-vendored cordis does; `provide`, `webServer.register` and the
 * optional host services are recorded so the total wiring is observable.
 */
async function mountStack(options: {
  readonly fence?: (req: SidebarHttpRequest) => boolean
  readonly sessions?: FakeSessions
  readonly workspaceRegistry?: FakeWorkspaceRegistry
} = {}): Promise<StackHarness> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-clues-stack-'))
  homes.push(home)
  const provided = new Map<string, unknown>()
  const routes: RegisteredRoute[] = []
  const cleanups: Array<() => void> = []
  const sessions = options.sessions ?? sessionsFixture()
  const registry = options.workspaceRegistry ?? registryFixture()

  const ctx = {
    profileContext: { home },
    connection: { requestRejection: () => undefined },
    webServer: {
      register: (route: SidebarWebRoute) => {
        const entry: RegisteredRoute = { route, released: false }
        routes.push(entry)
        return () => { entry.released = true }
      },
      registerUpgrade: () => () => {},
    },
    sessions,
    tools: { register: () => () => {} },
    effect: (fn: () => void | (() => void), _label?: string) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    // The workspace registry is the only optional service the stack reads
    // eagerly on this path; everything else must degrade cleanly.
    get: (name: string) => (name === 'workspaceRegistry' ? registry : undefined),
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    provide: (name: string, value?: unknown) => { provided.set(name, value) },
  } as unknown as Context

  const stack = installClueStack(ctx, {
    readPrefs: () => SIDEBAR_PREFS_DEFAULTS,
    fence: options.fence ?? (() => true),
  })

  return {
    stack,
    home,
    provided,
    routes,
    cleanups,
    dispose: () => {
      // Reverse registration order is Cordis' unload order; running the same
      // list a second time is the "double cleanup" contract under test.
      for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]!()
    },
    cleanup: async () => {
      for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]!()
      await rm(home, { recursive: true, force: true })
    },
  }
}

/** A request whose body iteration is observable (must not run when fenced). */
function fakeRequest(path: string, onBodyRead?: () => void): SidebarHttpRequest {
  return {
    method: 'POST',
    url: path,
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() {
      onBodyRead?.()
      yield new Uint8Array()
    },
  }
}

/** A response that records what the route wrote. */
function captureResponse(): CapturedResponse {
  const captured: CapturedResponse = {
    status: 0,
    headers: {},
    body: '',
    res: {
      statusCode: 0,
      writeHead: (status: number, headers?: Record<string, string>) => {
        captured.status = status
        captured.headers = headers ?? {}
      },
      write: () => true,
      end: (body?: string | Uint8Array) => {
        if (body !== undefined) captured.body += typeof body === 'string' ? body : Buffer.from(body).toString('utf8')
      },
    },
  }
  return captured
}

describe('installClueStack host assembly', () => {
  it('publishes the clue service and the complete built-in source/type catalogue', async () => {
    const harness = await mountStack()
    try {
      // The Cordis service is published so external source plugins can find it.
      expect(harness.provided.get('betterSidebarClues')).toBe(harness.stack.clues)

      // The catalogue the settings UI and the client both read: all FIVE
      // built-in sources survive the total assembly (local files + S3 + S4).
      const expectedSources = [
        LOCAL_FILE_SOURCE_ID,
        BUILTIN_SOURCE_IDS.githubIssues,
        BUILTIN_SOURCE_IDS.githubPulls,
        BUILTIN_SOURCE_IDS.feishuDocs,
        BUILTIN_SOURCE_IDS.feishuTasks,
      ]
      expect(harness.stack.clues.getSources().map(source => source.sourceId).sort())
        .toEqual([...expectedSources].sort())
      // The GitHub/Feishu registrations really are the S3/S4 bundles' own ids,
      // not coincidental string matches: the shared constants agree.
      expect(harness.stack.github.registrations.map(registration => registration.descriptor.sourceId))
        .toEqual([GITHUB_SOURCE_IDS.issue, GITHUB_SOURCE_IDS.pull])
      expect(harness.stack.feishu.registrations.map(registration => registration.descriptor.sourceId))
        .toEqual([FEISHU_SOURCE_IDS.docs, FEISHU_SOURCE_IDS.tasks])

      // The SAME catalogue over the `/sidebar/api` seam (`clues.sources`).
      const catalogue = await harness.stack.clues.invokeApi('clues.sources', {}) as {
        sources: Array<{ sourceId: string }>
        types: Array<{ typeId: string }>
      }
      expect(catalogue.sources.map(source => source.sourceId).sort())
        .toEqual([...expectedSources].sort())

      // Every built-in type id is present, including local-file kinds.
      const typeIds = catalogue.types.map(type => type.typeId)
      expect(typeIds).toEqual(expect.arrayContaining([
        ...Object.values(LOCAL_FILE_TYPE_IDS),
        GITHUB_TYPE_IDS.issue,
        GITHUB_TYPE_IDS.pull,
        FEISHU_TYPE_IDS.docx,
        FEISHU_TYPE_IDS.wiki,
        FEISHU_TYPE_IDS.task,
      ]))
    } finally {
      await harness.cleanup()
    }
  })

  it('registers both dependency definitions and both connection definitions on the one runtime', async () => {
    const harness = await mountStack()
    try {
      // The dependency registry is shared by every source: exactly the two
      // built-in CLIs, each registered exactly once.
      const dependencies = harness.stack.runtime.dependencies.getDefinitions()
      expect(dependencies.map(definition => definition.dependencyId).sort())
        .toEqual([GITHUB_DEPENDENCY_ID, FEISHU_DEPENDENCY_ID].sort())
      expect(harness.stack.runtime.dependencies.getDefinition(GITHUB_DEPENDENCY_ID)?.command).toBe('gh')
      expect(harness.stack.runtime.dependencies.getDefinition(FEISHU_DEPENDENCY_ID)?.command).toBe('lark-cli')

      // ... and the connection registry is the same single instance.
      const connections = harness.stack.runtime.connections.getDefinitions()
      expect(connections.map(definition => definition.connectionId).sort())
        .toEqual([GITHUB_CONNECTION_ID, FEISHU_CONNECTION_ID].sort())
      expect(harness.stack.runtime.connections.getDefinition(GITHUB_CONNECTION_ID)).toBeDefined()
      expect(harness.stack.runtime.connections.getDefinition(FEISHU_CONNECTION_ID)).toBeDefined()

      // Both settings faces ride the existing clue API seam: no second route.
      expect(harness.stack.clues.hasApi('clues.dependencies.inspect')).toBe(true)
      expect(harness.stack.clues.hasApi('clues.connections.status')).toBe(true)
    } finally {
      await harness.cleanup()
    }
  })

  it('mounts exactly the four share raw routes and fences each request before any work', async () => {
    const fence = vi.fn(() => false)
    const harness = await mountStack({ fence })
    try {
      expect(harness.routes.map(entry => entry.route.path)).toEqual(Object.values(CLUES_SHARE_ROUTE_PATHS))
      expect(harness.routes.every(entry => entry.route.kind === 'exact')).toBe(true)

      for (const [index, entry] of harness.routes.entries()) {
        let bodyReads = 0
        const response = captureResponse()
        // The METHOD and the workspace query are deliberately invalid: a
        // handler that did any work before fencing would answer 405/400.
        const request = fakeRequest('/ignored?workspaceId=', () => { bodyReads += 1 })
        request.method = 'GET'
        await entry.route.handler(request, response.res)
        expect(response.status, entry.route.path).toBe(403)
        expect(JSON.parse(response.body) as unknown).toEqual({
          ok: false,
          error: { code: 'forbidden', message: 'forbidden' },
        })
        expect(bodyReads, entry.route.path).toBe(0)
        expect(fence).toHaveBeenCalledTimes(index + 1)
      }
    } finally {
      await harness.cleanup()
    }
  })

  it('answers the client workspace lookup from the session header and host registry', async () => {
    const harness = await mountStack()
    try {
      expect(harness.stack.clues.hasApi(CLUES_WORKSPACE_FOR_SESSION_API)).toBe(true)

      // Registered workspace: the id comes from the host registry, never a
      // client-side path guess.
      await expect(harness.stack.clues.invokeApi(CLUES_WORKSPACE_FOR_SESSION_API, { sessionId: 's1' }))
        .resolves.toEqual({ workspaceId: 'ws-1' })

      // Unknown session id: a first-class "no workspace", never a 500.
      await expect(harness.stack.clues.invokeApi(CLUES_WORKSPACE_FOR_SESSION_API, { sessionId: 's-unknown' }))
        .resolves.toEqual({ workspaceId: null })

      // Known session without a cwd: same answer.
      await expect(harness.stack.clues.invokeApi(CLUES_WORKSPACE_FOR_SESSION_API, { sessionId: 's-blank' }))
        .resolves.toEqual({ workspaceId: null })
    } finally {
      await harness.cleanup()
    }
  })

  it('releases routes, APIs, tools and runtime definitions through the effect disposers', async () => {
    const harness = await mountStack()
    try {
      expect(harness.routes).toHaveLength(4)
      expect(harness.routes.every(entry => entry.released)).toBe(false)
      expect(harness.stack.clues.hasApi(CLUES_WORKSPACE_FOR_SESSION_API)).toBe(true)
      expect(harness.stack.runtime.dependencies.getDefinitions()).toHaveLength(2)
      expect(harness.stack.runtime.connections.getDefinitions()).toHaveLength(2)

      expect(() => harness.dispose()).not.toThrow()
      expect(harness.routes.every(entry => entry.released)).toBe(true)
      expect(harness.stack.clues.hasApi(CLUES_WORKSPACE_FOR_SESSION_API)).toBe(false)
      expect(harness.stack.runtime.dependencies.getDefinitions()).toEqual([])
      expect(harness.stack.runtime.connections.getDefinitions()).toEqual([])
      expect(harness.stack.runtime.dependencies.getDefinition(GITHUB_DEPENDENCY_ID)).toBeUndefined()
      expect(harness.stack.runtime.connections.getDefinition(FEISHU_CONNECTION_ID)).toBeUndefined()

      // A repeated unload (HMR retry / double fiber dispose) is a strict no-op.
      expect(() => harness.dispose()).not.toThrow()
      expect(harness.routes.every(entry => entry.released)).toBe(true)
      expect(harness.stack.clues.hasApi(CLUES_WORKSPACE_FOR_SESSION_API)).toBe(false)
      expect(harness.stack.runtime.dependencies.getDefinitions()).toEqual([])
      expect(harness.stack.runtime.connections.getDefinitions()).toEqual([])
    } finally {
      await harness.cleanup()
    }
  })
})
