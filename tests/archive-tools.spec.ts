/**
 * archive-tools: the system's own zip/tar behind the file tree's archive action.
 *
 * This module replaced the hand-written ZIP encoder, so the old byte-level
 * reader is gone with it — there is nothing of OURS left to inflate. What is
 * worth pinning is the PLAN (where the tool runs and what argv it gets), the
 * NAME the client ends up with, the tool PROBE (which binary answers), and how
 * ONE run reports success, failure and stderr.
 *
 * Every case here injects the spawn face: `zip` does not exist on Windows
 * (bsdtar does), the ubuntu runner is not guaranteed either, and a spec that
 * spawned for real would fail at collection time on one platform while staying
 * green locally forever (AGENTS §6). Exactly ONE case drives a real binary —
 * it self-probes and returns early when neither tool is installed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  ARCHIVE_STDERR_LIMIT,
  ARCHIVE_STEM_MAX,
  archiveFileName,
  archiveTempName,
  planArchive,
  resetArchiveToolCache,
  resolveArchiveTool,
  runArchiveTool,
  tryTools,
  type ArchiveSpawn,
  type ArchiveToolSpec,
} from '../src/archive-tools.ts'
import { SidebarError } from '../src/wire.ts'
import { removeTree } from './temp-tree.ts'

/** What one scripted child answers, per phase. */
interface Script {
  /** `--version` probe: the exit code, a spawn error, or no answer at all. */
  probe?: (bin: string) => number | 'error' | 'hang'
  /** The real invocation (the one handed the output descriptor). */
  run?: () => RunAnswer
}

/** One scripted invocation's outcome. */
interface RunAnswer {
  /** Bytes the tool wrote into the caller's descriptor (the archive). */
  bytes?: Buffer
  /** Exit code; 'error' = the child could not start, null = killed by a signal. */
  code?: number | 'error' | null
  /** What the tool printed on stderr. */
  stderr?: string
  /** Keep running until `kill()` — the teardown case. */
  hang?: boolean
}

/** The minimum of a ChildProcess the two consumers here touch. */
type FakeChild = EventEmitter & { stderr: PassThrough; kill: ReturnType<typeof vi.fn> }

/** One recorded spawn, for argv/cwd/descriptor assertions. */
interface SpawnCall {
  bin: string
  args: string[]
  stdio: unknown
  fd?: number
}

/**
 * A scripted `spawn`, never a real binary.
 *
 * The probe is told apart from the run the way the module does it: a probe is
 * spawned with `stdio: 'ignore'`, a run with the caller's descriptor.
 */
function scriptedSpawn(script: Script): { spawner: ArchiveSpawn; calls: SpawnCall[]; children: FakeChild[] } {
  const calls: SpawnCall[] = []
  const children: FakeChild[] = []
  const spawner = ((bin: string, args: readonly string[], options: { stdio?: unknown }): FakeChild => {
    const child = new EventEmitter() as FakeChild
    child.stderr = new PassThrough()
    const fd = Array.isArray(options.stdio) ? options.stdio[1] : undefined
    calls.push({ bin, args: [...args], stdio: options.stdio, ...(typeof fd === 'number' ? { fd } : {}) })
    children.push(child)
    // A killed child is one that exits BY SIGNAL: 'close' with no exit code,
    // which is exactly what a real SIGTERM/SIGKILL looks like from here.
    let hangs = false
    child.kill = vi.fn(() => {
      if (hangs) child.emit('close', null)
      return true
    })
    if (options.stdio === 'ignore') {
      const answer = script.probe?.(bin) ?? 0
      process.nextTick(() => {
        if (answer === 'hang') return
        if (answer === 'error') {
          child.emit('error', new Error(`spawn ${bin} ENOENT`))
          return
        }
        child.emit('exit', answer)
      })
      return child
    }
    const run = script.run?.() ?? {}
    hangs = run.hang === true
    process.nextTick(() => {
      if (hangs) return
      if (run.stderr !== undefined) child.stderr.write(run.stderr)
      if (run.bytes !== undefined && typeof fd === 'number') writeSync(fd, run.bytes)
      const code = run.code === undefined ? 0 : run.code
      if (code === 'error') {
        child.emit('error', new Error(`spawn ${bin} ENOENT`))
        return
      }
      child.emit('close', code)
    })
    return child
  }) as unknown as ArchiveSpawn
  return { spawner, calls, children }
}

