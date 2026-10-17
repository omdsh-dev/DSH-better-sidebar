/**
 * The shared lark-cli dependency and the shared Feishu authorization
 * connection (S4).
 *
 * Both Feishu sources ride ONE CLI dependency and ONE connection. The
 * connection is two independent facts: whether the lark-cli application is
 * configured, and whether THIS user has authorized it. Nothing here stores an
 * appSecret, token or device code; lark-cli owns its credential store and
 * renewal, and the machine handle only lives in the in-memory authorization
 * session owned by S2.
 *
 * Explicit actions only:
 * - `inspect` (called by an explicit connection-status request) runs
 *   `lark-cli auth status --json` — never `--verify`, never `--dry-run`, and
 *   never on a timer/health check. dry-run previously triggered auth side
 *   effects, and the approved spec forbids periodic verification probes;
 * - `connect` (called by an explicit click) first checks the configuration with
 *   the read-only status verb (so a "configure" step never launches a login it
 *   cannot complete), then runs exactly
 *   `lark-cli auth login --domain docs --domain drive --domain task --domain
 *   wiki --no-wait --json` and projects the opaque verification URL / user
 *   code. The QR payload is the SAME opaque string (no re-encoding). The task
 *   domain is part of the union so a docs-only login can never leave the tasks
 *   capability unusable; `wiki` is a SEPARATE auth domain in lark-cli 1.0.55
 *   (the docs/drive domains do not include the `wiki:*` scopes), and the docs
 *   source calls the wiki shortcuts, so it is part of the requested union;
 * - `poll` runs `lark-cli auth login --device-code <host-side code> --json` on
 *   explicit request only. lark-cli 1.0.55 writes the terminal
 *   `authorization_complete` object to STDOUT with exit 3 when the user
 *   approved only some scopes (stderr may be empty), so the poll projects that
 *   completion before falling back to the stderr failure envelope;
 * - `cancel` drops the host-side handle. lark-cli documents no device-code
 *   cancel verb, so no CLI command is fabricated; the code expires on the
 *   server and the next connect starts a fresh flow.
 *
 * Configuration caveat: lark-cli's own application setup (`config init --new`)
 * prints a verification URL and then BLOCKS until the browser flow finishes.
 * The S2 runtime exposes only a buffered run-to-exit call (`runCli` returns
 * stdout after the child exits), so the adapter cannot stream that URL back to
 * the settings row, and killing the process at a timeout would abort the
 * configuration it started. Driving this in-app needs an S2 long-lived-process
 * seam; until then the "configure" step surfaces the CLI's own instruction
 * instead of collecting an appSecret or spawning a blind background process.
 * Re-running it is always an explicit user choice.
 */
import type {
  ConnectionConnectStart,
  ConnectionInspection,
  ConnectionPollResult,
} from '../../runtime/types.ts'
import type {
  ClueConnectionDefinition,
  ClueDependencyDefinition,
  ClueRuntime,
  ConnectionAdapterContext,
  DependencyDistribution,
  DependencyTarget,
  ConnectionCancelInput,
} from '../../runtime/types.ts'
import { ClueError, type JsonValue } from '../../types.ts'
import {
  FEISHU_CONNECTION_CAPABILITIES,
  FEISHU_CONNECTION_ID,
  FEISHU_CLI_COMMAND,
  FEISHU_DEPENDENCY_ID,
  FEISHU_PLUGIN_ID,
  isRecord,
  LARK_CLI_PACKAGE,
  LARK_CLI_VERSION,
  stringOf,
} from './format.ts'
import {
  capabilitiesForScopes,
  grantedScopesOf,
  missingConfigurationInspection,
  missingConnectionCapabilities,
  missingScopesDetail,
} from './auth.ts'
import {
  classifyLarkFailure,
  executeLark,
  larkFailureError,
  larkScopeDetail,
  LARK_AUTH_POLL_TIMEOUT_MS,
  LARK_CLI_ENV,
  type LarkCompletion,
  type LarkFailure,
  type LarkSuccess,
} from './lark.ts'

/** The auth-status argv (explicit status only; no `--verify`). */
export function larkAuthStatusArgs(): string[] {
  return ['auth', 'status', '--json']
}

