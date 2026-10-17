/**
 * S4 Feishu CLIENT contract (node-free renderers, no real account).
 *
 * Pins:
 * - `registerFeishuSourceClient` registers both source displays (with
 *   size-aware, token-only icons) and the three format renderers, and its
 *   disposer removes exactly those registrations (idempotent; a partial
 *   failure cleans up what already succeeded);
 * - docs reads are read-only escaped XML/Markdown text (never HTML) with
 *   freshness/source metadata; a loaded edit payload is a controlled block
 *   editor with a title, block textareas, read-only complex blocks and a save
 *   callback, and Markdown is never a write input;
 * - the task renderer is a controlled form with title/description/start/due/
 *   completed fields, localized errors, distinct all-day/Set-time accessible
 *   names and a disabled save on local validation errors; the read-only mode is
 *   static text with the updated time/source entry;
 * - localized copy arrives through the registration options (S9 owns the
 *   dictionaries), not hardcoded locale files;
 * - the client module and its stylesheet stay node-free and use only
 *   `--dsw-*` / `--ds-*` theme tokens.
 */
// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { act } from 'react-dom/test-utils'
import { describe, expect, it } from 'vitest'
import type {
  ClueEditDocument,
  ClueFormatRenderer,
  ClueFormatRendererProps,
  ClueReadResult,
  ClueSourceDisplayDescriptor,
  JsonValue,
} from '../src/clues/types.ts'
import type { FeishuDocEditData } from '../src/clues/sources/feishu/format.ts'
import {
  FEISHU_FORMATS,
  FEISHU_SOURCE_IDS,
  FEISHU_TYPE_IDS,
  type FeishuTaskDocumentData,
} from '../src/clues/sources/feishu/format.ts'
import {
  registerFeishuSourceClient,
  type FeishuClientRegistrationFace,
} from '../src/client/clues/sources/feishu/index.tsx'
import { DEFAULT_FEISHU_LABELS } from '../src/client/clues/sources/feishu/labels.ts'
import { createCluesClientRegistry } from '../src/client/clues/registry.ts'
import { ClueFormatHost } from '../src/client/windows/format-content.tsx'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

const ROOT = process.cwd()
const NOW = '2026-10-17T00:00:00.000Z'
const GUID = '2f4d8c1e-7a3b-4c5d-9e8f-0123456789ab'

/** One docs read payload. */
function docsRead(content: string, overrides: Partial<ClueReadResult> = {}): ClueReadResult {
  return {
    format: FEISHU_FORMATS.docsXml,
    data: {
      kind: 'docx',
      title: 'Plan',
      projection: 'xml',
      content,
      docToken: 'doccnA',
      revisionId: '12',
    } as unknown as JsonValue,
    fetchedAt: NOW,
    freshness: 'live',
    text: content,
    ...overrides,
  }
}

/** One renderer props fixture. */
function rendererProps(
  document: ClueEditDocument | ClueReadResult,
  overrides: Partial<ClueFormatRendererProps> = {},
): ClueFormatRendererProps {
  return {
    sourceId: FEISHU_SOURCE_IDS.docs,
    typeId: FEISHU_TYPE_IDS.docx,
    format: (document as { format?: string }).format ?? FEISHU_FORMATS.docsXml,
    document,
    readOnly: false,
    saving: false,
    onChange: () => undefined,
    onSave: () => undefined,
    ...overrides,
  }
}

/** One editable task document. */
function taskDocument(overrides: Partial<FeishuTaskDocumentData> = {}): FeishuTaskDocumentData {
  return {
    kind: 'task',
    guid: GUID,
    title: 'Release checklist',
    description: 'Ship the release',
    start: { timestamp: '1700000000000', isAllDay: false },
    due: { timestamp: '1700003600000', isAllDay: false },
    completed: false,
    updatedAt: '1700000001000',
    ...overrides,
  }
}

/** One editable docs payload (shape returned by docs loadEdit). */
function docsEdit(overrides: Partial<FeishuDocEditData> = {}): FeishuDocEditData {
  return {
    kind: 'docx',
    docToken: 'doccnA',
    sourceUrl: 'https://acme.feishu.cn/docx/doccnA',
    revisionId: '12',
    title: 'Plan',
    baselineTitle: 'Plan',
    titleEditable: true,
    titleBlockId: 'blk-title',
    titleAttrs: '',
    blocks: [
      {
        id: 'blk-p1',
        tag: 'p',
        attrs: '',
        text: 'Hello <b>world</b>',
        baseline: 'Hello <b>world</b>',
        kind: 'xml',
        order: 1,
      },
      {
        id: 'blk-pre',
        tag: 'pre',
        attrs: 'lang="ts"',
        text: 'const x = 1',
        baseline: 'const x = 1',
        kind: 'plain',
        order: 3,
      },
    ],
    readOnlyBlocks: [
      {
        tag: 'table',
        attrs: 'id="blk-table"',
        text: 'Cell',
        reason: 'complex container',
        order: 2,
      },
      {
        tag: 'img',
        attrs: 'token="tok" url="https://cdn.example/a.png"',
        text: '',
        reason: 'complex container',
        order: 4,
        url: 'https://cdn.example/a.png',
      },
    ],
    ...overrides,
  }
}

