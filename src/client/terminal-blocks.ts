/**
 * The terminal "block" framework: one continuous xterm buffer is segmented
 * into per-command blocks — each CLI execution gets a block carrying the
 * cleaned command and the buffer rows of its output — and the "add to
 * conversation" payloads are built from them. This is the terminal analog
 * of `selection-payload.ts` (the text viewers' selection popup): the same
 * appendToDraft path, fed with a block instead of a file selection.
 *
 * Everything here is pure row/string math over a minimal structural view of
 * the xterm buffer ({@link TerminalBlockBuffer}); xterm's own
 * `IBuffer`/`IBufferLine` satisfy the shapes structurally, so the unit
 * tests drive the whole framework without mounting xterm.
 *
 * Block boundaries come from the user's input stream, not from prompt
 * detection: each Enter (`\r`/`\n`) in the onData feed submits the cleaned
 * pending command and opens a new block anchored at the shell's echo row
 * (the last buffer row at submit time — the prompt + command line). Output
 * extraction therefore SKIPS the echo row; the payload carries the command
 * in its fence header instead. Rows after a submit (output, and the next
 * prompt) belong to the open block until the next submit closes it.
 */

/** Minimal structural view of one buffer row (matches xterm's IBufferLine). */
export interface TerminalBlockLine {
  /** Whether this row continues the row above (a wrapped line). */
  readonly isWrapped: boolean
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

/** Minimal structural view of a terminal buffer (matches xterm's IBuffer).
 *  xterm's real buffer satisfies this shape, so the tracker/extractors are
 *  fully testable without mounting xterm. */
export interface TerminalBlockBuffer {
  readonly length: number
  getLine(y: number): TerminalBlockLine | undefined
}

/** A row anchor that survives scrollback trimming and reflow (matches
 *  xterm's IMarker — `registerMarker(0)` anchors the cursor's row). The
 *  VIEW attaches one to a block right after its submit; the tracker itself
 *  never creates markers, keeping the framework xterm-free. */
export interface TerminalBlockMarker {
  /** The current buffer row of the anchor. */
  readonly line: number
  /** True once the anchor's row was trimmed out of the buffer. */
  readonly isDisposed: boolean
  dispose(): void
}

/** How many finished blocks the tracker keeps (older ones drop off). */
export const BLOCK_KEEP = 32

/** One CLI execution: the command and the buffer span of its rows. */
export interface TerminalBlock {
  /** Monotonic per-tracker id (ordering only). */
  readonly id: number
  /** The cleaned command text the user submitted (never empty). */
  readonly command: string
  /** Buffer row of the shell echo (prompt + command) at submit time. */
  readonly startRow: number
  /** Echo row of the NEXT command; null while this block is still open.
   *  Finished blocks get a closed span: [startRow+1, endRow). The tracker
   *  closes the span when the next command submits. */
  endRow: number | null
  finished: boolean
  /** The live anchor of the echo row (attached by the view right after the
   *  submit; {@link blockStartLine} prefers it over the index-based
   *  `startRow`, which drifts when the scrollback trims). */
  marker?: TerminalBlockMarker
}

/**
 * Segments the terminal's input stream into blocks. Feed every onData chunk
 * (with the buffer length at that moment) — submits, pending text and the
 * block list all derive from it. The optional `onSubmit` callback fires
 * right after a block is created — the view uses it to attach the xterm
 * marker anchoring the echo row — keeping the framework xterm-free.
 */
export class TerminalBlockTracker {
  private _mode: 0 | 1 | 2 | 3 = 0
  private _clean = ''
  private _blocks: TerminalBlock[] = []
  private _current: TerminalBlock | null = null
  private _nextId = 1
  private readonly _onSubmit: ((block: TerminalBlock) => void) | undefined

  constructor(onSubmit?: (block: TerminalBlock) => void) {
    this._onSubmit = onSubmit
  }

  /** All tracked blocks, oldest first (capped at {@link BLOCK_KEEP}). */
  get blocks(): readonly TerminalBlock[] {
    return this._blocks
  }

  /** The open block (the last submitted command, still growing). */
  get current(): TerminalBlock | null {
    return this._current
  }

