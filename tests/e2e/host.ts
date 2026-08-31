/**
 * Host glue for the e2e lanes: page/asset URL construction, the authenticated
 * request context, and the host RPC. The transport contracts (one-time-token
 * launch URL, slash `/api` endpoints) live in ./host-protocol.ts; this
 * module only wires them to Playwright.
 *
 * Every lane consumes the same contract:
 * - `PAGE_URL` / `pageUrl({...})` for page.goto (the token URL performs the
 *   browser's token→cookie exchange),
 * - `sidebarApi(path)` for the plugin's own public routes,
 * - `createHostApi()` for an APIRequestContext carrying the auth cookie,
 * - `hostRpc(api, 'workspace.create', {...})` for the host's unary RPC.
 */
import { request, type APIRequestContext, type Page } from '@playwright/test'
import { parseLaunchUrl, pageUrlWith, rpcAttempt } from './host-protocol'

const envUrl = process.env.DSH_E2E_URL
if (!envUrl) {
  throw new Error('DSH_E2E_URL is not set — boot a DSH web instance with the plugin mounted and point this lane at it (see scripts/e2e-mount.sh)')
}
// Re-bind with an explicit string type: closure bodies below do not inherit
// the guard's narrowing of envUrl.
const RAW_URL: string = envUrl

const LAUNCH = parseLaunchUrl(RAW_URL)

/** Origin for URL construction (a token URL would corrupt path joins). */
export const ORIGIN = LAUNCH.origin

/** page.goto target: the launch URL as printed (token included —
 *  navigating it exchanges the token for the cookie). */
export const PAGE_URL = LAUNCH.pageUrl

/** page.goto target with extra query stamps merged (token preserved). */
export function pageUrl(extra: Record<string, string>): string {
  return pageUrlWith(RAW_URL, extra)
}

/** Absolute URL for the plugin's own (public, unauthenticated) API route. */
export function sidebarApi(path: string): string {
  return `${ORIGIN}/sidebar/api/${path}`
}

/** Exchange the one-time launch token for the auth-cookie header pair: the
 *  token URL answers 303 with Set-Cookie (following the redirect would lose
 *  it, hence `redirect: 'manual'`). Pure aside from the injected fetch —
 *  unit tests stub it (tests/e2e-host-protocol.spec.ts). */
export async function exchangeLaunchCookie(
  launchUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(launchUrl, { redirect: 'manual' })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie === null) {
    throw new Error(`token exchange failed: HTTP ${res.status} carried no set-cookie — cannot authenticate /api seeding`)
  }
  return setCookie.split(';', 1)[0] ?? ''
}

/** The `name=value` pair of the auth cookie, once per process. */
let cookieHeader: string | undefined

/** page.goto through the host auth. A plain navigation goes to PAGE_URL (the
 *  token URL performs the browser's exchange), but a STAMPED navigation
 *  cannot: the exchange answers `303 → /` and silently DROPS every sibling
 *  query param (the mount lane caught the desktop-shell stamps vanishing
 *  this way), so pre-seed the browser context with the exchanged cookie and
 *  navigate the stamped URL directly. Playwright gives every test a fresh
 *  context, so the seeding is per-call and idempotent. */
export async function gotoPage(page: Page, extra: Record<string, string> = {}): Promise<void> {
  if (Object.keys(extra).length > 0) {
    if (cookieHeader === undefined) cookieHeader = await exchangeLaunchCookie(RAW_URL)
    const eq = cookieHeader.indexOf('=')
    await page.context().addCookies([{
      name: cookieHeader.slice(0, eq),
      value: cookieHeader.slice(eq + 1),
      url: ORIGIN,
    }])
    await page.goto(pageUrlWith(ORIGIN, extra), { waitUntil: 'domcontentloaded' })
    return
  }
  await page.goto(pageUrl(extra), { waitUntil: 'domcontentloaded' })
}

/** Authenticated request context for host RPC seeding (cookie attached). */
export async function createHostApi(): Promise<APIRequestContext> {
  if (cookieHeader === undefined) {
    cookieHeader = await exchangeLaunchCookie(RAW_URL)
  }
  return request.newContext({
    baseURL: ORIGIN,
    extraHTTPHeaders: { cookie: cookieHeader },
  })
}

/** The unwrapped `result` of a successful host RPC. */
export interface HostRpcOk<T> {
  ok: true
  value: T
}

let rpcCounter = 0

/** Call a host unary RPC (`'workspace.create'`, `'session.create'`, …).
 *  Throws with the response body when the HTTP call or the envelope result
 *  fails — the lanes' seeding treats any failure as fatal, so the error text
 *  carries everything a report needs. */
export async function hostRpc<T = unknown>(
  api: APIRequestContext,
  method: string,
  args: Record<string, unknown> = {},
): Promise<HostRpcOk<T>> {
  const attempt = rpcAttempt(method, args)
  rpcCounter += 1
  const rpcId = `e2e-${method}-${rpcCounter}`
  const res = await api.post(attempt.path, {
    data: { type: 'client-request', rpcId, method: attempt.method, payload: attempt.payload },
  })
  const bodyText = await res.text()
  if (!res.ok()) {
    throw new Error(`hostRpc ${method} [${attempt.path}] HTTP ${res.status()}: ${bodyText.slice(0, 400)}`)
  }
  let envelope: { type?: string; result?: { ok: true; value: T } | { ok: false; error: unknown } }
  try {
    envelope = JSON.parse(bodyText) as typeof envelope
  } catch {
    throw new Error(`hostRpc ${method} [${attempt.path}]: non-JSON response: ${bodyText.slice(0, 400)}`)
  }
  const result = envelope.result
  if (result === undefined || result.ok !== true) {
    throw new Error(`hostRpc ${method} [${attempt.path}] envelope error: ${bodyText.slice(0, 400)}`)
  }
  return result
}
