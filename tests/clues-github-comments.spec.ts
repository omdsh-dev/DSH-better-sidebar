/** UI19 public provider seam: one ordered connection, safe replies, no real gh. */
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/clues/request-gate.ts', () => vi.importActual('./fixtures/clues-source-request-gate.ts'))
import type { CliResult, CliRunRequest, ClueRuntime } from '../src/clues/runtime/types.ts'
import { createGithubGhClient } from '../src/clues/sources/github/gh.ts'
import { createGithubSourceRegistrations, type GithubCommentOperations } from '../src/clues/sources/github/sources.ts'
import type { GithubResource } from '../src/clues/sources/github/ids.ts'

const resource: GithubResource = { host: 'github.com', owner: 'acme', repo: 'app', kind: 'pull', number: 7 }
function result(payload: unknown): CliResult {
  return { exitCode: 0, stdout: JSON.stringify(payload), stderr: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1 }
}
function setup(handler: (request: CliRunRequest) => unknown) {
  const runs: CliRunRequest[] = []
  const runtime = {
    async prepareCli(request: CliRunRequest): Promise<() => Promise<CliResult>> { return () => runtime.runCli(request) },
    runCli: async (request: CliRunRequest) => {
    runs.push(request)
    const output = result(handler(request))
    return Buffer.byteLength(output.stdout) > (request.maxOutputBytes ?? Infinity) ? { ...output, stdout: '', stdoutTruncated: true } : output
  }, connections: { report() {} } } as unknown as ClueRuntime
  return { client: createGithubGhClient({ runtime: () => runtime, cwd: '/tmp' }), runs }
}
const comment = { __typename: 'IssueComment', id: 'IC_one', body: 'First', createdAt: '2026-10-01T01:00:00Z', updatedAt: '2026-10-01T01:00:00Z', url: 'https://github.com/acme/app/pull/7#issuecomment-1', author: { login: 'alice', name: 'Alice' } }

