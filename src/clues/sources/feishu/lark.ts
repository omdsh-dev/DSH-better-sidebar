/**
 * The lark-cli boundary adapter (S4).
 *
 * Every Feishu command goes through the injectable S2 `ClueRuntime.runCli`
 * (never `node:child_process` directly), so command resolution, the fixed
 * environment allowlist, argv-only execution, timeouts, cancellation and the
 * stdout capture cap are all owned by the runtime.
 *
 * The lark-cli JSON contract this module implements:
 * - success = `ok:true` on STDOUT **and** exit code 0. `error.code` is an
 *   upstream number that only exists inside failure envelopes; a top-level
 *   `code == 0` is NOT success (the success envelope has no `code` at all);
 * - failure = `ok:false` on STDERR **and** a non-zero exit. The two streams are
 *   never merged and `_notice` is never an error;
 * - a failure is projected to the fixed clue categories with only safe fields
 *   (upstream type/subtype, numeric code, missing scopes and the console URL).
 *   Raw messages, hints, stdout/stderr text, tokens, device codes and app
 *   secrets never enter a `ClueError`.
 *
 * lark-cli is NOT installed on this host: these argv shapes and envelope
 * fields are taken from the local lark skill documentation and are exercised
 * only against fake runtimes.
 */
import { isAbsolute } from 'node:path'
import { ClueError } from '../../types.ts'
import type { JsonValue } from '../../types.ts'
import type {
  CliResult,
  CliRunRequest,
  ClueRuntime,
} from '../../runtime/types.ts'
import { FEISHU_DEPENDENCY_ID } from './format.ts'

/** Process budget of one ordinary command. */
export const LARK_CLI_TIMEOUT_MS = 60_000
/** Device-code polling blocks until the user acts or the CLI gives up. */
export const LARK_AUTH_POLL_TIMEOUT_MS = 120_000
/** Large enough for a long document; the source pages the CONTENT itself. */
export const LARK_CLI_MAX_OUTPUT_BYTES = 8 << 20

/**
 * Stable machine output: lark-cli's update/skills notices are suppressed so a
 * script consumer gets one JSON envelope. `_notice` is still tolerated when a
 * user-level CLI config forces it on.
 */
export const LARK_CLI_ENV: Readonly<Record<string, string>> = {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
}

/** One lark-cli invocation through the shared runtime. */
export interface LarkRequest {
  readonly runtime: ClueRuntime
  readonly args: readonly string[]
  readonly cwd: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly stdin?: string
}

/** A validated success envelope. */
export interface LarkSuccess {
  /** The `data` object (empty when the command returned none). */
  readonly data: Record<string, JsonValue>
  /** The whole envelope (for `identity` / `meta` read-only access). */
  readonly envelope: Record<string, JsonValue>
}

/** The safe, classified projection of one failure envelope. */
export interface LarkFailure {
  /** Upstream error category (`authorization`, `permission`, …). */
  readonly type: string
  /** Upstream subtype (`missing_scope`, `token_expired`, …). */
  readonly subtype: string
  /** Upstream numeric code (diagnostic only; never a success signal). */
  readonly code?: number
  /** Missing scope names (already filtered to safe tokens). */
  readonly missingScopes: readonly string[]
  /** Opaque console URL from the error, only when it is an https URL. */
  readonly consoleUrl?: string
}

/** One classified failure kind. */
export type LarkFailureClass =
  | 'config-missing'
  | 'missing-scope'
  | 'authorization'
  | 'permission'
  | 'not-found'
  | 'rate-limited'
  | 'conflict'
  | 'unsupported'
  | 'invalid-request'
  | 'failed'

/** Result of one executed command, parsed but not yet thrown. */
export interface LarkOutcome {
  readonly result: CliResult
  readonly success?: LarkSuccess
  readonly failure?: LarkFailure
}

/** A safe token-shaped string (type/subtype/scope names). */
const SAFE_TOKEN = /^[A-Za-z0-9:._\-*]{1,200}$/
/** An opaque https URL the CLI itself returned (never re-encoded/mutated). */
const SAFE_HTTPS_URL = /^https:\/\/[^\s"'<>]{1,2048}$/

/** A safe collapsed string for meta. */
function safeToken(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : undefined
}

/** Keep only whitelisted missing-scope names. */
function safeScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const scopes: string[] = []
  for (const entry of value) {
    const token = safeToken(entry)
    if (token !== undefined && !scopes.includes(token)) scopes.push(token)
    if (scopes.length >= 20) break
  }
  return scopes
}

/** A plain object view of a parsed JSON envelope. */
function recordOf(value: unknown): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined
}

