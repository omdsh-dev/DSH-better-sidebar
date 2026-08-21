/**
 * mcp-status: the host's MCP roster derivation behind the sidebar MCP tab
 * (issue #276). The harness's dsh-mcp-client registers tools under the
 * server-qualified public names `mcp__<server>__<raw>` and exposes no status
 * service — the roster is grouped from the live tool registry, so a server
 * whose connection dropped (tools unregistered) cannot appear.
 */
import { describe, expect, it } from 'vitest'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  collectMcpStatus,
  parseMcpToolName,
  type McpStatus,
} from '../src/mcp-status.ts'

/** A minimal tool schema fixture (name + description are all the roster reads). */
function schema(name: string, description = ''): ToolSchema {
  return { name, description, parameters: {} }
}

/** Build a status from names alone (grouping/sorting/prefix concerns). */
function statusOf(names: string[]): McpStatus {
  return collectMcpStatus(names.map(name => schema(name, '')))
}

describe('parseMcpToolName', () => {
  it('splits a qualified name into server and raw tool', () => {
    expect(parseMcpToolName('mcp__playwright__click')).toEqual({ server: 'playwright', tool: 'click' })
    expect(parseMcpToolName('mcp__files__read_text')).toEqual({ server: 'files', tool: 'read_text' })
    // The first `__` separates server from tool; underscores inside either
    // part are preserved (server names may contain single underscores).
    expect(parseMcpToolName('mcp__my_server__read__text')).toEqual({ server: 'my_server', tool: 'read__text' })
  })

  it('rejects non-MCP and malformed names', () => {
    expect(parseMcpToolName('terminal_create')).toBeUndefined()
    expect(parseMcpToolName('run_code')).toBeUndefined()
    expect(parseMcpToolName('mcp__')).toBeUndefined()
    expect(parseMcpToolName('mcp__server')).toBeUndefined()
    expect(parseMcpToolName('mcp____tool')).toBeUndefined()
    expect(parseMcpToolName('mcp__server__')).toBeUndefined()
    expect(parseMcpToolName('')).toBeUndefined()
  })
})

describe('collectMcpStatus', () => {
  it('groups tools by server and sorts both levels by name', () => {
    const status = statusOf([
      'mcp__playwright__browser_click',
      'mcp__files__read',
      'mcp__playwright__browser_navigate',
      'terminal_create',
      'mcp__files__write',
    ])
    expect(status.servers.map(s => s.name)).toEqual(['files', 'playwright'])
    expect(status.servers[0]!.tools.map(t => t.name)).toEqual(['read', 'write'])
    expect(status.servers[1]!.tools.map(t => t.name)).toEqual(['browser_click', 'browser_navigate'])
  })

  it('carries the tool description through', () => {
    const status = collectMcpStatus([schema('mcp__playwright__click', 'Click an element')])
    expect(status.servers[0]!.tools[0]).toEqual({ name: 'click', description: 'Click an element' })
  })

  it('returns an empty roster when nothing is connected', () => {
    expect(statusOf([])).toEqual({ servers: [] })
    expect(statusOf(['terminal_create', 'run_code'])).toEqual({ servers: [] })
  })
})
