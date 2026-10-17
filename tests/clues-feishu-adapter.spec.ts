/**
 * S4 Feishu adapter contract (host half, no real CLI).
 *
 * Everything here runs against a fake `ClueRuntime` that captures the argv it
 * was handed; lark-cli is NOT installed on this host and no real account is
 * touched. The fixtures encode the lark-cli envelope shapes documented by the
 * local lark skill (`ok:true` on stdout + exit 0; `ok:false` on stderr + a
 * non-zero exit; `_notice` is a notice, never an error).
 *
 * Pins:
 * - one lazily-resolved runtime: building the sources/definitions performs no
 *   CLI call and does not need the runtime at all;
 * - `inspect` runs `auth status --json` ONLY when the explicit status path
 *   calls it — never `--verify`, never `--dry-run`, never on a timer;
 * - `connect` first runs the read-only `auth status` check (so a "configure"
 *   click never launches a login it cannot complete), then exactly
 *   `auth login --domain docs --domain drive --domain task --no-wait --json`;
 *   the verification URL is forwarded as the SAME opaque string (no
 *   re-encoding), the QR payload is that same string, and the device code stays
 *   in the host-side `state` (never in the prompt);
 * - `poll` runs `auth login --device-code … --json` for the explicit poll
 *   only, and a success envelope with a pending/denied status stays pending or
 *   denied instead of claiming ready;
 * - the shared connection derives its declared capabilities from
 *   `identities.user.scope`: a docs/drive-only grant reports
 *   `scope-insufficient` instead of advertising the task capabilities;
 * - cancel performs no CLI call (the CLI documents no device-code cancel verb
 *   — dropping the handle is the cancellation);
 * - success needs `ok:true` AND exit 0; failures come only from the stderr
 *   envelope; `error.code` is an upstream number, never the success signal;
 * - missing scopes and `console_url` survive as a safe projection, while raw
 *   messages, hints, device codes and token-shaped values never do.
 */
import { describe, expect, it } from 'vitest'
import type { JsonValue } from '../src/clues/types.ts'
import type {
  CliResult,
  CliRunRequest,
  ClueRuntime,
  ConnectionAdapterContext,
} from '../src/clues/runtime/index.ts'
import { createConnectionsRuntime } from '../src/clues/runtime/connections.ts'
import { createDependenciesRuntime } from '../src/clues/runtime/dependencies.ts'
import {
  createFeishuSources,
  FEISHU_CONNECTION_ID,
  FEISHU_DEPENDENCY_ID,
  FEISHU_SOURCE_IDS,
  FEISHU_TYPE_IDS,
  LARK_CLI_PACKAGE,
  LARK_CLI_VERSION,
  larkAuthLoginArgs,
  larkAuthPollArgs,
  larkAuthStatusArgs,
} from '../src/clues/sources/feishu/index.ts'
import {
  classifyLarkFailure,
  executeLark,
  larkFailureError,
  parseLarkFailure,
  runLark,
  type LarkFailure,
} from '../src/clues/sources/feishu/lark.ts'

const NOW = '2026-10-17T00:00:00.000Z'
const CWD = '/tmp/dsh-feishu-adapter'

/** One captured CLI request with a queued answer. */
class FakeRuntime {
  readonly requests: CliRunRequest[] = []
  private readonly answers: Array<CliResult | ((request: CliRunRequest) => CliResult)> = []

  enqueue(...answers: Array<CliResult | ((request: CliRunRequest) => CliResult)>): this {
    this.answers.push(...answers)
    return this
  }

  async runCli(request: CliRunRequest): Promise<CliResult> {
    this.requests.push(request)
    const answer = this.answers.shift()
    if (answer === undefined) throw new Error('[fake] no queued CLI answer')
    return typeof answer === 'function' ? answer(request) : answer
  }

  async runCliJson(): Promise<never> {
    throw new Error('[fake] runCliJson is not part of the lark adapter path')
  }

  dispose(): void {}

  asRuntime(): ClueRuntime {
    return this as unknown as ClueRuntime
  }
}

