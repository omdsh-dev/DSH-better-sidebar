/**
 * S4 Feishu adapter contract (host half, no real CLI).
 *
 * Everything here runs against a fake 'ClueRuntime' that captures the argv it
 * was handed; lark-cli is NOT installed on this host and no real account is
 * touched. The fixtures encode shortcut envelopes and the independently
 * observed native API success shape ('code:0' with object data), both with
 * exit 0. '_notice' is a notice, never an error.
 *
 * Pins: one lazily-resolved runtime (building the sources/definitions performs
 * no CLI call and does not need the runtime at all); 'inspect' runs
 * 'auth status --json' ONLY on the explicit status path - never '--verify',
 * never '--dry-run', never on a timer; 'connect' first runs the read-only
 * 'auth status' check (so a "configure" click never launches a login it cannot
 * complete), then exactly 'auth login --scope <selected union> --no-wait
 * --json'; the verification URL is forwarded as the SAME opaque string (no
 * re-encoding), the QR payload is that same string, and the device code stays
 * in the host-side 'state' (never in the prompt); 'poll' runs
 * 'auth login --device-code ... --json' for the explicit poll only, and a
 * success envelope with a pending/denied status stays pending or denied
 * instead of claiming ready; the shared connection derives its declared
 * capabilities from 'identities.user.scope', so a docs/drive-only grant
 * remains ready and does not advertise task/wiki/write capabilities; cancel
 * performs no CLI call (the CLI documents no device-code cancel verb - dropping
 * the handle is the cancellation); success needs exit 0 and a valid
 * shortcut/native envelope, so an unaccompanied code or a contradictory
 * failure cannot become an empty success; missing scopes and 'console_url'
 * survive as a safe projection, while raw messages, hints, device codes and
 * token-shaped values never do.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/clues/request-gate.ts', () => vi.importActual('./fixtures/clues-source-request-gate.ts'))
import type { ConnectionAdapterContext } from '../src/clues/runtime/index.ts'
import type { CliResult } from '../src/clues/runtime/types.ts'
import { ClueError, type JsonValue } from '../src/clues/types.ts'
import { createConnectionsRuntime } from '../src/clues/runtime/connections.ts'
import { createDependenciesRuntime } from '../src/clues/runtime/dependencies.ts'
import {
  createFeishuSources, FEISHU_CONNECTION_ID, FEISHU_DEPENDENCY_ID, FEISHU_SCOPE_ROLE, FEISHU_SOURCE_IDS,
  FEISHU_TYPE_IDS, LARK_CLI_VERSION, larkAuthLoginArgs, larkAuthPollArgs, larkAuthStatusArgs,
  parseDocsListScope, parseDocsSearchScope, parseFeishuTaskSearchScope, parseFeishuTasksScope,
} from '../src/clues/sources/feishu/index.ts'
import { reportAuthorizationFailure } from '../src/clues/sources/feishu/auth.ts'
import { classifyLarkFailure, executeLark, larkFailureError, parseLarkFailure, runLark, type LarkFailure } from '../src/clues/sources/feishu/lark.ts'
import { bareResult, cliResult, failResult, FakeLarkRuntime, okResult, statusResult } from './clues-feishu-fixture.ts'
/** The real bare auth-status answer for one user identity. */
const statusData = (user: Record<string, JsonValue>): CliResult => statusResult({ user })
const NOW = '2026-10-17T00:00:00.000Z'
const CWD = join(tmpdir(), 'dsh-feishu-adapter')
const FULL_CAPABILITIES = ['docs.read', 'docs.search', 'docs.edit', 'wiki.read', 'tasks.read', 'tasks.edit']
/** The real lark-cli 1.0.55 scope names that cover the declared capabilities. */
const ALL_SCOPES = [
  'docx:document', 'docs:document.content:read', 'drive:drive:readonly', 'drive:drive.metadata:readonly',
  'space:document:retrieve', 'search:docs:read', 'wiki:node:retrieve', 'wiki:space:retrieve',
  'task:task:read', 'task:task:write',
]
/** A docs/drive-only grant: no task or wiki scope was authorized. */
const DOCS_ONLY_SCOPES = [
  'docs:document.content:read', 'drive:drive:readonly', 'drive:drive.metadata:readonly',
  'drive:drive.search:readonly', 'space:document:retrieve',
]
const DOCS_READ_SCOPES = [
  'docx:document:readonly', 'docs:document.content:read', 'drive:drive:readonly',
  'drive:drive.metadata:readonly', 'space:document:retrieve', 'search:docs:read',
]
function adapterContext(observed: unknown[] = []): ConnectionAdapterContext {
  return { now: () => NOW, resolveCredential: async () => undefined, report: value => { observed.push(value) } }
}
function bundleWith(...answers: CliResult[]) {
  const runtime = new FakeLarkRuntime().enqueue(...answers)
  return { runtime, bundle: createFeishuSources({ runtime: () => runtime.asRuntime() }) }
}
async function inspectAnswer(answer: CliResult) {
  return bundleWith(answer).bundle.connection.inspect({}, adapterContext())
}
async function pollAnswer(answer: CliResult, deviceCode = 'dc') {
  const { runtime, bundle } = bundleWith(answer)
  const result = await bundle.connection.poll!({ authorizationId: 'a', state: { deviceCode } }, adapterContext())
  return { runtime, result }
}
async function larkRun(answer: CliResult, args: string[] = ['x']) {
  return runLark({ runtime: new FakeLarkRuntime().enqueue(answer).asRuntime(), args, cwd: CWD })
}

