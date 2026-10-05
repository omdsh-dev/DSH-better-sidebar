/**
 * search-engines: the native-engine probe and runner behind fs.search.
 * The probe is process-cached (verified binaries only); a runtime failure
 * disables one engine without disturbing the others, while a TIMEOUT only
 * degrades that one search. `normalizeEnginePaths` re-bases raw stdout lines
 * onto the walk contract (root-relative, '/'-separated, no './' prefix) and
 * `deriveRgMatches` supplies the directory hits `rg --files` cannot report.
 * Child processes are exercised entirely through injected hooks — CI
 * machines have no fd (and only sometimes rg), and the probe/runner contracts
 * are what the dispatch depends on.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { searchFiles } from '../src/fs-search.ts'
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

  // fd prints DIRECTORY hits with a trailing separator. The walk contract has
  // none, and consumers compare these rows against walk output, so the
  // canonical form is pinned here — WITHOUT needing a real engine installed
  // (the Windows lane is the only place fd exists, which is exactly why this
  // leaked: the assertion that caught it needs `fd` present).
  it('strips the trailing separator fd prints for directory hits', () => {
    expect(normalizeEnginePaths(['src/util/', 'web/comp-util/', 'src/util/util-helper.ts'])).toEqual([
      'src/util',
      'web/comp-util',
      'src/util/util-helper.ts',
    ])
  })

  it('strips a trailing separator from Windows-shaped directory output too', () => {
    expect(normalizeEnginePaths(['src\\util\\', '.\\web\\comp-util\\'], '\\')).toEqual([
      'src/util',
      'web/comp-util',
    ])
  })

  it('drops the bare root that the trailing-separator strip collapses', () => {
    expect(normalizeEnginePaths(['/', 'src/x.ts'])).toEqual(['src/x.ts'])
  })

  // Windows shape (rg emits '\'-separated paths with a '.\' prefix and CRLF
  // line endings): all of it must still land on the '/'-separated walk contract.
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
    )).toEqual({ paths: ['src/util.ts', 'util'], dirs: ['util'], truncated: false })
  })

  // fs-search's contract: dirs is the DIRECTORY SUBSET of matches — the
  // client navigates those rows instead of opening them as files.
  it('reports every derived directory as a subset of the matches', () => {
    const result = deriveRgMatches(['a/util/x.ts', 'b/util/y.ts'], 'util', 10)
    expect(result.paths).toEqual(['a/util', 'b/util'])
    expect(result.dirs).toEqual(['a/util', 'b/util'])
    for (const dir of result.dirs) expect(result.paths).toContain(dir)
  })

  // The direct-child shape ('util/helper.ts') is the most common one there
  // is: its directory must be derived, not only the deeper nesting.
  it('derives a directory that holds the matching file directly', () => {
    expect(deriveRgMatches(['util/helper.ts'], 'util', 10)).toEqual({
      paths: ['util'],
      dirs: ['util'],
      truncated: false,
    })
  })

  it('dedupes repeated matching segments across lines', () => {
    expect(deriveRgMatches(['lib/a/x.ts', 'lib/a/y.ts'], 'lib', 10)).toEqual({
      paths: ['lib'],
      dirs: ['lib'],
      truncated: false,
    })
  })

  it('matches case-insensitively (walk parity)', () => {
    expect(deriveRgMatches(['SRC/Util.ts'], 'UTIL', 10)).toEqual({
      paths: ['SRC/Util.ts'],
      dirs: [],
      truncated: false,
    })
  })

  it('caps the derived set at maxMatches + 1 and raises truncated', () => {
    // 4 derived entries ('a' + 3 files) over a budget of 2: the budget, not
    // the engine, cut the result short — same sentinel semantics as the
    // fd/rg stream (cap = maxMatches + 1, caller slices back).
    expect(deriveRgMatches(['a/a1', 'a/a2', 'a/a3'], 'a', 2)).toEqual({
      paths: ['a', 'a/a1', 'a/a2'],
      dirs: ['a'],
      truncated: true,
    })
  })

  // Both lists carry the same sentinel cap, so a truncated run never hands
  // the caller an unbounded directory list; the dispatch slices `paths` back
  // to maxMatches and re-derives `dirs` from what it kept (see the
  // fs-search dispatch cases).
  it('caps dirs at the same sentinel as paths', () => {
    const result = deriveRgMatches(['a1/x', 'a2/x', 'a3/x'], 'a', 1)
    // Here every hit is the derived directory itself ('x' carries no 'a'),
    // so the sorted union is a1, a2, a3 — the sentinel keeps two.
    expect(result.paths).toEqual(['a1', 'a2'])
    expect(result.dirs).toEqual(['a1', 'a2'])
    expect(result.truncated).toBe(true)
  })

  it('derives both the directory and the basename hit from one line', () => {
    // 'util/util.ts': basename hit keeps the file, the 'util' segment
    // derives the directory — runChild ORs this with the stream's own
    // truncation flag (a stream-truncated run with a small derived set
    // stays true).
    expect(deriveRgMatches(['util/util.ts'], 'util', 10)).toEqual({
      paths: ['util', 'util/util.ts'],
      dirs: ['util'],
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

  // fd cannot label its matches, so the directory subset comes from a second
  // invocation restricted to directories. The filter must not disturb the
  // sentinel/truncation contract of the main run.
  it('fd --type d marks the directory-only invocation', () => {
    const argv = fdArgv(10, 'util', 'd')
    expect(argv[argv.indexOf('--type') + 1]).toBe('d')
    expect(argv).toContain('--max-results')
    // The plain invocation carries no --type at all.
    expect(fdArgv(10, 'util')).not.toContain('--type')
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
    // case-insensitive and escaped: basename form + both path-level forms.
    expect(rgIglobs.slice(-3)).toEqual(['*util*', '**/*util*/*', '**/*util*/**'])
  })

  // rg's path-level globs decide which DIRECTORY hits are derivable at all:
  // '**' alone misses a direct child ('util/helper.ts' — the most common
  // shape there is), '/*' alone misses everything deeper. Both are pinned
  // here because dropping either silently loses directory matches on
  // rg-only machines (verified against real rg 15).
  it('rg argv carries both path-level globs (direct child + any depth)', () => {
    const argv = rgArgv('util')
    expect(argv).toContain('**/*util*/*')
    expect(argv).toContain('**/*util*/**')
  })

  it('rg argv escapes glob metacharacters and pins / separators', () => {
    const argv = rgArgv('a*b')
    expect(argv).toContain('--files')
    expect(argv).toContain('--path-separator')
    expect(argv[argv.indexOf('--path-separator') + 1]).toBe('/')
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
  // Every expectation below joins with the DIALECT OF THE PLATFORM UNDER TEST
  // (`posix.join` for darwin, `win32.join` for win32), never the host `join`:
  // the function is a pure function of its `platform` argument, so the host
  // separator would make these assertions test the runner instead of the
  // derivation (on a POSIX runner the host join silently accepts a candidate
  // shape Windows would never see, and on Windows it demands backslashes from
  // a POSIX case).

  // npm/pnpm hoist @vscode/ripgrep-<platform>-<arch> NEXT TO @deepseek-ai,
  // never under @deepseek-ai/dsh/node_modules — the derivation must point at
  // the package-manager root that really holds the binary.
  it('derives the POSIX npm global layout from execPath (darwin)', () => {
    const paths = bundledRgCandidates(
      'darwin', 'arm64',
      '/opt/homebrew/bin/node',
      {}, '/Users/me', undefined,
    )
    expect(paths).toContain(posix.join(
      '/opt/homebrew/lib/node_modules',
      '@vscode/ripgrep-darwin-arm64/bin/rg',
    ))
  })

  // A tree that did NOT hoist (pnpm's strict layout) keeps the platform
  // package under the CLI's own node_modules — still a candidate.
  it('also covers the non-hoisted <root>/@deepseek-ai/dsh/node_modules layout', () => {
    const paths = bundledRgCandidates('darwin', 'arm64', '/usr/local/bin/node', {}, '/Users/me', undefined)
    expect(paths).toContain(posix.join(
      '/usr/local/lib/node_modules',
      '@deepseek-ai/dsh/node_modules',
      '@vscode/ripgrep-darwin-arm64/bin/rg',
    ))
  })

  // The dependency tree that provided @deepseek-ai/dsh may sit at ANY
  // node_modules level above the CLI entry — a bundled desktop shell's own
  // tree, a checkout, a project-local install — even when the node running
  // it lives elsewhere (Homebrew node + this repo's bundled tree).
  it('walks every node_modules level above the CLI entry (argv[1])', () => {
    const paths = bundledRgCandidates(
      'darwin', 'arm64',
      '/opt/homebrew/Cellar/node/26.9.0/bin/node',
      {}, '/Users/me',
      '/Applications/Dsh.app/Contents/Resources/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
    )
    expect(paths).toContain(posix.join(
      '/Applications/Dsh.app/Contents/Resources/dsh/node_modules',
      '@vscode/ripgrep-darwin-arm64/bin/rg',
    ))
    // The same walk under the win32 dialect: the candidate must come back in
    // the REAL backslash shape on any host. This is the discriminating
    // assertion for the platform-purity fix — with the host's `sep`/`dirname`
    // a POSIX runner derived nothing from a '\'-separated start path, and a
    // Windows runner derived nothing from the POSIX one above.
    const win = bundledRgCandidates(
      'win32', 'x64',
      'C:\\Program Files\\nodejs\\node.exe',
      {}, 'C:\\Users\\me',
      'C:\\Tools\\Dsh\\app\\resources\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    )
    expect(win).toContain(win32.join(
      'C:\\Tools\\Dsh\\app\\resources\\dsh\\node_modules',
      '@vscode/ripgrep-win32-x64/bin/rg.exe',
    ))
  })

  // Windows npm has NO lib/ layer: the global prefix is %APPDATA%\npm, so
  // the execPath derivation used on POSIX would resolve to a bogus
  // C:\lib\node_modules\… path. The probe itself must cover the real shape.
  it('derives the Windows npm global layout from %APPDATA% (win32)', () => {
    const paths = bundledRgCandidates(
      'win32', 'x64',
      'C:\\Program Files\\nodejs\\node.exe',
      { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me', undefined,
    )
    // win32.join renders the win32 separator on EVERY host, so this pins the
    // real backslash shape here on a POSIX runner too — the platform
    // argument decides the dialect, not the machine running the tests.
    expect(paths).toContain(win32.join(
      'C:\\Users\\me\\AppData\\Roaming', 'npm', 'node_modules',
      '@vscode', 'ripgrep-win32-x64', 'bin', 'rg.exe',
    ))
  })

  it('covers the DSH profile layout under ~/.dsh on every platform', () => {
    const darwin = bundledRgCandidates('darwin', 'arm64', '/usr/local/bin/node', {}, '/Users/me', undefined)
    expect(darwin).toContain(posix.join(
      '/Users/me/.dsh/profiles/node_modules',
      '@vscode', 'ripgrep-darwin-arm64', 'bin', 'rg',
    ))
    // Windows: the win32 dialect is selected from the platform argument, so
    // the exact '\'-separated shape IS pinnable from a POSIX host now.
    const win = bundledRgCandidates('win32', 'x64', 'C:\\node.exe', {}, 'C:\\Users\\me', undefined)
    expect(win).toContain(win32.join(
      'C:\\Users\\me', '.dsh', 'profiles', 'node_modules',
      '@vscode', 'ripgrep-win32-x64', 'bin', 'rg.exe',
    ))
  })

  it('dedupes identical candidates across derivations', () => {
    const paths = bundledRgCandidates(
      'darwin', 'arm64',
      '/usr/local/bin/node',
      {}, '/Users/me', undefined,
    )
    // /usr/local/bin/node → /usr/local/lib/node_modules AND the fixed
    // /usr/local/lib/node_modules root — the same file must appear once.
    const duplicates = paths.filter((path, index) => paths.indexOf(path) !== index)
    expect(duplicates).toEqual([])
  })

  it('drops APPDATA roots when the env var is absent (win32)', () => {
    const paths = bundledRgCandidates('win32', 'x64', 'C:\\node.exe', {}, 'C:\\Users\\me', undefined)
    expect(paths.some(path => path.includes('AppData'))).toBe(false)
    // The fixed profile root survives — in its real win32 shape.
    expect(paths).toContain(win32.join(
      'C:\\Users\\me', '.dsh', 'profiles', 'node_modules',
      '@vscode', 'ripgrep-win32-x64', 'bin', 'rg.exe',
    ))
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
    setEngineHooks({
      runner: async () => { throw new Error('boom') },
    })
    await runEngine(fdProbe, '/w', 'x', 10).catch(() => {
      /* the failing runner above */
    })
    const usable = await usableEngines()
    expect(usable.map(probe => probe.engine)).toEqual(['rg'])
  })

  // A timeout means THIS tree was too big — the broken-set is per-engine,
  // so disabling here would strip every other root of the engine over one
  // huge directory. The engine must stay usable after a timeout.
  it('a timed-out run does not disable the engine', async () => {
    setEngineHooks({ prober: async () => [fdProbe] })
    setEngineHooks({
      runner: async () => { throw new EngineTimeoutError('search engine timed out') },
    })
    await runEngine(fdProbe, '/huge-tree', 'x', 10).catch(() => {
      /* expected failure */
    })
    expect((await usableEngines()).map(probe => probe.engine)).toEqual(['fd'])
  })
})