function cliResult(overrides: Partial<CliResult>): CliResult {
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

function okResult(data: JsonValue, extra: Record<string, JsonValue> = {}): CliResult {
  return cliResult({ stdout: JSON.stringify({ ok: true, identity: 'user', data, ...extra }) })
}

function failResult(error: Record<string, JsonValue>, exitCode = 1): CliResult {
  return cliResult({ exitCode, stderr: JSON.stringify({ ok: false, identity: 'user', error }) })
}

function adapterContext(observed: unknown[]): ConnectionAdapterContext {
  return {
    now: () => NOW,
    resolveCredential: async () => undefined,
    report(value) { observed.push(value) },
  }
}

function statusData(user: Record<string, JsonValue>): JsonValue {
  return { identities: { user } }
}

/** The documented scope families that cover the four declared capabilities. */
const ALL_SCOPES = [
  'docx:document:read',
  'search:docs:read',
  'task:task:read',
  'task:task:write',
]
/** A docs/drive-only grant: no task scope was authorized. */
const DOCS_ONLY_SCOPES = [
  'docx:document:read',
  'search:docs:read',
  'drive:drive.metadata:readonly',
]

describe('createFeishuSources: lazy runtime and shared definitions', () => {
  it('builds registrations, dependency and connection without touching the runtime', () => {
    const bundle = createFeishuSources({
      runtime: () => { throw new Error('the runtime must stay lazy during construction') },
    })

    expect(bundle.sources).toHaveLength(2)
    expect(bundle.registrations).toBe(bundle.sources)
    expect(bundle.sources.map(source => source.descriptor.sourceId)).toEqual([
      FEISHU_SOURCE_IDS.docs,
      FEISHU_SOURCE_IDS.tasks,
    ])
    expect(bundle.sources[0]!.descriptor.types).toEqual([FEISHU_TYPE_IDS.docx, FEISHU_TYPE_IDS.wiki])
    expect(bundle.sources[1]!.descriptor.types).toEqual([FEISHU_TYPE_IDS.task])
    // One shared CLI dependency and ONE shared authorization connection.
    for (const source of bundle.sources) {
      expect(source.descriptor.transport).toBe('cli')
      expect(source.descriptor.dependencyIds).toEqual([FEISHU_DEPENDENCY_ID])
      expect(source.descriptor.connectionId).toBe(FEISHU_CONNECTION_ID)
      expect(source.descriptor.pluginId).toBe('dsh-better-sidebar')
    }
    expect(bundle.sources[0]!.descriptor.capabilities.edit).toBe(false)
    expect(bundle.sources[1]!.descriptor.capabilities.edit).toBe(true)
    // The docs type states WHY it is read-only instead of silently offering a
    // lossy append/overwrite write path.
    const docsType = bundle.sources[0]!.types[0]!
    expect(docsType.capabilities).toMatchObject({ read: true, edit: false, concurrency: 'none' })
    expect(JSON.stringify(docsType.extensions)).toMatch(/append|overwrite/i)
    expect(JSON.stringify(docsType.extensions)).toMatch(/read-only|read only/i)
  })

  it('declares the pinned official npm dependency and a manual-install fallback', () => {
    const bundle = createFeishuSources({ runtime: () => { throw new Error('lazy') } })
    const dependency = bundle.dependency

    expect(dependency.dependencyId).toBe(FEISHU_DEPENDENCY_ID)
    expect(dependency.command).toBe('lark-cli')
    expect(dependency.version).toEqual({ minimum: LARK_CLI_VERSION, recommended: LARK_CLI_VERSION })
    expect(dependency.supportedPlatforms.length).toBeGreaterThan(0)
    expect(dependency.manualInstall?.instructions).toBeTruthy()
    const npm = dependency.install?.distributions.find(distribution => distribution.kind === 'npm')
    if (npm === undefined) throw new Error('the lark dependency needs an npm distribution')
    expect(npm.packageName).toBe(LARK_CLI_PACKAGE)
    expect(npm.packageVersion).toBe(LARK_CLI_VERSION)
    expect(npm.runScripts).toBe(false)
    expect(npm.executable).toMatch(/^node_modules\/\.bin\/lark-cli/)

    // The real S2 dependency registry accepts the definition as-is.
    const runtime = createDependenciesRuntime({
      home: CWD,
      platform: 'darwin',
      arch: 'arm64',
      env: { PATH: '' },
      runProcess: {
        run: async () => cliResult({ exitCode: 1, stderr: 'missing' }),
        runJson: async () => { throw new Error('unused') },
      },
      now: () => Date.parse(NOW),
    })
    try {
      const dispose = runtime.register(dependency)
      expect(runtime.getDefinition(FEISHU_DEPENDENCY_ID)?.command).toBe('lark-cli')
      dispose()
    } finally {
      runtime.dispose()
    }
  })

  it('declares the two-step connection (required app config, explicit user authorization)', () => {
    const bundle = createFeishuSources({ runtime: () => { throw new Error('lazy') } })
    expect(bundle.connection.connectionId).toBe(FEISHU_CONNECTION_ID)
    expect(bundle.connection.configuration).toBe('required')
    expect(bundle.connection.credentialOwner).toBe('tool')
    expect(bundle.connection.capabilities).toEqual(
      expect.arrayContaining(['docs.read', 'docs.search', 'tasks.read', 'tasks.edit']),
    )
    expect(typeof bundle.connection.inspect).toBe('function')
    expect(typeof bundle.connection.connect).toBe('function')
    expect(typeof bundle.connection.poll).toBe('function')
    expect(typeof bundle.connection.cancel).toBe('function')
  })
})

describe('lark envelope adapter', () => {
  it('requires ok:true on stdout AND exit 0 for success', async () => {
    const success = new FakeRuntime().enqueue(okResult({ value: 1 }))
    const outcome = await executeLark({
      runtime: success.asRuntime(), args: ['x'], cwd: CWD,
    })
    expect(outcome.success?.data).toEqual({ value: 1 })
    expect(outcome.failure).toBeUndefined()

    const okButNonZero = new FakeRuntime().enqueue(cliResult({
      exitCode: 1,
      stdout: JSON.stringify({ ok: true, data: { value: 1 } }),
    }))
    await expect(runLark({ runtime: okButNonZero.asRuntime(), args: ['x'], cwd: CWD }))
      .rejects.toMatchObject({ category: 'failed' })

    const notOkButZero = new FakeRuntime().enqueue(cliResult({
      exitCode: 0,
      stdout: JSON.stringify({ ok: false, error: { type: 'unknown' } }),
    }))
    await expect(runLark({ runtime: notOkButZero.asRuntime(), args: ['x'], cwd: CWD }))
      .rejects.toMatchObject({ category: 'failed' })
  })

  it('never treats a top-level code==0 or a bare exit 0 as success', async () => {
    const legacyCode = new FakeRuntime().enqueue(cliResult({ stdout: JSON.stringify({ code: 0, msg: 'ok' }) }))
    const outcome = await executeLark({ runtime: legacyCode.asRuntime(), args: ['x'], cwd: CWD })
    expect(outcome.success).toBeUndefined()
    expect(outcome.failure).toBeUndefined()
    const legacyRun = new FakeRuntime().enqueue(cliResult({ stdout: JSON.stringify({ code: 0, msg: 'ok' }) }))
    await expect(runLark({ runtime: legacyRun.asRuntime(), args: ['x'], cwd: CWD }))
      .rejects.toMatchObject({ category: 'failed' })

    const empty = new FakeRuntime().enqueue(cliResult({ exitCode: 0, stdout: '' }))
    await expect(runLark({ runtime: empty.asRuntime(), args: ['x'], cwd: CWD }))
      .rejects.toMatchObject({ category: 'failed' })
  })

  it('reads failures only from the stderr envelope and ignores _notice', async () => {
    const runtime = new FakeRuntime().enqueue(cliResult({
      exitCode: 1,
      stdout: JSON.stringify({ ok: true, data: { should: 'not be read' } }),
      stderr: JSON.stringify({
        ok: false,
        error: { type: 'not_found', subtype: 'resource_missing', code: 404 },
        _notice: { update: { message: 'a new version exists' } },
      }),
    }))
    const outcome = await executeLark({ runtime: runtime.asRuntime(), args: ['x'], cwd: CWD })
    expect(outcome.success).toBeUndefined()
    expect(classifyLarkFailure(outcome.failure!)).toBe('not-found')
    expect(JSON.stringify(outcome.failure)).not.toMatch(/new version|should|not be read/)

    const success = new FakeRuntime().enqueue(cliResult({
      stdout: JSON.stringify({
        ok: true,
        data: { value: 'kept' },
        _notice: { update: { message: 'a new version exists' } },
      }),
    }))
    const kept = await runLark({ runtime: success.asRuntime(), args: ['x'], cwd: CWD })
    expect(kept.data).toEqual({ value: 'kept' })
  })

  it('maps failure classes and keeps raw messages/hints out of the error', () => {
    const cases: Array<[LarkFailure, string]> = [
      [{ type: 'configuration', subtype: 'not_configured', missingScopes: [] }, 'config-missing'],
      [{ type: 'authorization', subtype: 'missing_scope', missingScopes: ['docx:document:read'] }, 'missing-scope'],
      [{ type: 'authorization', subtype: 'token_expired', missingScopes: [] }, 'authorization'],
      [{ type: 'permission', subtype: 'forbidden', code: 403, missingScopes: [] }, 'permission'],
      [{ type: 'not_found', subtype: 'resource_missing', code: 404, missingScopes: [] }, 'not-found'],
      [{ type: 'rate_limit', subtype: 'too_many_requests', code: 429, missingScopes: [] }, 'rate-limited'],
      [{ type: 'conflict', subtype: 'revision_mismatch', missingScopes: [] }, 'conflict'],
      [{ type: 'unsupported', subtype: 'complex_block', missingScopes: [] }, 'unsupported'],
      [{ type: 'invalid_parameter', subtype: 'validation', code: 99992402, missingScopes: [] }, 'invalid-request'],
      [{ type: 'mystery', subtype: 'surprise', missingScopes: [] }, 'failed'],
    ]
    for (const [failure, expected] of cases) {
      expect(classifyLarkFailure(failure), JSON.stringify(failure)).toBe(expected)
    }

    const failure: LarkFailure = {
      type: 'authorization',
      subtype: 'missing_scope',
      code: 99991679,
      missingScopes: ['docx:document:read', 'drive:drive:read'],
      consoleUrl: 'https://open.feishu.cn/app/cli_x/auth?q=scope&op=1',
    }
    const error = larkFailureError(failure)
    expect(error.category).toBe('auth-required')
    expect(error.message).not.toMatch(/super-secret|dc_secret/)
    // The wire only carries { code, message }, so the actionable detail must be
    // in the message as well as the meta.
    expect(error.message).toContain('docx:document:read')
    expect(error.message).toContain('https://open.feishu.cn/app/cli_x/auth?q=scope&op=1')
    expect(JSON.stringify(error.meta)).not.toMatch(/super-secret|dc_secret/)
    expect(error.meta?.missingScopes).toBe('docx:document:read,drive:drive:read')
    expect(error.meta?.consoleUrl).toBe('https://open.feishu.cn/app/cli_x/auth?q=scope&op=1')
  })

  it('parses only whitelisted failure fields and drops malformed/secret values', () => {
    const failure = parseLarkFailure(JSON.stringify({
      ok: false,
      error: {
        type: 'authorization',
        subtype: 'missing_scope',
        code: 99991679,
        message: 'raw message with Bearer super-secret-token',
        hint: 'raw hint with device_code=dc_secret',
        missing_scopes: ['ok:scope', 'bad scope with spaces', 'x'.repeat(300)],
        console_url: 'javascript:alert(1)',
        device_code: 'dc_secret',
      },
    }))
    expect(failure).toBeDefined()
    expect(failure!.missingScopes).toEqual(['ok:scope'])
    expect(failure!.consoleUrl).toBeUndefined()
    expect(JSON.stringify(failure)).not.toMatch(/super-secret|dc_secret|raw message|raw hint/)
    expect(larkFailureError(failure!).meta?.missingScopes).toBe('ok:scope')
  })

  it('passes the shared dependency id, an absolute cwd, a bounded budget and the notifier-free env', async () => {
    const runtime = new FakeRuntime().enqueue(okResult({}))
    await runLark({ runtime: runtime.asRuntime(), args: ['auth', 'status', '--json'], cwd: CWD })
    const request = runtime.requests[0]!
    expect(request.dependencyId).toBe(FEISHU_DEPENDENCY_ID)
    expect(request.cwd).toBe(CWD)
    expect(request.timeoutMs).toBeGreaterThan(0)
    expect(request.env).toMatchObject({
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    })
  })
})

describe('connection adapter: explicit status and two-step authorization', () => {
  it('inspect runs auth status --json only — no --verify, no --dry-run', async () => {
    const runtime = new FakeRuntime().enqueue(okResult(statusData({
      status: 'ready',
      tokenStatus: 'valid',
      userName: 'Ada',
      openId: 'ou_ada',
      scope: ALL_SCOPES,
    })))
    const bundle = createFeishuSources({ runtime: () => runtime.asRuntime() })
    const observed: unknown[] = []
    const inspection = await bundle.connection.inspect({}, adapterContext(observed))

    expect(larkAuthStatusArgs()).toEqual(['auth', 'status', '--json'])
    expect(runtime.requests).toHaveLength(1)
    expect(runtime.requests[0]!.args).toEqual(['auth', 'status', '--json'])
    expect(runtime.requests[0]!.args).not.toContain('--verify')
    expect(runtime.requests[0]!.args).not.toContain('--dry-run')
    expect(inspection).toMatchObject({
      configuration: 'ready',
      authorization: 'ready',
      account: 'Ada',
      capabilities: ['docs.read', 'docs.search', 'tasks.read', 'tasks.edit'],
    })
  })

  it('derives capabilities from identities.user.scope instead of a ready token alone', async () => {
    const docsOnly = new FakeRuntime().enqueue(okResult(statusData({
      status: 'ready',
      tokenStatus: 'valid',
      userName: 'Ada',
      scope: DOCS_ONLY_SCOPES,
    })))
    const docsBundle = createFeishuSources({ runtime: () => docsOnly.asRuntime() })
    const docsInspection = await docsBundle.connection.inspect({}, adapterContext([]))
    expect(docsInspection.authorization).toBe('scope-insufficient')
    expect(docsInspection.capabilities).toBeUndefined()
    expect(docsInspection.detail).toMatch(/tasks\.read/)
    expect(docsInspection.detail).toMatch(/tasks\.edit/)
    expect(docsInspection.detail).toMatch(/task:task:read/)

    const noScope = new FakeRuntime().enqueue(okResult(statusData({
      status: 'ready',
      tokenStatus: 'valid',
      userName: 'Ada',
    })))
    const noScopeBundle = createFeishuSources({ runtime: () => noScope.asRuntime() })
    const noScopeInspection = await noScopeBundle.connection.inspect({}, adapterContext([]))
    expect(noScopeInspection.authorization).toBe('scope-insufficient')
    expect(noScopeInspection.detail).toMatch(/did not report the granted scopes/)

    // A comma/space-separated scope string is tolerated as well.
    const stringScopes = new FakeRuntime().enqueue(okResult(statusData({
      status: 'ready',
      tokenStatus: 'valid',
      scope: ALL_SCOPES.join(','),
    })))
    const stringBundle = createFeishuSources({ runtime: () => stringScopes.asRuntime() })
    const stringInspection = await stringBundle.connection.inspect({}, adapterContext([]))
    expect(stringInspection.authorization).toBe('ready')
    expect(stringInspection.capabilities).toEqual([
      'docs.read', 'docs.search', 'tasks.read', 'tasks.edit',
    ])

    // Some CLI versions put the scope list on `data` rather than the user.
    const dataScopes = new FakeRuntime().enqueue(okResult({
      identities: { user: { status: 'ready', tokenStatus: 'valid' } },
      scope: ALL_SCOPES,
    }))
    const dataBundle = createFeishuSources({ runtime: () => dataScopes.asRuntime() })
    const dataInspection = await dataBundle.connection.inspect({}, adapterContext([]))
    expect(dataInspection.authorization).toBe('ready')
    expect(dataInspection.capabilities).toEqual([
      'docs.read', 'docs.search', 'tasks.read', 'tasks.edit',
    ])
  })

  it('projects a docs-only grant as grant-scope with no declared capabilities', async () => {
    const runtime = new FakeRuntime().enqueue(okResult(statusData({
      status: 'ready',
      tokenStatus: 'valid',
      scope: DOCS_ONLY_SCOPES,
    })))
    const bundle = createFeishuSources({ runtime: () => runtime.asRuntime() })
    const connections = createConnectionsRuntime({ now: () => Date.parse(NOW) })
    try {
      connections.register(bundle.connection)
      const [status] = await connections.status(FEISHU_CONNECTION_ID)
      expect(status).toMatchObject({
        configuration: 'ready',
        authorization: 'scope-insufficient',
        action: 'grant-scope',
        capabilities: [],
      })
      expect(status?.detail).toMatch(/tasks\.read/)
    } finally {
      connections.dispose()
    }
  })

  it('inspect reports a missing application configuration as step one, not a login failure', async () => {
    const runtime = new FakeRuntime().enqueue(failResult({ type: 'configuration', subtype: 'not_configured' }))
    const bundle = createFeishuSources({ runtime: () => runtime.asRuntime() })
    const inspection = await bundle.connection.inspect({}, adapterContext([]))
    expect(inspection.configuration).toBe('missing')
    expect(inspection.authorization).toBe('not-authorized')
    expect(inspection.detail).toMatch(/config init/)
  })

  it('inspect distinguishes expired authorization and missing scopes', async () => {
    const expiredRuntime = new FakeRuntime().enqueue(okResult(statusData({
      status: 'expired',
      tokenStatus: 'expired',
      userName: 'Ada',
    })))
    const expired = createFeishuSources({ runtime: () => expiredRuntime.asRuntime() })
    expect((await expired.connection.inspect({}, adapterContext([]))).authorization).toBe('expired')

    const scopeRuntime = new FakeRuntime().enqueue(failResult({
      type: 'authorization',
      subtype: 'missing_scope',
      missing_scopes: ['task:task:read'],
      console_url: 'https://open.feishu.cn/app/cli_x/auth',
      message: 'raw message with Bearer secret-token',
      hint: 'raw hint',
    }))
    const scoped = createFeishuSources({ runtime: () => scopeRuntime.asRuntime() })
    const inspection = await scoped.connection.inspect({}, adapterContext([]))
    expect(inspection.configuration).toBe('ready')
    expect(inspection.authorization).toBe('scope-insufficient')
    expect(inspection.detail).toContain('https://open.feishu.cn/app/cli_x/auth')
    expect(JSON.stringify(inspection)).not.toMatch(/secret-token|raw message|raw hint/)
  })

  it('connect checks the configuration first and starts exactly the documented device flow', async () => {
    const opaque = 'https://open.feishu.cn/device/verify?user_code=AB-CD&x=%2Fkept'
    const runtime = new FakeRuntime()
      .enqueue(okResult(statusData({ status: 'not-authorized', userName: 'Ada' })))
      .enqueue(okResult({
        verification_url: opaque,
        device_code: 'device-code-secret',
        user_code: 'AB-CD',
        expires_in: 60,
        interval: 5,
      }))
    const bundle = createFeishuSources({ runtime: () => runtime.asRuntime() })
    const observed: unknown[] = []
    const start = await bundle.connection.connect!({}, adapterContext(observed))

    expect(larkAuthLoginArgs()).toEqual([
      'auth', 'login',
      '--domain', 'docs',
      '--domain', 'drive',
      '--domain', 'task',
      '--no-wait', '--json',
    ])
    expect(runtime.requests.map(request => request.args)).toEqual([
      larkAuthStatusArgs(),
      larkAuthLoginArgs(),
    ])
    expect(start.prompt?.verificationUrl).toBe(opaque)
    expect(start.prompt?.qr?.uri).toBe(opaque)
    expect(start.prompt?.userCode).toBe('AB-CD')
    expect(start.prompt?.expiresAt).toBe('2026-10-17T00:01:00.000Z')
    expect(start.prompt?.pollAfterMs).toBe(5000)
    expect(start.state).toMatchObject({ deviceCode: 'device-code-secret' })
    expect(JSON.stringify(start.prompt)).not.toMatch(/device-code-secret/)
    expect(JSON.stringify(start.inspection)).not.toMatch(/device-code-secret/)
  })

  it('connect maps a missing application config to the configure step without launching login', async () => {
    const runtime = new FakeRuntime().enqueue(
      failResult({ type: 'configuration', subtype: 'not_configured' }),
    )
    const bundle = createFeishuSources({ runtime: () => runtime.asRuntime() })
    const start = await bundle.connection.connect!({}, adapterContext([]))
    expect(start.prompt).toBeUndefined()
    expect(start.inspection).toMatchObject({ configuration: 'missing', authorization: 'not-authorized' })
    // The read-only status check is the only call: the configure/edit flow is
    // lark-cli's own terminal flow and is never faked with a login.
    expect(runtime.requests.map(request => request.args)).toEqual([larkAuthStatusArgs()])
  })

  it('poll uses the device-code verb and finishes only on a ready server answer', async () => {
    const pending = new FakeRuntime().enqueue(failResult({
      type: 'authorization',
      subtype: 'authorization_pending',
    }))
    const pendingBundle = createFeishuSources({ runtime: () => pending.asRuntime() })
    const pendingResult = await pendingBundle.connection.poll!(
      { authorizationId: 'a1', state: { deviceCode: 'dc-1' } },
      adapterContext([]),
    )
    expect(larkAuthPollArgs('dc-1')).toEqual(['auth', 'login', '--device-code', 'dc-1', '--json'])
    expect(pending.requests[0]!.args).toEqual(larkAuthPollArgs('dc-1'))
    expect(pendingResult.complete).toBe(false)
    expect(pendingResult.inspection?.authorization).toBe('authorizing')

    const ready = new FakeRuntime().enqueue(okResult({ status: 'ready', scope: ALL_SCOPES }))
    const readyBundle = createFeishuSources({ runtime: () => ready.asRuntime() })
    const readyResult = await readyBundle.connection.poll!(
      { authorizationId: 'a2', state: { deviceCode: 'dc-2' } },
      adapterContext([]),
    )
    expect(readyResult.complete).toBe(true)
    expect(readyResult.inspection?.authorization).toBe('ready')

    // A success envelope that still says pending must NOT be projected ready.
    const stillPending = new FakeRuntime().enqueue(okResult({
      status: 'authorization_pending',
      authorized: false,
    }))
    const pendingSuccessBundle = createFeishuSources({ runtime: () => stillPending.asRuntime() })
    const pendingSuccess = await pendingSuccessBundle.connection.poll!(
      { authorizationId: 'a3', state: { deviceCode: 'dc-3' } },
      adapterContext([]),
    )
    expect(pendingSuccess.complete).toBe(false)
    expect(pendingSuccess.inspection?.authorization).toBe('authorizing')

    const denied = new FakeRuntime().enqueue(okResult({ status: 'denied' }))
    const deniedBundle = createFeishuSources({ runtime: () => denied.asRuntime() })
    const deniedResult = await deniedBundle.connection.poll!(
      { authorizationId: 'a4', state: { deviceCode: 'dc-4' } },
      adapterContext([]),
    )
    expect(deniedResult.complete).toBe(true)
    expect(deniedResult.inspection?.authorization).toBe('denied')
  })

  it('cancel drops the host-side handle without inventing a CLI verb or probing again', async () => {
    const runtime = new FakeRuntime()
    const bundle = createFeishuSources({ runtime: () => runtime.asRuntime() })
    await bundle.connection.cancel!(
      { authorizationId: 'a1', state: { deviceCode: 'dc-1' } },
      adapterContext([]),
    )
    expect(runtime.requests).toHaveLength(0)
  })

  it('drives the real connection lifecycle: configure → connect → poll → ready', async () => {
    const runtime = new FakeRuntime()
      .enqueue(failResult({ type: 'configuration', subtype: 'not_configured' }))
      // First connect is still the configure step: the status check reports the
      // missing configuration and no login is launched.
      .enqueue(failResult({ type: 'configuration', subtype: 'not_configured' }))
      // After the user configured lark-cli in a terminal, the next connect sees
      // a ready app + unauthenticated user and starts the device flow.
      .enqueue(okResult(statusData({ status: 'not-authorized', userName: 'Ada' })))
      .enqueue(okResult({
        verification_url: 'https://open.feishu.cn/device?code=opaque',
        device_code: 'dc-live',
        expires_in: 120,
      }))
      .enqueue(okResult({ status: 'ready', scope: ALL_SCOPES }))
    const bundle = createFeishuSources({ runtime: () => runtime.asRuntime() })
    const connections = createConnectionsRuntime({ now: () => Date.parse(NOW) })
    try {
      connections.register(bundle.connection)

      const configured = await connections.status(FEISHU_CONNECTION_ID)
      expect(configured[0]).toMatchObject({
        configuration: 'missing',
        authorization: 'not-authorized',
        action: 'configure',
        lastCheckedAt: NOW,
      })

      const stillUnconfigured = await connections.connect(FEISHU_CONNECTION_ID)
      expect(stillUnconfigured).toMatchObject({
        configuration: 'missing',
        authorization: 'not-authorized',
        action: 'configure',
      })
      expect(stillUnconfigured.prompt).toBeUndefined()
      expect(runtime.requests).toHaveLength(2)

      const connected = await connections.connect(FEISHU_CONNECTION_ID)
      expect(connected.authorization).toBe('authorizing')
      expect(connected.prompt?.verificationUrl).toBe('https://open.feishu.cn/device?code=opaque')
      // The machine handle NEVER crosses the projection.
      expect(JSON.stringify(connected)).not.toMatch(/dc-live/)

      const polled = await connections.poll(FEISHU_CONNECTION_ID)
      expect(polled.authorization).toBe('ready')
      expect(polled.action).toBe('none')
      expect(polled.capabilities).toEqual([
        'docs.read', 'docs.search', 'tasks.read', 'tasks.edit',
      ])
    } finally {
      connections.dispose()
    }
  })
})

describe('no periodic or probing auth behaviour', () => {
  it('building the sources and reading descriptors issues zero CLI calls', () => {
    const runtime = new FakeRuntime()
    const bundle = createFeishuSources({ runtime: () => runtime.asRuntime() })
    void bundle.sources[0]!.descriptor
    void bundle.connection.configuration
    void bundle.dependency.command
    expect(runtime.requests).toHaveLength(0)
  })

  it('every status/connect/poll argv stays free of --verify, --dry-run and --page-all', async () => {
    const runtime = new FakeRuntime()
      .enqueue(okResult(statusData({ status: 'ready', tokenStatus: 'valid', scope: ALL_SCOPES })))
      // Explicit status check inside connect (configuration preflight).
      .enqueue(okResult(statusData({ status: 'ready', tokenStatus: 'valid', scope: ALL_SCOPES })))
      .enqueue(okResult({
        verification_url: 'https://open.feishu.cn/device',
        device_code: 'dc',
        expires_in: 30,
      }))
      .enqueue(okResult({ status: 'ready', scope: ALL_SCOPES }))
    const bundle = createFeishuSources({ runtime: () => runtime.asRuntime() })
    await bundle.connection.inspect({}, adapterContext([]))
    await bundle.connection.connect!({}, adapterContext([]))
    await bundle.connection.poll!({ authorizationId: 'a', state: { deviceCode: 'dc' } }, adapterContext([]))
    for (const request of runtime.requests) {
      expect(request.args).not.toContain('--verify')
      expect(request.args).not.toContain('--dry-run')
      expect(request.args).not.toContain('--page-all')
    }
  })
})
