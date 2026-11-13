/**
 * The S2 CLI boundary.
 *
 * Everything a source adapter runs goes through this module:
 * - argv arrays with `shell: false` — no string concatenation, ever;
 * - an explicit absolute `cwd` (never the session's implicit cwd), so a user
 *   switching workspaces cannot silently select another CLI config;
 * - a fixed environment allowlist; `DSH_*`, token/key/password/auth variables
 *   and any unnamed variable never reach the child. A dependency may widen the
 *   allowlist by NAMES only, and secret-looking names are still refused;
 * - structured stdin for large bodies (they do not belong in argv);
 * - a timeout and an explicit per-stream output cap. A capped/truncated result
 *   says so; it is never presented as the complete output;
 * - cancellation through an AbortSignal that kills the child; the stdio
 *   handles are destroyed and settlement is forced after a short grace, so a
 *   grandchild holding the inherited pipes cannot hang the promise;
 * - stderr projection: ANSI stripped, token patterns redacted and bounded.
 *   stdout is returned to the trusted adapter ONLY; it never enters an error,
 *   a log message or a model-facing string. `runJson` refuses non-zero exits,
 *   empty output and malformed JSON instead of turning them into an empty list.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { ClueError, isClueError } from '../types.ts'
import type {
  CliChildProcess,
  CliCommandRequest,
  CliResult,
  CliRunner,
  CliSpawn,
  CliSpawnOptions,
} from './types.ts'

/** Default per-run budget when a source does not choose one. */
export const DEFAULT_CLI_TIMEOUT_MS = 30_000
/** Default per-stream capture cap (exceeding it is explicit in the result). */
export const DEFAULT_CLI_MAX_OUTPUT_BYTES = 1 << 20
/** Bound of the sanitized stderr projection (diagnostics only). */
export const MAX_CLI_STDERR_BYTES = 16 << 10
/**
 * After a timeout/cancellation kills the direct child, wait at most this long
 * for `close` before settling anyway. A grandchild that inherited stdout/stderr
 * keeps those pipes open, so `close` may never arrive; the run must not hang.
 */
const TERMINATION_GRACE_MS = 100

/**
 * Variables a CLI may inherit. Deliberately small: PATH/HOME/temp/locale plus
 * the Windows process basics. Tool-specific config dirs are added by the
 * dependency definition's `envAllowlist` (a name list, never values).
 */
export const CLI_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  // Windows exposes the same variable as `Path`; Node preserves the spelling.
  'Path',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERNAME',
  'USER',
  'LOGNAME',
  'SHELL',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
]

/**
 * Names that are never forwarded, even when a dependency asks for them:
 * DSH's own environment and anything that reads as a secret store. Plurals and
 * the browser credential names (`AUTHORIZATION`/`COOKIE`) are included on
 * purpose: they are exactly the names a CLI would never need as configuration.
 */
const FORBIDDEN_ENV_NAME = /^(?:DSH_|DSH$)|(?:^|_)(?:TOKENS?|SECRETS?|PASSWORDS?|PASSWD|PASS|API_?KEYS?|ACCESS_?KEYS?|PRIVATE_?KEYS?|CREDENTIALS?|AUTH|AUTHORIZATION|COOKIES?|SESSION_?KEY|BEARER)(?:_|$)/i

/** Whether one environment name is safe to hand to a child. */
export function isAllowedCliEnvName(name: string): boolean {
  return name.trim() !== '' && !FORBIDDEN_ENV_NAME.test(name)
}

/**
 * Build the child environment from the captured parent environment and a
 * request's extra values. Only allowlisted NAMES survive; extra values with an
 * unknown name are dropped silently (they are not needed and could carry a
 * secret by accident).
 */
export function buildCliEnv(
  inherited: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> | undefined,
  dependencyAllowlist: readonly string[] | undefined,
): Record<string, string> {
  const allowed = new Set([...CLI_ENV_ALLOWLIST, ...(dependencyAllowlist ?? [])])
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(inherited)) {
    if (typeof value !== 'string') continue
    if (!allowed.has(name) || !isAllowedCliEnvName(name)) continue
    out[name] = value
  }
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (!allowed.has(name) || !isAllowedCliEnvName(name)) continue
    out[name] = value
  }
  return out
}

/** Strip ANSI escape sequences and normalize line endings. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- the ESC byte is the point.
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n')
}

/**
 * Redact token-shaped values from a diagnostic projection. This is a
 * DEFENSE-IN-DEPTH filter for stderr only: stdout is never logged or shown, and
 * adapters still project their own whitelisted fields.
 */
