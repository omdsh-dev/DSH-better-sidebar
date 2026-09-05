/**
 * search-engines: the native-engine probe and runner behind fs.search.
 * The probe is process-cached (verified binaries only); a runtime failure
 * disables one engine without disturbing the others. `normalizeEnginePaths`
 * re-bases raw stdout lines onto the walk contract (root-relative,
 * '/'-separated, no './' prefix). Child processes are exercised entirely
 * through injected hooks — CI machines have no fd/rg, and the probe/runner
 * contracts are what the dispatch depends on.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  bundledRgCandidates,
  deriveRgMatches,
  EngineTimeoutError,
  escapeGlob,
  fdArgv,
  normalizeEnginePaths,
  probeEngines,
  resetEngines,
  rgArgv,
  runEngine,
  setEngineHooks,
  SKIP_DIR_NAMES,
  usableEngines,
} from '../src/search-engines.ts'
import type { EngineProbe } from '../src/search-engines.ts'

const fdProbe: EngineProbe = { engine: 'fd', binary: '/fake/fd' }
const rgProbe: EngineProbe = { engine: 'rg', binary: '/fake/rg' }

describe('normalizeEnginePaths', () => {
  it('keeps root-relative /-separated lines as-is (fd contract)', () => {
    expect(normalizeEnginePaths(['src/util.ts', 'README.md'])).toEqual([
      'src/util.ts',
      'README.md',
    ])
  })

  it('strips a leading ./ from engine output', () => {
    expect(normalizeEnginePaths(['./src/a.ts', './b.ts'])).toEqual([
      'src/a.ts',
      'b.ts',
    ])
  })

  it('drops empty lines and the bare root', () => {
    expect(normalizeEnginePaths(['', '.', 'src/x.ts'])).toEqual(['src/x.ts'])
  })

  // Windows shape (review concern: fd/rg "weird formats" on Windows):
  // rg emits '\'-separated paths with a '.\' prefix and CRLF line endings —
  // all of it must still land on the '/'-separated walk contract.
  it('normalizes Windows engine output: backslash separators + .\\ prefix (rg shape)', () => {
    expect(normalizeEnginePaths(['src\\util.ts', '.\\README.md'], '\\')).toEqual([
      'src/util.ts',
      'README.md',
    ])
  })

  it('strips a trailing CR from engine lines (Windows CRLF endings)', () => {
    expect(normalizeEnginePaths(['src/util.ts\r', './b.ts\r'])).toEqual([
      'src/util.ts',
      'b.ts',
    ])
    // Same protection applies to the Windows shape.
    expect(normalizeEnginePaths(['src\\util.ts\r', '.\\docs\\guide.md\r'], '\\')).toEqual([
      'src/util.ts',
      'docs/guide.md',
    ])
  })
})

describe('deriveRgMatches', () => {
  // rg --files never emits a directory line: a matching DIRECTORY segment
  // must be derived from the file path so rg-only machines see the same
  // results as fd / the plain walk (which both report directory names).
  it('keeps basename hits and derives matching directory segments', () => {
    expect(deriveRgMatches(
      ['src/util.ts', 'util/helper.ts', 'web/dist/bundle.js'],
      'util',
      10,
    )).toEqual({ paths: ['src/util.ts', 'util'], truncated: false })
  })

  it('dedupes repeated matching segments across lines', () => {
    expect(deriveRgMatches(['lib/a/x.ts', 'lib/a/y.ts'], 'lib', 10)).toEqual({
      paths: ['lib'],
      truncated: false,
    })
  })

  it('matches case-insensitively (walk parity)', () => {
    expect(deriveRgMatches(['SRC/Util.ts'], 'UTIL', 10)).toEqual({
      paths: ['SRC/Util.ts'],
      truncated: false,
    })
  })

  it('caps the derived set at maxMatches + 1 and raises truncated', () => {
    // 4 derived entries ('a' + 3 files) over a budget of 2: the budget, not
    // the engine, cut the result short — same sentinel semantics as the
    // fd/rg stream (cap = maxMatches + 1, caller slices back).
    expect(deriveRgMatches(['a/a1', 'a/a2', 'a/a3'], 'a', 2)).toEqual({
      paths: ['a', 'a/a1', 'a/a2'],
      truncated: true,
    })
  })

  it('derives both the directory and the basename hit from one line', () => {
    // 'util/util.ts': basename hit keeps the file, the 'util' segment
    // derives the directory — runChild ORs this with the stream's own
    // truncation flag (a stream-truncated run with a small derived set
    // stays true).
    expect(deriveRgMatches(['util/util.ts'], 'util', 10)).toEqual({
      paths: ['util', 'util/util.ts'],
      truncated: false,
    })
  })
})

describe('escapeGlob', () => {
  it('escapes glob metacharacters for rg -g literal matching', () => {
    expect(escapeGlob('a*b?c[d]')).toBe('a\\*b\\?c\\[d\\]')
  })

  // '{' is globset alternation syntax: unbalanced it breaks the glob parse
  // (rg exits 2 → the engine looks broken and gets disabled process-wide),
  // balanced 'a{b}' silently searches 'ab' instead of the literal. Both
  // verified against real rg 15; '\{' is the accepted escape.
  it('escapes braces so alternation syntax cannot hijack a literal query', () => {
    expect(escapeGlob('a{b}')).toBe('a\\{b\\}')
    expect(escapeGlob('{')).toBe('\\{')
    expect(escapeGlob('util{bar')).toBe('util\\{bar')
  })
})

describe('engine argv symmetry', () => {
  it('fd --max-results sits one ABOVE the sentinel (cap + 1) so full result sets trip truncation', () => {
    // cap = maxMatches + 1 is the stream sentinel: the runner marks
    // truncated when a line arrives past it. fd must not stop AT the
    // sentinel (never seen as truncated) — it caps one line higher.
    const argv = fdArgv(201, 'util')
    expect(argv).toContain('--max-results')
    expect(argv[argv.indexOf('--max-results') + 1]).toBe('202')
    expect(argv).toContain('--fixed-strings')
    expect(argv).toContain('--path-separator')
  })

  it('fd argv keeps the literal-fixed, hidden, no-ignore contract', () => {
    const argv = fdArgv(10, 'a*b')
    expect(argv.slice(0, 2)).toEqual(['--hidden', '--no-ignore'])
    expect(argv).toContain('--fixed-strings')
    expect(argv).toContain('--ignore-case')
    expect(argv).toContain('--path-separator')
    expect(argv).toContain('/')
    expect(argv[argv.length - 2]).toBe('a*b') // literal, unescaped
    expect(argv[argv.length - 1]).toBe('.')
  })

  // --no-ignore bypasses .gitignore: without explicit excludes the engines
  // would re-enter node_modules etc. and regress the walk's budget savings.
  // fd excludes each skip name at any depth (incl. a worktree .git FILE);
  // rg needs the directory glob + entry-only glob pair per name.
  it('fd and rg exclude every SKIP_DIR_NAMES entry (walk parity)', () => {
    const fd = fdArgv(10, 'util')
    const fdExcludes: (string | undefined)[] = []
    for (let index = 0; index < fd.length; index += 1) {
      if (fd[index] === '--exclude') fdExcludes.push(fd[index + 1])
    }
    expect(fdExcludes).toEqual([...SKIP_DIR_NAMES])

    const rg = rgArgv('util')
    const rgIglobs: (string | undefined)[] = []
    for (let index = 0; index < rg.length; index += 1) {
      if (rg[index] === '--iglob') rgIglobs.push(rg[index + 1])
    }
    for (const name of SKIP_DIR_NAMES) {
      expect(rgIglobs).toContain(`!**/${name}/**`)
      expect(rgIglobs).toContain(`!**/${name}`)
    }
    // The query iglobs are the last ones (skip globs precede them), still
    // case-insensitive and escaped: basename form + path-level form.
    expect(rgIglobs.slice(-2)).toEqual(['*util*', '**/*util*/**'])
  })

  it('rg argv escapes glob metacharacters and pins / separators', () => {
    const argv = rgArgv('a*b')
    expect(argv).toContain('--files')
    expect(argv).toContain('--path-separator')
    expect(argv).toContain('*a\\*b*')
    expect(argv[argv.length - 1]).toBe('.')
  })

  // A git worktree has a `.git` FILE at its root: '!**/.git/**' needs a
  // path segment AFTER .git, so the pointer file itself leaks through
  // (verified against real rg). fd's --exclude .git covers both shapes;
  // rg needs the second entry-only glob for parity.
  it('rg argv excludes .git directories AND a bare worktree .git file', () => {
    const argv = rgArgv('util')
    expect(argv).toContain('--iglob')
    expect(argv).toContain('!**/.git/**')
    expect(argv).toContain('!**/.git')
  })
})

describe('bundledRgCandidates', () => {
  it('derives the POSIX npm global layout from execPath (darwin)', () => {
    const paths = bundledRgCandidates(
      'darwin', 'arm64',
      '/opt/homebrew/bin/node',
      {}, '/Users/me',
    )
    expect(paths).toContain(join(
      '/opt/homebrew/lib/node_modules',
      '@deepseek-ai/dsh/node_modules',
      '@vscode/ripgrep-darwin-arm64/bin/rg',
    ))
  })

  // Windows npm has NO lib/ layer: the global prefix is %APPDATA%\npm, so
  // the execPath derivation used on POSIX would resolve to a bogus
  // C:\lib\node_modules\… path. The review concern (fd/rg "weird formats"
  // on Windows) includes the probe itself — pin the %APPDATA%\npm shape.
  it('derives the Windows npm global layout from %APPDATA% (win32)', () => {
    const paths = bundledRgCandidates(
      'win32', 'x64',
      'C:\\Program Files\\nodejs\\node.exe',
      { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me',
    )
    // join() renders the platform separator, so this also validates the
    // real backslash shape on Windows CI.
    expect(paths).toContain(join(
      'C:\\Users\\me\\AppData\\Roaming', 'npm', 'node_modules',
      '@deepseek-ai', 'dsh', 'node_modules',
      '@vscode', 'ripgrep-win32-x64', 'bin', 'rg.exe',
    ))
  })

  it('covers the launchd profile layout under ~/.dsh on every platform', () => {
    const darwin = bundledRgCandidates('darwin', 'arm64', '/usr/local/bin/node', {}, '/Users/me')
    expect(darwin).toContain(join(
      '/Users/me/.dsh/profiles/node_modules',
      '@deepseek-ai', 'dsh', 'node_modules',
      '@vscode', 'ripgrep-darwin-arm64', 'bin', 'rg',
    ))
    // Windows: node:path is platform-bound, so a test on POSIX cannot pin
    // the exact backslash shape — assert the layout structure (a real
    // Windows CI/true-positive run pins the literal '\\' separators).
    const win = bundledRgCandidates('win32', 'x64', 'C:\\node.exe', {}, 'C:\\Users\\me')
    expect(win.some(path => path.includes('.dsh') && path.includes('@deepseek-ai'))).toBe(true)
  })

  it('dedupes identical candidates across derivations', () => {
    const paths = bundledRgCandidates(
      'darwin', 'arm64',
      '/usr/local/bin/node',
      {}, '/Users/me',
    )
    // /usr/local/bin/node → /usr/local/lib/node_modules AND the fixed
    // /usr/local/lib/node_modules root — the same file must appear once.
    const duplicates = paths.filter((path, index) => paths.indexOf(path) !== index)
    expect(duplicates).toEqual([])
  })

  it('drops APPDATA roots when the env var is absent (win32)', () => {
    const paths = bundledRgCandidates('win32', 'x64', 'C:\\node.exe', {}, 'C:\\Users\\me')
    expect(paths.some(path => path.includes('AppData'))).toBe(false)
    // The per-executable node_modules root (portable installs) survives.
    expect(paths.some(path => path.includes('node_modules') && path.includes('@deepseek-ai'))).toBe(true)
  })
})

describe('probe cache and broken-disable', () => {
  afterEach(() => {
    resetEngines()
  })

  it('caches the probe result across calls', async () => {
    let calls = 0
    setEngineHooks({ prober: async () => { calls += 1; return [fdProbe] } })
    expect(await probeEngines()).toBe(await probeEngines())
    expect(calls).toBe(1)
  })

  it('usableEngines hides engines broken at runtime', async () => {
    setEngineHooks({ prober: async () => [fdProbe, rgProbe] })
    await runEngine(fdProbe, '/w', 'x', 10, undefined).catch(() => {
      /* the failing runner below */
    })
    setEngineHooks({
      runner: async () => { throw new Error('boom') },
    })
    await runEngine(fdProbe, '/w', 'x', 10, undefined).catch(() => {
      /* expected failure */
    })
    const usable = await usableEngines()
    expect(usable.map(probe => probe.engine)).toEqual(['rg'])
  })

  it('an aborted run does not disable the engine', async () => {
    setEngineHooks({ prober: async () => [fdProbe] })
    setEngineHooks({
      runner: async () => { throw new Error('search aborted') },
    })
    const controller = new AbortController()
    controller.abort()
    await runEngine(fdProbe, '/w', 'x', 10, controller.signal).catch(() => {
      /* expected failure */
    })
    expect((await usableEngines()).map(probe => probe.engine)).toEqual(['fd'])
  })

  // A timeout means THIS tree was too big — the broken-set is per-engine,
  // so disabling here would strip every other root of the engine over one
  // huge directory. The engine must stay usable after a timeout.
  it('a timed-out run does not disable the engine', async () => {
    setEngineHooks({ prober: async () => [fdProbe] })
    setEngineHooks({
      runner: async () => { throw new EngineTimeoutError('search engine timed out') },
    })
    await runEngine(fdProbe, '/huge-tree', 'x', 10, undefined).catch(() => {
      /* expected failure */
    })
    expect((await usableEngines()).map(probe => probe.engine)).toEqual(['fd'])
  })
})