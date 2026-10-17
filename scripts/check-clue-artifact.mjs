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

/** POST one JSON payload through a captured route; return {status, body}. */
async function post(route, method, payload) {
  const body = JSON.stringify(payload ?? {})
  const req = {
    url: `/sidebar/api/${method}`,
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
    fail(`${method} answered a non-JSON body: ${raw.slice(0, 200)}`)
  }
  return { status, body: parsed }
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

  console.log(`${label} OK: lib/index.js and lib/clues.js share ONE ClueError (categories survive the wire).`)
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
