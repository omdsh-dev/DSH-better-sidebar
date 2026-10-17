/**
 * S5 composer integration: the two `@` trigger sources (client half).
 *
 * Registered names are the FROZEN codec names from S1 —
 * `better-sidebar:clues` and `better-sidebar:packs` — so a draft reference
 * keeps one codec even when a business source is disabled or unloaded. The
 * sources aggregate the clue extension face (`ctx.betterSidebar.clues`):
 *
 * - empty query: local pinned clues (clues source) and the local pack library
 *   (packs source); opening `@` never fetches remote resources;
 * - non-empty query: enabled/mention-enabled sources are searched with bounded
 *   concurrency and per-source failure isolation; the request signal cancels
 *   the in-flight searches, and stale results are dropped;
 * - candidates carry a STABLE id: search rows already in the library reuse
 *   `clueId`, the rest are ensured through `clues.ensure` before the row is
 *   shown (the host opens the menu only after `candidates` resolves, so a pick
 *   can never insert an id that does not exist yet);
 * - `codec.serialize` emits the fixed token only — no remote body read, no auth
 *   probe — while `clipboardText` is the same token;
 * - chips use only the host-supported appearances (`session` / `file` /
 *   `folder`) and preview through an INJECTABLE `openReference` callback.
 *
 * This module is node-free; host packages are restated structurally because
 * `@deepseek-ai/dsh-client-ui-input-trigger` is not a peer of this package.
 */
import { Fragment, createElement } from 'react'
import type { ComponentType, ReactNode } from 'react'
import {
  CLUE_CODEC_SOURCE,
  PACK_CODEC_SOURCE,
  type ClueDisplayIcon,
  type ClueListResult,
  type CluesSourcesCatalogResult,
  type ClueSourceDisplayDescriptor,
} from '../../clues/types.ts'
import type { CluesClientApi } from './api.ts'
import type { BetterSidebarCluesClientFace } from './registry.ts'
import type { Context } from '../../context-types.ts'
import { escapeClueTitle, serializeClueToken } from '../../clues/context/tokens.ts'

// ── Structural mirror of the host input-trigger contract ───────────────────
//
// Only the members this module calls are restated. `appearance` is the host's
// closed union; no candidate field is invented.

/** The host-supported reference chip appearances. */
export type ClueReferenceAppearance = 'session' | 'file' | 'folder'

/** One reference insert outcome of the composer pipeline. */
export interface ClueReferenceInsert {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance?: ClueReferenceAppearance
  readonly clipboardText: string
}

/** A pick settling outcome (subset of the host `PickOutcome`). */
export type CluePickOutcome =
  | { readonly insert: ClueReferenceInsert }
  | { readonly text: string; readonly continue?: boolean }
  | 'handled'
  | undefined

/** One candidate row handed to the composer menu. */
export interface ClueInputCandidate {
  readonly name: string
  readonly label?: string
  readonly description?: string
  readonly icon?: 'file' | 'folder' | 'session' | ComponentType<{ readonly size?: number }>
  readonly hint?: string
  readonly section?: string
  readonly value?: string
  readonly drill?: boolean
}

/** The session projection the host hands to every trigger callback. */
export interface ClueSessionContext {
  readonly sessionId: string
}

/** One candidate request from the composer. */
export interface ClueCandidateRequest {
  readonly query: string
  readonly quoted?: boolean
  readonly position: 'leading' | 'inline'
  readonly drilled: boolean
  readonly signal: AbortSignal
}

/** Everything `onPick` needs (the span is host-owned and untouched here). */
export interface ClueInputPick {
  readonly candidate: ClueInputCandidate
  readonly session: ClueSessionContext
  readonly position: 'leading' | 'inline'
  readonly via: 'menu' | 'space' | 'enter'
  readonly action: 'pick' | 'drill'
  readonly span?: unknown
}

/** The reference codec contract (clipboard + model serialization). */
export interface ClueReferenceCodec {
  clipboardText(ref: string): string
  serialize(ref: string, signal: AbortSignal): Promise<string>
}

/** One registered trigger source. */
export interface ClueInputTriggerSource {
  readonly trigger: '@'
  readonly name: string
  readonly order?: number
  readonly showGroupTitle?: boolean
  candidates(session: ClueSessionContext, request: ClueCandidateRequest): Promise<readonly ClueInputCandidate[]>
  onPick(pick: ClueInputPick): CluePickOutcome
  openReference?(session: ClueSessionContext, reference: { readonly ref: string; readonly appearance?: ClueReferenceAppearance }): boolean
  readonly codec?: ClueReferenceCodec
  warm?(session: ClueSessionContext): void
}