/** The explicit authorization-start argv fixed by the shared contract. */
export function larkAuthLoginArgs(): string[] {
  return [
    'auth', 'login',
    '--domain', 'docs',
    '--domain', 'drive',
    '--domain', 'task',
    '--domain', 'wiki',
    '--no-wait', '--json',
  ]
}

/**
 * The explicit device-code completion argv. The code is passed as one argv
 * element (never through a shell string) and is never projected/logged.
 */
export function larkAuthPollArgs(deviceCode: string): string[] {
  return ['auth', 'login', '--device-code', deviceCode, '--json']
}

/** Manual guidance for a host where managed installation is not used. */
const MANUAL_INSTALL = {
  instructions:
    'Install the official lark-cli so `lark-cli` is on PATH '
    + `(\`npm install -g ${LARK_CLI_PACKAGE}@${LARK_CLI_VERSION}\`), or configure an explicit executable path in the settings.`,
  url: `https://www.npmjs.com/package/${LARK_CLI_PACKAGE}`,
} as const

/** One official native archive of the pinned CLI release. */
interface LarkArchive {
  readonly platform: 'darwin' | 'linux' | 'win32'
  readonly arch: 'x64' | 'arm64'
  /** GitHub release asset platform segment. */
  readonly releasePlatform: 'darwin' | 'linux' | 'windows'
  /** GitHub release asset architecture segment. */
  readonly releaseArch: 'amd64' | 'arm64'
  readonly archive: 'zip' | 'tar.gz'
  /** `lark-cli` on POSIX, `lark-cli.exe` in the Windows zip. */
  readonly executable: string
  /** Official sha256 (the `checksums.txt` shipped inside @larksuite/cli@1.0.55). */
  readonly sha256: string
}

/**
 * The official native archives of lark-cli 1.0.55.
 *
 * The npm package itself is only an installer shim: its `postinstall` downloads
 * one of these archives, so an `--ignore-scripts` npm install (S2 never runs
 * lifecycle scripts) produces no executable. Installing the archive directly is
 * the reliable one-click path.
 *
 * NOT verified end-to-end inside the plugin: all six official GitHub-release
 * archives were downloaded and hashed against the `checksums.txt` shipped in
 * @larksuite/cli@1.0.55 (the digests below match), but the S2
 * download→extract→swap→probe pipeline was not run against a real download in
 * this worktree. If the download fails, the settings row keeps the
 * manual-install guidance (`npm install -g @larksuite/cli@1.0.55`, which runs
 * the CLI's own official postinstall) and the explicit-path option.
 */
const LARK_ARCHIVES: readonly LarkArchive[] = [
  {
    platform: 'darwin', arch: 'arm64', releasePlatform: 'darwin', releaseArch: 'arm64',
    archive: 'tar.gz', executable: 'lark-cli',
    sha256: 'd2e3d8cf0b055144606904b503ae1379e3d50a6dac90b0643912fd2e9072c1f2',
  },
  {
    platform: 'darwin', arch: 'x64', releasePlatform: 'darwin', releaseArch: 'amd64',
    archive: 'tar.gz', executable: 'lark-cli',
    sha256: '575be44bf803a94f81b5fb30bb8653841e4a4c9b1931a5d62adf4807dbac06aa',
  },
  {
    platform: 'linux', arch: 'x64', releasePlatform: 'linux', releaseArch: 'amd64',
    archive: 'tar.gz', executable: 'lark-cli',
    sha256: 'd345e54527b37575d33e0b860550d4e49034c97a193a5b4810fb684d247677f9',
  },
  {
    platform: 'linux', arch: 'arm64', releasePlatform: 'linux', releaseArch: 'arm64',
    archive: 'tar.gz', executable: 'lark-cli',
    sha256: 'b5ca0b25d6e87744c38280b837a6473d01fb063c3598ec5beaf6051a803c3dfb',
  },
  {
    platform: 'win32', arch: 'x64', releasePlatform: 'windows', releaseArch: 'amd64',
    archive: 'zip', executable: 'lark-cli.exe',
    sha256: 'afd8114bf53e6b150dc22358d347502c55a347b29a00212351225e52151ab9ef',
  },
  {
    platform: 'win32', arch: 'arm64', releasePlatform: 'windows', releaseArch: 'arm64',
    archive: 'zip', executable: 'lark-cli.exe',
    sha256: '0cdd542687c4d520c48bc3aef1fd691e800298af01a0401b2b268f7dc184fe34',
  },
]