describe('explicit minimal authorization scopes', () => {
  it('defaults to document read/search without requesting write, tasks or wiki', () => {
    const args = larkAuthLoginArgs()
    expect(args).not.toContain('--domain')
    const scopes = args[args.indexOf('--scope') + 1]!.split(' ')
    expect(scopes).toEqual(expect.arrayContaining(['docx:document:readonly', 'drive:drive:readonly', 'search:docs:read']))
    expect(scopes).not.toContain('docx:document')
    expect(scopes.some(scope => /^(task|wiki):/.test(scope))).toBe(false)
  })
  it('requests only the selected task capability with one exact scope argument', () => {
    const args = larkAuthLoginArgs(['tasks.read'])
    expect(args.filter(arg => arg === '--scope')).toHaveLength(1)
    expect(args[args.indexOf('--scope') + 1]).toBe('task:task:read')
    expect(args).not.toContain('--domain')
  })
})

describe('createFeishuSources: lazy runtime and shared definitions', () => {
  it('builds registrations, dependency and two-step connection without touching the runtime', () => {
    const bundle = createFeishuSources({ runtime: () => { throw new Error('lazy runtime') } })
    expect(bundle.registrations).toHaveLength(2)
    expect(bundle.dependencyIds).toEqual([FEISHU_DEPENDENCY_ID])
    expect(bundle.connectionId).toBe(FEISHU_CONNECTION_ID)
    expect(bundle.typeIds).toEqual([FEISHU_TYPE_IDS.docx, FEISHU_TYPE_IDS.wiki, FEISHU_TYPE_IDS.task])
    expect(bundle.registrations.map(source => source.descriptor.sourceId)).toEqual([FEISHU_SOURCE_IDS.docs, FEISHU_SOURCE_IDS.tasks])
    expect(bundle.registrations.map(source => source.descriptor.types)).toEqual([[FEISHU_TYPE_IDS.docx, FEISHU_TYPE_IDS.wiki], [FEISHU_TYPE_IDS.task]])
    // One shared CLI dependency and ONE shared authorization connection.
    for (const source of bundle.registrations) {
      expect(source.descriptor).toMatchObject({
        transport: 'cli', dependencyIds: [FEISHU_DEPENDENCY_ID], connectionId: FEISHU_CONNECTION_ID, pluginId: 'dsh-better-sidebar',
      })
      expect(source.descriptor.capabilities.edit).toBe(true)
    }
    // The docs type is block-scoped editable; complex containers stay read-only.
    const docsType = bundle.registrations[0]!.types[0]!
    expect(docsType.capabilities).toMatchObject({ read: true, edit: true, concurrency: 'check-before-save' })
    const extensions = JSON.stringify(docsType.extensions)
    expect(extensions).toMatch(/text blocks/i)
    expect(extensions).toMatch(/read-only/i)
    expect(extensions).not.toMatch(/no lossless/i)
    // Two-step connection: required app config, tool-owned credential.
    expect(bundle.connection).toMatchObject({ connectionId: FEISHU_CONNECTION_ID, configuration: 'required', credentialOwner: 'tool' })
    expect(bundle.connection.capabilities).toEqual(expect.arrayContaining(['docs.read', 'docs.search', 'tasks.read', 'tasks.edit']))
    for (const verb of ['inspect', 'connect', 'poll', 'cancel'] as const) expect(typeof bundle.connection[verb]).toBe('function')
  })
  it('installs the official native archive per target (no npm postinstall shim)', async () => {
    const dependency = createFeishuSources({ runtime: () => { throw new Error('lazy') } }).dependency
    expect(dependency.dependencyId).toBe(FEISHU_DEPENDENCY_ID)
    expect(dependency.command).toBe('lark-cli')
    expect(dependency.version).toEqual({ minimum: LARK_CLI_VERSION, recommended: LARK_CLI_VERSION })
    expect(dependency.supportedPlatforms.length).toBeGreaterThan(0)
    expect(dependency.manualInstall?.instructions).toBeTruthy()
    const distributions = dependency.install?.distributions ?? []
    expect(distributions).toHaveLength(dependency.supportedPlatforms.length)
    for (const distribution of distributions) {
      // @larksuite/cli is a downloader shim; managed installs use the official archive + sha256.
      expect(distribution).toMatchObject({ kind: 'archive', source: 'GitHub releases' })
      expect(distribution.url).toMatch(/^https:\/\/github\.com\/larksuite\/cli\/releases\/download\/v1\.0\.55\//)
      expect(distribution.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(distribution.archive).toMatch(/^(zip|tar\.gz)$/)
      expect(distribution.executable).toMatch(/^lark-cli(?:\.exe)?$/)
      expect(distribution.runScripts).toBeUndefined()
      expect(distribution.platforms).toHaveLength(1)
    }
    expect(distributions.find(d => d.platforms?.some(t => t.platform === 'win32')))
      .toMatchObject({ archive: 'zip', executable: 'lark-cli.exe' })
    expect(distributions.find(d => d.platforms?.some(t => t.platform === 'darwin' && t.arch === 'arm64')))
      .toMatchObject({ archive: 'tar.gz', executable: 'lark-cli', sha256: 'd2e3d8cf0b055144606904b503ae1379e3d50a6dac90b0643912fd2e9072c1f2' })
    // The real S2 dependency registry accepts the definition and plans the archive pipeline.
    const dependencies = createDependenciesRuntime({
      home: CWD, platform: 'darwin', arch: 'arm64', env: { PATH: '' },
      runProcess: { run: async () => cliResult({ exitCode: 1, stderr: 'missing' }), runJson: async () => { throw new Error('unused') } },
      now: () => Date.parse(NOW),
    })
    try {
      const dispose = dependencies.register(dependency)
      expect(dependencies.getDefinition(FEISHU_DEPENDENCY_ID)?.command).toBe('lark-cli')
      const plan = await dependencies.plan(FEISHU_DEPENDENCY_ID)
      expect(plan).toMatchObject({
        dependencyId: FEISHU_DEPENDENCY_ID, version: LARK_CLI_VERSION, platform: 'darwin', arch: 'arm64', installable: true,
        distribution: { kind: 'archive', archive: 'tar.gz', sha256: 'd2e3d8cf0b055144606904b503ae1379e3d50a6dac90b0643912fd2e9072c1f2' },
        executablePath: join(CWD, 'tools', FEISHU_DEPENDENCY_ID, LARK_CLI_VERSION, 'lark-cli'),
      })
      expect(plan.actionIds).toEqual(['download-archive', 'verify-sha256', 'extract-archive', 'probe-version', 'replace-managed-copy'])
      dispose()
    } finally { dependencies.dispose() }
  })
})

describe('lark envelope adapter', () => {
  it('accepts success only from exit 0 plus a valid shortcut/native envelope', async () => {
    await expect(larkRun(okResult({ value: 1 }))).resolves.toMatchObject({ data: { value: 1 } })
    const data = { items: [{ guid: 'task-native-1', summary: 'Native task' }], has_more: false }
    await expect(larkRun(cliResult({ stdout: JSON.stringify({ code: 0, data, msg: '' }) }), ['task', 'tasks', 'list'])).resolves.toMatchObject({ data })
    // code==0 without data is neither a success nor a classified failure.
    const legacy = await executeLark({
      runtime: new FakeLarkRuntime().enqueue(cliResult({ stdout: JSON.stringify({ code: 0, msg: 'ok' }) })).asRuntime(),
      args: ['x'], cwd: CWD,
    })
    expect(legacy.success).toBeUndefined()
    expect(legacy.failure).toBeUndefined()
    const rejected = [
      { exitCode: 1, stdout: JSON.stringify({ ok: true, data: { value: 1 } }) },
      { exitCode: 0, stdout: JSON.stringify({ ok: false, error: { type: 'unknown' } }) },
      { exitCode: 1, stdout: JSON.stringify({ code: 0, data }) },
      { exitCode: 0, stdout: JSON.stringify({ code: 100, data }) },
      { exitCode: 0, stdout: JSON.stringify({ code: 0, data: [] }) },
      { exitCode: 0, stdout: JSON.stringify({ code: 0, data: null }) },
      { exitCode: 0, stdout: JSON.stringify({ ok: false, code: 0, data }) },
      { exitCode: 0, stdout: JSON.stringify({ code: 0, error: { type: 'unknown' }, data }) },
      { exitCode: 0, stdout: JSON.stringify({ code: 0, msg: 'ok' }) },
      { exitCode: 0, stdout: '' },
    ]
    for (const response of rejected) {
      await expect(larkRun(cliResult(response))).rejects.toMatchObject({ category: 'failed' })
    }
  })
  it('accepts the real bare auth status object only when the auth calls opt in', async () => {
    const bare = { appId: 'cli_test', identities: { user: { status: 'ready' } } }
    const generic = await executeLark({ runtime: new FakeLarkRuntime().enqueue(bareResult(bare)).asRuntime(), args: ['x'], cwd: CWD })
    expect(generic.success).toBeUndefined()
    const authed = await executeLark({
      runtime: new FakeLarkRuntime().enqueue(bareResult(bare)).asRuntime(), args: ['auth', 'status', '--json'], cwd: CWD, bareSuccess: true,
    })
    expect(authed.success?.data).toEqual(bare)
    expect(authed.success?.envelope).toEqual(bare)
  })
  it('reads failures only from stderr and tolerates notice/prefix lines', async () => {
    const failed = new FakeLarkRuntime().enqueue(cliResult({
      exitCode: 1,
      stdout: JSON.stringify({ ok: true, data: { should: 'not be read' } }),
      stderr: JSON.stringify({
        ok: false, error: { type: 'not_found', subtype: 'resource_missing', code: 404 },
        _notice: { update: { message: 'a new version exists' } },
      }),
    }))
    const outcome = await executeLark({ runtime: failed.asRuntime(), args: ['x'], cwd: CWD })
    expect(outcome.success).toBeUndefined()
    expect(classifyLarkFailure(outcome.failure!)).toBe('not-found')
    expect(JSON.stringify(outcome.failure)).not.toMatch(/new version|should|not be read/)
    const stdoutLines = [
      '{"ok":true,"identity":"user","data":{"value":"kept"},"_notice":{"update":{"message":"new"}}}',
      '_notice: a newer lark-cli exists\n{"ok":true,"identity":"user","data":{"value":"kept"}}',
      '{"_notice":{"update":{"message":"new"}}}\n{"ok":true,"data":{"value":"kept"}}',
    ]
    for (const stdout of stdoutLines) {
      expect((await larkRun(cliResult({ stdout }))).data).toEqual({ value: 'kept' })
    }
  })
  it('maps failure classes and keeps raw messages, hints and secrets out of the error', () => {
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
    for (const [failure, expected] of cases) expect(classifyLarkFailure(failure), JSON.stringify(failure)).toBe(expected)
    const error = larkFailureError({
      type: 'authorization', subtype: 'missing_scope', code: 99991679,
      missingScopes: ['docx:document:read', 'drive:drive:read'],
      consoleUrl: 'https://open.feishu.cn/app/cli_x/auth?q=scope&op=1',
    })
    expect(error.category).toBe('auth-required')
    expect(error.message).not.toMatch(/super-secret|dc_secret/)
    // The wire only carries { code, message }, so the actionable detail must be in the message as well as the meta.
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
        type: 'authorization', subtype: 'missing_scope', code: 99991679,
        message: 'raw message with Bearer super-secret-token', hint: 'raw hint with device_code=dc_secret',
        missing_scopes: ['ok:scope', 'bad scope with spaces', 'x'.repeat(300)],
        console_url: 'javascript:alert(1)', device_code: 'dc_secret',
      },
    }))
    expect(failure).toBeDefined()
    expect(failure!.missingScopes).toEqual(['ok:scope'])
    expect(failure!.consoleUrl).toBeUndefined()
    expect(JSON.stringify(failure)).not.toMatch(/super-secret|dc_secret|raw message|raw hint/)
    expect(larkFailureError(failure!).meta?.missingScopes).toBe('ok:scope')
  })
  it('passes the dependency id, absolute cwd, budget and notifier-free env', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({}))
    await runLark({ runtime: runtime.asRuntime(), args: ['auth', 'status', '--json'], cwd: CWD })
    expect(runtime.requests[0]).toMatchObject({
      dependencyId: FEISHU_DEPENDENCY_ID, cwd: CWD,
      env: { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
    })
    expect(runtime.requests[0]!.timeoutMs).toBeGreaterThan(0)
  })
})

