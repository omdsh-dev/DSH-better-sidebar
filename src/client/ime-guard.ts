/**
 * IME-composition key guard.
 *
 * While a Chinese/Japanese/Korean input method is composing (the user is
 * picking a candidate from the IME window), every pressed key BELONGS to the
 * input method: arrows move the candidate highlight, Enter/Space confirm the
 * composition, Escape cancels it. Page code must not process those keys —
 * a component that does (a number stepper calling preventDefault() on
 * ArrowUp/ArrowDown, a submit handler reacting to Enter, ...) silently
 * breaks the IME: candidates stop responding, the composition gets torn
 * apart, and only bare letters come out.
 *
 * This guard enforces that rule at the document boundary: a capture-phase
 * keydown/keyup listener that stops the event from propagating further
 * whenever a composition is in progress. Because it runs in the capture
 * phase on `document` — the outermost node — it fires BEFORE React's
 * delegated handlers (attached at the root container) and before any native
 * target/bubble listener, so an inlined third-party component (e.g. the
 * Univer office UI bundled into this plugin) can never intercept
 * composition keys. The browser's native IME processing is untouched:
 * stopPropagation only silences page JS, not the default action.
 *
 * TWO predicates, deliberately different, because the two kinds of call site
 * pay different prices for a false positive:
 *
 * - `isImeComposition` — the capture guard's decision (narrow). A false
 *   positive here costs `stopPropagation()`: the key is swallowed for EVERY
 *   downstream listener, page-wide. Trusting a bare legacy 229 outside a
 *   composition window did exactly that to layout-switcher utilities (#833,
 *   see below), so 229 only counts while a composition is live.
 * - `isLikelyImeKey` — the conservative disjunction
 *   `isComposing || keyCode === 229`, for NON-intercepting callers that use
 *   the answer as an early return (FileTree's rename / new-folder commit
 *   handlers). A false positive there costs one skipped key while a false
 *   negative commits a half-composed name, so the over-approximation wins.
 *
 * The conservative shape is also what DSH core itself uses, but only because
 * no core call site stops propagation: `QuestionComposer` (ui-user-questions)
 * has no composition tracking at all — just `isComposing || keyCode === 229` —
 * and `InputBar` (ui-conversation, issue #535) ORs a live composition ref
 * with the bare 229. This module is the one place where the wider rule is
 * wrong, which is why the narrow decision lives behind its own name here.
 *
 * The legacy 229 signal is only trusted by the capture guard while (or right
 * after) a real composition is running. Legacy engines (Safari) emit 229
 * keydowns with `isComposing === false` *during* a composition, and that
 * context is what distinguishes them from synthetic 229 keydowns emitted
 * outside any IME — layout-switcher utilities (e.g. KeyRay's layout swap)
 * send a keydown carrying the whole converted word as a multi-character
 * unicode string, Chromium reports it as keyCode 229 / isComposing=false, and
 * swallowing it made the backspaces land while the replacement text never
 * did: the word silently disappeared instead of being rewritten.
 */

/** Live composition context, tracked by the guard's composition listeners. */
let guardComposing = false
/** Grace window (ms) after compositionend that still counts as composition,
 *  covering legacy engines' closing 229 keydown with isComposing === false. */
const GUARD_COMPOSITION_END_GRACE_MS = 50
let guardComposingUntil = 0

function imeCompositionLive(): boolean {
  return guardComposing || Date.now() < guardComposingUntil
}

/** The key-event shape both predicates accept. `isComposing` is optional:
 *  React's synthetic KeyboardEvent type does not declare it (the DOM event
 *  always carries it). */
type ImeKeyEvent = { isComposing?: boolean; keyCode: number }

/** The CAPTURE guard's decision: is this keyboard event part of an IME
 *  composition? NOT a pure function of its argument — it consults the
 *  guard's module-level composition state (above) to scope the legacy 229
 *  signal. Never reuse it as a generic "is IME" helper: see the module doc
 *  for why non-intercepting callers want `isLikelyImeKey` instead. */
export function isImeComposition(event: ImeKeyEvent): boolean {
  if (event.isComposing === true) return true
  if (event.keyCode !== 229) return false
  return imeCompositionLive()
}

/** The CONSERVATIVE decision, for non-intercepting callers where misreading a
 *  composition key costs more than ignoring an ordinary one: a bare 229 counts
 *  even outside a composition window. Pure — reads no module state, so it
 *  answers the same before, during and after a composition. */
export function isLikelyImeKey(event: ImeKeyEvent): boolean {
  return event.isComposing === true || event.keyCode === 229
}

/**
 * Register the document-level capture guard. Returns the disposer
 * (HMR-safe; call through `ctx.effect`).
 */
export function registerImeGuard(): () => void {
  const onKey = (event: KeyboardEvent): void => {
    if (isImeComposition(event)) event.stopPropagation()
  }
  const onCompositionStart = (): void => {
    guardComposing = true
  }
  const onCompositionEnd = (): void => {
    guardComposing = false
    guardComposingUntil = Date.now() + GUARD_COMPOSITION_END_GRACE_MS
  }
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('keyup', onKey, true)
  document.addEventListener('compositionstart', onCompositionStart, true)
  document.addEventListener('compositionend', onCompositionEnd, true)
  return () => {
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('keyup', onKey, true)
    document.removeEventListener('compositionstart', onCompositionStart, true)
    document.removeEventListener('compositionend', onCompositionEnd, true)
    guardComposing = false
    guardComposingUntil = 0
  }
}
