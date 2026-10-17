/**
 * S2 DSH-MCP bridge contract (fake host tool registry/agents; no MCP server).
 *
 * Pins the approved §3 guard rules:
 * - dispatch goes ONLY through the host's public `ctx.tools.execute` path (the
 *   fake proves the arguments and the caller signal arrive there);
 * - a UI call with no live agent may execute a mapping declared as
 *   `requiresApproval: false`, but a mapping that may need approval answers the
 *   explicit `approval-required` state WITHOUT executing;
 * - an agent-scoped call without its live agent answers
 *   `operation-unavailable` instead of losing the session context;
 * - a missing tool-execution seam answers `operation-unavailable`; no tool is
 *   registered by the bridge;
 * - failures normalize to clue categories and never copy raw host text.
 */
import { describe, expect, it } from 'vitest'
import { ClueError } from '../src/clues/error.ts'
import { createMcpBridge } from '../src/clues/runtime/mcp.ts'
import type {
  SidebarAgentsService,
  SidebarToolExecutionInput,
  SidebarToolsService,
} from '../src/context-types.ts'

interface HarnessOptions {
  readonly execute?: (input: SidebarToolExecutionInput) => Promise<unknown>
  readonly agents?: SidebarAgentsService
  readonly withoutTools?: boolean
}

function harness(options: HarnessOptions = {}): {
  bridge: ReturnType<typeof createMcpBridge>
  executions: SidebarToolExecutionInput[]
} {
  const executions: SidebarToolExecutionInput[] = []
  const tools: SidebarToolsService = {
    register: () => () => undefined,
    async execute(input) {
      executions.push(input)
      if (options.execute !== undefined) return await options.execute(input) as never
      return { isError: false, value: { ok: true } }
    },
  }
  const bridge = createMcpBridge({
    ...(options.withoutTools === true ? {} : { getTools: () => tools }),
    ...(options.agents === undefined ? {} : { getAgents: () => options.agents }),
  })
  return { bridge, executions }
}

const AGENT = { id: 'session-1', session: { header: { cwd: '/work' } } }

function agentsWith(entries: Record<string, unknown>): SidebarAgentsService {
  return {
    get: id => entries[id] as never,
  }
}

