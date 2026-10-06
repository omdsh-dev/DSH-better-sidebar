/**
 * The session's live FILE-OPERATION stream — the signal the editor's
 * auto-refresh rides (#855).
 *
 * The model's file tools leave their calls in the session event log, and the
 * plugin's own `changes.ops` route ships that log's `tool/call` +
 * `tool/result` rows as a `seq > afterSeq` delta (see `src/index.ts`). This
 * module folds those deltas into "which file did the model just write or
 * edit", which is the whole question an open preview has to answer.
 *
 * Design constraints it exists to honour:
 *
 * - **One poller per session, not one per tab.** The native right sidebar
 *   keeps every visited tab body mounted (`keepMounted`), so an N-editor
 *   session would otherwise run N identical `changes.ops` polls. Members
 *   (editor tabs) elect ONE leader per session; that leader owns the single
 *   `usePolling` loop and every member reads the same published state. Any
 *   member leaving re-elects, and the loop stops when the last one goes.
 * - 每个会话通过 `changes.ops` 保持一条工具事件流，由 `use-polling.ts` 调度。
 *   两次响应之间间隔 2.5 秒；空窗请求等待宿主事件，最长 25 秒。
 *   当前会话没有可见编辑器时停止请求。插件自行保存文件时使用 `/sidebar/file`，
 *   不产生会话工具事件，因此不会引发重复刷新。
 * - **Settled successes only.** A `write`/`edit` call fires once its result
 *   landed without an error, so a half-written file never reaches a preview
 *   and a failed call never triggers a pointless reload.
 * - **Nothing historical fires.** The first pull of a fresh stream is the
 *   BASELINE: every op the session already settled is recorded as seen and
 *   published to nobody. Only an op that settles while someone is watching
 *   can refresh anything.
 * - **Session-scoped.** Streams are keyed by session id; a touch published
 *   for one session is invisible to every other session's editors.
 *
 * The stream record outlives its members (only the poller stops): a tab that
 * becomes visible again re-joins, the leader resumes from the persisted `seq`
 * cursor, and the missed delta is folded then — so a file the model rewrote
 * while the tab was parked is still seen as touched.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { SidebarSessionEvent } from '../context-types.ts'
import { api, type SessionScope } from './api.ts'
import { extractFileOps, type FileOp } from './changes/ops.ts'
import { resolveSidebarPath } from './paths.ts'
import { usePolling } from './use-polling.ts'

/** The delta cadence: the changes tab's session-lens poll of the same route. */
export const FILE_OPS_INTERVAL_MS = 2_500

/**
 * Events kept for cross-tick `tool/call` → `tool/result` pairing: a call may
 * be delivered in one delta and settle in the next. Only the tail matters
 * (a call that old has long since settled), and the bound is what keeps a
 * long session's fold cheap.
 */
const EVENT_WINDOW = 400

/**
 * Events kept once the last member goes away. The cursor, the baseline and
 * the published touches all survive, so a returning tab resumes the delta it
 * missed — but a session's tool traffic (write payloads, read results) must
 * not be pinned for the page's lifetime just because a tab was visited.
 */
const IDLE_EVENT_WINDOW = 32

/** Touched paths remembered per session (oldest insertion evicted past this). */
const TOUCH_WINDOW = 256

/** The op kinds that changed a file's bytes. */
export type FileOpTouchKind = 'write' | 'edit'

/** The newest settled write/edit of one path. */
export interface FileOpTouch {
  readonly kind: FileOpTouchKind
  /** The published revision this touch belongs to (compare with a baseline). */
  readonly revision: number
  /** The originating tool call's event time (epoch ms). */
  readonly time: number
}

/** What a member reads: the published state of its session's stream. */
export interface FileOpStreamState {
  /** Monotonic per-session counter, bumped once per published delta. */
  readonly revision: number
  /** Comparison key ({@link fileOpKey}) → that path's newest settled touch. */
  readonly touched: ReadonlyMap<string, FileOpTouch>
}