/** The official GitHub release URL of one archive. */
function larkArchiveUrl(entry: LarkArchive): string {
  const extension = entry.archive === 'zip' ? 'zip' : 'tar.gz'
  return `https://github.com/larksuite/cli/releases/download/v${LARK_CLI_VERSION}/`
    + `lark-cli-${LARK_CLI_VERSION}-${entry.releasePlatform}-${entry.releaseArch}.${extension}`
}

/** The three platform families the pinned package declares. */
function supportedTargets(): DependencyTarget[] {
  return LARK_ARCHIVES.map(entry => ({ platform: entry.platform, arch: entry.arch }))
}

/**
 * The shared lark-cli dependency: the exact official 1.0.55 native archive per
 * target. The npm shim is NOT installed (S2 never runs postinstall scripts and
 * the shim has no binary to probe); the manual guidance keeps the official
 * global-npm route as a fallback.
 */
export function feishuDependencyDefinition(): ClueDependencyDefinition {
  const distributions: DependencyDistribution[] = LARK_ARCHIVES.map(entry => ({
    kind: 'archive',
    source: 'GitHub releases',
    platforms: [{ platform: entry.platform, arch: entry.arch }],
    url: larkArchiveUrl(entry),
    sha256: entry.sha256,
    archive: entry.archive,
    executable: entry.executable,
  }))
  return {
    dependencyId: FEISHU_DEPENDENCY_ID,
    name: 'Lark CLI',
    command: FEISHU_CLI_COMMAND,
    pluginId: FEISHU_PLUGIN_ID,
    version: { minimum: LARK_CLI_VERSION, recommended: LARK_CLI_VERSION },
    supportedPlatforms: supportedTargets(),
    // Notice suppression only; the runtime's safe allowlist still filters them.
    // Reuse the exact same names the adapter passes to every CLI call, so the
    // dependency allowlist and the invocation can never drift apart.
    envAllowlist: Object.keys(LARK_CLI_ENV),
    install: { distributions },
    manualInstall: MANUAL_INSTALL,
  }
}

/** The user identity object of an auth-status answer, when present. */
function userIdentityOf(success: LarkSuccess): Record<string, JsonValue> | undefined {
  const identities = isRecord(success.data.identities)
    ? success.data.identities
    : isRecord(success.envelope.identities) ? success.envelope.identities : undefined
  if (identities === undefined) return undefined
  const user = identities.user
  return isRecord(user) ? user : undefined
}

/** Whether one identity object explicitly reports the app configuration absent. */
function identityConfigMissing(value: JsonValue | undefined): boolean {
  if (!isRecord(value)) return false
  const text = `${stringOf(value.status) ?? ''} ${stringOf(value.message) ?? ''}`.toLowerCase()
  return text.includes('missing app config')
    || text.includes('not_configured')
    || text.includes('not configured')
    || text.includes('missing app secret')
}

/** Whether the status payload explicitly says the app configuration is absent. */
function statusConfigMissing(success: LarkSuccess): boolean {
  const data = success.data
  if (data.configured === false || data.config === null || data.app === null) return true
  // The real bare `auth status` payload has no `configured` field; it reports
  // the two identities instead. The unconfigured app is visible as
  // `identities.bot.status/message` (e.g. “Bot identity: not configured
  // (missing app config)”). Treating only the invented `data.configured` field
  // as authoritative was the reason a real unconfigured CLI still looked
  // authorized after B1.
  const identities = isRecord(data.identities)
    ? data.identities
    : isRecord(success.envelope.identities) ? success.envelope.identities : undefined
  if (identities === undefined) return false
  return identityConfigMissing(identities.bot) || identityConfigMissing(identities.user)
}

/**
 * Project one successful auth-status answer. A ready token is necessary but
 * not sufficient: a docs/drive-only grant must not advertise the task
 * capabilities, so the declared capabilities are filtered by the scopes the
 * CLI reports (`identities.user.scope`).
 */
