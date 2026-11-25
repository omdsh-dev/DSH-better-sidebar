/** A failed renderer stays local and the shared retry action restores its content. */
// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { RenderBoundary } from '../src/client/RenderBoundary.tsx'
import { t } from '../src/client/locales.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()

describe('RenderBoundary recovery', () => {
  it('announces the renderer failure and recovers through the shared retry action', () => {
    let broken = true
    function Content() {
      if (broken) throw new Error('source renderer failed')
      return createElement('p', null, 'Recovered source content')
    }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = renderRoot(createElement('div', null,
      createElement('aside', null, 'Other surface'),
      createElement(RenderBoundary, { className: 'local-boundary' }, createElement(Content)),
    ))
    try {
      const alert = view.container.querySelector('[role="alert"]')!
      expect(alert.textContent).toContain('source renderer failed')
      expect(view.container.querySelector('aside')?.textContent).toBe('Other surface')
      const retry = alert.querySelector<HTMLButtonElement>('button')!
      expect(retry.textContent).toBe(t('terminalRetry'))
      broken = false
      act(() => { retry.click() })
      expect(view.container.querySelector('[role="alert"]')).toBeNull()
      expect(view.container.textContent).toContain('Recovered source content')
      expect(view.container.querySelector('aside')?.textContent).toBe('Other surface')
    } finally {
      view.unmount()
      log.mockRestore()
    }
  })
})