/**
 * The REAL engines, when this machine has one (a CI runner usually has
 * neither and only the injected-hook contracts above run — that is why this
 * is a conditional block, not a fixture of the suite). It pins the properties
 * the injected hooks cannot: the shipped argvs actually parse, the literals
 * really are literal, the noise dirs really are excluded, and the directory
 * subset survives the real stdout pipeline.
 */
describe('real engines (only when installed)', () => {
  afterEach(() => {
    resetEngines()
  })

  it('matches literals, splits dirs, skips noise when an engine is installed', async () => {
    resetEngines()
    const engines = await probeEngines()
    if (engines.length === 0) return
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-engine-real-'))
    try {
      mkdirSync(join(dir, 'src', 'util'), { recursive: true })
      // A DIRECT child of the matching directory (rg's '**/*util*/*' glob is
      // what makes this one reachable at all).
      mkdirSync(join(dir, 'web', 'comp-util'), { recursive: true })
      mkdirSync(join(dir, 'node_modules', 'util-dep'), { recursive: true })
      writeFileSync(join(dir, 'src', 'util', 'util-helper.ts'), 'x')
      writeFileSync(join(dir, 'web', 'comp-util', 'component.tsx'), 'x')
      writeFileSync(join(dir, 'node_modules', 'util-dep', 'index.js'), 'x')
      // A glob metacharacter in the query is a LITERAL here (--fixed-strings
      // for fd, escapeGlob for rg): it must match the file whose NAME really
      // contains it and must not act as a wildcard. The pair is picked so a
      // lost escape is CAUGHT rather than merely unexercised — the decoy is
      // exactly what the non-literal reading would match:
      //   POSIX  : query 'a*b',  literal 'a*b.ts',  decoy 'anb.ts'
      //            (a glob/regex 'a*b' matches the decoy, verified on rg 15)
      //   win32  : query 'a[b]', literal 'a[b].ts', decoy 'ab.ts'
      // '*' (and '?', ':', '"', '<', '>', '|') are ILLEGAL file-name
      // characters on Windows: the old fixture wrote a real 'a*b.ts' there
      // and died with ENOENT before a single assertion ran. '[' and ']' are
      // legal everywhere and carry the same property — 'a[b]' is a character
      // class, so an unescaped glob matches 'ab.ts' and NOT the literal file
      // (verified against real rg 15.2.0: unescaped '*a[b]*' returns
      // 'ab.ts', escaped '*a\[b\]*' returns 'a[b].ts'). Deliberately NOT an
      // UNCLOSED 'a[b': rg refuses the glob outright ("unclosed character
      // class", exit 2), the engine gets dropped as broken and the plain-walk
      // fallback satisfies the assertion by accident.
      const meta = process.platform === 'win32'
        ? { file: 'a[b].ts', decoy: 'ab.ts', query: 'a[b]' }
        : { file: 'a*b.ts', decoy: 'anb.ts', query: 'a*b' }
      writeFileSync(join(dir, meta.file), 'x')
      writeFileSync(join(dir, meta.decoy), 'x')

      // Directory hits are derived from the file paths (rg) or read from
      // fd's directory listing: one nested match, one direct child, and the
      // node_modules copy stays invisible either way.
      const dirHit = await searchFiles(dir, 'util')
      expect(dirHit.matches).toEqual(['src/util', 'src/util/util-helper.ts', 'web/comp-util'])
      expect(dirHit.dirs).toEqual(['src/util', 'web/comp-util'])
      expect(dirHit.truncated).toBe(false)

      const literal = await searchFiles(dir, meta.query)
      expect(literal.matches).toEqual([meta.file])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
