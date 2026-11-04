/**
 * The mermaid frame boundary: a diagram that mermaid itself rejects is a
 * per-diagram error (only its block falls back to the source), while frame
 * load/handshake/timeout failures retry once and then trip a page-level
 * fast-fail breaker. The postMessage bridge is identity- and shape-validated on
 * both sides.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MermaidDiagramError,
  MermaidFrameError,
  acceptFrameMessage,
  renderMermaidDiagram,
  resetMermaidFrameForTests,
  setMermaidFrameTransportForTests,
} from '../src/client/mermaid-frame.ts'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><text>OK</text></svg>'

beforeEach(() => { resetMermaidFrameForTests() })
afterEach(() => { resetMermaidFrameForTests() })

describe('renderMermaidDiagram failure classes', () => {
  it('keeps rendering the rest of the document after one diagram is rejected', async () => {
    const transport = vi.fn()
      .mockRejectedValueOnce(new MermaidDiagramError('Parse error on line 1'))
      .mockResolvedValueOnce(SVG)
    setMermaidFrameTransportForTests(transport)

    await expect(renderMermaidDiagram('bad', 'default')).rejects.toBeInstanceOf(MermaidDiagramError)
    await expect(renderMermaidDiagram('good', 'default')).resolves.toBe(SVG)
    // A diagram error is final for that diagram: no retry, no breaker.
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('retries a transport failure once and recovers', async () => {
    const transport = vi.fn()
      .mockRejectedValueOnce(new MermaidFrameError('frame did not become ready'))
      .mockResolvedValueOnce(SVG)
    setMermaidFrameTransportForTests(transport)

    await expect(renderMermaidDiagram('graph TD', 'default')).resolves.toBe(SVG)
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('breaks the page only after two transport failures, not after a diagram error', async () => {
    const transport = vi.fn().mockRejectedValue(new MermaidFrameError('frame died'))
    setMermaidFrameTransportForTests(transport)

    await expect(renderMermaidDiagram('graph TD', 'default')).rejects.toBeInstanceOf(MermaidFrameError)
    expect(transport).toHaveBeenCalledTimes(2)
    const callsAfterBreaker = transport.mock.calls.length
    // Fast fail: later diagrams must not pay another timeout/retry.
    await expect(renderMermaidDiagram('graph LR', 'default')).rejects.toBeInstanceOf(MermaidFrameError)
    expect(transport.mock.calls.length).toBe(callsAfterBreaker)
  })
})

describe('acceptFrameMessage', () => {
  const frameWindow = {} as Window
  const event = (overrides: Record<string, unknown> = {}): {
    source: unknown
    origin: string
    data: unknown
  } => ({
    source: frameWindow,
    origin: 'null',
    data: { type: 'mermaid-result', id: 1, svg: SVG },
    ...overrides,
  })

  it('accepts a well-formed result from the frame window', () => {
    expect(acceptFrameMessage(event(), frameWindow)).toEqual({ kind: 'result', id: 1, svg: SVG })
  })

  it('accepts a well-formed diagram error', () => {
    expect(
      acceptFrameMessage(event({ data: { type: 'mermaid-error', id: 2, message: 'Parse error' } }), frameWindow),
    ).toEqual({ kind: 'error', id: 2, message: 'Parse error' })
  })

  it('rejects a message from any window other than the frame', () => {
    expect(acceptFrameMessage(event({ source: {} }), frameWindow)).toBeNull()
    expect(acceptFrameMessage(event(), null)).toBeNull()
  })

  it('rejects a same-shape message from a different origin', () => {
    expect(acceptFrameMessage(event({ origin: 'https://example.com' }), frameWindow)).toBeNull()
  })

  it('rejects malformed payloads', () => {
    const bad = [
      null,
      { type: 'mermaid-result', id: '1', svg: SVG },
      { type: 'mermaid-result', id: 0, svg: SVG },
      { type: 'mermaid-result', id: 1.5, svg: SVG },
      { type: 'mermaid-result', id: 1, svg: 42 },
      { type: 'mermaid-error', id: 1 },
      { type: 'mermaid-frame-ready' },
      { type: 'mermaid-render', id: 1, code: 'graph TD' },
    ]
    for (const data of bad) {
      expect(acceptFrameMessage(event({ data }), frameWindow)).toBeNull()
    }
  })
})