/** The `ctx.inputTriggers` service slice. */
interface InputTriggerServiceLike {
  registerSource(source: ClueInputTriggerSource): () => void
}

/** The injected-context slice `ctx.inject` hands back. */
interface InjectedTriggerContext {
  get?(name: string): unknown
  inputTriggers?: InputTriggerServiceLike
}

/** The context `installClueInputTriggers` needs (client plugin context). */
interface MentionsContext {
  betterSidebar?: { readonly clues?: BetterSidebarCluesClientFace }
  inject?(deps: readonly string[], callback: (injected: unknown) => (() => void) | void): () => void
  logger?: { warn?: (message: string) => void }
}

// ── Options and public API ─────────────────────────────────────────────────

/** The clue face slice the trigger sources consume. */
export interface ClueMentionsFace {
  readonly api: CluesClientApi
  getSourceDisplays(): readonly ClueSourceDisplayDescriptor[]
  isSourceEnabled(sourceId: string): boolean
  isSourceMentionEnabled(sourceId: string): boolean
  isPacksMentionEnabled(): boolean
}

/** Options of {@link createClueInputTriggers}. */
export interface CreateClueInputTriggersOptions {
  /** The clue extension face (`ctx.betterSidebar.clues`). */
  readonly face: ClueMentionsFace
  /**
   * Resolve the composer session's workspace id. The host client workspace
   * service does not expose workspace ids today, so S9 wires the authoritative
   * resolver (session → workspace) here; `undefined` means "not ready".
   */
  readonly resolveWorkspaceId: (session: ClueSessionContext) => string | undefined | Promise<string | undefined>
  /**
   * Open a reference preview without changing the draft. `false` leaves the
   * gesture to the host (the callback owns the actual preview surface).
   */
  readonly openReference?: (input: {
    readonly kind: 'clue' | 'pack'
    readonly id: string
    readonly sessionId: string
  }) => boolean
  /** Maximum rows returned per source (default 20, hard cap 50). */
  readonly limit?: number
  /** Maximum concurrent source searches (default 4). */
  readonly concurrency?: number
  /** Catalogue cache TTL (default 30 s; one entry, bounded). */
  readonly catalogueTtlMs?: number
  /** Observability hook for isolated source/candidate failures (never logs secrets). */
  readonly onError?: (error: unknown, sourceId?: string) => void
}

/** The created sources plus their disposer. */
export interface CreatedClueInputTriggers {
  readonly sources: readonly ClueInputTriggerSource[]
  dispose(): void
}

/** Defaults. */
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const DEFAULT_CONCURRENCY = 4
const DEFAULT_CATALOGUE_TTL_MS = 30_000
/** Candidate-level ensure concurrency (the store is local; keep it small). */
const ENSURE_CONCURRENCY = 4

/** Clamp the caller's row budget. */
function limitOf(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)))
}

/** Run async work over a list with a fixed concurrency ceiling. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const run = async (): Promise<void> => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index]!, index)
    }
  }
  const width = Math.max(1, Math.min(Math.floor(concurrency), items.length))
  await Promise.all(Array.from({ length: width }, () => run()))
  return results
}

/** Throw the host's cancellation shape when the request was superseded. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error('clue reference candidates were cancelled')
    error.name = 'AbortError'
    throw error
  }
}

/** Parse one candidate payload produced by this module. */
function parseCandidateValue(value: string | undefined): {
  kind: 'clue' | 'pack'
  id: string
  appearance?: 'file' | 'folder'
} | undefined {
  if (value === undefined) return undefined
  try {
    const raw = JSON.parse(value) as unknown
    if (raw === null || typeof raw !== 'object') return undefined
    const record = raw as { kind?: unknown; id?: unknown; appearance?: unknown }
    if (record.kind !== 'clue' && record.kind !== 'pack') return undefined
    if (typeof record.id !== 'string' || record.id === '') return undefined
    return {
      kind: record.kind,
      id: record.id,
      ...(record.appearance === 'file' || record.appearance === 'folder' ? { appearance: record.appearance } : {}),
    }
  } catch {
    return undefined
  }
}

