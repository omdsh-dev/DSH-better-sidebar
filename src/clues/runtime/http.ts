/**
 * The S2 HTTP boundary.
 *
 * A source plugin never calls `fetch` directly: this module owns the rules from
 * the approved spec §3:
 * - the target host is checked against the connection's allowlist before any
 *   byte leaves the process;
 * - a secret is resolved PER OPERATION from the host credential seam (never
 *   copied into preferences, clues, exports or a cache). Caller-supplied
 *   `authorization`/`cookie` headers are refused — secrets use the seam;
 * - redirects are followed MANUALLY and only same-origin; an authenticated
 *   request is never bounced to another host or downgraded from https;
 * - caller cancellation and the operation timeout both abort the fetch;
 * - the response body is capped explicitly (`truncated`), pagination links are
 *   exposed through the safe header projection, and failures never echo request
 *   headers, tokens, raw bodies or provider diagnostics.
 */
import { ClueError, isClueError } from '../error.ts'
import type {
  ClueFetch,
  ClueFetchResponse,
  ClueHttpClient,
  ClueHttpRequest,
  ClueHttpResult,
} from './types.ts'

/** Default per-request budget. */
export const DEFAULT_HTTP_TIMEOUT_MS = 20_000
/** Default response-body cap (explicit truncation beyond it). */
export const DEFAULT_HTTP_MAX_RESPONSE_BYTES = 2 << 20
/** Default redirect budget (same-origin only). */
export const DEFAULT_HTTP_MAX_REDIRECTS = 3

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** Response headers safe to hand to a source adapter (no cookies/secrets). */
const SAFE_RESPONSE_HEADERS: readonly string[] = [
  'content-type',
  'content-length',
  'link',
  'etag',
  'last-modified',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
]

/** Caller headers that must come from the credential seam or the host. */
const FORBIDDEN_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
])

/** Headers that can never carry a connection credential. */
const FORBIDDEN_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  'cookie',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
])

/** Options of {@link createHttpClient}. */
export interface HttpClientOptions {
  /** Host fetch (tests inject a fake; production passes globalThis.fetch). */
  readonly fetch: ClueFetch
  /** Resolve a named host credential for ONE operation (never cached here). */
  readonly resolveCredential?: (ref: string) => Promise<string | undefined>
  readonly defaultTimeoutMs?: number
  readonly defaultMaxResponseBytes?: number
  readonly defaultMaxRedirects?: number
}

/** Whether an optional signal has been aborted (opaque to TS narrowing). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Validate the URL and method; invalid input is a fixed clue category. */
function parseTarget(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ClueError('invalid-request', 'the HTTP request needs an absolute URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ClueError('invalid-request', 'the HTTP request needs an http(s) URL')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ClueError('invalid-request', 'credentials must not be embedded in the request URL')
  }
  return parsed
}

/** Validate caller headers: strings only, no credential/hop-by-hop names. */
function requestHeadersOf(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase()
    if (FORBIDDEN_REQUEST_HEADERS.has(lower)) {
      throw new ClueError(
        'invalid-request',
        `the "${lower}" header must be supplied through the credential seam, not by the source`,
      )
    }
    if (typeof value !== 'string') {
      throw new ClueError('invalid-request', `the "${name}" header value must be a string`)
    }
    out[lower] = value
  }
  return out
}

/** Same-origin comparison (scheme + host + port). */
function sameOrigin(left: URL, right: URL): boolean {
  return left.protocol === right.protocol && left.host === right.host
}

