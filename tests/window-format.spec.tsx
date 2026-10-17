/**
 * Structured content inside the unified window host (S6): S1's
 * `ClueFormatRenderer` is the only presentation path for a source's data. The
 * host forwards the ORIGINAL document value (never a Markdown conversion),
 * the read-only/saving state and the source-owned change/save callbacks.
 * Unknown formats stay read-only: summary + raw JSON, no generic save.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
import { WindowHost } from '../src/client/windows/WindowHost.tsx'
import { createWindowHost } from '../src/client/windows/host.ts'
import type { WindowHostController } from '../src/client/windows/types.ts'
import { createCluesClientRegistry } from '../src/client/clues/registry.ts'
import type { BetterSidebarCluesClientFace } from '../src/client/clues/registry.ts'
import type { ClueFormatRenderer, ClueFormatRendererProps } from '../src/clues/types.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'

setupReactAct()

const VIEWPORT = { width: 1_000, height: 800 }

function frame(title: string): HTMLElement {
  const node = [...document.querySelectorAll<HTMLElement>('[data-floating-window]')]
    .find(candidate => candidate.getAttribute('aria-label') === title)
  if (node === undefined) throw new Error(`no floating window titled "${title}"`)
  return node
}

let host: WindowHostController | undefined
let mounted: RenderedRoot | undefined
let registry: BetterSidebarCluesClientFace | undefined

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height })
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
  registry = createCluesClientRegistry(() => SIDEBAR_PREFS_DEFAULTS)
  host = createWindowHost({ viewport: () => VIEWPORT })
  mounted = renderRoot(createElement(WindowHost, { host, formats: registry }))
})

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  host?.dispose()
  host = undefined
  registry = undefined
  document.body.innerHTML = ''
})

describe('window format renderer seat', () => {
  it('passes the original structured document, read-only/saving state and the source callbacks', () => {
    const seen: ClueFormatRendererProps[] = []
    const renderer: ClueFormatRenderer = (props) => {
      seen.push(props)
      return createElement('div', { 'data-test-format': '' }, 'rendered')
    }
    registry!.registerFormatRenderer('application/x-test-blocks', renderer)
    const data = { blocks: [{ kind: 'heading', text: 'not markdown' }], revisionNote: 'r1' }
    const onChange = vi.fn()
    const onSave = vi.fn()
    let handle!: ReturnType<WindowHostController['open']>
    act(() => {
      handle = host!.open({
        id: 'doc',
        title: 'Doc',
        content: {
        kind: 'document',
        sourceId: 'test.docs',
        typeId: 'test.docs.blocks',
        format: 'application/x-test-blocks',
        document: { format: 'application/x-test-blocks', data, baseRevision: 'r1' },
        readOnly: false,
        saving: true,
          onChange,
          onSave,
        },
      })
    })
    expect(frame('Doc').querySelector('[data-test-format]')).not.toBeNull()
    // The host may render more than once while the layer registers its z slot;
    // every render must see the SAME original document.
    expect(seen.length).toBeGreaterThanOrEqual(1)
    const props = seen[seen.length - 1]!
    expect(props.document.data).toBe(data)
    expect(props.document.data).toEqual(data)
    expect(props.readOnly).toBe(false)
    expect(props.saving).toBe(true)
    expect(props.sourceId).toBe('test.docs')
    expect(props.typeId).toBe('test.docs.blocks')
    // The renderer's change/save callbacks are the source's own callbacks.
    props.onChange({ ...data, blocks: [{ kind: 'heading', text: 'edited' }] })
    props.onSave?.()
    expect(onChange).toHaveBeenCalledOnce()
    expect((onChange.mock.calls[0]![0] as typeof data).blocks[0]!.text).toBe('edited')
    expect(onSave).toHaveBeenCalledOnce()
    void handle
  })

  it('shows a read-only raw summary for an unregistered format and upgrades when a renderer arrives', () => {
    const data = { blocks: [{ kind: 'table', rows: [[1, 2]] }] }
    act(() => {
      host!.open({
        id: 'unknown',
        title: 'Unknown',
        content: {
        kind: 'document',
        sourceId: 'test.docs',
        typeId: 'test.docs.blocks',
        format: 'application/x-late-format',
          document: { format: 'application/x-late-format', data },
        },
      })
    })
    const fallback = frame('Unknown').querySelector('[data-window-unknown-format]') as HTMLElement
    expect(fallback).not.toBeNull()
    expect(fallback.textContent).toContain('application/x-late-format')
    expect(fallback.querySelector('[data-window-raw]')?.textContent).toContain('"rows"')
    // No generic save affordance exists for an unknown structure.
    expect(frame('Unknown').querySelector('[data-window-footer]')).toBeNull()
    expect([...frame('Unknown').querySelectorAll('button')].some(button => button.textContent?.includes('保存')))
      .toBe(false)

    act(() => {
      registry!.registerFormatRenderer('application/x-late-format', () => createElement('div', null, 'late renderer'))
    })
    expect(frame('Unknown').querySelector('[data-window-unknown-format]')).toBeNull()
    expect(frame('Unknown').textContent).toContain('late renderer')
  })

  it('renders explicit loading and source error states in the same surface', () => {
    act(() => {
      host!.open({
        id: 'state',
        title: 'State',
        content: {
          kind: 'document',
          sourceId: 'test.docs',
          typeId: 'test.docs.blocks',
          format: 'application/x-state-format',
          document: { format: 'application/x-state-format', data: { blocks: [] } },
          loading: true,
          error: 'save conflict: reread the source',
        },
      })
    })
    expect(frame('State').querySelector('[data-window-loading]')?.textContent).toBe('加载中…')
    expect(frame('State').querySelector('[data-window-error]')?.textContent).toBe('save conflict: reread the source')
    // No registered renderer: the status + read-only summary still render.
    expect(frame('State').querySelector('[data-window-unknown-format]')).not.toBeNull()
  })

  it('renders a plain React node content unchanged', () => {
    act(() => {
      host!.open({ id: 'plain', title: 'Plain', content: createElement('p', { 'data-plain': '' }, 'hello') })
    })
    expect(frame('Plain').querySelector('[data-plain]')?.textContent).toBe('hello')
  })
})
