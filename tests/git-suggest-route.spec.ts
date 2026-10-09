/**
 * The `git.suggest-message` HOST ROUTE's own contract, over the real
 * `/sidebar/api` surface: the provider/model route one suggestion runs on
 * (pinned → the conversation's own → the harness default → a clean error), the
 * prompt assembly and diff truncation, every generation bound handed to the
 * harness LLM service, the answer shape `src/client/api.ts` declares, the
 * error mapping, and the invariant that a suggestion never writes to the
 * repository.
 *
 * The three suites around this route each cover another layer and none of them
 * covers the route body: `tests/commit-message.spec.ts` pins the pure
 * vocabulary (prompt wording, route parse, cleanup), `tests/git-suggest.spec.tsx`
 * the panel, `tests/commit-model-settings.spec.tsx` the settings card. The
 * route cases that used to exist were deleted together with the implementation
 * they pinned (a folded `requestHeader()` and a 200-token budget), which left
 * the fallback chain, the generation bounds and the safety invariant unguarded.
 *
 * The model is a fake `ctx.llm` (a real call would need credentials), the
 * session / default-selection / settings faces are fake too, and the repository
 * is real — the same harness as tests/git-remote-actions.spec.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync, type SpawnOptions } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { SUGGEST_DIFF_LIMIT, truncateDiff } from '../src/commit-message.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

/** Every git process the plugin spawned, in call order (argv without the
 *  binary). The safety invariant is asserted at the PROCESS BOUNDARY, so it
 *  holds whichever layer issues the call. */
const gitArgv = vi.hoisted(() => [] as string[][])

// `spawnSync` stays real: it is how the fixtures below build repositories.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: SpawnOptions) => {
      if (command === 'git') gitArgv.push([...args])
      return actual.spawn(command, args, options)
    },
  }
})

/** Fixture commit identity, confined to this process: no git config is touched. */
const FIXTURE_IDENTITY = {
  GIT_AUTHOR_NAME: 'dsh-better-sidebar-test',
  GIT_AUTHOR_EMAIL: 'test@dsh.invalid',
  GIT_COMMITTER_NAME: 'dsh-better-sidebar-test',
  GIT_COMMITTER_EMAIL: 'test@dsh.invalid',
}