describe('resource authorization observations', () => {
  it('publishes a sanitized unknown state for permission denial without a console URL', () => {
    const runtime = new FakeLarkRuntime()
    reportAuthorizationFailure(runtime.asRuntime(), new ClueError('permission-denied', 'resource denied'))
    expect(runtime.reports).toEqual([{
      connectionId: FEISHU_CONNECTION_ID,
      inspection: { configuration: 'ready', authorization: 'unknown', detail: 'The Feishu account cannot access this resource.' },
    }])
  })
})

describe('connection adapter: explicit status and two-step authorization', () => {
  it('inspect runs auth status --json only', async () => {
    const { runtime, bundle } = bundleWith(statusData({
      status: 'ready', tokenStatus: 'valid', userName: 'Ada', openId: 'ou_ada', scope: ALL_SCOPES,
    }))
    const inspection = await bundle.connection.inspect({}, adapterContext())
    expect(larkAuthStatusArgs()).toEqual(['auth', 'status', '--json'])
    expect(runtime.requests.map(request => request.args)).toEqual([larkAuthStatusArgs()])
    expect(inspection).toMatchObject({ configuration: 'ready', authorization: 'ready', account: 'Ada', capabilities: FULL_CAPABILITIES })
  })
  it('maps a missing app configuration to the configure step without launching login', async () => {
    for (const answer of [
      statusResult({ bot: { status: 'not_configured', message: 'Bot identity: not configured (missing app config)' } }),
      failResult({ type: 'configuration', subtype: 'not_configured' }),
    ]) {
      const inspection = await inspectAnswer(answer)
      expect(inspection).toMatchObject({ configuration: 'missing', authorization: 'not-authorized' })
      expect(inspection.detail).toMatch(/config init/)
    }
    const { runtime, bundle } = bundleWith(failResult({ type: 'configuration', subtype: 'not_configured' }))
    const start = await bundle.connection.connect!({}, adapterContext())
    expect(start.prompt).toBeUndefined()
    expect(start.inspection).toMatchObject({ configuration: 'missing', authorization: 'not-authorized' })
    expect(runtime.requests.map(request => request.args)).toEqual([larkAuthStatusArgs()])
  })
  it('derives capabilities from identities.user.scope instead of a ready token alone', async () => {
    const cases: Array<[string, CliResult, string, string[]]> = [
      ['wiki-only', statusData({ status: 'ready', tokenStatus: 'valid', scope: ['wiki:node:read', 'wiki:space:read'] }), 'ready', ['wiki.read']],
      ['docs content + drive', statusData({ status: 'ready', tokenStatus: 'valid', scope: DOCS_READ_SCOPES }), 'ready', ['docs.read', 'docs.search']],
      ['task wildcard', statusData({ status: 'ready', tokenStatus: 'valid', scope: ['task:task'] }), 'ready', ['tasks.read', 'tasks.edit']],
      ['content without drive', statusData({ status: 'ready', tokenStatus: 'valid', scope: ['docx:document:readonly', 'docs:document.content:read', 'search:docs:read'] }), 'ready', ['docs.search']],
      ['drive without content', statusData({ status: 'ready', tokenStatus: 'valid', scope: ['drive:drive:readonly', 'drive:drive.metadata:readonly', 'space:document:retrieve', 'search:docs:read'] }), 'ready', ['docs.search']],
      ['comma-separated scopes', statusData({ status: 'ready', tokenStatus: 'valid', scope: ALL_SCOPES.join(',') }), 'ready', FULL_CAPABILITIES],
      ['scopes on data', okResult({ identities: { user: { status: 'ready', tokenStatus: 'valid' } }, scope: ALL_SCOPES }), 'ready', FULL_CAPABILITIES],
    ]
    for (const [label, answer, authorization, capabilities] of cases) {
      const inspection = await inspectAnswer(answer)
      expect(inspection.authorization, label).toBe(authorization)
      expect(inspection.capabilities, label).toEqual(capabilities)
    }
    const noScope = await inspectAnswer(statusData({ status: 'ready', tokenStatus: 'valid', userName: 'Ada' }))
    expect(noScope.authorization).toBe('scope-insufficient')
    expect(noScope.detail).toMatch(/did not report the granted scopes/)
  })
  it('treats lark-cli needs_refresh as authorized and surfaces the account', async () => {
    const inspection = await inspectAnswer(statusData({ status: 'needs_refresh', tokenStatus: 'needs_refresh', userName: 'Ada', scope: ALL_SCOPES }))
    expect(inspection).toMatchObject({ authorization: 'ready', account: 'Ada' })
  })
  it('projects a docs-only grant as ready with only the permissions actually granted', async () => {
    const { bundle } = bundleWith(statusData({ status: 'ready', tokenStatus: 'valid', scope: DOCS_ONLY_SCOPES }))
    const connections = createConnectionsRuntime({ now: () => Date.parse(NOW) })
    try {
      connections.register(bundle.connection)
      const [status] = await connections.status(FEISHU_CONNECTION_ID)
      expect(status).toMatchObject({
        configuration: 'ready', authorization: 'ready', action: 'none', capabilities: ['docs.read', 'docs.search'],
      })
      expect(status?.detail).toBeUndefined()
      expect(status?.selectableCapabilities).toContain('tasks.read')
    } finally { connections.dispose() }
  })
  it('distinguishes expired authorization from missing scopes', async () => {
    const expired = await inspectAnswer(statusData({ status: 'expired', tokenStatus: 'expired', userName: 'Ada' }))
    expect(expired.authorization).toBe('expired')
    const scoped = await inspectAnswer(failResult({
      type: 'authorization', subtype: 'missing_scope', missing_scopes: ['task:task:read'],
      console_url: 'https://open.feishu.cn/app/cli_x/auth',
      message: 'raw message with Bearer secret-token', hint: 'raw hint',
    }))
    expect(scoped).toMatchObject({ configuration: 'ready', authorization: 'scope-insufficient' })
    expect(scoped.detail).toContain('https://open.feishu.cn/app/cli_x/auth')
    expect(JSON.stringify(scoped)).not.toMatch(/secret-token|raw message|raw hint/)
  })
  it('connect checks the configuration first and starts exactly the documented device flow', async () => {
    const opaque = 'https://open.feishu.cn/device/verify?user_code=AB-CD&x=%2Fkept'
    const { runtime, bundle } = bundleWith(
      statusData({ status: 'not-authorized', userName: 'Ada' }),
      okResult({ verification_url: opaque, device_code: 'device-code-secret', user_code: 'AB-CD', expires_in: 60, interval: 5 }),
    )
    const start = await bundle.connection.connect!({}, adapterContext())
    expect(larkAuthLoginArgs()).toEqual([
      'auth', 'login',
      '--scope', 'docx:document:readonly docs:document.content:read drive:drive:readonly drive:drive.metadata:readonly space:document:retrieve search:docs:read',
      '--no-wait', '--json',
    ])
    expect(runtime.requests.map(request => request.args)).toEqual([larkAuthStatusArgs(), larkAuthLoginArgs()])
    expect(start.prompt).toMatchObject({ verificationUrl: opaque, userCode: 'AB-CD', expiresAt: '2026-10-17T00:01:00.000Z', pollAfterMs: 5000 })
    expect(start.prompt?.qr?.uri).toBe(opaque)
    expect(start.state).toMatchObject({ deviceCode: 'device-code-secret' })
    expect(JSON.stringify(start.prompt)).not.toMatch(/device-code-secret/)
    expect(JSON.stringify(start.inspection)).not.toMatch(/device-code-secret/)
  })
  it('poll uses the device-code verb and finishes only on a ready server answer', async () => {
    const pending = await pollAnswer(failResult({ type: 'authorization', subtype: 'authorization_pending' }), 'dc-1')
    expect(larkAuthPollArgs('dc-1')).toEqual(['auth', 'login', '--device-code', 'dc-1', '--json'])
    expect(pending.runtime.requests.map(request => request.args)).toEqual([larkAuthPollArgs('dc-1')])
    expect(pending.result).toMatchObject({ complete: false })
    expect(pending.result.inspection?.authorization).toBe('authorizing')
    const ready = await pollAnswer(okResult({ status: 'ready', scope: ALL_SCOPES }), 'dc-2')
    expect(ready.result).toMatchObject({ complete: true })
    expect(ready.result.inspection?.authorization).toBe('ready')
    // A success envelope that still says pending/denied must NOT claim ready.
    const stillPending = await pollAnswer(okResult({ status: 'authorization_pending', authorized: false }), 'dc-3')
    expect(stillPending.result).toMatchObject({ complete: false })
    expect(stillPending.result.inspection?.authorization).toBe('authorizing')
    const denied = await pollAnswer(okResult({ status: 'denied' }), 'dc-4')
    expect(denied.result).toMatchObject({ complete: true })
    expect(denied.result.inspection?.authorization).toBe('denied')
  })
  it('reads the exit-3 stdout completion and reports scope-insufficient', async () => {
    const cases: Array<[Record<string, JsonValue>, RegExp]> = [
      [{
        event: 'authorization_complete', user_open_id: 'ou_user', user_name: 'Ada', scope: 'docx:document:readonly',
        requested: ['docx:document:read', 'task:task:read'], newly_granted: ['docx:document:readonly'], already_granted: [],
        missing: ['docx:document:read', 'task:task:read'], granted: ['docx:document:readonly'],
        warning: { type: 'missing_scope', hint: 'raw hint that must not leak' },
      }, /docx:document:read[\s\S]*task:task:read/],
      // The nested authorization_complete spelling is tolerated too (older/proxied shapes), not the real wire.
      [{ authorization_complete: { warning: 'some scopes were not granted', missing: ['drive:drive:readonly'] } }, /drive:drive:readonly/],
    ]
    for (const [payload, detail] of cases) {
      const { result } = await pollAnswer(cliResult({ exitCode: 3, stdout: JSON.stringify(payload) }), 'dc-scope')
      expect(result.complete).toBe(true)
      expect(result.inspection).toMatchObject({ configuration: 'ready', authorization: 'scope-insufficient' })
      expect(result.inspection?.detail).toMatch(detail)
      expect(JSON.stringify(result)).not.toMatch(/raw hint/)
    }
  })
  it('maps authorization_failed denial/expiry (JSON and text) to terminal states', async () => {
    const cases: Array<[CliResult, 'denied' | 'expired']> = [
      [cliResult({ exitCode: 3, stdout: JSON.stringify({ event: 'authorization_failed', error: 'authorization failed: access_denied' }) }), 'denied'],
      [cliResult({ exitCode: 3, stdout: JSON.stringify({ event: 'authorization_failed', error: 'authorization failed: expired_token' }) }), 'expired'],
      [failResult({ type: 'authentication', subtype: 'unknown', message: 'authorization failed: access_denied' }, 3), 'denied'],
      [failResult({ type: 'authentication', subtype: 'unknown', message: 'authorization failed: expiration reached' }, 3), 'expired'],
      [failResult({ type: 'authentication', subtype: 'unknown', message: 'authorization failed: The device_code is invalid. Please restart the device authorization flow.' }, 3), 'expired'],
    ]
    for (const [answer, expected] of cases) {
      const { result } = await pollAnswer(answer)
      expect(result.complete).toBe(true)
      expect(result.inspection?.authorization).toBe(expected)
      expect(JSON.stringify(result)).not.toMatch(/access_denied|expiration reached|device_code is invalid/)
    }
  })
  it('accepts bare login/poll payloads from the same auth family', async () => {
    const { bundle } = bundleWith(
      statusData({ status: 'not-authorized', userName: 'Ada' }),
      bareResult({ verification_url: 'https://open.feishu.cn/device?bare=1', device_code: 'dc-bare', expires_in: 60 }),
      bareResult({ status: 'ready', scope: ALL_SCOPES }),
    )
    const start = await bundle.connection.connect!({}, adapterContext())
    expect(start.prompt?.verificationUrl).toBe('https://open.feishu.cn/device?bare=1')
    expect(JSON.stringify(start.state)).toMatch(/dc-bare/)
    const polled = await bundle.connection.poll!({ authorizationId: 'a-bare', state: { deviceCode: 'dc-bare' } }, adapterContext())
    expect(polled).toMatchObject({ complete: true })
    expect(polled.inspection?.authorization).toBe('ready')
  })
  it('cancel drops the host-side handle without inventing a CLI verb', async () => {
    const { runtime, bundle } = bundleWith()
    await bundle.connection.cancel!({ authorizationId: 'a1', state: { deviceCode: 'dc-1' } }, adapterContext())
    expect(runtime.requests).toHaveLength(0)
  })
  it('drives the real connection lifecycle: configure -> connect -> poll -> ready', async () => {
    const { runtime, bundle } = bundleWith(
      failResult({ type: 'configuration', subtype: 'not_configured' }),
      // First connect is still the configure step: no login is launched.
      failResult({ type: 'configuration', subtype: 'not_configured' }),
      // After the user configured lark-cli, the next connect starts the device flow.
      statusData({ status: 'not-authorized', userName: 'Ada' }),
      okResult({ verification_url: 'https://open.feishu.cn/device?code=opaque', device_code: 'dc-live', expires_in: 120 }),
      okResult({ status: 'ready', scope: ALL_SCOPES }),
    )
    const connections = createConnectionsRuntime({ now: () => Date.parse(NOW) })
    try {
      connections.register(bundle.connection)
      const configured = await connections.status(FEISHU_CONNECTION_ID)
      expect(configured[0]).toMatchObject({
        configuration: 'missing', authorization: 'not-authorized', action: 'configure', lastCheckedAt: NOW,
      })
      const stillUnconfigured = await connections.connect(FEISHU_CONNECTION_ID)
      expect(stillUnconfigured).toMatchObject({ configuration: 'missing', action: 'configure' })
      expect(stillUnconfigured.prompt).toBeUndefined()
      expect(runtime.requests).toHaveLength(2)
      const connected = await connections.connect(FEISHU_CONNECTION_ID)
      expect(connected.authorization).toBe('authorizing')
      expect(connected.prompt?.verificationUrl).toBe('https://open.feishu.cn/device?code=opaque')
      // The machine handle NEVER crosses the projection.
      expect(JSON.stringify(connected)).not.toMatch(/dc-live/)
      const polled = await connections.poll(FEISHU_CONNECTION_ID)
      expect(polled).toMatchObject({ authorization: 'ready', action: 'none', capabilities: FULL_CAPABILITIES })
      // Every status/connect/poll argv stays free of probing flags.
      for (const request of runtime.requests) {
        expect(request.args).not.toContain('--verify')
        expect(request.args).not.toContain('--dry-run')
        expect(request.args).not.toContain('--page-all')
      }
    } finally { connections.dispose() }
  })
})

