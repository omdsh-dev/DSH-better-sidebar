// @vitest-environment jsdom
/**
 * S9 client total-assembly integration.
 *
 * Pins the browser half of the ONE assembled surface (not the per-subsystem
 * renderer/mention contracts, which have their own specs):
 * - `registerGithubSourceClient` + `registerFeishuSourceClient` install the
 *   four built-in source displays and the four content-format renderers on a
 *   REAL `createCluesClientRegistry`, and their disposers remove exactly those
 *   registrations so an HMR re-mount re-registers without a duplicate error;
 * - `installClueInputTriggers` registers both `@` sources exactly once inside
 *   the injected `inputTriggers` scope and releases them on disposal; a second
 *   install cycle does not duplicate anything;
 * - `resolveWorkspaceIdForSession` prefers the browser workspace list (when
 *   the item carries `workspaceId`) and falls back to the host's read-only
 *   `clues.workspaceForSession` POST, where `{ workspaceId: null }` means
 *   "no workspace" (undefined), not an error.
 *
 * Only the host boundary is faked: the wire is a stubbed `fetch` and the
 * Cordis seams are structural fakes. Every registration function is the real
 * one, and the labels come from the repo's own locale dictionaries.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import {
  CLUE_CODEC_SOURCE,
  PACK_CODEC_SOURCE,
} from '../src/clues/types.ts'
import {
  FEISHU_FORMATS,
  FEISHU_SOURCE_IDS,
} from '../src/clues/sources/feishu/format.ts'
import {
  GITHUB_FORMAT,
  GITHUB_SOURCE_IDS,
} from '../src/clues/sources/github/ids.ts'
import {
  createCluesClientRegistry,
  type BetterSidebarCluesClientFace,
} from '../src/client/clues/registry.ts'
import { registerGithubSourceClient } from '../src/client/clues/sources/github/index.tsx'
import { registerFeishuSourceClient } from '../src/client/clues/sources/feishu/index.tsx'
import {
  installClueInputTriggers,
  type ClueInputTriggerSource,
} from '../src/client/clues/mentions.ts'
import { resolveWorkspaceIdForSession } from '../src/client/clues/workspace-id.ts'
import { t } from '../src/client/locales.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'

// The spec asserts the English copy; the locale module resolves the browser
// language when no host locale service is attached.
Object.defineProperty(globalThis.navigator, 'language', { configurable: true, value: 'en-US' })

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The four format ids the assembled client registers, in registration order. */
const EXPECTED_FORMATS = [
  GITHUB_FORMAT,
  FEISHU_FORMATS.docsXml,
  FEISHU_FORMATS.docsMarkdown,
  FEISHU_FORMATS.taskDocument,
] as const

/** The four built-in source displays, in registration order. */
const EXPECTED_SOURCE_IDS = [
  GITHUB_SOURCE_IDS.issue,
  GITHUB_SOURCE_IDS.pull,
  FEISHU_SOURCE_IDS.docs,
  FEISHU_SOURCE_IDS.tasks,
] as const

/** Install both client halves on one real registry (the S9 wiring shape). */
function installClientSurface(registry: BetterSidebarCluesClientFace): () => void {
  const disposeGithub = registerGithubSourceClient(registry)
  const disposeFeishu = registerFeishuSourceClient(registry, {
    // S9 owns the dictionaries; the registrations consume their English text
    // exactly as the assembled client does under en-US.
    labels: {
      docsName: t('clueFeishuDocsName'),
      tasksName: t('clueFeishuTasksName'),
    },
    formatDateTime: value => `at:${value}`,
  })
  return () => {
    disposeFeishu()
    disposeGithub()
  }
}