/** Run `fn` and hand back what it threw (SidebarError assertions read better this way). */
function capture(fn: () => unknown): unknown {
  try {
    fn()
    return undefined
  } catch (error: unknown) {
    return error
  }
}

/** A platform-native absolute root that does not have to exist: planning is pure path math. */
const PLAN_ROOT = join(parse(tmpdir()).root, 'dsh-archive-plan')

/**
 * The tool spec the MODULE defines, resolved through a fake probe — so the
 * argv assertions below pin the real flags instead of a copy of them.
 */
async function specOf(tool: 'zip' | 'tar'): Promise<ArchiveToolSpec> {
  const spec = await tryTools([tool], scriptedSpawn({ probe: () => 0 }).spawner)
  if (spec === undefined) throw new Error(`test setup: no ${tool} spec`)
  return spec
}

/** Temp trees, removed after each test. */
const roots: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-archive-tools-'))
  roots.push(root)
  return root
}

beforeEach(() => {
  resetArchiveToolCache()
})
afterEach(() => {
  resetArchiveToolCache()
  vi.useRealTimers()
  vi.restoreAllMocks()
  while (roots.length > 0) removeTree(roots.pop()!)
})

describe('planArchive', () => {
  it('plans one selection from its PARENT, named by its basename', async () => {
    const spec = await specOf('zip')
    const src = join(PLAN_ROOT, 'ws', 'src')
    const plan = planArchive([src], spec)
    // From the parent, so the archive carries a `src/` top-level entry rather
    // than unpacking its contents into the download directory.
    expect(plan.cwd).toBe(join(PLAN_ROOT, 'ws'))
    // `-y` is not decoration: without it Info-ZIP FOLLOWS symlinks, and a
    // `loop -> .` in the tree then recurses until the process is killed.
    expect(plan.args).toEqual(['-r', '-q', '-X', '-y', '-', 'src'])
    expect(plan.spec).toBe(spec)
  })

  it('plans several selections from their deepest common ancestor, "/"-separated', async () => {
    const spec = await specOf('zip')
    const ws = join(PLAN_ROOT, 'ws')
    const plan = planArchive([join(ws, 'src', 'index.ts'), join(ws, 'lib', 'util.ts')], spec)
    expect(plan.cwd).toBe(ws)
    expect(plan.args.slice(spec.flags.length)).toEqual(['src/index.ts', 'lib/util.ts'])
    // The separator is normalized whatever the platform produced: the tool
    // gets in-archive names, not host paths.
    expect(plan.args.every(arg => !arg.includes('\\'))).toBe(true)
  })

  it('steps the base up one level when a selection IS the common ancestor', async () => {
    const spec = await specOf('zip')
    const ws = join(PLAN_ROOT, 'ws')
    // Selecting a folder AND something inside it would name the folder '' from
    // its own directory, so the base moves up and both keep a component.
    const plan = planArchive([join(ws, 'src'), join(ws, 'src', 'index.ts')], spec)
    expect(plan.cwd).toBe(ws)
    const names = plan.args.slice(spec.flags.length)
    expect(names).toEqual(['src', 'src/index.ts'])
    expect(names.every(name => name !== '')).toBe(true)
  })

  it('uses the tar invocation for a tar-only host', async () => {
    const spec = await specOf('tar')
    const plan = planArchive([join(PLAN_ROOT, 'ws', 'notes.md')], spec)
    expect(plan.args).toEqual(['-czf', '-', 'notes.md'])
    expect(plan.spec.ext).toBe('.tar.gz')
  })

  it('refuses the filesystem root, whose parent does not exist', async () => {
    const spec = await specOf('zip')
    const root = parse(tmpdir()).root
    const thrown = capture(() => planArchive([root], spec))
    expect(thrown).toBeInstanceOf(SidebarError)
    expect(thrown).toMatchObject({ code: 'bad-request' })
    expect((thrown as Error).message).toMatch(/filesystem root/)
  })

  it('refuses an empty selection', async () => {
    const spec = await specOf('zip')
    const thrown = capture(() => planArchive([], spec))
    expect(thrown).toBeInstanceOf(SidebarError)
    expect(thrown).toMatchObject({ code: 'bad-request' })
    expect((thrown as Error).message).toMatch(/no paths/)
  })
})