describe('MCP bridge guard rules', () => {
  it('executes a no-approval read-only mapping for a UI request without faking an agent', async () => {
    const { bridge, executions } = harness()
    const result = await bridge.callTool(
      { toolName: 'mcp.feishu.docs_search', arguments: { query: 'spec' }, requiresApproval: false },
      { caller: 'ui' },
    )
    expect(result).toEqual({ status: 'completed', value: { ok: true } })
    expect(executions).toHaveLength(1)
    expect(executions[0]).toMatchObject({
      name: 'mcp.feishu.docs_search',
      arguments: { query: 'spec' },
    })
    expect(executions[0]?.agent).toBeUndefined()
  })

  it('answers approval-required for a restricted UI call with no live agent and executes nothing', async () => {
    const { bridge, executions } = harness()
    const result = await bridge.callTool(
      { toolName: 'mcp.feishu.doc_update', arguments: { id: 'doc-1' } },
      { caller: 'ui' },
    )
    expect(result.status).toBe('approval-required')
    expect(executions).toHaveLength(0)
  })

  it('passes the real live agent for a UI call when the session resolves one', async () => {
    const { bridge, executions } = harness({ agents: agentsWith({ 'session-1': AGENT }) })
    const result = await bridge.callTool(
      { toolName: 'mcp.feishu.doc_update', arguments: { id: 'doc-1' }, sessionId: 'session-1' },
      { caller: 'ui' },
    )
    expect(result.status).toBe('completed')
    expect(executions[0]?.agent).toBe(AGENT)
  })

  it('answers operation-unavailable for an agent-scoped call without its live agent', async () => {
    const { bridge, executions } = harness({ agents: agentsWith({}) })
    const result = await bridge.callTool(
      { toolName: 'mcp.feishu.docs_read', arguments: {}, sessionId: 'gone', requiresApproval: false },
      { caller: 'agent', sessionId: 'gone' },
    )
    expect(result.status).toBe('operation-unavailable')
    expect(executions).toHaveLength(0)
  })

  it('uses the context session as the agent address and forwards the caller signal', async () => {
    const controller = new AbortController()
    const { bridge, executions } = harness({ agents: agentsWith({ 'session-9': AGENT }) })
    await bridge.callTool(
      { toolName: 'mcp.feishu.docs_read', arguments: {}, requiresApproval: false },
      { caller: 'agent', sessionId: 'session-9', signal: controller.signal },
    )
    expect(executions[0]?.agent).toBe(AGENT)
    expect(executions[0]?.signal).toBe(controller.signal)
  })

  it('answers operation-unavailable when the deployment has no tool-execution seam', async () => {
    const { bridge, executions } = harness({ withoutTools: true })
    const result = await bridge.callTool(
      { toolName: 'mcp.feishu.docs_read', arguments: {}, requiresApproval: false },
      { caller: 'ui' },
    )
    expect(result.status).toBe('operation-unavailable')
    expect(executions).toHaveLength(0)
  })

  it('refuses an already-cancelled call before dispatching', async () => {
    const { bridge, executions } = harness()
    const controller = new AbortController()
    controller.abort()
    await expect(bridge.callTool(
      { toolName: 'mcp.feishu.docs_read', arguments: {}, requiresApproval: false },
      { caller: 'ui', signal: controller.signal },
    )).rejects.toMatchObject({ category: 'cancelled' })
    expect(executions).toHaveLength(0)
  })

  it('maps an unknown host tool to unsupported without leaking its message', async () => {
    const { bridge } = harness({
      execute: async () => ({
        isError: true,
        error: { message: 'secret host detail', info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' } },
      }),
    })
    const error = await bridge.callTool(
      { toolName: 'mcp.missing', arguments: {}, requiresApproval: false },
      { caller: 'ui' },
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClueError)
    expect((error as ClueError).category).toBe('unsupported')
    expect((error as ClueError).message).not.toContain('secret host detail')
    expect((error as ClueError).meta).toEqual({ tool: 'mcp.missing' })
  })

  it('maps a general host failure to failed and an aborted execution to cancelled', async () => {
    const failure = harness({
      execute: async () => ({
        isError: true,
        error: { message: 'raw provider text', info: { name: 'ToolError', code: 'TOOL_FAILED' } },
      }),
    })
    await expect(failure.bridge.callTool(
      { toolName: 'mcp.feishu.doc_update', arguments: {}, requiresApproval: false },
      { caller: 'ui' },
    )).rejects.toMatchObject({ category: 'failed', meta: { tool: 'mcp.feishu.doc_update' } })

    const aborted = harness({
      execute: async () => ({
        isError: true,
        error: { message: 'aborted', info: { name: 'AbortError', code: 'ABORTED' } },
      }),
    })
    await expect(aborted.bridge.callTool(
      { toolName: 'mcp.feishu.doc_update', arguments: {}, requiresApproval: false },
      { caller: 'ui' },
    )).rejects.toMatchObject({ category: 'cancelled' })
  })

  it('normalizes a thrown host failure without copying its text', async () => {
    const { bridge } = harness({
      execute: async () => { throw new Error('raw token=leak') },
    })
    const error = await bridge.callTool(
      { toolName: 'mcp.feishu.docs_read', arguments: {}, requiresApproval: false },
      { caller: 'ui' },
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClueError)
    expect((error as ClueError).category).toBe('failed')
    expect((error as ClueError).message).not.toContain('leak')
  })

  it('validates the tool name and arguments before dispatching', async () => {
    const { bridge, executions } = harness()
    await expect(bridge.callTool(
      { toolName: ' ', arguments: {}, requiresApproval: false },
      { caller: 'ui' },
    )).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(bridge.callTool(
      { toolName: 'mcp.x', arguments: [] as never, requiresApproval: false },
      { caller: 'ui' },
    )).rejects.toMatchObject({ category: 'invalid-request' })
    expect(executions).toHaveLength(0)
  })

  it('turns an undefined tool value into null and refuses a non-JSON value', async () => {
    const undefinedValue = harness({ execute: async () => ({ isError: false }) })
    expect(await undefinedValue.bridge.callTool(
      { toolName: 'mcp.x', arguments: {}, requiresApproval: false },
      { caller: 'ui' },
    )).toEqual({ status: 'completed', value: null })

    const circular: { self?: unknown } = {}
    circular.self = circular
    const invalid = harness({ execute: async () => ({ isError: false, value: circular }) })
    await expect(invalid.bridge.callTool(
      { toolName: 'mcp.x', arguments: {}, requiresApproval: false },
      { caller: 'ui' },
    )).rejects.toMatchObject({ category: 'failed' })
  })
})
