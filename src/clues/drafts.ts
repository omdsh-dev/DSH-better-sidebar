/** Durable whole-body drafts. Only the unguessable id crosses the local commit route. */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ClueError } from './error.ts'
import { planFeishuDraft, type FeishuDraftBridge, type FeishuDraftPlan } from './drafts/feishu.ts'
import type { ClueCallOptions, CluesService } from './service.ts'
import type { ClueEditDocument, ClueSaveEditInput, ClueSaveEditResult, CluesReadParams, JsonObject } from './types.ts'

export type ClueDraftState = 'prepared' | 'committing' | 'committed' | 'failed' | 'partial' | 'uncertain'
export interface ClueDraft {
  readonly draftId: string
  readonly bodyPath: string
  readonly status: ClueDraftState
  readonly format: string
  readonly createdAt: string
  readonly error?: { readonly category: string; readonly message: string; readonly partial?: true }
  readonly result?: ClueSaveEditResult
}
interface StoredDraft extends ClueDraft {
  readonly version: 1
  readonly resource: CluesReadParams
  readonly baseline: ClueEditDocument
  readonly field: 'text' | 'body' | 'description' | 'xml'
  readonly nativeXml?: string
}
export interface ClueDraftManagerOptions {
  readonly clues: Pick<CluesService, 'loadEdit' | 'saveEdit'>
  /** Plugin user-data root, never the workspace cwd. Missing storage fails closed. */
  readonly root?: string
  readonly now?: () => string
  readonly maxDrafts?: number
  readonly maxBodyBytes?: number
  readonly maxStorageBytes?: number
  readonly feishu?: FeishuDraftBridge
}
export interface ClueDraftManager {
  prepare(resource: CluesReadParams, call?: ClueCallOptions): Promise<ClueDraft>
  commit(draftId: string): Promise<ClueDraft>
  discard(draftId: string): Promise<void>
  list(): Promise<readonly ClueDraft[]>
}
export const CLUE_DRAFT_LIMITS = { drafts: 64, bodyBytes: 8 * 1024 * 1024, storageBytes: 128 * 1024 * 1024 } as const
const ID = /^[a-f0-9]{48}$/u
const UNCERTAIN = 'The write outcome is uncertain; inspect the resource before preparing a new draft.'

