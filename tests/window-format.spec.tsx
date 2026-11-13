/**
 * Structured content inside the unified window host (S6): S1's
 * `ClueFormatRenderer` is the only presentation path for a source's data. The
 * host forwards the ORIGINAL document value (never a Markdown conversion),
 * the read-only/saving state and the source-owned change/save callbacks.
 * Unknown formats stay read-only: summary + raw JSON, no generic save.
 * A caller may control the preview/edit mode (`mode` + `onModeChange`) and
 * supply a fixed `header`; `embedded` lets a source renderer drop its own
 * duplicate title/source chrome. The Edit tab is offered from a read-only
 * PREVIEW only when the caller defines `onModeChange` (lazy edit load).
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
import type { WindowDocumentContent, WindowHostController } from '../src/client/windows/types.ts'
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
  presentation?: 'modes'
  saving?: boolean
  saved?: boolean
  loading?: boolean
  error?: string
  mode?: 'preview' | 'edit'
  editLoading?: boolean
  embedded?: boolean
  header?: ReactNode
  onModeChange?: (mode: 'preview' | 'edit') => void
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
        ...(options.presentation === undefined ? {} : { presentation: options.presentation }),
        ...(options.saving === true ? { saving: true } : {}),
        ...(options.saved === true ? { saved: true } : {}),
        ...(options.loading === true ? { loading: true } : {}),
        ...(options.error === undefined ? {} : { error: options.error }),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.editLoading === true ? { editLoading: true } : {}),
        ...(options.embedded === true ? { embedded: true } : {}),
        ...(options.header === undefined ? {} : { header: options.header }),
        ...(options.onModeChange === undefined ? {} : { onModeChange: options.onModeChange }),
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
    expect(frame('State').querySelector('[data-window-loading] [data-loading-indicator] svg')).not.toBeNull()
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

describe('window preview/edit modes', () => {
  it('defaults to preview and keeps the draft, editor selection and scroll when switching', () => {
    const onChange = (data: unknown): void => {
      const previous = host!.getSnapshot().windows[0]!.content as WindowDocumentContent
      handle.update({ content: { ...previous, document: { ...previous.document, data: data as never }, saved: false } })
    }
    const handle = openDocument({
      id: 'modes-md', title: 'Markdown modes', format: 'text/markdown', presentation: 'modes',
      data: { text: '# Before', sourceField: 'preserve' }, onChange, saved: true,
    })
    const window = frame('Markdown modes')
    expect(window.querySelector('[data-window-document]')?.firstElementChild?.querySelector('[role="tablist"]')).not.toBeNull()
    const preview = window.querySelector<HTMLElement>('[data-window-document-preview]')!
    const editorPanel = window.querySelector<HTMLElement>('[data-window-document-editor]')!
    const editor = window.querySelector<HTMLTextAreaElement>('[data-window-text-editor]')!
    const previewTab = window.querySelector<HTMLButtonElement>('[data-window-mode-tab="preview"]')!
    const editTab = window.querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!
    const visiblePanels = (): number => window.querySelectorAll('[data-window-document-modes] > :not([hidden])').length
    expect(preview.hidden).toBe(false)
    expect(editorPanel.hidden).toBe(true)
    expect(preview.querySelector('h1')?.textContent).toBe('Before')
    expect(visiblePanels()).toBe(1)
    expect(previewTab.getAttribute('aria-selected')).toBe('true')
    act(() => { editTab.click() })
    expect(preview.hidden).toBe(true)
    expect(editorPanel.hidden).toBe(false)
    expect(visiblePanels()).toBe(1)
    act(() => { typeInto(editor, '# After\n\n**Live** draft') })
    editor.setSelectionRange(3, 8, 'backward')
    editor.scrollTop = 93
    editorPanel.scrollTop = 27
    act(() => { previewTab.click() })
    expect(preview.hidden).toBe(false)
    expect(editorPanel.hidden).toBe(true)
    expect(preview.querySelector('h1')?.textContent).toBe('After')
    expect(preview.querySelector('strong')?.textContent).toBe('Live')
    act(() => { editTab.click() })
    expect(window.querySelector('[data-window-text-editor]')).toBe(editor)
    expect(editor.value).toBe('# After\n\n**Live** draft')
    expect([editor.selectionStart, editor.selectionEnd, editor.selectionDirection]).toEqual([3, 8, 'backward'])
    expect(editor.scrollTop).toBe(93)
    expect(editorPanel.scrollTop).toBe(27)
    expect((host!.getSnapshot().windows[0]!.content as WindowDocumentContent).document.data)
      .toEqual({ text: '# After\n\n**Live** draft', sourceField: 'preserve' })
    act(() => { handle.update({ saving: true }) })
    act(() => { handle.update({ saving: false }) })
    expect(editTab.getAttribute('aria-selected')).toBe('true')
    expect(editorPanel.hidden).toBe(false)
    expect(visiblePanels()).toBe(1)
  })

  it('uses one tab stop and supports arrow, Home and End activation with linked panels', () => {
    openDocument({ id: 'keys', title: 'Mode keys', format: 'text/markdown', presentation: 'modes', data: '# Keys' })
    const window = frame('Mode keys')
    const preview = window.querySelector<HTMLButtonElement>('[data-window-mode-tab="preview"]')!
    const edit = window.querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!
    const selected = (): HTMLButtonElement => window.querySelector('[role="tab"][aria-selected="true"]')!
    const press = (key: string): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      act(() => { selected().dispatchEvent(event) })
      return event
    }
    expect(window.querySelector('[role="tablist"]')?.getAttribute('aria-orientation')).toBe('horizontal')
    expect([preview.tabIndex, edit.tabIndex]).toEqual([0, -1])
    preview.focus()
    expect(press('ArrowRight').defaultPrevented).toBe(true)
    expect(selected()).toBe(edit)
    expect(document.activeElement).toBe(edit)
    expect([preview.tabIndex, edit.tabIndex]).toEqual([-1, 0])
    const editPanel = document.getElementById(edit.getAttribute('aria-controls')!)!
    expect(editPanel.getAttribute('aria-labelledby')).toBe(edit.id)
    expect(editPanel.getAttribute('role')).toBe('tabpanel')
    expect(editPanel.hidden).toBe(false)
    expect(press('Tab').defaultPrevented).toBe(false)
    press('ArrowRight')
    expect(selected()).toBe(preview)
    press('ArrowLeft')
    expect(selected()).toBe(edit)
    press('Home')
    expect(selected()).toBe(preview)
    press('End')
    expect(selected()).toBe(edit)
  })

  it('keeps source preview and editor instances over the same data while showing one at a time', () => {
    const seen = new Map<boolean, ClueFormatRendererProps>()
    registry!.registerFormatRenderer('application/x-source-modes', props => {
      seen.set(props.readOnly, props)
      return createElement('div', { 'data-source-mode': props.readOnly ? 'preview' : 'editor' },
        JSON.stringify(props.document.data))
    })
    const data = { blocks: [{ text: 'source-owned' }] }
    const onSave = vi.fn()
    const onChange = vi.fn()
    openDocument({ id: 'source-modes', title: 'Source modes', format: 'application/x-source-modes', data,
      presentation: 'modes', onSave, onChange })
    const window = frame('Source modes')
    expect(window.querySelectorAll('[data-source-mode]')).toHaveLength(2)
    expect(window.querySelector('[data-source-mode="editor"]')?.closest('[hidden]')).not.toBeNull()
    expect(window.querySelector('[data-source-mode="preview"]')?.closest('[hidden]')).toBeNull()
    expect(seen.get(true)?.document).toBe(seen.get(false)?.document)
    expect(seen.get(true)?.document.data).toBe(data)
    expect(seen.get(true)?.onSave).toBeUndefined()
    seen.get(true)!.onChange({ blocks: [] })
    expect(onChange).not.toHaveBeenCalled()
    act(() => { window.querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!.click() })
    expect(window.querySelector('[data-source-mode="editor"]')?.closest('[hidden]')).toBeNull()
    expect(window.querySelector('[data-source-mode="preview"]')?.closest('[hidden]')).not.toBeNull()
    seen.get(false)!.onChange({ blocks: [{ text: 'edited' }] })
    seen.get(false)!.onSave?.()
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ blocks: [{ text: 'edited' }] })
    expect(onSave).toHaveBeenCalledOnce()
  })

  it('omits editing entirely for read-only documents', () => {
    openDocument({ id: 'readonly-modes', title: 'Read-only modes', format: 'text/markdown',
      presentation: 'modes', readOnly: true, data: { text: '# Read only' } })
    const window = frame('Read-only modes')
    expect(window.querySelector('[data-window-mode-tab="edit"]')).toBeNull()
    expect(window.querySelector('[data-window-document-editor]')).toBeNull()
    expect(window.querySelector('textarea')).toBeNull()
    expect(window.querySelector('[data-window-document-preview] h1')?.textContent).toBe('Read only')
    expect(window.querySelector<HTMLElement>('[data-window-document-preview]')?.hidden).toBe(false)
    expect(window.querySelector('[data-window-read-only]')).not.toBeNull()
  })

  it('offers a controlled Edit from a read-only preview and renders the lazy edit state', () => {
    const modes: string[] = []
    const handle = openDocument({
      id: 'lazy-edit', title: 'Lazy edit', format: 'text/markdown', presentation: 'modes',
      readOnly: true, mode: 'preview', data: { text: '# Preview' },
      onModeChange: mode => { modes.push(mode) },
    })
    const window = frame('Lazy edit')
    const editTab = window.querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!
    expect(editTab).not.toBeNull()
    expect(window.querySelector('[data-window-read-only]')).toBeNull()
    act(() => { editTab.click() })
    expect(modes).toEqual(['edit'])
    const previous = host!.getSnapshot().windows[0]!.content as WindowDocumentContent
    // The caller takes responsibility for the lazy load; the host shows a
    // fixed edit-pane loading mark instead of an editor over preview bytes.
    act(() => {
      handle.update({ content: { ...previous, mode: 'edit', editLoading: true } })
    })
    expect(window.querySelector('[data-window-edit-loading]')).not.toBeNull()
    expect(window.querySelector('[data-window-text-editor]')).toBeNull()
    const loading = host!.getSnapshot().windows[0]!.content as WindowDocumentContent
    act(() => {
      handle.update({
        content: {
          ...loading,
          mode: 'edit',
          editLoading: false,
          readOnly: false,
          document: { ...loading.document, data: { text: '# Loaded draft' } as never },
        },
      })
    })
    expect(window.querySelector<HTMLTextAreaElement>('[data-window-text-editor]')?.value).toBe('# Loaded draft')
    expect(window.querySelector('[data-window-mode-tab="edit"]')?.getAttribute('aria-selected')).toBe('true')
  })

  it('keeps the caller header above the mode bar and out of the scrolling body', () => {
    openDocument({
      id: 'header', title: 'Header', format: 'text/markdown', presentation: 'modes',
      data: { text: '# Body' },
      header: createElement('div', { 'data-test-header': '' }, 'Metadata header'),
    })
    const window = frame('Header')
    const header = window.querySelector<HTMLElement>('[data-window-document-header]')!
    expect(header.textContent).toBe('Metadata header')
    expect(header.compareDocumentPosition(window.querySelector('[data-window-mode-tab="preview"]')!)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(header.closest('[data-window-document-modes]')).toBeNull()
  })

  it('passes the embedded presentation flag to a source renderer', () => {
    const seen: Array<{ embedded?: boolean }> = []
    registry!.registerFormatRenderer('application/x-embedded', props => {
      seen.push(props as unknown as { embedded?: boolean })
      return createElement('div', { 'data-embedded-renderer': '' }, 'body')
    })
    openDocument({
      id: 'embedded', title: 'Embedded', format: 'application/x-embedded',
      data: { x: 1 }, embedded: true,
    })
    expect(seen[seen.length - 1]!.embedded).toBe(true)
  })

  it('keeps a standalone renderer save but routes an embedded Ctrl+Enter to the host', () => {
    const seen: ClueFormatRendererProps[] = []
    const onSave = vi.fn()
    registry!.registerFormatRenderer('application/x-embedded-save', props => {
      seen.push(props)
      return createElement('textarea', {
        'data-embedded-editor': '',
        onChange: (event: { target: { value: string } }) => { props.onChange({ text: event.target.value }) },
      })
    })
    openDocument({
      id: 'embedded-save', title: 'Embedded save', format: 'application/x-embedded-save',
      data: { text: 'draft' }, embedded: true, onSave,
    })
    const embedded = frame('Embedded save')
    // The detail chrome owns Save; the embedded renderer gets no callback and
    // therefore cannot draw a second control.
    expect(seen[seen.length - 1]!.onSave).toBeUndefined()
    act(() => {
      embedded.querySelector('[data-embedded-editor]')!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
      }))
    })
    expect(onSave).toHaveBeenCalledOnce()

    openDocument({
      id: 'standalone-save', title: 'Standalone save', format: 'application/x-embedded-save',
      data: { text: 'draft' }, onSave,
    })
    // Standalone mounts keep the source renderer's own affordance.
    expect(seen[seen.length - 1]!.onSave).toBeTypeOf('function')
  })

  it('offers no edit mode or save path for an unknown format', () => {
    const onChange = vi.fn()
    const onSave = vi.fn()
    openDocument({ id: 'unknown-modes', title: 'Unknown modes', format: 'application/x-unknown',
      presentation: 'modes', data: { opaque: true }, onChange, onSave })
    const window = frame('Unknown modes')
    expect(window.querySelector('[data-window-unknown-format]')).not.toBeNull()
    expect(window.querySelector('[data-window-mode-tab="edit"]')).toBeNull()
    expect(window.querySelector('[data-window-document-editor]')).toBeNull()
    expect(window.querySelector('textarea')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
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