/** One stable token, or the raw id when a corrupt id cannot be serialized. */
function tokenOf(kind: 'clue' | 'pack', id: string): string {
  try {
    return serializeClueToken(kind, id)
  } catch {
    return id
  }
}

/** The appearance a clue's content type maps to (host-supported values only). */
function appearanceOf(typeId: string): ClueReferenceAppearance {
  return typeId.endsWith('.directory') ? 'folder' : 'file'
}

/** Wrap a client display icon (node or size-aware factory) as a candidate icon component. */
function wrapDisplayIcon(icon: ClueDisplayIcon | undefined, fallback: 'file' | 'folder'): ClueInputCandidate['icon'] {
  if (icon === undefined) return fallback
  if (typeof icon === 'function') {
    const factory = icon
    const ClueSourceIcon = (): ReactNode => createElement(Fragment, null, factory(16))
    return ClueSourceIcon
  }
  const node = icon
  const ClueSourceIcon = (): ReactNode => createElement(Fragment, null, node)
  return ClueSourceIcon
}

/** One effective clue row shared by pins and search results. */
interface ClueRow {
  readonly id: string
  readonly title: string
  readonly sourceId: string
  readonly typeId: string
  readonly pinned: boolean
}

/** Build the composer candidate row for one stable clue. */
function clueCandidate(
  row: ClueRow,
  displayById: ReadonlyMap<string, ClueSourceDisplayDescriptor>,
): ClueInputCandidate {
  const display = displayById.get(row.sourceId)
  const sourceName = display?.name ?? row.sourceId
  return {
    name: row.id,
    label: escapeClueTitle(row.title),
    description: `${sourceName} · ${row.typeId}`,
    icon: wrapDisplayIcon(display?.icon, appearanceOf(row.typeId) === 'folder' ? 'folder' : 'file'),
    value: JSON.stringify({ kind: 'clue', id: row.id, appearance: appearanceOf(row.typeId) }),
  }
}

/** Build the composer candidate row for one stable pack. */
function packCandidate(pack: { readonly id: string; readonly name: string; readonly members: readonly string[] }): ClueInputCandidate {
  return {
    name: pack.id,
    label: escapeClueTitle(pack.name),
    icon: 'folder',
    value: JSON.stringify({ kind: 'pack', id: pack.id }),
  }
}

/**
 * Create the two `@` sources.
 * @param options - the clue face, workspace resolver and preview callback.
 * @returns the sources plus a disposer that clears the bounded catalogue cache.
 */