describe('GitHub discussion timeline', () => {
  it('uses an independent bounded discussion budget and clamps large pages for both resource kinds', async () => {
    for (const kind of ['issue', 'pull'] as const) {
      const { client, runs } = setup(request => {
        const first = Number(request.args.find(arg => arg.startsWith('first='))?.slice(6))
        const nodes = Array.from({ length: first }, (_, index) => ({ ...comment, id: `IC_${index}`, body: '\u0001'.repeat(65_536) }))
        const connection = { nodes, pageInfo: { hasNextPage: true, endCursor: 'more' } }
        return { data: { repository: kind === 'pull' ? { pullRequest: { timelineItems: connection } } : { issue: { comments: connection } } } }
      })
      const page = await client.listComments!({ resource: { ...resource, kind }, limit: 100 })
      expect(page.items).toHaveLength(20)
      expect(runs[0]!.args).toContain('first=20')
      expect(runs[0]!.maxOutputBytes).toBe(8 << 20)
      expect(page.nextAfter).toBe('more')
    }
  })

  it('exposes independent comment capability and binds cursors to one resource', async () => {
    const { client, runs } = setup(() => ({ data: { repository: { pullRequest: { timelineItems: {
      nodes: [comment], pageInfo: { hasNextPage: true, endCursor: 'next' },
    } } } } }))
    const source = createGithubSourceRegistrations({ client })[1]!
    expect(source.descriptor.capabilities.comments).toEqual({ read: true, create: true, reply: 'quote' })
    const operations = source.operations as GithubCommentOperations
    const input = { typeId: source.types[0]!.typeId, locator: { ...resource } }
    const page = await operations.listComments(input, { workspaceId: 'w', caller: 'agent' })
    expect(page.complete).toBe(false)
    await expect(operations.listComments({ ...input, locator: { ...resource, number: 8 }, cursor: page.nextCursor }, { workspaceId: 'w', caller: 'ui' })).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(operations.createComment({ ...input, body: 'Write', requestId: 'r' }, { workspaceId: 'w', caller: 'agent' })).rejects.toMatchObject({ category: 'permission-denied' })
    await expect(operations.createComment({ ...input, body: 'Write', requestId: 'r' }, { workspaceId: 'w', caller: 'agent-edit' })).rejects.toMatchObject({ category: 'permission-denied' })
    expect(runs).toHaveLength(1)
  })

  it('pages PR comments and nonempty review summaries on one provider timeline cursor', async () => {
    const { client, runs } = setup(request => {
      const continuation = request.args.includes('after=timeline-1')
      return { data: { repository: { pullRequest: { timelineItems: {
        nodes: continuation ? [
          { ...comment, id: 'IC_two', body: 'Last' },
        ] : [
          comment,
          { __typename: 'PullRequestReview', id: 'PRR_empty', body: '  ', state: 'APPROVED' },
          { __typename: 'PullRequestReview', id: 'PRR_one', body: 'Needs a test', state: 'CHANGES_REQUESTED', submittedAt: '2026-10-01T02:00:00Z', author: { login: 'bob' } },
        ], pageInfo: { hasNextPage: !continuation, endCursor: continuation ? null : 'timeline-1' },
      } } } } }
    })
    const first = await client.listComments!({ resource, limit: 3 })
    expect(first.items.map(item => [item.id, item.kind, item.body])).toEqual([
      ['IC_one', 'comment', 'First'], ['PRR_one', 'review', 'Needs a test'],
    ])
    expect(first.items[1]?.reviewState).toBe('CHANGES_REQUESTED')
    expect(first.nextAfter).toBe('timeline-1')
    const second = await client.listComments!({ resource, limit: 3, after: first.nextAfter })
    expect(second.items.map(item => item.id)).toEqual(['IC_two'])
    expect(runs).toHaveLength(2)
    const query = runs[0]!.args.find(arg => arg.startsWith('query='))!
    expect(query).toContain('timelineItems(')
    expect(query).toContain('ISSUE_COMMENT')
    expect(query).toContain('PULL_REQUEST_REVIEW')
    expect(query).not.toContain('reviews(')
  })

  it('allows normal issue comments with read-only repository permission and validates the requested kind', async () => {
    const { client, runs } = setup(request => request.args.includes('graphql')
      ? { data: { repository: { isArchived: false, viewerPermission: 'READ', issue: { id: 'I_one' } } } }
      : { node_id: 'IC_new', body: 'A comment', user: { login: 'me' } })
    await expect(client.createComment!({ resource: { ...resource, kind: 'issue' }, body: 'A comment' })).resolves.toMatchObject({ id: 'IC_new' })
    expect(runs).toHaveLength(2)
    const missing = setup(() => ({ data: { repository: { pullRequest: null } } }))
    await expect(missing.client.createComment!({ resource, body: 'A comment' })).rejects.toMatchObject({ category: 'not-found' })
    expect(missing.runs).toHaveLength(1)
  })

  it('quotes a verified parent in a normal PR discussion comment and sends text only through stdin', async () => {
    const { client, runs } = setup(request => request.args.includes('graphql')
      ? { data: { node: { ...comment, issue: { number: 7, repository: { nameWithOwner: 'acme/app' } }, pullRequest: { number: 7, repository: { nameWithOwner: 'acme/app' } } } } }
      : { node_id: 'IC_new', body: JSON.parse(String(request.stdin)).body, created_at: '2026-10-02T00:00:00Z', user: { login: 'me' } })
    const saved = await client.createComment!({ resource, body: 'A <safe> reply', replyToId: 'IC_one' })
    expect(saved.body).toContain('> First')
    expect(saved.body).toContain('A <safe> reply')
    expect(saved.replyToId).toBe('IC_one')
    expect(runs[1]!.args).toContain('repos/acme/app/issues/7/comments')
    expect(runs[1]!.args).toContain('--input')
    expect(runs[1]!.args.join(' ')).not.toContain('A <safe> reply')
  })

  it('rejects replies to a comment from a different resource before any write', async () => {
    const { client, runs } = setup(() => ({ data: { node: { ...comment, issue: { number: 99, repository: { nameWithOwner: 'acme/app' } } } } }))
    await expect(client.createComment!({ resource, body: 'Reply', replyToId: 'IC_one' })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(runs).toHaveLength(1)
  })
})
