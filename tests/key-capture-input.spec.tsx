/**
 * Key-capture input render spec (SSR): the shortcut rows' control shows the
 * platform-aware label of the current combo (or the disabled copy), carries
 * the `data-dsh-shortcut-capture` marker the global shortcut listener skips,
 * and renders the capture hint while recording. Rendered with
 * renderToString — effects do not run in SSR, which is exactly the idle
 * state we assert.
 */
import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { KeyCaptureInput } from '../src/client/KeyCaptureInput.tsx'
import { isMacPlatform, shortcutLabel } from '../src/client/shortcut-combo.ts'

function render(value: string): string {
  return renderToString(
    createElement(KeyCaptureInput, {
      value,
      ariaLabel: 'Test shortcut',
      onChange: () => {},
    }),
  )
}

describe('KeyCaptureInput (SSR)', () => {
  it('shows the platform label of the current combo', () => {
    // The control and the assertion agree on the same platform detection,
    // so the spec is stable on macOS and elsewhere alike.
    expect(render('mod+b')).toContain(shortcutLabel('mod+b', isMacPlatform()))
  })

  it('shows the disabled copy for an empty combo', () => {
    expect(render('')).toContain('Disabled')
  })

  it('carries the capture marker and the aria label', () => {
    const html = render('mod+t')
    expect(html).toContain('data-dsh-shortcut-capture')
    expect(html).toContain('aria-label="Test shortcut"')
  })
})
