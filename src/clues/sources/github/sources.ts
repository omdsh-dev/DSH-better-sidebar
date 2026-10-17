/**
 * The two built-in GitHub source registrations (S3).
 *
 * Issues and pull requests share one gh dependency, one account connection and
 * one provider client, but stay separate sources/types: a URL names the kind,
 * and a resource that exists as the other kind is reported as a type mismatch
 * instead of being rewritten.
 *
 * Contract highlights (the S1 operations seam):
 * - every list/search names ONE `owner/repo`; an absent scope is a request
 *   error and a cursor is bound to its range/query, so a late page can never
 *   leak into a new range;
 * - one page per request with a bounded limit; the provider total is passed
 *   through only when reported and `limited` only for the search-index cap;
 * - read is always a live fetch (freshness `live`); the edit document carries
 *   the opaque revision as its baseline; save refuses agent callers, requires
 *   the baseline, and only sends changed title/body fields;
 * - the portable form is exactly the normalized locator (no token, account or
 *   install path).
 */
import {
  ClueError,
  type ClueCandidate,
  type ClueEditDocument,
  type ClueListResult,
  type ClueLocatorContext,
  type ClueOperationContext,
  type CluePortableRef,
  type ClueReadResult,
  type ClueSaveEditInput,
  type ClueSaveEditResult,
  type ClueSourceDescriptor,
  type ClueTypeDescriptor,
  type JsonObject,
  type Locator,
} from '../../types.ts'
import type {
  ClueResolveInput,
  ClueSourceListInput,
  ClueSourceOperations,
  ClueSourceReadInput,
  ClueSourceSaveInput,
  ClueSourceSearchInput,
  ClueSourceRegistration,
} from '../../service.ts'
import {
  GITHUB_DEPENDENCY_ID,
  GITHUB_FORMAT,
  GITHUB_CONNECTION_ID,
  GITHUB_MAX_EDITABLE_CHARS,
  GITHUB_PLUGIN_ID,
  sourceIdOfKind,
  typeIdOfKind,
  type GithubKind,
  type GithubListScope,
  type GithubLocator,
  type GithubResource,
} from './ids.ts'
import {
  githubLocatorKey,
  githubLocatorOf,
  githubLocatorTitle,
  githubReferenceTitle,
  normalizeGithubLocator,
  parseGithubText,
  portableGithubLocator,
} from './url.ts'
import {
  decodeGithubCursor,
  encodeGithubCursor,
  pageLimitOf,
  parseGithubScope,
} from './scope.ts'
import type {
  GithubGhClient,
  GithubListItem,
  GithubListPage,
  GithubResourceSnapshot,
} from './gh.ts'

/** The seams the source operations consume (the client carries the runtime). */
export interface GithubSourceDeps {
  readonly client: GithubGhClient
  /** Clock for `fetchedAt`/`savedAt` (tests inject a fixed one). */
  readonly now?: () => string
}

/** The user-facing label of one kind. */
const KIND_LABELS: Readonly<Record<GithubKind, string>> = {
  issue: 'issue',
  pull: 'pull request',
}

/** Throw the fixed cancellation category when the caller aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ClueError('cancelled', 'the GitHub operation was cancelled')
}

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The host-side descriptor of one GitHub source. */
function descriptorOf(kind: GithubKind): ClueSourceDescriptor {
  return {
    sourceId: sourceIdOfKind(kind),
    name: kind === 'issue' ? 'GitHub Issues' : 'GitHub Pull requests',
    icon: 'github',
    order: kind === 'issue' ? 10 : 11,
    pluginId: GITHUB_PLUGIN_ID,
    types: [typeIdOfKind(kind)],
    transport: 'cli',
    capabilities: {
      resolve: true,
      list: true,
      search: true,
      read: true,
      edit: true,
      portable: true,
    },
    dependencyIds: [GITHUB_DEPENDENCY_ID],
    connectionId: GITHUB_CONNECTION_ID,
  }
}

