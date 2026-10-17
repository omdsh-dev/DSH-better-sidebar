/**
 * The stable clue reference protocol (S5).
 *
 * One spelling, shared by the composer codec, the prompt injection text and
 * the agent tools:
 *
 * - `[[dsh-clue:<id>]]` — a live clue (read the CURRENT source content);
 * - `[[dsh-cluepack:<id>]]` — a local pack (read its CURRENT members);
 * - `[[dsh-clue-snapshot:<snapshotId>]]` — one explicit historical snapshot.
 *
 * Titles are metadata, never part of the token: {@link escapeClueTitle}
 * replaces ASCII brackets with their full-width forms so a hostile or merely
 * unlucky title cannot mint a token, and `serializeClueToken` never appends a
 * title to the model-facing reference.
 *
 * This module is pure (no `node:*`, no service access): both halves import it.
 */
import { ClueError } from '../types.ts'

/** The three token kinds. */
export type ClueTokenKind = 'clue' | 'pack' | 'snapshot'

/** One parsed reference token. */
export interface ClueToken {
  readonly kind: ClueTokenKind
  /** The stable id from S1 (clue / pack / snapshot). */
  readonly id: string
  /** The exact matched token text. */
  readonly raw: string
}

/** One segment of text containing reference tokens. */
export type ClueTextPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'token'; readonly token: ClueToken }

/** Opening spellings, one per kind (closed vocabulary). */
export const CLUE_TOKEN_PREFIXES: Readonly<Record<ClueTokenKind, string>> = {
  clue: '[[dsh-clue:',
  pack: '[[dsh-cluepack:',
  snapshot: '[[dsh-clue-snapshot:',
}

/** The closing spelling shared by every token. */
export const CLUE_TOKEN_SUFFIX = ']]'

/**
 * One stable id: non-empty, no whitespace, no brackets, no control characters.
 * Anything else would make the token boundary ambiguous (or enable injection
 * of a second token through an id), so it is refused at serialization time.
 */
const ID_PATTERN = /^[^\s[\]\u0000-\u001f\u007f-\u009f]+$/u

/**
 * One token occurrence. The lookarounds keep a token from being carved out of
 * a longer bracket run (`[[[dsh-clue:x]]]`), which is what makes the boundary
 * rule symmetric with the titles' bracket escaping.
 */
const TOKEN_PATTERN = /(?<!\[)\[\[(?:dsh-clue-snapshot|dsh-cluepack|dsh-clue):([^\s[\]\u0000-\u001f\u007f-\u009f]+)\]\](?!\])/gu

/** The maximum title length carried as display metadata. */
export const CLUE_TITLE_MAX_CHARS = 200

/** Whether one id can be serialized without breaking the token boundary. */
export function isValidClueReferenceId(id: string): boolean {
  return typeof id === 'string' && ID_PATTERN.test(id)
}

/**
 * Serialize one stable reference.
 * @param kind - the reference kind.
 * @param id - the S1 stable id.
 * @returns the exact model-facing token.
 * @throws {ClueError} `invalid-request` when the id cannot be represented.
 */
export function serializeClueToken(kind: ClueTokenKind, id: string): string {
  if (!isValidClueReferenceId(id)) {
    throw new ClueError(
      'invalid-request',
      `a ${kind} reference needs a stable id without whitespace, brackets or control characters`,
    )
  }
  return `${CLUE_TOKEN_PREFIXES[kind]}${id}${CLUE_TOKEN_SUFFIX}`
}

/** The kind named by a matched token's opening spelling. */
function kindOfRaw(raw: string): ClueTokenKind {
  if (raw.startsWith(CLUE_TOKEN_PREFIXES.snapshot)) return 'snapshot'
  if (raw.startsWith(CLUE_TOKEN_PREFIXES.pack)) return 'pack'
  return 'clue'
}

/**
 * Parse a reference that must occupy the whole input (surrounding whitespace
 * is allowed).
 * @param text - candidate text.
 * @returns the token, or undefined when the input is not exactly one token.
 */
export function parseClueToken(text: string): ClueToken | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  const match = TOKEN_PATTERN.exec(trimmed)
  TOKEN_PATTERN.lastIndex = 0
  if (match === null || match.index !== 0 || match[0].length !== trimmed.length) return undefined
  const raw = match[0]
  return { kind: kindOfRaw(raw), id: match[1]!, raw }
}

/**
 * Every reference occurrence in free text, in order.
 * @param text - text possibly carrying reference tokens.
 */
export function parseClueTokens(text: string): ClueToken[] {
  if (typeof text !== 'string') return []
  const tokens: ClueToken[] = []
  TOKEN_PATTERN.lastIndex = 0
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const raw = match[0]
    tokens.push({ kind: kindOfRaw(raw), id: match[1]!, raw })
  }
  return tokens
}

/**
 * Split text into plain runs and reference tokens, preserving every character
 * (a malformed span stays plain text).
 * @param text - text possibly carrying reference tokens.
 */
export function tokenizeClueText(text: string): ClueTextPart[] {
  if (typeof text !== 'string' || text === '') return []
  const parts: ClueTextPart[] = []
  let cursor = 0
  TOKEN_PATTERN.lastIndex = 0
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0
    if (index > cursor) parts.push({ kind: 'text', text: text.slice(cursor, index) })
    const raw = match[0]
    parts.push({ kind: 'token', token: { kind: kindOfRaw(raw), id: match[1]!, raw } })
    cursor = index + raw.length
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) })
  return parts
}

/**
 * Sanitize a human-readable title for display metadata.
 *
 * Control characters collapse to one space, runs of whitespace collapse, and
 * ASCII brackets become their full-width forms so the result can never contain
 * (or break) a reference token. The result is bounded to
 * {@link CLUE_TITLE_MAX_CHARS} code units.
 *
 * @param title - untrusted display title.
 */
export function escapeClueTitle(title: string): string {
  if (typeof title !== 'string') return ''
  return title
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
    .replace(/\[/gu, '［')
    .replace(/\]/gu, '］')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, CLUE_TITLE_MAX_CHARS)
}

/** The composer-facing projection of one stable reference. */
export interface FormattedClueReference {
  /** The exact model-facing token. */
  readonly token: string
  /** Escaped display metadata; absent when the caller supplied no title. */
  readonly title?: string
}

/**
 * Build the composer chip projection: the token plus escaped title metadata.
 * @param reference - kind, stable id and optional human-readable title.
 * @throws {ClueError} `invalid-request` for an unserializable id.
 */
export function formatClueReference(reference: {
  readonly kind: ClueTokenKind
  readonly id: string
  readonly title?: string
}): FormattedClueReference {
  const token = serializeClueToken(reference.kind, reference.id)
  if (reference.title === undefined) return { token }
  const title = escapeClueTitle(reference.title)
  return title === '' ? { token } : { token, title }
}