describe('S9 range-picker contract', () => {
  it('exports the docs/task list+search scope parsers and the scope role marker', () => {
    expect(FEISHU_SCOPE_ROLE).toBe('scope')
    expect(parseDocsListScope({ kind: 'drive', folderToken: 'fldX' })).toEqual({ kind: 'drive', folderToken: 'fldX' })
    expect(parseDocsListScope({ kind: 'wiki', spaceId: 'my_library', parentNodeToken: 'wikcnN' }))
      .toEqual({ kind: 'wiki', spaceId: 'my_library', parentNodeToken: 'wikcnN' })
    expect(parseDocsSearchScope({ kind: 'drive', folderToken: 'fldX' })).toEqual({ kind: 'drive', folderToken: 'fldX' })
    expect(parseFeishuTasksScope({ kind: 'tasks', tasklistGuid: 'tl-1', completed: false }))
      .toEqual({ kind: 'tasks', tasklistGuid: 'tl-1', completed: false })
    expect(parseFeishuTaskSearchScope({ kind: 'tasks', assignee: 'ou_a', due: '-1d,+7d' }))
      .toEqual({ kind: 'tasks', assignee: 'ou_a', due: '-1d,+7d' })
    expect(() => parseDocsListScope(undefined)).toThrow(/explicit browsing range/)
    expect(() => parseDocsSearchScope({ kind: 'drive-root' })).toThrow(/Drive folder or a wiki space/)
  })
})

