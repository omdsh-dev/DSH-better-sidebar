#!/usr/bin/env node
/**
 * Built-artifact identity guard for the clue surface (runs AFTER `pnpm build`).
 *
 * The host bundle (`lib/index.js`) and the public `./clues` artifact
 * (`lib/clues.js`) are separate builds, but they are loaded in ONE process:
 * an external source plugin throws `ClueError` imported from
 * `dsh-better-sidebar/clues` at the host service. If the host bundle inlined
 * its own copy of the class, every `instanceof` check would fail and the fixed
 * category (auth-required / conflict / not-found / …) would collapse to
 * "failed" (service) or 500 internal (wire).
 *
 * This probe mounts the BUILT host against a fake context, registers an API
 * handler that throws the BUILT public `ClueError`, and drives it through the
 * real `/sidebar/api` dispatcher. The expected 403 `auth-required` envelope is
 * only reachable when both artifacts share one class object. A raw handler
 * error is checked too: it must be normalized (no token in the 500 envelope).
 *
 * It also proves the host and the clue entry share the host's fs module state:
 * a file created through the host write route must show up in an immediately
 * following `clues.list` (a separate fs-tree copy would serve a stale cache).
 *
 * Invoked by `scripts/check-consumer-types.sh`, which already requires a build.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const label = '[check-clue-artifact]'

/** Fail the check with a clear reason. */
function fail(message) {
  console.error(`${label} FAIL: ${message}`)
  process.exit(1)
}

let host
let clues
try {
  host = await import(pathToFileURL(join(repoRoot, 'lib', 'index.js')).href)
  clues = await import(pathToFileURL(join(repoRoot, 'lib', 'clues.js')).href)
} catch (error) {
  fail(`cannot load the built artifacts (run 'pnpm build' first): ${error instanceof Error ? error.message : String(error)}`)
}
if (typeof host.apply !== 'function') fail('lib/index.js does not export apply()')
if (typeof clues.ClueError !== 'function') fail('lib/clues.js does not export ClueError')

const base = mkdtempSync(join(tmpdir(), 'dsh-clue-artifact-'))
const home = join(base, 'home')
const workspace = join(base, 'workspace')
mkdirSync(home, { recursive: true })
mkdirSync(workspace, { recursive: true })

/** Everything the host `apply()` touches on the fake context. */
const provided = new Map()
const effects = []
const routes = []
const registry = { get: id => (id === 'ws-1' ? { path: workspace } : undefined) }
const ctx = {
  connection: { requestRejection: () => undefined },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
    registerUpgrade() {
      return () => {}
    },
  },
  sessions: { get: () => undefined },
  tools: { register: () => () => {} },
  effect(fn) {
    const cleanup = fn()
    if (typeof cleanup === 'function') effects.push(cleanup)
  },
  inject() {
    return () => {}
  },
  on() {
    return () => {}
  },
  get(key) {
    if (key === 'betterSidebarClues') return provided.get(key)
    if (key === 'workspaceRegistry') return registry
    return undefined
  },
  provide(name, value) {
    provided.set(name, value)
  },
  profileContext: { home },
  workspaceRegistry: registry,
  logger: { warn() {}, info() {} },
}

/** POST one raw body through a captured route; return {status, body}. */
async function request(route, url, body) {
  const req = {
    url,
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body)
    },
  }
  let status = 0
  let raw = ''
  const res = {
    statusCode: 0,
    headersSent: false,
    writeHead(code) {
      status = code
      res.statusCode = code
      res.headersSent = true
    },
    write() {
      return true
    },
    end(chunk) {
      raw += chunk === undefined ? '' : String(chunk)
    },
    destroy() {},
    once() {},
    off() {},
  }
  await route.handler(req, res)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(`${url} answered a non-JSON body: ${raw.slice(0, 200)}`)
  }
  return { status, body: parsed }
}

/** POST one JSON payload through the `/sidebar/api` dispatcher. */
async function post(route, method, payload) {
  return request(route, `/sidebar/api/${method}`, JSON.stringify(payload ?? {}))
}

try {
  host.apply(ctx)
  const route = routes.find(candidate => candidate.path === '/sidebar/api')
  if (route === undefined) fail('apply() did not register /sidebar/api')
  const service = provided.get('betterSidebarClues')
  if (service === undefined) fail('apply() did not provide the betterSidebarClues service')

  // An external source plugin raises the class it imported from ./clues.
  service.registerApi('probe.external-clue-error', () => {
    throw new clues.ClueError('auth-required', 'sign in to continue')
  })
  const external = await post(route, 'probe.external-clue-error', {})
  if (external.status !== 403 || external.body?.error?.code !== 'auth-required') {
    fail(
      'a ClueError thrown by an external source did not keep its category: '
      + `expected 403 auth-required, got ${external.status} ${JSON.stringify(external.body)}`,
    )
  }

  // A raw handler failure (S2+ CLI/HTTP output) must not leak its message.
  const secret = 'Authorization: Bearer top-secret-token'
  service.registerApi('probe.raw-error', () => {
    throw new Error(secret)
  })
  const raw = await post(route, 'probe.raw-error', {})
  if (raw.status !== 500) fail(`a raw handler error should be a 500 clue failure, got ${raw.status}`)
  if (raw.body?.error?.message?.includes('top-secret')) {
    fail('a raw handler error leaked its message into the 500 envelope')
  }

  // Module-state identity: only the ERROR class is externalized. If the whole
  // clue entry were externalized again, lib/clues.js would carry a SECOND copy
  // of fs-tree, and a host-side write would not invalidate the directory cache
  // the clue listing reads (the listing would stay stale for its 1.5 s TTL).
  const writeRoute = routes.find(candidate => candidate.path === '/sidebar/write')
  if (writeRoute === undefined) fail('apply() did not register /sidebar/write')
  const warm = await post(route, 'clues.list', { workspaceId: 'ws-1', sourceId: 'builtin.files' })
  if (warm.status !== 200) fail(`clues.list failed before the cache probe: ${warm.status}`)
  const params = new URLSearchParams({ sessionId: 'probe', path: 'cache-probe.txt', cwd: workspace })
  const written = await request(writeRoute, `/sidebar/write?${params.toString()}`, 'probe\n')
  if (written.status !== 200) {
    fail(`the host write route failed during the cache probe: ${written.status} ${JSON.stringify(written.body)}`)
  }
  const listed = await post(route, 'clues.list', { workspaceId: 'ws-1', sourceId: 'builtin.files' })
  const items = Array.isArray(listed.body?.value?.items) ? listed.body.value.items : []
  if (!items.some(item => item.title === 'cache-probe.txt')) {
    fail(
      'a host-side write did not invalidate the fs-tree cache the clue list reads '
      + '(lib/index.js and lib/clues.js do not share module state)',
    )
  }

  console.log(`${label} OK: lib/index.js and lib/clues.js share ONE ClueError (categories survive the wire) and the host fs caches.`)
} finally {
  for (const cleanup of effects.reverse()) {
    try {
      cleanup()
    } catch {
      // Teardown of the probe must not mask the assertion result.
    }
  }
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
