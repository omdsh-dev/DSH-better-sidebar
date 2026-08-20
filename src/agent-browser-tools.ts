import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentBrowserManager, AgentBrowserSnapshot, SnapshotDiff } from './agent-browser.ts'
import type { Context } from './context-types.ts'

function sessionIdOf(exec: ToolRunContext): string {
  const agent = exec.agent as Agent | undefined
  if (agent === undefined) throw new Error('agent browser requires an initiating agent')
  return agent.session.id
}

function renderElements(elements: AgentBrowserSnapshot['elements'], cap = 60): string {
  const lines = elements.slice(0, cap).map(el =>
    `[${el.ref}] <${el.tag}${el.type ? ` type="${el.type}"` : ''}> ${el.label || el.href || ''}`)
  const out = lines.join('\n')
  if (elements.length > cap) return `${out}\n…(${elements.length - cap} more elements)`
  return out
}

function renderChanged(changed: SnapshotDiff): string {
  const parts = [
    `url: ${changed.urlChanged ? 'CHANGED' : 'same'}`,
    `title: ${changed.titleChanged ? 'CHANGED' : 'same'}`,
    `text: ${changed.textDelta >= 0 ? '+' : ''}${changed.textDelta} chars`,
    `elements: +${changed.added.length} added, -${changed.removed.length} removed`,
  ]
  const out = parts.join(' | ')
  if (changed.added.length === 0 && changed.removed.length === 0) return out
  const lines = [out]
  for (const el of changed.added.slice(0, 5)) {
    lines.push(`  + [${el.ref}] <${el.tag}${el.type ? ` type="${el.type}"` : ''}> ${el.label.slice(0, 60)}`)
  }
  for (const el of changed.removed.slice(0, 5)) {
    lines.push(`  - <${el.tag}${el.type ? ` type="${el.type}"` : ''}> ${el.label.slice(0, 60)}`)
  }
  return lines.join('\n')
}

function renderSnapshot(_args: unknown, value: unknown): ContentBlock[] {
  const snap = value as AgentBrowserSnapshot
  const lines: string[] = []
  lines.push(`[${snap.title}](${snap.url})`)
  lines.push(snap.text.slice(0, 4000))
  if (snap.textLength > 4000) lines.push(`…(text truncated, ${snap.textLength} chars total)`)
  if (snap.changed !== null) {
    lines.push('')
    lines.push('changed:')
    lines.push(renderChanged(snap.changed))
  }
  lines.push('')
  lines.push('elements:')
  lines.push(renderElements(snap.elements))
  return [{ type: 'text', text: lines.join('\n') }]
}

const snapshotSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    url: { type: 'string', required: true },
    title: { type: 'string', required: true },
    text: { type: 'string', required: true },
    textLength: { type: 'number', required: true },
    links: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      t: { type: 'string', required: true }, h: { type: 'string', required: true },
    } } },
    elements: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      ref: { type: 'number', required: true }, tag: { type: 'string', required: true },
      type: { type: 'string', required: true }, label: { type: 'string', required: true }, href: { type: 'string', required: true },
    } } },
    screenshot: { type: 'string', required: true },
    updatedAt: { type: 'number', required: true },
    changed: { type: 'json', required: true },
  },
} as const

const snapshotOutput = {
  schema: snapshotSchema,
  render: renderSnapshot,
} as const