export function redactCliOutput(text: string): string {
  let output = stripAnsi(text)
  // Whole credential headers first: `Authorization: Bearer …`,
  // `Cookie: …` and `Set-Cookie: …` (the scheme word alone must not be the
  // only redacted part).
  output = output.replace(
    /^([ \t]*(?:(?:proxy-)?authorization|(?:set-)?cookie)[ \t]*:[ \t]*).*$/gim,
    '$1[redacted]',
  )
  // Header / key-value forms: `token=…`, `"api_key": "…"`, `"cookie":"…"`.
  // Keep the key, replace the value. Longer token names come first so
  // `access_token` is not half-matched by the bare `token` alternative.
  output = output.replace(
    /((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?token|auth[_-]?token|token|api[_-]?key|private[_-]?key|password|passwd|secret|(?:set[_-]?)?cookie)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    '$1[redacted]',
  )
  output = output.replace(/\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, 'Bearer [redacted]')
  // Well-known token shapes (GitHub, Slack, AWS, OpenAI-style).
  output = output.replace(
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{16,})\b/g,
    '[redacted]',
  )
  return output
}

/** Truncate one UTF-8 string to at most `maxBytes` without splitting a codepoint badly. */
function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  const slice = buffer.subarray(0, maxBytes).toString('utf8')
  // A split multi-byte sequence decodes to U+FFFD; drop it rather than ship it.
  return slice.endsWith('\uFFFD') ? slice.slice(0, -1) : slice
}

/** Validate the common request fields; failures are fixed-category clue errors. */
function validateRequest(request: CliCommandRequest): void {
  if (typeof request.command !== 'string' || request.command.trim() === '') {
    throw new ClueError('invalid-request', 'a CLI command needs a non-empty executable path')
  }
  if (!Array.isArray(request.args) || request.args.some(arg => typeof arg !== 'string')) {
    throw new ClueError('invalid-request', 'CLI arguments must be an argv array of strings')
  }
  if (typeof request.cwd !== 'string' || request.cwd === '' || !isAbsolute(request.cwd)) {
    throw new ClueError('invalid-request', 'a CLI call needs an explicit absolute working directory')
  }
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1)) {
    throw new ClueError('invalid-request', 'the CLI timeout must be a positive integer')
  }
  if (request.maxOutputBytes !== undefined && (!Number.isInteger(request.maxOutputBytes) || request.maxOutputBytes < 1)) {
    throw new ClueError('invalid-request', 'the CLI output cap must be a positive integer')
  }
}

/** Map a spawn/process failure to a fixed category without echoing its text. */
function mapSpawnError(error: unknown): ClueError {
  if (isClueError(error)) return error
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT') {
    return new ClueError('dependency-missing', 'the CLI executable could not be found')
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new ClueError('permission-denied', 'the CLI executable is not permitted to run')
  }
  return new ClueError('failed', 'the CLI executable could not be started')
}

/** Options of {@link createCliRunner}. */
export interface CliRunnerOptions {
  /** Injected spawn (production wraps node:child_process). */
  readonly spawn: CliSpawn
  /** Captured parent environment; tests pass an isolated map. */
  readonly env?: NodeJS.ProcessEnv
  readonly defaultTimeoutMs?: number
  readonly defaultMaxOutputBytes?: number
}

/**
 * One captured stream: keeps at most `limit` bytes and records whether it had
 * to drop data. Overflow does NOT kill the child: the excess is drained but not
 * buffered, so the process can still exit normally, the result carries an
 * explicit `stdoutTruncated`/`stderrTruncated` flag, and `runJson` can refuse
 * the incomplete payload instead of reporting a process it killed itself.
 */
function createCapture(limit: number): {
  push(chunk: string | Uint8Array): void
  text(): string
  truncated(): boolean
} {
  const chunks: Buffer[] = []
  let received = 0
  let truncated = false
  return {
    push(chunk: string | Uint8Array): void {
      if (truncated) return
      const buffer = Buffer.from(chunk)
      const remaining = limit - received
      if (buffer.length <= remaining) {
        chunks.push(buffer)
        received += buffer.length
        return
      }
      if (remaining > 0) chunks.push(buffer.subarray(0, remaining))
      received += buffer.length
      truncated = true
    },
    text(): string {
      return Buffer.concat(chunks).toString('utf8')
    },
    truncated(): boolean {
      return truncated
    },
  }
}

/**
 * Create the process runner.
 * @param options - spawned process seam + captured environment.
 */