/** Read a bounded response body (explicit truncation, no silent loss). */
async function readResponseText(
  response: ClueFetchResponse,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  if (response.body !== undefined && response.body !== null) {
    const chunks: Buffer[] = []
    let total = 0
    let truncated = false
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      const remaining = limit - total
      if (value.byteLength <= remaining) {
        chunks.push(Buffer.from(value))
        total += value.byteLength
        continue
      }
      if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)))
      truncated = true
      await reader.cancel().catch(() => undefined)
      break
    }
    return { text: Buffer.concat(chunks).toString('utf8'), truncated }
  }
  if (response.text !== undefined) {
    const text = await response.text()
    const buffer = Buffer.from(text, 'utf8')
    if (buffer.length <= limit) return { text, truncated: false }
    const slice = buffer.subarray(0, limit).toString('utf8')
    return {
      text: slice.endsWith('\uFFFD') ? slice.slice(0, -1) : slice,
      truncated: true,
    }
  }
  return { text: '', truncated: false }
}

/** Copy the safe header projection (lowercase names). */
function safeHeaders(response: ClueFetchResponse): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = response.headers.get(name)
    if (value !== null) out[name] = value
  }
  return out
}

/**
 * Throw the matching fixed category for a failed HTTP status. Adapters call this
 * after checking a provider's own success envelope; it never reads the body.
 */
export function requireHttpOk(result: ClueHttpResult): ClueHttpResult {
  const status = result.status
  if (status >= 200 && status < 300) return result
  if (status === 401) throw new ClueError('auth-required', 'the remote service requires authorization')
  if (status === 403) throw new ClueError('permission-denied', 'the remote service denied this operation')
  if (status === 404) throw new ClueError('not-found', 'the remote resource does not exist')
  if (status === 409) throw new ClueError('conflict', 'the remote resource changed')
  if (status === 429) throw new ClueError('rate-limited', 'the remote service asked the caller to slow down')
  if (status >= 500) throw new ClueError('failed', `the remote service failed (HTTP ${status})`)
  throw new ClueError('invalid-request', `the remote service rejected the request (HTTP ${status})`)
}

/**
 * Create the HTTP client.
 * @param options - injected fetch + per-operation credential resolver.
 */