/** One source-display/renderer registry double. */
class FakeFace implements FeishuClientRegistrationFace {
  readonly displays: ClueSourceDisplayDescriptor[] = []
  readonly renderers = new Map<string, ClueFormatRenderer>()
  readonly disposed: string[] = []
  failOnFormat: string | undefined
  failOnDisplay: string | undefined

  registerSourceDisplay(descriptor: ClueSourceDisplayDescriptor): () => void {
    if (this.failOnDisplay === descriptor.sourceId) {
      throw new Error(`[fake] refusing display ${descriptor.sourceId}`)
    }
    this.displays.push(descriptor)
    return () => {
      const index = this.displays.indexOf(descriptor)
      if (index >= 0) this.displays.splice(index, 1)
      this.disposed.push(`display:${descriptor.sourceId}`)
    }
  }

  registerFormatRenderer(format: string, renderer: ClueFormatRenderer): () => void {
    if (this.failOnFormat === format) throw new Error(`[fake] refusing ${format}`)
    this.renderers.set(format, renderer)
    return () => { this.disposed.push(`format:${format}`) }
  }
}

/** Render one registered format renderer to static markup. */
function renderFormat(face: FakeFace, format: string, props: ClueFormatRendererProps): string {
  const renderer = face.renderers.get(format)
  if (renderer === undefined) throw new Error(`missing renderer ${format}`)
  return renderToStaticMarkup(renderer(props) as ReactNode)
}

/** The one serialized tag around a data marker (attribute order independent). */
function tagOf(markup: string, marker: string): string {
  const index = markup.indexOf(marker)
  if (index < 0) throw new Error(`missing marker ${marker}`)
  const start = markup.lastIndexOf('<', index)
  const end = markup.indexOf('>', index)
  return markup.slice(start, end + 1)
}