export function createCliRunner(options: CliRunnerOptions): CliRunner {
  const inheritedEnv = options.env ?? process.env
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS
  const defaultMaxOutputBytes = options.defaultMaxOutputBytes ?? DEFAULT_CLI_MAX_OUTPUT_BYTES

  const run = async (request: CliCommandRequest): Promise<CliResult> => {
    validateRequest(request)
    if (request.signal?.aborted === true) {
      throw new ClueError('cancelled', 'the CLI operation was cancelled')
    }
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs
    const maxOutputBytes = request.maxOutputBytes ?? defaultMaxOutputBytes
    const env = buildCliEnv(inheritedEnv, request.env, request.envAllowlist)
    const startedAt = Date.now()

    return new Promise<CliResult>((resolve, reject) => {
      let child: CliChildProcess
      let settled = false
      let timedOut = false
      let aborted = false
      let forceTimer: ReturnType<typeof setTimeout> | undefined

      const stdout = createCapture(maxOutputBytes)
      const stderr = createCapture(maxOutputBytes)

      const cleanup = (): void => {
        clearTimeout(timer)
        if (forceTimer !== undefined) clearTimeout(forceTimer)
        request.signal?.removeEventListener('abort', onAbort)
      }
      const fail = (error: ClueError): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const succeed = (code: number): void => {
        if (settled) return
        settled = true
        cleanup()
        const rawStderr = stderr.text()
        const sanitized = redactCliOutput(rawStderr)
        const bounded = truncateUtf8(sanitized, MAX_CLI_STDERR_BYTES)
        resolve({
          exitCode: code,
          stdout: stdout.text(),
          stderr: bounded,
          stdoutTruncated: stdout.truncated(),
          stderrTruncated: stderr.truncated() || bounded.length !== sanitized.length,
          durationMs: Date.now() - startedAt,
        })
      }
      const kill = (): void => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
      /** Release a stdio pipe even when a surviving grandchild still holds it. */
      const destroyStream = (stream: { destroy?(): void } | null | undefined): void => {
        try { stream?.destroy?.() } catch { /* already closed */ }
      }
      /** The final answer after a kill whose `close` event never arrives. */
      const forceSettle = (): void => {
        if (timedOut) {
          fail(new ClueError('timeout', 'the CLI operation timed out'))
          return
        }
        if (aborted) {
          fail(new ClueError('cancelled', 'the CLI operation was cancelled'))
          return
        }
        fail(new ClueError('failed', 'the CLI process could not be terminated cleanly'))
      }
      /**
       * Kill the child AND destroy the three stdio handles. Node emits `close`
       * only once every stdio stream is closed; a grandchild that inherited
       * stdout/stderr keeps the pipe open after the direct child exits. In that
       * case the short grace timer settles the promise instead of hanging it.
       */
      const terminate = (): void => {
        kill()
        destroyStream(child.stdout)
        destroyStream(child.stderr)
        destroyStream(child.stdin)
        if (forceTimer === undefined) {
          forceTimer = setTimeout(forceSettle, TERMINATION_GRACE_MS)
          forceTimer.unref?.()
        }
      }
      const onAbort = (): void => {
        aborted = true
        terminate()
      }

      try {
        child = options.spawn(request.command, [...request.args], {
          cwd: request.cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        } satisfies CliSpawnOptions)
      } catch (error) {
        reject(mapSpawnError(error))
        return
      }

      const timer = setTimeout(() => {
        timedOut = true
        terminate()
      }, timeoutMs)
      // Do not keep the event loop alive just for a pending child timeout.
      timer.unref?.()
      request.signal?.addEventListener('abort', onAbort, { once: true })

      const stdinHasPayload = request.stdin !== undefined
      // True once stdin finished flushing (or when there was no payload).
      // A child that closes before this point did not receive the payload.
      let stdinFinished = !stdinHasPayload
      child.stdout?.on('data', chunk => stdout.push(chunk))
      child.stderr?.on('data', chunk => stderr.push(chunk))
      child.on('error', error => fail(mapSpawnError(error)))
      child.on('close', (code, signal) => {
        if (timedOut) {
          fail(new ClueError('timeout', 'the CLI operation timed out'))
          return
        }
        if (aborted) {
          fail(new ClueError('cancelled', 'the CLI operation was cancelled'))
          return
        }
        if (stdinHasPayload && !stdinFinished) {
          // Covers EPIPE that arrives AFTER `close` (the write callback never
          // flushed), so an undelivered stdin can never be reported as success.
          fail(new ClueError('failed', 'the CLI process closed before the input was fully written'))
          return
        }
        if (code === null) {
          fail(new ClueError(
            'failed',
            signal === null ? 'the CLI process ended without an exit code' : 'the CLI process was terminated',
          ))
          return
        }
        succeed(code)
      })

      // An async stdin failure (typically EPIPE when the child exits before
      // reading) is an EventEmitter ERROR: without a listener it becomes an
      // uncaught exception and can take the host process down. It also means
      // the payload was NOT delivered, so a run with `stdin` must fail instead
      // of reporting the child's exit code as success. An EOF-only stdin may
      // legitimately close early and keeps the close/exit outcome.
      const onStdinError = (error: Error): void => {
        if (!stdinHasPayload) return
        kill()
        if (timedOut) {
          fail(new ClueError('timeout', 'the CLI operation timed out'))
          return
        }
        if (aborted) {
          fail(new ClueError('cancelled', 'the CLI operation was cancelled'))
          return
        }
        const code = (error as { code?: unknown } | null)?.code
        fail(new ClueError(
          'failed',
          code === 'EPIPE'
            ? 'the CLI process closed its input before the payload was written'
            : 'the CLI input could not be written',
        ))
      }
      try {
        child.stdin?.on?.('finish', () => { stdinFinished = true })
        child.stdin?.on?.('error', onStdinError)
      } catch {
        // A structural fake may not expose `on`; the synchronous write path
        // below still reports a broken stdin instead of pretending success.
      }

      // Close stdin even when there is no payload: many CLIs wait for EOF.
      try {
        if (stdinHasPayload) {
          if (child.stdin === null) {
            fail(new ClueError('failed', 'the CLI process does not accept input'))
            return
          }
          child.stdin.write(request.stdin!)
        }
        child.stdin?.end()
      } catch {
        if (!stdinHasPayload) return
        kill()
        fail(new ClueError('failed', 'the CLI input could not be written'))
      }
    })
  }

  const runJson = async <T = never>(request: CliCommandRequest): Promise<T> => {
    const result = await run(request)
    if (result.stdoutTruncated) {
      throw new ClueError('failed', 'the CLI output exceeded the capture limit and was not parsed')
    }
    if (result.exitCode !== 0) {
      throw new ClueError('failed', `the CLI command exited with code ${result.exitCode}`, {
        exitCode: String(result.exitCode),
      })
    }
    const text = result.stdout.trim()
    if (text === '') {
      throw new ClueError('failed', 'the CLI command returned no JSON output')
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new ClueError('failed', 'the CLI command did not return valid JSON')
    }
  }

  return { run, runJson: runJson as CliRunner['runJson'] }
}

