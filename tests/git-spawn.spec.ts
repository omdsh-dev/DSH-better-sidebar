import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { isGitRepo, worktrees } from '../src/git.ts'

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

  it('falls back when worktree list does not support -z', async () => {
    const gitChild = (stdoutText = '', stderrText = '', code = 0): EventEmitter => {
      const child = new EventEmitter()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      Object.assign(child, { stdout, stderr, kill: vi.fn() })
      queueMicrotask(() => {
        stdout.end(stdoutText)
        stderr.end(stderrText)
        child.emit('close', code)
      })
      return child
    }

    spawnMock.mockImplementation((_file: string, args: string[]) => {
      const command = args.slice(5)
      if (command[0] === 'rev-parse' && command[1] === '--is-inside-work-tree') return gitChild('true\n')
      if (command[0] === 'rev-parse' && command[1] === '--show-toplevel') return gitChild('C:\\repo\n')
      if (command[0] === 'rev-parse' && command[1] === '--abbrev-ref') return gitChild('main\n')
      if (command[0] === 'status') return gitChild('')
      if (command[0] === 'worktree' && command.includes('-z')) {
        return gitChild('', "error: unknown switch `z'\n", 129)
      }
      if (command[0] === 'worktree') {
        return gitChild([
          'worktree C:\\repo',
          'HEAD abc',
          'branch refs/heads/main',
          '',
        ].join('\n'))
      }
      throw new Error(`unexpected git command: ${command.join(' ')}`)
    })

    await expect(worktrees('C:\\repo')).resolves.toEqual([
      { path: 'C:\\repo', branch: 'main', current: true, changes: 0 },
    ])
    await expect(worktrees('C:\\repo')).resolves.toEqual([
      { path: 'C:\\repo', branch: 'main', current: true, changes: 0 },
    ])

    const nulAttempts = spawnMock.mock.calls.filter((call) => {
      const args = call[1] as string[]
      return args.includes('worktree') && args.includes('-z')
    })
    expect(nulAttempts).toHaveLength(1)
  })
})
