import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gitGraph } from '../src/git-graph.ts'

const dirs: string[] = []
// macOS tmpdir() keeps the /var symlink while git reports the resolved
// /private/var prefix, and on Windows TEMP is often the 8.3 short form
// (C:\Users\RUNNER~1\...) while git reports the long path. The NATIVE realpath
// resolves both aliasings (libuv's GetFinalPathNameByHandle expands 8.3 names),
// so every fixture path this suite hands to git is spelled the way git answers
// back — the reader selects a checkout root by platform path identity.
function temp() { const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sidebar-graph-'))); dirs.push(dir); return dir }
function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim()
}
function repo() {
  const dir = temp()
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.name', 'Graph Tester')
  git(dir, 'config', 'user.email', 'graph@example.test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}
function commit(dir: string, message: string) { git(dir, 'commit', '--allow-empty', '-m', message); return git(dir, 'rev-parse', 'HEAD') }
afterEach(() => {
  const root = realpathSync.native(tmpdir())
  for (const dir of dirs.splice(0)) { if (resolve(dir).startsWith(root + '/') || resolve(dir).startsWith(root + '\\')) rmSync(dir, { recursive: true, force: true }) }
})
function files(dir: string): Record<string, string> {
  const result: Record<string, string> = {}
  function visit(path: string) { for (const name of readdirSync(path)) { const full = join(path, name); if (statSync(full).isDirectory()) visit(full); else result[full] = readFileSync(full).toString('base64') } }
  visit(dir)
  return result
}

describe('read-only Git graph', () => {
  it('distinguishes non-repositories, unborn repositories and real failures', async () => {
    expect(await gitGraph(temp())).toMatchObject({ isRepo: false, entries: [] })
    expect(await gitGraph(repo())).toMatchObject({ isRepo: true, entries: [], hasMore: false })
    await expect(gitGraph(join(temp(), 'missing'))).rejects.toMatchObject({ code: 'git-error' })
  })

  it('returns merge parents, branch decorations, full messages and stable pages without writes', async () => {
    const dir = repo()
    const base = commit(dir, 'base')
    git(dir, 'checkout', '-b', 'topic')
    const topic = commit(dir, 'topic\n\nBody with unicode 日本語 and separators \x1e\x1f')
    git(dir, 'checkout', 'main')
    commit(dir, 'main change')
    git(dir, 'merge', '--no-ff', 'topic', '-m', 'merge')
    git(dir, 'update-ref', 'refs/remotes/origin/topic', topic)
    writeFileSync(join(dir, 'untracked'), 'leave alone')
    const before = files(dir)
    const all = await gitGraph(dir)
    expect(all.entries[0]!.parents).toHaveLength(2)
    expect(all.entries.find(e => e.hashFull === topic)?.message).toContain('Body with unicode 日本語 and separators \x1e\x1f')
    expect(all.entries.find(e => e.hashFull === topic)?.refs).toContain('origin/topic')
    expect(all.entries.at(-1)?.hashFull).toBe(base)
    const page1 = await gitGraph(dir, { count: 2 })
    const page2 = await gitGraph(dir, { count: 2, cursor: page1.nextCursor })
    expect([...page1.entries, ...page2.entries]).toEqual(all.entries)
    expect(page2.hasMore).toBe(false)
    expect(page2.nextCursor).toBeUndefined()
    expect(page2.snapshot).toBe(page1.snapshot)
    expect(files(dir)).toEqual(before)
    const filtered = await gitGraph(dir, { branch: 'refs/remotes/origin/topic' })
    expect(filtered.entries.map(e => e.hashFull)).toEqual([topic, base])
  })

  it('includes detached HEAD but excludes stash-only history', async () => {
    const dir = repo()
    commit(dir, 'base')
    writeFileSync(join(dir, 'tracked'), 'a')
    git(dir, 'add', '.')
    commit(dir, 'tracked')
    writeFileSync(join(dir, 'tracked'), 'b')
    git(dir, 'stash')
    const stash = git(dir, 'rev-parse', 'refs/stash')
    git(dir, 'checkout', '--detach')
    const detached = commit(dir, 'detached')
    const graph = await gitGraph(dir)
    expect(graph.entries[0]?.hashFull).toBe(detached)
    expect(graph.entries.some(e => e.hashFull === stash)).toBe(false)
  })

  it('rejects stale pages when refs move or the filter changes', async () => {
    const dir = repo()
    commit(dir, 'one'); commit(dir, 'two')
    const first = await gitGraph(dir, { count: 1 })
    await expect(gitGraph(dir, { cursor: first.nextCursor, branch: 'refs/heads/main' })).rejects.toMatchObject({ code: 'graph-stale' })
    git(dir, 'branch', 'new-decoration')
    await expect(gitGraph(dir, { cursor: first.nextCursor })).rejects.toMatchObject({ code: 'graph-stale' })
    const second = await gitGraph(dir, { count: 1, branch: 'refs/heads/new-decoration' })
    git(dir, 'branch', '-D', 'new-decoration')
    await expect(gitGraph(dir, { cursor: second.nextCursor, branch: 'refs/heads/new-decoration' })).rejects.toMatchObject({ code: 'graph-stale' })
  })

  it('uses selected container repositories and linked worktree HEADs', async () => {
    const container = temp()
    for (const name of ['a', 'b']) {
      git(container, 'init', '-b', 'main', name)
      git(join(container, name), 'config', 'user.name', 'Graph Tester')
      git(join(container, name), 'config', 'user.email', 'graph@example.test')
      git(join(container, name), 'config', 'commit.gpgsign', 'false')
      commit(join(container, name), name)
    }
    expect((await gitGraph(container, {}, join(container, 'b'))).entries[0]?.subject).toBe('b')
    const linked = join(temp(), 'linked')
    git(join(container, 'b'), 'worktree', 'add', '--detach', linked)
    const head = commit(linked, 'linked only')
    expect((await gitGraph(linked, {}, join(container, 'b'))).entries[0]?.hashFull).toBe(head)
  })

  it('fails visibly instead of truncating oversized full messages', async () => {
    const dir = repo()
    const message = join(dir, 'message')
    writeFileSync(message, 'large message\n\n' + 'x'.repeat(9 * 1024 * 1024))
    git(dir, 'commit', '--allow-empty', '-F', message)
    await expect(gitGraph(dir)).rejects.toMatchObject({ code: 'git-error' })
  })

  it('rejects option injection, unknown refs and malformed or unbounded cursors', async () => {
    const dir = repo(); commit(dir, 'one')
    for (const branch of ['--all', 'HEAD', 'main', 'refs/heads/main --all', 'refs/heads/main~1', 'refs/tags/v1', 'refs/heads/main\0']) {
      await expect(gitGraph(dir, { branch })).rejects.toMatchObject({ code: 'bad-request' })
    }
    for (const cursor of ['', '!', 'a'.repeat(513), Buffer.from(JSON.stringify({ version: 1, fingerprint: 'a'.repeat(64), offset: 10001 })).toString('base64url')]) {
      await expect(gitGraph(dir, { cursor })).rejects.toMatchObject({ code: 'bad-request' })
    }
    for (const count of [0, -1, NaN, 1.5]) await expect(gitGraph(dir, { count })).rejects.toMatchObject({ code: 'bad-request' })
  })
})
