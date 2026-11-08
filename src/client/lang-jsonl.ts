/**
 * A per-line JSON language for JSONL / NDJSON editing.
 *
 * Reusing `@codemirror/lang-json` here is not free: its grammar accepts ONE
 * top-level value, so every record after the first lands in an error node —
 * measured on a 400-record file, 402 error nodes. They are zero-width for
 * well-formed lines so the tinting looks right, but the parse is structurally
 * wrong: every diagnostic, fold and structure query built on it inherits the
 * damage, and a genuinely broken line is indistinguishable from the boundary
 * noise. (Verified directly against `@lezer/json` before writing this.)
 *
 * A JSONL line IS an independent JSON document, so the honest parse is one
 * JSON tokenizer per line. This is that tokenizer, written as a CodeMirror
 * `StreamLanguage`: it walks a line once, tags what it recognises, and marks
 * what it does not — which is exactly the signal a broken record deserves.
 *
 * Only the concerns an editor needs are covered: strings (with escapes and an
 * unterminated tail), numbers, `true`/`false`/`null`, structural punctuation,
 * and property names (a string followed by `:`). No validation of duplicate
 * keys, no nesting depth, no number grammar beyond JSON's shape — a tokenizer
 * is not a parser and pretending otherwise would only produce false errors.
 */
import { StreamLanguage, type StringStream } from '@codemirror/language'

/** JSON's number grammar (also used to decide whether a run IS a number). */
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/
/** A bare word: `true` / `false` / `null`, or something that is not JSON. */
const WORD = /^[A-Za-z_][A-Za-z0-9_]*/

/** Tags the tokenizer emits, by meaning rather than by name. */
interface JsonlToken {
  text: string
  kind: 'punctuation' | 'string' | 'number' | 'keyword' | 'invalid'
}

/**
 * Read one token starting at the stream's position.
 *
 * @param stream - the line stream, positioned at a non-space character.
 * @returns the token's text and kind.
 */
function readToken(stream: StringStream): JsonlToken {
  const char = stream.peek()
  if (char === '"') {
    // A JSON string: everything up to an unescaped quote on this line. An
    // unterminated string is `invalid` here rather than at end-of-line, and
    // that IS provable for JSONL: a record is one line by definition, so a
    // quote that never closes within it is always a broken record.
    stream.next()
    let body = '"'
    for (;;) {
      // `StringStream.next()` returns `undefined` — not null — once the line is
      // exhausted, and does NOT advance past the end. Testing only for null
      // here was an infinite loop that grew a string until V8 threw
      // RangeError: Invalid string length, on the very first unterminated
      // string a JSONL file contained.
      const next = stream.next()
      if (next === undefined || next === null) return { text: body, kind: 'invalid' }
      body += next
      if (next === '\\') {
        const escaped = stream.next()
        if (escaped === undefined || escaped === null) return { text: body, kind: 'invalid' }
        body += escaped
        continue
      }
      if (next === '"') return { text: body, kind: 'string' }
    }
  }
  if (char === '{' || char === '}' || char === '[' || char === ']' || char === ':' || char === ',') {
    stream.next()
    return { text: char, kind: 'punctuation' }
  }
  if (char !== undefined && (char === '-' || (char >= '0' && char <= '9'))) {
    // Peeked from the remaining line rather than through `stream.match`, whose
    // declared return type is the boolean legacy shape.
    const matched = NUMBER.exec(stream.string.slice(stream.pos))
    if (matched !== null) {
      const text = matched[0]
      for (let index = 0; index < text.length; index += 1) stream.next()
      return { text, kind: 'number' }
    }
    // A leading '-' or digit that cannot start a JSON number: mark the one
    // character, which is enough for the reader to see where it went wrong.
    return { text: stream.next() ?? '', kind: 'invalid' }
  }
  const word = WORD.exec(stream.string.slice(stream.pos))
  if (word !== null) {
    const text = word[0]
    for (let index = 0; index < text.length; index += 1) stream.next()
    return text === 'true' || text === 'false' || text === 'null'
      ? { text, kind: 'keyword' }
      : { text, kind: 'invalid' }
  }
  stream.next()
  return { text: char ?? '', kind: 'invalid' }
}

/**
 * The JSONL language: one JSON document per line, no cross-line state.
 *
 * A `StreamLanguage` carries a state object between lines; this grammar keeps
 * none, because JSONL records are independent by definition — carrying
 * anything would make line 2's tinting depend on line 1's.
 */
export const jsonlLanguage = StreamLanguage.define({
  name: 'jsonl',
  token(stream: StringStream): string | null {
    if (stream.eatSpace()) return null
    const token = readToken(stream)
    switch (token.kind) {
      case 'string':
        // A string immediately followed (modulo spaces) by ':' is a property
        // name — the one piece of context a token needs, and the reason the
        // lookahead lives here rather than in the caller.
        return isPropertyName(stream) ? 'propertyName' : 'string'
      case 'number': return 'number'
      case 'keyword': return 'atom'
      case 'punctuation': return 'punctuation'
      case 'invalid': return 'invalid'
    }
  },
  startState() { return {} },
})

/**
 * Whether a just-read string opens an object property: the next non-space
 * character is a colon. JSON allows whitespace between the two, and a JSONL
 * line commonly uses it after `{`.
 */
function isPropertyName(stream: StringStream): boolean {
  const rest = stream.string.slice(stream.pos)
  return /^\s*:/.test(rest)
}