function objectData(document: ClueEditDocument): JsonObject {
  if (document.data === null || typeof document.data !== 'object' || Array.isArray(document.data)) {
    throw new ClueError('unsupported', 'this resource has no editable body')
  }
  return document.data as JsonObject
}
function bodyOf(document: ClueEditDocument): { field: StoredDraft['field']; body: string } {
  const data = objectData(document)
  if (data.readOnly === true) throw new ClueError('permission-denied', 'this resource is read-only')
  for (const field of ['text', 'body', 'description'] as const) {
    if (typeof data[field] === 'string') return { field, body: data[field] as string }
  }
  throw new ClueError('unsupported', 'this resource has no supported complete body')
}
function publicDraft(draft: StoredDraft): ClueDraft {
  const { draftId, bodyPath, status, format, createdAt, result, error } = draft
  return { draftId, bodyPath, status, format, createdAt, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) }
}
function validLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) throw new ClueError('invalid-request', 'invalid clue draft capacity')
  return value
}
/** Read only a bounded regular file; native edits cannot redirect a commit through a symlink. */
async function readBounded(path: string, limit: number): Promise<string> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new ClueError('invalid-request', 'the draft file is not a bounded regular file')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit || stat.ino !== before.ino || stat.dev !== before.dev) throw new ClueError('invalid-request', 'the draft file changed while opening')
    const buffer = Buffer.alloc(Math.min(limit + 1, Math.max(stat.size + 1, 4096)))
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > limit || length === buffer.length) throw new ClueError('invalid-request', 'the draft body exceeds its capacity or changed while reading')
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)) }
    catch { throw new ClueError('invalid-request', 'the draft file must contain UTF-8 text') }
  } finally { await file.close() }
}
async function writeDurable(path: string, text: string, exclusive = false): Promise<void> {
  const file = await open(path, exclusive ? 'wx' : 'w', 0o600)
  try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
}
function sameBaseline(left: ClueEditDocument, right: ClueEditDocument): boolean {
  // Provider display metadata is intentionally excluded; the exact editable model and revision are not.
  return left.format === right.format && left.baseRevision === right.baseRevision && JSON.stringify(left.data) === JSON.stringify(right.data)
}
/** One manager per activation. Failed/uncertain files are never evicted to make room. */
export function createClueDraftManager(options: ClueDraftManagerOptions): ClueDraftManager {
  const maxDrafts = validLimit(options.maxDrafts, CLUE_DRAFT_LIMITS.drafts)
  const maxBody = validLimit(options.maxBodyBytes, CLUE_DRAFT_LIMITS.bodyBytes)
  const maxStorage = validLimit(options.maxStorageBytes, CLUE_DRAFT_LIMITS.storageBytes)
  const drafts = new Map<string, StoredDraft>()
  const inFlight = new Map<string, Promise<ClueDraft>>()
  let preparation = Promise.resolve()
  let ready: Promise<void> | undefined
  const root = options.root === undefined ? undefined : join(options.root, 'clue-drafts')
  const requireRoot = (): string => {
    if (root === undefined) throw new ClueError('failed', 'clue draft storage is unavailable')
    return root
  }
  const metadataPath = (id: string): string => join(requireRoot(), `${id}.json`)
  const attemptPath = (id: string): string => join(requireRoot(), `${id}.attempt`)
  const persist = async (draft: StoredDraft): Promise<void> => {
    const path = metadataPath(draft.draftId)
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeDurable(temporary, JSON.stringify(draft), true)
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    drafts.set(draft.draftId, draft)
  }
  const initialize = async (): Promise<void> => {
    await mkdir(requireRoot(), { recursive: true, mode: 0o700 })
    if (!(await lstat(requireRoot())).isDirectory() || (await lstat(requireRoot())).isSymbolicLink()) throw new ClueError('failed', 'the clue draft directory is invalid')
    const files = await readdir(requireRoot())
    const manifests = files.filter(name => /^[a-f0-9]{48}\.json$/u.test(name))
    if (manifests.length > maxDrafts) throw new ClueError('failed', 'the clue draft ledger exceeds its capacity; retained files need review')
    for (const name of manifests) {
      let draft: StoredDraft
      try {
        draft = JSON.parse(await readBounded(join(requireRoot(), name), maxStorage)) as StoredDraft
        if (draft.version !== 1 || !ID.test(draft.draftId) || name !== `${draft.draftId}.json` || draft.resource?.workspaceId === undefined || draft.baseline?.format === undefined || !['text', 'body', 'description', 'xml'].includes(draft.field) || !['prepared', 'failed', 'partial', 'uncertain', 'committing', 'committed'].includes(draft.status)) throw new Error('invalid ledger')
      } catch { throw new ClueError('failed', 'a retained clue draft ledger cannot be read; its files were preserved') }
      draft = { ...draft, bodyPath: join(requireRoot(), `${draft.draftId}.${draft.field === 'xml' ? 'xml' : 'md'}`) }
      if (draft.status === 'committing' || (!['committed', 'partial', 'uncertain'].includes(draft.status) && files.includes(`${draft.draftId}.attempt`))) {
        draft = { ...draft, status: 'uncertain', error: { category: 'failed', message: UNCERTAIN } }
        // Do not overwrite a live older manager's eventual committed receipt during recovery.
      }
      drafts.set(draft.draftId, draft)
    }
  }
  const ensureReady = (): Promise<void> => ready ??= initialize()
  const get = (id: string): StoredDraft => {
    if (typeof id !== 'string' || !ID.test(id)) throw new ClueError('invalid-request', 'invalid clue draft id')
    const draft = drafts.get(id)
    if (draft === undefined) throw new ClueError('not-found', 'the clue draft does not exist')
    return draft
  }
  const storageSize = async (): Promise<number> => {
    let size = 0
    for (const name of await readdir(requireRoot())) {
      const stat = await lstat(join(requireRoot(), name))
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ClueError('failed', 'the clue draft directory contains an unsupported entry')
      size += stat.size
    }
    return size
  }
  return {
    async prepare(resource, call = {}) {
      const execute = async (): Promise<ClueDraft> => {
        await ensureReady()
        if (drafts.size >= maxDrafts) {
          // Only successful receipts can expire automatically. Failed work is retained for review.
          const receipt = [...drafts.values()].find(value => value.status === 'committed')
          if (receipt !== undefined) {
            for (const path of [receipt.bodyPath, metadataPath(receipt.draftId), attemptPath(receipt.draftId)]) await rm(path, { force: true })
            drafts.delete(receipt.draftId)
          }
        }
        if (drafts.size >= maxDrafts) throw new ClueError('failed', 'clue draft capacity is full; review or discard a retained draft')
        if (resource.offset !== undefined) throw new ClueError('invalid-request', 'a draft requires the complete resource, not a page')
        const target = structuredClone({ ...resource, sessionId: resource.sessionId ?? call.sessionId })
        const document = await options.clues.loadEdit(target, { ...call, caller: 'agent-edit', sessionId: target.sessionId })
        if (document.format === 'feishu.docs.xml' && options.feishu === undefined) throw new ClueError('unsupported', 'the native XML draft bridge is unavailable')
        const { field, body } = document.format === 'feishu.docs.xml'
          ? { field: 'xml' as const, body: await options.feishu!.loadXml(document, target, call) }
          : bodyOf(document)
        if (Buffer.byteLength(body) > maxBody) throw new ClueError('unsupported', 'the complete resource body exceeds the draft capacity')
        const draftId = randomBytes(24).toString('hex')
        const bodyPath = join(requireRoot(), `${draftId}.${field === 'xml' ? 'xml' : 'md'}`)
        const draft: StoredDraft = { version: 1, draftId, bodyPath, status: 'prepared', format: document.format, createdAt: options.now?.() ?? new Date().toISOString(), resource: target, baseline: structuredClone(document), field, ...(field === 'xml' ? { nativeXml: body } : {}) }
        if (await storageSize() + Buffer.byteLength(JSON.stringify(draft)) + Buffer.byteLength(body) > maxStorage) throw new ClueError('failed', 'clue draft storage capacity is full; retained drafts were preserved')
        await writeDurable(bodyPath, body, true)
        await persist(draft)
        return publicDraft(draft)
      }
      const pending = preparation.then(execute)
      preparation = pending.then(() => {}, () => {})
      return pending
    },
    async commit(draftId) {
      const active = inFlight.get(draftId)
      if (active !== undefined) return active
      const commit = async (): Promise<ClueDraft> => {
        await ensureReady()
        let draft = get(draftId)
        if (draft.status === 'committed') return publicDraft(draft)
        if (draft.status === 'partial' || draft.status === 'uncertain' || draft.status === 'committing') throw new ClueError('conflict', draft.error?.message ?? UNCERTAIN)
        let document: ClueSaveEditInput
        let nativePlan: FeishuDraftPlan | undefined
        try {
          const body = await readBounded(draft.bodyPath, maxBody)
          if (await storageSize() > maxStorage) throw new ClueError('invalid-request', 'clue draft storage exceeds its capacity')
          const current = await options.clues.loadEdit(draft.resource, { caller: 'agent-edit', sessionId: draft.resource.sessionId })
          if (!sameBaseline(draft.baseline, current)) throw new ClueError('conflict', 'the resource changed since this draft was prepared; prepare a new draft')
          if (draft.field === 'xml') {
            if (options.feishu === undefined || draft.nativeXml === undefined) throw new ClueError('unsupported', 'the native XML draft bridge is unavailable')
            nativePlan = planFeishuDraft(draft.baseline, draft.nativeXml, body)
            document = nativePlan.document
          } else document = { format: draft.baseline.format, data: { ...objectData(draft.baseline), [draft.field]: body }, ...(draft.baseline.baseRevision === undefined ? {} : { baseRevision: draft.baseline.baseRevision }) }
        } catch (error) {
          const safe = error instanceof ClueError ? error : new ClueError('failed', 'the draft could not be read or its baseline verified; the file was preserved')
          draft = { ...draft, status: 'failed', error: { category: safe.category, message: safe.message } }
          await persist(draft)
          throw safe
        }
        // A durable exclusive marker closes the duplicate window across manager replacements.
        try { await writeDurable(attemptPath(draftId), 'attempted\n', true) }
        catch { throw new ClueError('conflict', UNCERTAIN) }
        try {
          draft = { ...draft, status: 'committing', error: undefined }
          await persist(draft)
          const result = nativePlan === undefined
            ? await options.clues.saveEdit({ ...draft.resource, document }, { caller: 'agent-edit', sessionId: draft.resource.sessionId })
            : await options.feishu!.save(nativePlan, draft.baseline, draft.resource)
          const saved: StoredDraft = { ...draft, status: 'committed', result }
          await persist(saved)
          // Keep the bounded receipt for repeat POSTs; only failed bodies need indefinite retention.
          await rm(saved.bodyPath, { force: true }).catch(() => {})
          return publicDraft(saved)
        } catch (error) {
          const partial = error instanceof ClueError && error.meta?.partial === 'true'
          const message = partial ? 'The resource was only partially updated; inspect it before preparing a new draft.' : UNCERTAIN
          draft = { ...draft, status: partial ? 'partial' : 'uncertain', error: { category: 'failed', message, ...(partial ? { partial: true } : {}) } }
          // Keep memory fail-closed even if the disk is full. The attempt marker restores it later.
          drafts.set(draftId, draft)
          await persist(draft).catch(() => {})
          throw new ClueError('failed', message, partial ? { partial: 'true' } : undefined)
        }
      }
      const pending = commit().finally(() => { inFlight.delete(draftId) })
      inFlight.set(draftId, pending)
      return pending
    },
    async discard(draftId) {
      await ensureReady()
      const draft = get(draftId)
      if (inFlight.has(draftId) || draft.status === 'committing') throw new ClueError('conflict', 'a committing draft cannot be discarded')
      // Paths are derived from a validated generated id, never a caller path or stored path.
      for (const path of [draft.bodyPath, metadataPath(draftId), attemptPath(draftId)]) await rm(path, { force: true })
      drafts.delete(draftId)
    },
    async list() { await ensureReady(); return [...drafts.values()].map(publicDraft) },
  }
}
