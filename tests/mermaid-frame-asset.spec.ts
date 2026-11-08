/**
 * The generated mermaid frame asset must stay a single self-contained HTML
 * document: the preview loads it into an opaque-origin sandboxed iframe, which
 * can fetch no subresources, and a raw `</script` inside either inlined script
 * would close the element early and corrupt the frame.
 */
import { describe, expect, it } from 'vitest'
import { MERMAID_FRAME_HTML } from '../src/client/mermaid-frame-asset.generated.ts'

describe('mermaid frame asset', () => {
  it('is a self-contained HTML document with the frame protocol', () => {
    expect(MERMAID_FRAME_HTML.startsWith('<!doctype html>')).toBe(true)
    expect(MERMAID_FRAME_HTML).toContain('window.__dshMermaidFrame')
    expect(MERMAID_FRAME_HTML).toContain('mermaid-frame-ready')
    expect(MERMAID_FRAME_HTML).toContain('dsh-frame-mermaid-')
  })

  it('inlines exactly two script bodies (mermaid UMD + frame protocol)', () => {
    // Every `</script` inside the inlined sources is escaped as `<\/script`,
    // so the document carries exactly the two structural closing tags.
    expect(MERMAID_FRAME_HTML.match(/<\/script>/gi)?.length).toBe(2)
  })

  it('carries the strict mermaid configuration used by the preview', () => {
    expect(MERMAID_FRAME_HTML).toContain("securityLevel: 'strict'")
    expect(MERMAID_FRAME_HTML).toContain('htmlLabels: false')
    expect(MERMAID_FRAME_HTML).toContain('suppressErrorRendering: true')
  })

  it('validates the sender and the payload on the frame side', () => {
    // The opaque-origin sandbox cannot compare origins, so the frame binds
    // requests to its parent window and validates every field it consumes.
    expect(MERMAID_FRAME_HTML).toContain('event.source !== window.parent')
    expect(MERMAID_FRAME_HTML).toContain("typeof data.id !== 'number'")
    expect(MERMAID_FRAME_HTML).toContain("typeof data.code !== 'string'")
    expect(MERMAID_FRAME_HTML).toContain('data.code.length > MAX_SOURCE')
    expect(MERMAID_FRAME_HTML).toContain("data.theme === 'dark' ? 'dark' : 'default'")
  })
})
