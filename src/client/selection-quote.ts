/**
 * The quote chip: "add to conversation" on a viewer selection mints a
 * reference chip into the composer draft instead of pasting the fenced text
 * block. The chip reads as `引用 a.md L12-15`, clicking it re-opens the file in
 * the sidebar editor and lands on the quoted lines (with a temporary flash),
 * and sending serializes it back to the same fenced block the pre-chip insert
 * produced — the model sees identical text, byte for byte.
 *
 * Since #1052 the selection popup already inserts a chip through the host's
 * built-in `'reference'` source, whose `ref` IS the payload (the whole fenced
 * block). That chip is inert: the host marks it openable only with an
 * `appearance`, and a click would hand the raw fence to the file opener. What
 * this module adds is the much smaller, source-owned alternative:
 *
 * - The chip's `ref` is a short opaque id ({@link QuoteRecord.id}); the
 *   selection lives in this module's store.
 * - One input-trigger source (`ctx.inputTriggers`, DSH 0.2.1+) owns that
 *   source name: `openReference` answers the click (open the file at the
 *   quoted lines), `codec.serialize` answers send-time expansion. A source
 *   with a `codec` is mandatory for insert outcomes — the host REFUSES a send
 *   whose chip has no serializer rather than silently downgrading it to the
 *   clipboard text.
 * - Records persist in `localStorage` (FIFO, {@link QUOTE_STORE_CAP}): an
 *   unsent draft's chips must stay clickable and serializable across reloads,
 *   and this module ships in BOTH the core bundle and the lazy editor chunk —
 *   two independent module instances whose in-memory maps only see their own
 *   writes, so the shared store is also how they see each other.
 *
 * Degradation: without the input-trigger service (older hosts), before the
 * source registers, or when the record cannot be persisted, {@link
 * insertQuoteRecord} reports undefined and the caller keeps the #1052 behavior — the
 * plain built-in reference chip, or the fenced text on hosts with no chip
 * channel at all. A failed quote insert never leaves a dead chip behind: the
 * record is written BEFORE the chip is inserted, and a store write that does
 * not land (quota, private mode) rolls it back and falls back — the other
 * bundle instance resolves refs through `localStorage`, so an unpersisted
 * record would click into nothing and block the send in the codec. Only a
 * record that PERSISTED and whose source later disappears fails the send
 * loudly (the codec throws), never silently.
 */
import type { Context } from '../context-types.ts'
import { insertDraftReference, type PendingReference } from './conversation-draft.ts'
import { t } from './locales.ts'
import {
  buildPlanAnnotationInsert, buildSelectionInsert, cleanPlanTitle, headerOf, whereOf,
  type SelectionLines,
} from './selection-payload.ts'

/** The input-trigger source name the quote chips route by. */
export const QUOTE_SOURCE = 'betterSidebarQuote'

/** localStorage key for the quote record store (FIFO, see module doc). */
export const QUOTE_STORE_KEY = 'dsh-better-sidebar:quote-refs'

/** Max persisted quote records (the oldest drops first). */
export const QUOTE_STORE_CAP = 200

/** Registration retries (× {@link QUOTE_RETRY_MS}) while the host service boots. */
export const QUOTE_REGISTER_RETRIES = 20

/** Delay between registration attempts (ms). */
export const QUOTE_RETRY_MS = 500

/**
 * The selection a viewer hands over when the popup commits: exactly the facts
 * the fenced insert already encoded, kept structured so the chip can act on
 * them (jump to the lines, re-serialize).
 */
export interface QuoteSelection {
  /**
   * What the selection came from. A file selection (the original behavior)
   * carries a path and a line span; a plan selection carries a plan address,
   * the note, and the quoted plan text. Omitted means `'file'` for records
   * written before the plan page existed.
   */
  kind?: 'file' | 'plan'
  path?: string
  cwd?: string
  lines?: SelectionLines
  text: string
  /** The plan document's tab address (`dsh-resource://plan/…`). */
  planId?: string
  /** The plan's heading, used in the chip label. */
  planTitle?: string
  /** The reader's annotation for the quoted plan text. */
  note?: string
}

/**
 * One persisted chip: the facts a click-through and a send need.
 *
 * `text` is the payload the model receives, built once at insert time — NOT
 * the raw selection. The raw text is unbounded (a 200-record FIFO of whole
 * selections overflows the localStorage quota), and an unpersisted record is a
 * dead chip in the other bundle instance (see the module doc).
 */
