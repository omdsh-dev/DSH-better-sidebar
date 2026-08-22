import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { isGitRepo } from '../src/git.ts'

afterEach(() => {
  spawnMock.mockReset()
})

describe('git subprocess spawning', () => {
  it('hides spawned git windows', async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      Object.assign(child, { stdout, stderr, kill: vi.fn() })

      queueMicrotask(() => {
        stdout.end('true\n')
        stderr.end()
        child.emit('close', 0)
      })

      return child
    })

    await expect(isGitRepo('C:\\repo')).resolves.toBe(true)

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['-C', 'C:\\repo', '--no-pager', '-c', 'color.ui=false', 'rev-parse', '--is-inside-work-tree'],
      expect.objectContaining({ windowsHide: true }),
    )
  })
})
