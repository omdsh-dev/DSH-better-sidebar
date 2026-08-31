/**
 * File-operation extraction for the changes tab's session lens: folds the
 * session's append-only event log (`tool/call` + `tool/result` pairs) into
 * one op per file-touching call — the same semantics as the standalone
 * dsh-file-trace plugin's Chat-view extraction, reading the authoritative
 * event log instead (the repo's stated preference for cross-feature session
 * data). Pure — no React, no DOM.
 */
import type { SidebarSessionEvent } from '../../context-types.ts'

/** The file-touching operation kinds the tracer distinguishes. */
export type FileOpKind = 'read' | 'write' | 'edit'

/** One extracted file operation. */
export interface FileOp {
  /** Stable identity: the originating tool-call id. */
  readonly callId: string
  readonly kind: FileOpKind
  /** Workspace-relative or absolute path exactly as the model spelled it. */
  readonly path: string
  /** Unix epoch ms of the call; the result time when only that is known. */
  readonly time: number
  /** True while the call has no result yet. */
  readonly running: boolean
  /** True when the result reported an error. */
  readonly isError: boolean
  /** The result's error text when isError; presented instead of the payload. */
  readonly errorText?: string
  /** For 'edit': the model's exact replacement payload. */
  readonly edit?: { oldString: string; newString: string }
  /** For 'write': the full new content. */
  readonly content?: string
  /** For 'read': the file content returned by the tool result. */
  readonly read?: string
}

/** Tool names mapped to each op kind; unknown names are ignored. */
const READ_TOOLS = new Set(['read', 'view', 'see'])
const WRITE_TOOLS = new Set(['write', 'create'])
const EDIT_TOOLS = new Set(['edit', 'str_replace', 'str-replace-editor', 'multi-edit'])

/** Classify one tool name; undefined when the tool touches no file. */
function kindOf(name: string): FileOpKind | undefined {
  if (READ_TOOLS.has(name)) return 'read'
  if (WRITE_TOOLS.has(name)) return 'write'
  if (EDIT_TOOLS.has(name)) return 'edit'
  return undefined
}

/**
 * Parse one tool-call arguments JSON body defensively: the payload is
 * model-emitted wire data, so every field is checked before use.
 */
function parseArgs(argsRaw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Extract the path field common to every file tool's arguments. */
function pathOf(args: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'filePath']) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** The 'tool/result' message envelope inside a session event's data. */
interface ToolResultMessageLike {
  source?: { kind?: unknown; callId?: unknown }
  content?: unknown
}

/** One 'tool-result' content block (inner blocks carry the text). */
interface ToolResultBlockLike {
  type?: unknown
  content?: unknown
  isError?: unknown
}