export interface QuoteRecord {
  /** The chip's `ref` — also the store key. */
  id: string
  /** The session the chip belongs to (clicks from other sessions refuse). */
  sessionId: string
  /** The monotonic record number (FIFO order; the chip's `ref` adds a suffix). */
  n: number
  /** The selection's kind; absent means `'file'` (legacy records). */
  kind?: 'file' | 'plan'
  /** The quoted file (file selections only). */
  path?: string
  /** The session cwd the header path was relativized with (file selections). */
  cwd?: string
  /** The quoted source span, when the selection mapped to lines (file selections). */
  lines?: SelectionLines
  /** The chip's visible text (`引用 a.md L12-15` or `计划批注 · …`). */
  label: string
  /** What copying the chip yields (the file header). Plan records omit it —
   *  their payload is `text` already, and storing both doubled the record. */
  clipboardText?: string
  /** The plan document's address (plan selections only). */
  planId?: string
  /** The payload `codec.serialize` returns. */
  text: string
}

/**
 * The structural face of the host input-trigger service this module needs
 * (`ctx.inputTriggers`, see `context-types.ts`). Declared here so the mirror
 * stays next to its single consumer.
 */
export interface SidebarInputTriggerService {
  registerSource(src: SidebarQuoteSource): () => void
}

/** The source face (structural mirror of the host's `InputTriggerSource`). */
export interface SidebarQuoteSource {
  trigger: '@'
  name: string
  showGroupTitle?: boolean
  candidates(session: { sessionId: string }, req: object): Promise<readonly unknown[]>
  onPick(pick: object): unknown
  openReference?(session: { sessionId: string }, reference: { ref: string; appearance?: string }): boolean
  codec?: {
    clipboardText(ref: string): string
    serialize(ref: string, signal: AbortSignal): Promise<string>
  }
}

// ── The record store ────────────────────────────────────────────────────────

const records = new Map<string, QuoteRecord>()
/** Monotonic chip numbering; restored from the store so numbers keep growing
 *  across reloads instead of colliding with chips still in old drafts. */
let nextN = 1
/** The exact stored value this instance's memory was last synced with. When
 *  `getItem` still returns it, the memory already reflects the store — either
 *  our own `saveStore` wrote it or a read merged it — so the rest of an insert
 *  batch can reuse those records without another full parse. */
let storeSyncedRaw: string | null | undefined

/**
 * Read the persisted store into memory. Safe to call repeatedly: the merge is
 * idempotent and `nextN` never moves backwards. The `getItem` compare is cheap
 * and still catches other pages' writes; only a changed value pays for
 * `JSON.parse` plus the per-entry validation loop.
 */
function readStoreIntoMemory(): void {
  try {
    if (typeof localStorage === 'undefined') return
    const raw = localStorage.getItem(QUOTE_STORE_KEY)
    if (raw === storeSyncedRaw) return
    storeSyncedRaw = raw
    if (raw === null) return
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return
    for (const entry of parsed) {
      if (!isQuoteRecord(entry)) continue
      if (!records.has(entry.id)) records.set(entry.id, entry)
      if (entry.n >= nextN) nextN = entry.n + 1
    }
  } catch {
    // A corrupt store reads as empty — the numbering restart is harmless
    // (labels repeat, ids stay unique through the random suffix).
  }
}

function isSelectionLines(value: unknown): value is SelectionLines {
  if (typeof value !== 'object' || value === null) return false
  const lines = value as Partial<SelectionLines>
  return typeof lines.start === 'number' && Number.isInteger(lines.start) && lines.start > 0
    && typeof lines.end === 'number' && Number.isInteger(lines.end) && lines.end >= lines.start
}

function isQuoteRecord(value: unknown): value is QuoteRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<QuoteRecord>
  if (record.kind !== undefined && record.kind !== 'file' && record.kind !== 'plan') return false
  const plan = record.kind === 'plan'
  return typeof record.id === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.n === 'number'
    && Number.isInteger(record.n) && record.n > 0
    // A legacy record (no `kind`) is a file quote and always had a path; a
    // plan record legitimately has none.
    && (plan ? typeof record.planId === 'string' && record.planId !== '' : typeof record.path === 'string' && record.path !== '')
    && typeof record.text === 'string'
    && typeof record.label === 'string'
    && (record.clipboardText === undefined || typeof record.clipboardText === 'string')
    && (record.cwd === undefined || typeof record.cwd === 'string')
    && (record.lines === undefined || isSelectionLines(record.lines))
}

