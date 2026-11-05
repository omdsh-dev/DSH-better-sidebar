import { describe, expect, it } from 'vitest'
import katex from 'katex'
import { createRequire } from 'node:module'
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { runScripts: string }) => {
    window: { mermaid: { parse: (input: string) => Promise<unknown> }; close: () => void }
  }
}
import { MERMAID_FRAME_HTML } from '../src/client/mermaid-frame-asset.generated.ts'

describe('patched mathematical renderer in the delivered frame', () => {
  it('does not inherit trust from an options prototype (GHSA-238p-pmpm-9mq7)', () => {
    const inherited = Object.create({ trust: true })
    const html = katex.renderToString('\\href{javascript:alert(1)}{x}', inherited)
    expect(html).not.toContain('href="javascript:')
    expect(katex.renderToString('x^2 + y^2')).toContain('katex')
    expect(katex.renderToString('\\href{https://example.test}{x}', { trust: true })).toContain('href="https://example.test"')
  })

  it('embeds patched KaTeX instead of the version inside the prebuilt Mermaid UMD', () => {
    expect(MERMAID_FRAME_HTML).toContain('0.18.2')
    expect(MERMAID_FRAME_HTML).not.toContain('0.16.47')
  })

  it('initializes the rebuilt browser IIFE and parses a normal diagram offline', async () => {
    const dom = new JSDOM(MERMAID_FRAME_HTML, { runScripts: 'dangerously' })
    try {
      const mermaid = (dom.window as unknown as { mermaid: { parse: (input: string) => Promise<unknown> } }).mermaid
      expect(typeof mermaid.parse).toBe('function')
      await expect(mermaid.parse('flowchart TD\nA-->B')).resolves.toBeTruthy()
    } finally { dom.window.close() }
  })
})
