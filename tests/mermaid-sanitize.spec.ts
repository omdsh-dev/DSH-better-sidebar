/**
 * Mermaid SVG sanitizer security spec: the rendered diagram must never
 * carry an executable surface into the markdown preview — foreignObject
 * (the raw-HTML channel) is stripped wholesale, event/`@*` attributes are
 * removed, href/xlink:href are removed, script elements are removed, and a
 * malformed/foreign document is rejected entirely (empty string) rather
 * than passed through.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeSvg } from '../src/client/mermaid-sanitize.ts'

describe('sanitizeSvg', () => {
  it('keeps a benign diagram (svg + text nodes)', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Hello</text></svg>'
    const out = sanitizeSvg(svg)
    expect(out).toContain('<text>Hello</text>')
    expect(out).not.toContain('foreignObject')
  })

  it('strips foreignObject wholesale (the raw-HTML channel)', () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<foreignObject><div><img src="x" onerror="alert(1)"/></div></foreignObject>',
      '<text>keep</text>',
      '</svg>',
    ].join('')
    const out = sanitizeSvg(svg)
    expect(out).not.toContain('foreignObject')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('onerror')
    expect(out).toContain('<text>keep</text>')
  })

  it('strips on* and @* attributes from every element', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><text onclick="x()" @click="y()">t</text></svg>'
    const out = sanitizeSvg(svg)
    expect(out).not.toContain('onload')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('@click')
  })

  it('strips mixed-case event/link attributes (HTML parsing normalizes case)', () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
      '<text oNload="alert(1)" OnClick="x()">t</text>',
      '<a HREF="javascript:alert(1)" xlink:HREF="data:text/html,<script>1</script>">x</a>',
      '<text @Click="y()">u</text>',
      '</svg>',
    ].join('')
    const out = sanitizeSvg(svg)
    expect(out).not.toContain('oNload')
    expect(out).not.toContain('OnClick')
    expect(out).not.toContain('@Click')
    expect(out).not.toContain('HREF')
    expect(out).not.toContain('xlink:HREF')
    expect(out).not.toContain('javascript:')
  })

  it('removes href and xlink:href regardless of scheme', () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
      '<a href="javascript:alert(1)" xlink:href="data:text/html,<script>1</script>">x</a>',
      '<a href="https://example.com">y</a>',
      '</svg>',
    ].join('')
    const out = sanitizeSvg(svg)
    expect(out).not.toContain('href')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('data:text/html')
  })

  it('removes script elements', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><text>t</text></svg>'
    const out = sanitizeSvg(svg)
    expect(out).not.toContain('script')
    expect(out).toContain('<text>t</text>')
  })

  it('strips mixed-case element names (HTML parsing normalizes tag casing)', () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<sCrIpT>alert(1)</sCrIpT>',
      '<foreignobject><div><img src="x" onerror="alert(1)"/></div></foreignobject>',
      '<ImG src="y" onerror="alert(2)"/>',
      '<iFrAmE src="https://evil.test"/>',
      '<text>keep</text>',
      '</svg>',
    ].join('')
    const out = sanitizeSvg(svg)
    expect(out).not.toContain('sCrIpT')
    expect(out).not.toContain('alert')
    expect(out).not.toContain('foreignobject')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<ImG')
    expect(out).not.toContain('iFrAmE')
    expect(out).not.toContain('onerror')
    expect(out).toContain('<text>keep</text>')
  })

  it('rejects malformed XML instead of passing it through', () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><text>oops</svg>')
    expect(out).toBe('')
  })

  it('strips foreign HTML elements smuggled past lenient parsers', () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><img src="x" onerror="alert(1)"/></svg>')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('onerror')
  })

  it('rejects a non-svg document', () => {
    const out = sanitizeSvg('<html><body onload="alert(1)">hi</body></html>')
    expect(out).toBe('')
  })
})
