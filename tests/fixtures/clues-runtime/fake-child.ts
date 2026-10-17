/**
 * Shared fake `node:child_process` seam for the S2 runtime specs.
 *
 * Tests never spawn a real user CLI, inherit HOME credentials or touch the
 * Keychain: the runner gets this fake `CliSpawn`, which records the exact
 * command/argv/env/cwd/stdin and lets a test script the stdout/stderr/exit code.
 */
import { EventEmitter } from 'node:events'
import type {
  CliChildProcess,
  CliReadable,
  CliSpawn,
  CliSpawnOptions,
  CliWritable,
} from '../../../src/clues/runtime/types.ts'

/** One scripted outcome; omit to keep the fake child open for manual control. */
export interface FakeOutcome {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
  readonly signal?: string | null
}

/** One recorded spawn. */
export interface FakeRun {
  readonly command: string
  readonly args: readonly string[]
  readonly options: CliSpawnOptions
  readonly stdin: FakeWritable
  readonly child: FakeChild
  /** Emit a close event (auto-close is disabled). */
  close(code?: number, signal?: string | null): void
}

/** Readable stream fake. */
export class FakeReadable extends EventEmitter implements CliReadable {
  emitData(chunk: string | Uint8Array): void {
    this.emit('data', chunk)
  }
}

/** Writable stdin fake. */
export class FakeWritable implements CliWritable {
  data = ''
  ended = false
  write(chunk: string | Uint8Array): boolean {
    this.data += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }
  end(): void {
    this.ended = true
  }
  on(): this {
    return this
  }
}

/** ChildProcess fake. */
export class FakeChild implements CliChildProcess {
  readonly stdout = new FakeReadable()
  readonly stderr = new FakeReadable()
  readonly stdin = new FakeWritable()
  readonly kills: Array<string | undefined> = []
  private readonly events = new EventEmitter()

  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly options: CliSpawnOptions,
  ) {}

  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): this
  on(event: 'error' | 'close', listener: ((error: Error) => void) | ((code: number | null, signal: string | null) => void)): this {
    this.events.on(event, listener)
    return this
  }

  kill(signal?: string): boolean {
    this.kills.push(signal)
    return true
  }

  emitClose(code: number | null, signal: string | null = null): void {
    this.events.emit('close', code, signal)
  }

  emitError(error: Error): void {
    this.events.emit('error', error)
  }
}

/**
 * Build a scripted spawn.
 * @param script - produces the outcome for a run; returning undefined leaves it open.
 * @param options - `autoClose: false` requires the test to call `run.close()`.
 */
export function createFakeSpawn(
  script: (run: FakeRun) => FakeOutcome | undefined = () => ({ exitCode: 0 }),
  options: { readonly autoClose?: boolean } = {},
): { readonly spawn: CliSpawn; readonly runs: FakeRun[] } {
  const runs: FakeRun[] = []
  const spawn: CliSpawn = (command, args, spawnOptions) => {
    const child = new FakeChild(command, args, spawnOptions)
    const run: FakeRun = {
      command,
      args,
      options: spawnOptions,
      stdin: child.stdin,
      child,
      close: (code = 0, signal = null) => child.emitClose(code, signal),
    }
    runs.push(run)
    if (options.autoClose !== false) {
      queueMicrotask(() => {
        const outcome = script(run)
        if (outcome === undefined) return
        if (outcome.stdout !== undefined) child.stdout.emitData(outcome.stdout)
        if (outcome.stderr !== undefined) child.stderr.emitData(outcome.stderr)
        child.emitClose(outcome.exitCode ?? 0, outcome.signal ?? null)
      })
    }
    return child
  }
  return { spawn, runs }
}
