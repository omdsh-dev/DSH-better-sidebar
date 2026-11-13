/** Whole-resource GitHub discussion: a single timeline cursor includes PR reviews. */
import { ClueError, type ClueComment } from '../../types.ts'
import type { GithubResource } from './ids.ts'

const AUTHOR = 'author{login url ... on User{name} ... on Organization{name}}'
const COMMENT_FIELDS = `id body createdAt updatedAt url ${AUTHOR}`
const REVIEW_FIELDS = `id body createdAt submittedAt updatedAt url state ${AUTHOR}`

export interface GithubDiscussionQuery {
  readonly resource: GithubResource
  readonly limit: number
  readonly after?: string
}
export interface GithubDiscussionPage {
  readonly items: readonly ClueComment[]
  readonly nextAfter?: string
  readonly total?: number
}
export interface GithubCommentInput {
  readonly resource: GithubResource
  readonly body: string
  readonly replyToId?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Both kinds return one connection in provider order; reviews are never paged separately. */
export function githubCommentsArgs(input: GithubDiscussionQuery): string[] {
  const fields = input.resource.kind === 'pull'
    ? `pullRequest(number:$number){timelineItems(first:$first,after:$after,itemTypes:[ISSUE_COMMENT,PULL_REQUEST_REVIEW]){pageInfo{hasNextPage endCursor} nodes{__typename ... on IssueComment{${COMMENT_FIELDS}} ... on PullRequestReview{${REVIEW_FIELDS}}}}}`
    : `issue(number:$number){comments(first:$first,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{${COMMENT_FIELDS}}}}`
  return [
    'api', 'graphql', '--hostname', input.resource.host,
    '-f', `query=query($owner:String!,$repo:String!,$number:Int!,$first:Int!,$after:String){repository(owner:$owner,name:$repo){${fields}}}`,
    '-f', `owner=${input.resource.owner}`, '-f', `repo=${input.resource.repo}`,
    '-F', `number=${input.resource.number}`, '-F', `first=${input.limit}`,
    ...(input.after === undefined ? [] : ['-f', `after=${input.after}`]),
  ]
}

export function githubCommentOf(value: unknown, rest = false): ClueComment {
  const node = record(value)
  const id = text(rest ? node?.node_id : node?.id)
  if (node === undefined || id === undefined || typeof node.body !== 'string') {
    throw new ClueError('failed', 'GitHub returned a malformed comment')
  }
  const author = record(rest ? node.user : node.author)
  const handle = text(author?.login)
  const name = text(author?.name)
  const authorUrl = text(rest ? author?.html_url : author?.url)
  const review = node.__typename === 'PullRequestReview'
  const createdAt = text(rest ? node.created_at : review ? node.submittedAt ?? node.createdAt : node.createdAt)
  const updatedAt = text(rest ? node.updated_at : node.updatedAt)
  const url = text(rest ? node.html_url : node.url)
  return {
    id, kind: review ? 'review' : 'comment', format: 'text/markdown', body: node.body,
    ...(handle === undefined && name === undefined ? {} : { author: {
      ...(handle === undefined ? {} : { handle }), ...(name === undefined ? {} : { name }),
      ...(authorUrl === undefined ? {} : { url: authorUrl }),
    } }),
    ...(createdAt === undefined ? {} : { createdAt }), ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(url === undefined ? {} : { url }),
    ...(review && text(node.state) !== undefined ? { reviewState: text(node.state) } : {}),
  }
}

export function githubDiscussionOf(data: unknown, resource: GithubResource): GithubDiscussionPage {
  const repository = record(record(data)?.repository)
  const node = record(resource.kind === 'pull' ? repository?.pullRequest : repository?.issue)
  if (node === undefined) throw new ClueError('not-found', 'the GitHub discussion resource is not visible')
  const connection = record(resource.kind === 'pull' ? node.timelineItems : node.comments)
  if (!Array.isArray(connection?.nodes)) throw new ClueError('failed', 'GitHub returned a malformed discussion page')
  const pageInfo = record(connection.pageInfo)
  if (typeof pageInfo?.hasNextPage !== 'boolean' || (pageInfo.hasNextPage && text(pageInfo.endCursor) === undefined)) {
    throw new ClueError('failed', 'GitHub did not provide a usable discussion continuation')
  }
  const items = connection.nodes.filter(value => {
    const entry = record(value)
    // Empty review events are deliberately omitted, while the provider cursor still advances.
    return entry?.__typename !== 'PullRequestReview' || (typeof entry.body === 'string' && entry.body.trim() !== '')
  }).map(value => githubCommentOf(value))
  const total = connection.totalCount
  return {
    items,
    ...(pageInfo.hasNextPage ? { nextAfter: text(pageInfo.endCursor)! } : {}),
    ...(typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? { total } : {}),
  }
}

export function githubReplyParentArgs(resource: GithubResource, id: string): string[] {
  if (!/^[A-Za-z0-9_=-]{1,256}$/.test(id)) throw new ClueError('invalid-request', 'invalid GitHub reply parent')
  const owner = 'number repository{nameWithOwner}'
  return ['api', 'graphql', '--hostname', resource.host,
    '-f', `query=query($id:ID!){node(id:$id){__typename ... on IssueComment{${COMMENT_FIELDS} issue{${owner}} pullRequest{${owner}}} ... on PullRequestReview{${REVIEW_FIELDS} pullRequest{${owner}}}}}`,
    '-f', `id=${id}`,
  ]
}

/** Native issue/PR discussion comments have no reply verb; quote a server-verified parent. */
export function githubQuotedReply(data: unknown, input: GithubCommentInput): string {
  const node = record(record(data)?.node)
  const parentResource = record(input.resource.kind === 'pull' ? node?.pullRequest : node?.issue)
  const repository = record(parentResource?.repository)
  if (node?.id !== input.replyToId || parentResource?.number !== input.resource.number
    || text(repository?.nameWithOwner)?.toLowerCase() !== `${input.resource.owner}/${input.resource.repo}`.toLowerCase()
    || (input.resource.kind === 'issue' && (node?.__typename === 'PullRequestReview' || record(node?.pullRequest) !== undefined))) {
    throw new ClueError('invalid-request', 'the reply parent does not belong to this GitHub resource')
  }
  const parent = githubCommentOf(node)
  const by = parent.author?.handle === undefined ? '' : ` @${parent.author.handle}`
  const link = parent.url !== undefined && /^https:\/\/github\.com\//.test(parent.url) ? ` (${parent.url})` : ''
  const quote = parent.body.slice(0, 4000).split('\n').map(line => `> ${line}`).join('\n')
  return `Reply to${by}${link}\n\n${quote}\n\n${input.body}`
}

export function requireGithubCommentBody(body: string): void {
  if (typeof body !== 'string' || body.trim() === '' || body.length > 60_000) {
    throw new ClueError('invalid-request', 'a GitHub comment needs nonempty text within the size limit')
  }
}

/** Bind discussion cursors to the exact resource, independent of body/list pagination. */
export function githubDiscussionCursor(resource: GithubResource, after?: string): string | undefined {
  return after === undefined ? undefined : Buffer.from(JSON.stringify({ resource, after })).toString('base64url')
}
export function githubDiscussionAfter(resource: GithubResource, cursor?: string): string | undefined {
  if (cursor === undefined) return undefined
  if (cursor.length > 8192) throw new ClueError('invalid-request', 'invalid GitHub discussion cursor')
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const other = parsed.resource
    if (other?.host !== resource.host || other?.owner !== resource.owner || other?.repo !== resource.repo
      || other?.number !== resource.number || other?.kind !== resource.kind || typeof parsed.after !== 'string' || parsed.after === '') throw new Error('range')
    return parsed.after
  } catch {
    throw new ClueError('invalid-request', 'the discussion cursor belongs to a different GitHub resource or is invalid')
  }
}
