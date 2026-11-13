/** Automatic scopes use only local registered git roots; no gh/lark/network calls. */
import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { githubRepoOfRemote } from '../src/clues/default-scope.ts'
import { createCluesService, type ClueSourceRegistration } from '../src/clues/service.ts'
import { registerCluesApi } from '../src/clues/api.ts'
import { BUILTIN_SOURCE_IDS, ClueError, type JsonValue } from '../src/clues/types.ts'
import { parseGithubScope } from '../src/clues/sources/github/scope.ts'
import { parseDocsListScope, parseDocsSearchScope } from '../src/clues/sources/feishu/docs.ts'
import { removeTree } from './temp-tree.ts'

const execute = promisify(execFile)
const roots: string[] = []
const issues = BUILTIN_SOURCE_IDS.githubIssues
const pulls = BUILTIN_SOURCE_IDS.githubPulls
const docs = BUILTIN_SOURCE_IDS.feishuDocs
const scope = (repo: string) => ({ repo, state: 'open' })

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'clue default scopes-'))
  roots.push(root)
  return root
}
async function git(root: string, ...args: string[]): Promise<void> {
  await execute('git', ['-C', root, ...args], { timeout: 5000, maxBuffer: 256 * 1024 })
}
async function repository(): Promise<string> {
  const root = directory()
  await git(root, 'init', '--quiet')
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(root.startsWith(join(tmpdir(), 'clue default scopes-'))).toBe(true)
    removeTree(root)
  }
})

function fixture(paths: Record<string, string> = {}, failProvider = false) {
  const seen: { sourceId: string; scope?: JsonValue; kind: string; query?: string; caller: string }[] = []
  const registration = (sourceId: string): ClueSourceRegistration => ({
    descriptor: { sourceId, name: sourceId, order: 1, pluginId: 'test', types: [], transport: 'cli', capabilities: { resolve: false, list: true, search: true, read: false, edit: false, portable: false } },
    types: [],
    operations: {
      async list(input, context) {
        seen.push({ sourceId, kind: 'list', scope: input.scope, caller: context.caller })
        if (sourceId === docs) parseDocsListScope(input.scope)
        else parseGithubScope(input.scope)
        if (failProvider) throw new ClueError('dependency-missing', 'provider dependency is missing')
        return { items: [] }
      },
      async search(input, context) {
        seen.push({ sourceId, kind: 'search', scope: input.scope, query: input.query, caller: context.caller })
        if (sourceId === docs) parseDocsSearchScope(input.scope)
        else parseGithubScope(input.scope)
        return { items: [] }
      },
    },
  })
  const store = join(directory(), 'store')
  const service = createCluesService({ root: store, builtinSources: [issues, pulls, docs].map(registration), resolveWorkspacePath: id => paths[id] })
  return { service, seen, store }
}

describe('GitHub remote canonicalization', () => {
  it.each([
    ['https://github.com/acme/repo.git', 'acme/repo'],
    ['https://username:private-credential@github.com/acme/repo.git', 'acme/repo'],
    ['https://private-credential@github.com/acme/repo', 'acme/repo'],
    ['git@github.com:acme/repo.git', 'acme/repo'],
    ['ssh://git@github.com/acme/repo.git', 'acme/repo'],
    ['https://github.com/acme/repo.git/', 'acme/repo'],
  ])('reduces %s to a canonical credential-free repo', (remote, expected) => {
    expect(githubRepoOfRemote(remote)).toBe(expected)
  })
  it.each([
    'https://github.com.evil.test/acme/repo.git', 'https://gitlab.com/acme/repo',
    'file:///acme/repo', '/local/acme/repo', 'https://github.com/acme/repo/tree/main',
    'https://github.com:444/acme/repo', 'git@github.com:acme/repo;echo-secret',
    'ssh://git@github.com/acme/repo?token=secret', 'not a URL',
  ])('refuses a foreign or malformed transport', remote => {
    expect(githubRepoOfRemote(remote)).toBeUndefined()
  })
})