/** The finalized plain text of one tool result (inner text blocks joined). */
function resultText(message: ToolResultMessageLike): string | undefined {
  if (!Array.isArray(message.content)) return undefined
  const parts: string[] = []
  for (const block of message.content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as ToolResultBlockLike
    if (candidate.type !== 'tool-result') continue
    const inner = candidate.content
    if (!Array.isArray(inner)) continue
    for (const item of inner) {
      if (item === null || typeof item !== 'object') continue
      const textItem = item as { type?: unknown; text?: unknown }
      if (textItem.type === 'text' && typeof textItem.text === 'string') parts.push(textItem.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** Whether a tool result reported an error (the inner block's isError flag). */
function resultIsError(message: ToolResultMessageLike): boolean {
  if (!Array.isArray(message.content)) return false
  return message.content.some((block) => {
    if (block === null || typeof block !== 'object') return false
    return (block as ToolResultBlockLike).type === 'tool-result'
      && (block as ToolResultBlockLike).isError === true
  })
}

/**
 * Fold a session event log into the file operations it contains, newest
 * first. A `tool/call` seeds a running op (payload from the model's
 * arguments); its `tool/result` settles it (read content, error text).
 * Calls dispatched through a host tool such as run_code appear as their own
 * `tool/call` rows in the log, so nested file calls fold in naturally.
 * @param events - the session's append-only event log (oldest → newest).
 * @returns the ordered operation list.
 */
export function extractFileOps(events: readonly SidebarSessionEvent[]): FileOp[] {
  const byCall = new Map<string, FileOp>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      const data = event.data as { name?: unknown; callId?: unknown; arguments?: unknown }
      if (typeof data.name !== 'string' || typeof data.callId !== 'string') continue
      const kind = kindOf(data.name)
      if (kind === undefined) continue
      const args = parseArgs(typeof data.arguments === 'string' ? data.arguments : '')
      const path = pathOf(args)
      if (path === undefined) continue
      const base: FileOp = { callId: data.callId, kind, path, time: event.time, running: true, isError: false }
      if (kind === 'edit') {
        const oldString = args.old_string
        const newString = args.new_string
        byCall.set(data.callId, typeof oldString === 'string' && typeof newString === 'string'
          ? { ...base, edit: { oldString, newString } }
          : base)
        continue
      }
      if (kind === 'write') {
        const content = args.content
        byCall.set(data.callId, typeof content === 'string' && content.length > 0 ? { ...base, content } : base)
        continue
      }
      byCall.set(data.callId, base)
    } else if (event.type === 'tool/result') {
      const message = (event.data as { message?: unknown }).message as ToolResultMessageLike | undefined
      if (message === undefined) continue
      const callId = message.source?.callId
      if (typeof callId !== 'string') continue
      const op = byCall.get(callId)
      if (op === undefined) continue
      const text = resultText(message)
      const isError = resultIsError(message)
      const patch: { running: boolean; isError: boolean; errorText?: string; read?: string; content?: string } = { running: false, isError }
      if (text !== undefined && text.length > 0) {
        if (isError) patch.errorText = text
        else if (op.kind === 'read') patch.read = text
        else if (op.kind === 'write' && op.content === undefined) patch.content = text
      }
      byCall.set(callId, { ...op, ...patch })
    }
  }
  return [...byCall.values()].sort((a, b) => b.time - a.time)
}

/**
 * Group operations by path, newest op first per file, files ordered by their
 * most recent operation.
 */
export function groupByFile(ops: readonly FileOp[]): Map<string, FileOp[]> {
  const groups = new Map<string, FileOp[]>()
  for (const op of ops) {
    const list = groups.get(op.path) ?? []
    list.push(op)
    groups.set(op.path, list)
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1][0]!.time - a[1][0]!.time)
  return new Map(ordered)
}

/**
 * The last content known for a path before the given operation, synthesized
 * from earlier ops: a write's payload is authoritative, an edit implies its
 * old side. Best effort — a write with no known prior content diffs against
 * nothing (all-added).
 */
export function knownContentBefore(ops: readonly FileOp[], path: string, before: FileOp): string | undefined {
  const ofFile = ops.filter(op => op.path === path && op.time <= before.time && op !== before)
  for (let i = ofFile.length - 1; i >= 0; i -= 1) {
    const op = ofFile[i]!
    if (op.kind === 'write' && op.content !== undefined) return op.content
    if (op.kind === 'edit' && op.edit !== undefined && i === ofFile.length - 1) {
      return op.edit.oldString
    }
  }
  return undefined
}

/** One parsed read line: the file's own line number and its content text. */
export interface ReadLine { readonly line: number; readonly text: string }

/**
 * Parse a DSH read result into file lines with their real line numbers:
 * drops the <content> envelope and "(Showing lines ...)" note; recovers the
 * "<n>: " prefix as the line number, falling back to sequential counting.
 */
export function parseReadLines(raw: string): ReadLine[] {
  const contentMatch = raw.match(/<content>([\s\S]*?)<\/content>/)
  const body = contentMatch ? contentMatch[1]! : raw
  const result: ReadLine[] = []
  let fallback = 1
  for (const line of body.split('\n')) {
    if (/^\s*\(Showing lines .*\)\s*$/.test(line)) continue
    if (line.length === 0) continue
    const match = line.match(/^\s*(\d+):\s?(.*)$/)
    if (match !== null) {
      result.push({ line: Number(match[1]), text: match[2] ?? '' })
      fallback = Number(match[1]) + 1
    } else {
      result.push({ line: fallback, text: line })
      fallback += 1
    }
  }
  return result
}