/**
 * Parse the stderr failure envelope. Returns undefined when stderr is not a
 * failure envelope — the caller then answers a generic (still sanitized)
 * failure instead of pretending success.
 * @param text - the runner's sanitized stderr.
 */
export function parseLarkFailure(text: string): LarkFailure | undefined {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // A CLI may print a progress/notice prefix before the envelope; keep only
    // the outermost JSON object. Raw text is still never echoed.
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
  const envelope = recordOf(parsed)
  if (envelope === undefined) return undefined
  if (envelope.ok !== false && envelope.error === undefined) return undefined
  const error = recordOf(envelope.error)
  if (error === undefined) return undefined
  const code = typeof error.code === 'number' && Number.isFinite(error.code) ? error.code : undefined
  const missingScopes = safeScopes(error.missing_scopes)
  const consoleUrl = typeof error.console_url === 'string' && SAFE_HTTPS_URL.test(error.console_url)
    ? error.console_url
    : undefined
  const type = safeToken(error.type) ?? ''
  const subtype = safeToken(error.subtype) ?? ''
  return {
    type,
    subtype,
    ...(code === undefined ? {} : { code }),
    missingScopes,
    ...(consoleUrl === undefined ? {} : { consoleUrl }),
  }
}

/** Whether a failure string smells like one of the given markers. */
function hasMarker(failure: LarkFailure, markers: readonly string[]): boolean {
  const haystack = `${failure.type} ${failure.subtype}`.toLowerCase()
  return markers.some(marker => haystack.includes(marker))
}

/**
 * Classify one sanitized failure into the fixed S4 vocabulary. Order matters:
 * scope/config/permission markers win over the generic authorization family.
 * @param failure - the sanitized failure envelope.
 */
export function classifyLarkFailure(failure: LarkFailure): LarkFailureClass {
  if (failure.missingScopes.length > 0 || hasMarker(failure, ['missing_scope', 'scope_insufficient'])) {
    return 'missing-scope'
  }
  if (hasMarker(failure, ['config', 'not_configured', 'no_app', 'app_missing'])) return 'config-missing'
  if (hasMarker(failure, ['permission', 'forbidden', 'access_denied', 'no_permission'])) return 'permission'
  if (hasMarker(failure, ['not_found', 'notfound', 'resource_missing'])) return 'not-found'
  if (hasMarker(failure, ['rate_limit', 'too_many', 'throttl'])) return 'rate-limited'
  if (hasMarker(failure, ['conflict', 'revision_mismatch', 'block_mismatch'])) return 'conflict'
  if (hasMarker(failure, ['unsupported', 'not_supported', 'complex_block', 'block_not_supported'])) {
    return 'unsupported'
  }
  if (hasMarker(failure, ['invalid_parameter', 'invalid_request', 'validation', 'bad_request'])) {
    return 'invalid-request'
  }
  if (hasMarker(failure, ['authorization', 'token_expired', 'token_invalid', 'not_logged', 'login_required', 'unauthorized'])) {
    return 'authorization'
  }
  return 'failed'
}

/** Fixed, safe messages per failure class (never derived from CLI text). */
const FAILURE_MESSAGES: Readonly<Record<LarkFailureClass, string>> = {
  'config-missing': 'the lark-cli application is not configured; run `lark-cli config init` in a terminal, then check the connection again',
  'missing-scope': 'the authorized Feishu account is missing a required scope; grant the missing scope and retry',
  authorization: 'Feishu authorization is required; connect the account again',
  permission: 'the Feishu account cannot access this resource',
  'not-found': 'the Feishu resource was not found or is not visible to this account',
  'rate-limited': 'Feishu rate-limited the request; retry later',
  conflict: 'the Feishu resource changed since it was loaded; re-read it and retry',
  unsupported: 'lark-cli does not support this Feishu operation',
  'invalid-request': 'lark-cli rejected the request parameters',
  failed: 'the lark-cli command failed',
}

/** Clue category of one failure class. */
function categoryOf(failureClass: LarkFailureClass): ClueError['category'] {
  switch (failureClass) {
    case 'config-missing':
    case 'missing-scope':
    case 'authorization':
      return 'auth-required'
    case 'permission':
      return 'permission-denied'
    case 'not-found':
      return 'not-found'
    case 'rate-limited':
      return 'rate-limited'
    case 'conflict':
      return 'conflict'
    case 'unsupported':
      return 'unsupported'
    case 'invalid-request':
      return 'invalid-request'
    default:
      return 'failed'
  }
}

/**
 * The safe scope/console detail of one failure. Only fixed scope names (already
 * filtered to safe tokens) and an https console URL are interpolated.
 * @param scopes - missing scope names.
 * @param consoleUrl - the CLI-provided developer console URL.
 */