/**
 * Persist the store, dropping the oldest records beyond {@link QUOTE_STORE_CAP}.
 * @returns whether the store really reached `localStorage`. `false` means the
 *   record must NOT become a chip: the other module instance (the core bundle
 *   registers the source, the editor chunk inserts) resolves refs through this
 *   store, so an unpersisted record would be a silent dead chip and the codec
 *   would block the send.
 */
function saveStore(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    const all = [...records.values()].sort((a, b) => a.n - b.n)
    const over = Math.max(0, all.length - QUOTE_STORE_CAP)
    const kept = all.slice(over)
    // An empty store is no key at all: the first quote (or a rolled-back
    // record) must not leave an `[]` behind for the next read to interpret.
    if (kept.length === 0) {
      localStorage.removeItem(QUOTE_STORE_KEY)
      storeSyncedRaw = null
    } else {
      const serialized = JSON.stringify(kept)
      localStorage.setItem(QUOTE_STORE_KEY, serialized)
      // Memory now equals what is stored. Record the exact value so the next
      // insert in the batch reuses memory instead of parsing our own write.
      storeSyncedRaw = serialized
    }
    // Evict from MEMORY only after the write landed: a failed write must not
    // cost this page records it could still resolve.
    if (over > 0) for (const dropped of all.slice(0, over)) records.delete(dropped.id)
    return true
  } catch {
    // Private mode / quota: report it so the caller falls back instead of
    // minting a chip no other module instance can resolve.
    return false
  }
}

/** The chip's `ref` — unique across reloads via the number plus a random suffix. */
function quoteId(n: number): string {
  return `q${n}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Resolve one quote record by chip `ref`. The persisted store is re-read on
 * every resolve: the record may have been written by the other bundle
 * instance, whose in-memory map this instance never sees directly.
 * @param ref - the chip's reference id.
 * @returns the record, or `undefined` when it is not (or no longer) stored.
 */
export function resolveQuote(ref: string): QuoteRecord | undefined {
  readStoreIntoMemory()
  return records.get(ref)
}

// ── The source ──────────────────────────────────────────────────────────────

/** Build the source object the host registers (one per module instance). */
function createQuoteSource(ctx: Context): SidebarQuoteSource {
  return {
    trigger: '@',
    name: QUOTE_SOURCE,
    // No @-menu participation: the candidates stay empty so the composer's
    // picker never lists this group; the source only answers chips.
    showGroupTitle: false,
    candidates: () => Promise.resolve([]),
    onPick: () => 'handled',
    openReference: (session, reference) => {
      try {
        const record = resolveQuote(reference.ref)
        if (record === undefined || record.sessionId !== session.sessionId) return false
        // A plan annotation has no file to jump to. Returning false leaves the
        // click with the host's own chip behavior instead of asking the file
        // opener to open a plan address.
        if (record.kind === 'plan' || record.path === undefined) return false
        ctx.betterSidebar.openFile(
          { sessionId: session.sessionId, ...(record.cwd === undefined ? {} : { cwd: record.cwd }) },
          record.path,
          undefined,
          record.lines === undefined ? undefined : { line: record.lines.start, lineEnd: record.lines.end },
        )
        return true
      } catch (error) {
        // A dead ctx (dev hot reload) degrades to the host's own gesture.
        console.warn('[dsh-better-sidebar] quote open failed:', error)
        return false
      }
    },
    codec: {
      clipboardText: (ref) => {
        const record = resolveQuote(ref)
        // A plan record stores only the payload (see QuoteRecord.clipboardText).
        return record?.clipboardText ?? record?.text ?? ref
      },
      serialize: async (ref) => {
        const record = resolveQuote(ref)
        if (record === undefined) {
          // Never a silent downgrade: the host blocks the submission instead,
          // so a dropped record surfaces as an error rather than a wrong text.
          throw new Error(`[dsh-better-sidebar] quote reference "${ref}" is no longer available`)
        }
        // The payload was built and size-reduced at insert time (see
        // `QuoteRecord.text`): no raw selection round-trips through storage.
        return record.text
      },
    },
  }
}

// ── Registration (startup) ──────────────────────────────────────────────────

/** Whether a quote source is live (ours or the other bundle instance's). */
let sourceReady = false
/** The disposer of the source THIS instance registered. `undefined` while the
 *  live source is BORROWED (the other module instance owns it — duplicate
 *  registration is a real error in the host, see `tryRegisterOnce`). */
let registeredDisposer: (() => void) | undefined
/** Whether the live source is the other instance's (readiness is a borrow,
 *  and every commit re-probes for the moment that owner releases it). */
let borrowed = false

/**
 * One synchronous registration attempt. Duplicate tolerance here is about the
 * BORROWED case, not about calling `registerSource` twice: this module ships
 * in both the core bundle and the editor chunk (two independent module
 * instances), so the host's "already registered" error usually means the other
 * instance owns the live source — inserts and click routing work identically
 * either way. But the borrowing instance holds no disposer, so it cannot learn
 * when that owner unregisters (a fiber disposal does not reach it): readiness
 * is therefore re-probed on every commit that does not own the source, and a
 * released slot is taken over instead of leaving a dead chip behind. Every
 * outcome logs; nothing stays silent.
 */
function tryRegisterOnce(ctx: Context): boolean {
  if (sourceReady && registeredDisposer !== undefined) return true
  try {
    const triggers = ctx.get('inputTriggers') as SidebarInputTriggerService | undefined
    if (triggers === undefined) return false
    registeredDisposer = triggers.registerSource(createQuoteSource(ctx))
    sourceReady = true
    borrowed = false
    // Positive proof the chip build is live (a silent feature-off reads
    // exactly like a stale bundle served by the host).
    console.debug('[dsh-better-sidebar] quote chips ready')
    return true
  } catch (error) {
    // The host message (ui-input-trigger service) is `slash source
    // "@betterSidebarQuote" is already registered`; match both that wording
    // and a generic "duplicate" so an upstream rewording cannot silently
    // turn "already live" into a permanent fallback.
    if (error instanceof Error && /already registered|duplicate/i.test(error.message)) {
      sourceReady = true
      // Log the TRANSITION only: a borrowed instance re-probes on every
      // commit, and a log line per selection would drown the console.
      if (!borrowed) {
        borrowed = true
        console.debug('[dsh-better-sidebar] quote chips ready (source already registered by the other bundle instance)')
      }
      return true
    }
    console.warn('[dsh-better-sidebar] quote source registration failed:', error)
    return false
  }
}

