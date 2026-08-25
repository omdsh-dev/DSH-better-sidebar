/**
 * Unit tests for the `sidebar_open` tool layer: registry semantics
 * (per-session queue, consume-on-send delivery, attach replay, drain) and
 * the tool itself (URL/file/folder classification, relative-path resolution,
 * schema-valid canonical output, target-tab gating). The registry is real;
 * no WebSocket or browser is needed — the sender callbacks are captured.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { AgentOpenRegistry, registerOpenTool } from '../src/agent-opens.ts'
import type { Context } from '../src/context-types.ts'
import { SIDEBAR_PREFS_DEFAULTS, type SidebarPrefs } from '../src/prefs-shared.ts'

/** One registration captured by the fake tools service. */
interface CapturedTool {
  definition: ToolDefinition
}

/** A minimal ToolRunContext for one calling session. */
function exec(sessionId: string): ToolRunContext {
  return {
    signal: { throwIfAborted: () => {}, aborted: false },
    agent: { session: { id: sessionId } },
  } as unknown as ToolRunContext
}

/** Register the tool against a fake service + real registry. */
function mount(overrides: { prefs?: Partial<SidebarPrefs>; resolveCwd?: (sessionId: string) => string } = {}) {
  const captured: CapturedTool[] = []
  let disposeCount = 0
  const ctx = {
    tools: {
      register: (tool: unknown): (() => void) => {
        captured.push({ definition: tool as ToolDefinition })
        return () => { disposeCount += 1 }
      },
    },
  } as unknown as Context
  const registry = new AgentOpenRegistry()
  const prefs: SidebarPrefs = { ...SIDEBAR_PREFS_DEFAULTS, ...overrides.prefs }
  const dispose = registerOpenTool(
    ctx,
    registry,
    overrides.resolveCwd ?? (() => '/cwd'),
    () => prefs,
  )
  return { captured, registry, prefs, dispose: () => { dispose(); return disposeCount } }
}

/** The captured definition for one tool name. */
function toolOf(captured: CapturedTool[], name: string): ToolDefinition {
  const found = captured.find(candidate => candidate.definition.name === name)
  if (found === undefined) throw new Error(`tool "${name}" was not registered`)
  return found.definition
}

describe('AgentOpenRegistry', () => {
  it('queues without a subscriber, replays on attach (consume-on-send), and reports delivered', () => {
    const registry = new AgentOpenRegistry()
    const queued = registry.enqueue('s1', 'folder', '/work/src', 'src')
    expect(queued.delivered).toBe(false)

    const received: unknown[] = []
    const detach = registry.attach('s1', (request) => { received.push(request) })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ kind: 'folder', target: '/work/src', title: 'src', sessionId: 's1' })

    // The request was consumed on send: a second attach sees nothing.
    const later: unknown[] = []
    const detach2 = registry.attach('s1', (request) => { later.push(request) })
    expect(later).toHaveLength(0)

    detach()
    detach2()
  })

  it('delivers immediately and does not queue when a subscriber is attached', () => {
    const registry = new AgentOpenRegistry()
    const received: unknown[] = []
    const detach = registry.attach('s2', (request) => { received.push(request) })
    const result = registry.enqueue('s2', 'url', 'https://example.com/', 'example.com')
    expect(result.delivered).toBe(true)
    expect(received).toHaveLength(1)
    // Consumed on send: a reconnect never replays (no duplicate browser tabs).
    const later: unknown[] = []
    const detach2 = registry.attach('s2', (request) => { later.push(request) })
    expect(later).toHaveLength(0)
    detach()
    detach2()
  })

  it('owner-scopes the queue: one session never leaks into another', () => {
    const registry = new AgentOpenRegistry()
    registry.enqueue('s1', 'file', '/a.txt', 'a.txt')

    const other: unknown[] = []
    const detach = registry.attach('s2', (request) => { other.push(request) })
    expect(other).toHaveLength(0)

    const own: unknown[] = []
    const detach2 = registry.attach('s1', (request) => { own.push(request) })
    expect(own).toHaveLength(1)
    detach()
    detach2()
  })

  it('drainAll drops the queue and dispose drops subscribers', () => {
    const registry = new AgentOpenRegistry()
    registry.enqueue('s1', 'file', '/a.txt', 'a.txt')
    registry.drainAll()
    const received: unknown[] = []
    const detach = registry.attach('s1', (request) => { received.push(request) })
    expect(received).toHaveLength(0)

    registry.dispose()
    // After dispose the previously-returned disposer is a no-op (idempotent).
    detach()
    detach()
  })
})