/** Assert the complete assembled client surface is registered. */
function expectClientSurface(registry: BetterSidebarCluesClientFace): void {
  expect(registry.getSourceDisplays().map(display => display.sourceId)).toEqual([...EXPECTED_SOURCE_IDS])
  const docs = registry.getSourceDisplays().find(display => display.sourceId === FEISHU_SOURCE_IDS.docs)
  const tasks = registry.getSourceDisplays().find(display => display.sourceId === FEISHU_SOURCE_IDS.tasks)
  expect(docs?.name).toBe('Feishu docs')
  expect(tasks?.name).toBe('Feishu tasks')
  expect([...registry.getFormatRenderers().keys()]).toEqual([...EXPECTED_FORMATS])
  for (const format of EXPECTED_FORMATS) {
    expect(typeof registry.getFormatRenderer(format), format).toBe('function')
  }
}

/** A fake `inputTriggers` service that remembers exactly what is registered. */
interface TriggerHost {
  readonly service: { registerSource(source: ClueInputTriggerSource): () => void }
  readonly sources: ClueInputTriggerSource[]
  readonly registered: string[]
  readonly unregistered: string[]
}

/** One fake input-trigger service; duplicate names are refused like the host. */
function createTriggerHost(): TriggerHost {
  const sources: ClueInputTriggerSource[] = []
  const registered: string[] = []
  const unregistered: string[] = []
  return {
    sources,
    registered,
    unregistered,
    service: {
      registerSource(source: ClueInputTriggerSource): () => void {
        if (sources.some(existing => existing.name === source.name)) {
          throw new Error(`duplicate input trigger source "${source.name}"`)
        }
        sources.push(source)
        registered.push(source.name)
        return () => {
          const index = sources.indexOf(source)
          if (index === -1) return
          sources.splice(index, 1)
          unregistered.push(source.name)
        }
      },
    },
  }
}

/**
 * A structural client context whose `inject(['inputTriggers'])` hands the
 * callback one fresh fake service per install and returns a Cordis-like Fiber.
 */
function mentionsContext(
  face: BetterSidebarCluesClientFace,
  hosts: readonly TriggerHost[],
): { ctx: Context; injectedDeps: string[][]; fibers: Array<{ dispose(): void }> } {
  const injectedDeps: string[][] = []
  const fibers: Array<{ dispose(): void }> = []
  let installIndex = 0
  const ctx = {
    betterSidebar: { clues: face },
    inject: (deps: readonly string[], callback: (injected: unknown) => (() => void) | void) => {
      injectedDeps.push([...deps])
      const host = hosts[installIndex]
      installIndex += 1
      if (host === undefined) throw new Error('test setup: more installs than fake trigger services')
      const cleanup = callback({ inputTriggers: host.service })
      let disposed = false
      const fiber = {
        dispose: () => {
          if (disposed) return
          disposed = true
          cleanup?.()
        },
      }
      fibers.push(fiber)
      return fiber
    },
    logger: { warn: vi.fn() },
  } as unknown as Context
  return { ctx, injectedDeps, fibers }
}

/** One posted wire request observed by the stubbed fetch. */
interface Posted {
  readonly url: string
  readonly body: Record<string, unknown>
  readonly signal?: AbortSignal
}

/** Stub the host wire: record POSTs and answer one success envelope. */
function stubFetch(value: unknown): Posted[] {
  const posted: Posted[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    posted.push({
      url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      signal: init?.signal ?? undefined,
    })
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value }),
    } as unknown as Response
  }))
  return posted
}

/** One browser workspace-list snapshot item (host 0.2.1 view subset). */
interface WorkspaceItem {
  readonly path: string
  readonly sessionIds: readonly string[]
  readonly workspaceId?: string
}

/** A client context carrying the browser workspace list (or none). */
function workspacesContext(items: readonly WorkspaceItem[] | undefined): Context {
  return {
    get: (name: string) => name === 'workspaces' && items !== undefined
      ? { list: { getSnapshot: () => ({ phase: 'ready', state: 'idle', items }) } }
      : undefined,
  } as unknown as Context
}

