/**
 * Structured content inside the unified window host (S6): S1's
 * `ClueFormatRenderer` is the only presentation path for a source's data. The
 * host forwards the ORIGINAL document value (never a Markdown conversion),
 * the read-only/saving state and the source-owned change/save callbacks.
 * Unknown formats stay read-only: summary + raw JSON, no generic save.
 *
 * The late-registration case uses a STATEFUL renderer on purpose: rendering a
 * renderer by calling it as a plain function puts its hooks on the host's
 * fiber and throws "Rendered more hooks than during the previous render".
 * `createElement` keeps the renderer its own component (its own fiber).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useState, type ReactNode } from 'react'
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

/** Type into a textarea through the native setter + input event React listens for. */
function typeInto(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
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

/** Open one structured document and return its handle. */
function openDocument(options: {
  id: string
  title: string
  format: string
  data: unknown
  readOnly?: boolean
  saving?: boolean
  saved?: boolean
  loading?: boolean
  error?: string
  onChange?: (data: unknown) => void
  onSave?: () => void
  saveOnWindow?: boolean
}) {
  let handle!: ReturnType<WindowHostController['open']>
  act(() => {
    handle = host!.open({
      id: options.id,
      title: options.title,
      ...(options.saveOnWindow === true ? { saving: true } : {}),
      content: {
        kind: 'document',
        sourceId: 'test.docs',
        typeId: 'test.docs.blocks',
        format: options.format,
        document: { format: options.format, data: options.data as never },
        ...(options.readOnly === true ? { readOnly: true } : {}),
        ...(options.saving === true ? { saving: true } : {}),
        ...(options.saved === true ? { saved: true } : {}),
        ...(options.loading === true ? { loading: true } : {}),
        ...(options.error === undefined ? {} : { error: options.error }),
        ...(options.onChange === undefined ? {} : { onChange: options.onChange as never }),
        ...(options.onSave === undefined ? {} : { onSave: options.onSave }),
      },
    })
  })
  return handle
}

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
    openDocument({
      id: 'doc',
      title: 'Doc',
      format: 'application/x-test-blocks',
      data,
      saving: true,
      onChange,
      onSave,
    })
    expect(frame('Doc').querySelector('[data-test-format]')).not.toBeNull()
    // The shell and the renderer see the SAME save-in-flight state.
    expect(frame('Doc').querySelector('[data-window-saving]')).not.toBeNull()
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
  })

  it('merges a window-level saving flag into what the renderer receives', () => {
    const seen: ClueFormatRendererProps[] = []
    registry!.registerFormatRenderer('application/x-window-saving', (props) => {
      seen.push(props)
      return createElement('div', null, 'saving')
    })
    openDocument({
      id: 'window-saving', title: 'Window saving', format: 'application/x-window-saving', data: { n: 1 }, saveOnWindow: true,
    })
    expect(frame('Window saving').querySelector('[data-window-saving]')).not.toBeNull()
    expect(seen[seen.length - 1]!.saving).toBe(true)
  })

  it('merges a pushed page-level saving flag into the same answer', () => {
    const seen: ClueFormatRendererProps[] = []
    registry!.registerFormatRenderer('application/x-page-saving', (props) => {
      seen.push(props)
      return createElement('div', null, 'page saving')
    })
    const handle = openDocument({
      id: 'page-saving', title: 'Page saving', format: 'application/x-page-saving', data: { n: 1 },
    })
    act(() => {
      handle.navigation.push({
        title: 'Page saving 2',
        saving: true,
        content: {
          kind: 'document',
          sourceId: 'test.docs',
          typeId: 'test.docs.blocks',
          format: 'application/x-page-saving',
          document: { format: 'application/x-page-saving', data: { n: 2 } },
        },
      })
    })
    expect(frame('Page saving 2').querySelector('[data-window-saving]')).not.toBeNull()
    expect(seen[seen.length - 1]!.saving).toBe(true)
  })

  it('renders a STATEFUL renderer registered after mount (its hooks get their own fiber)', () => {
    function LateRenderer(props: ClueFormatRendererProps): ReactNode {
      const [clicks, setClicks] = useState(0)
      return createElement('button', {
        type: 'button',
        'data-late': '',
        onClick: () => { setClicks(value => value + 1) },
      }, `late ${clicks} ${props.format}`)
    }
    openDocument({
      id: 'unknown', title: 'Unknown', format: 'application/x-late-format', data: { blocks: [{ kind: 'table' }] },
    })
    expect(frame('Unknown').querySelector('[data-window-unknown-format]')).not.toBeNull()
    act(() => {
      registry!.registerFormatRenderer('application/x-late-format', LateRenderer)
    })
    expect(frame('Unknown').querySelector('[data-window-unknown-format]')).toBeNull()
    const button = frame('Unknown').querySelector('[data-late]') as HTMLButtonElement
    expect(button.textContent).toBe('late 0 application/x-late-format')
    act(() => { button.click() })
    expect(button.textContent).toBe('late 1 application/x-late-format')
  })

  it('follows the registry disposer: the fallback returns, and re-registration works', () => {
    const renderer: ClueFormatRenderer = () => createElement('div', { 'data-disposable': '' }, 'live')
    let dispose!: () => void
    act(() => { dispose = registry!.registerFormatRenderer('application/x-disposable', renderer) })
    openDocument({ id: 'live', title: 'Live', format: 'application/x-disposable', data: { text: 'x' } })
    expect(frame('Live').querySelector('[data-disposable]')).not.toBeNull()
    act(() => { dispose() })
    expect(frame('Live').querySelector('[data-disposable]')).toBeNull()
    expect(frame('Live').querySelector('[data-window-unknown-format]')).not.toBeNull()
    act(() => { registry!.registerFormatRenderer('application/x-disposable', renderer) })
    expect(frame('Live').querySelector('[data-disposable]')).not.toBeNull()
  })

  it('shows a read-only badge for a registered renderer too', () => {
    const seen: ClueFormatRendererProps[] = []
    registry!.registerFormatRenderer('application/x-read-only', (props) => {
      seen.push(props)
      return createElement('div', null, 'viewer')
    })
    openDocument({
      id: 'readonly', title: 'Read only', format: 'application/x-read-only', data: { n: 1 }, readOnly: true,
    })
    expect(frame('Read only').querySelector('[data-window-read-only]')).not.toBeNull()
    expect(seen[seen.length - 1]!.readOnly).toBe(true)
  })

  it('shows the explicit saved state until a save starts again', () => {
    const handle = openDocument({
      id: 'saved', title: 'Saved', format: 'text/plain', data: { text: 'body' }, saved: true,
    })
    expect(frame('Saved').querySelector('[data-window-saved]')?.textContent).toBe('已保存')
    act(() => { handle.update({ saving: true }) })
    expect(frame('Saved').querySelector('[data-window-saved]')).toBeNull()
  })

  it('shows a read-only raw summary for an unregistered format and upgrades when a renderer arrives', () => {
    const data = { blocks: [{ kind: 'table', rows: [[1, 2]] }] }
    openDocument({ id: 'unknown-raw', title: 'Unknown raw', format: 'application/x-late-format', data })
    const fallback = frame('Unknown raw').querySelector('[data-window-unknown-format]') as HTMLElement
    expect(fallback).not.toBeNull()
    expect(fallback.textContent).toContain('application/x-late-format')
    expect(fallback.querySelector('[data-window-raw]')?.textContent).toContain('"rows"')
    // No generic save affordance exists for an unknown structure.
    expect(frame('Unknown raw').querySelector('[data-window-footer]')).toBeNull()
    expect([...frame('Unknown raw').querySelectorAll('button')].some(button => button.textContent?.includes('保存')))
      .toBe(false)
  })

  it('renders explicit loading and source error states in the same surface', () => {
    openDocument({
      id: 'state',
      title: 'State',
      format: 'application/x-state-format',
      data: { blocks: [] },
      loading: true,
      error: 'save conflict: reread the source',
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

describe('window text/markdown carrier', () => {
  it('edits text/plain in place and sends the merged source data back', () => {
    const onChange = vi.fn()
    openDocument({
      id: 'plain-text',
      title: 'Plain text',
      format: 'text/plain',
      data: { text: 'hello', revisionNote: 'keep me' },
      onChange,
    })
    const editor = frame('Plain text').querySelector('[data-window-text-editor]') as HTMLTextAreaElement
    expect(editor).not.toBeNull()
    expect(editor.value).toBe('hello')
    expect(frame('Plain text').querySelector('[data-window-unknown-format]')).toBeNull()
    act(() => { typeInto(editor, 'hello world') })
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange.mock.calls[0]![0]).toEqual({ text: 'hello world', revisionNote: 'keep me' })
  })

  it('edits text/markdown through the same carrier', () => {
    const onChange = vi.fn()
    openDocument({
      id: 'md-text', title: 'Markdown', format: 'text/markdown', data: { text: '# title' }, onChange,
    })
    const editor = frame('Markdown').querySelector('[data-window-text-editor]') as HTMLTextAreaElement
    expect(editor.value).toBe('# title')
    act(() => { typeInto(editor, '# edited') })
    expect(onChange.mock.calls[0]![0]).toEqual({ text: '# edited' })
  })

  it('shows a read-only block instead of an editor for a preview document', () => {
    openDocument({
      id: 'preview', title: 'Preview', format: 'text/plain', data: { text: 'read me' }, readOnly: true,
    })
    expect(frame('Preview').querySelector('[data-window-text-editor]')).toBeNull()
    expect(frame('Preview').querySelector('[data-window-text-read-only]')?.textContent).toBe('read me')
    expect(frame('Preview').querySelector('[data-window-read-only]')).not.toBeNull()
  })
})

describe('per-window render containment', () => {
  it('keeps the other windows and the crashed window chrome alive when a renderer throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    registry!.registerFormatRenderer('application/x-boom', () => {
      throw new Error('renderer exploded')
    })
    openDocument({ id: 'boom', title: 'Boom', format: 'application/x-boom', data: { n: 1 } })
    act(() => {
      host!.open({ id: 'safe', title: 'Safe', content: createElement('p', { 'data-safe': '' }, 'still here') })
    })
    const boom = frame('Boom')
    expect(boom.textContent).toContain('renderer exploded')
    // The crash did not replace the whole host: the sibling window and the
    // crashed window's own close control are still there.
    expect(frame('Safe').querySelector('[data-safe]')?.textContent).toBe('still here')
    expect(boom.querySelector('button[aria-label="关闭"]')).not.toBeNull()
    spy.mockRestore()
  })
})
