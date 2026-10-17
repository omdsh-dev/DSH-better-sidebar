/**
 * The lark-cli boundary adapter (S4).
 *
 * Every Feishu command goes through the injectable S2 `ClueRuntime.runCli`
 * (never `node:child_process` directly), so command resolution, the fixed
 * environment allowlist, argv-only execution, timeouts, cancellation and the
 * stdout capture cap are all owned by the runtime.
 *
 * The lark-cli JSON contract this module implements:
 * - resource commands use the documented success envelope: `ok:true` on
 *   STDOUT **and** exit code 0. `error.code` is an upstream number that only
 *   exists inside failure envelopes; a top-level `code == 0` is NOT success
 *   (the success envelope has no `code` at all);
 * - the auth family is the exception: `auth status --json` emits the status
 *   object DIRECTLY (top-level `appId`/`brand`/`identities`/`identity`/`note`,
 *   no `ok` and no `data`). The auth calls opt into `bareSuccess`, so the
 *   envelope parser does not falsely reject the real CLI shape;
 * - failure = `ok:false` on STDERR **and** a non-zero exit. The two streams are
 *   never merged and `_notice` is never an error;
 * - a failure is projected to the fixed clue categories with only safe fields
 *   (upstream type/subtype, numeric code, missing scopes and the console URL).
 *   Raw messages, hints, stdout/stderr text, tokens, device codes and app
 *   secrets never enter a `ClueError`.
 *
 * lark-cli is NOT bundled with the plugin and the test suite never runs a
 * real account: these argv shapes, envelopes, exit codes and payloads were
 * checked against the pinned lark-cli 1.0.55 binary/source (including the
 * device-flow stdout events) and are exercised in CI against fake runtimes.
 * A real-account verification remains a separate, explicitly agreed step.
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
/**
 * The plugin runner's stdout capture cap (S2's `maxOutputBytes`), NOT a
 * lark-cli limit: the CLI may print a larger document, but this adapter cannot
 * parse more than this in one capture and must report the boundary explicitly.
 */
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
  /**
   * Accept a bare JSON object as a success payload (no `ok`/`data` envelope).
   * `auth status --json` is documented to emit the status object directly;
   * login/poll are accepted the same way because they belong to the same auth
   * family. Never enable this for resource commands: their success contract is
   * the envelope.
   */
  readonly bareSuccess?: boolean
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
  /** Upstream error category (`authorization`, `authentication`, …). */
  readonly type: string
  /** Upstream subtype (`missing_scope`, `token_expired`, …). */
  readonly subtype: string
  /** Upstream numeric code (diagnostic only; never a success signal). */
  readonly code?: number
  /** Missing scope names (already filtered to safe tokens). */
  readonly missingScopes: readonly string[]
  /** Opaque console URL from the error, only when it is an https URL. */
  readonly consoleUrl?: string
  /**
   * Fixed, safe classification derived from the raw error message (never the
   * message itself). lark-cli reports device-flow denial/expiry as
   * `type:"authentication" subtype:"unknown"` with the real code only inside
   * `message`, so the adapter needs one sanitized enum to distinguish them.
   */
  readonly marker?: 'denied' | 'expired' | 'pending' | 'scope' | 'config'
}

/**
 * The terminal `authorization_complete` projection of a device-flow poll.
 *
 * lark-cli 1.0.55 writes this object to stdout with **exit 3** when the user
 * completed the browser flow but the requested scopes were not granted (the
 * stderr stream may be empty). Reading only stderr made `scope-insufficient`
 * unreachable.
 */
