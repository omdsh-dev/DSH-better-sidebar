/**
 * S4 Feishu CLIENT contract (node-free renderers, no real account).
 *
 * Pins:
 * - `registerFeishuSourceClient` registers both source displays (with
 *   size-aware, token-only icons) and the three format renderers, and its
 *   disposer removes exactly those registrations (idempotent; a partial
 *   failure cleans up what already succeeded);
 * - docs previews are READ-ONLY XML/Markdown text: no save control, content is
 *   escaped as text (never injected as HTML), fragments/truncation are stated,
 *   and empty documents use dedicated empty copy rather than a time label;
 * - the task renderer is a controlled form with title/description/start/due/
 *   completed fields and a disabled save on local validation errors; the
 *   read-only mode is static text;
 * - localized copy arrives through the registration options (S9 owns the
 *   dictionaries), not hardcoded locale files;
 * - the client module and its stylesheet stay node-free and use only
 *   `--dsw-*` / `--ds-*` theme tokens.
 */
// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  ClueEditDocument,
  ClueFormatRenderer,
  ClueFormatRendererProps,
  ClueReadResult,
  ClueSourceDisplayDescriptor,
  JsonValue,
} from '../src/clues/types.ts'
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

/** One source-display/renderer registry double. */
class FakeFace implements FeishuClientRegistrationFace {
  readonly displays: ClueSourceDisplayDescriptor[] = []
  readonly renderers = new Map<string, ClueFormatRenderer>()
  readonly disposed: string[] = []
  failOnFormat: string | undefined

  registerSourceDisplay(descriptor: ClueSourceDisplayDescriptor): () => void {
    this.displays.push(descriptor)
    return () => { this.disposed.push(`display:${descriptor.sourceId}`) }
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

  it('renders a size-aware, token-only icon', () => {
    const face = new FakeFace()
    registerFeishuSourceClient(face)
    const icon = face.displays[0]!.icon
    if (typeof icon !== 'function') throw new Error('the Feishu display icon must be size-aware')
    const markup = renderToStaticMarkup(icon(16) as ReactNode)
    expect(markup).toContain('<svg')
    expect(markup).toContain('width="16"')
    expect(markup).toContain('stroke="currentColor"')
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}/)
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

describe('client hygiene', () => {
  it('keeps the client module node-free and token-only', () => {
    const directory = resolve(ROOT, 'src/client/clues/sources/feishu')
    const files = readdirSync(directory).map(name => resolve(directory, name))
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/from\s+['"]node:/)
      expect(source, file).not.toMatch(/require\(\s*['"]node:/)
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(source, file).not.toMatch(/\brgba?\(/)
    }
    const styles = readFileSync(resolve(directory, 'feishu.module.css'), 'utf8')
    for (const declaration of styles.matchAll(/(?:^|[;{\s])color:\s*([^;}]+)/g)) {
      expect(declaration[1], declaration[0]).toContain('var(--')
    }
  })
})
