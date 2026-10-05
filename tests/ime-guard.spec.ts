// @vitest-environment jsdom
/**
 * IME-composition guard tests.
 *
 * The guard registers document CAPTURE-phase keydown/keyup listeners that
 * stopPropagation() while an input method is composing (isComposing, or the
 * legacy keyCode 229 *inside a live composition context* — bare synthetic
 * 229 keydowns from layout-switcher utilities must pass through). These tests
 * pin:
 *
 * 1. the decision predicates — the capture guard's narrow `isImeComposition`
 *    (NOT a pure function: it reads the guard's module-level composition
 *    state) and the conservative `isLikelyImeKey` that non-intercepting
 *    callers use;
 * 2. the native-listener path — a bubble listener on `document` and a
 *    target-phase listener on the input must NOT see composition keys, but
 *    must see every other key;
 * 3. the React-synthetic path — a React `onKeyDown` handler (delegated at
 *    the root container) must not fire for composition keys, proving the
 *    document-capture listener wins the ordering race against React's
 *    delegation (the mechanism that inlined third-party UI, e.g. Univer's
 *    InputNumber, uses to hijack ArrowUp/ArrowDown);
 * 4. the disposer restores normal flow (HMR-safe);
 * 5. the FileTree shape — a commit handler that early-returns on the
 *    conservative predicate must not commit a rename on a bare 229 Enter,
 *    even though the capture guard's predicate deliberately says "not IME"
 *    for that same event.
 *
 * Events are dispatched on a deep element (an `<input>` in `document.body`)
 * exactly like the browser does, so capture-phase blocking behaves like in
 * production — dispatching on `document` itself would run all listeners in
 * the target phase where stopPropagation does not stop same-node listeners.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { isImeComposition, isLikelyImeKey, registerImeGuard } from '../src/client/ime-guard.ts'

/** Build a KeyboardEvent the way jsdom allows: keyCode/isComposing via defineProperty. */
function keyEvent(
  type: 'keydown' | 'keyup',
  init: { key: string; isComposing?: boolean; keyCode?: number; bubbles?: boolean },
): KeyboardEvent {
  const event = new KeyboardEvent(type, { key: init.key, bubbles: init.bubbles ?? true, cancelable: true })
  if (init.isComposing !== undefined) {
    Object.defineProperty(event, 'isComposing', { value: init.isComposing })
  }
  if (init.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  }
  return event
}

describe('isImeComposition', () => {
  it('treats isComposing as composition', () => {
    expect(isImeComposition({ isComposing: true, keyCode: 0 })).toBe(true)
  })

  it('treats keyCode 229 as composition only inside a live composition context', () => {
    // No composition events were dispatched, so no composition is live: a bare
    // synthetic 229 (layout-switcher utilities emit these) must NOT count.
    expect(isImeComposition({ isComposing: false, keyCode: 229 })).toBe(false)
  })

  it('short-circuits on isComposing even when a 229 keyCode rides along', () => {
    // The isComposing branch returns before the composition-context lookup, so
    // this is true for the same reason as the isComposing-only case above.
    expect(isImeComposition({ isComposing: true, keyCode: 229 })).toBe(true)
  })

  it('lets ordinary keys through', () => {
    expect(isImeComposition({ isComposing: false, keyCode: 40 })).toBe(false)
    expect(isImeComposition({ isComposing: false, keyCode: 0 })).toBe(false)
  })
})

describe('isLikelyImeKey — the conservative predicate', () => {
  it('treats isComposing as composition', () => {
    expect(isLikelyImeKey({ isComposing: true, keyCode: 0 })).toBe(true)
  })

  it('trusts a bare keyCode 229 with no composition context at all', () => {
    // This is the whole difference from isImeComposition, and the reason the
    // two names exist: no composition event was ever dispatched here.
    expect(isLikelyImeKey({ isComposing: false, keyCode: 229 })).toBe(true)
  })

  it('lets ordinary keys through', () => {
    expect(isLikelyImeKey({ isComposing: false, keyCode: 40 })).toBe(false)
    expect(isLikelyImeKey({ isComposing: false, keyCode: 13 })).toBe(false)
    expect(isLikelyImeKey({ isComposing: false, keyCode: 0 })).toBe(false)
  })

  it('a FileTree-shaped commit handler ignores a bare 229 Enter (rename / new folder)', () => {
    let commits = 0
    // The shape of FileTree's rename / new-folder onKeyDown: a NON-intercepting
    // early return, so a false positive costs one skipped key while a false
    // negative commits a half-composed name. This case guards THAT call site's
    // semantics, not the capture guard's — the guardian of the document-wide
    // stopPropagation is the `isImeComposition` suite above.
    const onKeyDown = (event: { key: string; isComposing?: boolean; keyCode: number }): void => {
      if (isLikelyImeKey(event)) return
      if (event.key === 'Enter') commits += 1
    }
    // Legacy engines report the IME-confirming Enter as keyCode 229 with
    // isComposing === false; outside a composition window the capture guard's
    // predicate answers false for it by design (#833), so a handler that read
    // its safety from there would commit the rename.
    expect(isImeComposition({ isComposing: false, keyCode: 229 })).toBe(false)
    onKeyDown({ key: 'Enter', isComposing: false, keyCode: 229 })
    expect(commits).toBe(0)
    // A real Enter still commits: the guard must not swallow ordinary typing.
    onKeyDown({ key: 'Enter', isComposing: false, keyCode: 13 })
    expect(commits).toBe(1)
  })
})

