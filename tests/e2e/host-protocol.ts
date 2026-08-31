/**
 * Pure host-transport contracts for the e2e lanes against the DSH
 * 0.1.2-alpha.x web host (Remote gateway + one-time-token browser auth). No
 * Playwright imports here — these shapes are unit-testable
 * (tests/e2e-host-protocol.spec.ts); ./host.ts wires them to a request
 * context.
 *
 * Host contract (deepseek-harness tags dsh-v0.1.2-alpha.1/2, verified on
 * live hosts; the pre-alpha dual-dialect layer was dropped in the plugin's
 * v0.18.0-alpha.0 alpha track):
 *
 * - `dsh web` prints an AUTHENTICATED launch URL — `dsh web:
 *   http://127.0.0.1:<port>/?token=<43 base64url chars>`. Navigating it
 *   exchanges the token for a signed cookie (HttpOnly, SameSite=Strict) that
 *   every `/api` request must then carry; the clean URL answers 401.
 * - The Remote gateway serves SLASH endpoints — `POST /api/workspace/create`
 *   with `payload: { args }` whose args object is keyed by the controller's
 *   TypeScript PARAMETER name (`workspace/create` → `{ request: {...} }`;
 *   `session/list`'s unused parameter is literally `_request` and is NOT
 *   omissible); the legacy dot path is no longer claimed (404). The
 *   `{type:'client-request', rpcId, method, payload}` /
 *   `{type:'server-response', rpcId, result}` envelopes are unchanged, and
 *   the plugin's own `/sidebar/*` routes stay public (the webserver carrier
 *   owns no authentication — only `/api`, the index HTML, and the remote mux
 *   upgrade sit behind the browser auth).
 */

/** The pieces of a `dsh web` launch URL the lanes need. */
export interface LaunchUrl {
  /** Scheme + host + port — the base for URL construction (a token URL would
   *  corrupt path concatenation). */
  origin: string
  /** The URL as printed (token query included) — the correct page.goto
   *  target; navigating it performs the token→cookie exchange. */
  pageUrl: string
  /** The one-time launch token. */
  token: string
}

/** Split a `dsh web` launch URL (`/?token=` — every supported host prints
 *  one) into the pieces the lanes address. Throws without a token: a bare
 *  origin is a pre-0.1.2-alpha host this plugin no longer supports. */
export function parseLaunchUrl(raw: string): LaunchUrl {
  const url = new URL(raw)
  const token = url.searchParams.get('token')
  if (token === null) {
    throw new Error(`launch URL carries no ?token= — not a DSH 0.1.2-alpha+ authenticated launch URL: ${raw}`)
  }
  return { origin: url.origin, pageUrl: raw, token }
}

/** Page navigation URL with extra query stamps (e.g. desktop-shell URL
 *  parameters) merged in — never naively append `?...` to a token URL (a
 *  double `?` breaks both params). The token survives the merge. */
export function pageUrlWith(raw: string, extra: Record<string, string>): string {
  const url = new URL(raw)
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value)
  return url.toString()
}

/** One host-RPC request. */
export interface RpcAttempt {
  /** Request path, relative to the origin, starting with `/api/`. */
  path: string
  /** Envelope `method` string — must equal the endpoint the path selects. */
  method: string
  /** Envelope `payload` — `{ args }` keyed by the controller parameter name
   *  (the gateway rejects any other payload shape). */
  payload: Record<string, unknown>
}

/** The args key per host method: the 0.1.2-alpha Remote controllers key the
 *  args object by the TypeScript PARAMETER name, not by the endpoint's own
 *  naming — workspace/create and session/create declare a single `request`
 *  parameter, while session/list's unused parameter is literally named
 *  `_request` (and is NOT omissible: the typert gateway rejects `{}` and
 *  `{request:{}}` alike). Verified against live dsh-v0.1.2-alpha hosts:
 *  every other shape fails with `args fields do not match the descriptor`. */
const RPC_ARGS_KEY: Record<string, string> = {
  'workspace.create': 'request',
  'session.create': 'request',
  'session.list': '_request',
}

/** Build one host RPC request (method in dot form, e.g.
 *  `'workspace.create'`). Throws for methods without a known args key: the
 *  wrapper is per-parameter, so an unverified shape must fail loudly at
 *  build time instead of as a confusing gateway error mid-lane. */
export function rpcAttempt(method: string, args: Record<string, unknown>): RpcAttempt {
  const key = RPC_ARGS_KEY[method]
  if (key === undefined) {
    throw new Error(`host-protocol: no args key for ${JSON.stringify(method)} — verify the parameter name on the host and extend RPC_ARGS_KEY`)
  }
  const endpoint = method.split('.').join('/')
  return { path: `/api/${endpoint}`, method: endpoint, payload: { args: { [key]: args } } }
}