function inspectionOfStatus(success: LarkSuccess): ConnectionInspection {
  if (statusConfigMissing(success)) return missingConfigurationInspection()
  const user = userIdentityOf(success)
  const account = user === undefined ? undefined : stringOf(user.userName) ?? stringOf(user.openId)
  if (user === undefined) {
    return {
      configuration: 'ready',
      authorization: 'not-authorized',
      detail: 'No Feishu user identity is authorized yet; connect the account.',
    }
  }
  const status = (stringOf(user.status) ?? '').toLowerCase()
  const tokenStatus = (stringOf(user.tokenStatus) ?? '').toLowerCase()
  const expired = status === 'expired' || tokenStatus === 'expired'
  const denied = status === 'denied' || status === 'revoked' || tokenStatus === 'revoked'
  // `needs_refresh` is lark-cli's own "the token is valid and will be refreshed
  // on the next call" state, not an expired authorization.
  const ready = !expired && !denied && (
    status === 'ready' || status === 'active' || status === 'valid' || status === 'needs_refresh'
    || tokenStatus === 'valid' || tokenStatus === 'active' || tokenStatus === 'needs_refresh'
  )
  if (!ready) {
    return {
      configuration: 'ready',
      authorization: expired ? 'expired' : denied ? 'denied' : 'not-authorized',
      ...(account === undefined ? {} : { account }),
      detail: expired
        ? 'The Feishu authorization expired; connect the account again.'
        : denied
          ? 'The Feishu authorization was denied or revoked; connect the account again.'
          : 'The Feishu account is not authorized yet; connect it.',
    }
  }
  const scopes = grantedScopesOf(user) ?? grantedScopesOf(success.data)
  if (scopes === undefined) {
    // The documented status shape carries the granted scopes; without them we
    // cannot honestly claim the tasks capability after a docs-only login.
    return {
      configuration: 'ready',
      authorization: 'scope-insufficient',
      ...(account === undefined ? {} : { account }),
      detail: 'lark-cli did not report the granted scopes; re-run authorization to confirm '
        + 'the docs and task scopes.',
    }
  }
  const capabilities = capabilitiesForScopes(scopes)
  const missing = missingConnectionCapabilities(capabilities)
  if (missing.length > 0) {
    return {
      configuration: 'ready',
      authorization: 'scope-insufficient',
      ...(account === undefined ? {} : { account }),
      detail: missingScopesDetail(missing),
    }
  }
  return {
    configuration: 'ready',
    authorization: 'ready',
    ...(account === undefined ? {} : { account }),
    capabilities,
  }
}

/** One expiry instant, derived only from explicit fields (never invented as "valid"). */
function expiresAtOf(success: LarkSuccess, context: ConnectionAdapterContext): string {
  const explicit = stringOf(success.data.expires_at)
  if (explicit !== undefined) {
    const parsed = Date.parse(explicit)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  const seconds = success.data.expires_in
  const numeric = typeof seconds === 'number' ? seconds : Number(stringOf(seconds) ?? Number.NaN)
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(Date.parse(context.now()) + numeric * 1000).toISOString()
  }
  // lark-cli device codes are short-lived; 10 minutes is the runtime's own TTL
  // fallback and never a claim that the code is valid for longer.
  return new Date(Date.parse(context.now()) + 10 * 60 * 1000).toISOString()
}

/** The suggested poll interval, when the CLI reports one (OAuth `interval` seconds). */
function pollAfterMsOf(success: LarkSuccess): number | undefined {
  const explicit = success.data.poll_after_ms
  const numeric = typeof explicit === 'number' ? explicit : Number(stringOf(explicit) ?? Number.NaN)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const interval = success.data.interval
  const seconds = typeof interval === 'number' ? interval : Number(stringOf(interval) ?? Number.NaN)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  return undefined
}

/** Project one successful connect answer into the explicit-device-flow start. */
function connectStartOf(success: LarkSuccess, context: ConnectionAdapterContext): ConnectionConnectStart {
  const verificationUrl = stringOf(success.data.verification_url)
    ?? stringOf(success.data.verification_uri_complete)
  const deviceCode = stringOf(success.data.device_code)
  if (verificationUrl === undefined || deviceCode === undefined) {
    throw new ClueError('failed', 'lark-cli did not return a usable device authorization prompt')
  }
  const expiresAt = expiresAtOf(success, context)
  if (Date.parse(expiresAt) <= Date.parse(context.now())) {
    throw new ClueError('failed', 'lark-cli returned an already-expired authorization prompt')
  }
  const userCode = stringOf(success.data.user_code)
  const pollAfterMs = pollAfterMsOf(success)
  return {
    inspection: { configuration: 'ready', authorization: 'authorizing' },
    prompt: {
      // The URL is opaque: copied verbatim, never re-parsed/re-encoded.
      verificationUrl,
      ...(userCode === undefined ? {} : { userCode }),
      expiresAt,
      ...(pollAfterMs === undefined ? {} : { pollAfterMs }),
      // The QR encodes the SAME string for a client-side encoder.
      qr: { uri: verificationUrl },
      instructions:
        'Open the authorization link (or scan the QR code), approve the requested Feishu access, '
        + 'then choose “Check authorization”.',
    },
    // Host-side only: S2 keeps this in memory and never projects it.
    state: { deviceCode },
  }
}

