// @vitest-environment jsdom
/** The clue guide uses the host modal's dialog and focus semantics. */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderRoot, setupReactAct } from './test-utils.ts'
setupReactAct()
import { ClueHelpOverlay } from '../src/client/clues/tab/help.tsx'

afterEach(() => { document.body.innerHTML = '' })

describe('clue help dialog', () => {
  it('renders three steps in an accessible host dialog with a concise close action', () => {
    const close = vi.fn()
    const view = renderRoot(createElement(ClueHelpOverlay, { onClose: close }))
    const guide = document.body.querySelector<HTMLElement>('[data-clue-help]')
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(guide).not.toBeNull()
    expect(guide!.querySelectorAll('[data-clue-help-step]')).toHaveLength(3)
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.getAttribute('aria-label')).toBeTruthy()
    expect(dialog?.querySelector('[aria-label="Close help"]')).not.toBeNull()
    expect(document.querySelector('[data-clue-help-notes]')).toBeNull()
    expect(guide!.textContent!.length).toBeLessThan(650)
    view.unmount()
  })
})
