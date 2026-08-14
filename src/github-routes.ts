/**
 * GitHub routes of the /sidebar JSON API ('github.state' / 'github.thread'
 * / 'github.markRead' / 'github.markDone' / 'github.markAllRead' /
 * 'github.review' / 'github.comment' / 'github.mergeStatus' /
 * 'github.merge'). The routes mount as METHODS on the existing /sidebar/api
 * table, so they inherit the prefix route's trust fence, POST-only check,
 * and body bound with zero new route registrations.
 *
 * The inbox is account-global (not session-scoped): none of these payloads
 * read the sessionId the shared wrapper stamps on every request.
 */
import {
  GITHUB_BODY_MAX,
  githubErrorToSidebar,
  type GithubInboxService,
  type GithubMergeStatus,
  type GithubStateResult,
  type GithubThread,
} from './github.ts'
import { requireString, SidebarError } from './wire.ts'

/** Review events the GitHub reviews endpoint accepts. */
const REVIEW_EVENTS = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'])
/** Merge methods the GitHub merge endpoint accepts. */
const MERGE_METHODS = new Set(['merge', 'squash', 'rebase'])

/** The GitHub routes of the sidebar API. */
export interface SidebarGithubRoutes {
  /** The inbox snapshot (conditional fetch behind the freshness window; force bypasses it). */
  state(payload: unknown): Promise<GithubStateResult>
  /** One thread's detail plus its latest comment body. */
  thread(payload: unknown): Promise<{ thread: GithubThread; commentBody?: string }>
  markRead(payload: unknown): Promise<{ ok: true }>
  markDone(payload: unknown): Promise<{ ok: true }>
  markAllRead(payload: unknown): Promise<{ ok: true }>
  review(payload: unknown): Promise<{ ok: true }>
  comment(payload: unknown): Promise<{ ok: true }>
  mergeStatus(payload: unknown): Promise<GithubMergeStatus>
  merge(payload: unknown): Promise<{ ok: true }>
}

/**
 * Build the GitHub route group over one inbox service. Payload validation
 * is strict (wrong values fail loud as bad-request); GitHub-side failures
 * are re-thrown through {@link githubErrorToSidebar} so the client gets the
 * machine-readable codes (github-auth / github-rejected / …).
 * @param service - the host's inbox service (token chain + cache + actions).
 */
export function buildGithubApi(service: GithubInboxService): SidebarGithubRoutes {
  /** Optional bounded string field of a payload (undefined when absent). */
  const optionalBody = (payload: unknown): string | undefined => {
    const record = payload as { body?: unknown } | null
    if (record?.body === undefined) return undefined
    if (typeof record.body !== 'string') throw new SidebarError('bad-request', '"body" must be a string')
    if (record.body.length > GITHUB_BODY_MAX) throw new SidebarError('bad-request', `"body" is too long (max ${GITHUB_BODY_MAX} chars)`)
    return record.body === '' ? undefined : record.body
  }

  /** Parse the 'owner/name' repo plus a positive integer number field. */
  const repoAndNumber = (payload: unknown, numberKey: string): { repo: string; number: number } => {
    const repo = requireString(payload, 'repo')
    // GitHub's owner/name charset: alphanumerics plus - _ . (no slashes
    // beyond the separator, no query/fragment escapes).
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new SidebarError('bad-request', '"repo" must be an owner/name pair')
    }
    const record = payload as Record<string, unknown>
    const value = record[numberKey]
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new SidebarError('bad-request', `"${numberKey}" must be a positive integer`)
    }
    return { repo, number: value }
  }

  /**
   * Validate a thread id: GitHub thread ids are numeric strings — the
   * strict contract rejects anything else before it reaches the REST path.
   */
  const requireThreadId = (payload: unknown): string => {
    const id = requireString(payload, 'id')
    if (!/^\d{1,20}$/.test(id)) throw new SidebarError('bad-request', '"id" must be a numeric thread id')
    return id
  }

  /** Wrap a service call so GitHub failures surface as sidebar wire errors. */
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      throw githubErrorToSidebar(error)
    }
  }

  return {
    state: (payload) => {
      const record = payload as { force?: unknown } | null
      return service.state(record?.force === true)
    },
    thread: (payload) => {
      const id = requireThreadId(payload)
      return guard(() => service.thread(id))
    },
    markRead: (payload) => {
      const id = requireThreadId(payload)
      return guard(async () => {
        await service.markRead(id)
        return { ok: true as const }
      })
    },
    markDone: (payload) => {
      const id = requireThreadId(payload)
      return guard(async () => {
        await service.markDone(id)
        return { ok: true as const }
      })
    },
    markAllRead: () => guard(async () => {
      await service.markAllRead()
      return { ok: true as const }
    }),
    review: (payload) => {
      const { repo, number } = repoAndNumber(payload, 'pr')
      const event = requireString(payload, 'event')
      if (!REVIEW_EVENTS.has(event)) {
        throw new SidebarError('bad-request', 'event must be APPROVE, REQUEST_CHANGES, or COMMENT')
      }
      const body = optionalBody(payload)
      return guard(async () => {
        await service.review(repo, number, event, body)
        return { ok: true as const }
      })
    },
    comment: (payload) => {
      const { repo, number } = repoAndNumber(payload, 'issue')
      const body = requireString(payload, 'body')
      if (body === '' || body.length > GITHUB_BODY_MAX) {
        throw new SidebarError('bad-request', `"body" must be 1–${GITHUB_BODY_MAX} chars`)
      }
      return guard(async () => {
        await service.comment(repo, number, body)
        return { ok: true as const }
      })
    },
    mergeStatus: (payload) => {
      const { repo, number } = repoAndNumber(payload, 'pr')
      return guard(() => service.mergeStatus(repo, number))
    },
    merge: (payload) => {
      const { repo, number } = repoAndNumber(payload, 'pr')
      const method = requireString(payload, 'method')
      if (!MERGE_METHODS.has(method)) {
        throw new SidebarError('bad-request', 'method must be merge, squash, or rebase')
      }
      return guard(async () => {
        await service.merge(repo, number, method)
        return { ok: true as const }
      })
    },
  }
}