describe('fresh read-only automatic scopes', () => {
  it('prefers origin and applies the same default to issue/pull list/search including mentions', async () => {
    const root = await repository()
    await git(root, 'remote', 'add', 'upstream', 'https://github.com/other/upstream.git')
    await git(root, 'remote', 'add', 'origin', 'git@github.com:acme/project.git')
    const config = readFileSync(join(root, '.git/config'), 'utf8')
    const { service, seen, store } = fixture({ ws: root })
    for (const sourceId of [issues, pulls]) {
      expect(await service.defaultScope({ workspaceId: 'ws', sourceId })).toEqual({ scope: scope('acme/project') })
      expect(await service.list({ workspaceId: 'ws', sourceId })).toEqual({ items: [], effectiveScope: scope('acme/project') })
      expect(await service.search({ workspaceId: 'ws', sourceId, query: 'bug' }, { caller: 'agent' })).toEqual({ items: [], effectiveScope: scope('acme/project') })
    }
    expect(seen).toHaveLength(4)
    expect(seen.filter(call => call.kind === 'search').every(call => call.query === 'bug' && call.caller === 'agent')).toBe(true)
    expect(readFileSync(join(root, '.git/config'), 'utf8')).toBe(config)
    expect(existsSync(store)).toBe(false)
  })
  it('uses upstream without origin, otherwise a single unambiguous GitHub repository', async () => {
    const root = await repository()
    await git(root, 'remote', 'add', 'mirror', 'https://github.com/acme/mirror.git')
    const { service } = fixture({ ws: root })
    expect(await service.defaultScope({ workspaceId: 'ws', sourceId: issues })).toEqual({ scope: scope('acme/mirror') })
    await git(root, 'remote', 'add', 'upstream', 'ssh://git@github.com/acme/main.git')
    expect(await service.defaultScope({ workspaceId: 'ws', sourceId: issues })).toEqual({ scope: scope('acme/main') })
    await git(root, 'remote', 'add', 'origin', 'https://gitlab.com/acme/main.git')
    expect(await service.defaultScope({ workspaceId: 'ws', sourceId: issues })).toEqual({ scope: scope('acme/main') })
  })
  it('returns a safe ambiguity reason instead of arbitrarily selecting a remote', async () => {
    const root = await repository()
    await git(root, 'remote', 'add', 'one', 'https://github.com/acme/one.git')
    await git(root, 'remote', 'add', 'two', 'https://github.com/acme/two.git')
    const { service } = fixture({ ws: root })
    expect(await service.defaultScope({ workspaceId: 'ws', sourceId: issues })).toEqual({ reason: 'ambiguous-github-remotes' })
    await expect(service.list({ workspaceId: 'ws', sourceId: issues })).rejects.toMatchObject({ category: 'invalid-request' })
    await git(root, 'remote', 'set-url', 'two', 'git@github.com:acme/one.git')
    expect(await service.defaultScope({ workspaceId: 'ws', sourceId: issues })).toEqual({ scope: scope('acme/one') })
  })
  it('refuses an ambiguous preferred remote with multiple repository URLs', async () => {
    const root = await repository()
    await git(root, 'remote', 'add', 'origin', 'https://github.com/acme/one.git')
    await git(root, 'config', '--add', 'remote.origin.url', 'https://github.com/acme/two.git')
    const { service } = fixture({ ws: root })
    expect(await service.defaultScope({ workspaceId: 'ws', sourceId: issues })).toEqual({ reason: 'ambiguous-github-remotes' })
  })
  it('keeps explicit scope authoritative, including invalid explicit null', async () => {
    const root = await repository()
    await git(root, 'remote', 'add', 'origin', 'https://github.com/auto/default.git')
    const { service, seen } = fixture({ ws: root })
    const explicit = { repo: 'chosen/repo', state: 'closed' }
    expect(await service.list({ workspaceId: 'ws', sourceId: issues, scope: explicit })).toEqual({ items: [] })
    expect(await service.search({ workspaceId: 'ws', sourceId: issues, scope: explicit, query: 'x' })).toEqual({ items: [] })
    expect(seen.slice(0, 2).every(call => call.scope === explicit)).toBe(true)
    await expect(service.list({ workspaceId: 'ws', sourceId: issues, scope: null })).rejects.toMatchObject({ category: 'invalid-request' })
  })
  it('reflects changed remotes and registry roots immediately, isolated by workspace id', async () => {
    const first = await repository(), second = await repository()
    await git(first, 'remote', 'add', 'origin', 'https://github.com/acme/first.git')
    await git(second, 'remote', 'add', 'origin', 'https://github.com/acme/second.git')
    const paths = { a: first, b: second }
    const { service } = fixture(paths)
    expect((await service.list({ workspaceId: 'a', sourceId: issues })).effectiveScope).toEqual(scope('acme/first'))
    expect((await service.list({ workspaceId: 'b', sourceId: issues })).effectiveScope).toEqual(scope('acme/second'))
    await git(first, 'remote', 'set-url', 'origin', 'https://github.com/acme/changed.git')
    expect((await service.list({ workspaceId: 'a', sourceId: issues })).effectiveScope).toEqual(scope('acme/changed'))
    paths.a = second
    expect((await service.list({ workspaceId: 'a', sourceId: issues })).effectiveScope).toEqual(scope('acme/second'))
  })
  it('has useful no-default reasons for missing workspace, non-repository and non-GitHub repositories', async () => {
    const root = await repository()
    const plain = directory()
    const { service } = fixture({ repo: root, plain })
    expect(await service.defaultScope({ workspaceId: 'unknown', sourceId: issues })).toEqual({ reason: 'workspace-unavailable' })
    expect(await service.defaultScope({ workspaceId: 'plain', sourceId: issues })).toEqual({ reason: 'git-unavailable' })
    expect(await service.defaultScope({ workspaceId: 'repo', sourceId: issues })).toEqual({ reason: 'no-github-remote' })
    await git(root, 'remote', 'add', 'origin', 'https://user:fake-sensitive@other.example/acme/repo.git')
    expect(await service.defaultScope({ workspaceId: 'repo', sourceId: issues })).toEqual({ reason: 'no-github-remote' })
  })
  it('does not expose credentials through scope, metadata, API results or errors', async () => {
    const root = await repository()
    await git(root, 'remote', 'add', 'origin', 'https://username:private-credential@github.com/acme/project.git')
    const { service } = fixture({ ws: root })
    registerCluesApi(service)
    const inferred = await service.invokeApi('clues.defaultScope', { workspaceId: 'ws', sourceId: issues })
    const listed = await service.invokeApi('clues.list', { workspaceId: 'ws', sourceId: issues })
    expect(inferred).toEqual({ scope: scope('acme/project') })
    expect(JSON.stringify([inferred, listed])).not.toMatch(/username|private-credential|https:|@github/)
    appendFileSync(join(root, '.git/config'), `\n[remote "origin"]\n\turl = https://username:${'private-credential'.repeat(5000)}@github.com/acme/project.git\n`)
    expect(await service.defaultScope({ workspaceId: 'ws', sourceId: issues })).toEqual({ reason: 'git-unavailable' })
  })
  it('serves defaults before provider dependency checks and validates the API', async () => {
    const root = await repository()
    await git(root, 'remote', 'add', 'origin', 'https://github.com/acme/project.git')
    const { service, seen } = fixture({ ws: root }, true)
    registerCluesApi(service)
    expect(await service.invokeApi('clues.defaultScope', { workspaceId: 'ws', sourceId: issues })).toEqual({ scope: scope('acme/project') })
    expect(seen).toHaveLength(0)
    await expect(service.list({ workspaceId: 'ws', sourceId: issues })).rejects.toMatchObject({ category: 'dependency-missing' })
    for (const payload of [null, {}, { workspaceId: 'ws' }, { workspaceId: 1, sourceId: issues }]) {
      await expect(service.invokeApi('clues.defaultScope', payload)).rejects.toMatchObject({ category: 'invalid-request' })
    }
    await expect(service.defaultScope({ workspaceId: 'ws', sourceId: 'unknown' })).rejects.toMatchObject({ category: 'source-missing' })
    const abort = new AbortController()
    abort.abort()
    await expect(service.defaultScope({ workspaceId: 'ws', sourceId: issues }, { signal: abort.signal })).rejects.toMatchObject({ category: 'cancelled' })
  })
  it('defaults Feishu docs browse to drive-root while absent search scope stays account-wide', async () => {
    const { service, seen } = fixture()
    expect(await service.defaultScope({ workspaceId: 'ws', sourceId: docs })).toEqual({ scope: { kind: 'drive-root' } })
    expect(await service.list({ workspaceId: 'ws', sourceId: docs })).toEqual({ items: [], effectiveScope: { kind: 'drive-root' } })
    expect(await service.search({ workspaceId: 'ws', sourceId: docs, query: 'report' })).toEqual({ items: [] })
    const explicit = { kind: 'drive', folderToken: 'chosen' }
    await service.search({ workspaceId: 'ws', sourceId: docs, scope: explicit, query: 'report' })
    expect(seen.map(call => call.scope)).toEqual([{ kind: 'drive-root' }, undefined, explicit])
    await expect(service.search({ workspaceId: 'ws', sourceId: docs, scope: { kind: 'drive-root' }, query: 'report' })).rejects.toMatchObject({ category: 'invalid-request' })
  })
})
