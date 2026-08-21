/**
 * Pure derivation of the compact LIVE line shown on a running subagent card:
 * the last text output and the last tool call of the child's session events.
 * The host batch route feeds raw session events into this parser; the client
 * only receives the already-folded `LastActivity` map. Renders nothing
 * itself — the SubagentView component turns this into the card's status
 * lines. Kept framework-free so the parser is unit-testable in the node
 * environment.
 */
import type { SidebarSessionEvent } from './context-types.ts'

/**
 * Extract the concatenated plain text of a content-block list (the durable
 * `ContentBlock[]` shape, structurally: blocks with `type: 'text'` carry
 * `text`; anything else — tool_use, image, … — contributes nothing).
 * @param content - the raw `content` field of a message event.
 * @returns the joined text, or undefined when the message carries no text.
 */
export function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      parts.push(candidate.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** The live status of one subagent card (both fields optional). */
export interface LastActivity {
  /** The latest assembled assistant text output in the tail. */
  text?: string
  /** The latest tool call in the tail. */
  tool?: { name: string; args: string }
}

/**
 * Fold a session event log into the last text output + last tool call (each
 * is the LAST occurrence in event order). Lifecycle events and raw
 * `assistant/chunk` rows are ignored — the card shows what the subagent is
 * doing right now, not its plumbing. The scan runs BACKWARD from the newest
 * event and stops once both fields are found, so a long history costs only
 * the recent tail in the common case.
 * @param events - the session's append-only event log (oldest → newest).
 * @returns the last text and/or tool call; an empty object when the log has neither.
 */
export function lastActivity(events: readonly SidebarSessionEvent[]): LastActivity {
  let text: string | undefined
  let tool: { name: string; args: string } | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (text !== undefined && tool !== undefined) break
    const event = events[index]
    if (event === undefined) continue
    const { type, data } = event
    if (text === undefined && type === 'assistant/message') {
      const message = data.message as { content?: unknown } | undefined
      const extracted = contentText(message?.content)
      if (extracted !== undefined) text = extracted
    } else if (tool === undefined && type === 'tool/call') {
      tool = {
        name: typeof data.name === 'string' ? data.name : 'tool',
        args: typeof data.arguments === 'string' ? data.arguments : '',
      }
    }
  }
  if (text === undefined && tool === undefined) return {}
  return {
    ...(text === undefined ? {} : { text }),
    ...(tool === undefined ? {} : { tool }),
  }
}