/** The type descriptor of one GitHub source (text/markdown, non-atomic save). */
function typeDescriptorOf(kind: GithubKind): ClueTypeDescriptor {
  return {
    typeId: typeIdOfKind(kind),
    sourceId: sourceIdOfKind(kind),
    formats: [GITHUB_FORMAT],
    capabilities: {
      read: true,
      edit: true,
      // Re-read + compare before writing, but the pair is NOT atomic.
      concurrency: 'check-before-save',
    },
  }
}

/** The GitHub resource named by one normalized locator. */
function resourceOf(locator: GithubLocator): GithubResource {
  return {
    host: locator.host,
    owner: locator.owner,
    repo: locator.repo,
    kind: locator.kind,
    number: locator.number,
  }
}

/**
 * Validate a locator against THIS source's type/kind.
 * @throws {ClueError} `unsupported` for the other kind, `invalid-request` when malformed.
 */
function requireResource(kind: GithubKind, typeId: string, locator: Locator): GithubResource {
  if (typeId !== typeIdOfKind(kind)) {
    throw new ClueError(
      'unsupported',
      `the GitHub ${KIND_LABELS[kind]} source does not offer type "${typeId}"`,
    )
  }
  const normalized = normalizeGithubLocator(locator)
  if (normalized.kind !== kind) {
    throw new ClueError(
      'unsupported',
      `the reference is a ${KIND_LABELS[normalized.kind]}, not a ${KIND_LABELS[kind]}`,
    )
  }
  return resourceOf(normalized)
}

/** The candidate projection shared by resolve and list/search. */
function candidateOf(kind: GithubKind, locator: GithubLocator): ClueCandidate {
  return {
    sourceId: sourceIdOfKind(kind),
    typeId: typeIdOfKind(kind),
    locator: locator as unknown as Locator,
    title: githubLocatorTitle(locator) ?? githubReferenceTitle(locator),
    subtitle: `${locator.owner}/${locator.repo}`,
    meta: { kind: locator.kind, number: locator.number },
  }
}

/** Resolve one text/locator to a candidate for THIS source, or no candidate. */
function resolveCandidate(kind: GithubKind, input: ClueResolveInput): ClueCandidate | undefined {
  const explicit = input.explicit === true
  if (input.locator !== undefined) {
    // Auto resolution gives every source the same locator: a locator that is
    // not GitHub-shaped belongs to another source (no candidate). An explicit
    // call still reports a malformed GitHub-shaped value.
    try {
      const normalized = normalizeGithubLocator(input.locator)
      if (normalized.kind !== kind) {
        if (explicit) {
          throw new ClueError(
            'unsupported',
            `the reference is a ${KIND_LABELS[normalized.kind]}, not a ${KIND_LABELS[kind]}`,
          )
        }
        return undefined
      }
      if (input.typeId !== undefined && input.typeId !== typeIdOfKind(kind)) {
        throw new ClueError('unsupported', `the reference names type "${input.typeId}", not "${typeIdOfKind(kind)}"`)
      }
      return candidateOf(kind, normalized)
    } catch (error) {
      if (!explicit && error instanceof ClueError && error.category === 'invalid-request') return undefined
      throw error
    }
  }
  if (typeof input.text !== 'string') return undefined
  const parsed = parseGithubText(input.text)
  if (parsed === undefined) {
    if (explicit) {
      throw new ClueError(
        'invalid-request',
        'the text is not a github.com issue/pull URL or an owner/repo#number reference',
      )
    }
    return undefined
  }
  if (parsed.kind === 'url') {
    if (parsed.resource.kind !== kind) {
      if (explicit) {
        throw new ClueError(
          'unsupported',
          `the URL names a ${KIND_LABELS[parsed.resource.kind]}, not a ${KIND_LABELS[kind]}`,
        )
      }
      return undefined
    }
    if (input.typeId !== undefined && input.typeId !== typeIdOfKind(kind)) {
      throw new ClueError('unsupported', `the reference names type "${input.typeId}", not "${typeIdOfKind(kind)}"`)
    }
    return candidateOf(kind, githubLocatorOf(parsed.resource))
  }
  // The kind-less shorthand may only be resolved by an EXPLICIT source call:
  // auto resolution must not return both an issue and a pull candidate for the
  // same number.
  if (!explicit) return undefined
  if (input.typeId !== undefined && input.typeId !== typeIdOfKind(kind)) {
    throw new ClueError('unsupported', `the reference names type "${input.typeId}", not "${typeIdOfKind(kind)}"`)
  }
  return candidateOf(kind, githubLocatorOf({
    host: 'github.com',
    owner: parsed.owner,
    repo: parsed.repo,
    kind,
    number: parsed.number,
  }))
}