/**
 * Register the quote-chip input-trigger source once the host service shows up,
 * retrying briefly because the plugin's apply can run before the host package
 * provides the service. Returns the disposer (idempotent). A commit that finds
 * the source unregistered re-attempts on the spot (see
 * {@link insertQuoteRecord}) — the self-heal covers fiber disposals (session
 * switch, socket reconnect, HMR) that never get a re-apply.
 * @param ctx - the client context.
 * @returns the disposer.
 */
export function registerQuoteSource(ctx: Context): () => void {
  let retries = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const attempt = (): void => {
    if (disposed) return
    if (tryRegisterOnce(ctx)) return
    if (++retries > QUOTE_REGISTER_RETRIES) {
      console.info('[dsh-better-sidebar] quote chips unavailable: no input-trigger service')
      return
    }
    timer = setTimeout(attempt, QUOTE_RETRY_MS)
  }
  attempt()
  return () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    if (registeredDisposer !== undefined) {
      sourceReady = false
      registeredDisposer()
      registeredDisposer = undefined
      console.info('[dsh-better-sidebar] quote source unregistered (fiber disposed; the next commit re-registers)')
    }
  }
}

// ── Insert (popup commit) ───────────────────────────────────────────────────

/** Longest plan title in a chip label (code points). */
const CHIP_TITLE_MAX = 23

/** The chip label's title part; the generic label when the plan has none. */
function chipTitleOf(title: string | undefined): string {
  return cleanPlanTitle(title, CHIP_TITLE_MAX) ?? t('plan')
}

/** The plan annotation envelope (model text and label; `text` is also what a copy yields). */
function planInsertOf(sel: QuoteSelection): { text: string; label: string } {
  const text = buildPlanAnnotationInsert(sel.note ?? '', sel.text, {
    heading: t('planAnnotation'),
    noteLabel: t('planAnnotationNote'),
    quoteLabel: t('planAnnotationQuote'),
    ...(sel.planTitle === undefined ? {} : { planTitle: sel.planTitle }),
  })
  return {
    text,
    label: t('planAnnotationChip', { where: chipTitleOf(sel.planTitle) }),
  }
}