export function larkScopeDetail(scopes: readonly string[], consoleUrl?: string): string {
  const parts: string[] = []
  if (scopes.length > 0) {
    parts.push(`Missing Feishu scopes: ${scopes.join(', ')}.`)
  } else {
    parts.push('A required Feishu scope is missing; authorize it incrementally and retry.')
  }
  if (consoleUrl !== undefined) {
    parts.push(`Developer console: ${consoleUrl}`)
  }
  return parts.join(' ')
}

/**
 * Project one failure to a safe clue error.
 * @param failure - sanitized failure envelope.
 * @throws {never} always returns the error.
 */
export function larkFailureError(failure: LarkFailure): ClueError {
  const failureClass = classifyLarkFailure(failure)
  const meta: Record<string, string> = {}
  if (failure.subtype !== '') meta.subtype = failure.subtype
  if (failure.missingScopes.length > 0) meta.missingScopes = failure.missingScopes.join(',')
  if (failure.consoleUrl !== undefined) meta.consoleUrl = failure.consoleUrl
  // The wire only carries { code, message }, so the actionable scope names and
  // console URL must be in the (already sanitized) message as well as the meta.
  const detail = failureClass === 'missing-scope'
    ? larkScopeDetail(failure.missingScopes, failure.consoleUrl)
    : failureClass === 'permission' && failure.consoleUrl !== undefined
      ? `Developer console: ${failure.consoleUrl}`
      : undefined
  const message = detail === undefined
    ? FAILURE_MESSAGES[failureClass]
    : `${FAILURE_MESSAGES[failureClass]} (${detail})`
  return new ClueError(
    categoryOf(failureClass),
    message,
    Object.keys(meta).length === 0 ? undefined : meta,
  )
}

/**
 * Execute one lark-cli invocation and parse both streams.
 *
 * Runner failures (dependency missing/incompatible, timeout, cancellation)
 * propagate unchanged: they are host facts, not CLI envelopes.
 * @param request - command, cwd and budgets.
 */
export async function executeLark(request: LarkRequest): Promise<LarkOutcome> {
  const command: CliRunRequest = {
    dependencyId: FEISHU_DEPENDENCY_ID,
    args: [...request.args],
    cwd: request.cwd,
    timeoutMs: request.timeoutMs ?? LARK_CLI_TIMEOUT_MS,
    maxOutputBytes: request.maxOutputBytes ?? LARK_CLI_MAX_OUTPUT_BYTES,
    env: LARK_CLI_ENV,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
  }
  const result = await request.runtime.runCli(command)
  if (result.exitCode !== 0) {
    const failure = parseLarkFailure(result.stderr)
    return failure === undefined ? { result } : { result, failure }
  }
  if (result.stdoutTruncated) return { result }
  const text = result.stdout.trim()
  if (text === '') return { result }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { result }
  }
  const envelope = recordOf(parsed)
  if (envelope === undefined || envelope.ok !== true) return { result }
  const data = recordOf(envelope.data)
  if (data === undefined && envelope.data !== undefined) return { result }
  return {
    result,
    success: {
      data: data ?? {},
      envelope,
    },
  }
}

/**
 * Execute one command and return its success payload, or throw a mapped error.
 * @param request - command, cwd and budgets.
 */
export async function runLark(request: LarkRequest): Promise<LarkSuccess> {
  const outcome = await executeLark(request)
  if (outcome.success !== undefined) return outcome.success
  if (outcome.failure !== undefined) throw larkFailureError(outcome.failure)
  if (outcome.result.stdoutTruncated) {
    throw new ClueError('failed', 'the lark-cli output exceeded the capture limit and was not parsed')
  }
  if (outcome.result.exitCode !== 0) {
    throw new ClueError('failed', `the lark-cli command failed (exit code ${outcome.result.exitCode})`)
  }
  throw new ClueError('failed', 'the lark-cli command returned no usable success envelope')
}

/**
 * The child-process working directory. The workspace directory is only the
 * CLI process cwd — never the resource scope — with a stable fallback.
 * @param workspacePath - host workspace directory, when known.
 */
export function larkWorkingDirectory(workspacePath?: string): string {
  if (typeof workspacePath === 'string' && isAbsolute(workspacePath)) return workspacePath
  return process.cwd()
}

/** A non-empty string field of a parsed data object. */
export function stringField(data: Record<string, JsonValue>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** A plain object field of a parsed data object. */
export function recordField(
  data: Record<string, JsonValue>,
  key: string,
): Record<string, JsonValue> | undefined {
  return recordOf(data[key])
}

/** An array field of a parsed data object. */
export function arrayField(data: Record<string, JsonValue>, key: string): JsonValue[] | undefined {
  const value = data[key]
  return Array.isArray(value) ? value : undefined
}
