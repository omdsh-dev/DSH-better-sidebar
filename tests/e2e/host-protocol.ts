/**
 * Pure host-transport contracts for the e2e lanes, spanning the DSH
 * 0.1.1-rc.x → 0.1.2-alpha.1 breaking split (Remote gateway + one-time-token
 * browser auth). No Playwright imports here — these shapes are unit-testable
 * (tests/e2e-host-protocol.spec.ts); ./host.ts wires them to a request
 * context.
 *
 * What changed in 0.1.2-alpha.1 (deepseek-harness tag dsh-v0.1.2-alpha.1):
 *
 * - `dsh web` prints an AUTHENTICATED launch URL — `dsh web:
 *   http://127.0.0.1:<port>/?token=<43 base64url chars>`. Navigating it
 *   exchanges the token for a signed cookie (HttpOnly, SameSite=Strict) that
 *   every `/api` request must then carry; the clean URL answers 401. Older
 *   hosts print a bare origin and have no browser auth.
 * - The legacy ApiProxy dot-method endpoints (`POST /api/workspace.create`
 *   with `payload: <args>`) were replaced by the Remote gateway's slash
 *   endpoints — `POST /api/workspace/create` with `payload: { args }` whose
 *   args object is keyed by the controller's TypeScript PARAMETER name
 *   (`workspace/create` → `{ request: {...} }`; `session/list`'s unused
 *   parameter is literally `_request` and is not omissible); a dot path is
 *   no longer claimed (404). The `{type:'client-request', rpcId, method,
 *   payload}` / `{type:'server-response', rpcId, result}` envelopes are
 *   unchanged, and the plugin's own `/sidebar/*` routes stay public (the
 *   webserver carrier owns no authentication — only `/api`, the index HTML,
 *   and the remote mux upgrade sit behind the browser auth).
 */

/** The pieces of a `dsh web` launch URL the lanes need. */
export interface LaunchUrl {
  /** Scheme + host + port — the base for URL construction (a token URL would
   *  corrupt path concatenation). */
  origin: string
  /** The URL as printed (token query included on 0.1.2-alpha.1+); the correct
   *  page.goto target — navigating it performs the token→cookie exchange. */
  pageUrl: string
  /** The one-time launch token, when the host printed one. */
  token: string | undefined
}

/** Split a `dsh web` launch URL (bare origin on 0.1.1-rc.x, `/?token=` on
 *  0.1.2-alpha.1+) into the pieces the lanes address. */
export function parseLaunchUrl(raw: string): LaunchUrl {
  const url = new URL(raw)
  return {
    origin: url.origin,
    pageUrl: raw,
    token: url.searchParams.get('token') ?? undefined,
  }
}

/** Page navigation URL with extra query stamps (e.g. desktop-shell URL
 *  parameters) merged in — never naively append `?...` to a token URL (a
 *  double `?` breaks both params). The token survives the merge. */
export function pageUrlWith(raw: string, extra: Record<string, string>): string {
  const url = new URL(raw)
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value)
  return url.toString()
}

/** One host-RPC protocol attempt. */
export interface RpcAttempt {
  /** Which host dialect this attempt speaks. */
  protocol: 'dot' | 'slash'
  /** Request path, relative to the origin, starting with `/api/`. */
  path: string
  /** Envelope `method` string — must equal the endpoint the path selects. */
  method: string
  /** Envelope `payload` — the bare args object on dot hosts, `{ args }` on
   *  slash hosts (the gateway rejects any other payload shape). */
  payload: Record<string, unknown>
}

/** The slash-dialect args key per host method: the 0.1.2-alpha.1 Remote
 *  controllers key the args object by the TypeScript PARAMETER name, not by
 *  the endpoint's own naming — workspace/create and session/create declare a
 *  single `request` parameter, while session/list's unused parameter is
 *  literally named `_request` (and is NOT omissible: the typert gateway
 *  rejects `{}` and `{request:{}}` alike). Verified against a live
 *  dsh-v0.1.2-alpha.1 host: every other shape fails with `args fields do not
 *  match the descriptor`. */
const SLASH_ARGS_KEY: Record<string, string> = {
  'workspace.create': 'request',
  'session.create': 'request',
  'session.list': '_request',
}

/** Build the two dialects of one host RPC (method in dot form, e.g.
 *  `'workspace.create'`): the 0.1.1-rc.x dot endpoint first — the dialect
 *  every currently-published host speaks, so the deployed lanes never pay a
 *  probe round-trip — then the 0.1.2-alpha.1+ slash endpoint as the 404
 *  fallback. Throws for methods without a known slash args key: the wrapper
 *  is per-parameter, so an unverified shape must fail loudly at build time
 *  instead of as a confusing gateway error mid-lane. */
export function rpcAttempts(method: string, args: Record<string, unknown>): RpcAttempt[] {
  const slashKey = SLASH_ARGS_KEY[method]
  if (slashKey === undefined) {
    throw new Error(`host-protocol: no slash-dialect args key for ${JSON.stringify(method)} — verify the parameter name on the host and extend SLASH_ARGS_KEY`)
  }
  const slash = method.split('.').join('/')
  return [
    { protocol: 'dot', path: `/api/${method}`, method, payload: args },
    { protocol: 'slash', path: `/api/${slash}`, method: slash, payload: { args: { [slashKey]: args } } },
  ]
}
