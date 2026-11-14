/**
 * Validation and time normalization for the display metadata snapshot
 * ({@link ClueResourceInfo}) and the clue subtitle.
 *
 * This module is deliberately node-free: host sources, the service, the store
 * and the browser bundle may import it. It owns the ONE bounded shape the core
 * accepts from a source or from `clues.ensure`; unknown keys are dropped and
 * malformed values fail as a typed `invalid-request` instead of reaching the
 * persisted library.
 *
 * Time mapping follows the same rule as the rest of the feature line: a
 * provider value is converted ONLY when it is present. Epoch numbers are
 * interpreted in the unit the caller declares, or auto-detected by magnitude
 * for providers that have used both spellings (seconds < 1e12 <= millis).
 * There is no "now" fallback.
 */
import {
  CLUE_CHECK_STATES,
  CLUE_MAX_CHECK_RUNS,
  CLUE_RESOURCE_STATES,
  ClueError,
  type ClueCheckState,
  type CluePerson,
  type ClueResourceBranches,
  type ClueResourceCheck,
  type ClueResourceCounts,
  type ClueResourceInfo,
  type ClueResourceState,
  type ClueResourceTime,
} from './types.ts'

/** Longest display subtitle persisted on a clue. */
export const MAX_CLUE_SUBTITLE_LENGTH = 500
/** Longest person id/name/handle string. */
export const MAX_CLUE_PERSON_TEXT = 300
/** Longest display URL accepted for a person/resource link. */
export const MAX_CLUE_INFO_URL = 2048
/** Longest repository/path display string. */
export const MAX_CLUE_INFO_PATH = 4096
/** Longest label string. */
export const MAX_CLUE_INFO_LABEL = 100
/** Maximum people in one assignees/followers list. */
export const MAX_CLUE_INFO_PEOPLE = 50
/** Maximum labels on one resource. */
export const MAX_CLUE_INFO_LABELS = 100
/** Longest check name/job string (a workflow may prefix a long matrix leg). */
export const MAX_CLUE_CHECK_NAME = 300

/** The epoch unit of a provider number. `auto` picks by magnitude. */
export type ClueInstantUnit = 'auto' | 'ms' | 's'

/** Whether a value is a plain JSON object (not null / array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Whether a string contains an ASCII control character (never display text). */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** A bounded, trimmed display string (rejects empty/control/oversized). */
function displayText(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') {
    throw new ClueError('invalid-request', `${what} must be a string`)
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new ClueError('invalid-request', `${what} must be a non-empty string`)
  }
  if (trimmed.length > max) {
    throw new ClueError('invalid-request', `${what} is longer than ${max} characters`)
  }
  if (hasControlCharacters(trimmed)) {
    throw new ClueError('invalid-request', `${what} contains control characters`)
  }
  return trimmed
}

/** A bounded display path: whitespace is significant on POSIX, so no trim. */
function displayPath(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new ClueError('invalid-request', 'clue resource info.path must be a non-empty string')
  }
  if (value.length > MAX_CLUE_INFO_PATH) {
    throw new ClueError('invalid-request', `clue resource info.path is longer than ${MAX_CLUE_INFO_PATH} characters`)
  }
  if (hasControlCharacters(value)) {
    throw new ClueError('invalid-request', 'clue resource info.path contains control characters')
  }
  return value
}