describe('registerImeGuard — native listeners', () => {
  let input: HTMLInputElement
  let dispose: (() => void) | undefined
  const seen: string[] = []

  const onDocumentBubble = (event: Event): void => {
    seen.push(`document:${event.type}`)
  }
  const onInputTarget = (event: Event): void => {
    seen.push(`input:${event.type}`)
  }

  beforeEach(() => {
    input = document.createElement('input')
    document.body.appendChild(input)
    seen.length = 0
    document.addEventListener('keydown', onDocumentBubble)
    document.addEventListener('keyup', onDocumentBubble)
    input.addEventListener('keydown', onInputTarget)
    input.addEventListener('keyup', onInputTarget)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    document.removeEventListener('keydown', onDocumentBubble)
    document.removeEventListener('keyup', onDocumentBubble)
    input.removeEventListener('keydown', onInputTarget)
    input.removeEventListener('keyup', onInputTarget)
    input.remove()
  })

  it('lets ordinary keys reach document bubble and input target listeners', () => {
    dispose = registerImeGuard()
    input.dispatchEvent(keyEvent('keydown', { key: 'ArrowDown' }))
    input.dispatchEvent(keyEvent('keyup', { key: 'ArrowDown' }))
    expect(seen).toEqual(['input:keydown', 'document:keydown', 'input:keyup', 'document:keyup'])
  })

  it('blocks composition keys (isComposing) from every downstream listener', () => {
    dispose = registerImeGuard()
    input.dispatchEvent(keyEvent('keydown', { key: 'ArrowDown', isComposing: true }))
    input.dispatchEvent(keyEvent('keyup', { key: 'ArrowDown', isComposing: true }))
    expect(seen).toEqual([])
  })

  it('blocks a keyCode 229 keydown inside a live composition (legacy engines emit 229 with isComposing=false)', () => {
    dispose = registerImeGuard()
    document.dispatchEvent(new Event('compositionstart'))
    input.dispatchEvent(keyEvent('keydown', { key: 'ArrowDown', isComposing: false, keyCode: 229 }))
    expect(seen).toEqual([])
  })

  it('keeps blocking a keyCode 229 keydown right after compositionend (legacy closing keydown)', () => {
    vi.useFakeTimers()
    try {
      dispose = registerImeGuard()
      document.dispatchEvent(new Event('compositionstart'))
      document.dispatchEvent(new Event('compositionend'))
      input.dispatchEvent(keyEvent('keydown', { key: 'a', isComposing: false, keyCode: 229 }))
      expect(seen).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a bare synthetic keyCode 229 keydown through when no composition ever started (KeyRay regression)', () => {
    dispose = registerImeGuard()
    input.dispatchEvent(keyEvent('keydown', { key: 'ArrowDown', isComposing: false, keyCode: 229 }))
    expect(seen).toEqual(['input:keydown', 'document:keydown'])
  })

  it('lets a keyCode 229 keydown through after the post-compositionend grace window expires', () => {
    vi.useFakeTimers()
    try {
      dispose = registerImeGuard()
      document.dispatchEvent(new Event('compositionstart'))
      document.dispatchEvent(new Event('compositionend'))
      vi.advanceTimersByTime(51)
      input.dispatchEvent(keyEvent('keydown', { key: 'ArrowDown', isComposing: false, keyCode: 229 }))
      expect(seen).toEqual(['input:keydown', 'document:keydown'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('still blocks after the composition signal is gone (guard is per-event)', () => {
    dispose = registerImeGuard()
    input.dispatchEvent(keyEvent('keydown', { key: 'ArrowDown', isComposing: true }))
    input.dispatchEvent(keyEvent('keydown', { key: 'ArrowDown', isComposing: false }))
    expect(seen).toEqual(['input:keydown', 'document:keydown'])
  })

  it('disposer restores normal flow', () => {
    dispose = registerImeGuard()
    input.dispatchEvent(keyEvent('keydown', { key: 'ArrowDown', isComposing: true }))
    expect(seen).toEqual([])
    dispose()
    dispose = undefined
    input.dispatchEvent(keyEvent('keydown', { key: 'ArrowDown', isComposing: true }))
    expect(seen).toEqual(['input:keydown', 'document:keydown'])
  })
})

describe('registerImeGuard — React synthetic path', () => {
  let container: HTMLDivElement
  let root: Root
  let input: HTMLInputElement
  let dispose: (() => void) | undefined
  const seen: string[] = []

  const onReactKeyDown = (): void => {
    seen.push('react:keydown')
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(createElement('input', { 'data-testid': 'ime-target', onKeyDown: onReactKeyDown }))
    })
    input = container.querySelector('input') as HTMLInputElement
    seen.length = 0
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    act(() => { root.unmount() })
    container.remove()
  })

  it('baseline: React onKeyDown receives composition keys when the guard is absent', () => {
    input.dispatchEvent(keyEvent('keydown', { key: 'ArrowDown', isComposing: true }))
    expect(seen).toEqual(['react:keydown'])
  })

  it('guard blocks React synthetic onKeyDown during composition (capture beats delegation)', () => {
    dispose = registerImeGuard()
    input.dispatchEvent(keyEvent('keydown', { key: 'ArrowDown', isComposing: true }))
    expect(seen).toEqual([])
    // Ordinary keys still flow through React after the guard is in place.
    input.dispatchEvent(keyEvent('keydown', { key: 'ArrowDown', isComposing: false }))
    expect(seen).toEqual(['react:keydown'])
  })

  it('disposer restores the React synthetic path', () => {
    dispose = registerImeGuard()
    input.dispatchEvent(keyEvent('keydown', { key: 'ArrowDown', isComposing: true }))
    expect(seen).toEqual([])
    dispose()
    dispose = undefined
    input.dispatchEvent(keyEvent('keydown', { key: 'ArrowDown', isComposing: true }))
    expect(seen).toEqual(['react:keydown'])
  })
})
