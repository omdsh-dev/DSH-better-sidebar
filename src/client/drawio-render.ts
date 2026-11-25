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

/**
 * Convert an HTML label to plain text.
 *
 * `DOMParser` builds an inert document: no script runs, no image loads, so a
 * hostile label cannot do anything while it is being defused.
 * @param html - the cell label as stored in the file.
 * @returns the label's text content.
 */
function labelText(html: string): string {
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/giu, '\n'), 'text/html')
  return (doc.body.textContent ?? '').replace(/\u00a0/gu, ' ')
}

/**
 * Remove the two ways a diagram file can reach out of an inert image.
 *
 * maxGraph renders `html=1` labels by assigning their markup to `innerHTML` in a
 * container attached to the live page, where an `<img onerror=…>` label would
 * run in the app's origin — an origin that can call the local session RPC. The
 * styles `image=…` would also make the browser fetch a remote URL while the
 * diagram is being measured. Both are turned off before the graph is refreshed:
 * labels become text, and a remote image style is dropped.
 * @param model - the imported diagram model, mutated in place.
 */
function defuseModel(model: { cells?: Record<string, unknown>; setStyle?: (cell: unknown, style: string) => void }): void {
  const cells = Object.values(model.cells ?? {})
  for (const cell of cells) {
    const entry = cell as { value?: unknown; style?: unknown }
    if (typeof entry.value === 'string' && entry.value.includes('<')) {
      entry.value = labelText(entry.value)
    } else if (
      entry.value !== null &&
      typeof entry.value === 'object' &&
      typeof (entry.value as { label?: unknown }).label === 'string'
    ) {
      // `<UserObject label="…">` wrapping keeps the label on a value object.
      const wrapped = entry.value as { label: string }
      if (wrapped.label.includes('<')) wrapped.label = labelText(wrapped.label)
    }
    if (typeof entry.style !== 'string') continue
    let style = entry.style.replace(/(^|;)html=1(?=;|$)/gu, '$1html=0')
    style = style.replace(/(^|;)image=([^;]*)(?=;|$)/gu, (_match, lead: string, url: string) =>
      /^\s*data:/iu.test(decodeURIComponent(url)) ? _match : `${lead}image=none`,
    )
    if (style !== entry.style) model.setStyle?.(cell, style)
  }
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
    defuseModel(graph.getDataModel() as unknown as { cells?: Record<string, unknown>; setStyle?: (cell: unknown, style: string) => void })
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