/** A safe http(s) display URL. */
function displayUrl(value: unknown, what: string): string {
  const url = displayText(value, what, MAX_CLUE_INFO_URL)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ClueError('invalid-request', `${what} must be an absolute http(s) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ClueError('invalid-request', `${what} must be an absolute http(s) URL`)
  }
  return url
}

/**
 * Normalize one provider instant (ISO string, epoch milliseconds or epoch
 * seconds) to an ISO-8601 UTC string.
 *
 * @param value - the provider value; absent/empty/invalid answers undefined.
 * @param unit - the declared epoch unit, or `auto` to pick by magnitude.
 */
export function isoInstantOf(value: unknown, unit: ClueInstantUnit = 'auto'): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    return isoOfEpoch(value, unit)
  }
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text)
    return Number.isFinite(numeric) ? isoOfEpoch(numeric, unit) : undefined
  }
  // The Feishu CLI spells some task instants as the host-local wall clock
  // (`YYYY-MM-DD HH:mm:ss`, Go's time.DateTime). Its meaning is the local
  // wall clock, not UTC; `Date.parse` of this spelling is implementation-
  // defined, so parse the components explicitly.
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text)
  if (local !== null) {
    const millis = new Date(
      Number(local[1]),
      Number(local[2]) - 1,
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
      Number(local[6]),
    ).getTime()
    return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined
  }
  const millis = Date.parse(text)
  if (!Number.isFinite(millis)) return undefined
  return new Date(millis).toISOString()
}

/** Convert one finite epoch value to ISO using the requested unit. */
function isoOfEpoch(value: number, unit: ClueInstantUnit): string | undefined {
  let millis: number
  if (unit === 'ms') millis = value
  else if (unit === 's') millis = value * 1000
  else {
    // Auto-detect follows the documented provider spellings: a 10-digit value
    // is epoch seconds, a 13-digit value is epoch milliseconds. The boundary
    // 1e12 sits between them for every plausible modern date.
    millis = Math.abs(value) < 1e12 ? value * 1000 : value
  }
  if (!Number.isFinite(millis)) return undefined
  const date = new Date(millis)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

/** Normalize one person snapshot, or undefined when the value is absent. */
function personOf(value: unknown, what: string): CluePerson | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new ClueError('invalid-request', `${what} must be a JSON object`)
  }
  const person: { id?: string; name?: string; handle?: string; url?: string } = {}
  if (value.id !== undefined) person.id = displayText(value.id, `${what}.id`, MAX_CLUE_PERSON_TEXT)
  if (value.name !== undefined) person.name = displayText(value.name, `${what}.name`, MAX_CLUE_PERSON_TEXT)
  if (value.handle !== undefined) person.handle = displayText(value.handle, `${what}.handle`, MAX_CLUE_PERSON_TEXT)
  if (value.url !== undefined) person.url = displayUrl(value.url, `${what}.url`)
  if (Object.keys(person).length === 0) {
    throw new ClueError('invalid-request', `${what} must name at least one id, name, handle or url`)
  }
  return person
}

/** Normalize one bounded person list. */
function peopleOf(value: unknown, what: string): CluePerson[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new ClueError('invalid-request', `${what} must be an array`)
  }
  if (value.length > MAX_CLUE_INFO_PEOPLE) {
    throw new ClueError('invalid-request', `${what} has more than ${MAX_CLUE_INFO_PEOPLE} entries`)
  }
  return value.map((entry, index) => {
    const person = personOf(entry, `${what}[${index}]`)
    if (person === undefined) {
      throw new ClueError('invalid-request', `${what}[${index}] must be a person object`)
    }
    return person
  })
}

/** Normalize the label names of one resource (duplicates are corrupt input). */
function labelsOf(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new ClueError('invalid-request', 'clue resource info labels must be an array')
  }
  if (value.length > MAX_CLUE_INFO_LABELS) {
    throw new ClueError('invalid-request', `clue resource info has more than ${MAX_CLUE_INFO_LABELS} labels`)
  }
  const labels: string[] = []
  const seen = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const label = displayText(entry, `clue resource info labels[${index}]`, MAX_CLUE_INFO_LABEL)
    if (seen.has(label)) {
      throw new ClueError('invalid-request', `clue resource info labels contain duplicate "${label}"`)
    }
    seen.add(label)
    labels.push(label)
  }
  return labels
}

/** Normalize one display time; absent stays absent. */
function timeOf(value: unknown, what: string): ClueResourceTime | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new ClueError('invalid-request', `${what} must be a JSON object`)
  }
  if (value.at === undefined) {
    throw new ClueError('invalid-request', `${what}.at is required`)
  }
  const at = isoInstantOf(value.at)
  if (at === undefined) {
    throw new ClueError('invalid-request', `${what}.at must be an ISO instant`)
  }
  if (value.allDay !== undefined && typeof value.allDay !== 'boolean') {
    throw new ClueError('invalid-request', `${what}.allDay must be a boolean`)
  }
  return { at, ...(value.allDay === undefined ? {} : { allDay: value.allDay }) }
}

/** Normalize one branch block; an empty block is dropped. */
function branchesOf(value: unknown): ClueResourceBranches | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new ClueError('invalid-request', 'clue resource info branches must be a JSON object')
  }
  const branches: { head?: string; base?: string; headRepository?: string; baseRepository?: string } = {}
  for (const key of ['head', 'base', 'headRepository', 'baseRepository'] as const) {
    if (value[key] !== undefined) {
      branches[key] = displayText(value[key], `clue resource info branches.${key}`, MAX_CLUE_PERSON_TEXT)
    }
  }
  return Object.keys(branches).length === 0 ? undefined : branches
}

/** Normalize the provider count block; unknown keys and empty blocks are dropped. */
function countsOf(value: unknown): ClueResourceCounts | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new ClueError('invalid-request', 'clue resource info counts must be a JSON object')
  }
  const counts: {
    comments?: number
    commits?: number
    changedFiles?: number
    additions?: number
    deletions?: number
  } = {}
  for (const key of ['comments', 'commits', 'changedFiles', 'additions', 'deletions'] as const) {
    const raw = value[key]
    if (raw === undefined) continue
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
      throw new ClueError('invalid-request', `clue resource info counts.${key} must be a non-negative integer`)
    }
    counts[key] = raw
  }
  return Object.keys(counts).length === 0 ? undefined : counts
}

/** Normalize one CI state value; only the shared vocabulary is accepted. */
function checkStateOf(value: unknown, what: string): ClueCheckState {
  if (typeof value !== 'string' || !(CLUE_CHECK_STATES as readonly string[]).includes(value)) {
    throw new ClueError('invalid-request', `${what} must be one of ${CLUE_CHECK_STATES.join(', ')}`)
  }
  return value as ClueCheckState
}

/**
 * Normalize the individual checks of one detail read.
 *
 * Bounded twice — by {@link CLUE_MAX_CHECK_RUNS} entries and by a per-name
 * limit — because this list is an untrusted provider payload that the client
 * renders inline. Provider order is preserved; ranking failures first is a
 * display decision the client owns.
 */
function checkRunsOf(value: unknown): ClueResourceCheck[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new ClueError('invalid-request', 'clue resource info checkRuns must be an array')
  }
  if (value.length > CLUE_MAX_CHECK_RUNS) {
    throw new ClueError('invalid-request', `clue resource info has more than ${CLUE_MAX_CHECK_RUNS} checkRuns`)
  }
  return value.map((entry, index) => {
    const what = `clue resource info checkRuns[${index}]`
    if (!isRecord(entry)) throw new ClueError('invalid-request', `${what} must be a JSON object`)
    const name = displayText(entry.name, `${what}.name`, MAX_CLUE_CHECK_NAME)
    const state = checkStateOf(entry.state, `${what}.state`)
    const url = entry.url === undefined ? undefined : displayUrl(entry.url, `${what}.url`)
    return { name, state, ...(url === undefined ? {} : { url }) }
  })
}

/** Normalize one `state` value. */
function stateOf(value: unknown): ClueResourceState | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !(CLUE_RESOURCE_STATES as readonly string[]).includes(value)) {
    throw new ClueError(
      'invalid-request',
      `clue resource info state must be one of ${CLUE_RESOURCE_STATES.join(', ')}`,
    )
  }
  return value as ClueResourceState
}

/**
 * Validate and copy one display metadata snapshot.
 *
 * Only the public contract fields are retained (no source extensions/tokens);
 * every present field is validated. Absent fields stay absent.
 *
 * @param value - the untrusted value (source result or `clues.ensure` payload).
 * @param what - message prefix (defaults to "clue resource info").
 */
export function normalizeClueResourceInfo(
  value: unknown,
  what = 'clue resource info',
): ClueResourceInfo {
  if (!isRecord(value)) {
    throw new ClueError('invalid-request', `${what} must be a JSON object`)
  }
  const info: {
    state?: ClueResourceState
    number?: number
    repository?: string
    author?: CluePerson
    assignees?: readonly CluePerson[]
    followers?: readonly CluePerson[]
    labels?: readonly string[]
    createdAt?: string
    updatedAt?: string
    completedAt?: string
    start?: ClueResourceTime
    due?: ClueResourceTime
    branches?: ClueResourceBranches
    counts?: ClueResourceCounts
    sizeBytes?: number
    path?: string
    review?: 'approved' | 'changes-requested' | 'review-required'
    mergeable?: 'mergeable' | 'conflicting' | 'unknown'
    checks?: ClueCheckState
    checkRuns?: readonly ClueResourceCheck[]
  } = {}

  const state = stateOf(value.state)
  if (state !== undefined) info.state = state

  if (value.number !== undefined) {
    if (typeof value.number !== 'number' || !Number.isSafeInteger(value.number) || value.number <= 0) {
      throw new ClueError('invalid-request', `${what}.number must be a positive integer`)
    }
    info.number = value.number
  }

  if (value.repository !== undefined) {
    info.repository = displayText(value.repository, `${what}.repository`, MAX_CLUE_PERSON_TEXT)
  }
  const author = personOf(value.author, `${what}.author`)
  if (author !== undefined) info.author = author
  const assignees = peopleOf(value.assignees, `${what}.assignees`)
  if (assignees !== undefined) info.assignees = assignees
  const followers = peopleOf(value.followers, `${what}.followers`)
  if (followers !== undefined) info.followers = followers
  const labels = labelsOf(value.labels)
  if (labels !== undefined) info.labels = labels

  for (const key of ['createdAt', 'updatedAt', 'completedAt'] as const) {
    if (value[key] === undefined) continue
    const instant = isoInstantOf(value[key])
    if (instant === undefined) {
      throw new ClueError('invalid-request', `${what}.${key} must be an ISO instant`)
    }
    info[key] = instant
  }

  const start = timeOf(value.start, `${what}.start`)
  if (start !== undefined) info.start = start
  const due = timeOf(value.due, `${what}.due`)
  if (due !== undefined) info.due = due
  const branches = branchesOf(value.branches)
  if (branches !== undefined) info.branches = branches
  const counts = countsOf(value.counts)
  if (counts !== undefined) info.counts = counts

  if (value.sizeBytes !== undefined) {
    if (
      typeof value.sizeBytes !== 'number'
      || !Number.isSafeInteger(value.sizeBytes)
      || value.sizeBytes < 0
    ) {
      throw new ClueError('invalid-request', `${what}.sizeBytes must be a non-negative integer`)
    }
    info.sizeBytes = value.sizeBytes
  }

  if (value.path !== undefined) {
    info.path = displayPath(value.path)
  }

  // Change-request facts. The GitHub adapter supplies them on a detail read;
  // this whitelist is what actually carries them to the client, so dropping a
  // field here silently removes the PR status card.
  if (value.review !== undefined) {
    if (value.review !== 'approved' && value.review !== 'changes-requested' && value.review !== 'review-required') {
      throw new ClueError('invalid-request', what + '.review must be approved, changes-requested or review-required')
    }
    info.review = value.review
  }
  if (value.mergeable !== undefined) {
    if (value.mergeable !== 'mergeable' && value.mergeable !== 'conflicting' && value.mergeable !== 'unknown') {
      throw new ClueError('invalid-request', what + '.mergeable must be mergeable, conflicting or unknown')
    }
    info.mergeable = value.mergeable
  }
  if (value.checks !== undefined) info.checks = checkStateOf(value.checks, what + '.checks')
  const checkRuns = checkRunsOf(value.checkRuns)
  if (checkRuns !== undefined) info.checkRuns = checkRuns

  return info
}

/** Validate one optional snapshot; only `undefined` means absent. */
export function optionalClueResourceInfo(
  value: unknown,
  what = 'clue resource info',
): ClueResourceInfo | undefined {
  return value === undefined ? undefined : normalizeClueResourceInfo(value, what)
}

/**
 * Normalize one display subtitle. An absent subtitle stays absent; a present
 * one is bounded display text.
 */
export function normalizeClueSubtitle(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return displayText(value, 'clue subtitle', MAX_CLUE_SUBTITLE_LENGTH)
}

/** Stable JSON text (sorted keys) for snapshot equality. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

/** Whether two normalized snapshots are structurally identical. */
export function sameClueResourceInfo(
  left: ClueResourceInfo | undefined,
  right: ClueResourceInfo | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return stableJson(left) === stableJson(right)
}