/** Mount one registered format renderer into jsdom for interaction tests. */
function mountFormat(
  face: FakeFace,
  format: string,
  props: ClueFormatRendererProps,
): {
  readonly container: HTMLElement
  rerender(next: ClueFormatRendererProps): void
  unmount(): void
} {
  const renderer = face.renderers.get(format)
  if (renderer === undefined) throw new Error(`missing renderer ${format}`)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => { root.render(renderer(props) as ReactNode) })
  return {
    container,
    rerender(next) {
      act(() => { root.render(renderer(next) as ReactNode) })
    },
    unmount() {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** Type into one controlled input/textarea and let React observe the event. */
function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
    'value',
  )?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('registration', () => {
  it('registers both source displays and the three format renderers, then disposes exactly them', () => {
    const face = new FakeFace()
    const dispose = registerFeishuSourceClient(face)

    expect(face.displays.map(display => display.sourceId)).toEqual([
      FEISHU_SOURCE_IDS.docs,
      FEISHU_SOURCE_IDS.tasks,
    ])
    expect(face.displays.map(display => display.name)).toEqual(['Feishu docs', 'Feishu tasks'])
    for (const display of face.displays) expect(typeof display.icon).toBe('function')
    expect([...face.renderers.keys()]).toEqual([
      FEISHU_FORMATS.docsXml,
      FEISHU_FORMATS.docsMarkdown,
      FEISHU_FORMATS.taskDocument,
    ])

    dispose()
    expect(face.disposed.sort()).toEqual([
      `display:${FEISHU_SOURCE_IDS.docs}`,
      `display:${FEISHU_SOURCE_IDS.tasks}`,
      `format:${FEISHU_FORMATS.docsMarkdown}`,
      `format:${FEISHU_FORMATS.docsXml}`,
      `format:${FEISHU_FORMATS.taskDocument}`,
    ].sort())
    // Idempotent: a second call must not dispose twice.
    dispose()
    expect(face.disposed).toHaveLength(5)
  })

  it('cleans up already-registered surfaces when a later registration fails', () => {
    const face = new FakeFace()
    face.failOnFormat = FEISHU_FORMATS.taskDocument
    expect(() => registerFeishuSourceClient(face)).toThrow(/refusing/)
    expect(face.disposed).toEqual(expect.arrayContaining([
      `display:${FEISHU_SOURCE_IDS.docs}`,
      `display:${FEISHU_SOURCE_IDS.tasks}`,
      `format:${FEISHU_FORMATS.docsXml}`,
      `format:${FEISHU_FORMATS.docsMarkdown}`,
    ]))
  })

  it('disposes the first display when the second display registration fails', () => {
    const face = new FakeFace()
    face.failOnDisplay = FEISHU_SOURCE_IDS.tasks
    expect(() => registerFeishuSourceClient(face)).toThrow(/refusing display/)
    expect(face.disposed).toEqual([`display:${FEISHU_SOURCE_IDS.docs}`])
    expect(face.displays).toHaveLength(0)
  })

  it('re-registers the format renderers so an already-mounted window follows a locale switch', () => {
    let german = false
    let listener: (() => void) | undefined
    const registry = createCluesClientRegistry(() => SIDEBAR_PREFS_DEFAULTS)
    const dispose = registerFeishuSourceClient(registry, {
      labels: () => german
        ? { readOnly: 'Nur Lesen', docsName: 'Feishu-Dokumente' }
        : undefined,
      subscribe: (callback) => {
        listener = callback
        return () => { listener = undefined }
      },
    })
    const original = registry.getFormatRenderer(FEISHU_FORMATS.docsXml)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => {
      root.render(createElement(ClueFormatHost, {
        kind: 'document',
        registry,
        sourceId: FEISHU_SOURCE_IDS.docs,
        typeId: FEISHU_TYPE_IDS.docx,
        format: FEISHU_FORMATS.docsXml,
        document: docsRead('<title>Plan</title>'),
        readOnly: true,
      }))
    })
    expect(container.textContent).toContain(DEFAULT_FEISHU_LABELS.readOnly)
    german = true
    act(() => { listener?.() })
    // The mounted window subscribes to `getFormatRenderer`; a NEW function
    // identity is what makes it re-render with the new copy.
    expect(registry.getFormatRenderer(FEISHU_FORMATS.docsXml)).not.toBe(original)
    expect(container.textContent).toContain('Nur Lesen')
    act(() => { root.unmount() })
    container.remove()
    dispose()
  })

  it('takes localized labels from the caller instead of editing locale dictionaries', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face, {
      labels: { docsName: 'Docs lokal', tasksName: 'Aufgaben lokal', readOnly: 'Nur Lesen', save: 'Speichern' },
    })
    expect(face.displays.map(display => display.name)).toEqual(['Docs lokal', 'Aufgaben lokal'])
    const markup = renderFormat(face, FEISHU_FORMATS.docsXml, rendererProps(docsRead('<title>Plan</title>')))
    expect(markup).toContain('Nur Lesen')
    const taskMarkup = renderFormat(
      face,
      FEISHU_FORMATS.taskDocument,
      rendererProps(
        { format: FEISHU_FORMATS.taskDocument, data: taskDocument() as unknown as JsonValue },
        { sourceId: FEISHU_SOURCE_IDS.tasks, typeId: FEISHU_TYPE_IDS.task },
      ),
    )
    expect(taskMarkup).toContain('Speichern')
  })

  it('re-resolves live labels and re-registers display names on a locale switch', () => {
    let german = false
    let listener: (() => void) | undefined
    const face = new FakeFace()
    const dispose = registerFeishuSourceClient(face, {
      labels: () => german
        ? { docsName: 'Feishu-Dokumente', tasksName: 'Feishu-Aufgaben', readOnly: 'Nur Lesen' }
        : undefined,
      subscribe: (callback) => {
        listener = callback
        return () => { listener = undefined }
      },
    })
    expect(face.displays.map(display => display.name)).toEqual(['Feishu docs', 'Feishu tasks'])
    german = true
    act(() => { listener?.() })
    expect(face.displays.map(display => display.name)).toEqual(['Feishu-Dokumente', 'Feishu-Aufgaben'])
    const markup = renderFormat(face, FEISHU_FORMATS.docsXml, rendererProps(docsRead('<title>Plan</title>')))
    expect(markup).toContain('Nur Lesen')
    dispose()
    expect(face.displays).toHaveLength(0)
  })

  it('renders a size-aware, token-only icon for both sources', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    for (const display of face.displays) {
      const icon = display.icon
      if (typeof icon !== 'function') throw new Error('the Feishu display icon must be size-aware')
      const markup = renderToStaticMarkup(icon(16) as ReactNode)
      expect(markup).toContain('<svg')
      expect(markup).toContain('width="16"')
      expect(markup).toContain('stroke="currentColor"')
      expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    }
  })
})