describe('archiveFileName', () => {
  it('strips whatever archive suffix the caller guessed, then applies the real one', () => {
    expect(archiveFileName('docs', '.zip')).toBe('docs.zip')
    expect(archiveFileName('docs.zip', '.zip')).toBe('docs.zip')
    expect(archiveFileName('docs.tar', '.zip')).toBe('docs.zip')
    expect(archiveFileName('docs.tar.gz', '.zip')).toBe('docs.zip')
    expect(archiveFileName('docs.tgz', '.zip')).toBe('docs.zip')
    // The stem keeps its case, the extension is the tool's literal — a guessed
    // `DOCS.ZIP` comes back as the real `DOCS.zip`.
    expect(archiveFileName('DOCS.ZIP', '.zip')).toBe('DOCS.zip')
    // The TOOL decides, not the client: the same stem on a tar-only host.
    expect(archiveFileName('docs', '.tar.gz')).toBe('docs.tar.gz')
    expect(archiveFileName('docs.zip', '.tar.gz')).toBe('docs.tar.gz')
  })

  it('strips separators, quotes and control characters — a name is never a path', () => {
    expect(archiveFileName('../../etc/passwd', '.zip')).toBe('etcpasswd.zip')
    expect(archiveFileName('a\\b".zip', '.zip')).toBe('ab.zip')
    expect(archiveFileName("it's.zip", '.zip')).toBe('its.zip')
    expect(archiveFileName('bad\u0000name\u001F.zip', '.zip')).toBe('badname.zip')
    expect(archiveFileName('del\u007Fete', '.zip')).toBe('delete.zip')
    // Kept: non-latin1 is the header encoder's problem (see contentDispositionOf).
    expect(archiveFileName('报告', '.zip')).toBe('报告.zip')
  })

  it('falls back to `archive`, drops leading dots, and truncates the stem', () => {
    expect(archiveFileName('', '.zip')).toBe('archive.zip')
    expect(archiveFileName('   ', '.zip')).toBe('archive.zip')
    expect(archiveFileName('.zip', '.zip')).toBe('archive.zip')
    expect(archiveFileName('..zip', '.zip')).toBe('archive.zip')
    expect(archiveFileName('...hidden', '.zip')).toBe('hidden.zip')
    const long = archiveFileName(`${'x'.repeat(300)}.zip`, '.zip')
    expect(long).toBe(`${'x'.repeat(ARCHIVE_STEM_MAX)}.zip`)
    expect(long.length).toBe(ARCHIVE_STEM_MAX + 4)
    // `.tar.gz` is one extension, applied whole.
    expect(archiveFileName('x'.repeat(300), '.tar.gz')).toBe(`${'x'.repeat(ARCHIVE_STEM_MAX)}.tar.gz`)
  })

  it('names the temp file after the task id and the tool extension', () => {
    expect(archiveTempName('ar-1', '.zip')).toBe('dsh-better-sidebar-ar-1.zip')
    expect(archiveTempName('ar-2', '.tar.gz')).toBe('dsh-better-sidebar-ar-2.tar.gz')
  })
})