/** The JSON data half of one read / edit document. */
function dataOf(kind: GithubKind, snapshot: GithubResourceSnapshot): JsonObject {
  const data: JsonObject = {
    kind,
    owner: snapshot.resource.owner,
    repo: snapshot.resource.repo,
    number: snapshot.resource.number,
    title: snapshot.title,
    body: snapshot.body,
    state: snapshot.state,
    url: snapshot.url,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    labels: [...snapshot.labels],
    isArchived: snapshot.isArchived,
  }
  if (snapshot.stateReason !== undefined) data.stateReason = snapshot.stateReason
  if (snapshot.author !== undefined) data.author = snapshot.author
  if (snapshot.viewerPermission !== undefined) data.viewerPermission = snapshot.viewerPermission
  if (snapshot.isDraft !== undefined) data.isDraft = snapshot.isDraft
  if (snapshot.merged !== undefined) data.merged = snapshot.merged
  if (snapshot.mergedAt !== undefined) data.mergedAt = snapshot.mergedAt
  return data
}

/** The model-facing text projection: title + state + verbatim Markdown body. */
function textOf(snapshot: GithubResourceSnapshot): string {
  const header = [
    `# ${snapshot.title}`,
    '',
    `- state: ${snapshot.state}`,
    `- author: ${snapshot.author === undefined ? 'unknown' : `@${snapshot.author}`}`,
    `- updated: ${snapshot.updatedAt}`,
    `- url: ${snapshot.url}`,
  ]
  if (snapshot.labels.length > 0) header.push(`- labels: ${snapshot.labels.join(', ')}`)
  if (snapshot.isDraft !== undefined) header.push(`- draft: ${snapshot.isDraft}`)
  if (snapshot.merged !== undefined) header.push(`- merged: ${snapshot.merged}`)
  if (snapshot.isArchived) header.push('- repository: archived (read-only)')
  return `${header.join('\n')}\n\n${snapshot.body}`
}

/** Why an edit document is read-only, when it is. */
function readOnlyReasonOf(snapshot: GithubResourceSnapshot): string | undefined {
  if (snapshot.isArchived) return 'archived'
  if (snapshot.viewerPermission === 'READ' || snapshot.viewerPermission === 'NONE') return 'permission-denied'
  if (snapshot.body.length > GITHUB_MAX_EDITABLE_CHARS) return 'size'
  return undefined
}

/** Validate the save document's format/data (title/body only). */
function documentFieldsOf(document: ClueSaveEditInput): { title: string; body: string } {
  if (!isRecord(document)) {
    throw new ClueError('invalid-request', 'a GitHub save needs an edit document')
  }
  if (document.format !== GITHUB_FORMAT) {
    throw new ClueError('unsupported', `the GitHub editor only saves "${GITHUB_FORMAT}" documents`)
  }
  const data = document.data
  if (!isRecord(data)) {
    throw new ClueError('invalid-request', 'a GitHub save needs a document data object')
  }
  if (typeof data.title !== 'string') {
    throw new ClueError('invalid-request', 'a GitHub save needs a string title')
  }
  if (typeof data.body !== 'string') {
    throw new ClueError('invalid-request', 'a GitHub save needs a string body (empty is allowed)')
  }
  if (data.body.length > GITHUB_MAX_EDITABLE_CHARS) {
    throw new ClueError('unsupported', 'the GitHub body exceeds the editable size limit')
  }
  return { title: data.title, body: data.body }
}

