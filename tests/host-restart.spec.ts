import { describe, expect, it, vi } from 'vitest'
import {
  createHostRestartController,
  restartWaiterSource,
  type HostLaunchSnapshot,
  type HostRestartRuntime,
} from '../src/host-restart.ts'

const snapshot: HostLaunchSnapshot = {
  pid: 4242,
  execPath: '/opt/node/bin/node',
  execArgv: ['--max-old-space-size=4096'],
  argv: ['/opt/dsh/bin/dsh', 'web', '--port', '3080'],
  cwd: '/work/a folder',
  logPath: '/tmp/dsh-web-restart.log',
}

describe('restartWaiterSource', () => {
  it('embeds the exact trusted argv and waits for the parent before relaunching', () => {
    const source = restartWaiterSource(snapshot)
    expect(source).toContain('process.kill(parentPid, 0)')
    expect(source).toContain('spawn(execPath, [...execArgv, ...argv]')
    expect(source).toContain(JSON.stringify(snapshot.execArgv))
    expect(source).toContain(JSON.stringify(snapshot.argv))
    expect(source).toContain(JSON.stringify(snapshot.cwd))
    expect(source).toContain(JSON.stringify(snapshot.logPath))
    expect(source).not.toContain('shell: true')
    expect(() => new Function(source)).not.toThrow()
  })
})

describe('createHostRestartController', () => {
  it('launches one handoff, schedules termination after the response window, and deduplicates retries', async () => {
    const launchWaiter = vi.fn()
    const scheduleTermination = vi.fn()
    const runtime: HostRestartRuntime = {
      snapshot: () => snapshot,
      launchWaiter,
      scheduleTermination,
    }
    const controller = createHostRestartController(runtime)

    await expect(controller.request()).resolves.toEqual({ accepted: true, alreadyScheduled: false, pid: 4242 })
    await expect(controller.request()).resolves.toEqual({ accepted: true, alreadyScheduled: true, pid: 4242 })
    expect(launchWaiter).toHaveBeenCalledOnce()
    expect(launchWaiter).toHaveBeenCalledWith(snapshot)
    expect(scheduleTermination).toHaveBeenCalledOnce()
    expect(scheduleTermination).toHaveBeenCalledWith(250)
  })

  it('does not terminate the live host when the detached waiter cannot spawn', async () => {
    const scheduleTermination = vi.fn()
    const controller = createHostRestartController({
      snapshot: () => snapshot,
      launchWaiter: async () => { throw new Error('EMFILE') },
      scheduleTermination,
    })

    await expect(controller.request()).rejects.toThrow('EMFILE')
    expect(scheduleTermination).not.toHaveBeenCalled()
  })

  it('refuses a process without a restartable Node entrypoint', async () => {
    const launchWaiter = vi.fn()
    const scheduleTermination = vi.fn()
    const controller = createHostRestartController({
      snapshot: () => ({ ...snapshot, argv: [] }),
      launchWaiter,
      scheduleTermination,
    })

    await expect(controller.request()).rejects.toThrow('without a Node entrypoint')
    expect(launchWaiter).not.toHaveBeenCalled()
    expect(scheduleTermination).not.toHaveBeenCalled()
  })

  it('refuses a random web port because the browser cannot rediscover it', async () => {
    const launchWaiter = vi.fn()
    const scheduleTermination = vi.fn()
    const controller = createHostRestartController({
      snapshot: () => ({ ...snapshot, argv: ['/opt/dsh/bin/dsh', 'web', '--port=0'] }),
      launchWaiter,
      scheduleTermination,
    })

    await expect(controller.request()).rejects.toThrow('requires a fixed web port')
    expect(launchWaiter).not.toHaveBeenCalled()
    expect(scheduleTermination).not.toHaveBeenCalled()
  })
})
