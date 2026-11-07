/**
 * 用户给的路径是字面文件名：git 默认把 `a[1].txt` 里的 `[1]` 当 pathspec
 * 通配符，会连 `a1.txt` 一起命中——丢弃改动不可恢复。这里钉住每个吃路径的
 * 子命令都把 `--literal-pathspecs` 作为全局选项前置在子命令前，且原有的
 * `--` 分隔与字面路径原样保留。
 *
 * 与 git-spawn.spec.ts 一样 mock 掉 spawn：只有拿到 argv 才能断言全局选项的
 * 顺序，真实 git 只会把结果返回来。
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { blame, diff, diffHead, discard, stage, unstage } from '../src/git.ts'

/** `a[1].txt` 是两平台都合法的良构方括号名；`a1.txt` 是它会被误伤的同伴。 */
const LITERAL = 'a[1].txt'
const PLAIN = 'a1.txt'
const CWD = '/repo'

afterEach(() => {
  spawnMock.mockReset()
})

/** 假的 git 子进程：`rev-parse --show-toplevel` 回填仓库根，其余返回空。 */
function fakeGit(_file: string, args: string[]): EventEmitter {
  const child = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(child, { stdout, stderr, kill: vi.fn() })
  const cwd = args[args.indexOf('-C') + 1] ?? ''
  queueMicrotask(() => {
    stdout.end(args.includes('rev-parse') ? `${cwd}\n` : '')
    stderr.end()
    child.emit('close', 0)
  })
  return child
}

const cases: { name: string; subcommand: string; run: () => Promise<unknown> }[] = [
  { name: 'discard', subcommand: 'checkout', run: () => discard(CWD, LITERAL) },
  { name: 'stage', subcommand: 'add', run: () => stage(CWD, LITERAL) },
  { name: 'unstage', subcommand: 'reset', run: () => unstage(CWD, LITERAL) },
  { name: 'diff (unstaged)', subcommand: 'diff', run: () => diff(CWD, LITERAL, false) },
  { name: 'diff (staged)', subcommand: 'diff', run: () => diff(CWD, LITERAL, true) },
  { name: 'diffHead', subcommand: 'diff', run: () => diffHead(CWD, LITERAL) },
  { name: 'blame', subcommand: 'blame', run: () => blame(CWD, LITERAL, 1, 1) },
]

describe('字面 pathspec（防止误伤同名文件）', () => {
  for (const { name, subcommand, run } of cases) {
    it(`${name}：--literal-pathspecs 前置在子命令前，且只带字面路径`, async () => {
      spawnMock.mockImplementation(fakeGit)
      await run()

      // 目标命令是唯一带用户路径的那次 spawn（其余是仓库发现的 rev-parse）。
      const argv = spawnMock.mock.calls
        .map(call => call[1] as string[])
        .find(args => args.includes(LITERAL))
      expect(argv).toBeDefined()
      const full = argv!

      expect(full).toContain('--literal-pathspecs')
      // 必须排在子命令之前，否则 git 把它当子命令参数、全局选项不生效。
      expect(full.indexOf('--literal-pathspecs')).toBeLessThan(full.indexOf(subcommand))
      // 原有的 `--` 分隔与字面路径不变，且路径是最后一个操作数。
      expect(full).toContain('--')
      expect(full.indexOf('--')).toBeLessThan(full.indexOf(LITERAL))
      expect(full.at(-1)).toBe(LITERAL)
      // 从未把 `a[1].txt` 展开/替换成 `a1.txt`。
      expect(full).not.toContain(PLAIN)
    })
  }

  it('全量操作（path 为 undefined）不引入多余的全局选项', async () => {
    spawnMock.mockImplementation(fakeGit)
    await Promise.all([
      stage(CWD, undefined),
      unstage(CWD, undefined),
      diff(CWD, undefined, false),
      diffHead(CWD, undefined),
    ])
    for (const call of spawnMock.mock.calls) {
      expect(call[1] as string[]).not.toContain('--literal-pathspecs')
    }
  })
})
