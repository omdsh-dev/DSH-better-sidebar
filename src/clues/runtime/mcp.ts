/**
 * The DSH-internal MCP boundary.
 *
 * A source adapter never speaks MCP itself: it declares a tool name and calls
 * this bridge, which dispatches through the HOST's public `ctx.tools.execute`
 * pipeline — so the host's MCP connection, guards, approval policy, audit and
 * cancellation are the only execution path (no hidden second MCP client, no
 * profile rewriting).
 *
 * Guard rules from the approved spec §3:
 * - a call is attributed to a REAL live agent resolved from the session id;
 *   the bridge never fabricates an agent, opens a hidden turn or starts an
 *   agent-less interactive approval;
 * - a UI call with no live agent may run a mapping the source declared as
 *   not needing approval; a mapping that may need approval answers the explicit
 *   `approval-required` state instead of executing;
 * - an agent-scoped call without a live agent answers `operation-unavailable`
 *   (it must not lose its session context);
 * - no tool registry / execution seam answers `operation-unavailable`;
 * - failures are normalized to fixed clue categories and never copy the host's
 *   raw failure text, content blocks or diagnostics.
 */
import { ClueError, isClueError } from '../error.ts'
import type { SidebarAgentsService, SidebarToolsService } from '../../context-types.ts'
import type { JsonValue } from '../types.ts'
import type { ClueMcpBridge, McpCallRequest, McpCallResult } from './types.ts'

/** Options of {@link createMcpBridge}. */
export interface McpBridgeOptions {
  /** Lazy host tool service (it may appear after the plugin mounts). */
  readonly getTools?: () => SidebarToolsService | undefined
  /** Lazy host agent registry (used to resolve a REAL live agent). */
  readonly getAgents?: () => SidebarAgentsService | undefined
  readonly newId?: () => string
}

/** Whether an optional signal has been aborted (opaque to TS narrowing). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Sanitized mapping of a host tool failure to a fixed category. */
function toolFailureCategory(result: { error?: { info?: { code?: string } } }): 'cancelled' | 'unsupported' | 'failed' {
  const code = result.error?.info?.code
  if (code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH') return 'cancelled'
  if (code === 'UNKNOWN_TOOL') return 'unsupported'
  return 'failed'
}

/**
 * Create the DSH-MCP bridge.
 * @param options - lazy tool/agent accessors + call-id generator.
 */
export function createMcpBridge(options: McpBridgeOptions = {}): ClueMcpBridge {
  let sequence = 0
  const newId = options.newId ?? (() => `${Date.now().toString(36)}-${++sequence}`)

  return {
    async callTool(
      request: McpCallRequest,
      context: { readonly caller: 'ui' | 'agent'; readonly sessionId?: string; readonly signal?: AbortSignal },
    ): Promise<McpCallResult> {
      const toolName = typeof request.toolName === 'string' ? request.toolName.trim() : ''
      if (toolName === '') {
        throw new ClueError('invalid-request', 'an MCP tool call needs a non-empty tool name')
      }
      if (request.arguments === null || typeof request.arguments !== 'object' || Array.isArray(request.arguments)) {
        throw new ClueError('invalid-request', 'MCP tool arguments must be a JSON object')
      }
      try {
        JSON.stringify(request.arguments)
      } catch {
        throw new ClueError('invalid-request', 'MCP tool arguments must be JSON-serializable')
      }
      const signal = context.signal ?? request.signal
      if (isAborted(signal)) {
        throw new ClueError('cancelled', 'the MCP tool call was cancelled')
      }
      const tools = options.getTools?.()
      if (tools?.execute === undefined) {
        return {
          status: 'operation-unavailable',
          message: 'DSH tool execution is not available in this deployment',
        }
      }
      const sessionId = request.sessionId ?? context.sessionId
      const agent = sessionId === undefined ? undefined : options.getAgents?.()?.get(sessionId)
      if (agent === undefined) {
        if (context.caller === 'agent') {
          // Never drop the session context of an agent-scoped call.
          return {
            status: 'operation-unavailable',
            message: 'the calling agent session is not live; this tool call needs its session context',
          }
        }
        // Fail closed: a mapping that may require the host's approval pipeline
        // cannot be approved for an idle UI request without a live agent turn.
        if (request.requiresApproval !== false) {
          return {
            status: 'approval-required',
            message: 'this DSH tool needs an approval channel that only a live agent turn provides',
          }
        }
      }
      const effectiveSignal = signal ?? new AbortController().signal
      let result
      try {
        result = await tools.execute({
          callId: `clue-mcp-${newId()}`,
          name: toolName,
          arguments: request.arguments,
          ...(agent === undefined ? {} : { agent }),
          signal: effectiveSignal,
        })
      } catch (error) {
        if (isAborted(signal)) throw new ClueError('cancelled', 'the MCP tool call was cancelled')
        if (isClueError(error)) throw error
        throw new ClueError('failed', 'the DSH tool call failed', { tool: toolName })
      }
      if (result.isError) {
        const category = toolFailureCategory(result)
        const message = category === 'unsupported'
          ? `the DSH tool "${toolName}" is not available`
          : category === 'cancelled'
            ? 'the DSH tool call was cancelled'
            : 'the DSH tool call failed'
        throw new ClueError(category, message, { tool: toolName })
      }
      let value = result.value
      if (value === undefined) value = null
      try {
        JSON.stringify(value)
      } catch {
        throw new ClueError('failed', 'the DSH tool returned a non-JSON value', { tool: toolName })
      }
      return { status: 'completed', value: value as JsonValue }
    },
  }
}
