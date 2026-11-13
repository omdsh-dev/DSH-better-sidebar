/** Read-only, fresh defaults from the registered workspace; no CLI auth or persistence. */
import { runGit } from '../git.ts'
import { BUILTIN_SOURCE_IDS, type ClueDefaultScopeResult } from './types.ts'
import { parseGithubRepoRef } from './sources/github/url.ts'

const GIT_TIMEOUT_MS = 3_000
const GIT_MAX_BYTES = 64 * 1024

/** Reduce supported clone transports to a credential-free canonical repo reference. */
export function githubRepoOfRemote(value: string): string | undefined {
  const text = value.trim()
  let pathname: string
  const scp = /^git@github\.com:([^\s?#]+)$/i.exec(text)
  if (scp !== null) {
    pathname = scp[1]!
  } else {
    let url: URL
    try { url = new URL(text) } catch { return undefined }
    if (url.hostname.toLowerCase() !== 'github.com' || url.port !== '' || url.search !== '' || url.hash !== '') return undefined
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return undefined
    // Credentials are intentionally ignored, never copied to output or errors.
    pathname = url.pathname.replace(/^\//, '')
  }
  const repo = parseGithubRepoRef(pathname.replace(/\/$/, '').replace(/\.git$/i, ''))
  return repo === undefined ? undefined : `${repo.owner}/${repo.repo}`
}

/** Only canonical repo names leave this function; raw git output stays private. */
function scopeOfRemotes(output: string): ClueDefaultScopeResult {
  const remotes = new Map<string, Set<string>>()
  for (const entry of output.split('\0')) {
    const separator = entry.indexOf('\n')
    if (separator < 0) continue
    const name = /^remote\.(.+)\.url$/.exec(entry.slice(0, separator))?.[1]
    const repo = githubRepoOfRemote(entry.slice(separator + 1))
    if (name === undefined || repo === undefined) continue
    const repos = remotes.get(name) ?? new Set<string>()
    repos.add(repo)
    remotes.set(name, repos)
  }
  const result = (repo: string): ClueDefaultScopeResult => ({ scope: { repo, state: 'open' } })
  for (const preferred of ['origin', 'upstream']) {
    const repos = remotes.get(preferred)
    if (repos === undefined) continue
    if (repos.size > 1) return { reason: 'ambiguous-github-remotes' }
    return result([...repos][0]!)
  }
  const repos = new Set([...remotes.values()].flatMap(values => [...values]))
  if (repos.size === 0) return { reason: 'no-github-remote' }
  if (repos.size > 1) return { reason: 'ambiguous-github-remotes' }
  return result([...repos][0]!)
}

/** Resolves without running gh/lark, so it also works before installing either dependency. */
export async function inferClueDefaultScope(sourceId: string, workspacePath: string | undefined): Promise<ClueDefaultScopeResult> {
  if (sourceId === BUILTIN_SOURCE_IDS.feishuDocs) return { scope: { kind: 'drive-root' } }
  if (sourceId !== BUILTIN_SOURCE_IDS.githubIssues && sourceId !== BUILTIN_SOURCE_IDS.githubPulls) return { reason: 'no-default' }
  if (workspacePath === undefined) return { reason: 'workspace-unavailable' }
  try {
    // --local rejects a non-repository cwd and excludes global credential/remote config.
    const output = await runGit(workspacePath, ['config', '--local', '--null', '--get-regexp', '^remote\\..*\\.url$'], GIT_TIMEOUT_MS, { maxBytes: GIT_MAX_BYTES })
    return scopeOfRemotes(output)
  } catch (error) {
    // git config exits 1 (with no stderr) when the key has no matches.
    if (error instanceof Error && error.message === 'git exited with 1') return { reason: 'no-github-remote' }
    // Never propagate/log git stderr: it can contain embedded clone credentials.
    return { reason: 'git-unavailable' }
  }
}
