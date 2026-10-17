/**
 * The shared `github.gh.auth` connection adapter (S3).
 *
 * gh owns the credentials (keyring/config), so this adapter never stores or
 * returns a token: it only projects the account and what the token can do.
 * This is the ACCOUNT-level row (login + token scopes); per-repository write
 * permission is not part of S2's `inspect` contract (it has no repository
 * input) and is carried by each read instead (`viewerPermission` in the
 * resource data, enforced by loadEdit/saveEdit). S9 can therefore show a
 * per-resource permission from the document/read data.
 *
 * Lifecycle rules:
 * - `inspect` runs `gh auth status --hostname github.com --json hosts` and is
 *   called ONLY for an explicit status/connect/poll by S2 — never on a timer,
 *   never during list/read/edit;
 * - `connect` is an explicit human action. It first checks the stored
 *   sign-in, then starts `gh auth login --web` in the background (with
 *   `--clipboard`) and returns a prompt with the official device URL. The
 *   login child is polled by the UI through `poll`, and `cancel` aborts it;
 * - KNOWN RUNNER BOUNDARY: S2's CLI runner is request/response, so gh's
 *   one-time code (written to stderr while the login child is still waiting)
 *   cannot be read before the child exits. The prompt therefore relies on
 *   gh's `--clipboard` copy and states the terminal fallback when the
 *   clipboard is unavailable. {@link projectLoginPrompt} is the tested
 *   whitelist projector a future streaming runner can wire without changing
 *   the prompt shape;
 * - the human prompt is a fixed whitelist (URL, code, expiry, poll hint,
 *   instructions). Machine handles, the process, stdout/stderr and any token
 *   stay host-side;
 * - there is no periodic auth probe and no automatic login on a resource
 *   failure (a real resource 401 is reported by the gh adapter instead).
 */
import { tmpdir } from 'node:os'
import { ClueError, isClueError } from '../../types.ts'
import type {
  ClueConnectionDefinition,
  ConnectionAdapterContext,
  ConnectionAuthorizationPrompt,
  ConnectionCancelInput,
  ConnectionConnectInput,
  ConnectionConnectStart,
  ConnectionInspection,
  ConnectionPollInput,
  ConnectionPollResult,
  ClueRuntime,
} from '../../runtime/types.ts'
import { mapGithubCliFailure } from './errors.ts'
import { authStatusArgs, loginArgs, parseGithubJson, runGithubCli } from './gh.ts'
import {
  GITHUB_AUTH_POLL_AFTER_MS,
  GITHUB_AUTH_STATUS_MAX_OUTPUT_BYTES,
  GITHUB_AUTH_STATUS_TIMEOUT_MS,
  GITHUB_AUTH_TIMEOUT_MS,
  GITHUB_CONNECTION_ID,
  GITHUB_DEVICE_URL,
  GITHUB_HOST,
  GITHUB_LOGIN_MAX_OUTPUT_BYTES,
  GITHUB_PLUGIN_ID,
} from './ids.ts'

/** The capability ids the connection can grant (token-level). */
export const GITHUB_CONNECTION_CAPABILITIES = [
  'issues.read',
  'issues.write',
  'pulls.read',
  'pulls.write',
] as const

/** The connection's display name. */
const CONNECTION_NAME = 'GitHub account'

/** Fixed, user-renderable instruction (host-side copy, not a secret). */
const LOGIN_INSTRUCTIONS =
  'Open the GitHub device URL and enter the one-time code the GitHub CLI copied to your clipboard. '
  + 'If the code was not copied (for example on a headless system), cancel and run '
  + '"gh auth login" in a terminal, then retry. The connection completes after the browser sign-in finishes.'

/** Options of {@link createGithubAuthAdapter}. */
export interface GithubAuthOptions {
  /** Lazy runtime accessor (S9 installs the runtime after the sources). */
  readonly runtime: () => ClueRuntime
  readonly cwd?: string
  /** Millisecond clock (S2 session TTLs use the same domain). */
  readonly now?: () => number
  readonly newId?: () => string
  /** Prompt/attempt lifetime; the login child is killed after it. */
  readonly promptTtlMs?: number
  /** The login child's own timeout (defaults to the prompt lifetime). */
  readonly loginTimeoutMs?: number
}

