import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { currentBranch, isGitRepo, refusedRepository, worktrees } from '../src/git.ts'

afterEach(() => {
  spawnMock.mockReset()
})

/** A fake spawned git that ends its streams and closes with `code`. */
function fakeGit(stdoutText = '', stderrText = '', code = 0): EventEmitter {
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

/** The `-c key=value` overrides runGit put in front of the subcommand.
 *  Collected by name rather than by index: the flag set grows whenever a new
 *  global `-c` lands (color.ui, core.quotePath, the per-invocation
 *  safe.directory…), so a positional slice pins a shape nothing depends on. */
function configFlagsOf(args: string[] | undefined): string[] {
  const flags: string[] = []
  for (let at = 0; at < (args?.length ?? 0); at += 1) {
    if (args?.[at] === '-c') flags.push(args[at + 1] ?? '')
  }
  return flags
}

/** git ≥ 2.35.2's refusal, verbatim (the hint text included). */
const DUBIOUS = "fatal: detected dubious ownership in repository at '/srv/site'\n"
  + 'To add an exception for this directory, call:\n\n'
  + '\tgit config --global --add safe.directory /srv/site\n'

describe('dubious-ownership retry (issue #690)', () => {
  it('retries once, trusting only the repository git refused for this invocation', async () => {
    const calls: string[][] = []
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      calls.push(args)
      return calls.length === 1 ? fakeGit('', DUBIOUS, 128) : fakeGit('true\n')
    })

    await expect(isGitRepo('/srv/site/wp-content')).resolves.toBe(true)

    expect(calls).toHaveLength(2)
    // The first attempt is the argv a healthy repository always got...
    expect(calls[0]).toEqual([
      '-C', '/srv/site/wp-content', '--no-pager', '-c', 'color.ui=false',
      '-c', 'core.quotePath=false',
      'rev-parse', '--is-inside-work-tree',
    ])
    // ...and the retry trusts exactly what git named (the repository ROOT, not
    // the cwd — the refusal names the root) plus the cwd, and never '*'.
    expect(calls[1]).toEqual([
      '-C', '/srv/site/wp-content', '--no-pager', '-c', 'color.ui=false',
      '-c', 'core.quotePath=false',
      '-c', 'safe.directory=/srv/site',
      '-c', 'safe.directory=/srv/site/wp-content',
      'rev-parse', '--is-inside-work-tree',
    ])
  })

  it('runs git under a C locale so the refused path stays parseable', async () => {
    spawnMock.mockImplementation(() => fakeGit('true\n'))

    await isGitRepo('/srv/site')

    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      expect.anything(),
      expect.objectContaining({
        env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }),
      }),
    )
  })

  it('does not retry a failure that is not the ownership guard', async () => {
    spawnMock.mockImplementation(() => fakeGit('', 'fatal: not a git repository (or any of the parent directories): .git\n', 128))

    await expect(isGitRepo('/tmp/plain')).resolves.toBe(false)

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to the cwd when the refusal names no directory', async () => {
    const calls: string[][] = []
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      calls.push(args)
      return calls.length === 1 ? fakeGit('', 'fatal: detected dubious ownership\n', 128) : fakeGit('true\n')
    })

    await expect(isGitRepo('/srv/site')).resolves.toBe(true)

    expect(configFlagsOf(calls[1])).toContain('safe.directory=/srv/site')
    expect(calls[1]?.some(arg => arg.includes('safe.directory=*'))).toBe(false)
  })

  it('reports a second refusal instead of retrying forever', async () => {
    const calls: string[][] = []
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      calls.push(args)
      return fakeGit('', DUBIOUS, 128)
    })

    await expect(currentBranch('/srv/site')).rejects.toThrow(/dubious ownership/)
    expect(calls).toHaveLength(2)
  })

  it('reads the refused path out of the git message', () => {
    expect(refusedRepository(DUBIOUS)).toBe('/srv/site')
    // Percent-escaped or otherwise unusual messages must simply yield nothing.
    expect(refusedRepository('fatal: detected dubious ownership\n')).toBeUndefined()
    expect(refusedRepository('')).toBeUndefined()
  })
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
      ['-C', 'C:\\repo', '--no-pager', '-c', 'color.ui=false', '-c', 'core.quotePath=false', 'rev-parse', '--is-inside-work-tree'],
      expect.objectContaining({ windowsHide: true }),
    )
  })

  it('falls back when worktree list does not support -z', async () => {
    // The subcommand starts after runGit's own prefix (`-C <cwd>
    // --no-pager` plus any number of `-c key=value` flags), so find it
    // instead of counting: pinning the count breaks on every added `-c`.
    const subcommandOf = (args: string[]): string[] => {
      let at = 0
      while (at < args.length) {
        if (args[at] === '-C' || args[at] === '-c') { at += 2; continue }
        if (args[at] === '--no-pager') { at += 1; continue }
        break
      }
      return args.slice(at)
    }

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
      const command = subcommandOf(args)
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
