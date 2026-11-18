/**
 * draw.io file support: the decoder accepts both save forms (plain
 * `<mxGraphModel>` and the compressed `<mxfile><diagram>` body), and maxGraph
 * turns the normalized model into a self-contained SVG. The decoder is pure
 * apart from DOMParser; jsdom supplies it, like the browser does.
 */
// @vitest-environment jsdom
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { DrawioParseError, decodeDrawio, inflateDrawioBody } from '../src/client/drawio.ts'
import { renderDrawioSvg } from '../src/client/drawio-render.ts'

const MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<mxGraphModel dx="900" dy="600" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />
    <mxCell id="a" value="API" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
      <mxGeometry x="40" y="60" width="140" height="60" as="geometry" />
    </mxCell>
  </root>
</mxGraphModel>`

/** Encode exactly like draw.io's compressed save path. */
function compress(xml: string): string {
  return deflateRawSync(Buffer.from(encodeURIComponent(xml))).toString('base64')
}

describe('decodeDrawio', () => {
  it('passes plain mxGraphModel XML through', () => {
    expect(decodeDrawio(MODEL)).toBe(MODEL)
  })

  it('extracts a plain page from an mxfile wrapper', () => {
    const file = `<mxfile host="app.diagrams.net"><diagram id="p1" name="Page-1">${MODEL.replace(/^<\?xml[^>]*>\s*/u, '')}</diagram></mxfile>`
    expect(decodeDrawio(file)).toContain('<mxGraphModel')
    expect(decodeDrawio(file)).not.toContain('<mxfile')
  })

  it('inflates the compressed diagram body of an mxfile', () => {
    const file = `<mxfile host="app.diagrams.net"><diagram id="p1" name="Page-1">${compress(MODEL)}</diagram></mxfile>`
    expect(decodeDrawio(file)).toContain('<mxGraphModel')
    expect(decodeDrawio(file)).toContain('value="API"')
  })

  it('inflates a bare base64 body', () => {
    expect(inflateDrawioBody(compress(MODEL))).toContain('<mxGraphModel')
    expect(decodeDrawio(compress(MODEL))).toContain('<mxGraphModel')
  })

  it('rejects empty, non-XML, and corrupt compressed files', () => {
    expect(() => decodeDrawio('   ')).toThrow(DrawioParseError)
    expect(() => decodeDrawio('not a diagram')).toThrow(DrawioParseError)
    expect(() => decodeDrawio('<mxfile><diagram id="x"></diagram></mxfile>')).toThrow(DrawioParseError)
    expect(() => decodeDrawio('AAAA')).toThrow(DrawioParseError)
  })
})

describe('renderDrawioSvg', () => {
  it('renders the model to a data URL with its intrinsic size', () => {
    const svg = renderDrawioSvg(decodeDrawio(MODEL))
    expect(svg.url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(decodeURIComponent(svg.url)).toContain('<svg')
    expect(decodeURIComponent(svg.url)).toContain('API')
    expect(svg.width).toBeGreaterThan(0)
    expect(svg.height).toBeGreaterThan(0)
  })
})