export interface LarkCompletion {
  /** Raw `authorization_complete.status` / `warning` (safe token). */
  readonly status: string
  /** Scopes the CLI reported as not granted (safe tokens). */
  readonly missingScopes: readonly string[]
  /** Opaque console URL from the completion payload, when https. */
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
  /** Device-flow completion printed to stdout (with a non-zero exit). */
  readonly completion?: LarkCompletion
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
 * Parse one CLI payload tolerantly.
 *
 * lark-cli can print an update/`_notice` prefix or a JSON notice object before
 * the envelope when a user-level config forces notices on. Only the outermost
 * candidate JSON object is used; raw text is never echoed.
 */
function parseJsonPayload(text: string): unknown {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    // Keep looking for a complete suffix object; the notice prefix is not data.
  }
  const last = trimmed.lastIndexOf('}')
  if (last < 0) return undefined
  for (let start = trimmed.indexOf('{'); start >= 0 && start < last; start = trimmed.indexOf('{', start + 1)) {
    for (const candidate of [trimmed.slice(start), trimmed.slice(start, last + 1)]) {
      try {
        return JSON.parse(candidate)
      } catch {
        // Try the next start.
      }
    }
  }
  return undefined
}

/** The classified failure of an already-parsed envelope value. */
function failureOfValue(value: unknown): LarkFailure | undefined {
  const envelope = recordOf(value)
  if (envelope === undefined) return undefined
  // Device-flow JSON failure (exit 3, bare stdout):
  // `{event:"authorization_failed", error:"authorization failed: access_denied"}`.
  // `error` is a raw message here, not the usual error object.
  if (envelope.event === 'authorization_failed' || (envelope.ok === undefined && typeof envelope.error === 'string')) {
    const marker = failureMarker(envelope)
    if (marker !== undefined || envelope.event === 'authorization_failed') {
      return {
        type: 'authentication',
        subtype: 'unknown',
        missingScopes: [],
        ...(marker === undefined ? {} : { marker }),
      }
    }
  }
  if (envelope.ok !== false && envelope.error === undefined) return undefined
  const error = recordOf(envelope.error)
  if (error === undefined) return undefined
  const code = typeof error.code === 'number' && Number.isFinite(error.code) ? error.code : undefined
  // Missing scopes can be reported by the device-flow completion shape as well.
  const data = recordOf(envelope.data)
  const missingScopes = safeScopes(
    error.missing_scopes
      ?? error.missing
      ?? data?.missing_scopes
      ?? data?.missing
      ?? envelope.missing_scopes,
  )
  const consoleUrlValue = error.console_url ?? data?.console_url ?? envelope.console_url
  const consoleUrl = typeof consoleUrlValue === 'string' && SAFE_HTTPS_URL.test(consoleUrlValue)
    ? consoleUrlValue
    : undefined
  const type = safeToken(error.type) ?? ''
  const subtype = safeToken(error.subtype) ?? ''
  const marker = failureMarker(error)
  return {
    type,
    subtype,
    ...(code === undefined ? {} : { code }),
    missingScopes,
    ...(consoleUrl === undefined ? {} : { consoleUrl }),
    ...(marker === undefined ? {} : { marker }),
  }
}

/**
 * Classify the raw failure message into one fixed, safe enum.
 *
 * The message itself is NEVER stored or projected. lark-cli's device-flow
 * denial/expiry arrives as `type:"authentication" subtype:"unknown"`; the only
 * discriminator is the OAuth code embedded in the message (`access_denied`,
 * `expiration`, …), so this is the one place that reads it.
 */
function failureMarker(error: Record<string, JsonValue>): LarkFailure['marker'] {
  const message = [
    stringOfValue(error.message),
    stringOfValue(error.hint),
    stringOfValue(error.error),
    stringOfValue(error.reason),
    stringOfValue(error.description),
  ].filter((entry): entry is string => entry !== undefined).join(' ').toLowerCase()
  if (message === '') return undefined
  if (/access[_ ]denied|\bdenied\b|\brevoked\b/.test(message)) return 'denied'
  if (/expired_token|token[_ ]expired|expiration|\bexpired\b|timed out|\btimeout\b|device_code is invalid|invalid device/.test(message)) {
    return 'expired'
  }
  if (/authorization_pending|slow_down|waiting/.test(message)) return 'pending'
  if (/missing[_ ]scope|scope[_ ]insufficient|not granted|missing scopes/.test(message)) return 'scope'
  if (/not[_ ]configured|not configured|missing app config/.test(message)) return 'config'
  return undefined
}