/** Map one provider page to the S1 list contract, with a range-bound cursor. */
function pageToResult(
  kind: GithubKind,
  scope: GithubListScope,
  query: string,
  page: GithubListPage,
): ClueListResult {
  const repo = `${scope.repo.owner}/${scope.repo.repo}`
  const items: ClueCandidate[] = page.items.map((item: GithubListItem) => {
    const locator = githubLocatorOf({
      host: 'github.com',
      owner: scope.repo.owner,
      repo: scope.repo.repo,
      kind,
      number: item.number,
    })
    const meta: JsonObject = {
      kind,
      number: item.number,
      state: item.state,
      updatedAt: item.updatedAt,
      url: item.url,
    }
    if (item.author !== undefined) meta.author = item.author
    if (item.isDraft !== undefined) meta.isDraft = item.isDraft
    if (item.merged !== undefined) meta.merged = item.merged
    if (item.mergedAt !== undefined) meta.mergedAt = item.mergedAt
    return {
      sourceId: sourceIdOfKind(kind),
      typeId: typeIdOfKind(kind),
      locator: locator as unknown as Locator,
      title: item.title,
      subtitle: `#${item.number}`,
      meta,
    }
  })
  const range = {
    sourceId: sourceIdOfKind(kind),
    kind,
    repo,
    state: scope.state,
    query,
  }
  return {
    items,
    ...(page.nextAfter === undefined ? {} : { nextCursor: encodeGithubCursor({ ...range, after: page.nextAfter }) }),
    ...(page.total === undefined ? {} : { total: page.total }),
    ...(page.limited === true ? { limited: true } : {}),
  }
}

/** Parse + validate one list/search scope and page size. */
function scopeAndLimit(input: ClueSourceListInput): { scope: GithubListScope; limit: number } {
  return { scope: parseGithubScope(input.scope), limit: pageLimitOf(input.limit) }
}