describe('docs preview (read-only)', () => {
  it('renders XML as escaped text with a read-only badge and revision', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const markup = renderFormat(face, FEISHU_FORMATS.docsXml, rendererProps(
      docsRead('<title>Plan</title><p>Hello</p>'),
    ))
    expect(markup).toContain('data-feishu-docs-preview')
    expect(markup).toContain('data-feishu-docs-read-only')
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.readOnly)
    expect(markup).toContain('&lt;title&gt;Plan&lt;/title&gt;')
    expect(markup).toContain('Revision 12')
    // No write/editor affordance exists for a read-only document.
    expect(markup).not.toContain('<textarea')
    expect(markup).not.toContain('data-feishu-task-save')
  })

  it('renders Markdown as text too, never as raw HTML', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const document: ClueReadResult = {
      ...docsRead('# Plan\n\n**bold**'),
      format: FEISHU_FORMATS.docsMarkdown,
      data: {
        kind: 'docx',
        title: 'Plan',
        projection: 'markdown',
        content: '# Plan\n\n**bold** <script>alert(1)</script>',
        docToken: 'doccnA',
      } as unknown as JsonValue,
    }
    const markup = renderFormat(face, FEISHU_FORMATS.docsMarkdown, rendererProps(document))
    expect(markup).toContain('Markdown')
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(markup).not.toContain('<script>alert(1)</script>')
  })

  it('states when the shown text is one fragment of a longer document', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const markup = renderFormat(face, FEISHU_FORMATS.docsXml, rendererProps(
      docsRead('<title>Plan</title><p>Start</p>', { limited: true, nextOffset: 42 }),
    ))
    expect(markup).toContain('data-feishu-docs-limited')
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.limitedFragment)
  })

  it('uses an empty-content label rather than the time "Not set" copy', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const markup = renderFormat(face, FEISHU_FORMATS.docsXml, rendererProps(docsRead('')))
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.emptyContent)
    expect(markup).not.toContain(DEFAULT_FEISHU_LABELS.noTime)
  })

  it('degrades to a readable note for an unknown payload instead of crashing', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const props = rendererProps({ format: FEISHU_FORMATS.docsXml, data: { not: 'a document' } as JsonValue })
    const markup = renderFormat(face, FEISHU_FORMATS.docsXml, props)
    expect(markup).toContain('data-feishu-docs-invalid')
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.invalidDocument)
  })
})