/** The device code of one host-side poll/cancel state. */
function deviceCodeOf(state: unknown): string {
  if (!isRecord(state)) {
    throw new ClueError('invalid-request', 'the authorization attempt has no poll handle')
  }
  const deviceCode = stringOf(state.deviceCode)
  if (deviceCode === undefined) {
    throw new ClueError('invalid-request', 'the authorization attempt has no device code')
  }
  return deviceCode
}

/** Project one successful device-code poll (the user just approved). */
function readyInspectionOf(success: LarkSuccess): ConnectionInspection {
  const user = userIdentityOf(success)
  const account = user === undefined
    // The real login JSON is a bare `authorization_complete` event with
    // snake_case `user_name`.
    ? stringOf(success.data.userName) ?? stringOf(success.data.user_name)
    : stringOf(user.userName) ?? stringOf(user.openId)
  const scopes = grantedScopesOf(user) ?? grantedScopesOf(success.data)
  if (scopes === undefined) {
    // The documented poll success means the requested domains were granted;
    // only an explicit scope list can narrow that claim.
    return {
      configuration: 'ready',
      authorization: 'ready',
      ...(account === undefined ? {} : { account }),
      capabilities: [...FEISHU_CONNECTION_CAPABILITIES],
    }
  }
  const capabilities = capabilitiesForScopes(scopes)
  const missing = missingConnectionCapabilities(capabilities)
  if (missing.length > 0) {
    return {
      configuration: 'ready',
      authorization: 'scope-insufficient',
      ...(account === undefined ? {} : { account }),
      detail: missingScopesDetail(missing),
    }
  }
  return {
    configuration: 'ready',
    authorization: 'ready',
    ...(account === undefined ? {} : { account }),
    capabilities,
  }
}

/**
 * Project one SUCCESSFUL device-code poll. A success envelope is not a ready
 * claim by itself: when the payload carries a status/authorized field, a
 * pending/denied/expired answer must stay in that state.
 */
function pollResultOf(success: LarkSuccess): ConnectionPollResult {
  // Real successful `auth login --device-code --json` is a bare
  // `authorization_complete` event. A non-empty `missing` there means the
  // grant is partial even though the exit code was 0.
  if (success.data.event === 'authorization_complete') {
    const missing = Array.isArray(success.data.missing)
      ? success.data.missing.filter((scope): scope is string => typeof scope === 'string' && scope.trim() !== '')
      : []
    if (missing.length > 0) {
      return {
        complete: true,
        inspection: {
          configuration: 'ready',
          authorization: 'scope-insufficient',
          detail: larkScopeDetail(missing),
        },
      }
    }
  }
  const status = (
    stringOf(success.data.status)
    ?? stringOf(success.data.authorization_status)
    ?? ''
  ).toLowerCase()
  if (status !== '') {
    if (
      status.includes('pending')
      || status.includes('waiting')
      || status.includes('slow_down')
      || status === 'authorizing'
    ) {
      return {
        complete: false,
        inspection: { configuration: 'ready', authorization: 'authorizing' },
      }
    }
    if (status.includes('denied') || status.includes('revoked') || status.includes('access_denied')) {
      return { complete: true, inspection: { configuration: 'ready', authorization: 'denied' } }
    }
    if (status.includes('expired') || status.includes('timeout')) {
      return { complete: true, inspection: { configuration: 'ready', authorization: 'expired' } }
    }
    if (status.includes('not_authorized') || status.includes('unauthorized')) {
      return {
        complete: true,
        inspection: { configuration: 'ready', authorization: 'not-authorized' },
      }
    }
    const readyStatus = [
      'ready', 'authorized', 'active', 'valid', 'done', 'success', 'complete', 'completed',
      // A token that must be refreshed on the next call is still authorized.
      'needs_refresh',
    ]
    if (!readyStatus.includes(status)) {
      // Unknown non-terminal status: never claim ready; keep the explicit
      // authorization attempt open for the next poll.
      return {
        complete: false,
        inspection: { configuration: 'ready', authorization: 'authorizing' },
      }
    }
  }
  if (success.data.authorized === false || success.data.complete === false) {
    return {
      complete: false,
      inspection: { configuration: 'ready', authorization: 'authorizing' },
    }
  }
  return { complete: true, inspection: readyInspectionOf(success) }
}