/** Build one source's operations. */
function operationsOf(kind: GithubKind, deps: GithubSourceDeps): ClueSourceOperations {
  const now = deps.now ?? (() => new Date().toISOString())
  const sourceId = sourceIdOfKind(kind)

  /** Read one page (browse or search) and map it. */
  const page = async (
    input: ClueSourceListInput,
    context: ClueOperationContext,
    query: string,
  ): Promise<ClueListResult> => {
    const { scope, limit } = scopeAndLimit(input)
    const repo = `${scope.repo.owner}/${scope.repo.repo}`
    const range = { sourceId, kind, repo, state: scope.state, query }
    const after = input.cursor === undefined ? undefined : decodeGithubCursor(input.cursor, range)
    throwIfAborted(context.signal)
    const result = await deps.client.listPage({
      kind,
      repo: scope.repo,
      state: scope.state,
      limit,
      ...(after === undefined ? {} : { after }),
      ...(query === '' ? {} : { query }),
    }, context.signal)
    throwIfAborted(context.signal)
    return pageToResult(kind, scope, query, result)
  }

  return {
    async resolve(input: ClueResolveInput, context: ClueOperationContext): Promise<ClueCandidate | undefined> {
      throwIfAborted(context.signal)
      // Pure parse: resolution never calls gh, never writes a clue and never
      // opens an authorization flow.
      return resolveCandidate(kind, input)
    },

    async list(input: ClueSourceListInput, context: ClueOperationContext): Promise<ClueListResult> {
      return page(input, context, '')
    },

    async search(input: ClueSourceSearchInput, context: ClueOperationContext): Promise<ClueListResult> {
      const query = typeof input.query === 'string' ? input.query.trim() : ''
      // An empty query is the first browse page, never a cross-repository
      // search and never a title guess.
      if (query === '') return page(input, context, '')
      return page(input, context, query)
    },

    async read(input: ClueSourceReadInput, context: ClueOperationContext): Promise<ClueReadResult> {
      const resource = requireResource(kind, input.typeId, input.locator)
      throwIfAborted(context.signal)
      const snapshot = await deps.client.readResource(resource, context.signal)
      throwIfAborted(context.signal)
      return {
        format: GITHUB_FORMAT,
        data: dataOf(kind, snapshot),
        revision: snapshot.revision,
        fetchedAt: now(),
        freshness: 'live',
        text: textOf(snapshot),
      }
    },

    async loadEdit(input: ClueSourceReadInput, context: ClueOperationContext): Promise<ClueEditDocument> {
      const resource = requireResource(kind, input.typeId, input.locator)
      throwIfAborted(context.signal)
      const snapshot = await deps.client.readResource(resource, context.signal)
      throwIfAborted(context.signal)
      const readOnly = readOnlyReasonOf(snapshot)
      return {
        format: GITHUB_FORMAT,
        data: {
          ...dataOf(kind, snapshot),
          ...(readOnly === undefined ? {} : { readOnly: true, readOnlyReason: readOnly }),
        },
        baseRevision: snapshot.revision,
      }
    },

    async saveEdit(input: ClueSourceSaveInput, context: ClueOperationContext): Promise<ClueSaveEditResult> {
      // There is no agent write path: only the editor (a human action in the
      // floating window) may save, and this check keeps a future tool bridge
      // from reusing the UI operation.
      if (context.caller === 'agent') {
        throw new ClueError('unsupported', 'saving GitHub content is only available from the editor')
      }
      const resource = requireResource(kind, input.typeId, input.locator)
      const { title, body } = documentFieldsOf(input.document)
      const baseRevision = input.document.baseRevision
      if (typeof baseRevision !== 'string' || baseRevision === '') {
        throw new ClueError('invalid-request', 'a GitHub save needs the base revision from the editor load')
      }
      throwIfAborted(context.signal)
      const outcome = await deps.client.saveEdits({
        resource,
        title,
        body,
        baseRevision,
      }, context.signal)
      throwIfAborted(context.signal)
      return {
        ...(outcome.revision === undefined ? {} : { revision: outcome.revision }),
        savedAt: outcome.savedAt,
      }
    },

    async portable(input: ClueSourceReadInput, context: ClueOperationContext): Promise<CluePortableRef> {
      const resource = requireResource(kind, input.typeId, input.locator)
      throwIfAborted(context.signal)
      return portableGithubLocator(resource as unknown as Locator)
    },

    normalizeLocator(locator: Locator, _context: ClueLocatorContext): Locator {
      const normalized = normalizeGithubLocator(locator)
      if (normalized.kind !== kind) {
        throw new ClueError(
          'unsupported',
          `the reference is a ${KIND_LABELS[normalized.kind]}, not a ${KIND_LABELS[kind]}`,
        )
      }
      return normalized as unknown as Locator
    },

    locatorKey(locator: Locator): string {
      return githubLocatorKey(locator)
    },
  }
}

/**
 * Create both GitHub source registrations.
 *
 * The caller installs them through `createCluesService({ builtinSources })`
 * (S9); this function performs no registration itself.
 *
 * @param deps - the provider client and clock seam.
 */
export function createGithubSourceRegistrations(deps: GithubSourceDeps): ClueSourceRegistration[] {
  return (['issue', 'pull'] as const).map(kind => ({
    descriptor: descriptorOf(kind),
    types: [typeDescriptorOf(kind)],
    operations: operationsOf(kind, deps),
  }))
}