describe('docs editor', () => {
  it('renders the loaded edit payload as a controlled block form and keeps complex blocks read-only', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const markup = renderFormat(face, FEISHU_FORMATS.docsXml, rendererProps(
      { format: FEISHU_FORMATS.docsXml, data: docsEdit() as unknown as JsonValue },
      { readOnly: false },
    ))
    expect(markup).toContain('data-feishu-docs-editor')
    expect(markup).toContain('data-feishu-docs-title')
    expect(markup).toContain('value="Plan"')
    expect(markup).toContain('data-feishu-docs-block-input="blk-p1"')
    expect(markup).toContain('Hello &lt;b&gt;world&lt;/b&gt;')
    expect(markup).toContain('data-feishu-docs-block-input="blk-pre"')
    expect(markup).toContain('const x = 1')
    expect(markup).toContain('data-feishu-docs-read-only-block="table"')
    expect(markup).toContain('data-feishu-docs-save')
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.save)
    expect(markup).not.toContain('data-feishu-docs-read-only"')
  })

  it('keeps read-only blocks in document order and exposes their original resource link', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const markup = renderFormat(face, FEISHU_FORMATS.docsXml, rendererProps(
      { format: FEISHU_FORMATS.docsXml, data: docsEdit() as unknown as JsonValue },
      { readOnly: false },
    ))
    const title = markup.indexOf('data-feishu-docs-title')
    const firstBlock = markup.indexOf('data-feishu-docs-block-input="blk-p1"')
    const table = markup.indexOf('data-feishu-docs-read-only-block="table"')
    const pre = markup.indexOf('data-feishu-docs-block-input="blk-pre"')
    const image = markup.indexOf('data-feishu-docs-read-only-block="img"')
    // The table stays between the two text blocks instead of being pushed to
    // the bottom, and the image keeps its original URL entry.
    expect(title).toBeLessThan(firstBlock)
    expect(firstBlock).toBeLessThan(table)
    expect(table).toBeLessThan(pre)
    expect(pre).toBeLessThan(image)
    expect(markup).toContain('https://cdn.example/a.png')
    // The read-only block explains WHY it cannot be edited instead of only
    // showing a generic badge.
    expect(markup).toContain('data-feishu-docs-read-only-reason')
    expect(markup).toContain('complex container')
  })

  it('uses document-specific copy for the title error and an invalid payload', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const markup = renderFormat(face, FEISHU_FORMATS.docsXml, rendererProps(
      { format: FEISHU_FORMATS.docsXml, data: docsEdit({ title: '  ' }) as unknown as JsonValue },
      { readOnly: false },
    ))
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.docsTitleRequired)
    expect(markup).not.toContain(DEFAULT_FEISHU_LABELS.titleRequired)

    const taskInvalid = renderFormat(
      face,
      FEISHU_FORMATS.taskDocument,
      rendererProps(
        { format: FEISHU_FORMATS.taskDocument, data: { not: 'a task' } as JsonValue },
        { sourceId: FEISHU_SOURCE_IDS.tasks, typeId: FEISHU_TYPE_IDS.task },
      ),
    )
    expect(taskInvalid).toContain(DEFAULT_FEISHU_LABELS.invalidTask)
    expect(taskInvalid).not.toContain(DEFAULT_FEISHU_LABELS.invalidDocument)
  })

  it('locks the title and every block while a save is in flight', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const markup = renderFormat(face, FEISHU_FORMATS.docsXml, rendererProps(
      { format: FEISHU_FORMATS.docsXml, data: docsEdit() as unknown as JsonValue },
      { readOnly: false, saving: true },
    ))
    expect(tagOf(markup, 'data-feishu-docs-title')).toContain('disabled')
    expect(tagOf(markup, 'data-feishu-docs-block-input="blk-p1"')).toContain('disabled')
    expect(tagOf(markup, 'data-feishu-docs-save')).toContain('disabled')
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.saving)
  })

  it('never opens the block editor for an edit payload under the Markdown format', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const markup = renderFormat(face, FEISHU_FORMATS.docsMarkdown, rendererProps(
      { format: FEISHU_FORMATS.docsMarkdown, data: docsEdit() as unknown as JsonValue },
      { readOnly: false },
    ))
    expect(markup).not.toContain('data-feishu-docs-editor')
    expect(markup).not.toContain('data-feishu-docs-save')
    expect(markup).toContain('data-feishu-docs-invalid')
  })

  it('localizes freshness and uses the supplied app-locale formatter for stamps', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face, {
      labels: {
        freshnessLive: 'En direct',
        freshnessSnapshot: 'Instantané',
      },
      formatDateTime: value => `formatted(${value})`,
    })
    const markup = renderFormat(face, FEISHU_FORMATS.docsXml, rendererProps(docsRead('<title>Plan</title>')))
    expect(markup).toContain('En direct')
    expect(markup).toContain('formatted(2026-10-17T00:00:00.000Z)')
  })

  it('disables save when the editable title is empty', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const markup = renderFormat(face, FEISHU_FORMATS.docsXml, rendererProps(
      { format: FEISHU_FORMATS.docsXml, data: docsEdit({ title: '  ' }) as unknown as JsonValue },
      { readOnly: false },
    ))
    expect(markup).toContain('data-feishu-docs-error="title"')
    expect(markup).toMatch(/data-feishu-docs-save=""[^>]*disabled/)
  })

  it('shows a static block projection when an edit payload is opened read-only', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const markup = renderFormat(face, FEISHU_FORMATS.docsXml, rendererProps(
      { format: FEISHU_FORMATS.docsXml, data: docsEdit() as unknown as JsonValue },
      { readOnly: true },
    ))
    expect(markup).toContain('data-feishu-docs-preview')
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.readOnly)
    expect(markup).not.toContain('data-feishu-docs-save')
    expect(markup).not.toContain('<textarea')
  })

  it('emits the source-owned edit data when a block or the title changes', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const changes: JsonValue[] = []
    const props = rendererProps(
      { format: FEISHU_FORMATS.docsXml, data: docsEdit() as unknown as JsonValue },
      { readOnly: false, onChange: data => changes.push(data) },
    )
    const mounted = mountFormat(face, FEISHU_FORMATS.docsXml, props)
    const block = mounted.container.querySelector<HTMLTextAreaElement>(
      '[data-feishu-docs-block-input="blk-p1"]',
    )!
    act(() => { typeInto(block, 'Hello edited') })
    expect((changes[0] as unknown as FeishuDocEditData).blocks[0]!.text).toBe('Hello edited')
    const title = mounted.container.querySelector<HTMLInputElement>('[data-feishu-docs-title]')!
    act(() => { typeInto(title, 'New plan') })
    expect((changes[1] as unknown as FeishuDocEditData).title).toBe('New plan')
    mounted.unmount()
  })

  it('calls the host save callback from the save button', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    let saves = 0
    const props = rendererProps(
      { format: FEISHU_FORMATS.docsXml, data: docsEdit() as unknown as JsonValue },
      { readOnly: false, onSave: () => { saves += 1 } },
    )
    const mounted = mountFormat(face, FEISHU_FORMATS.docsXml, props)
    const button = mounted.container.querySelector<HTMLButtonElement>('[data-feishu-docs-save]')!
    act(() => { button.click() })
    expect(saves).toBe(1)
    mounted.unmount()
  })

  it('shows freshness, the original-source entry and the edit-scope note on a read preview', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const document = docsRead('<title>Plan</title><p>Hello</p>')
    const markup = renderFormat(face, FEISHU_FORMATS.docsXml, rendererProps({
      ...document,
      data: {
        ...(document.data as unknown as Record<string, JsonValue>),
        sourceUrl: 'https://acme.feishu.cn/docx/doccnA',
      } as unknown as JsonValue,
    }))
    expect(markup).toContain('data-feishu-docs-freshness="live"')
    expect(markup).toContain('data-feishu-docs-fetched-at')
    expect(markup).toContain('data-feishu-docs-source-link')
    expect(markup).toContain('https://acme.feishu.cn/docx/doccnA')
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.docsEditScopeNote)
    expect(markup).toContain('data-feishu-docs-edit-note')
  })

  it('marks the Markdown projection as read-only and truncates a >40k preview', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const markdown = renderFormat(face, FEISHU_FORMATS.docsMarkdown, rendererProps({
      ...docsRead('# Plan'),
      format: FEISHU_FORMATS.docsMarkdown,
      data: {
        kind: 'docx',
        title: 'Plan',
        projection: 'markdown',
        content: '# Plan',
        docToken: 'doccnA',
      } as unknown as JsonValue,
    }))
    expect(markdown).toContain('data-feishu-docs-markdown-read-only')
    expect(markdown).toContain(DEFAULT_FEISHU_LABELS.markdownReadOnly)

    const huge = 'x'.repeat(50_000)
    const truncated = renderFormat(face, FEISHU_FORMATS.docsXml, rendererProps(docsRead(huge)))
    expect(truncated).toContain(DEFAULT_FEISHU_LABELS.contentTruncated)
    expect(truncated).toContain(DEFAULT_FEISHU_LABELS.showFullContent)
    expect(truncated.length).toBeLessThan(huge.length)
  })

  it('expands a performance-limited preview instead of claiming the full document is elsewhere', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const huge = 'x'.repeat(50_000)
    const mounted = mountFormat(face, FEISHU_FORMATS.docsXml, rendererProps(docsRead(huge)))
    const pre = mounted.container.querySelector<HTMLElement>('[data-feishu-docs-content]')!
    expect(pre.textContent).toHaveLength(40_000)
    const button = mounted.container.querySelector<HTMLButtonElement>('[data-feishu-docs-expand]')!
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.getAttribute('aria-controls')).toBe(pre.id)
    act(() => { button.click() })
    expect(pre.textContent).toHaveLength(50_000)
    expect(button.textContent).toBe(DEFAULT_FEISHU_LABELS.showLess)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    mounted.unmount()
  })
})