export function createClueInputTriggers(options: CreateClueInputTriggersOptions): CreatedClueInputTriggers {
  const { face } = options
  const limit = limitOf(options.limit)
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY))
  const catalogueTtlMs = Math.max(0, options.catalogueTtlMs ?? DEFAULT_CATALOGUE_TTL_MS)
  /** Single-entry bounded catalogue cache (ids are persisted elsewhere). */
  let catalogue: { readonly at: number; readonly value: CluesSourcesCatalogResult } | undefined
  let disposed = false

  const report = (error: unknown, sourceId?: string): void => {
    try {
      options.onError?.(error, sourceId)
    } catch {
      // An observer must never break the composer.
    }
  }

  const workspaceOf = async (session: ClueSessionContext, signal: AbortSignal): Promise<string | undefined> => {
    try {
      const value = await options.resolveWorkspaceId(session)
      if (signal.aborted) return undefined
      return typeof value === 'string' && value !== '' ? value : undefined
    } catch (error) {
      report(error)
      return undefined
    }
  }

  const catalogueOf = async (signal: AbortSignal): Promise<CluesSourcesCatalogResult | undefined> => {
    if (catalogue !== undefined && Date.now() - catalogue.at <= catalogueTtlMs) return catalogue.value
    try {
      const value = await face.api.sources(signal)
      catalogue = { at: Date.now(), value }
      return value
    } catch (error) {
      if (!signal.aborted) report(error)
      return undefined
    }
  }

  const displayMap = (): ReadonlyMap<string, ClueSourceDisplayDescriptor> => {
    const map = new Map<string, ClueSourceDisplayDescriptor>()
    for (const display of face.getSourceDisplays()) map.set(display.sourceId, display)
    return map
  }

  /** Local pinned clues matching one query (empty query = every pin, ordered). */
  const pinnedRows = async (workspaceId: string, query: string, signal: AbortSignal): Promise<ClueRow[]> => {
    try {
      const [pins, library] = await Promise.all([
        face.api.pinsList(workspaceId),
        face.api.clues(workspaceId),
      ])
      if (signal.aborted) return []
      const byId = new Map(library.clues.map(clue => [clue.id, clue]))
      const rows: ClueRow[] = []
      for (const pin of pins.pins) {
        const clue = byId.get(pin.clueId)
        if (clue === undefined) continue
        if (query !== '' && !clue.title.toLowerCase().includes(query)) continue
        if (!face.isSourceEnabled(clue.sourceId)) continue
        // A per-source @ switch also hides that source's pinned rows; the
        // switch is presentation only, so explicit reads stay available.
        if (!face.isSourceMentionEnabled(clue.sourceId)) continue
        rows.push({
          id: clue.id,
          title: clue.title,
          sourceId: clue.sourceId,
          typeId: clue.typeId,
          pinned: true,
        })
      }
      return rows
    } catch (error) {
      if (!signal.aborted) report(error)
      return []
    }
  }

  /** Search one enabled source and ensure every row's stable id. */
  const searchSource = async (
    workspaceId: string,
    sourceId: string,
    query: string,
    signal: AbortSignal,
    perSourceLimit: number,
  ): Promise<ClueRow[]> => {
    let result: ClueListResult
    try {
      result = await face.api.search(workspaceId, { sourceId, query, limit: perSourceLimit }, signal)
    } catch (error) {
      if (!signal.aborted) report(error, sourceId)
      return []
    }
    if (signal.aborted) return []
    const candidates = result.items.slice(0, perSourceLimit)
    const rows = await mapWithLimit(candidates, ENSURE_CONCURRENCY, async (candidate): Promise<ClueRow | undefined> => {
      try {
        let clueId = candidate.clueId
        let title = candidate.title
        if (clueId === undefined) {
          const ensured = await face.api.ensure(workspaceId, {
            sourceId: candidate.sourceId,
            typeId: candidate.typeId,
            locator: candidate.locator,
            title: candidate.title,
          }, signal)
          clueId = ensured.clue.id
          title = ensured.clue.title
        }
        if (signal.aborted) return undefined
        return {
          id: clueId,
          title,
          sourceId: candidate.sourceId,
          typeId: candidate.typeId,
          pinned: false,
        } satisfies ClueRow
      } catch (error) {
        if (!signal.aborted) report(error, sourceId)
        return undefined
      }
    })
    return rows.filter((row): row is ClueRow => row !== undefined)
  }

  const cluesSource: ClueInputTriggerSource = {
    trigger: '@',
    name: CLUE_CODEC_SOURCE,
    order: 0,
    showGroupTitle: false,
    async candidates(session, request): Promise<readonly ClueInputCandidate[]> {
      if (disposed) return []
      throwIfAborted(request.signal)
      const workspaceId = await workspaceOf(session, request.signal)
      if (workspaceId === undefined) return []
      const query = request.query.trim().toLowerCase()
      const displays = displayMap()
      if (query === '') {
        const rows = await pinnedRows(workspaceId, '', request.signal)
        return rows.slice(0, limit).map(row => clueCandidate(row, displays))
      }
      const [pins, catalog] = await Promise.all([
        pinnedRows(workspaceId, query, request.signal),
        catalogueOf(request.signal),
      ])
      if (request.signal.aborted) return []
      const sources = (catalog?.sources ?? []).filter(source =>
        source.capabilities.search
        && face.isSourceEnabled(source.sourceId)
        && face.isSourceMentionEnabled(source.sourceId))
      // Distribute the row budget across sources; the merged list is capped
      // again below, so a broad query cannot ensure an unbounded number of ids.
      const perSourceLimit = Math.max(1, Math.ceil(limit / Math.max(1, sources.length)))
      const perSource = await mapWithLimit(sources, concurrency, async source =>
        searchSource(workspaceId, source.sourceId, request.query.trim(), request.signal, perSourceLimit))
      if (request.signal.aborted) return []
      const seen = new Set<string>()
      const merged: ClueRow[] = []
      for (const row of [...pins, ...perSource.flat()]) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        merged.push(row)
        if (merged.length >= limit) break
      }
      return merged.map(row => clueCandidate(row, displays))
    },
    onPick({ candidate }): CluePickOutcome {
      const value = parseCandidateValue(candidate.value)
      if (value === undefined || value.kind !== 'clue') return undefined
      const token = tokenOf('clue', value.id)
      return {
        insert: {
          source: CLUE_CODEC_SOURCE,
          ref: value.id,
          label: candidate.label ?? value.id,
          appearance: value.appearance ?? 'file',
          clipboardText: token,
        },
      }
    },
    openReference(session, reference): boolean {
      if (options.openReference === undefined) return false
      try {
        return options.openReference({ kind: 'clue', id: reference.ref, sessionId: session.sessionId }) === true
      } catch (error) {
        report(error)
        return false
      }
    },
    codec: {
      clipboardText: (ref: string): string => tokenOf('clue', ref),
      async serialize(ref: string, signal: AbortSignal): Promise<string> {
        throwIfAborted(signal)
        // Default serialization is the token alone: no remote body read and
        // no authentication probe, so sending never blocks on a source.
        return tokenOf('clue', ref)
      },
    },
  }

  const packsSource: ClueInputTriggerSource = {
    trigger: '@',
    name: PACK_CODEC_SOURCE,
    order: 1,
    showGroupTitle: false,
    async candidates(session, request): Promise<readonly ClueInputCandidate[]> {
      if (disposed) return []
      throwIfAborted(request.signal)
      if (!face.isPacksMentionEnabled()) return []
      const workspaceId = await workspaceOf(session, request.signal)
      if (workspaceId === undefined) return []
      const query = request.query.trim().toLowerCase()
      try {
        const result = await face.api.packsList(workspaceId)
        if (request.signal.aborted) return []
        return result.packs
          .filter(pack => query === '' || pack.name.toLowerCase().includes(query))
          .sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
          .slice(0, limit)
          .map(packCandidate)
      } catch (error) {
        if (!request.signal.aborted) report(error)
        return []
      }
    },
    onPick({ candidate }): CluePickOutcome {
      const value = parseCandidateValue(candidate.value)
      if (value === undefined || value.kind !== 'pack') return undefined
      const token = tokenOf('pack', value.id)
      return {
        insert: {
          source: PACK_CODEC_SOURCE,
          ref: value.id,
          label: candidate.label ?? value.id,
          appearance: 'folder',
          clipboardText: token,
        },
      }
    },
    openReference(session, reference): boolean {
      if (options.openReference === undefined) return false
      try {
        return options.openReference({ kind: 'pack', id: reference.ref, sessionId: session.sessionId }) === true
      } catch (error) {
        report(error)
        return false
      }
    },
    codec: {
      clipboardText: (ref: string): string => tokenOf('pack', ref),
      async serialize(ref: string, signal: AbortSignal): Promise<string> {
        throwIfAborted(signal)
        return tokenOf('pack', ref)
      },
    },
  }

  return {
    sources: [cluesSource, packsSource],
    dispose(): void {
      disposed = true
      catalogue = undefined
    },
  }
}