/** Run one git command (throws on a non-zero exit). */
function gitRun(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, '--no-pager', '-c', 'color.ui=false', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...FIXTURE_IDENTITY },
  })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0] ?? ''} exited with ${String(result.status)}`)
  return result.stdout
}

/** A repository on `main` with one commit over `a.txt` / `b.txt` and a clean tree. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-suggest-'))
  gitRun(dir, ['init', '-q'])
  // Pin the eol policy: Git for Windows defaults to core.autocrlf=true, which
  // would smudge the byte-exact prompt assertions below.
  gitRun(dir, ['config', 'core.autocrlf', 'false'])
  gitRun(dir, ['checkout', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(dir, 'b.txt'), 'base\n')
  gitRun(dir, ['add', '-A'])
  gitRun(dir, ['commit', '-q', '-m', 'base'])
  return dir
}

/** The same repository with one pending UNSTAGED edit (the "nothing staged" branch). */
function makePendingRepo(): string {
  const dir = makeRepo()
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  return dir
}

/** One `request/header` event as the session log carries it. */
function headerEvent(provider: string, model: string): { type: string; data: unknown } {
  return { type: 'request/header', data: { header: { config: { provider, model } } } }
}

/** One recorded `llm.stream` call: the fields this route must fill. */
interface StreamCall {
  provider?: string
  model?: string
  system?: string
  messages?: readonly { role?: string; content?: readonly { type?: string; text?: string }[] }[]
  maxTokens?: number
  reasoningEffort?: string
  signal?: AbortSignal
}

/** The fake model's behaviour, swapable between two invocations in one case. */
interface FakeModel {
  /** Chunks the stream yields (default: one text delta + a clean finish). */
  chunks?: readonly unknown[]
  /** When set, the stream fails with it on the first pull. */
  fail?: Error
  /** `resolveModelInfo` answer (the reasoning-effort source). */
  info?: unknown
}

/** Service faces a route call may read, mutable so one case can cover two. */
interface FakeServices {
  llm?: unknown
  agents?: unknown
  agentDefaultModel?: unknown
}

interface Harness {
  route: SidebarWebRoute
  /** Every `llm.stream` argument, in call order. */
  calls: StreamCall[]
  /** Every git argv spawned since the mount (shared with the module mock). */
  gitArgv: string[][]
  model: FakeModel
  services: FakeServices
}

/** The default fake answer: one text delta and a clean finish. */
const DEFAULT_CHUNKS: readonly unknown[] = [
  { type: 'text-delta', index: 0, text: 'feat: add the thing' },
  { type: 'finish', reason: { kind: 'stop' } },
]

/**
 * The fake model's stream. A configured failure throws on the first pull — the
 * shape a provider failure really has, so the route's own `for await` is what
 * has to contain it.
 */
async function* fakeStream(fail: Error | undefined, chunks: readonly unknown[]): AsyncGenerator<unknown> {
  if (fail !== undefined) throw fail
  for (const chunk of chunks) yield chunk
}

/** The user half the route put in `messages` (it sends exactly one message). */
function userTextOf(call: StreamCall | undefined): string {
  const blocks = call?.messages?.[0]?.content ?? []
  return blocks.map(block => (block.type === 'text' ? block.text ?? '' : '')).join('')
}

/** This plugin's Loader row id (the settings namespace `ownEntryId` discovers). */
const ENTRY_ID = 'better-sidebar'

/**
 * Mount the plugin's `/sidebar/api` route against a minimal fake context: a
 * fake model, fake session/agent/default-selection faces, and a fake settings
 * forms service carrying the pinned route.
 */
function mount(setup: {
  /** The Git card's pinned route (`pluginSettings.git.commitModel`). */
  pinned?: string
  /** The session log; its newest `request/header` is the conversation's route. */
  events?: readonly unknown[]
  /** The live agent's own options, when the session is attached. */
  agentOptions?: { provider?: string; model?: string }
  /** `agentDefaultModel.currentSelection()`. */
  defaultSelection?: unknown
  /** Fake model behaviour. */
  model?: FakeModel
} = {}): Harness {
  const calls: StreamCall[] = []
  const model: FakeModel = setup.model ?? {}
  const events = setup.events ?? []
  const agentOptions = setup.agentOptions
  const llm = {
    stream: (options: unknown) => {
      calls.push(options as StreamCall)
      return fakeStream(model.fail, model.chunks ?? DEFAULT_CHUNKS)
    },
    resolveModelInfo: (_provider: string, _model: string) => Promise.resolve(model.info),
  }
  const services: FakeServices = {
    llm,
    agents: { get: (_id: string) => (agentOptions === undefined ? undefined : { options: agentOptions }) },
    agentDefaultModel: { currentSelection: () => setup.defaultSelection },
  }
  // The settings face is filled through `ctx.inject(['settings'], …)`, and it
  // only exists when `ownEntryId` finds this package's row (matched by fiber).
  const fiber = {}
  const settings = {
    configure: () => undefined,
    describe: () => [{
      ns: ENTRY_ID,
      value: { pluginSettings: { git: setup.pinned === undefined ? {} : { commitModel: setup.pinned } } },
      revision: 1,
      user: {},
    }],
    update: () => Promise.resolve(undefined),
  }
  const routes: SidebarWebRoute[] = []
  const ctx = {
    fiber,
    loader: {
      entries: () => [{ options: { id: ENTRY_ID, name: 'dsh-better-sidebar' }, fiber, disabled: false }],
    },
    logger: { info: () => {}, warn: () => {} },
    profileContext: undefined,
    webRuntime: { trustedHosts: [] },
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: (_route: SidebarWebUpgradeRoute) => () => {},
    },
    sessions: { get: (_id: string) => ({ header: {}, snapshotEvents: () => [...events] }) },
    tools: { register: () => () => {} },
    // The vendored cordis runs registration effects immediately.
    effect: (fn: () => void | (() => void)) => { fn() },
    inject: (deps: readonly string[], cb: (sctx: unknown) => void) => {
      if (deps.includes('settings')) cb({ settings })
      return () => {}
    },
    on: () => () => {},
    get: (name: string) => (services as Record<string, unknown>)[name],
  }
  apply(ctx as never)
  const route = routes.find(entry => entry.path === '/sidebar/api')
  if (route === undefined) throw new Error('the /sidebar/api route was not registered')
  gitArgv.length = 0
  return { route, calls, gitArgv, model, services }
}

interface Invoked<T> {
  ok: boolean
  status: number
  value?: T
  error?: { code?: string; message: string }
}

/** One POST through the mounted route, exactly as the web server would issue it. */
async function invoke<T = unknown>(route: SidebarWebRoute, method: string, payload: unknown): Promise<Invoked<T>> {
  const body = Buffer.from(JSON.stringify(payload))
  const req = {
    method: 'POST',
    url: `/sidebar/api/${method}`,
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () { yield body },
  } as never
  const out = { status: 200, body: '' }
  const res = {
    writeHead: (status: number) => { out.status = status },
    end: (chunk: unknown) => { out.body += String(chunk ?? '') },
  } as never
  await route.handler(req, res)
  return { ...JSON.parse(out.body) as Invoked<T>, status: out.status }
}

/** The git subcommand of one recorded argv: the first token that is neither a
 *  global option nor an option value (`runGit` always prefixes
 *  `-C <cwd> --no-pager -c k=v -c k=v`). */
function subcommandOf(argv: readonly string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? ''
    if (token === '-C' || token === '-c') {
      index += 1
      continue
    }
    if (token.startsWith('-')) continue
    return token
  }
  return ''
}

/** Subcommands that would change the repository (index, worktree, refs or the
 *  remote). A suggestion may read; it must never write. */
const WRITE_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'fetch', 'merge', 'mv',
  'pull', 'push', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch', 'tag', 'update-index',
])

afterEach(() => {
  vi.restoreAllMocks()
})

describe('git.suggest-message: model route fallback chain', () => {
  it('prefers the route pinned in the Git card settings', async () => {
    const dir = makePendingRepo()
    try {
      // Every other source is available and reachable: the pin must still win.
      const harness = mount({
        pinned: 'pinned-prov/model-x',
        agentOptions: { provider: 'conversation-prov', model: 'conversation-model' },
        events: [headerEvent('log-prov', 'log-model')],
        defaultSelection: { provider: 'harness-prov', model: 'harness-model' },
      })

      const result = await invoke(harness.route, 'git.suggest-message', { sessionId: 's-pinned', cwd: dir, language: 'en' })

      expect(result.ok).toBe(true)
      expect(result.value).toMatchObject({ provider: 'pinned-prov', model: 'model-x' })
      expect(harness.calls).toHaveLength(1)
      expect(harness.calls[0]).toMatchObject({ provider: 'pinned-prov', model: 'model-x' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('follows the conversation\'s own route when nothing is pinned', async () => {
    const dir = makePendingRepo()
    try {
      const harness = mount({
        agentOptions: { provider: 'conversation-prov', model: 'conversation-model' },
        defaultSelection: { provider: 'harness-prov', model: 'harness-model' },
      })

      const result = await invoke(harness.route, 'git.suggest-message', { sessionId: 's-conv', cwd: dir, language: 'en' })

      expect(result.ok).toBe(true)
      expect(result.value).toMatchObject({ provider: 'conversation-prov', model: 'conversation-model' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the conversation route off the newest request/header event', async () => {
    const dir = makePendingRepo()
    try {
      // A detached session has no live agent, but its log records what the
      // conversation actually dispatched on — newest first.
      const harness = mount({
        events: [
          { type: 'user/message', data: {} },
          headerEvent('older-prov', 'older-model'),
          { type: 'assistant/message', data: {} },
          headerEvent('newest-prov', 'newest-model'),
        ],
        defaultSelection: { provider: 'harness-prov', model: 'harness-model' },
      })

      const result = await invoke(harness.route, 'git.suggest-message', { sessionId: 's-log', cwd: dir, language: 'en' })

      expect(result.ok).toBe(true)
      expect(result.value).toMatchObject({ provider: 'newest-prov', model: 'newest-model' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the harness default selection on a conversation with no route yet', async () => {
    const dir = makePendingRepo()
    try {
      // A session that has not sent its first message: attached but route-less,
      // and its log carries no `request/header` at all.
      const harness = mount({
        events: [{ type: 'user/message', data: {} }],
        agentOptions: {},
        defaultSelection: { provider: 'harness-prov', model: 'harness-model' },
      })

      const result = await invoke(harness.route, 'git.suggest-message', { sessionId: 's-default', cwd: dir, language: 'en' })

      expect(result.ok).toBe(true)
      expect(result.value).toMatchObject({ provider: 'harness-prov', model: 'harness-model' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers a clean 503 when no route resolves at all, without calling the model', async () => {
    const dir = makePendingRepo()
    try {
      const harness = mount({ events: [], agentOptions: {}, defaultSelection: undefined })

      const result = await invoke(harness.route, 'git.suggest-message', { sessionId: 's-none', cwd: dir, language: 'en' })

      // An error RESULT, never an uncaught exception: the panel renders the
      // message instead of the route taking the request down.
      expect(result.ok).toBe(false)
      expect(result.status).toBe(503)
      expect(result.error?.code).toBe('git-suggest-error')
      expect(result.error?.message).toContain('model route')
      // Nothing was generated and, above all, nothing was committed.
      expect(harness.calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('git.suggest-message: prompt and generation bounds', () => {
  it('hands the LLM the assembled prompt and every generation bound', async () => {
    const dir = makePendingRepo()
    // Spy through, so the signal the route creates is the real one.
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      const harness = mount({
        agentOptions: { provider: 'conversation-prov', model: 'conversation-model' },
        model: { info: { reasoning: { efforts: [{ id: 'high' }, { id: 'off' }] } } },
      })

      const result = await invoke(harness.route, 'git.suggest-message', { sessionId: 's-params', cwd: dir, language: 'en' })

      expect(result.ok).toBe(true)
      const call = harness.calls[0]
      expect(call?.provider).toBe('conversation-prov')
      expect(call?.model).toBe('conversation-model')
      // The prompt halves: the system instruction plus the file list and the
      // patch the model is asked to summarize.
      expect(call?.system).toContain('You are a git commit message assistant')
      expect(call?.messages).toHaveLength(1)
      expect(call?.messages?.[0]?.role).toBe('user')
      const user = userTextOf(call)
      expect(user).toContain('Changed files:\na.txt\n\nDiff:\n')
      expect(user).toContain('+three')
      // The output budget is the one-line allowance, not the provider default.
      expect(call?.maxTokens).toBe(512)
      // Commit drafting needs no deliberation: the LOWEST advertised effort.
      expect(call?.reasoningEffort).toBe('off')
      // The deadline is attached to the request itself.
      expect(timeout).toHaveBeenCalledWith(30_000)
      expect(call?.signal).toBe(timeout.mock.results[0]?.value)
      expect(call?.signal?.aborted).toBe(false)
    } finally {
      vi.restoreAllMocks()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('omits the reasoning effort for a model that advertises none', async () => {
    const dir = makePendingRepo()
    try {
      // Requesting an effort a non-reasoning model does not support is rejected
      // by the harness, so the field must be ABSENT, not undefined-valued.
      const harness = mount({
        agentOptions: { provider: 'p', model: 'm' },
        model: { info: { reasoning: { efforts: [] } } },
      })

      const result = await invoke(harness.route, 'git.suggest-message', { sessionId: 's-noreason', cwd: dir, language: 'en' })

      expect(result.ok).toBe(true)
      const call = harness.calls[0]
      expect(call).toBeDefined()
      expect(Object.hasOwn(call ?? {}, 'reasoningEffort')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('truncates an oversized diff and marks the cut', async () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'big.txt'), `${'x'.repeat(20_000)}\n`)
      gitRun(dir, ['add', '-A'])
      gitRun(dir, ['commit', '-q', '-m', 'big file'])
      writeFileSync(join(dir, 'big.txt'), `${'y'.repeat(20_000)}\n`)
      const realDiff = gitRun(dir, ['diff', '--no-ext-diff', '--no-color', '-U3'])
      // The case is only meaningful while the patch really is oversized.
      expect(realDiff.length).toBeGreaterThan(SUGGEST_DIFF_LIMIT)

      const harness = mount({ agentOptions: { provider: 'p', model: 'm' } })
      const result = await invoke(harness.route, 'git.suggest-message', { sessionId: 's-big', cwd: dir, language: 'en' })

      expect(result.ok).toBe(true)
      const user = userTextOf(harness.calls[0])
      // Exactly the truncated patch (same helper the route uses) and its marker…
      expect(user).toContain(truncateDiff(realDiff))
      expect(user).toContain('...(diff truncated)')
      // …and never the whole patch, which is what flooding the model means.
      expect(user).not.toContain(realDiff)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('asks in the panel\'s language and defaults to English', async () => {
    const dir = makePendingRepo()
    try {
      const harness = mount({ agentOptions: { provider: 'p', model: 'm' } })

      await invoke(harness.route, 'git.suggest-message', { sessionId: 's-zh', cwd: dir, language: 'zh' })
      await invoke(harness.route, 'git.suggest-message', { sessionId: 's-unknown', cwd: dir, language: 'klingon' })

      expect(harness.calls[0]?.system).toContain('git 提交信息生成助手')
      expect(userTextOf(harness.calls[0])).toContain('改动的文件')
      expect(harness.calls[1]?.system).toContain('You are a git commit message assistant')
      expect(userTextOf(harness.calls[1])).toContain('Changed files')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('git.suggest-message: answer shape and error mapping', () => {
  it('answers exactly {message, provider, model} with the cleaned, trimmed text', async () => {
    const dir = makePendingRepo()
    try {
      // Models routinely wrap the one-liner in a fence despite the instruction.
      const harness = mount({
        agentOptions: { provider: 'conversation-prov', model: 'conversation-model' },
        model: {
          chunks: [
            { type: 'text-delta', index: 0, text: '\n  ```\nfeat: add the thing\n```  \n' },
            { type: 'finish', reason: { kind: 'stop' } },
          ],
        },
      })

      const result = await invoke<{ message: string; provider: string; model: string }>(
        harness.route,
        'git.suggest-message',
        { sessionId: 's-shape', cwd: dir, language: 'en' },
      )

      expect(result.ok).toBe(true)
      const value = result.value as { message: string; provider: string; model: string }
      // The shape `src/client/api.ts` declares, and nothing else.
      expect(Object.keys(value).sort()).toEqual(['message', 'model', 'provider'])
      expect(value.provider).toBe('conversation-prov')
      expect(value.model).toBe('conversation-model')
      // Unfenced: the panel drops this straight into the commit box.
      expect(value.message).toBe('feat: add the thing')

      // Padding is dropped too — a message the model wrapped in blank lines
      // must not arrive with them.
      harness.model.chunks = [
        { type: 'text-delta', index: 0, text: '\n\n   fix: pad the edges   \n\n' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      const padded = await invoke<{ message: string }>(harness.route, 'git.suggest-message', {
        sessionId: 's-shape-2',
        cwd: dir,
        language: 'en',
      })

      expect(padded.ok).toBe(true)
      expect((padded.value as { message: string }).message).toBe('fix: pad the edges')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maps a model failure to an error result distinguishable from "no model route"', async () => {
    const dir = makePendingRepo()
    try {
      const harness = mount({ agentOptions: { provider: 'p', model: 'm' } })
      // No route at all: the answer the panel shows for an unresolvable model.
      harness.services.agents = undefined
      harness.services.agentDefaultModel = undefined
      const noRoute = await invoke(harness.route, 'git.suggest-message', { sessionId: 's-cmp-a', cwd: dir, language: 'en' })
      // The provider itself fails mid-request.
      harness.services.agents = { get: () => ({ options: { provider: 'p', model: 'm' } }) }
      harness.model.fail = new Error('provider exploded')

      const failed = await invoke(harness.route, 'git.suggest-message', { sessionId: 's-cmp-b', cwd: dir, language: 'en' })

      // A failure is an error RESULT carrying the provider's own text, not a
      // rejection no caller can handle (and not a fabricated commit message).
      expect(failed.ok).toBe(false)
      expect(failed.status).toBe(500)
      expect(failed.error?.code).toBe('internal')
      expect(failed.error?.message).toContain('provider exploded')
      // The two failures stay apart: "no model is configured" is actionable in
      // the settings, "the provider failed" is not.
      expect(failed.status).not.toBe(noRoute.status)
      expect(failed.error?.code).not.toBe(noRoute.error?.code)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a stalled model as the 30s timeout answer', async () => {
    const dir = makePendingRepo()
    try {
      const harness = mount({ agentOptions: { provider: 'p', model: 'm' } })
      harness.model.fail = Object.assign(new Error('the operation was aborted'), { name: 'AbortError' })

      const result = await invoke(harness.route, 'git.suggest-message', { sessionId: 's-stall', cwd: dir, language: 'en' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(504)
      expect(result.error?.code).toBe('git-suggest-error')
      expect(result.error?.message).toContain('30s')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports an empty generation instead of an empty commit message', async () => {
    const dir = makePendingRepo()
    try {
      const harness = mount({ agentOptions: { provider: 'p', model: 'm' } })
      // A reasoning model that spent the whole budget thinking: the finish
      // reason is what tells the user which of the two happened.
      harness.model.chunks = [
        { type: 'reasoning-delta', index: 0, text: 'thinking about it' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]

      const result = await invoke(harness.route, 'git.suggest-message', { sessionId: 's-emptygen', cwd: dir, language: 'en' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(500)
      expect(result.error?.code).toBe('git-suggest-error')
      expect(result.error?.message).toContain('empty message')
      expect(result.error?.message).toContain('finish=stop')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports the dedicated empty-changeset code without asking the model', async () => {
    const dir = makeRepo()
    try {
      const harness = mount({ agentOptions: { provider: 'p', model: 'm' } })

      const result = await invoke(harness.route, 'git.suggest-message', { sessionId: 's-clean', cwd: dir, language: 'en' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error?.code).toBe('git-suggest-empty')
      expect(result.error?.message).toContain('no pending changes')
      expect(harness.calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('git.suggest-message: repository safety', () => {
  it('summarizes the STAGED changes and leaves unstaged work out', async () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nSTAGED-EDIT\n')
      gitRun(dir, ['add', 'a.txt'])
      writeFileSync(join(dir, 'b.txt'), 'base\nUNSTAGED-EDIT\n')

      const harness = mount({ agentOptions: { provider: 'p', model: 'm' } })
      const result = await invoke(harness.route, 'git.suggest-message', { sessionId: 's-staged', cwd: dir, language: 'en' })

      expect(result.ok).toBe(true)
      const user = userTextOf(harness.calls[0])
      // Staged wins: it is exactly what `git commit` would record here.
      expect(user).toContain('Changed files:\na.txt\n\nDiff:\n')
      expect(user).toContain('+STAGED-EDIT')
      expect(user).not.toContain('UNSTAGED-EDIT')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('spawns read-only git only: no index, worktree, ref or remote is touched', async () => {
    const dir = makePendingRepo()
    try {
      const before = {
        porcelain: gitRun(dir, ['status', '--porcelain']),
        head: gitRun(dir, ['rev-parse', 'HEAD']),
        content: readFileSync(join(dir, 'a.txt'), 'utf8'),
      }
      expect(before.porcelain).toBe(' M a.txt\n')

      const harness = mount({ agentOptions: { provider: 'p', model: 'm' } })
      const result = await invoke(harness.route, 'git.suggest-message', { sessionId: 's-safe', cwd: dir, language: 'en' })

      expect(result.ok).toBe(true)
      const commands = harness.gitArgv.map(subcommandOf)
      // The spy is live: the diff really was read through git.
      expect(commands).toContain('status')
      expect(commands).toContain('diff')
      // …and nothing else was written. This is the safety constraint: a
      // suggestion is a read, never a stage/commit/push.
      expect(commands.filter(command => WRITE_SUBCOMMANDS.has(command))).toEqual([])
      // Same evidence at the repository itself, including the index state: the
      // pending edit is still UNSTAGED (' M', not 'M ').
      expect(gitRun(dir, ['status', '--porcelain'])).toBe(before.porcelain)
      expect(gitRun(dir, ['rev-parse', 'HEAD'])).toBe(before.head)
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe(before.content)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