describe('sidebar_open tool', () => {
  it('registers the single tool and the disposer unregisters it', () => {
    const { captured, dispose } = mount()
    expect(captured.map(candidate => candidate.definition.name)).toEqual(['sidebar_open'])
    expect(dispose()).toBe(1)
    expect(() => mount().dispose()).not.toThrow()
  })

  it('opens an existing file (schema-valid output, delivered with a subscriber)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sidebar-open-'))
    try {
      const file = join(dir, 'a.txt')
      writeFileSync(file, 'hello')
      const { captured, registry } = mount({ resolveCwd: () => dir })
      const received: unknown[] = []
      const detach = registry.attach('s1', (request) => { received.push(request) })
      const tool = toolOf(captured, 'sidebar_open')
      const value = await tool.execute({ target: file }, exec('s1'))
      expect(value).toEqual({ kind: 'file', target: file, title: 'a.txt', delivered: true })
      expect(validateJsonSchemaValue(tool.output.schema, value, 'value')).toEqual([])
      expect(received).toHaveLength(1)
      detach()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a relative path against the session cwd and queues when no view is attached', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sidebar-open-'))
    try {
      writeFileSync(join(dir, 'note.md'), '# hi')
      const { captured, registry } = mount({ resolveCwd: () => dir })
      const tool = toolOf(captured, 'sidebar_open')
      const value = await tool.execute({ target: 'note.md' }, exec('s1'))
      expect(value).toMatchObject({ kind: 'file', target: join(dir, 'note.md'), title: 'note.md', delivered: false })
      // Queued: a later attach replays it.
      const received: unknown[] = []
      const detach = registry.attach('s1', (request) => { received.push(request) })
      expect(received).toHaveLength(1)
      detach()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('classifies a directory as folder and applies a custom title', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sidebar-open-'))
    try {
      const sub = join(dir, 'src')
      mkdirSync(sub)
      const { captured } = mount({ resolveCwd: () => dir })
      const tool = toolOf(captured, 'sidebar_open')
      const value = await tool.execute({ target: sub, title: 'Sources' }, exec('s1'))
      expect(value).toEqual({ kind: 'folder', target: sub, title: 'Sources', delivered: false })
      expect(validateJsonSchemaValue(tool.output.schema, value, 'value')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('classifies an http(s) URL, titles it by hostname, and never stats it', async () => {
    const { captured } = mount()
    const tool = toolOf(captured, 'sidebar_open')
    const value = await tool.execute({ target: 'https://example.com/docs' }, exec('s1'))
    expect(value).toEqual({ kind: 'url', target: 'https://example.com/docs', title: 'example.com', delivered: false })
  })

  it('rejects non-http(s) schemes', async () => {
    const { captured } = mount()
    const tool = toolOf(captured, 'sidebar_open')
    for (const target of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://file/x']) {
      await expect(tool.execute({ target }, exec('s1'))).rejects.toThrow(/only accepts http/)
    }
  })

  it('reports a missing local path instead of opening it', async () => {
    const { captured } = mount({ resolveCwd: () => '/definitely/missing' })
    const tool = toolOf(captured, 'sidebar_open')
    await expect(tool.execute({ target: '/definitely/missing/nope.txt' }, exec('s1')))
      .rejects.toThrow(/does not exist/)
  })

  it('refuses a disabled target tab type with a clear cause', async () => {
    const { captured } = mount({ prefs: { tabsEnabled: { browser: false } } })
    const tool = toolOf(captured, 'sidebar_open')
    await expect(tool.execute({ target: 'https://example.com/' }, exec('s1')))
      .rejects.toThrow(/browser tab is disabled/)

    const dir = mkdtempSync(join(tmpdir(), 'sidebar-open-'))
    try {
      writeFileSync(join(dir, 'f.txt'), 'x')
      const { captured: fileCaptured } = mount({ resolveCwd: () => dir, prefs: { tabsEnabled: { editor: false } } })
      const fileTool = toolOf(fileCaptured, 'sidebar_open')
      // A URL is unaffected by the editor gate; a path is refused with cause.
      await expect(fileTool.execute({ target: 'https://example.com/' }, exec('s1'))).resolves.toMatchObject({ kind: 'url' })
      await expect(fileTool.execute({ target: 'f.txt' }, exec('s1'))).rejects.toThrow(/editor tab is disabled/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws the canonical no-agent error when executed without an agent', async () => {
    const { captured } = mount()
    const tool = toolOf(captured, 'sidebar_open')
    await expect(tool.execute({ target: '/tmp/x' }, { signal: { throwIfAborted: () => {}, aborted: false } } as unknown as ToolRunContext))
      .rejects.toThrow(/requires an initiating agent/)
  })
})