/**
 * Register both `@` sources against `ctx.inputTriggers`.
 *
 * The registration follows the Cordis lifecycle: the injected child scope owns
 * the source disposers, so an HMR reload never leaves a duplicate group.
 *
 * @param ctx - client plugin context.
 * @param options - same options as {@link createClueInputTriggers} except the
 *  face (read from `ctx.betterSidebar.clues` unless supplied).
 * @returns a disposer releasing the injection and both sources.
 */
export function installClueInputTriggers(
  ctx: Context,
  options: Omit<CreateClueInputTriggersOptions, 'face'> & { readonly face?: ClueMentionsFace },
): () => void {
  const context = ctx as unknown as MentionsContext
  const face = options.face ?? context.betterSidebar?.clues
  if (face === undefined) {
    context.logger?.warn?.('dsh-better-sidebar: no clue client face; the @ clue sources stay unregistered')
    return () => {}
  }
  if (typeof context.inject !== 'function') {
    context.logger?.warn?.('dsh-better-sidebar: ctx.inject is unavailable; the @ clue sources stay unregistered')
    return () => {}
  }
  const created = createClueInputTriggers({ ...options, face })
  const offInject = context.inject(['inputTriggers'], (injected) => {
    const triggerContext = injected as InjectedTriggerContext
    const service = (triggerContext.inputTriggers
      ?? triggerContext.get?.('inputTriggers')) as InputTriggerServiceLike | undefined
    if (service === undefined || typeof service.registerSource !== 'function') {
      context.logger?.warn?.('dsh-better-sidebar: the input-trigger service is unavailable; @ clue sources stay unregistered')
      return
    }
    const disposers = created.sources.map(source => service.registerSource(source))
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    offInject?.()
    created.dispose()
  }
}