describe('selected permissions through the device flow', () => {
  function startResult() {
    return bareResult({ verification_uri_complete: 'https://example.invalid/device', device_code: 'fixture-only', expires_in: 60 })
  }
  it('completes a task-only request without claiming document, wiki or write access', async () => {
    const { runtime, bundle } = bundleWith(
      statusData({ status: 'ready', scope: [] }),
      startResult(),
      bareResult({ event: 'authorization_complete' }),
    )
    const context = adapterContext()
    const start = await bundle.connection.connect!({ capabilities: ['tasks.read'] }, context)
    expect(runtime.requests[1]?.args).toEqual(['auth', 'login', '--scope', 'task:task:read', '--no-wait', '--json'])
    const result = await bundle.connection.poll!({ authorizationId: 'a', state: start.state }, context)
    expect(result.inspection).toMatchObject({ authorization: 'ready', capabilities: ['tasks.read'] })
  })
  it('keeps the approved read subset ready after exit-3 refuses optional search scope', async () => {
    const { bundle } = bundleWith(
      statusData({ status: 'ready', scope: [] }),
      startResult(),
      cliResult({ exitCode: 3, stdout: JSON.stringify({ event: 'authorization_complete', missing: ['search:docs:read'], warning: 'missing_scope' }) }),
    )
    const context = adapterContext()
    const start = await bundle.connection.connect!({ capabilities: ['docs.read', 'docs.search'] }, context)
    const result = await bundle.connection.poll!({ authorizationId: 'a', state: start.state }, context)
    expect(result.inspection).toMatchObject({ authorization: 'ready', capabilities: ['docs.read'] })
    // Declining search must not be undone by ordinary drive read/metadata scopes.
    expect(result.inspection?.capabilities).not.toContain('docs.edit')
    expect(result.inspection?.capabilities).not.toContain('tasks.read')
  })
})
