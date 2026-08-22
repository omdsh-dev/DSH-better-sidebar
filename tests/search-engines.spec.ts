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
import { join, sep } from 'node:path'
import {
  bundledRgCandidates,
  escapeGlob,
  fdArgv,
  normalizeEnginePaths,
  probeEngines,
  resetEngines,
  rgArgv,
  runEngine,
  setEngineHooks,
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

describe('escapeGlob', () => {
  it('escapes glob metacharacters for rg -g literal matching', () => {
    expect(escapeGlob('a*b?c[d]')).toBe('a\\*b\\?c\\[d\\]')
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
    expect(argv.slice(0, 8)).toEqual([
      '--hidden', '--no-ignore', '--exclude', '.git',
      '--fixed-strings', '--ignore-case', '--path-separator', '/',
    ])
    expect(argv[argv.length - 2]).toBe('a*b') // literal, unescaped
    expect(argv[argv.length - 1]).toBe('.')
  })

  it('rg argv escapes glob metacharacters and pins / separators', () => {
    const argv = rgArgv('a*b')
    expect(argv).toContain('--files')
    expect(argv).toContain('--path-separator')
    expect(argv).toContain('*a\\*b*')
    expect(argv[argv.length - 1]).toBe('.')
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
})