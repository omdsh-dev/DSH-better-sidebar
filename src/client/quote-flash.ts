/**
 * The landing flash: when a navigation lands the editor on a source range
 * (a quote chip's lines), those lines wash in the theme's hover-accent color
 * and fade out, so the span reads at a glance instead of a caret somewhere.
 *
 * The mechanism is a CodeMirror StateField carrying the flash's doc range plus
 * a decorations facet rendering one line class per line; the flash clears
 * itself (the caller owns the timer). Colors come from the skin tokens — a
 * decoration class must be a literal name, so the rule lives outside the CSS
 * module and is injected once per document on the first flash.
 */
import { StateEffect, StateField, type Range } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'

/** The injected stylesheet's element id (one per document). */
export const QUOTE_FLASH_STYLE_ID = 'dsh-quote-flash-style'

/**
 * How long a flash stays up before the caller clears it (ms). The CSS fade is
 * slightly shorter, so the class removal never cuts a visible color change.
 */
export const QUOTE_FLASH_MS = 2400

/**
 * Inject the flash stylesheet once per document (idempotent). The wash is the
 * skin's hover accent — the same token the search panel's active line uses —
 * mixed toward transparent so the text underneath stays readable; a reduced-
 * motion reader gets a static tint (the flash still clears on its timer).
 */
export function ensureQuoteFlashStyle(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(QUOTE_FLASH_STYLE_ID) !== null) return
  // One token-derived tint at three strengths: the resting wash, the flash
  // frame, and the reduced-motion static tint.
  const tint = (percent: number): string =>
    `color-mix(in srgb, var(--dsw-alias-interactive-bg-hover-accent) ${percent}%, transparent)`
  const style = document.createElement('style')
  style.id = QUOTE_FLASH_STYLE_ID
  style.textContent = [
    `.cm-quote-flash{background-color:${tint(55)}!important;`,
    'animation:dsh-quote-flash-fade 2.2s ease-out forwards}',
    `@keyframes dsh-quote-flash-fade{0%{background-color:${tint(85)}}`,
    '100%{background-color:transparent}}',
    '@media (prefers-reduced-motion:reduce){.cm-quote-flash{animation:none;',
    `background-color:${tint(45)}}}`,
  ].join('')
  document.head.appendChild(style)
}

/**
 * Clamp a flash line range to the document.
 * @param docLines - the document's line count (the 1-based world).
 * @param line - the 1-based start line.
 * @param lineEnd - the 1-based end line (`undefined` = the start line alone).
 * @returns the clamped first/last line numbers, or `undefined` when the start
 *   lies outside the document (nothing to flash).
 */
export function clampQuoteRange(
  docLines: number,
  line: number,
  lineEnd: number | undefined,
): { first: number; last: number } | undefined {
  if (!(line >= 1) || line > docLines) return undefined
  return { first: line, last: Math.min(Math.max(lineEnd ?? line, line), docLines) }
}

/** The flash a viewer owes: a doc range, or `undefined` to clear. */
export const quoteFlashEffect = StateEffect.define<{ from: number; to: number } | undefined>()

/** The flash's live range, mapped through document edits between flashes. */
export const quoteFlashField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    let next: { from: number; to: number } | null = value
    for (const effect of tr.effects) {
      if (effect.is(quoteFlashEffect)) next = effect.value ?? null
    }
    if (next === null) return null
    return { from: tr.changes.mapPos(next.from, -1), to: tr.changes.mapPos(next.to, 1) }
  },
})

/** Renders the flash as one line decoration per line of the range. */
export const quoteFlashHighlight = EditorView.decorations.compute([quoteFlashField], (state) => {
  const range = state.field(quoteFlashField)
  if (range === null) return Decoration.none
  const marks: Range<Decoration>[] = []
  const first = state.doc.lineAt(range.from).number
  const last = state.doc.lineAt(range.to).number
  for (let number = first; number <= last; number++) {
    marks.push(Decoration.line({ class: 'cm-quote-flash' }).range(state.doc.line(number).from))
  }
  return Decoration.set(marks, true)
})

/**
 * Flash one source line range in the live view and clear it after
 * {@link QUOTE_FLASH_MS}.
 * @param view - the editor view.
 * @param line - the 1-based start line.
 * @param lineEnd - the 1-based end line (`undefined` = the start line alone).
 * @returns the clear timer, or `undefined` when the range did not fit.
 */
export function flashQuoteLines(
  view: EditorView,
  line: number,
  lineEnd: number | undefined,
): ReturnType<typeof setTimeout> | undefined {
  const range = clampQuoteRange(view.state.doc.lines, line, lineEnd)
  if (range === undefined) return undefined
  ensureQuoteFlashStyle()
  const doc = view.state.doc
  view.dispatch({
    effects: quoteFlashEffect.of({ from: doc.line(range.first).from, to: doc.line(range.last).to }),
  })
  return setTimeout(() => {
    // The view may be gone by the time the timer fires (chunk unload, file
    // switch); an idle clear on a destroyed view throws, so guard on it.
    try {
      if (viewDestroyed(view)) return
      view.dispatch({ effects: quoteFlashEffect.of(undefined) })
    } catch {
      // Nothing to clear.
    }
  }, QUOTE_FLASH_MS)
}

/** Whether a view has been destroyed (its dom left the document). */
function viewDestroyed(view: EditorView): boolean {
  return view.dom.isConnected === false
}