describe('task form editor', () => {
  it('is a controlled form over title/description/start/due/completed with a save action', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const props = rendererProps(
      { format: FEISHU_FORMATS.taskDocument, data: taskDocument() as unknown as JsonValue },
      { sourceId: FEISHU_SOURCE_IDS.tasks, typeId: FEISHU_TYPE_IDS.task },
    )
    const markup = renderFormat(face, FEISHU_FORMATS.taskDocument, props)
    expect(markup).toContain('data-feishu-task-editor')
    expect(markup).toContain('data-feishu-task-input="title"')
    expect(markup).toContain('value="Release checklist"')
    expect(markup).toContain('data-feishu-task-input="description"')
    expect(markup).toContain('Ship the release')
    expect(markup).toContain('data-feishu-task-input="start"')
    expect(markup).toContain('data-feishu-task-input="due"')
    expect(markup).toContain('data-feishu-task-input="completed"')
    expect(markup).toContain('data-feishu-task-save')
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.save)
    expect(markup).not.toContain('disabled')
  })

  it('blocks saving locally when the start is later than the due time', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const props = rendererProps(
      {
        format: FEISHU_FORMATS.taskDocument,
        data: taskDocument({ start: { timestamp: '1700009999999', isAllDay: false } }) as unknown as JsonValue,
      },
      { sourceId: FEISHU_SOURCE_IDS.tasks, typeId: FEISHU_TYPE_IDS.task },
    )
    const markup = renderFormat(face, FEISHU_FORMATS.taskDocument, props)
    expect(markup).toContain('data-feishu-task-error="due"')
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.startAfterDue)
    expect(markup).toContain('data-feishu-task-save')
    expect(markup).toMatch(/data-feishu-task-save=""[^>]*disabled/)
  })

  it('blocks saving locally when the title is empty', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const props = rendererProps(
      {
        format: FEISHU_FORMATS.taskDocument,
        data: taskDocument({ title: '   ' }) as unknown as JsonValue,
      },
      { sourceId: FEISHU_SOURCE_IDS.tasks, typeId: FEISHU_TYPE_IDS.task },
    )
    const markup = renderFormat(face, FEISHU_FORMATS.taskDocument, props)
    expect(markup).toContain('data-feishu-task-error="title"')
    expect(markup).toMatch(/data-feishu-task-save=""[^>]*disabled/)
  })

  it('blocks saving locally on mixed all-day flags (the API requires both to agree)', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const props = rendererProps(
      {
        format: FEISHU_FORMATS.taskDocument,
        data: taskDocument({
          start: { timestamp: '1700000000000', isAllDay: false },
          due: { timestamp: '1700003600000', isAllDay: true },
        }) as unknown as JsonValue,
      },
      { sourceId: FEISHU_SOURCE_IDS.tasks, typeId: FEISHU_TYPE_IDS.task },
    )
    const markup = renderFormat(face, FEISHU_FORMATS.taskDocument, props)
    expect(markup).toContain('data-feishu-task-error="due"')
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.allDayMismatch)
    expect(markup).toMatch(/data-feishu-task-save=""[^>]*disabled/)
  })

  it('shows updatedAt in the editor meta and locks every field while saving', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const props = rendererProps(
      { format: FEISHU_FORMATS.taskDocument, data: taskDocument() as unknown as JsonValue },
      {
        sourceId: FEISHU_SOURCE_IDS.tasks,
        typeId: FEISHU_TYPE_IDS.task,
        saving: true,
      },
    )
    const markup = renderFormat(face, FEISHU_FORMATS.taskDocument, props)
    expect(markup).toContain('data-feishu-task-updated-at')
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.updatedAt)
    for (const field of ['title', 'description', 'start', 'due', 'completed']) {
      expect(tagOf(markup, `data-feishu-task-input="${field}"`)).toContain('disabled')
    }
    expect(tagOf(markup, 'data-feishu-task-save')).toContain('disabled')
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.saving)
  })

  it('refuses to render a task payload under another format', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const markup = renderFormat(face, FEISHU_FORMATS.taskDocument, rendererProps(
      { format: FEISHU_FORMATS.taskDocument, data: taskDocument() as unknown as JsonValue },
      {
        sourceId: FEISHU_SOURCE_IDS.tasks,
        typeId: FEISHU_TYPE_IDS.task,
        format: FEISHU_FORMATS.docsXml,
      },
    ))
    expect(markup).toContain('data-feishu-task-invalid')
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.invalidTask)
  })

  it('uses an empty-description label in the read-only task projection', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const props = rendererProps(
      {
        format: FEISHU_FORMATS.taskDocument,
        data: taskDocument({ description: '' }) as unknown as JsonValue,
      },
      { sourceId: FEISHU_SOURCE_IDS.tasks, typeId: FEISHU_TYPE_IDS.task, readOnly: true },
    )
    const markup = renderFormat(face, FEISHU_FORMATS.taskDocument, props)
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.emptyDescription)
    expect(markup).not.toContain(DEFAULT_FEISHU_LABELS.noTime)
  })

  it('renders a static read-only task preview with no inputs or save button', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const props = rendererProps(
      { format: FEISHU_FORMATS.taskDocument, data: taskDocument() as unknown as JsonValue },
      { sourceId: FEISHU_SOURCE_IDS.tasks, typeId: FEISHU_TYPE_IDS.task, readOnly: true },
    )
    const markup = renderFormat(face, FEISHU_FORMATS.taskDocument, props)
    expect(markup).toContain('data-feishu-task-read-only')
    expect(markup).toContain('Release checklist')
    expect(markup).toContain('Ship the release')
    expect(markup).not.toContain('<input')
    expect(markup).not.toContain('data-feishu-task-save')
  })
})

