/**
 * Secret redaction for rendered file content. The tracer replays read/write
 * tool results into the DOM (diff, read view, markdown mode) — when the
 * model reads a credentials file, that plaintext must not land on screen or
 * in inspectable DOM. Two layers, both pure and unit-tested:
 *
 * 1. Path layer: files whose NAME marks them as secrets (.env, *secret*,
 *    *credential*, *token*, *api-key*, private keys, …) are masked whole —
 *    every non-empty line becomes [REDACTED].
 * 2. Content layer: for ordinary files, secret-SHAPED lines and tokens are
 *    masked in place (api_key/token/password assignments, sk-/AKIA/ghp_/
 *    xox prefixes, Bearer headers, PEM private-key block headers).
 *
 * Redaction is display-only: the session log and the tool results keep their
 * original bytes; this layer guarantees only that this plugin never renders
 * the secret. It is NOT a security boundary against a same-context malicious
 * plugin (which can read anything on the page or call host APIs itself) —
 * it removes the tracer's own contribution to secret exposure.
 */

/** Placeholder substituted for every secret found. */
export const REDACTED = '[REDACTED]'

/** Result of redacting one text: the masked text + whether anything was hit. */
export interface RedactionOutcome {
  readonly text: string
  readonly hit: boolean
}

/** Lowercased filename substrings that mark a whole file as sensitive. */
const SENSITIVE_PATH_PATTERNS: readonly string[] = [
  '.env', 'secret', 'credential', 'token', 'api-key', 'apikey', 'password',
  'passwd', 'private_key', 'privatekey', 'id_rsa', 'id_ed25519',
  '.pem', '.key', '.p12', '.pfx',
]

/**
 * Whether a path's own name marks the file as sensitive (case-insensitive,
 * matched against the full path so .env in any directory counts).
 */
export function isSensitivePath(path: string): boolean {
  const lower = path.toLowerCase()
  return SENSITIVE_PATH_PATTERNS.some((pattern) => lower.includes(pattern))
}

/**
 * Assignment-shaped secret lines: "api_key: …", "TOKEN = …", "password": ….
 * The key name survives; the value is masked so the user still sees WHICH
 * field was secret.
 */
const ASSIGNMENT_RE = /^(\s*["']?[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(\S.*)$/

/**
 * Field names whose assigned value is a secret. Stored in NORMALIZED form
 * (lower-case, separators stripped — see normalizeField) so api_key/API-KEY/
 * "api-key" all match one entry.
 */
const SECRET_FIELDS = new Set([
  'apikey', 'key', 'secret', 'secretkey',
  'token', 'apitoken', 'accesstoken', 'refreshtoken', 'idtoken', 'auth',
  'password', 'passwd', 'pass', 'pwd',
  'clientsecret', 'privatekey',
  'accesskey', 'accesskeyid', 'secretaccesskey',
  'bearer', 'authorization',
])

/** Bearer-scheme token in free text (covers HTTP headers in logs/configs). */
const BEARER_RE = /(\bBearer\s+)[A-Za-z0-9\-_.+/]{16,}/gi

/** Well-known credential token prefixes (OpenAI/AWS/GitHub/Slack/Google). */
const TOKEN_RES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgho_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bya29\.[A-Za-z0-9_-]{20,}\b/g,
]

/** Mask an entire non-empty line, keeping whitespace shape. */
function maskLine(line: string): string {
  return line.trim().length === 0 ? line : REDACTED
}

/** Normalize a field name for SECRET_FIELDS lookup. */
function normalizeField(raw: string): string {
  return raw.replace(/["'\s:=]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Redact one possibly-secret assignment line; undefined when not a secret field. */
function redactAssignment(line: string): string | undefined {
  const match = ASSIGNMENT_RE.exec(line)
  const prefix = match?.[1]
  if (prefix === undefined || match?.[2] === undefined) return undefined
  if (!SECRET_FIELDS.has(normalizeField(prefix))) return undefined
  return prefix + REDACTED
}

/** Whether a line is the header of a PEM private-key block. */
function isPemPrivateKeyHeader(line: string): boolean {
  return line.includes('-----BEGIN') && line.includes('PRIVATE KEY-----')
}

/**
 * Redact secret-shaped content from an ordinary file's text. Only the secret
 * itself is masked; surrounding code/config stays readable.
 */
export function redactContentText(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (isPemPrivateKeyHeader(line)) return REDACTED
      const assignment = redactAssignment(line)
      if (assignment !== undefined) return assignment
      let masked = line.replace(BEARER_RE, (_m, prefix) => prefix + REDACTED)
      for (const re of TOKEN_RES) masked = masked.replace(re, () => REDACTED)
      return masked
    })
    .join('\n')
}

/**
 * Apply the full two-layer redaction for one file's text. Sensitive paths
 * mask whole lines; ordinary files mask only secret-shaped spans.
 */
export function redactText(path: string, text: string): RedactionOutcome {
  if (isSensitivePath(path)) {
    return { text: text.split('\n').map(maskLine).join('\n'), hit: text.trim().length > 0 }
  }
  const masked = redactContentText(text)
  return { text: masked, hit: masked !== text }
}