describe('tool probing (injected spawn)', () => {
  it('takes zip when zip answers exit 0 — tar is never spawned', async () => {
    const { spawner, calls } = scriptedSpawn({ probe: () => 0 })
    const spec = await tryTools(['zip', 'tar'], spawner)
    expect(spec?.tool).toBe('zip')
    expect(spec?.bin).toBe('zip')
    expect(spec?.ext).toBe('.zip')
    expect(spec?.flags).toEqual(['-r', '-q', '-X', '-y', '-'])
    // `--version`, not `--help`: bsdtar's help exits non-zero on some builds.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ bin: 'zip', args: ['--version'], stdio: 'ignore' })
  })

  it('falls through to tar when zip cannot be started at all', async () => {
    const { spawner, calls } = scriptedSpawn({ probe: bin => (bin === 'zip' ? 'error' : 0) })
    const spec = await tryTools(['zip', 'tar'], spawner)
    expect(spec?.tool).toBe('tar')
    expect(spec?.flags).toEqual(['-czf', '-'])
    expect(spec?.ext).toBe('.tar.gz')
    expect(calls.map(call => call.bin)).toEqual(['zip', 'tar'])
  })

  it('falls through to tar when zip answers with a non-zero exit', async () => {
    const { spawner, calls } = scriptedSpawn({ probe: bin => (bin === 'zip' ? 127 : 0) })
    const spec = await tryTools(['zip', 'tar'], spawner)
    expect(spec?.tool).toBe('tar')
    expect(calls.map(call => call.bin)).toEqual(['zip', 'tar'])
  })

  it('returns undefined when neither tool answers', async () => {
    const broken = scriptedSpawn({ probe: () => 'error' })
    expect(await tryTools(['zip', 'tar'], broken.spawner)).toBeUndefined()
    expect(broken.calls.map(call => call.bin)).toEqual(['zip', 'tar'])
    resetArchiveToolCache()
    const nonZero = scriptedSpawn({ probe: () => 1 })
    expect(await tryTools(['zip', 'tar'], nonZero.spawner)).toBeUndefined()
    expect(nonZero.calls.map(call => call.bin)).toEqual(['zip', 'tar'])
  })

  it('memoizes the probe for the process, and resetArchiveToolCache re-probes', async () => {
    const first = scriptedSpawn({ probe: () => 0 })
    expect((await tryTools(['zip'], first.spawner))?.tool).toBe('zip')
    expect(first.calls).toHaveLength(1)
    // The second ask is answered from the memo: no second process.
    const second = scriptedSpawn({ probe: () => 0 })
    expect((await tryTools(['zip'], second.spawner))?.tool).toBe('zip')
    expect(second.calls).toHaveLength(0)
    resetArchiveToolCache()
    expect((await tryTools(['zip'], second.spawner))?.tool).toBe('zip')
    expect(second.calls).toHaveLength(1)
  })

  it('gives up on a probe that never answers, and kills it', async () => {
    vi.useFakeTimers()
    const { spawner, children } = scriptedSpawn({ probe: () => 'hang' })
    const pending = tryTools(['zip'], spawner)
    // Well past any sane probe budget: the timer, not the child, ends this.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await pending).toBeUndefined()
    expect(children[0]!.kill).toHaveBeenCalled()
  })
})

describe('runArchiveTool (injected spawn)', () => {
  it('resolves with the exit code and the stderr tail for a tool that RAN and failed', async () => {
    const root = tempRoot()
    const spec = await specOf('zip')
    const plan = planArchive([join(root, 'src')], spec)
    const out = join(root, 'out.zip')
    const { spawner } = scriptedSpawn({ run: () => ({ code: 2, stderr: 'zip error: nothing to do\n' }) })
    const fd = openSync(out, 'w')
    try {
      // A non-zero exit is a RESULT: the route turns it into an `error` task
      // with the tool's own message, which is the point of running in the
      // background at all.
      await expect(runArchiveTool(plan, fd, spawner)).resolves.toEqual({
        code: 2,
        stderr: 'zip error: nothing to do',
      })
    } finally {
      closeSync(fd)
    }
  })

  it('rejects with a SidebarError when the child cannot be started', async () => {
    const root = tempRoot()
    const spec = await specOf('zip')
    const plan = planArchive([join(root, 'src')], spec)
    const out = join(root, 'out.zip')
    const { spawner } = scriptedSpawn({ run: () => ({ code: 'error' }) })
    const fd = openSync(out, 'w')
    try {
      const thrown = await runArchiveTool(plan, fd, spawner).catch((error: unknown) => error)
      expect(thrown).toBeInstanceOf(SidebarError)
      expect(thrown).toMatchObject({ code: 'fs-error' })
      expect((thrown as Error).message).toMatch(/cannot run zip/)
    } finally {
      closeSync(fd)
    }
  })

  it('reports code 1 for a child killed by a signal (no exit code at all)', async () => {
    const root = tempRoot()
    const spec = await specOf('zip')
    const plan = planArchive([join(root, 'src')], spec)
    const out = join(root, 'out.zip')
    const { spawner } = scriptedSpawn({ run: () => ({ code: null }) })
    const fd = openSync(out, 'w')
    try {
      await expect(runArchiveTool(plan, fd, spawner)).resolves.toEqual({ code: 1, stderr: '' })
    } finally {
      closeSync(fd)
    }
  })

  it('keeps a bounded TAIL of stderr, not the whole log', async () => {
    const root = tempRoot()
    const spec = await specOf('zip')
    const plan = planArchive([join(root, 'src')], spec)
    const out = join(root, 'out.zip')
    // Three budgets of noise with a distinct head and tail: the last lines are
    // the ones that name the actual problem.
    const head = 'H'.repeat(64)
    const tail = 'T'.repeat(64)
    const { spawner } = scriptedSpawn({
      run: () => ({ code: 1, stderr: `${head}${'M'.repeat(ARCHIVE_STDERR_LIMIT * 3)}${tail}` }),
    })
    const fd = openSync(out, 'w')
    try {
      const result = await runArchiveTool(plan, fd, spawner)
      expect(result.code).toBe(1)
      expect(result.stderr.length).toBeLessThanOrEqual(ARCHIVE_STDERR_LIMIT)
      expect(result.stderr.endsWith(tail)).toBe(true)
      expect(result.stderr.includes(head)).toBe(false)
    } finally {
      closeSync(fd)
    }
  })

  it('hands the spawn the plan, the caller\'s descriptor and the child', async () => {
    const root = tempRoot()
    const spec = await specOf('zip')
    const plan = planArchive([join(root, 'src')], spec)
    const out = join(root, 'out.zip')
    const payload = Buffer.from('PK\u0003\u0004 not really a zip\n')
    const { spawner, calls, children } = scriptedSpawn({ run: () => ({ bytes: payload }) })
    const fd = openSync(out, 'w')
    const spawned: unknown[] = []
    try {
      await expect(runArchiveTool(plan, fd, spawner, child => spawned.push(child)))
        .resolves.toEqual({ code: 0, stderr: '' })
    } finally {
      closeSync(fd)
    }
    // The TOOL wrote the file, through the descriptor we opened: the route
    // never holds the bytes.
    expect(readFileSync(out).equals(payload)).toBe(true)
    expect(calls[0]).toMatchObject({ bin: 'zip', args: plan.args, fd })
    // onSpawn hands the child over BEFORE it exits — that is what lets the
    // task table kill a build at teardown.
    expect(spawned).toEqual([children[0]])
  })
})

