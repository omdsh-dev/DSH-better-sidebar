/**
 * Self-restart handoff for the DSH Web host.
 *
 * A detached helper waits for this process to disappear before launching the
 * exact same Node entrypoint, arguments, cwd, and environment. Waiting avoids
 * a race on the listening port; detaching lets the helper survive SIGTERM.
 */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Immutable launch details copied before shutdown starts. */
export interface HostLaunchSnapshot {
  pid: number
  execPath: string
  execArgv: string[]
  argv: string[]
  cwd: string
  logPath: string
}

/** Injectable effects keep restart scheduling deterministic in tests. */
export interface HostRestartRuntime {
  snapshot(): HostLaunchSnapshot
  launchWaiter(snapshot: HostLaunchSnapshot): Promise<void> | void
  scheduleTermination(delayMs: number): void
}

/** Result returned to the browser before the old host shuts down. */
export interface HostRestartAccepted {
  accepted: true
  alreadyScheduled: boolean
  pid: number
}

/** Build the detached wait-and-relaunch program from trusted local values. */
export function restartWaiterSource(snapshot: HostLaunchSnapshot): string {
  return `
const { spawn } = require('node:child_process')
const { appendFileSync, closeSync, openSync } = require('node:fs')
const parentPid = ${JSON.stringify(snapshot.pid)}
const execPath = ${JSON.stringify(snapshot.execPath)}
const execArgv = ${JSON.stringify(snapshot.execArgv)}
const argv = ${JSON.stringify(snapshot.argv)}
const cwd = ${JSON.stringify(snapshot.cwd)}
const logPath = ${JSON.stringify(snapshot.logPath)}
const deadline = Date.now() + 120000
const log = (message) => {
  try { appendFileSync(logPath, new Date().toISOString() + ' ' + message + '\\n') } catch {}
}
const wait = () => {
  try {
    process.kill(parentPid, 0)
    if (Date.now() >= deadline) {
      log('restart abandoned: old host did not exit within 120 seconds')
      process.exit(1)
    }
    setTimeout(wait, 100)
  } catch {
    try {
      const output = openSync(logPath, 'a')
      const child = spawn(execPath, [...execArgv, ...argv], {
        cwd,
        env: process.env,
        detached: true,
        stdio: ['ignore', output, output],
        windowsHide: true,
      })
      child.once('error', error => log('replacement spawn failed: ' + error.message))
      child.unref()
      closeSync(output)
    } catch (error) {
      log('replacement launch failed: ' + (error instanceof Error ? error.message : String(error)))
      process.exitCode = 1
    }
  }
}
wait()
`.trim()
}

/** Production runtime: detached helper first, graceful SIGTERM after reply. */
export const defaultHostRestartRuntime: HostRestartRuntime = {
  snapshot: () => ({
    pid: process.pid,
    execPath: process.execPath,
    execArgv: [...process.execArgv],
    argv: process.argv.slice(1),
    cwd: process.cwd(),
    logPath: join(tmpdir(), 'dsh-web-restart.log'),
  }),
  launchWaiter: (snapshot) => new Promise((resolve, reject) => {
    const waiter = spawn(process.execPath, ['-e', restartWaiterSource(snapshot)], {
      cwd: snapshot.cwd,
      env: process.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    const onError = (error: Error): void => { reject(error) }
    waiter.once('error', onError)
    waiter.once('spawn', () => {
      waiter.off('error', onError)
      waiter.on('error', (error) => {
        try { appendFileSync(snapshot.logPath, `${new Date().toISOString()} restart waiter failed: ${error.message}\n`) } catch {}
      })
      waiter.unref()
      resolve()
    })
  }),
  scheduleTermination: (delayMs) => {
    const timer = setTimeout(() => {
      process.kill(process.pid, 'SIGTERM')
    }, delayMs)
    timer.unref()
  },
}

/** A random replacement port cannot be rediscovered from the old page. */
function usesDynamicPort(argv: readonly string[]): boolean {
  return argv.some((arg, index) => arg === '--port=0' || (arg === '--port' && argv[index + 1] === '0'))
}

/**
 * Idempotent restart controller. Repeated clicks during the response window
 * reuse the first handoff and never launch competing replacement processes.
 */
export function createHostRestartController(runtime: HostRestartRuntime = defaultHostRestartRuntime): {
  request(): Promise<HostRestartAccepted>
} {
  let scheduled: Promise<HostRestartAccepted> | undefined
  return {
    request: () => {
      if (scheduled !== undefined) {
        return scheduled.then(accepted => ({ ...accepted, alreadyScheduled: true }))
      }
      const pending = (async (): Promise<HostRestartAccepted> => {
        const snapshot = runtime.snapshot()
        if (snapshot.argv.length === 0) {
          throw new Error('cannot restart a host without a Node entrypoint')
        }
        if (usesDynamicPort(snapshot.argv)) {
          throw new Error('one-click restart requires a fixed web port')
        }
        // Do not terminate the live host until Node confirms that the detached
        // waiter process really spawned; otherwise a local resource failure
        // could turn a restart request into an unrecoverable outage.
        await runtime.launchWaiter(snapshot)
        const accepted: HostRestartAccepted = { accepted: true, alreadyScheduled: false, pid: snapshot.pid }
        // Leave enough time for the JSON response to reach the browser before
        // SIGTERM begins the host's normal shutdown path.
        runtime.scheduleTermination(250)
        return accepted
      })()
      scheduled = pending
      void pending.catch(() => {
        if (scheduled === pending) scheduled = undefined
      })
      return pending
    },
  }
}