  /** Cleaned text typed since the last submit (the next command so far). */
  get pending(): string {
    return this._clean
  }

  /** Feed one onData chunk. `bufferLength` = `term.buffer.active.length`
   *  at the time the chunk was produced — it anchors a submit's echo row. */
  onData(data: string, bufferLength: number): void {
    for (let i = 0; i < data.length; i++) this._feed(data.charAt(i), bufferLength)
  }

  private _feed(ch: string, bufferLength: number): void {
    const code = ch.charCodeAt(0)
    switch (this._mode) {
      case 1: // After ESC: '[' starts CSI, ']' starts OSC, anything else
        // consumed the sequence (e.g. ESC \ closes an OSC string).
        this._mode = ch === '[' ? 2 : ch === ']' ? 3 : 0
        return
      case 2: // CSI: swallows up to the final byte (0x40–0x7e).
        if (code >= 0x40 && code <= 0x7e) this._mode = 0
        return
      case 3: // OSC: swallows until BEL or ST (ESC \).
        if (ch === '\x07') this._mode = 0
        else if (ch === '\x1b') this._mode = 1
        return
      default: // 0 — printable handling below.
        break
    }
    if (code === 0x1b) { this._mode = 1; return }
    if (ch === '\r' || ch === '\n') { this._submit(bufferLength); return }
    if (code === 0x7f || code === 0x08) { this._clean = this._clean.slice(0, -1); return }
    if (code < 0x20) return // Remaining C0 controls (tab, bell…) — not command text.
    this._clean += ch
  }