/**
 * Build the command line used to run a `.cmd`/`.bat` shim through `cmd.exe`.
 *
 * Node cannot spawn a batch file directly (`shell: false` + CreateProcess), so
 * the production seam wraps it in a CONTROLLED `cmd.exe /d /s /c` invocation.
 * Every token is quoted, and characters cmd would expand/escape (`%`, quotes,
 * line breaks, NUL) are refused instead of being passed through.
 * @param command - absolute `.cmd`/`.bat` path.
 * @param args - argv tokens (never a pre-joined shell string).
 */
export function windowsShimCommandLine(command: string, args: readonly string[]): string {
  const quote = (value: string): string => {
    // eslint-disable-next-line no-control-regex -- NUL cannot reach cmd.exe.
    if (/["%\r\n\u0000]/.test(value)) {
      throw new ClueError(
        'invalid-request',
        'the Windows command arguments contain characters that cmd.exe would reinterpret',
      )
    }
    return `"${value}"`
  }
  return [command, ...args].map(quote).join(' ')
}

/**
 * Wrap node:child_process.spawn as the injectable seam.
 * @param options - platform override (tests); production uses `process.platform`.
 */
export function createNodeSpawn(options: { readonly platform?: NodeJS.Platform } = {}): CliSpawn {
  const platform = options.platform ?? process.platform
  return (command, args, spawnOptions) => {
    if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
      // Node's own `shell: true` path builds exactly this cmd.exe invocation;
      // doing it here keeps the runner's argv array + shell:false contract while
      // making npm/gh/lark-cli shims executable on Windows.
      const comspec = spawnOptions.env.ComSpec ?? spawnOptions.env.COMSPEC ?? 'cmd.exe'
      const commandLine = windowsShimCommandLine(command, args)
      return nodeSpawn(comspec, ['/d', '/s', '/c', `"${commandLine}"`], {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        stdio: [...spawnOptions.stdio],
        shell: false,
        windowsHide: spawnOptions.windowsHide,
        windowsVerbatimArguments: true,
      }) as unknown as CliChildProcess
    }
    return nodeSpawn(command, [...args], {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      stdio: [...spawnOptions.stdio],
      shell: false,
      windowsHide: spawnOptions.windowsHide,
    }) as unknown as CliChildProcess
  }
}
