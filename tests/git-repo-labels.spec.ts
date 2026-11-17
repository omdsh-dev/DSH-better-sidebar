/** Repository labels are display-only: preserve input roots/order, and identify context without IO. */
import { describe, expect, it } from 'vitest'
import { buildRepositoryLabels } from '../src/client/changes/repo-labels.ts'

const labels = (roots: readonly string[], cwd?: string) => buildRepositoryLabels(roots, cwd).map(row => row.label)

describe('buildRepositoryLabels', () => {
  it('keeps the display base and immediate child names short', () => {
    const roots = ['/workspace', '/workspace/dsh-m', '/workspace/ob-harness']
    expect(buildRepositoryLabels(roots, '/workspace')).toEqual([
      { root: '/workspace', label: 'workspace' },
      { root: '/workspace/dsh-m', label: 'dsh-m' },
      { root: '/workspace/ob-harness', label: 'ob-harness' },
    ])
  })

  it('always shows the full relative parent for deeper roots, even without name conflicts', () => {
    expect(labels(['/workspace/ob-harness/contexts/baseline', '/workspace/one/two/repo'], '/workspace'))
      .toEqual(['baseline (ob-harness/contexts)', 'repo (one/two)'])
  })

  it('preserves directory names with spaces, Unicode and punctuation', () => {
    expect(labels(['/workspace/proj a/子目录/a[b]'], '/workspace')).toEqual(['a[b] (proj a/子目录)'])
  })

  it('treats a POSIX root as base without losing the root or direct child', () => {
    expect(labels(['/', '/workspace', '/workspace/a'], '/')).toEqual(['/', 'workspace', 'a (workspace)'])
  })

  it('treats double-leading slashes as POSIX when the known base is POSIX', () => {
    const roots = ['//work/project/repo']
    expect(buildRepositoryLabels(roots, '/work')).toEqual([{ root: roots[0], label: 'repo (project)' }])
  })

  it('treats a Windows-looking namespace as POSIX on a POSIX host', () => {
    const roots = ['//?/C:/work/repo', '//?/UNC/work/repo']
    expect(buildRepositoryLabels(roots, '/', '/home/example').map(row => row.label))
      .toEqual(['repo (?/C:/work)', 'repo (?/UNC/work)'])
  })

  it('uses the existing host home to disambiguate double-slash POSIX and UNC bases', () => {
    const posixRoots = ['//work/project/a/b/repo', '/work/project/a/b/other']
    expect(buildRepositoryLabels(posixRoots, '//work/project', '/home/example').map(row => row.label))
      .toEqual(['repo (a/b)', 'other (a/b)'])
    const windowsRoots = ['//server/share/work/a/b/repo']
    expect(buildRepositoryLabels(windowsRoots, '//server/share/work', 'C:\\Users\\example').map(row => row.label))
      .toEqual(['repo (a\\b)'])
    // With no host hint, the two spellings are indistinguishable; preserve
    // forward-slash spelling rather than pretending the host is Windows.
    expect(buildRepositoryLabels(windowsRoots, '//server/share/work').map(row => row.label))
      .toEqual(['repo (a/b)'])
    expect(buildRepositoryLabels(posixRoots, '//work/project').map(row => row.label))
      .toEqual(['repo (a/b)', 'other (a/b)'])
    // Unknown host semantics must not infer case-insensitive containment.
    expect(buildRepositoryLabels(['//SERVER/share/work/a/b/repo'], '//server/share/work').map(row => row.label))
      .toEqual(['repo (b)'])
  })

  it('preserves slash spelling when host and display base are unknown', () => {
    const roots = ['//srv/share/A/same/repo', '//srv/share/B/same/repo']
    const expected = ['repo (A/same)', 'repo (B/same)']
    expect(labels(roots, undefined)).toEqual(expected)
    expect(labels(roots, 'relative')).toEqual(expected)
  })

  it('uses segment boundaries rather than a textual prefix', () => {
    expect(labels(['/work/repo', '/workspace/other', '/work-other/third'], '/work'))
      .toEqual(['repo', 'other (workspace)', 'third (work-other)'])
  })

  it('does not infer containment through unresolved parent segments', () => {
    expect(labels(['/workspace/link/../parent/repo'], '/workspace')).toEqual(['repo'])
    expect(labels(['/workspace/parent/repo'], '/workspace/link/..')).toEqual(['repo'])
  })

  it('does not case-fold POSIX containment or POSIX distinct names', () => {
    expect(labels(['/work/Team/repo', '/Work/Team/other', '/work/foo', '/work/Foo'], '/work'))
      .toEqual(['repo (Team)', 'other (Team)', 'foo', 'Foo'])
  })

  it('shows short parent context outside a known base, but short names when the base is unavailable', () => {
    const roots = ['/a/pkg', '/b/pkg', '/outside/unique']
    expect(labels(roots, undefined)).toEqual(['pkg (a)', 'pkg (b)', 'unique'])
    expect(labels(roots, '/workspace')).toEqual(['pkg (a)', 'pkg (b)', 'unique (outside)'])
    expect(labels(roots, 'relative')).toEqual(['pkg (a)', 'pkg (b)', 'unique'])
  })

  it('expands parent context sufficiently when immediate parents match', () => {
    const roots = ['/one/common/repo', '/two/common/repo']
    expect(labels(roots)).toEqual(['repo (one/common)', 'repo (two/common)'])
  })

  it('resolves a base item and direct child with the same basename without numeric suffixes', () => {
    const roots = ['/workspace', '/workspace/workspace']
    const result = labels(roots, '/workspace')
    expect(new Set(result).size).toBe(2)
    expect(result.every(label => !/\[\d+\]$/.test(label))).toBe(true)
    expect(result).toEqual(labels(roots, '/workspace'))
  })

  it('resolves collision between a generated label and a real directory name globally', () => {
    const roots = ['/x/a', '/y/a', '/z/a (x)']
    const result = labels(roots)
    expect(new Set(result).size).toBe(3)
    expect(result).toEqual(labels(roots))
    expect(result.every(label => !/\[\d+\]$/.test(label))).toBe(true)
  })

  it('falls back to complete paths when names and ancestor suffixes collide', () => {
    const roots = ['/x/shared/repo', '/y/shared/repo']
    const result = labels(roots, undefined)
    expect(result).toEqual(['repo (x/shared)', 'repo (y/shared)'])
    expect(new Set(result).size).toBe(2)
  })

  it('uses absolute paths as a final fallback without losing distinct raw spellings', () => {
    const roots = ['/a/repo', '/a/repo/']
    const result = labels(roots)
    expect(new Set(result).size).toBe(2)
    expect(result.join('\n')).toContain('/a/repo')
    expect(result).toEqual(labels(roots))
  })

  it('supports case-insensitive Windows drive containment using Windows separators', () => {
    const roots = ['C:\\Work', 'c:\\work\\app', 'C:\\work\\project\\nested\\repo']
    expect(labels(roots, 'C:\\WORK\\')).toEqual(['Work', 'app', 'repo (project\\nested)'])
  })

  it('recognises Windows paths written with forward slashes and uses the host dialect', () => {
    expect(labels(['C:/Work/project/nested/repo'], 'c:/work')).toEqual(['repo (project\\nested)'])
  })

  it('matches Windows extended-length drive and UNC paths to ordinary bases', () => {
    expect(labels(['\\\\?\\C:\\work\\project\\nested\\repo'], 'C:\\work'))
      .toEqual(['repo (project\\nested)'])
    expect(labels(['\\\\?\\UNC\\srv\\share\\work\\project\\nested\\repo'], '\\\\srv\\share\\work'))
      .toEqual(['repo (project\\nested)'])
    expect(labels(['//?/C:/work/project/nested/repo'], 'C:\\work'))
      .toEqual(['repo (project\\nested)'])
    expect(labels(['//?/UNC/srv/share/work/project/nested/repo'], '\\\\srv\\share\\work'))
      .toEqual(['repo (project\\nested)'])
  })

  it('recognises mixed UNC separators on a Windows host without misreading POSIX names', () => {
    const roots = ['\\/server/share/work/a/repo', '/\\server/share/work/b/nested/other']
    const rows = buildRepositoryLabels(roots, '\\\\server\\share\\work', 'C:\\Users\\example')
    expect(rows.map(row => row.root)).toEqual(roots)
    expect(rows.map(row => row.label)).toEqual(['repo (a)', 'other (b\\nested)'])
    expect(buildRepositoryLabels(['/\\server/share/work/a/repo'], '/', '/home/example').map(row => row.label))
      .toEqual(['repo (\\server/share/work/a)'])
    const ambiguous = ['/\\server/share/work/a/b/repo']
    expect(buildRepositoryLabels(ambiguous, '/\\server/share/work').map(row => row.label))
      .toEqual(['repo (a/b)'])
    expect(buildRepositoryLabels(ambiguous, '/\\server/share/work', 'C:\\Users\\example').map(row => row.label))
      .toEqual(['repo (a\\b)'])
    const duplicates = ['//server/share/A/same/repo', '//server/share/B/same/repo']
    expect(buildRepositoryLabels(duplicates, undefined, '\\/server/share/user').map(row => row.label))
      .toEqual(['repo (A\\same)', 'repo (B\\same)'])
  })

  it('does not treat a different Windows drive as inside the base', () => {
    expect(labels(['D:\\work\\project\\repo'], 'C:\\work')).toEqual(['repo (project)'])
  })

  it('shows a root-level parent for an outside repository', () => {
    expect(labels(['/repo'], '/workspace')).toEqual(['repo (/)'])
    expect(labels(['D:\\repo'], 'C:\\work')).toEqual(['repo (D:\\)'])
    expect(labels(['\\\\server\\other'], '\\\\server\\share')).toEqual(['other (\\\\server)'])
  })

  it('uses drive-qualified absolute paths when parent contexts cannot distinguish drives', () => {
    expect(labels(['C:\\repo', 'D:\\repo'])).toEqual(['repo (C:\\repo)', 'repo (D:\\repo)'])
    expect(labels(['C:\\', 'C:\\work', 'C:\\work\\repo'], 'C:\\'))
      .toEqual(['C:\\', 'work', 'repo (work)'])
  })

  it('distinguishes raw Windows path spellings when their normalized identity is equal', () => {
    const roots = ['C:\\work\\repo', 'c:/work/repo/']
    const rows = buildRepositoryLabels(roots, 'C:\\work')
    expect(rows.map(row => row.root)).toEqual(roots)
    expect(new Set(rows.map(row => row.label)).size).toBe(2)
    expect(rows.map(row => row.label)).toEqual(labels(roots, 'C:\\work'))
  })

  it('supports UNC shares and case-insensitive Windows containment', () => {
    const roots = ['\\\\server\\Share', '\\\\SERVER\\share\\org\\repo', '\\\\server\\other\\org\\other']
    expect(labels(roots, '\\\\SERVER\\SHARE\\')).toEqual(['Share', 'repo (org)', 'other (org)'])
  })

  it('treats backslashes inside POSIX path components literally', () => {
    expect(labels(['/workspace/project\\name/sub/repo'], '/workspace')).toEqual(['repo (project\\name/sub)'])
  })

  it('handles trailing separators while leaving each selected root untouched', () => {
    const roots = ['/workspace/', '/workspace/nested/repo/', 'C:\\work\\project\\']
    const rows = buildRepositoryLabels(roots, '/workspace/')
    expect(rows.map(row => row.root)).toEqual(roots)
    expect(rows.map(row => row.label)).toEqual(['workspace', 'repo (nested)', 'project (work)'])
  })

  it('does not invent distinct identities for duplicate identical input roots', () => {
    const root = '/workspace/app'
    expect(buildRepositoryLabels([root, root], '/workspace')).toEqual([
      { root, label: 'app' }, { root, label: 'app' },
    ])
  })

  it('distinguishes 200 colliding basenames with an unknown base', () => {
    const roots = Object.freeze(Array.from({ length: 200 }, (_, i) => `/outside/project-${i}/shared/repo`))
    const result = buildRepositoryLabels(roots, undefined)
    expect(result.map(row => row.root)).toEqual([...roots])
    expect(new Set(result.map(row => row.label)).size).toBe(200)
    expect(result[0]?.label).toBe('repo (project-0/shared)')
    expect(result[199]?.label).toBe('repo (project-199/shared)')
  })

  it('does not build ancestor suffixes for unique names', () => {
    const base = '/' + Array.from({ length: 200 }, (_, i) => `d${i}`).join('/')
    const roots = Array.from({ length: 100 }, (_, i) => `${base}/repo-${i}`)
    const originalJoin = Array.prototype.join
    let calls = 0
    Array.prototype.join = function (separator?: string) {
      calls++
      return originalJoin.call(this, separator)
    }
    let rows: ReturnType<typeof buildRepositoryLabels>
    try {
      rows = buildRepositoryLabels(roots, base)
    } finally {
      Array.prototype.join = originalJoin
    }
    expect(rows).toHaveLength(100)
    expect(calls).toBeLessThan(500)
  })

  it('constructs 200 labels in input order without mutating frozen input', () => {
    const roots = Object.freeze(Array.from({ length: 200 }, (_, i) => `/workspace/project-${i}/contexts/repo`))
    const before = [...roots]
    const result = buildRepositoryLabels(roots, '/workspace')
    expect(result).toHaveLength(200)
    expect(result.map(row => row.root)).toEqual(before)
    expect(new Set(result.map(row => row.label)).size).toBe(200)
    expect(result[0]?.label).toBe('repo (project-0/contexts)')
    expect(result[199]?.label).toBe('repo (project-199/contexts)')
    expect(roots).toEqual(before)
  })
})