describe('client clue total wiring', () => {
  it('registers every built-in display and renderer, and re-registers after disposal', () => {
    const registry = createCluesClientRegistry(() => SIDEBAR_PREFS_DEFAULTS)

    const dispose = installClientSurface(registry)
    expectClientSurface(registry)

    // The disposer removes exactly what each half registered: a later mount
    // (HMR) must not hit a duplicate-display/duplicate-format error.
    dispose()
    expect(registry.getSourceDisplays()).toEqual([])
    expect(registry.getFormatRenderers().size).toBe(0)
    expect(registry.getFormatRenderer(GITHUB_FORMAT)).toBeUndefined()

    const reinstall = installClientSurface(registry)
    expectClientSurface(registry)
    // Idempotent disposers: a double unload is a strict no-op.
    expect(() => { reinstall(); reinstall() }).not.toThrow()
    expect(registry.getSourceDisplays()).toEqual([])
    expect(registry.getFormatRenderers().size).toBe(0)
  })

  it('registers both @ sources exactly once per install and unregisters them on disposal', () => {
    const registry = createCluesClientRegistry(() => SIDEBAR_PREFS_DEFAULTS)
    const hosts = [createTriggerHost(), createTriggerHost()]
    const { ctx, injectedDeps, fibers } = mentionsContext(registry, hosts)

    const disposeFirst = installClueInputTriggers(ctx, { resolveWorkspaceId: () => 'ws-1' })
    const [first] = hosts
    expect(injectedDeps).toEqual([['inputTriggers']])
    // Both codec sources, each registered exactly once, on `@`.
    expect(first!.registered).toEqual([CLUE_CODEC_SOURCE, PACK_CODEC_SOURCE])
    expect(first!.sources.map(source => source.name)).toEqual([CLUE_CODEC_SOURCE, PACK_CODEC_SOURCE])
    expect(first!.sources.every(source => source.trigger === '@')).toBe(true)
    // The second cycle's service was never touched by the first install.
    expect(hosts[1]!.registered).toEqual([])

    disposeFirst()
    expect(first!.sources).toEqual([])
    expect(first!.unregistered).toEqual([CLUE_CODEC_SOURCE, PACK_CODEC_SOURCE])
    expect(fibers[0]).toBeDefined()

    // A fresh mount cycle (new injected service) registers the same two once.
    const disposeSecond = installClueInputTriggers(ctx, { resolveWorkspaceId: () => 'ws-1' })
    expect(injectedDeps).toEqual([['inputTriggers'], ['inputTriggers']])
    expect(hosts[1]!.registered).toEqual([CLUE_CODEC_SOURCE, PACK_CODEC_SOURCE])
    expect(hosts[1]!.sources).toHaveLength(2)

    disposeSecond()
    expect(hosts[1]!.sources).toEqual([])
    expect(hosts[1]!.unregistered).toEqual([CLUE_CODEC_SOURCE, PACK_CODEC_SOURCE])
  })

  it('reads the browser workspace list, then falls back to the host lookup on the wire', async () => {
    // 1. The item carries the stable id: no wire request is needed.
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const local = workspacesContext([{ path: '/repo', sessionIds: ['s1'], workspaceId: 'ws-local' }])
    await expect(resolveWorkspaceIdForSession(local, 's1')).resolves.toBe('ws-local')
    expect(fetchSpy).not.toHaveBeenCalled()

    // 2. An older/trimmed view has path + membership only: the host answers.
    const posted = stubFetch({ workspaceId: 'ws-host' })
    const older = workspacesContext([{ path: '/repo', sessionIds: ['s1'] }])
    await expect(resolveWorkspaceIdForSession(older, 's1')).resolves.toBe('ws-host')
    expect(posted).toHaveLength(1)
    expect(new URL(posted[0]!.url).pathname).toBe('/sidebar/api/clues.workspaceForSession')
    expect(posted[0]!.body).toEqual({ sessionId: 's1' })

    // 3. The host's "no workspace" answer is undefined, not a failure.
    const nullPosted = stubFetch({ workspaceId: null })
    await expect(resolveWorkspaceIdForSession(older, 's1')).resolves.toBeUndefined()
    expect(nullPosted).toHaveLength(1)
    expect(new URL(nullPosted[0]!.url).pathname).toBe('/sidebar/api/clues.workspaceForSession')
    expect(nullPosted[0]!.body).toEqual({ sessionId: 's1' })
  })
})
