/**
 * Feishu authorization observations shared by the two sources (S4).
 *
 * `auth status` reports the granted user scopes (`identities.user.scope` in the
 * local lark skill docs). The shared connection declares BOTH docs and tasks
 * capabilities, so a valid token is not enough: a docs/drive-only login must
 * not advertise `tasks.read`/`tasks.edit`. This module projects the documented
 * scopes onto the declared capabilities and reports missing coverage as
 * `scope-insufficient` (S2 maps that state to the `grant-scope` action).
 *
 * A normal resource request that fails with an authorization error publishes
 * the same safe observation through `runtime.connections.report`, as the S4
 * spec requires. Only fixed scope names and the CLI-provided https console URL
 * are projected; raw stderr, messages, hints, device codes and tokens never
 * are.
 *
 * The exact scope spelling is taken from the lark-cli 1.0.55 scope catalog
 * (`docx:document:readonly`, `docs:document.content:read`,
 * `search:docs:read`, `task:task:read`, `task:task:write`, …); a real
 * lark-cli account is NOT exercised by the test suite. A wiki scope is
 * deliberately NOT sufficient for `docs.read`: it grants wiki-node access but
 * not Docx content, so treating it as full docs coverage would over-advertise
 * the source exactly like the old token-only projection did.
 */
import { ClueError } from '../../types.ts'
import type { JsonValue } from '../../types.ts'
import type { ClueRuntime, ConnectionInspection } from '../../runtime/types.ts'
import {
  FEISHU_CONFIGURATION_DETAIL,
  FEISHU_CONNECTION_CAPABILITIES,
  FEISHU_CONNECTION_ID,
  isRecord,
  type FeishuConnectionCapability,
} from './format.ts'
import {
  larkScopeDetail,
  runLark,
  type LarkRequest,
  type LarkSuccess,
} from './lark.ts'

/**
 * The documented scopes that satisfy one connection capability. These are the
 * exact scope names the CLI's `auth status` reports; a `resource:object:*`
 * wildcard is also accepted. Unknown spellings simply match nothing.
 */
const CAPABILITY_SCOPES: Readonly<Record<FeishuConnectionCapability, readonly string[]>> = {
  'docs.read': [
    // The real 1.0.55 scope vocabulary. `docx:document:read` / the plural
    // `docs:document:read` are NOT real scope names.
    'docx:document:readonly',
    'docx:document',
    'docs:document.content:read',
    'docs:doc:readonly',
    'docs:doc',
  ],
  'docs.search': [
    'search:docs:read',
    'drive:drive.search:readonly',
    'drive:drive',
    'drive:drive:readonly',
    'drive:drive.metadata:readonly',
  ],
  'tasks.read': [
    'task:task:read',
    'task:task:readonly',
    'task:task',
  ],
  'tasks.edit': [
    'task:task:write',
    'task:task:writeonly',
    'task:task',
  ],
}

/** Whether one granted scope satisfies a required documented scope (wildcards included). */
function scopeMatches(granted: string, required: string): boolean {
  if (granted === required) return true
  // A domain-wide wildcard (`task:task:*`, `docs:*`) grants everything below it.
  if (granted.endsWith(':*')) {
    const prefix = granted.slice(0, -1)
    if (required === prefix || required.startsWith(prefix)) return true
  }
  return false
}

/** A string-valued scope list, or undefined when the field is absent. */
function scopeListOf(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    return value.split(/[\s,]+/).filter(entry => entry !== '')
  }
  if (Array.isArray(value)) {
    const scopes: string[] = []
    for (const entry of value) {
      if (typeof entry !== 'string') continue
      const trimmed = entry.trim()
      if (trimmed !== '') scopes.push(trimmed)
    }
    return scopes
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .filter(([, granted]) => granted === true)
      .map(([scope]) => scope)
  }
  return undefined
}

/**
 * The scopes lark-cli reports for the current user. `undefined` means the
 * status answer carried no scope information at all (which is NOT the same as
 * a known-empty grant).
 * @param record - `identities.user`, `data` or another status object.
 */
export function grantedScopesOf(record: Record<string, JsonValue> | undefined): readonly string[] | undefined {
  if (record === undefined) return undefined
  return scopeListOf(record.scope) ?? scopeListOf(record.scopes)
}