/**
 * Project the terminal `authorization_complete` object lark-cli writes to
 * STDOUT (exit 3) when the device flow finished with warnings or a denial.
 */
function pollCompletionOf(completion: LarkCompletion): ConnectionPollResult {
  const status = completion.status.toLowerCase()
  if (completion.missingScopes.length > 0 || status.includes('warning') || status.includes('partial')) {
    return {
      complete: true,
      inspection: {
        configuration: 'ready',
        authorization: 'scope-insufficient',
        detail: larkScopeDetail(completion.missingScopes, completion.consoleUrl),
      },
    }
  }
  if (status.includes('denied') || status.includes('access_denied')) {
    return { complete: true, inspection: { configuration: 'ready', authorization: 'denied' } }
  }
  if (status.includes('expired') || status.includes('expiration')) {
    return { complete: true, inspection: { configuration: 'ready', authorization: 'expired' } }
  }
  if (status.includes('pending') || status.includes('waiting') || status.includes('authorizing')) {
    return {
      complete: false,
      inspection: { configuration: 'ready', authorization: 'authorizing' },
    }
  }
  if (status.includes('complete') || status.includes('success') || status.includes('ready')) {
    return {
      complete: true,
      inspection: { configuration: 'ready', authorization: 'ready', capabilities: [...FEISHU_CONNECTION_CAPABILITIES] },
    }
  }
  return {
    complete: true,
    inspection: {
      configuration: 'ready',
      authorization: 'not-authorized',
      detail: 'lark-cli reported that the authorization did not complete',
    },
  }
}

/** Project one failed device-code poll into a terminal state or a still-pending one. */
function pollFailureOf(failure: LarkFailure): ConnectionPollResult | undefined {
  const failureClass = classifyLarkFailure(failure)
  const subtype = failure.subtype.toLowerCase()
  if (failureClass === 'config-missing') {
    return { complete: true, inspection: missingConfigurationInspection() }
  }
  if (failureClass === 'missing-scope') {
    return {
      complete: true,
      inspection: {
        configuration: 'ready',
        authorization: 'scope-insufficient',
        detail: larkScopeDetail(failure.missingScopes, failure.consoleUrl),
      },
    }
  }
  if (failureClass === 'authorization') {
    // lark-cli 1.0.55 reports denial/expiry as type "authentication" with
    // subtype "unknown"; the fixed `marker` is the sanitized discriminator.
    if (
      failure.marker === 'pending'
      || subtype.includes('pending')
      || subtype.includes('slow_down')
      || subtype.includes('authorization_waiting')
    ) {
      return {
        complete: false,
        inspection: { configuration: 'ready', authorization: 'authorizing' },
      }
    }
    if (failure.marker === 'denied' || subtype.includes('denied') || subtype.includes('access_denied')) {
      return { complete: true, inspection: { configuration: 'ready', authorization: 'denied' } }
    }
    if (
      failure.marker === 'expired'
      || subtype.includes('expired')
      || subtype.includes('expiration')
      || subtype.includes('timeout')
    ) {
      return { complete: true, inspection: { configuration: 'ready', authorization: 'expired' } }
    }
    return { complete: true, inspection: { configuration: 'ready', authorization: 'not-authorized' } }
  }
  return undefined
}

/**
 * Build the shared connection definition.
 * @param getRuntime - lazy runtime accessor; definition construction never calls it.
 */
