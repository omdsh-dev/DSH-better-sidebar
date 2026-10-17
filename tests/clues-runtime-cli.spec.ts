/**
 * S2 CLI boundary contract.
 *
 * The cases pin the execution rules from the approved spec with a FAKE spawn
 * (no real user CLI, HOME or Keychain is touched):
 * - argv arrays + `shell: false`, an explicit absolute cwd and structured stdin;
 * - the environment allowlist (dependency extras by name, secret-looking names
 *   always refused: DSH_* and GITHUB_TOKEN never reach the child);
 * - timeout and AbortSignal both kill the child and fail with the fixed
 *   `timeout` / `cancelled` categories;
 * - the per-stream output cap is explicit (`stdoutTruncated`);
 * - stderr is ANSI-stripped and token-redacted; stdout/stderr never enter a
 *   `ClueError` message;
 * - JSON parsing refuses non-zero exits, empty, malformed and truncated output
 *   instead of pretending the command returned an empty list.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClueError } from '../src/clues/error.ts'
import {
  buildCliEnv,
  createCliRunner,
  createNodeSpawn,
  redactCliOutput,
  windowsShimCommandLine,
} from '../src/clues/runtime/cli.ts'
import type {
  CliChildProcess,
  CliCommandRequest,
  CliReadable,
  CliSpawn,
  CliSpawnOptions,
  CliWritable,
} from '../src/clues/runtime/types.ts'

class FakeReadable extends EventEmitter implements CliReadable {
  emitData(chunk: string | Uint8Array): void {
    this.emit('data', chunk)
  }
}

class FakeWritable implements CliWritable {
  data = ''
  ended = false
  private readonly events = new EventEmitter()
  constructor(private readonly finishOnEnd = true) {}
  write(chunk: string | Uint8Array): boolean {
    this.data += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }
  end(): void {
    this.ended = true
    if (this.finishOnEnd) this.events.emit('finish')
  }
  on(event: 'error' | 'finish', listener: ((error: Error) => void) | (() => void)): this {
    this.events.on(event, listener)
    return this
  }
  emitError(error: Error): void {
    this.events.emit('error', error)
  }
}

class FakeChild implements CliChildProcess {
  readonly stdout = new FakeReadable()
  readonly stderr = new FakeReadable()
  readonly stdin: FakeWritable
  readonly kills: Array<string | undefined> = []
  private readonly events = new EventEmitter()

  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly options: CliSpawnOptions,
    private readonly autoCloseOnKill: boolean,
    stdin: FakeWritable = new FakeWritable(),
  ) {
    this.stdin = stdin
  }

  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): this
  on(event: 'error' | 'close', listener: ((error: Error) => void) | ((code: number | null, signal: string | null) => void)): this {
    this.events.on(event, listener)
    return this
  }

  kill(signal?: string): boolean {
    this.kills.push(signal)
    if (this.autoCloseOnKill) {
      queueMicrotask(() => this.close(null, signal ?? 'SIGKILL'))
    }
    return true
  }

  close(code: number | null, signal: string | null = null): void {
    this.events.emit('close', code, signal)
  }

  error(error: Error): void {
    this.events.emit('error', error)
  }
}

interface Harness {
  readonly spawn: CliSpawn
  readonly runs: FakeChild[]
}

function harness(options: { autoCloseOnKill?: boolean; stdin?: FakeWritable } = {}): Harness {
  const runs: FakeChild[] = []
  const spawn: CliSpawn = (command, args, spawnOptions) => {
    const child = new FakeChild(
      command,
      args,
      spawnOptions,
      options.autoCloseOnKill ?? true,
      options.stdin,
    )
    runs.push(child)
    return child
  }
  return { spawn, runs }
}

const CWD = process.platform === 'win32' ? 'C:\\tmp\\clue-work' : '/tmp/clue-work'

function request(overrides: Partial<CliCommandRequest> = {}): CliCommandRequest {
  return {
    command: process.platform === 'win32' ? 'C:\\tools\\gh.exe' : '/opt/tools/gh',
    args: ['issue', 'list', '--json', 'number,title'],
    cwd: CWD,
    ...overrides,
  }
}

const ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/tester',
  LANG: 'en_US.UTF-8',
  GITHUB_TOKEN: 'ghp_shouldneverleak',
  DSH_HOME: '/home/tester/.dsh',
  GH_CONFIG_DIR: '/home/tester/.config/gh',
  SOME_UNLISTED: 'nope',
}

const roots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-clue-cli-'))
  roots.push(path)
  return path
}

describe('CLI boundary', () => {
  it('passes argv as an array with shell:false, an absolute cwd and structured stdin', async () => {
    const { spawn, runs } = harness()
    const runner = createCliRunner({ spawn, env: ENV })
    const promise = runner.run(request({ stdin: '{"body":"hello"}' }))
    const child = runs[0]!
    expect(child.command).toBe(request().command)
    expect(child.args).toEqual(['issue', 'list', '--json', 'number,title'])
    expect(child.options.shell).toBe(false)
    expect(child.options.cwd).toBe(CWD)
    expect(child.stdin.data).toBe('{"body":"hello"}')
    expect(child.stdin.ended).toBe(true)
    child.close(0)
    await expect(promise).resolves.toMatchObject({ exitCode: 0 })
  })

  it('refuses a relative cwd and a non-argv argument list before spawning', async () => {
    const { spawn, runs } = harness()
    const runner = createCliRunner({ spawn, env: ENV })
    await expect(runner.run(request({ cwd: 'relative/dir' }))).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(runner.run(request({ args: 'issue list' as unknown as string[] }))).rejects.toMatchObject({ category: 'invalid-request' })
    expect(runs).toHaveLength(0)
  })

  it('only inherits allowlisted env names and never forwards secrets or DSH variables', async () => {
    const { spawn, runs } = harness()
    const runner = createCliRunner({ spawn, env: ENV })
    const promise = runner.run(request({
      envAllowlist: ['GH_CONFIG_DIR', 'GITHUB_TOKEN'],
    }))
    const env = runs[0]!.options.env
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.HOME).toBe('/home/tester')
    expect(env.GH_CONFIG_DIR).toBe('/home/tester/.config/gh')
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.DSH_HOME).toBeUndefined()
    expect(env.SOME_UNLISTED).toBeUndefined()
    runs[0]!.close(0)
    await promise
  })

  it('drops unknown or secret names from caller-provided env values', () => {
    const env = buildCliEnv(
      { PATH: '/bin' },
      { GH_CONFIG_DIR: '/cfg', UNKNOWN: 'x', GITHUB_TOKEN: 'nope' },
      ['GH_CONFIG_DIR', 'GITHUB_TOKEN'],
    )
    expect(env).toEqual({ PATH: '/bin', GH_CONFIG_DIR: '/cfg' })
  })

  it('refuses plural secret stores and browser credential names', () => {
    const env = buildCliEnv(
      {
        PATH: '/bin',
        GH_TOKENS: 'plural-token',
        AWS_CREDENTIALS: 'plural-credential',
        HTTP_AUTHORIZATION: 'authorization',
        SESSION_COOKIE: 'cookie',
        SAFE_CFG: 'keep',
      },
      {},
      ['GH_TOKENS', 'AWS_CREDENTIALS', 'HTTP_AUTHORIZATION', 'SESSION_COOKIE', 'SAFE_CFG'],
    )
    expect(env).toEqual({ PATH: '/bin', SAFE_CFG: 'keep' })
  })

  it('kills the child and answers timeout after the deadline', async () => {
    const { spawn, runs } = harness({ autoCloseOnKill: true })
    const runner = createCliRunner({ spawn, env: ENV })
    const promise = runner.run(request({ timeoutMs: 5 }))
    await expect(promise).rejects.toMatchObject({ category: 'timeout' })
    expect(runs[0]!.kills).toEqual(['SIGKILL'])
  })

  it('kills the child and answers cancelled when the caller aborts', async () => {
    const { spawn, runs } = harness({ autoCloseOnKill: true })
    const runner = createCliRunner({ spawn, env: ENV })
    const controller = new AbortController()
    const promise = runner.run(request({ signal: controller.signal }))
    controller.abort()
    await expect(promise).rejects.toMatchObject({ category: 'cancelled' })
    expect(runs[0]!.kills).toEqual(['SIGKILL'])
  })

  it('settles cancelled even when the killed child never emits close', async () => {
    // A grandchild may inherit the pipes and keep `close` from ever firing.
    const { spawn, runs } = harness({ autoCloseOnKill: false })
    const runner = createCliRunner({ spawn, env: ENV })
    const controller = new AbortController()
    const promise = runner.run(request({ signal: controller.signal }))
    controller.abort()
    await expect(promise).rejects.toMatchObject({ category: 'cancelled' })
    expect(runs[0]!.kills).toEqual(['SIGKILL'])
  })

  it('settles timeout even when the killed child never emits close', async () => {
    const { spawn, runs } = harness({ autoCloseOnKill: false })
    const runner = createCliRunner({ spawn, env: ENV })
    await expect(runner.run(request({ timeoutMs: 5 }))).rejects.toMatchObject({ category: 'timeout' })
    expect(runs[0]!.kills).toEqual(['SIGKILL'])
  })

  it('does not spawn when the signal was already aborted', async () => {
    const { spawn, runs } = harness()
    const controller = new AbortController()
    controller.abort()
    const runner = createCliRunner({ spawn, env: ENV })
    await expect(runner.run(request({ signal: controller.signal }))).rejects.toMatchObject({ category: 'cancelled' })
    expect(runs).toHaveLength(0)
  })

  it('caps output explicitly, keeps draining and reports the truncation', async () => {
    const { spawn, runs } = harness()
    const runner = createCliRunner({ spawn, env: ENV })
    const promise = runner.run(request({ maxOutputBytes: 5 }))
    const child = runs[0]!
    child.stdout.emitData('1234567890')
    // Overflow is reported, not hidden by killing the process ourselves.
    expect(child.kills).toEqual([])
    child.close(0)
    const result = await promise
    expect(result.stdout).toBe('12345')
    expect(result.stdoutTruncated).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  it('refuses runJson for a truncated stdout with the output-limit reason', async () => {
    const { spawn, runs } = harness()
    const runner = createCliRunner({ spawn, env: ENV })
    const promise = runner.runJson(request({ maxOutputBytes: 5 }))
    const child = runs[0]!
    child.stdout.emitData('{"truncated":true}')
    child.close(0)
    await expect(promise).rejects.toMatchObject({
      category: 'failed',
      message: expect.stringMatching(/capture limit/),
    })
  })

  it('settles failed when stdin emits EPIPE and the payload was not delivered', async () => {
    const { spawn, runs } = harness()
    const runner = createCliRunner({ spawn, env: ENV })
    const promise = runner.run(request({ stdin: 'payload' }))
    const child = runs[0]!
    child.stdin.emitError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    await expect(promise).rejects.toMatchObject({ category: 'failed' })
    expect(child.kills).toEqual(['SIGKILL'])
    // A second event after settlement must stay swallowed (no uncaught error).
    child.stdin.emitError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  })

  it('fails when the child closes before stdin finished flushing the payload', async () => {
    const { spawn, runs } = harness({ stdin: new FakeWritable(false) })
    const runner = createCliRunner({ spawn, env: ENV })
    const promise = runner.run(request({ stdin: 'payload' }))
    runs[0]!.close(0)
    await expect(promise).rejects.toMatchObject({
      category: 'failed',
      message: expect.stringMatching(/input was fully written/),
    })
  })

  it('does not fail an EOF-only run when stdin closes early', async () => {
    const { spawn, runs } = harness()
    const runner = createCliRunner({ spawn, env: ENV })
    const promise = runner.run(request())
    const child = runs[0]!
    child.stdin.emitError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    child.close(0)
    await expect(promise).resolves.toMatchObject({ exitCode: 0 })
  })

  it('redacts token-shaped stderr and strips ANSI before returning it', async () => {
    const { spawn, runs } = harness()
    const runner = createCliRunner({ spawn, env: ENV })
    const promise = runner.run(request())
    const child = runs[0]!
    child.stderr.emitData(
      '\u001b[31mAuthorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789\u001b[0m\n'
      + 'token=supersecretvalue\n'
      + 'could not parse --json\n',
    )
    child.close(1)
    const result = await promise
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('could not parse --json')
    expect(result.stderr).not.toContain('supersecretvalue')
    expect(result.stderr).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(result.stderr).not.toContain('\u001b[')
  })

  it('never copies stdout/stderr into a failure message', async () => {
    const { spawn, runs } = harness()
    const runner = createCliRunner({ spawn, env: ENV })
    const promise = runner.runJson(request())
    const child = runs[0]!
    child.stdout.emitData('{"token":"leak-me"}')
    child.stderr.emitData('fatal: token=leak-me')
    child.close(2)
    const error = await promise.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClueError)
    expect((error as ClueError).category).toBe('failed')
    expect((error as ClueError).message).not.toContain('leak-me')
    expect((error as ClueError).meta).toEqual({ exitCode: '2' })
    expect(JSON.stringify((error as ClueError).meta)).not.toContain('leak-me')
  })

  it('parses JSON only from a successful, complete run', async () => {
    const { spawn, runs } = harness()
    const runner = createCliRunner({ spawn, env: ENV })
    const promise = runner.runJson<{ ok: boolean }>(request())
    runs[0]!.stdout.emitData('{"ok":true}')
    runs[0]!.close(0)
    await expect(promise).resolves.toEqual({ ok: true })
  })

  it('rejects empty, malformed, truncated and non-zero JSON output', async () => {
    const cases: Array<{ name: string; drive: (child: FakeChild) => void }> = [
      { name: 'empty', drive: child => { child.stdout.emitData('  \n'); child.close(0) } },
      { name: 'malformed', drive: child => { child.stdout.emitData('{nope'); child.close(0) } },
      { name: 'truncated', drive: child => { child.stdout.emitData('{"partial":'); child.close(0) } },
      { name: 'non-zero', drive: child => { child.stdout.emitData('{"ok":false}'); child.close(1) } },
    ]
    for (const entry of cases) {
      const { spawn, runs } = harness()
      const runner = createCliRunner({ spawn, env: ENV })
      const promise = runner.runJson(request({ maxOutputBytes: entry.name === 'truncated' ? 5 : 1024 }))
      if (entry.name === 'truncated') runs[0]!.stdout.emitData('{"partial":true}')
      entry.drive(runs[0]!)
      await expect(promise, entry.name).rejects.toMatchObject({ category: 'failed' })
    }
  })

  it('maps a missing executable to dependency-missing without leaking the spawn text', async () => {
    const spawn: CliSpawn = () => {
      const error = Object.assign(new Error('spawn /opt/missing ENOENT'), { code: 'ENOENT' })
      throw error
    }
    const runner = createCliRunner({ spawn, env: ENV })
    const error = await runner.run(request()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClueError)
    expect((error as ClueError).category).toBe('dependency-missing')
    expect((error as ClueError).message).not.toContain('/opt/missing')
  })
})

describe('production spawn seam', () => {
  it('runs a real child with structured stdin through createNodeSpawn', async () => {
    const runner = createCliRunner({ spawn: createNodeSpawn(), env: process.env })
    const result = await runner.run({
      command: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      cwd: process.cwd(),
      stdin: 'hello-real-stdin',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello-real-stdin')
  })

  it('survives a real child that closes stdin early (EPIPE) without an uncaught error', async () => {
    const runner = createCliRunner({ spawn: createNodeSpawn(), env: process.env })
    // The child exits immediately without reading stdin: the 2 MiB write
    // cannot be delivered (EPIPE may arrive before OR after `close`).
    const error = await runner.run({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      stdin: 'x'.repeat(2 * 1024 * 1024),
      timeoutMs: 10_000,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClueError)
    expect((error as ClueError).category).toBe('failed')
    expect((error as ClueError).message).not.toContain('EPIPE')
  })

  it('settles the timeout when a real grandchild keeps the inherited stdio open', async () => {
    const dir = tempDir()
    const pidFile = join(dir, 'grandchild.pid')
    // The direct child exits immediately; its grandchild inherits stdout and
    // stderr, so Node's `close` event (which waits for every stdio stream) can
    // never fire until the runner releases those pipes.
    const script = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })",
      'writeFileSync(process.argv[1], String(grandchild.pid))',
      'grandchild.unref()',
      'process.exit(0)',
    ].join(';')
    let pid: number | undefined
    try {
      const runner = createCliRunner({ spawn: createNodeSpawn(), env: process.env })
      const startedAt = Date.now()
      const error = await runner.run({
        command: process.execPath,
        args: ['-e', script, pidFile],
        cwd: dir,
        timeoutMs: 200,
      }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ClueError)
      expect((error as ClueError).category).toBe('timeout')
      // No `close` can arrive while the grandchild lives: only the forced
      // settlement makes this resolve, close to the configured deadline.
      expect(Date.now() - startedAt).toBeLessThan(10_000)
      pid = Number(readFileSync(pidFile, 'utf8'))
    } finally {
      if (pid !== undefined && Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
      }
    }
  })
})

describe('Windows .cmd shim support', () => {
  it('quotes every token and refuses characters cmd.exe would reinterpret', () => {
    expect(windowsShimCommandLine('C:\\Program Files\\nodejs\\npm.cmd', ['install', 'C:\\a b']))
      .toBe('"C:\\Program Files\\nodejs\\npm.cmd" "install" "C:\\a b"')
    expect(() => windowsShimCommandLine('C:\\x\\npm.cmd', ['100%'])).toThrow(/cmd\.exe/)
    expect(() => windowsShimCommandLine('C:\\x\\npm.cmd', ['a"b'])).toThrow(/cmd\.exe/)
    expect(() => windowsShimCommandLine('C:\\x\\npm.cmd', ['a\nb'])).toThrow(/cmd\.exe/)
  })

  it.skipIf(process.platform !== 'win32')('executes a .cmd shim with shell:false', async () => {
    const dir = tempDir()
    const script = join(dir, 'probe.cmd')
    writeFileSync(script, '@echo off\r\necho {%1}\r\n')
    const runner = createCliRunner({ spawn: createNodeSpawn(), env: process.env })
    const result = await runner.run({
      command: script,
      args: ['hello world'],
      cwd: dir,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('{hello world}')
  })
})

describe('redactCliOutput', () => {
  it('redacts header, key-value and well-known token shapes', () => {
    const text = [
      'Authorization: Bearer abcdefghijklmnop',
      '{"access_token":"abc123","safe":"keep"}',
      'xoxb-123456789012-abcdefghij',
      'AKIAABCDEFGHIJKLMNOP',
      'nothing to hide here',
    ].join('\n')
    const redacted = redactCliOutput(text)
    expect(redacted).toContain('nothing to hide here')
    expect(redacted).toContain('"safe":"keep"')
    expect(redacted).not.toContain('abcdefghijklmnop')
    expect(redacted).not.toContain('abc123')
    expect(redacted).not.toContain('xoxb-123456789012')
    expect(redacted).not.toContain('AKIAABCDEFGHIJKLMNOP')
  })

  it('redacts Cookie and Set-Cookie headers and key-value forms', () => {
    const text = [
      'Cookie: sessionid=abcdef123456',
      'Set-Cookie: sid=zyx987654321; Path=/; HttpOnly',
      '{"cookie":"ghi789","safe":"keep"}',
      'cookie=plainvalue',
    ].join('\n')
    const redacted = redactCliOutput(text)
    expect(redacted).toContain('"safe":"keep"')
    expect(redacted).not.toContain('abcdef123456')
    expect(redacted).not.toContain('zyx987654321')
    expect(redacted).not.toContain('ghi789')
    expect(redacted).not.toContain('plainvalue')
  })
})