describe('task editor interactions and a11y', () => {
  it('shows the task updated time and the original-source entry in the read-only projection', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const props = rendererProps(
      {
        format: FEISHU_FORMATS.taskDocument,
        data: taskDocument({
          updatedAt: '1700000001000',
          url: 'https://applink.feishu.cn/client/todo/detail?guid=x',
        }) as unknown as JsonValue,
      },
      { sourceId: FEISHU_SOURCE_IDS.tasks, typeId: FEISHU_TYPE_IDS.task, readOnly: true },
    )
    const markup = renderFormat(face, FEISHU_FORMATS.taskDocument, props)
    expect(markup).toContain('data-feishu-task-updated-at')
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.updatedAt)
    expect(markup).toContain('https://applink.feishu.cn/client/todo/detail?guid=x')
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.sourceLink)
  })

  it('gives each time field a distinct accessible name for its all-day checkbox and set button', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const props = rendererProps(
      {
        format: FEISHU_FORMATS.taskDocument,
        data: taskDocument({
          start: null,
          due: { timestamp: '1700003600000', isAllDay: true },
        }) as unknown as JsonValue,
      },
      { sourceId: FEISHU_SOURCE_IDS.tasks, typeId: FEISHU_TYPE_IDS.task },
    )
    const markup = renderFormat(face, FEISHU_FORMATS.taskDocument, props)
    expect(markup).toContain('aria-label="Start: Set time"')
    expect(markup).toContain('aria-label="Due All day"')
    expect(markup).not.toContain('aria-label="Start All day"')
  })

  it('keeps all-day dates date-only even when S9 supplies a date-time formatter', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face, {
      formatDateTime: value => `formatted(${value})`,
    })
    const markup = renderFormat(face, FEISHU_FORMATS.taskDocument, rendererProps(
      {
        format: FEISHU_FORMATS.taskDocument,
        data: taskDocument({
          start: { timestamp: '1700000000000', isAllDay: true },
          due: { timestamp: '1700003600000', isAllDay: false },
        }) as unknown as JsonValue,
      },
      { readOnly: true, sourceId: FEISHU_SOURCE_IDS.tasks, typeId: FEISHU_TYPE_IDS.task },
    ))
    // All-day semantics win: the start date is not rendered as a date+time.
    expect(markup).not.toContain('formatted(1700000000000)')
    expect(markup).toContain('formatted(1700003600000)')
  })

  it('emits the all-day flag instead of silently converting the time', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const changes: JsonValue[] = []
    const props = rendererProps(
      { format: FEISHU_FORMATS.taskDocument, data: taskDocument() as unknown as JsonValue },
      { sourceId: FEISHU_SOURCE_IDS.tasks, typeId: FEISHU_TYPE_IDS.task, onChange: data => changes.push(data) },
    )
    const mounted = mountFormat(face, FEISHU_FORMATS.taskDocument, props)
    const allDay = mounted.container.querySelector<HTMLInputElement>('[data-feishu-task-allday="start"]')!
    act(() => { allDay.click() })
    expect((changes[0] as { start: { isAllDay: boolean; timestamp: string } }).start)
      .toEqual({ timestamp: '1700000000000', isAllDay: true })
    mounted.unmount()
  })

  it('focuses the time input after Set time and emits null when the user clears it', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const changes: JsonValue[] = []
    const props = rendererProps(
      {
        format: FEISHU_FORMATS.taskDocument,
        data: taskDocument({ start: null }) as unknown as JsonValue,
      },
      { sourceId: FEISHU_SOURCE_IDS.tasks, typeId: FEISHU_TYPE_IDS.task, onChange: data => changes.push(data) },
    )
    const mounted = mountFormat(face, FEISHU_FORMATS.taskDocument, props)
    const button = mounted.container.querySelector<HTMLButtonElement>('[data-feishu-task-set-time="start"]')!
    act(() => { button.click() })
    expect(changes).toHaveLength(1)
    // The host owns the document state: feed the emitted value back, as S6 does.
    mounted.rerender({
      ...props,
      document: {
        format: FEISHU_FORMATS.taskDocument,
        data: changes[0] as JsonValue,
      },
    })
    const input = mounted.container.querySelector<HTMLInputElement>('[data-feishu-task-input="start"]')!
    expect(input).toBeTruthy()
    expect(document.activeElement).toBe(input)
    act(() => { typeInto(input, '') })
    // Clearing a time is a real edit: the host names the field in
    // update_fields and omits it from the native PATCH body.
    expect((changes[1] as { start: unknown }).start).toBeNull()
    expect(mounted.container.querySelector('[data-feishu-task-time-error="start"]')).toBeNull()
    expect(changes).toHaveLength(2)
    mounted.unmount()
  })

  it('marks the due input invalid with a described error when start is later than due', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const props = rendererProps(
      {
        format: FEISHU_FORMATS.taskDocument,
        data: taskDocument({ start: { timestamp: '1700009999999', isAllDay: false } }) as unknown as JsonValue,
      },
      { sourceId: FEISHU_SOURCE_IDS.tasks, typeId: FEISHU_TYPE_IDS.task },
    )
    const markup = renderFormat(face, FEISHU_FORMATS.taskDocument, props)
    expect(markup).toMatch(/data-feishu-task-input="due"[^>]*aria-invalid="true"/)
    expect(markup).toMatch(/data-feishu-task-input="due"[^>]*aria-describedby="[^"]+"/)
    expect(markup).toContain(DEFAULT_FEISHU_LABELS.startAfterDue)
  })

  it('emits title edits and calls the host save callback', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const changes: JsonValue[] = []
    let saves = 0
    const props = rendererProps(
      { format: FEISHU_FORMATS.taskDocument, data: taskDocument() as unknown as JsonValue },
      {
        sourceId: FEISHU_SOURCE_IDS.tasks,
        typeId: FEISHU_TYPE_IDS.task,
        onChange: data => changes.push(data),
        onSave: () => { saves += 1 },
      },
    )
    const mounted = mountFormat(face, FEISHU_FORMATS.taskDocument, props)
    const title = mounted.container.querySelector<HTMLInputElement>('[data-feishu-task-input="title"]')!
    act(() => { typeInto(title, 'New title') })
    expect((changes[0] as { title: string }).title).toBe('New title')
    const save = mounted.container.querySelector<HTMLButtonElement>('[data-feishu-task-save]')!
    act(() => { save.click() })
    expect(saves).toBe(1)
    mounted.unmount()
  })
})

describe('client hygiene', () => {
  it('keeps the client module node-free and token-only', () => {
    const directory = resolve(ROOT, 'src/client/clues/sources/feishu')
    const files = readdirSync(directory).map(name => resolve(directory, name))
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/from\s+['"]node:/)
      expect(source, file).not.toMatch(/require\(\s*['"]node:/)
      expect(source, file).not.toMatch(/from\s+['"](?:node:)?(?:fs|path|os|crypto|child_process)['"]/)
      expect(source, file).not.toMatch(/\bprocess\.(?:env|cwd|platform)\b/)
      expect(source, file).not.toMatch(/\bBuffer\b/)
      expect(source, file).not.toMatch(/\b(?:access_token|refresh_token|device_code|Bearer)\b/i)
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(source, file).not.toMatch(/\brgba?\(/)
    }
    const styles = readFileSync(resolve(directory, 'feishu.module.css'), 'utf8')
    for (const declaration of styles.matchAll(/(?:^|[;{\s])color:\s*([^;}]+)/g)) {
      expect(declaration[1], declaration[0]).toContain('var(--')
    }
  })
})
