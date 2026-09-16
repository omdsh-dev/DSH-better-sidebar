/**
 * TerminalWaitBanner unit tests: localized text with the needle, the skip
 * button wiring, and the long-needle display cap (full text stays on the
 * title attribute). The component imports no xterm — renderable in plain
 * jsdom (the repo's jsdom pattern, see bottom-auto-terminal.spec.tsx head).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { TerminalWaitBanner } from '../src/client/TerminalWaitBanner.tsx'

describe('TerminalWaitBanner', () => {
  const mounted: Array<{ root: Root; container: HTMLDivElement }> = []
  function mount(needle: string, onSkip: () => void): HTMLDivElement {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => { root.render(createElement(TerminalWaitBanner, { needle, onSkip })) })
    mounted.push({ root, container })
    return container
  }
  afterEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('shows the localized waiting text with the needle and a working skip button', () => {
    let skipped = 0
    const container = mount('BUILD_OK', () => { skipped += 1 })
    // jsdom navigator.language is en-US → the en dictionary applies.
    expect(container.textContent).toContain('Agent is waiting for')
    expect(container.textContent).toContain('BUILD_OK')
    expect(container.textContent).toContain('Skip wait')
    const button = container.querySelector('button')
    expect(button).not.toBeNull()
    act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(skipped).toBe(1)
  })

  it('truncates a long needle for display but keeps the full text on the title', () => {
    const long = 'X'.repeat(200)
    const container = mount(long, () => {})
    const span = container.querySelector('span[title]')
    expect(span).not.toBeNull()
    expect(span!.getAttribute('title')).toBe(long)
    // The needle's inline contribution is capped (NEEDLE_DISPLAY_CAP): at
    // most 80 X's are rendered — the full 200-char run only rides the title
    // tooltip. The localized sentence around the needle is not measured;
    // its length varies per language, so counting the needle's own chars is
    // the language-agnostic form of the display-cap assertion.
    expect((span!.textContent?.match(/X/g) ?? []).length).toBeLessThanOrEqual(80)
  })
})