/** The state every session starts from (a stable identity: the store contract). */
const EMPTY_STATE: FileOpStreamState = { revision: 0, touched: new Map() }

/**
 * The comparison key of one path, so a model-spelled path and an editor tab's
 * absolute path meet: relative paths are resolved against the session cwd
 * ({@link resolveSidebarPath}), `.`/`..` segments are folded lexically, both
 * separators unify to '/', and Windows-style paths (drive letters, UNC
 * shares) fold case — the same file may be spelled either way there.
 * @param cwd - the session working directory (undefined = nothing to join onto).
 * @param path - an absolute or session-relative path.
 * @returns the comparison key (never a path to hand back to the host).
 */
export function fileOpKey(cwd: string | undefined, path: string): string {
  const unified = resolveSidebarPath(cwd, path).replace(/\\/g, '/')
  const windows = /^[A-Za-z]:\//.test(unified) || unified.startsWith('//')
  const segments: string[] = []
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  const key = `${unified.startsWith('/') ? '/' : ''}${segments.join('/')}`
  return windows ? key.toLowerCase() : key
}

/** One polling member: an editor tab, and the way to tell it it leads now. */
interface Member {
  /** Become (true) or stop being (false) this session's poller. */
  lead(leading: boolean): void
}

/** One session's stream: the shared cursor, the published state, the members. */
interface Stream {
  state: FileOpStreamState
  listeners: Set<() => void>
  members: Set<Member>
  leader: Member | undefined
  /** The delivered cursor (`-1` includes an eventual first event at seq 0). */
  seq: number
  /** Whether the baseline pull completed (only then may a delta publish). */
  primed: boolean
  events: SidebarSessionEvent[]
  /** callIds already accounted for: a settle must fire exactly once. */
  published: Set<string>
  /** The leader's cwd, used to resolve the model's own relative spellings. */
  cwd: string | undefined
}

/** Every session's stream, alive for the page (only its poller stops). */
const streams = new Map<string, Stream>()

/** The stream record of one session, created on first use. */
function streamOf(sessionId: string): Stream {
  let stream = streams.get(sessionId)
  if (stream === undefined) {
    stream = {
      state: EMPTY_STATE,
      listeners: new Set(),
      members: new Set(),
      leader: undefined,
      seq: -1,
      primed: false,
      events: [],
      published: new Set(),
      cwd: undefined,
    }
    streams.set(sessionId, stream)
  }
  return stream
}

/** Publish one delta's settled write/edit ops to every member of the stream. */
function publish(stream: Stream, ops: readonly FileOp[]): void {
  const revision = stream.state.revision + 1
  const touched = new Map(stream.state.touched)
  // `extractFileOps` orders newest first; walking it backwards leaves the
  // NEWEST op of this delta as the one recorded for a path touched twice.
  for (const op of [...ops].reverse()) {
    stream.published.add(op.callId)
    touched.set(fileOpKey(stream.cwd, op.path), { kind: op.kind as FileOpTouchKind, revision, time: op.time })
  }
  // Bound the memory of a long session. Map iteration is insertion order, and
  // re-touching a path keeps its original slot, so the evicted entry is not
  // strictly the oldest revision — a miss here only costs a stale preview
  // until the next write of that path, never wrong content.
  for (const key of touched.keys()) {
    if (touched.size <= TOUCH_WINDOW) break
    touched.delete(key)
  }
  stream.state = { revision, touched }
  for (const listener of stream.listeners) listener()
}

/**
 * Fold one delta (plus the retained window) into the stream.
 * @param baseline - true for a fresh stream's FIRST fold: everything already
 * settled predates the editors that are joining, so it marks state without
 * publishing anything.
 */
