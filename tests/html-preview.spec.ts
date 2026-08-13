/**
 * HTML draft-preview target decision tests (see src/client/html-preview.ts):
 * the preview iframe renders a dirty draft through srcdoc ONLY while the
 * sandbox is enabled (opaque origin); every other state keeps the saved-file
 * route URL — in particular a dirty draft with the sandbox disabled must NOT
 * use srcdoc, because an unsandboxed srcdoc frame inherits the GUI origin.
 */
import { describe, expect, it } from 'vitest'
import { htmlPreviewTarget } from '../src/client/html-preview.ts'

const ROUTE = '/sidebar/html/S/Users/me/index.html'

describe('htmlPreviewTarget', () => {
  it('keeps the saved-file route when clean', () => {
    expect(htmlPreviewTarget({ isHtml: true, dirty: false, draft: null, sandboxOff: false, routeUrl: ROUTE }))
      .toEqual({ src: ROUTE })
  })

  it('previews a dirty draft through srcdoc while the sandbox is enabled', () => {
    expect(htmlPreviewTarget({ isHtml: true, dirty: true, draft: '<h1>draft</h1>', sandboxOff: false, routeUrl: ROUTE }))
      .toEqual({ srcDoc: '<h1>draft</h1>' })
  })

  it('refuses srcdoc for a dirty draft once the sandbox is disabled (origin safety)', () => {
    expect(htmlPreviewTarget({ isHtml: true, dirty: true, draft: '<h1>draft</h1>', sandboxOff: true, routeUrl: ROUTE }))
      .toEqual({ src: ROUTE })
  })

  it('ignores draft state for non-HTML files', () => {
    expect(htmlPreviewTarget({ isHtml: false, dirty: true, draft: 'x', sandboxOff: false, routeUrl: ROUTE }))
      .toEqual({ src: ROUTE })
  })

  it('keeps the route when dirty but the draft is null (clean editor)', () => {
    expect(htmlPreviewTarget({ isHtml: true, dirty: true, draft: null, sandboxOff: false, routeUrl: ROUTE }))
      .toEqual({ src: ROUTE })
  })
})
