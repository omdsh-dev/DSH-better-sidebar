/**
 * MCP server status for the sidebar's MCP tab (issue #276). The harness's
 * @deepseek-ai/dsh-mcp-client exposes no status service: each instance merely
 * connects one MCP server and registers its tools on `ctx.tools` under the
 * server-qualified public names `mcp__<serverName>__<rawName>` (documented in
 * the package's own types). The live tool registry is therefore the only
 * truthful status source — a registered `mcp__*` tool proves its server is
 * connected, and a lost connection unregisters every tool of that server (the
 * client's supervisor contract) — so the roster below is derived from
 * `ctx.tools.schemas()` with no DSH source touched.
 *
 * Pure logic with an injected tool-schema source, so the whole surface is
 * unit-testable without a Cordis context or a real registry.
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** The public-name prefix dsh-mcp-client uses: `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = 'mcp__'

/** One MCP server's tool as shown in the panel (display name + description). */
export interface McpToolInfo {
  /** The raw tool name without the `mcp__<server>__` prefix. */
  name: string
  /** The tool's model-facing description (empty string when the server sent none). */
  description?: string
}

/** One connected MCP server (issue #276): server name + its tool list. */
export interface McpServerStatus {
  name: string
  tools: McpToolInfo[]
}

/** The full status snapshot served to the browser half. */
export interface McpStatus {
  servers: McpServerStatus[]
}

/**
 * Split a registered tool name `mcp__<server>__<raw>` into its server and
 * raw tool parts. Returns undefined for names outside the `mcp__` namespace
 * (or malformed ones), so non-MCP tools pass through untouched.
 * @param name - the tool name as registered (e.g. `mcp__playwright__click`).
 * @returns the server and raw tool parts, or undefined when not an MCP tool.
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
  const rest = name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : undefined
  if (rest === undefined || rest === '') return undefined
  const sep = rest.indexOf('__')
  if (sep === -1) return undefined
  const server = rest.slice(0, sep)
  const tool = rest.slice(sep + 2)
  if (server === '' || tool === '') return undefined
  return { server, tool }
}

/**
 * Build the MCP status snapshot from the live tool registry: group every
 * registered `mcp__*` tool by its server. Servers and tools are sorted by
 * name for a stable panel. A server absent from the registry is not
 * connected (its tools were unregistered), so it cannot appear here.
 * @param schemas - the registry's tool schemas (`ctx.tools.schemas()`).
 * @returns the grouped server roster.
 */
export function collectMcpStatus(schemas: readonly ToolSchema[]): McpStatus {
  const byServer = new Map<string, McpToolInfo[]>()
  for (const schema of schemas) {
    const parsed = parseMcpToolName(schema.name)
    if (parsed === undefined) continue
    const tools = byServer.get(parsed.server) ?? []
    tools.push({ name: parsed.tool, description: schema.description })
    byServer.set(parsed.server, tools)
  }
  const servers: McpServerStatus[] = []
  for (const [name, tools] of byServer) {
    tools.sort((a, b) => a.name.localeCompare(b.name))
    servers.push({ name, tools })
  }
  servers.sort((a, b) => a.name.localeCompare(b.name))
  return { servers }
}