/** The capabilities whose documented scopes are present. */
export function capabilitiesForScopes(scopes: readonly string[]): FeishuConnectionCapability[] {
  return FEISHU_CONNECTION_CAPABILITIES.filter(capability =>
    CAPABILITY_SCOPES[capability].some(required =>
      scopes.some(scope => scopeMatches(scope, required))))
}

/** The declared capabilities the granted scopes do not cover. */
export function missingConnectionCapabilities(
  capabilities: readonly string[],
): FeishuConnectionCapability[] {
  return FEISHU_CONNECTION_CAPABILITIES.filter(capability => !capabilities.includes(capability))
}

/** The documented scope names required by one capability. */
function requiredScopeNames(capability: FeishuConnectionCapability): readonly string[] {
  return CAPABILITY_SCOPES[capability]
}

/**
 * A safe explanation of the missing capability families. Only fixed scope
 * names are interpolated, never a CLI message.
 * @param missing - capabilities the granted scopes do not cover.
 */
export function missingScopesDetail(missing: readonly FeishuConnectionCapability[]): string {
  const scopes = [...new Set(missing.flatMap(capability => requiredScopeNames(capability)))]
  return `The Feishu authorization is missing scopes for ${missing.join(', ')} `
    + `(${scopes.join(', ')}). Re-run authorization to grant them.`
}

/** The inspection shown when the application configuration is absent. */
export function missingConfigurationInspection(): ConnectionInspection {
  return {
    configuration: 'missing',
    authorization: 'not-authorized',
    detail: FEISHU_CONFIGURATION_DETAIL,
  }
}

/** Publish one observation without ever masking the resource-request error. */
function publish(runtime: ClueRuntime, inspection: ConnectionInspection): void {
  try {
    runtime.connections.report(FEISHU_CONNECTION_ID, inspection)
  } catch {
    // Reporting is an observation side effect; a connection that was not
    // registered yet (or a fake runtime) must not turn a real read failure
    // into a different exception.
  }
}

/**
 * Publish the safe connection observation of one failed resource request.
 * Auth failures are authoritative; the host-side scope/config distinction
 * comes from the fixed failure category and sanitized metadata only.
 * @param runtime - the shared runtime (its connection face owns the state).
 * @param error - the ClueError thrown by the resource operation.
 */
export function reportAuthorizationFailure(runtime: ClueRuntime, error: ClueError): void {
  if (error.category === 'permission-denied') {
    // A resource-level 403 keeps the account authorized; only the console
    // entry (when the CLI supplied one) is useful in the settings detail.
    if (error.meta?.consoleUrl !== undefined) {
      publish(runtime, {
        configuration: 'ready',
        authorization: 'ready',
        detail: `The Feishu account cannot access this resource. Developer console: ${error.meta.consoleUrl}`,
      })
    }
    return
  }
  if (error.category !== 'auth-required') return
  const meta = error.meta ?? {}
  const subtype = (meta.subtype ?? '').toLowerCase()
  if (
    subtype.includes('config')
    || subtype.includes('not_configured')
    || subtype.includes('no_app')
    || subtype.includes('app_missing')
  ) {
    publish(runtime, missingConfigurationInspection())
    return
  }
  const missingScopes = (meta.missingScopes ?? '').split(',').filter(scope => scope !== '')
  const authorization = missingScopes.length > 0 || subtype.includes('scope')
    ? 'scope-insufficient'
    : subtype.includes('expired') || subtype.includes('token')
      ? 'expired'
      : 'not-authorized'
  const detail = missingScopes.length > 0 || meta.consoleUrl !== undefined
    ? larkScopeDetail(missingScopes, meta.consoleUrl)
    : undefined
  publish(runtime, {
    configuration: 'ready',
    authorization,
    ...(detail === undefined ? {} : { detail }),
  })
}

/**
 * Run one resource command through the shared lark adapter. An authorization
 * failure updates the connection observation before the error continues to the
 * caller (the S4 spec's "real resource request updates connection state").
 * @param runtime - the runtime that executes the CLI.
 * @param request - command, cwd and budgets.
 */
export async function runFeishuCommand(
  runtime: ClueRuntime,
  request: Omit<LarkRequest, 'runtime'>,
): Promise<LarkSuccess> {
  try {
    return await runLark({ runtime, ...request })
  } catch (error) {
    if (error instanceof ClueError) reportAuthorizationFailure(runtime, error)
    throw error
  }
}