/**
 * Register the selection as a quote record and insert its chip into the
 * session's composer draft. Returns the persisted record — the plan page uses
 * it to know whether an annotation's chip landed — or `undefined` when chips
 * are unavailable, the record cannot be persisted (quota / private mode), or
 * the host refuses the insert; the caller keeps its own fallback.
 *
 * The plan branch differs from the file branch in three places: no
 * `appearance:'file'` (there is no file opener target), no path header
 * (`planInsertOf` builds the payload), and it carries the plan identity.
 * @param ctx - the client context.
 * @param sessionId - the session whose composer receives the chip.
 * @param sel - the selection the viewer's popup committed.
 * @returns the persisted record, or undefined when no chip landed.
 */
export function insertQuoteRecord(ctx: Context, sessionId: string, sel: QuoteSelection): QuoteRecord | undefined {
  if (!sourceReady || registeredDisposer === undefined) {
    // Self-heal, and the reason registration state lives in module scope
    // rather than the apply closure: THIS instance (the one the editor's
    // commit actually calls) may never have gone through apply, and a fiber
    // disposal unregisters without a re-apply. Registering here fixes both —
    // whichever instance wins, the source closures are equivalent.
    //
    // `registeredDisposer === undefined` also covers the BORROWED source: we
    // hold no disposer, so re-probe — the owner may have released the slot,
    // and a readiness flag with no owner is exactly how chips turn dead.
    if (!sourceReady) console.info('[dsh-better-sidebar] quote source not ready at commit, re-registering')
    if (!tryRegisterOnce(ctx)) {
      console.info('[dsh-better-sidebar] quote chips unavailable: source not registered')
      return undefined
    }
  }
  // `saveStore` rewrites the whole key from this instance's memory, and other
  // pages of the origin write the same key: merge their records in first, or
  // the write erases them and their chips block the send in the codec. The
  // read is a cheap `getItem` compare when nothing changed (see above), so a
  // batch of inserts reuses the memory each `saveStore` just synced.
  readStoreIntoMemory()
  const plan = sel.kind === 'plan'
  if (!plan && sel.path === undefined) return undefined
  // A plan record without its document identity would be rejected by the
  // other bundle instance's `isQuoteRecord` and become a dead chip.
  if (plan && (sel.planId === undefined || sel.planId === '')) return undefined
  const n = nextN++
  const path = sel.path!
  const built: { text: string; label: string; clipboardText?: string } = plan
    ? planInsertOf(sel)
    : {
      text: buildSelectionInsert(path, sel.cwd, sel.lines, sel.text).text,
      label: t('quoteChip', { where: whereOf(path, sel.lines) }),
      clipboardText: headerOf(path, sel.cwd, sel.lines),
    }
  const shared = { id: quoteId(n), sessionId, n, ...built }
  const record: QuoteRecord = plan
    ? { ...shared, kind: 'plan', planId: sel.planId! }
    : {
      ...shared,
      path,
      ...(sel.cwd === undefined ? {} : { cwd: sel.cwd }),
      ...(sel.lines === undefined ? {} : { lines: sel.lines }),
    }
  const reference: PendingReference = {
    source: QUOTE_SOURCE,
    ref: record.id,
    label: record.label,
    // A plan chip is deliberately NOT `appearance:'file'`: the host marks
    // file chips openable, and this source refuses the click anyway. Leaving
    // it undefined also makes the two chip families visually distinct.
    ...(plan ? {} : { appearance: 'file' as const }),
    // The host projects this into the composer and the saved draft, so a plan
    // chip carries its short label there; the record keeps the full payload
    // for the codec (copy/send), and the comment below still explains `text`.
    clipboardText: built.clipboardText ?? built.label,
    // Not what the chip carries (`ref` is the id, and the codec expands it on
    // send), but the plain-text form an ordinary path would fall back to —
    // and the payload itself, so a chip that cannot land still yields the
    // same text as the pre-chip insert.
    text: built.text,
  }
  records.set(record.id, record)
  if (!saveStore()) {
    // No persisted record = no chip: the core bundle resolves refs through
    // localStorage, so a chip whose record never landed would click into
    // nothing and block the send in the codec. The caller falls back to
    // #1052's built-in chip (same payload, just not clickable).
    records.delete(record.id)
    console.warn('[dsh-better-sidebar] quote chip skipped: the reference store cannot be written (quota/private mode)')
    return undefined
  }
  const landed = insertDraftReference(ctx, sessionId, reference)
  if (!landed) {
    // The record is not referenced by any draft, so drop it rather than leak
    // an id: the caller's fallback insert carries the same payload.
    records.delete(record.id)
    saveStore()
    return undefined
  }
  return record
}