export function registerAgentBrowserTools(ctx: Context, manager: AgentBrowserManager): () => void {
  const disposers: Array<() => void> = []
  const register = (tool: ReturnType<typeof defineTool>): void => {
    disposers.push(ctx.tools.register(tool))
  }

  register(defineTool({
    name: 'browser_open',
    description:
      'Open or navigate the current session browser to an HTTP(S) URL. '
      + 'Returns a structured text snapshot: title, URL, visible text, links, and a numbered element list. '
      + 'The controlled browser is mirrored in the sidebar so the user can watch it.',
    parameters: { url: { type: 'string', required: true, description: 'HTTP(S) URL to open.' } },
    output: snapshotOutput,
    execute: async (args: { url: string }, exec) => {
      exec.signal.throwIfAborted()
      if (!/^https?:\/\//i.test(args.url)) throw new Error('browser_open only accepts http:// or https:// URLs')
      return manager.open(sessionIdOf(exec), args.url)
    },
  }))

  register(defineTool({
    name: 'browser_snapshot',
    description:
      'Read the current page of the session browser as structured text: title, URL, visible text, links, '
      + 'a NUMBERED list of interactive elements, and a change summary versus the previous snapshot. '
      + 'Use the element numbers (refs) with browser_click/browser_type — never guess CSS selectors. '
      + 'Re-run after navigation; refs go stale when the page changes.',
    parameters: {},
    output: snapshotOutput,
    execute: async (_args, exec) => { exec.signal.throwIfAborted(); return manager.snapshot(sessionIdOf(exec)) },
  }))

  register(defineTool({
    name: 'browser_click',
    description:
      'Click an element in the session browser by its snapshot ref (number) or a CSS selector. '
      + 'Scrolls it into view first. Returns a fresh structured snapshot.',
    parameters: {
      ref: { type: 'number', description: 'Element ref from the numbered list in browser_snapshot/browser_open. Takes precedence over selector.' },
      selector: { type: 'string', description: 'CSS selector of the element to click (fallback when you have no ref).' },
    },
    output: snapshotOutput,
    execute: async (args: { ref?: number; selector?: string }, exec) => {
      exec.signal.throwIfAborted()
      const target = typeof args.ref === 'number' ? args.ref : args.selector
      if (target === undefined) throw new Error('provide ref or selector')
      return manager.click(sessionIdOf(exec), target)
    },
  }))

  register(defineTool({
    name: 'browser_type',
    description:
      'Type text into an input/textarea in the session browser by snapshot ref (number) or CSS selector. '
      + 'Sets the value through the native setter and fires input/change events, so framework-managed forms (React/Vue) observe it.',
    parameters: {
      ref: { type: 'number', description: 'Element ref from the numbered list in browser_snapshot/browser_open. Takes precedence over selector.' },
      selector: { type: 'string', description: 'CSS selector of the input or textarea (fallback when you have no ref).' },
      text: { type: 'string', required: true, description: 'Text to type.' },
      submit: { type: 'boolean', description: 'Press Enter after filling.' },
    },
    output: snapshotOutput,
    execute: async (args: { ref?: number; selector?: string; text: string; submit?: boolean }, exec) => {
      exec.signal.throwIfAborted()
      const target = typeof args.ref === 'number' ? args.ref : args.selector
      if (target === undefined) throw new Error('provide ref or selector')
      return manager.type(sessionIdOf(exec), target, args.text, args.submit === true)
    },
  }))

  register(defineTool({
    name: 'browser_press',
    description:
      'Press a keyboard key in the session browser (Enter, Tab, Escape, Backspace, arrows, or a single character). '
      + 'Use Enter to submit forms, Tab to move focus.',
    parameters: { key: { type: 'string', required: true, description: 'Key to press, e.g. Enter.' } },
    output: snapshotOutput,
    execute: async (args: { key: string }, exec) => {
      exec.signal.throwIfAborted()
      return manager.press(sessionIdOf(exec), args.key)
    },
  }))

  register(defineTool({
    name: 'browser_back',
    description: 'Go back to the previous page in the session browser history. Returns a fresh structured snapshot.',
    parameters: {},
    output: snapshotOutput,
    execute: async (_args, exec) => {
      exec.signal.throwIfAborted()
      return manager.back(sessionIdOf(exec))
    },
  }))

  register(defineTool({
    name: 'browser_reload',
    description: 'Reload the current page in the session browser. Returns a fresh structured snapshot.',
    parameters: {},
    output: snapshotOutput,
    execute: async (_args, exec) => {
      exec.signal.throwIfAborted()
      return manager.reload(sessionIdOf(exec))
    },
  }))

  register(defineTool({
    name: 'browser_wait',
    description:
      'Wait for the page to settle before the next action: async content, animations, or slow JavaScript. '
      + 'Takes milliseconds (1-30000, default 1000).',
    parameters: { ms: { type: 'number', description: 'Milliseconds to wait (1-30000, default 1000).' } },
    output: snapshotOutput,
    execute: async (args: { ms?: number }, exec) => {
      exec.signal.throwIfAborted()
      return manager.wait(sessionIdOf(exec), args.ms ?? 1000)
    },
  }))

  register(defineTool({
    name: 'browser_eval',
    description:
      'Evaluate a JavaScript expression in the session browser page and return the result as JSON. '
      + 'Use for reading state that is not in the text snapshot. The expression runs in page context.',
    parameters: { expression: { type: 'string', required: true, description: 'JavaScript expression to evaluate in the page.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        ok: { type: 'boolean', required: true }, type: { type: 'string', required: true }, text: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: (value as { ok: boolean; type: string; text: string }).ok
        ? `type=${(value as { type: string }).type} value=${(value as { text: string }).text}`
        : `eval failed: ${(value as { text: string }).text}` }],
    },
    execute: async (args: { expression: string }, exec) => {
      exec.signal.throwIfAborted()
      return manager.evalJs(sessionIdOf(exec), args.expression)
    },
  }))

  register(defineTool({
    name: 'browser_close',
    description: 'Close the current session controlled browser and release its browser process.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        sessionId: { type: 'string', required: true }, closed: { type: 'boolean', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: (value as { sessionId: string; closed: boolean }).closed
        ? `Closed browser for ${(value as { sessionId: string }).sessionId}.`
        : 'Browser was already closed.' }],
    },
    execute: async (_args, exec) => {
      const sessionId = sessionIdOf(exec)
      return { sessionId, closed: await manager.close(sessionId) }
    },
  }))

  return () => disposers.forEach(dispose => dispose())
}
