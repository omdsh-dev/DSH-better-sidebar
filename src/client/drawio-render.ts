/**
 * maxGraph-backed draw.io renderer. The engine lays the diagram out in an
 * offscreen container and the resulting SVG is serialized to a `data:` URL:
 * the viewer then mounts an inert `<img>` and carries no engine handle.
 *
 * `setEnabled(false)` removes maxGraph's interaction handlers, so the
 * serialized output is read-only. Images referenced by a diagram are still
 * resolved by the browser from their original URLs; the caller's `<img>`
 * uses `referrerPolicy="no-referrer"` to avoid leaking the page URL.
 */
import { Graph, ModelXmlSerializer, Stylesheet } from '@maxgraph/core'

/** Padding around the diagram bounds so strokes and labels are not clipped. */
const VIEW_PADDING = 8
/** Minimum dimensions for an empty diagram. */
const MIN_SIZE = 1

/** The rendered SVG and its intrinsic dimensions in diagram units. */
export interface DrawioSvg {
  url: string
  width: number
  height: number
}

/** Build the defaults draw.io uses for an unstyled vertex or edge. */
function createDrawioStylesheet(): Stylesheet {
  const stylesheet = new Stylesheet()
  const vertex = stylesheet.getDefaultVertexStyle()
  vertex.fillColor = '#dae8fc'
  vertex.strokeColor = '#6c8ebf'
  vertex.fontColor = '#333333'
  vertex.fontSize = 12
  stylesheet.putDefaultVertexStyle(vertex)
  const edge = stylesheet.getDefaultEdgeStyle()
  edge.strokeColor = '#6c8ebf'
  edge.fontColor = '#333333'
  edge.fontSize = 11
  edge.endArrow = 'block'
  stylesheet.putDefaultEdgeStyle(edge)
  return stylesheet
}

/**
 * Render one normalized draw.io model to a self-contained SVG data URL.
 * @param xml - `<mxGraphModel>` XML returned by {@link decodeDrawio}.
 * @returns the SVG source URL and its rendered size.
 * @throws when maxGraph cannot decode or lay out the document.
 */
export function renderDrawioSvg(xml: string): DrawioSvg {
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;'
  document.body.appendChild(container)

  let graph: Graph | undefined
  try {
    graph = new Graph(container, undefined, undefined, createDrawioStylesheet())
    graph.setEnabled(false)
    new ModelXmlSerializer(graph.getDataModel()).import(xml)
    graph.getView().validate()
    graph.refresh()

    const svg = container.querySelector('svg')
    if (svg === null) throw new Error('drawio: renderer produced no SVG')
    const bounds = graph.getView().getGraphBounds()
    const width = Math.max(MIN_SIZE, Math.ceil(bounds.width + VIEW_PADDING * 2))
    const height = Math.max(MIN_SIZE, Math.ceil(bounds.height + VIEW_PADDING * 2))
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))
    svg.setAttribute('viewBox', `${bounds.x - VIEW_PADDING} ${bounds.y - VIEW_PADDING} ${width} ${height}`)
    svg.removeAttribute('style')

    const markup = new XMLSerializer().serializeToString(svg)
    return {
      url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`,
      width,
      height,
    }
  } finally {
    try { graph?.destroy() } catch { /* maxGraph teardown is best-effort */ }
    container.remove()
  }
}
