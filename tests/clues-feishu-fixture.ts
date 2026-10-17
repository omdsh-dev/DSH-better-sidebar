/**
 * Test doubles for the Feishu source contracts.
 *
 * The fake runtime captures every `CliRunRequest` so tests assert argv/CWD/env
 * and never touch a real lark-cli, a real account or the network. Answers are
 * queued per call; an unqueued call is a test bug, not an empty result.
 */
import type {
  CliResult,
  CliRunRequest,
  ClueRuntime,
  ConnectionInspection,
} from '../src/clues/runtime/types.ts'
import type { JsonValue } from '../src/clues/types.ts'

/** One queued answer (a value or a function of the captured request). */
export type FakeAnswer = CliResult | ((request: CliRunRequest) => CliResult | Promise<CliResult>)

/** One connection observation captured from a resource request. */
export interface FakeConnectionReport {
  readonly connectionId: string
  readonly inspection: ConnectionInspection
}

/** A capturing fake of the S2 runtime's CLI face. */
export class FakeLarkRuntime {
  readonly requests: CliRunRequest[] = []
  /** Observations the adapter published through `runtime.connections.report`. */
  readonly reports: FakeConnectionReport[] = []
  private readonly answers: FakeAnswer[] = []

  readonly connections = {
    report: (connectionId: string, inspection: ConnectionInspection): void => {
      this.reports.push({ connectionId, inspection })
    },
  }

  enqueue(...answers: FakeAnswer[]): this {
    this.answers.push(...answers)
    return this
  }

  async runCli(request: CliRunRequest): Promise<CliResult> {
    this.requests.push(request)
    const answer = this.answers.shift()
    if (answer === undefined) throw new Error('[fake-lark] no queued CLI answer')
    return typeof answer === 'function' ? await answer(request) : answer
  }

  async runCliJson(): Promise<never> {
    throw new Error('[fake-lark] lark-cli is parsed by the source adapter, not runCliJson')
  }

  dispose(): void {}

  asRuntime(): ClueRuntime {
    return this as unknown as ClueRuntime
  }

  /** All argument vectors, for cross-cutting negative assertions. */
  args(): string[][] {
    return this.requests.map(request => [...request.args])
  }
}

/** One CLI result with safe defaults. */
export function cliResult(overrides: Partial<CliResult> = {}): CliResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    ...overrides,
  }
}

/** A successful lark-cli envelope on stdout. */
export function okResult(data: JsonValue, extra: Record<string, JsonValue> = {}): CliResult {
  return cliResult({ stdout: JSON.stringify({ ok: true, identity: 'user', data, ...extra }) })
}

/**
 * The real `auth status --json` shape: a BARE object with top-level
 * `appId`/`brand`/`identities`/`identity`/`note` (no `ok`, no `data`).
 */
export function bareResult(value: Record<string, JsonValue>): CliResult {
  return cliResult({ stdout: JSON.stringify(value) })
}

/** A bare auth-status answer with the given identities. */
export function statusResult(
  identities: Record<string, JsonValue>,
  extra: Record<string, JsonValue> = {},
): CliResult {
  return bareResult({
    appId: 'cli_test',
    brand: 'feishu',
    identity: 'user',
    identities,
    ...extra,
  })
}

/** A failed lark-cli envelope on stderr (non-zero exit). */
export function failResult(error: Record<string, JsonValue>, exitCode = 1): CliResult {
  return cliResult({ exitCode, stderr: JSON.stringify({ ok: false, identity: 'user', error }) })
}

/** One UI operation context. */
export function operationContext(overrides: Record<string, unknown> = {}): {
  workspaceId: string
  workspacePath: string
  caller: 'ui'
  signal?: AbortSignal
} {
  return {
    workspaceId: 'ws-feishu',
    workspacePath: '/tmp/dsh-feishu',
    caller: 'ui',
    ...overrides,
  } as {
    workspaceId: string
    workspacePath: string
    caller: 'ui'
    signal?: AbortSignal
  }
}