export function feishuConnectionDefinition(getRuntime: () => ClueRuntime): ClueConnectionDefinition {
  const runtime = (): ClueRuntime => getRuntime()
  return {
    connectionId: FEISHU_CONNECTION_ID,
    name: 'Feishu (lark-cli)',
    pluginId: FEISHU_PLUGIN_ID,
    configuration: 'required',
    // lark-cli owns the token store and renewal; the host stores no secret.
    credentialOwner: 'tool',
    capabilities: [...FEISHU_CONNECTION_CAPABILITIES],
    async inspect(_input, context) {
      const outcome = await executeLark({
        runtime: runtime(),
        bareSuccess: true,
        args: larkAuthStatusArgs(),
        cwd: process.cwd(),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        timeoutMs: 30_000,
      })
      if (outcome.success !== undefined) return inspectionOfStatus(outcome.success)
      if (outcome.failure === undefined) {
        throw new ClueError('failed', 'lark-cli auth status returned no usable status envelope')
      }
      const failureClass = classifyLarkFailure(outcome.failure)
      if (failureClass === 'config-missing') return missingConfigurationInspection()
      if (failureClass === 'missing-scope') {
        return {
          configuration: 'ready',
          authorization: 'scope-insufficient',
          detail: larkScopeDetail(outcome.failure.missingScopes, outcome.failure.consoleUrl),
        }
      }
      if (failureClass === 'authorization') {
        const subtype = outcome.failure.subtype.toLowerCase()
        const expired = subtype.includes('expired') || subtype.includes('timeout')
        return {
          configuration: 'ready',
          authorization: expired ? 'expired' : 'not-authorized',
          detail: expired
            ? 'The Feishu authorization expired; connect the account again.'
            : 'The Feishu account is not authorized yet; connect it.',
        }
      }
      if (failureClass === 'permission') {
        return { configuration: 'ready', authorization: 'denied', detail: 'The Feishu account was denied or revoked.' }
      }
      throw larkFailureError(outcome.failure)
    },
    async connect(_input, context) {
      // `connect` is also the runtime's "configure" action. Check the
      // configuration with the read-only status verb FIRST: an unconfigured
      // app must surface the CLI's `config init --new` instruction without
      // launching a login it cannot complete. `auth status` is not a probe with
      // side effects and this runs only for an explicit user action. The
      // blocking config flow itself is an S2 runtime extension (see the module
      // comment); this adapter does not fake it.
      const status = await executeLark({
        runtime: runtime(),
        bareSuccess: true,
        args: larkAuthStatusArgs(),
        cwd: process.cwd(),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        timeoutMs: 30_000,
      })
      if (status.success !== undefined && statusConfigMissing(status.success)) {
        return { inspection: missingConfigurationInspection() }
      }
      if (
        status.failure !== undefined
        && classifyLarkFailure(status.failure) === 'config-missing'
      ) {
        return { inspection: missingConfigurationInspection() }
      }
      const outcome = await executeLark({
        runtime: runtime(),
        bareSuccess: true,
        args: larkAuthLoginArgs(),
        cwd: process.cwd(),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        timeoutMs: 30_000,
      })
      if (outcome.success !== undefined) return connectStartOf(outcome.success, context)
      if (outcome.failure === undefined) {
        throw new ClueError('failed', 'lark-cli auth login returned no usable authorization envelope')
      }
      if (classifyLarkFailure(outcome.failure) === 'config-missing') {
        return { inspection: missingConfigurationInspection() }
      }
      throw larkFailureError(outcome.failure)
    },
    async poll(input, context) {
      const deviceCode = deviceCodeOf(input.state)
      const outcome = await executeLark({
        runtime: runtime(),
        bareSuccess: true,
        args: larkAuthPollArgs(deviceCode),
        cwd: process.cwd(),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        timeoutMs: LARK_AUTH_POLL_TIMEOUT_MS,
      })
      if (outcome.success !== undefined) return pollResultOf(outcome.success)
      // The device-flow terminal result is written to STDOUT with exit 3 when
      // the user completed the flow without granting every scope. It must be
      // projected before the generic failure path (which reads stderr).
      if (outcome.completion !== undefined) return pollCompletionOf(outcome.completion)
      if (outcome.failure === undefined) {
        throw new ClueError('failed', 'lark-cli device authorization returned no usable envelope')
      }
      const projected = pollFailureOf(outcome.failure)
      if (projected !== undefined) return projected
      throw larkFailureError(outcome.failure)
    },
    async cancel(input: ConnectionCancelInput) {
      // No documented device-code cancel verb exists. Dropping the host-side
      // handle (S2 deletes the session) is the cancellation; the server-side
      // code simply expires. Never call `auth logout` here: that would revoke
      // an existing valid authorization.
      deviceCodeOf(input.state)
    },
  }
}