function fold(stream: Stream, events: readonly SidebarSessionEvent[], baseline: boolean): void {
  const merged = [...stream.events, ...events]
  stream.events = merged.length > EVENT_WINDOW ? merged.slice(merged.length - EVENT_WINDOW) : merged
  const ops = extractFileOps(stream.events)
  if (baseline) {
    for (const op of ops) stream.published.add(op.callId)
  } else {
    const settled = ops.filter(op => (op.kind === 'write' || op.kind === 'edit')
      && !op.running && !op.isError && !stream.published.has(op.callId))
    if (settled.length > 0) publish(stream, settled)
  }
  // Ops that scrolled out of the window cannot settle any more: drop their
  // marks so the set can never grow past what the window can hold.
  const present = new Set(ops.map(op => op.callId))
  for (const callId of stream.published) {
    if (!present.has(callId)) stream.published.delete(callId)
  }
}

/** One leader's delta pull: advance the cursor, then fold (or baseline) it. */
async function pullStream(stream: Stream, scope: SessionScope, signal: AbortSignal): Promise<void> {
  const { events, lastSeq } = await api.changesOps(scope, stream.primed ? stream.seq : undefined, signal, stream.primed)
  // A torn-down run's answer must never publish state: the transport may
  // deliver an aborted response anyway.
  if (signal.aborted === true) return
  if (scope.cwd !== undefined && scope.cwd !== '') stream.cwd = scope.cwd
  if (lastSeq > stream.seq) stream.seq = lastSeq
  const baseline = !stream.primed
  stream.primed = true
  if (events.length > 0) fold(stream, events, baseline)
}

/**
 * Join one session's file-operation stream while `enabled`, and read its
 * published state. Every mounted editor of a session calls this; exactly one
 * of them (the elected leader) runs the poll.
 * @param scope - the session whose log is watched (sessionId + cwd).
 * @param enabled - whether this tab is on screen and holds a real file (a
 * parked tab must not keep polling, and a folder/path-less window has no file
 * to watch).
 * @returns the session's published touches, stable between deltas.
 */
export function useFileOpStream(scope: SessionScope, enabled: boolean): FileOpStreamState {
  const { sessionId } = scope
  const [leading, setLeading] = useState(false)

  useEffect(() => {
    if (!enabled || sessionId === '') {
      setLeading(false)
      return
    }
    const stream = streamOf(sessionId)
    const member: Member = { lead: (value: boolean) => { setLeading(value) } }
    stream.members.add(member)
    if (stream.leader === undefined) {
      stream.leader = member
      setLeading(true)
    }
    return () => {
      stream.members.delete(member)
      if (stream.members.size === 0 && stream.events.length > IDLE_EVENT_WINDOW) {
        // Nobody is watching: keep only what a settle landing right now would
        // still need to pair with. The cursor and the published touches stay,
        // so the missed delta is folded (and published) when a tab returns.
        stream.events = stream.events.slice(stream.events.length - IDLE_EVENT_WINDOW)
      }
      if (stream.leader !== member) return
      stream.leader = undefined
      setLeading(false)
      // Hand the loop to whoever is left: only a member's own hook can run it.
      const next = stream.members.values().next().value as Member | undefined
      if (next !== undefined) {
        stream.leader = next
        next.lead(true)
      }
    }
  }, [enabled, sessionId])

  // Granular scope fields: the scope object's identity churns every render,
  // only its sessionId / cwd gate the request target.
  const cwd = scope.cwd
  const pull = useCallback(async (signal: AbortSignal): Promise<void> => {
    await pullStream(streamOf(sessionId), { sessionId, cwd }, signal)
  }, [sessionId, cwd])

  // Self-scheduling: at most ONE delta request in flight per session, and the
  // first one runs immediately so the baseline is established before any
  // delta can be mistaken for a fresh write.
  usePolling(leading, pull, { intervalMs: FILE_OPS_INTERVAL_MS, mode: 'self-scheduling', immediate: true })

  return useSyncExternalStore(
    useCallback((listener: () => void) => {
      const stream = streamOf(sessionId)
      stream.listeners.add(listener)
      return () => { stream.listeners.delete(listener) }
    }, [sessionId]),
    useCallback(() => streams.get(sessionId)?.state ?? EMPTY_STATE, [sessionId]),
  )
}
