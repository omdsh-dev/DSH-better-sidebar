/**
 * S2 CLI boundary contract.
 *
 * Execution rules pinned with a FAKE spawn (no real CLI, HOME or Keychain):
 * - argv arrays + `shell: false`, an explicit absolute cwd and structured stdin;
 * - the env allowlist (dependency extras by name; DSH_* and secret-looking names
 *   always refused) and the fixed timeout/cancelled categories;
 * - the per-stream cap is explicit; stderr is ANSI-stripped and token-redacted,
 *   and stdout/stderr never enter a ClueError message; JSON parsing refuses
 *   non-zero exits, empty, malformed and truncated output.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClueError } from '../src/clues/error.ts'
import { buildCliEnv, createCliRunner, createNodeSpawn, redactCliOutput, windowsShimCommandLine } from '../src/clues/runtime/cli.ts'
import type { CliChildProcess, CliCommandRequest, CliReadable, CliSpawn, CliSpawnOptions, CliWritable } from '../src/clues/runtime/types.ts'

class FakeReadable extends EventEmitter implements CliReadable {
  emitData(chunk: string | Uint8Array): void { this.emit('data', chunk) }
}

class FakeWritable extends EventEmitter implements CliWritable {
  data = ''; ended = false
  constructor(private readonly finishOnEnd = true) { super() }
  write(chunk: string | Uint8Array): boolean { this.data += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true }
  end(): void { this.ended = true; if (this.finishOnEnd) this.emit('finish') }
  emitError(error: Error): void { this.emit('error', error) }
}

class FakeChild extends EventEmitter implements CliChildProcess {
  readonly stdout = new FakeReadable(); readonly stderr = new FakeReadable()
  readonly kills: Array<string | undefined> = []
  constructor(readonly command: string, readonly args: readonly string[], readonly options: CliSpawnOptions,
    private readonly autoCloseOnKill = true, readonly stdin: FakeWritable = new FakeWritable()) { super() }
  kill(signal?: string): boolean {
    this.kills.push(signal)
    if (this.autoCloseOnKill) queueMicrotask(() => this.close(null, signal ?? 'SIGKILL'))
    return true
  }
  close(code: number | null, signal: string | null = null): void { this.emit('close', code, signal) }
  error(error: Error): void { this.emit('error', error) }
}

function harness(options: { autoCloseOnKill?: boolean; stdin?: FakeWritable } = {}): { spawn: CliSpawn; runs: FakeChild[] } {
  const runs: FakeChild[] = []
  const spawn: CliSpawn = (command, args, spawnOptions) => { const child = new FakeChild(command, args, spawnOptions, options.autoCloseOnKill ?? true, options.stdin); runs.push(child); return child }
  return { spawn, runs }
}

const CWD = process.platform === 'win32' ? 'C:\\tmp\\clue-work' : '/tmp/clue-work'
function request(overrides: Partial<CliCommandRequest> = {}): CliCommandRequest {
  return { command: process.platform === 'win32' ? 'C:\\tools\\gh.exe' : '/opt/tools/gh', args: ['issue', 'list', '--json', 'number,title'], cwd: CWD, ...overrides }
}

const ENV = {
  PATH: '/usr/bin:/bin', HOME: '/home/tester', LANG: 'en_US.UTF-8', GITHUB_TOKEN: 'ghp_shouldneverleak',
  DSH_HOME: '/home/tester/.dsh', GH_CONFIG_DIR: '/home/tester/.config/gh', SOME_UNLISTED: 'nope',
}

const roots: string[] = []
afterEach(() => { vi.useRealTimers(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
function tempDir(): string { const path = mkdtempSync(join(tmpdir(), 'dsh-clue-cli-')); roots.push(path); return path }

describe('CLI boundary', () => {
  it('passes argv as an array with shell:false, an absolute cwd and structured stdin', async () => {
    const { spawn, runs } = harness()
    const promise = createCliRunner({ spawn, env: ENV }).run(request({ stdin: '{"body":"hello"}' }))
    const child = runs[0]!
    expect(child.command).toBe(request().command)
    expect(child.args).toEqual(['issue', 'list', '--json', 'number,title'])
    expect(child.options).toMatchObject({ shell: false, cwd: CWD })
    expect(child.stdin).toMatchObject({ data: '{"body":"hello"}', ended: true })
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

  it('only inherits allowlisted env names and refuses secrets in caller values', async () => {
    const { spawn, runs } = harness()
    const runner = createCliRunner({ spawn, env: ENV })
    const promise = runner.run(request({ envAllowlist: ['GH_CONFIG_DIR', 'GITHUB_TOKEN'] }))
    const env = runs[0]!.options.env
    expect(env).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '/home/tester', GH_CONFIG_DIR: '/home/tester/.config/gh' })
    for (const name of ['GITHUB_TOKEN', 'DSH_HOME', 'SOME_UNLISTED']) expect(env[name]).toBeUndefined()
    runs[0]!.close(0); await promise
    expect(buildCliEnv({ PATH: '/bin' }, { GH_CONFIG_DIR: '/cfg', UNKNOWN: 'x', GITHUB_TOKEN: 'nope' }, ['GH_CONFIG_DIR', 'GITHUB_TOKEN']))
      .toEqual({ PATH: '/bin', GH_CONFIG_DIR: '/cfg' })
    expect(buildCliEnv(
      { PATH: '/bin', GH_TOKENS: 'plural-token', AWS_CREDENTIALS: 'plural-credential', HTTP_AUTHORIZATION: 'authorization', SESSION_COOKIE: 'cookie', SAFE_CFG: 'keep' },
      {}, ['GH_TOKENS', 'AWS_CREDENTIALS', 'HTTP_AUTHORIZATION', 'SESSION_COOKIE', 'SAFE_CFG'],
    )).toEqual({ PATH: '/bin', SAFE_CFG: 'keep' })
  })

  it('kills the child and settles timeout, cancelled and already-aborted starts', async () => {
    // A grandchild may inherit the pipes and keep `close` from ever firing.
    for (const autoCloseOnKill of [true, false]) {
      const timeoutRun = harness({ autoCloseOnKill })
      await expect(createCliRunner({ spawn: timeoutRun.spawn, env: ENV }).run(request({ timeoutMs: 5 }))).rejects.toMatchObject({ category: 'timeout' })
      expect(timeoutRun.runs[0]!.kills).toEqual(['SIGKILL'])
      const cancelledRun = harness({ autoCloseOnKill })
      const controller = new AbortController()
      const cancelled = createCliRunner({ spawn: cancelledRun.spawn, env: ENV }).run(request({ signal: controller.signal }))
      controller.abort()
      await expect(cancelled).rejects.toMatchObject({ category: 'cancelled' })
      expect(cancelledRun.runs[0]!.kills).toEqual(['SIGKILL'])
    }

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    const abortedRun = harness()
    await expect(createCliRunner({ spawn: abortedRun.spawn, env: ENV }).run(request({ signal: alreadyAborted.signal })))
      .rejects.toMatchObject({ category: 'cancelled' })
    expect(abortedRun.runs).toHaveLength(0)
  })

  it('caps output explicitly, keeps draining and refuses runJson on truncation', async () => {
    const { spawn, runs } = harness(), runner = createCliRunner({ spawn, env: ENV })
    const promise = runner.run(request({ maxOutputBytes: 5 }))
    runs[0]!.stdout.emitData('1234567890')
    expect(runs[0]!.kills).toEqual([])
    runs[0]!.close(0); expect(await promise).toMatchObject({ stdout: '12345', stdoutTruncated: true, exitCode: 0 })

    const jsonRun = harness()
    const jsonPromise = createCliRunner({ spawn: jsonRun.spawn, env: ENV }).runJson(request({ maxOutputBytes: 5 }))
    jsonRun.runs[0]!.stdout.emitData('{"truncated":true}')
    jsonRun.runs[0]!.close(0)
    await expect(jsonPromise).rejects.toMatchObject({ category: 'failed', message: expect.stringMatching(/capture limit/) })
  })

  it('settles stdin delivery states without an uncaught error', async () => {
    const { spawn, runs } = harness()
    const epipeError = (): Error => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    const epipe = createCliRunner({ spawn, env: ENV }).run(request({ stdin: 'payload' }))
    runs[0]!.stdin.emitError(epipeError())
    await expect(epipe).rejects.toMatchObject({ category: 'failed' })
    expect(runs[0]!.kills).toEqual(['SIGKILL'])
    // A second event after settlement stays swallowed.
    runs[0]!.stdin.emitError(epipeError())

    const early = harness({ stdin: new FakeWritable(false) })
    const earlyRun = createCliRunner({ spawn: early.spawn, env: ENV }).run(request({ stdin: 'payload' }))
    early.runs[0]!.close(0)
    await expect(earlyRun).rejects.toMatchObject({ category: 'failed', message: expect.stringMatching(/input was fully written/) })

    const eof = harness(), eofRun = createCliRunner({ spawn: eof.spawn, env: ENV }).run(request())
    eof.runs[0]!.stdin.emitError(epipeError()); eof.runs[0]!.close(0)
    await expect(eofRun).resolves.toMatchObject({ exitCode: 0 })
  })

  it('redacts ANSI/token-shaped stderr and never copies output into a failure message', async () => {
    const { spawn, runs } = harness(), runner = createCliRunner({ spawn, env: ENV })
    const promise = runner.run(request())
    runs[0]!.stderr.emitData('\u001b[31mAuthorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789\u001b[0m\ntoken=supersecretvalue\ncould not parse --json\n')
    runs[0]!.close(1)
    const result = await promise
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('could not parse --json')
    for (const hidden of ['supersecretvalue', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', '\u001b[']) expect(result.stderr).not.toContain(hidden)

    const failing = harness()
    const failed = createCliRunner({ spawn: failing.spawn, env: ENV }).runJson(request())
    failing.runs[0]!.stdout.emitData('{"token":"leak-me"}')
    failing.runs[0]!.stderr.emitData('fatal: token=leak-me')
    failing.runs[0]!.close(2)
    const error = await failed.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClueError)
    expect((error as ClueError).category).toBe('failed')
    expect((error as ClueError).message).not.toContain('leak-me')
    expect((error as ClueError).meta).toEqual({ exitCode: '2' })
    expect(JSON.stringify((error as ClueError).meta)).not.toContain('leak-me')
  })

  it('parses JSON only from a successful complete run and rejects bad output', async () => {
    const ok = harness(), parsed = createCliRunner({ spawn: ok.spawn, env: ENV }).runJson<{ ok: boolean }>(request())
    ok.runs[0]!.stdout.emitData('{"ok":true}')
    ok.runs[0]!.close(0)
    await expect(parsed).resolves.toEqual({ ok: true })

    const cases: Array<[string, string, number, number?]> = [
      ['empty', '  \n', 0], ['malformed', '{nope', 0], ['truncated', '{"partial":true}', 0, 5], ['non-zero', '{"ok":false}', 1],
    ]
    for (const [name, output, exitCode, max] of cases) {
      const run = harness()
      const promise = createCliRunner({ spawn: run.spawn, env: ENV }).runJson(request({ maxOutputBytes: max ?? 1024 }))
      run.runs[0]!.stdout.emitData(output); run.runs[0]!.close(exitCode)
      await expect(promise, name).rejects.toMatchObject({ category: 'failed' })
    }
  })

  it('maps a missing executable to dependency-missing without leaking the spawn text', async () => {
    const spawn: CliSpawn = () => { throw Object.assign(new Error('spawn /opt/missing ENOENT'), { code: 'ENOENT' }) }
    const error = await createCliRunner({ spawn, env: ENV }).run(request()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClueError)
    expect((error as ClueError).category).toBe('dependency-missing')
    expect((error as ClueError).message).not.toContain('/opt/missing')
  })

  it('redacts header, key-value, cookie and well-known token shapes', () => {
    const redacted = redactCliOutput([
      'Authorization: Bearer abcdefghijklmnop', '{"access_token":"abc123","safe":"keep"}',
      'xoxb-123456789012-abcdefghij', 'AKIAABCDEFGHIJKLMNOP',
      'Cookie: sessionid=abcdef123456', 'Set-Cookie: sid=zyx987654321; Path=/; HttpOnly',
      '{"cookie":"ghi789"}', 'cookie=plainvalue', 'nothing to hide here',
    ].join('\n'))
    expect(redacted).toContain('nothing to hide here'); expect(redacted).toContain('"safe":"keep"')
    for (const hidden of ['abcdefghijklmnop', 'abc123', 'xoxb-123456789012', 'AKIAABCDEFGHIJKLMNOP', 'abcdef123456', 'zyx987654321', 'ghi789', 'plainvalue']) {
      expect(redacted).not.toContain(hidden)
    }
  })

  it('quotes every Windows .cmd shim token and refuses cmd.exe metacharacters', () => {
    expect(windowsShimCommandLine('C:\\Program Files\\nodejs\\npm.cmd', ['install', 'C:\\a b']))
      .toBe('"C:\\Program Files\\nodejs\\npm.cmd" "install" "C:\\a b"')
    for (const token of ['100%', 'a"b', 'a\nb']) expect(() => windowsShimCommandLine('C:\\x\\npm.cmd', [token])).toThrow(/cmd\.exe/)
  })

  it.skipIf(process.platform !== 'win32')('executes a .cmd shim with shell:false', async () => {
    const dir = tempDir(), script = join(dir, 'probe.cmd')
    writeFileSync(script, '@echo off\r\necho {%1}\r\n')
    const result = await createCliRunner({ spawn: createNodeSpawn(), env: process.env }).run({ command: script, args: ['hello world'], cwd: dir })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('{hello world}')
  })
})
describe('production spawn seam', () => {
  it('runs a real child with structured stdin and survives an early stdin close', async () => {
    const runner = createCliRunner({ spawn: createNodeSpawn(), env: process.env })
    const echoed = await runner.run({ command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], cwd: process.cwd(), stdin: 'hello-real-stdin' })
    expect(echoed).toMatchObject({ exitCode: 0, stdout: 'hello-real-stdin' })

    // The child exits without reading stdin: the 2 MiB write cannot be delivered.
    const error = await runner.run({
      command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
      stdin: 'x'.repeat(2 * 1024 * 1024), timeoutMs: 10_000,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClueError)
    expect((error as ClueError).category).toBe('failed')
    expect((error as ClueError).message).not.toContain('EPIPE')
  })
})