  private _submit(bufferLength: number): void {
    const command = this._clean.trim()
    this._clean = ''
    // A bare Enter produces no block — the shell just stamps another prompt
    // line, which stays inside the previous block's span (trailing blank
    // rows are stripped at extraction anyway).
    if (command === '') return
    const startRow = Math.max(0, bufferLength - 1)
    if (this._current !== null) {
      this._current.finished = true
      this._current.endRow = startRow
    }
    const block: TerminalBlock = {
      id: this._nextId++,
      command,
      startRow,
      endRow: null,
      finished: false,
    }
    this._blocks.push(block)
    if (this._blocks.length > BLOCK_KEEP) {
      const dropped = this._blocks.splice(0, this._blocks.length - BLOCK_KEEP)
      for (const old of dropped) {
        if (old.marker !== undefined && !old.marker.isDisposed) old.marker.dispose()
      }
    }
    this._current = block
    this._onSubmit?.(block)
  }
}

/**
 * The live buffer row a block's echo row currently sits on: the marker's
 * line when one was attached (markers slide with scrollback trims and
 * reflows), the index-based `startRow` when no marker exists (never
 * attached). A DISPOSED marker means the echo row was trimmed out of the
 * buffer entirely — the block's rows are gone, so it resolves to
 * +Infinity, which every consumer treats as "not present".
 */
export function blockStartLine(block: TerminalBlock): number {
  if (block.marker === undefined) return block.startRow
  return block.marker.isDisposed ? Number.POSITIVE_INFINITY : block.marker.line
}

/**
 * The buffer row where a block's span ENDS (exclusive): the next block's
 * start line, or Infinity for the newest block (its span runs to the live
 * buffer end).
 */
export function blockEndLine(
  blocks: readonly TerminalBlock[],
  block: TerminalBlock,
): number {
  const index = blocks.indexOf(block)
  if (index === -1 || index >= blocks.length - 1) return Infinity
  return blockStartLine(blocks[index + 1]!)
}

/**
 * The clipped visible span of a block: `{ start, end }` with end exclusive,
 * both clamped into `[0, bufferLength]` (rows trimmed away or an alt-buffer
 * swap shrink the buffer; the span then degrades gracefully to what remains).
 */
export function blockSpanLines(
  blocks: readonly TerminalBlock[],
  block: TerminalBlock,
  bufferLength: number,
): { start: number; end: number } {
  const endLine = blockEndLine(blocks, block)
  const end = Math.min(Number.isFinite(endLine) ? endLine : bufferLength, bufferLength)
  return {
    start: Math.min(Math.max(blockStartLine(block), 0), bufferLength),
    end,
  }
}

/**
 * The plain-text rows of a block's output: `[start+1, end)` where the echo
 * row (prompt + command) is skipped — the payload's fence header carries the
 * command instead, and the span itself resolves through the block's live
 * marker when available. Wrapped rows re-join without a newline, trailing
 * blank rows (prompt stamps, empty lines) are stripped, and a trailing row
 * that still ends with the *pending* next command (the shell echoes while
 * the user types) is peeled off so a half-typed command never leaks into
 * the payload. Best-effort by design: reply races (a pasted Enter landing
 * before its echo) and prompt redraws shift the anchor a little, never
 * worse than a misplaced boundary line. `endRow` overrides the closed-span
 * boundary (callers resolve it marker-aware via {@link blockSpanLines});
 * the open block always runs to the live buffer end.
 */
export function blockOutputText(
  buffer: TerminalBlockBuffer,
  block: TerminalBlock,
  pending = '',
  endRow?: number,
): string {
  const length = buffer.length
  const from = Math.min(Math.max(blockStartLine(block) + 1, 0), length)
  const end = Math.min(endRow ?? block.endRow ?? length, length)
  if (end <= from) return ''
  let text = ''
  let first = true
  for (let i = from; i < end; i++) {
    const line = buffer.getLine(i)
    if (line === undefined) continue
    const row = line.translateToString(true)
    // A wrapped row continues the previous line — no newline before it.
    text += (line.isWrapped || first ? '' : '\n') + row
    first = false
  }
  const pendingTrimmed = pending.trim()
  if (pendingTrimmed !== '') {
    // The shell echoes the NEXT command while the user types it; its row is
    // the open block's tail and must not leak into the payload.
    const lastBreak = text.lastIndexOf('\n')
    const lastRow = lastBreak === -1 ? text : text.slice(lastBreak + 1)
    if (lastRow.trimEnd().endsWith(pendingTrimmed)) {
      text = lastBreak === -1 ? '' : text.slice(0, lastBreak)
    }
  }
  return text.trimEnd()
}

/**
 * The block containing a buffer row (1-based xterm coordinates become
 * 0-based here), newest first — spans resolve through the blocks' live
 * markers, so the attribution stays correct after scrollback trims. Returns
 * null when the row predates all tracked blocks — the header then falls
 * back to a bare fence.
 */
export function blockForSelection(
  blocks: readonly TerminalBlock[],
  bufferRow: number,
): TerminalBlock | null {
  if (bufferRow < 0) return null
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block === undefined) continue
    if (blockStartLine(block) > bufferRow) continue
    if (i < blocks.length - 1) {
      if (bufferRow >= blockStartLine(blocks[i + 1]!)) continue
    } else if (block.endRow !== null && bufferRow >= block.endRow) {
      // Defensive: the tracker only closes a block when a NEXT one exists,
      // but a synthetic last-and-finished block must not own rows past its
      // closed span either.
      continue
    }
    return block
  }
  return null
}

/** Max body length of an inserted block/selection (UTF-16 units). */
export const TERMINAL_INSERT_LIMIT = 4000

/** The ellipsis appended at a truncation point (data marker, locale-free). */
const TERMINAL_INSERT_ELLIPSIS = '\n…'

/**
 * The full "add to conversation" payload for a terminal block or selection,
 * mirroring `buildSelectionInsert`'s shape: a fenced code block whose info
 * line is the command the content belongs to (`$ <command>`, empty when
 * unknown) and whose body is the text. Over the limit the body is cut and
 * marked instead of dropped — unlike a file selection, the output IS the
 * point of a terminal block.
 */
export function buildTerminalInsert(
  command: string | undefined,
  body: string,
  options: { limit?: number; ellipsis?: string } = {},
): string {
  const header = command !== undefined && command.trim() !== ''
    ? `$ ${command.trim()}`
    : ''
  const limit = options.limit ?? TERMINAL_INSERT_LIMIT
  let text = body
  if (text.length > limit) {
    text = `${text.slice(0, limit)}${options.ellipsis ?? TERMINAL_INSERT_ELLIPSIS}`
  }
  return `\`\`\`${header}\n${text}\n\`\`\``
}