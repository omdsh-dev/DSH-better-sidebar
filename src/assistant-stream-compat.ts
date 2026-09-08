/**
 * v2 assistant-stream compatibility.
 *
 * DSH 0.1.3 (Session format v2) removed top-level `assistant/chunk` events.
 * Each model attempt now commits ONE durable settlement — `assistant/message`
 * for a surfaced response, `assistant/attempt` for a failed/retried/cancelled
 * one — whose `stream` field carries the exact timed chunk sequence in the
 * lossless compact form owned by `@deepseek-ai/dsh-llm/assistant-stream`.
 *
 * This module expands those compact records locally instead of importing the
 * host package: the sidebar bundles the same helper into the browser client
 * and the host routes, and neither may assume the runtime exposes that
 * subpath. Unknown or malformed records are skipped rather than thrown on —
 * a reader must never break on a format it does not fully know — and v1 logs
 * keep arriving with top-level chunks, which never enter this path.
 *
 * @module
 */

/** One text/reasoning delta reconstructed from a compact v2 stream record. */
export interface CompatStreamDelta {
  readonly kind: 'assistant' | 'reasoning'
  readonly text: string
  /** Block index the delta belongs to, when the record carries one. */
  readonly index: number | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function blockIndexOf(record: Record<string, unknown>): number | undefined {
  const value = record.index
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

/**
 * Expand the compact `stream` records of one v2 Assistant settlement into the
 * ordered text/reasoning deltas the transcript and snapshot builders
 * accumulate.
 *
 * Handles both packed delta runs (`text-chunks` / `reasoning-chunks`) and raw
 * `chunk` records. Tool-call runs and any record shape a future encoding adds
 * are skipped, so the reader degrades to "no stream rows" instead of failing.
 *
 * @param stream - the `stream` field of a persisted Assistant settlement.
 * @returns deltas in their original order (empty for an unknown shape).
 */
export function assistantStreamDeltas(stream: unknown): CompatStreamDelta[] {
  const deltas: CompatStreamDelta[] = []
  for (const record of recordList(stream)) {
    const type = record.type
    if (type === 'text-chunks' || type === 'reasoning-chunks') {
      const kind: CompatStreamDelta['kind'] = type === 'text-chunks' ? 'assistant' : 'reasoning'
      const texts = record.texts
      if (!Array.isArray(texts)) continue
      const index = blockIndexOf(record)
      for (const text of texts) {
        if (typeof text === 'string' && text !== '') deltas.push({ kind, text, index })
      }
      continue
    }
    if (type === 'chunk') {
      const chunk = record.chunk
      if (!isRecord(chunk)) continue
      const chunkType = chunk.type
      const kind: CompatStreamDelta['kind'] | undefined = chunkType === 'text-delta'
        ? 'assistant'
        : chunkType === 'reasoning-delta'
          ? 'reasoning'
          : undefined
      const text = chunk.text
      if (kind === undefined || typeof text !== 'string' || text === '') continue
      deltas.push({ kind, text, index: blockIndexOf(chunk) })
    }
  }
  return deltas
}

/**
 * Deltas carried by one persisted event: the embedded v2 stream of
 * `assistant/message` / `assistant/attempt`, or `[]` for any other event.
 *
 * @param data - the event's `data` payload.
 * @returns reconstructed deltas in log order.
 */
export function assistantEventDeltas(data: unknown): CompatStreamDelta[] {
  return isRecord(data) ? assistantStreamDeltas(data.stream) : []
}
