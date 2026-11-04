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
 * insertQuoteChip} reports false and the caller keeps the #1052 behavior — the
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
import { buildSelectionInsert, headerOf, whereOf, type SelectionLines } from './selection-payload.ts'

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
  path: string
  cwd?: string
  lines?: SelectionLines
  text: string
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
  /** The monotonic chip number (kept across reloads so labels do not collide). */
  n: number
  /** The quoted file. */
  path: string
  /** The session cwd the header path was relativized with. */
  cwd?: string
  /** The quoted source span, when the selection mapped to lines. */
  lines?: SelectionLines
  /** The chip's visible text (`引用 a.md L12-15`). */
  label: string
  /** What copying the chip yields (the `path:lines` header line). */
  clipboardText: string
  /** The fenced block (header only past the limit) `codec.serialize` returns. */
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
let storeLoaded = false

/**
 * Read the persisted store into memory. Safe to call repeatedly: the merge is
 * idempotent and `nextN` never moves backwards.
 */
function readStoreIntoMemory(): void {
  try {
    if (typeof localStorage === 'undefined') return
    const raw = localStorage.getItem(QUOTE_STORE_KEY)
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

/** First-load wrapper (startup and insert paths). */
function loadStore(): void {
  if (storeLoaded) return
  storeLoaded = true
  readStoreIntoMemory()
}

function isQuoteRecord(value: unknown): value is QuoteRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<QuoteRecord>
  return typeof record.id === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.n === 'number'
    && typeof record.path === 'string'
    && typeof record.text === 'string'
    && typeof record.label === 'string'
    && typeof record.clipboardText === 'string'
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
    if (kept.length === 0) localStorage.removeItem(QUOTE_STORE_KEY)
    else localStorage.setItem(QUOTE_STORE_KEY, JSON.stringify(kept))
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
  loadStore()
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
      clipboardText: ref => resolveQuote(ref)?.clipboardText ?? ref,
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
    console.info('[dsh-better-sidebar] quote chips ready')
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
        console.info('[dsh-better-sidebar] quote chips ready (source already registered by the other bundle instance)')
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
 * {@link insertQuoteChip}) — the self-heal covers fiber disposals (session
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

/** Whether this module instance currently owns a registered quote source. */
export function quoteSourceReady(): boolean {
  return sourceReady
}

// ── Insert (popup commit) ───────────────────────────────────────────────────

/**
 * The legacy direct insert for one selection — the text #1052's chip carries,
 * and what lands in the draft when chips are unavailable.
 * @param sel - the selection.
 * @returns the fenced block (or the bare header line when over the limit).
 */
export function quoteFallbackInsert(sel: QuoteSelection): string {
  return buildSelectionInsert(sel.path, sel.cwd, sel.lines, sel.text).text
}

/**
 * Register the selection as a quote record and insert its chip into the
 * session's composer draft. Returns false — leaving the draft untouched —
 * when chips are unavailable, the record cannot be persisted (quota / private
 * mode), or the host refuses the insert; the caller then falls back to
 * {@link quoteFallbackInsert}.
 * @param ctx - the client context.
 * @param sessionId - the session whose composer receives the chip.
 * @param sel - the selection the viewer's popup committed.
 * @returns whether the chip landed in the draft.
 */
export function insertQuoteChip(ctx: Context, sessionId: string, sel: QuoteSelection): boolean {
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
      return false
    }
  }
  loadStore()
  const n = nextN++
  const clipboardText = headerOf(sel.path, sel.cwd, sel.lines)
  // Built ONCE and kept in its size-reduced form (a raw selection is
  // unbounded storage); the chip's fallback text and the send-time payload are
  // the same bytes the pre-chip insert produced.
  const insert = buildSelectionInsert(sel.path, sel.cwd, sel.lines, sel.text)
  const record: QuoteRecord = {
    id: quoteId(n),
    sessionId,
    n,
    path: sel.path,
    ...(sel.cwd === undefined ? {} : { cwd: sel.cwd }),
    ...(sel.lines === undefined ? {} : { lines: sel.lines }),
    label: t('quoteChip', { where: whereOf(sel.path, sel.lines) }),
    clipboardText,
    text: insert.text,
  }
  const reference: PendingReference = {
    source: QUOTE_SOURCE,
    ref: record.id,
    label: record.label,
    appearance: 'file',
    clipboardText,
    // Not what the chip carries (`ref` is the id, and the codec expands it on
    // send), but the plain-text form an ordinary path would fall back to —
    // and the fenced block itself, so a chip that cannot land still yields
    // the same payload as the pre-chip insert.
    text: insert.text,
  }
  records.set(record.id, record)
  if (!saveStore()) {
    // No persisted record = no chip: the core bundle resolves refs through
    // localStorage, so a chip whose record never landed would click into
    // nothing and block the send in the codec. The caller falls back to
    // #1052's built-in chip (same payload, just not clickable).
    records.delete(record.id)
    console.warn('[dsh-better-sidebar] quote chip skipped: the reference store cannot be written (quota/private mode)')
    return false
  }
  const landed = insertDraftReference(ctx, sessionId, reference)
  if (!landed) {
    // The record is not referenced by any draft, so drop it rather than leak
    // an id: the caller's fallback insert carries the same payload.
    records.delete(record.id)
    saveStore()
  }
  return landed
}