/** A non-empty string field of a parsed error record. */
function stringOfValue(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Parse the stderr failure envelope. Returns undefined when stderr is not a
 * failure envelope — the caller then answers a generic (still sanitized)
 * failure instead of pretending success.
 * @param text - the runner's sanitized stderr.
 */
export function parseLarkFailure(text: string): LarkFailure | undefined {
  return failureOfValue(parseJsonPayload(text))
}

/**
 * Parse the device-flow completion payload from stdout.
 *
 * Real 1.0.55 shapes this tolerates:
 * - `{event:"authorization_complete", user_name, scope, missing, warning?}`
 *   (exit 0 on success, exit 3 when requested scopes were not granted);
 * - `{event:"authorization_failed", error:"…"}` (see {@link parseLarkFailure});
 * - nested `{ok:false, data:{authorization_complete:{status:'warning',
 *   missing:[…]}}}` and `{authorization_complete:{warning, missing}}`.
 */
export function parseLarkCompletion(text: string): LarkCompletion | undefined {
  return completionOfValue(parseJsonPayload(text))
}

/** The completion projection of one parsed stdout value. */
function completionOfValue(value: unknown): LarkCompletion | undefined {
  const envelope = recordOf(value)
  if (envelope === undefined) return undefined
  const data = recordOf(envelope.data)
  // Real 1.0.55 login JSON is a BARE object identified by `event`:
  // `{event:"authorization_complete", user_name, scope, missing, warning?}`
  // (exit 0 on full success, exit 3 when requested scopes were not granted).
  const event = safeToken(data?.event) ?? safeToken(envelope.event)
  const raw = data?.authorization_complete ?? envelope.authorization_complete
  if (raw === undefined && event !== 'authorization_complete') return undefined
  let status: string
  let missingScopes = safeScopes(
    data?.missing
      ?? data?.missing_scopes
      ?? envelope.missing
      ?? envelope.missing_scopes,
  )
  let consoleUrl: string | undefined
  const outerConsoleUrl = data?.console_url ?? envelope.console_url
  if (typeof outerConsoleUrl === 'string' && SAFE_HTTPS_URL.test(outerConsoleUrl)) {
    consoleUrl = outerConsoleUrl
  }
  if (raw === undefined) {
    // A bare authorization_complete event: `warning` marks the partial grant.
    status = (data?.warning ?? envelope.warning) === undefined ? 'complete' : 'warning'
  } else if (typeof raw === 'string') {
    status = safeToken(raw) ?? ''
  } else if (raw === true) {
    status = 'complete'
  } else {
    const completion = recordOf(raw)
    if (completion === undefined) return undefined
    status = safeToken(completion.status)
      ?? (completion.warning !== undefined ? 'warning' : 'complete')
    missingScopes = safeScopes(
      completion.missing
        ?? completion.missing_scopes
        ?? data?.missing
        ?? data?.missing_scopes
        ?? envelope.missing
        ?? envelope.missing_scopes,
    )
    const consoleUrlValue = completion.console_url ?? data?.console_url ?? envelope.console_url
    if (typeof consoleUrlValue === 'string' && SAFE_HTTPS_URL.test(consoleUrlValue)) {
      consoleUrl = consoleUrlValue
    }
  }
  if (status === '' && missingScopes.length === 0) return undefined
  return {
    status: status === '' ? 'warning' : status,
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
  if (failure.marker === 'scope' || failure.missingScopes.length > 0 || hasMarker(failure, ['missing_scope', 'scope_insufficient'])) {
    return 'missing-scope'
  }
  if (failure.marker === 'config' || hasMarker(failure, ['config', 'not_configured', 'no_app', 'app_missing'])) {
    return 'config-missing'
  }
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
  // lark-cli 1.0.55 reports device-flow failures as `type:"authentication"`
  // (not `authorization`); `needs_refresh` is also an authorization signal.
  if (
    failure.type === 'authentication'
    || failure.marker === 'denied'
    || failure.marker === 'expired'
    || hasMarker(failure, [
      'authorization', 'authentication', 'token_expired', 'token_invalid', 'not_logged',
      'login_required', 'unauthorized', 'needs_refresh',
    ])
  ) {
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
  if (failure.marker !== undefined) meta.reason = failure.marker
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
 * Project one device-flow completion into a typed clue error.
 *
 * Only the fixed status enum and whitelisted scope names/console URL are used;
 * the completion payload's warning text is never projected.
 * @param completion - the sanitized stdout completion.
 */
export function larkCompletionError(completion: LarkCompletion): ClueError {
  const status = completion.status.toLowerCase()
  const meta: Record<string, string> = { reason: 'scope' }
  if (completion.missingScopes.length > 0) meta.missingScopes = completion.missingScopes.join(',')
  if (completion.consoleUrl !== undefined) meta.consoleUrl = completion.consoleUrl
  if (completion.missingScopes.length > 0 || status.includes('warning') || status.includes('partial')) {
    return new ClueError(
      'auth-required',
      `${FAILURE_MESSAGES['missing-scope']} (${larkScopeDetail(completion.missingScopes, completion.consoleUrl)})`,
      meta,
    )
  }
  if (status.includes('denied')) {
    meta.reason = 'denied'
    return new ClueError('auth-required', 'the Feishu authorization was denied; connect the account again', meta)
  }
  if (status.includes('expired')) {
    meta.reason = 'expired'
    return new ClueError('auth-required', 'the Feishu authorization expired; connect the account again', meta)
  }
  return new ClueError('failed', 'lark-cli reported that the authorization did not complete', meta)
}

/**
 * Execute one lark-cli invocation and parse both streams.
 *
 * Runner failures (dependency missing/incompatible, timeout, cancellation)
 * propagate unchanged: they are host facts, not CLI envelopes.
 *
 * The auth family is special: on exit 3 lark-cli 1.0.55 may print the device
 * completion object to STDOUT (with an empty/non-envelope stderr). Resource
 * commands still parse failures only from stderr and never accept stdout as a
 * failure signal.
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
  if (result.stdoutTruncated) return { result }
  const parsed = parseJsonPayload(result.stdout)
  const completion = completionOfValue(parsed)
  if (result.exitCode !== 0) {
    // Failure envelopes are read from stderr; the auth family additionally
    // tolerates a stdout error/completion envelope because the device flow
    // writes its terminal result there.
    let failure = parseLarkFailure(result.stderr)
    if (failure === undefined && request.bareSuccess === true) failure = failureOfValue(parsed)
    if (failure === undefined && completion === undefined) return { result }
    return {
      result,
      ...(failure === undefined ? {} : { failure }),
      ...(completion === undefined ? {} : { completion }),
    }
  }
  const envelope = recordOf(parsed)
  if (envelope === undefined) return { result }
  if (envelope.ok === true) {
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
  if (
    request.bareSuccess === true
    && envelope.ok === undefined
    && envelope.error === undefined
  ) {
    // A bare status/device-flow payload: the object itself is the data. The
    // envelope stays available for callers that read `identity`/`meta`.
    if (
      completion !== undefined
      && (completion.missingScopes.length > 0 || !/^(?:complete|completed|success|successful|ready|authorized|approved)$/.test(completion.status.toLowerCase()))
    ) {
      // A completion warning/denial is terminal, not a successful bare status.
      return { result, completion }
    }
    return { result, success: { data: envelope, envelope } }
  }
  if (request.bareSuccess === true) {
    const failure = failureOfValue(envelope)
    if (failure !== undefined) return { result, failure }
  }
  return { result }
}

/**
 * Execute one command and return its success payload, or throw a mapped error.
 * @param request - command, cwd and budgets.
 */
export async function runLark(request: LarkRequest): Promise<LarkSuccess> {
  const outcome = await executeLark(request)
  if (outcome.success !== undefined) return outcome.success
  if (outcome.completion !== undefined) throw larkCompletionError(outcome.completion)
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