export function createHttpClient(options: HttpClientOptions): ClueHttpClient {
  const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  const defaultMaxBytes = options.defaultMaxResponseBytes ?? DEFAULT_HTTP_MAX_RESPONSE_BYTES
  const defaultMaxRedirects = options.defaultMaxRedirects ?? DEFAULT_HTTP_MAX_REDIRECTS

  return {
    async request(request: ClueHttpRequest, callOptions: { readonly signal?: AbortSignal } = {}): Promise<ClueHttpResult> {
      let current = parseTarget(request.url)
      const headers = requestHeadersOf(request.headers)
      const allowedHosts = request.allowedHosts
      if (allowedHosts !== undefined && allowedHosts.length > 0) {
        const host = current.hostname.toLowerCase()
        if (!allowedHosts.some(entry => entry.toLowerCase() === host)) {
          throw new ClueError('permission-denied', 'the request target host is not allowed for this connection')
        }
      }
      const externalSignal = callOptions.signal ?? request.signal
      if (isAborted(externalSignal)) throw new ClueError('cancelled', 'the HTTP request was cancelled')
      const timeoutMs = request.timeoutMs ?? defaultTimeout
      const maxBytes = request.maxResponseBytes ?? defaultMaxBytes
      const maxRedirects = request.maxRedirects ?? defaultMaxRedirects
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
        throw new ClueError('invalid-request', 'the HTTP timeout must be a positive integer')
      }
      if (!Number.isInteger(maxBytes) || maxBytes < 1) {
        throw new ClueError('invalid-request', 'the HTTP response cap must be a positive integer')
      }

      // Secrets are resolved ONCE for THIS operation. They are never cached and
      // never appear in a result or error.
      let secret: string | undefined
      if (request.credential !== undefined) {
        const header = request.credential.header?.toLowerCase() ?? 'authorization'
        if (FORBIDDEN_CREDENTIAL_HEADERS.has(header)) {
          throw new ClueError('invalid-request', `the "${header}" header cannot carry a connection credential`)
        }
        if (/[\r\n]/.test(request.credential.prefix ?? '') || /[\r\n]/.test(request.credential.header ?? '')) {
          throw new ClueError('invalid-request', 'the credential header must not contain line breaks')
        }
        if (options.resolveCredential === undefined) {
          throw new ClueError('auth-required', 'the host credential provider is not available')
        }
        secret = await options.resolveCredential(request.credential.ref)
        if (secret === undefined || secret === '') {
          throw new ClueError('auth-required', 'the required host credential is not configured')
        }
        if (/[\r\n]/.test(secret)) {
          throw new ClueError('auth-required', 'the resolved host credential is not a valid header value')
        }
      }

      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      timer.unref?.()
      const onAbort = (): void => controller.abort()
      externalSignal?.addEventListener('abort', onAbort, { once: true })

      let method = request.method ?? 'GET'
      let body = request.body
      let redirects = 0
      try {
        while (true) {
          if (isAborted(externalSignal)) throw new ClueError('cancelled', 'the HTTP request was cancelled')
          if (timedOut) throw new ClueError('timeout', 'the HTTP request timed out')
          const outboundHeaders: Record<string, string> = { ...headers }
          if (request.credential !== undefined && secret !== undefined) {
            const header = (request.credential.header ?? 'authorization').toLowerCase()
            const prefix = request.credential.prefix ?? 'Bearer '
            outboundHeaders[header] = `${prefix}${secret}`
          }
          let response: ClueFetchResponse
          try {
            response = await options.fetch(current.toString(), {
              method,
              headers: outboundHeaders,
              ...(body === undefined ? {} : { body }),
              redirect: 'manual',
              signal: controller.signal,
            })
          } catch (error) {
            if (isAborted(externalSignal)) throw new ClueError('cancelled', 'the HTTP request was cancelled')
            if (timedOut) throw new ClueError('timeout', 'the HTTP request timed out')
            if (isClueError(error)) throw error
            throw new ClueError('failed', 'the HTTP request failed')
          }
          if (REDIRECT_STATUSES.has(response.status)) {
            const location = response.headers.get('location')
            if (location === null || location === '') {
              throw new ClueError('failed', 'the remote service answered a redirect without a location')
            }
            if (redirects >= maxRedirects) {
              throw new ClueError('failed', 'the remote service redirected too many times')
            }
            let next: URL
            try {
              next = new URL(location, current)
            } catch {
              throw new ClueError('failed', 'the remote service answered an invalid redirect location')
            }
            // Same-origin only: never forward an authorization header to a
            // different host, and never downgrade https to http.
            if (!sameOrigin(next, current)) {
              throw new ClueError(
                'permission-denied',
                'refused to follow a redirect to a different host',
              )
            }
            if (allowedHosts !== undefined && allowedHosts.length > 0
              && !allowedHosts.some(entry => entry.toLowerCase() === next.hostname.toLowerCase())) {
              throw new ClueError('permission-denied', 'the redirect target host is not allowed for this connection')
            }
            if (
              (response.status === 303)
              || ((response.status === 301 || response.status === 302) && method === 'POST')
            ) {
              method = 'GET'
              body = undefined
            }
            current = next
            redirects += 1
            continue
          }
          let bodyResult: { text: string; truncated: boolean }
          try {
            bodyResult = await readResponseText(response, maxBytes)
          } catch (error) {
            if (isAborted(externalSignal)) throw new ClueError('cancelled', 'the HTTP request was cancelled')
            if (timedOut) throw new ClueError('timeout', 'the HTTP request timed out')
            if (isClueError(error)) throw error
            throw new ClueError('failed', 'the HTTP response could not be read')
          }
          const { text, truncated } = bodyResult
          return {
            status: response.status,
            url: current.toString(),
            headers: safeHeaders(response),
            text,
            truncated,
            redirects,
          }
        }
      } catch (error) {
        if (isAborted(externalSignal)) throw new ClueError('cancelled', 'the HTTP request was cancelled')
        if (timedOut) throw new ClueError('timeout', 'the HTTP request timed out')
        throw error
      } finally {
        clearTimeout(timer)
        externalSignal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