/** Per-adapter attempt id sequence (deterministic in tests). */
let sequence = 0

/** The adapter surface index.ts installs. */
export interface GithubAuthAdapter {
  readonly definition: ClueConnectionDefinition
  /** Abort every in-flight login and clear adapter state (idempotent). */
  dispose(): void
}

/** One background login attempt (host-side only). */
interface LoginAttempt {
  readonly id: string
  readonly controller: AbortController
  readonly prompt: ConnectionAuthorizationPrompt
  settled: boolean
  succeeded: boolean
  error?: ClueError
}

/** Whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Project token scopes to capability ids. Fine-grained tokens report no
 * scopes; writes are advertised optimistically and the actual 403 from gh is
 * mapped to permission-denied.
 */
export function capabilitiesOfScopes(scopes: string | undefined): string[] {
  const capabilities: string[] = ['issues.read', 'pulls.read']
  if (scopes === undefined) return [...capabilities, 'issues.write', 'pulls.write']
  const entries = new Set(scopes.split(',').map(entry => entry.trim()).filter(entry => entry !== ''))
  if (entries.has('repo') || entries.has('public_repo')) {
    capabilities.push('issues.write', 'pulls.write')
  }
  if (!entries.has('repo') && entries.has('public_repo')) capabilities.push('repo:public')
  return capabilities
}

/**
 * Parse `gh auth status --json hosts` into an inspection.
 *
 * @param payload - the parsed JSON payload.
 */
export function parseGithubAuthStatus(payload: unknown): ConnectionInspection {
  if (!isRecord(payload) || !isRecord(payload.hosts)) {
    return {
      configuration: 'not-required',
      authorization: 'unknown',
      detail: 'the GitHub CLI auth status could not be read',
    }
  }
  const list = payload.hosts[GITHUB_HOST]
  if (!Array.isArray(list) || list.length === 0) {
    return {
      configuration: 'not-required',
      authorization: 'not-authorized',
      detail: 'not signed in to github.com',
    }
  }
  const entries = list.filter((entry): entry is Record<string, unknown> => isRecord(entry))
  const active = entries.find(entry => entry.active === true) ?? entries[0]
  if (active === undefined) {
    return {
      configuration: 'not-required',
      authorization: 'not-authorized',
      detail: 'not signed in to github.com',
    }
  }
  const login = typeof active.login === 'string' && active.login !== '' ? active.login : undefined
  const scopes = typeof active.scopes === 'string' ? active.scopes : undefined
  if (active.state !== 'success') {
    return {
      configuration: 'not-required',
      authorization: 'expired',
      ...(login === undefined ? {} : { account: login }),
      detail: 'the stored GitHub sign-in is no longer valid',
    }
  }
  return {
    configuration: 'not-required',
    authorization: 'ready',
    ...(login === undefined ? {} : { account: login }),
    capabilities: capabilitiesOfScopes(scopes),
    ...(scopes === undefined ? {} : { detail: `token scopes: ${scopes}` }),
  }
}

/**
 * Whitelist-project the human fields of gh's login output.
 *
 * gh prints the one-time code and the device URL while the flow runs (its
 * fallback wording is `First copy your one-time code: CODE`; the clipboard
 * variant is `One-time code (CODE)`). This function keeps those two fields
 * (and the fixed instruction/expiry) and drops everything else. The blocked
 * S2 runner is request/response, so the connect prompt uses the official URL
 * and gh's own `--clipboard` copy of the code; this projector is the single
 * place that turns captured output into a prompt when a streaming runner
 * makes it available.
 *
 * @param output - captured stdout/stderr of `gh auth login --web`.
 * @param options - clock/ttl seams (tests).
 */