describe('real tool (only when one is installed)', () => {
  // The one case that drives a real binary. `zip` is absent on Windows (where
  // `tar` is bsdtar) and neither is guaranteed on a bare runner, so the probe
  // is repeated HERE — with the real spawn face — and a host without either
  // tool skips instead of failing.
  it('packs a tree that contains a symlink loop, and the loop does not recurse', async () => {
    resetArchiveToolCache()
    const spec = await resolveArchiveTool()
    if (spec === undefined) return // no zip and no tar: nothing to verify here
    const root = mkdtempSync(join(tmpdir(), 'dsh-archive-real-'))
    try {
      const ws = join(root, 'ws')
      mkdirSync(join(ws, 'dir'), { recursive: true })
      writeFileSync(join(ws, 'a.txt'), 'a\n')
      writeFileSync(join(ws, 'dir', 'b.txt'), 'b\n')
      // `loop -> .` is the shape that made `-y` mandatory. Creating a symlink
      // needs a privilege Windows may not grant, so a failure only drops the
      // loop, not the case.
      let looped = false
      try {
        symlinkSync('.', join(ws, 'loop'), 'dir')
        looped = true
      } catch {
        looped = false
      }
      const plan = planArchive([ws], spec)
      const out = join(root, `out${spec.ext}`)
      const fd = openSync(out, 'w')
      let child: ReturnType<ArchiveSpawn> | undefined
      let result: Awaited<ReturnType<typeof runArchiveTool>>
      // A followed loop never finishes. Kill it well inside vitest's own
      // budget, so a regression fails on the exit code with the tool's stderr
      // instead of timing the case out.
      const deadline = setTimeout(() => { child?.kill('SIGKILL') }, 8_000)
      try {
        result = await runArchiveTool(plan, fd, undefined, spawned => { child = spawned })
      } finally {
        clearTimeout(deadline)
        closeSync(fd)
      }
      expect(result.code, result.stderr).toBe(0)
      const size = statSync(out).size
      expect(size).toBeGreaterThan(0)
      // A followed `loop -> .` grows without bound; `-y` stores the link
      // itself, so the archive stays a couple of hundred bytes.
      expect(size).toBeLessThan(1 << 20)
      if (looped && spec.tool === 'zip') {
        // Info-ZIP stores entry names uncompressed: a recursion would be
        // visible as `loop/loop/…` in the bytes.
        expect(readFileSync(out).includes('loop/loop')).toBe(false)
      }
    } finally {
      removeTree(root)
    }
  }, 30_000)
})