export function projectLoginPrompt(
  output: string,
  options: { readonly now?: () => number; readonly ttlMs?: number } = {},
): ConnectionAuthorizationPrompt | undefined {
  if (typeof output !== 'string' || output === '') return undefined
  const code = /one-time code[^\n]*?[(:]\s*([A-Za-z0-9-]{4,})/i.exec(output)?.[1]
  const url = /(https:\/\/github\.com\/login\/device\S*)/i.exec(output)?.[1]
  if (code === undefined && url === undefined) return undefined
  const now = options.now ?? (() => Date.now())
  const ttl = options.ttlMs ?? GITHUB_AUTH_TIMEOUT_MS
  return {
    ...(url === undefined ? {} : { verificationUrl: url }),
    ...(code === undefined ? {} : { userCode: code }),
    expiresAt: new Date(now() + ttl).toISOString(),
    pollAfterMs: GITHUB_AUTH_POLL_AFTER_MS,
    instructions: LOGIN_INSTRUCTIONS,
  }
}

/**
 * Create the shared GitHub account connection adapter.
 * @param options - lazy runtime, working directory and clock/id seams.
 */
export function createGithubAuthAdapter(options: GithubAuthOptions): GithubAuthAdapter {
  const now = options.now ?? (() => Date.now())
  const newId = options.newId ?? (() => `github-auth-${String(++sequence)}`)
  const cwd = options.cwd ?? tmpdir()
  const promptTtlMs = options.promptTtlMs ?? GITHUB_AUTH_TIMEOUT_MS
  const loginTimeoutMs = options.loginTimeoutMs ?? promptTtlMs
  const attempts = new Map<string, LoginAttempt>()
  let disposed = false

  const inspect = async (signal: AbortSignal | undefined): Promise<ConnectionInspection> => {
    const result = await runGithubCli(options.runtime(), authStatusArgs(), {
      cwd,
      timeoutMs: GITHUB_AUTH_STATUS_TIMEOUT_MS,
      maxOutputBytes: GITHUB_AUTH_STATUS_MAX_OUTPUT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    })
    if (result.exitCode !== 0) {
      const error = mapGithubCliFailure(result)
      // A stored sign-in that no longer authenticates is an observation, not
      // a failed status call: the UI must offer "reconnect".
      if (error.category === 'auth-required') {
        return {
          configuration: 'not-required',
          authorization: result.exitCode === 4 ? 'not-authorized' : 'expired',
          detail: result.exitCode === 4
            ? 'not signed in to github.com'
            : 'the stored GitHub sign-in is no longer valid',
        }
      }
      throw error
    }
    return parseGithubAuthStatus(parseGithubJson(result))
  }

  /** Start the background login child; the prompt travels immediately. */
  const startLogin = (parentSignal: AbortSignal | undefined): LoginAttempt => {
    const controller = new AbortController()
    const onParentAbort = (): void => controller.abort()
    if (parentSignal !== undefined) {
      if (parentSignal.aborted) controller.abort()
      else parentSignal.addEventListener('abort', onParentAbort, { once: true })
    }
    const prompt: ConnectionAuthorizationPrompt = {
      verificationUrl: GITHUB_DEVICE_URL,
      expiresAt: new Date(now() + promptTtlMs).toISOString(),
      pollAfterMs: GITHUB_AUTH_POLL_AFTER_MS,
      instructions: LOGIN_INSTRUCTIONS,
    }
    const attempt: LoginAttempt = {
      id: newId(),
      controller,
      prompt,
      settled: false,
      succeeded: false,
    }
    attempts.set(attempt.id, attempt)
    // The login child is intentionally fire-and-forget: `poll` reads the
    // settled flags, and `cancel`/`dispose` abort it through the controller.
    void (async () => {
      try {
        const result = await runGithubCli(options.runtime(), loginArgs(), {
          cwd,
          timeoutMs: loginTimeoutMs,
          maxOutputBytes: GITHUB_LOGIN_MAX_OUTPUT_BYTES,
          signal: controller.signal,
        })
        if (result.stdoutTruncated) {
          attempt.error = new ClueError('failed', 'the GitHub CLI output exceeded the capture limit and was not parsed')
        } else if (result.exitCode !== 0) {
          attempt.error = mapGithubCliFailure(result)
        } else {
          attempt.succeeded = true
        }
      } catch (error) {
        attempt.error = isClueError(error)
          ? error
          : new ClueError('failed', 'the GitHub sign-in could not be started')
      } finally {
        attempt.settled = true
        parentSignal?.removeEventListener('abort', onParentAbort)
      }
    })()
    return attempt
  }

  const attemptOf = (input: { readonly authorizationId: string; readonly state?: unknown }): LoginAttempt | undefined => {
    const direct = attempts.get(input.authorizationId)
    if (direct !== undefined) return direct
    if (isRecord(input.state) && typeof input.state.attemptId === 'string') {
      return attempts.get(input.state.attemptId)
    }
    return undefined
  }

  /** The terminal inspection of a failed login; never carries provider text. */
  const failedInspection = (category: string | undefined): ConnectionInspection => {
    if (category === 'timeout') {
      return {
        configuration: 'not-required',
        authorization: 'expired',
        detail: 'the GitHub sign-in flow expired before it completed',
      }
    }
    if (category === 'cancelled') {
      return {
        configuration: 'not-required',
        authorization: 'not-authorized',
        detail: 'the GitHub sign-in was cancelled',
      }
    }
    return {
      configuration: 'not-required',
      authorization: 'not-authorized',
      detail: 'the GitHub sign-in did not complete',
    }
  }

  const definition: ClueConnectionDefinition = {
    connectionId: GITHUB_CONNECTION_ID,
    name: CONNECTION_NAME,
    pluginId: GITHUB_PLUGIN_ID,
    configuration: 'not-required',
    credentialOwner: 'tool',
    capabilities: [...GITHUB_CONNECTION_CAPABILITIES],
    async inspect(
      _input: ConnectionConnectInput,
      context: ConnectionAdapterContext,
    ): Promise<ConnectionInspection> {
      if (disposed) throw new ClueError('failed', 'the GitHub connection adapter has been disposed')
      return await inspect(context.signal)
    },
    async connect(
      input: ConnectionConnectInput,
      _context: ConnectionAdapterContext,
    ): Promise<ConnectionConnectStart> {
      if (disposed) throw new ClueError('failed', 'the GitHub connection adapter has been disposed')
      // The connect click is itself an explicit status request: an already
      // signed-in account must not start a second device flow.
      const current = await inspect(input.signal)
      if (current.authorization === 'ready') return { inspection: current }
      // Never run two device flows for one shared connection.
      for (const pending of [...attempts.values()]) {
        pending.controller.abort()
        attempts.delete(pending.id)
      }
      const attempt = startLogin(input.signal)
      return {
        inspection: { configuration: 'not-required', authorization: 'authorizing' },
        authorizationId: attempt.id,
        state: { attemptId: attempt.id },
        prompt: attempt.prompt,
      }
    },
    async poll(
      input: ConnectionPollInput,
      context: ConnectionAdapterContext,
    ): Promise<ConnectionPollResult> {
      if (disposed) throw new ClueError('failed', 'the GitHub connection adapter has been disposed')
      const attempt = attemptOf(input)
      if (attempt === undefined) {
        return {
          inspection: {
            configuration: 'not-required',
            authorization: 'not-authorized',
            detail: 'the GitHub sign-in is no longer in progress',
          },
          complete: true,
        }
      }
      if (!attempt.settled) return { prompt: attempt.prompt }
      if (attempt.succeeded) {
        // Keep the succeeded attempt until the confirming status read returns:
        // a transient `auth status` failure must be retryable by the next poll
        // instead of being presented as "no sign-in in progress".
        const inspection = await inspect(context.signal)
        attempts.delete(attempt.id)
        return { inspection, complete: true }
      }
      attempts.delete(attempt.id)
      return { inspection: failedInspection(attempt.error?.category), complete: true }
    },
    async cancel(input: ConnectionCancelInput, _context: ConnectionAdapterContext): Promise<void> {
      const attempt = attemptOf(input)
      if (attempt === undefined) return
      attempt.controller.abort()
      attempts.delete(attempt.id)
    },
  }

  return {
    definition,
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const attempt of attempts.values()) attempt.controller.abort()
      attempts.clear()
    },
  }
}
