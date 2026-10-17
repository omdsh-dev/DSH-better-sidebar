/**
 * S3 GitHub client half: source icons + the text/markdown title+body editor.
 *
 * The renderer is registered through S1's format-renderer seam and hosted by
 * S6's window (no UI is opened here). It only forwards edits through
 * `onChange`; the source's `saveEdit` (S9 wiring) remains the only write path.
 *
 * Because the format registry is keyed by MIME only, the `text/markdown`
 * renderer also serves non-GitHub documents by delegating to S6's reusable
 * single-text carrier inside S6's own carrier wrapper/data attributes, so
 * registering it never breaks local-file editing or layout.
 * New visible copy is avoided on purpose (the locale dictionaries are owned by
 * S8/S9): the editor uses existing keys only, the source-owned read-only
 * reason is visible as its code AND as a data attribute for S9 to localize,
 * saving locks the inputs, and Ctrl/Cmd+Enter forwards the source-owned
 * `onSave` (the renderer never writes by itself).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
import { WindowHost } from '../src/client/windows/WindowHost.tsx'
import { createWindowHost } from '../src/client/windows/host.ts'
import { createCluesClientRegistry, type BetterSidebarCluesClientFace } from '../src/client/clues/registry.ts'
import { registerGithubSourceClient } from '../src/client/clues/sources/github/index.tsx'
import { GITHUB_SOURCE_IDS, GITHUB_TYPE_IDS, GITHUB_FORMAT } from '../src/clues/sources/github/ids.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import type { WindowHostController } from '../src/client/windows/types.ts'
import type { ClueFormatRenderer, JsonValue } from '../src/clues/types.ts'

setupReactAct()

const VIEWPORT = { width: 1_000, height: 800 }

function frame(title: string): HTMLElement {
  const node = [...document.querySelectorAll<HTMLElement>('[data-floating-window]')]
    .find(candidate => candidate.getAttribute('aria-label') === title)
  if (node === undefined) throw new Error(`no floating window titled "${title}"`)
  return node
}

/** Type into a controlled input/textarea through the setter React listens for. */
function typeInto(node: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = node instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true }))
}

let host: WindowHostController | undefined
let mounted: RenderedRoot | undefined
let registry: BetterSidebarCluesClientFace | undefined
let disposeRegistration: (() => void) | undefined

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height })
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
  registry = createCluesClientRegistry(() => SIDEBAR_PREFS_DEFAULTS)
  disposeRegistration = registerGithubSourceClient(registry)
  host = createWindowHost({ viewport: () => VIEWPORT })
  mounted = renderRoot(createElement(WindowHost, { host, formats: registry }))
})

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  host?.dispose()
  host = undefined
  disposeRegistration?.()
  disposeRegistration = undefined
  registry = undefined
  document.body.innerHTML = ''
})

interface OpenDocumentOptions {
  id: string
  title: string
  data: JsonValue
  sourceId?: string
  typeId?: string
  readOnly?: boolean
  saving?: boolean
  onChange?: (data: JsonValue) => void
  onSave?: () => void
}

function openDocument(options: OpenDocumentOptions): void {
  act(() => {
    host!.open({
      id: options.id,
      title: options.title,
      content: {
        kind: 'document',
        sourceId: options.sourceId ?? GITHUB_SOURCE_IDS.issue,
        typeId: options.typeId ?? GITHUB_TYPE_IDS.issue,
        format: GITHUB_FORMAT,
        document: {
          format: GITHUB_FORMAT,
          data: options.data,
          baseRevision: 'ghsb1-rev',
        },
        ...(options.readOnly === true ? { readOnly: true } : {}),
        ...(options.saving === true ? { saving: true } : {}),
        ...(options.onChange === undefined ? {} : { onChange: options.onChange }),
        ...(options.onSave === undefined ? {} : { onSave: options.onSave }),
      },
    })
  })
}

describe('source display registration', () => {
  it('registers both GitHub sources with icons and the markdown renderer', () => {
    const displays = registry!.getSourceDisplays()
    expect(displays.map(display => display.sourceId)).toEqual([
      GITHUB_SOURCE_IDS.issue,
      GITHUB_SOURCE_IDS.pull,
    ])
    for (const display of displays) {
      expect(typeof display.icon).toBe('function')
      const icon = (display.icon as (size: number) => ReactNode)(16)
      expect(icon).not.toBeNull()
    }
    expect(registry!.getFormatRenderer(GITHUB_FORMAT)).toBeTypeOf('function')
  })

  it('disposes exactly its own registrations', () => {
    disposeRegistration?.()
    disposeRegistration = undefined
    expect(registry!.getSourceDisplays()).toEqual([])
    expect(registry!.getFormatRenderer(GITHUB_FORMAT)).toBeUndefined()
  })

  it('rolls back its displays when another plugin already owns text/markdown', () => {
    const other = createCluesClientRegistry(() => SIDEBAR_PREFS_DEFAULTS)
    const renderer: ClueFormatRenderer = () => null
    other.registerFormatRenderer(GITHUB_FORMAT, renderer)
    expect(() => registerGithubSourceClient(other)).toThrow(/already registered/)
    expect(other.getSourceDisplays()).toEqual([])
    expect(other.getFormatRenderer(GITHUB_FORMAT)).toBe(renderer)
  })
})

describe('title + body editor', () => {
  it('renders the GitHub title/body and forwards edits without dropping source data', () => {
    const onChange = vi.fn()
    openDocument({
      id: 'issue-1',
      title: 'Issue editor',
      data: { title: 'Fix crash', body: 'Steps to reproduce', number: 7, labels: ['bug'] },
      onChange,
    })
    const window = frame('Issue editor')
    const title = window.querySelector<HTMLInputElement>('[data-github-title]')
    const body = window.querySelector<HTMLTextAreaElement>('[data-github-body]')
    expect(title?.value).toBe('Fix crash')
    expect(body?.value).toBe('Steps to reproduce')

    act(() => { typeInto(title!, 'Fix crash properly') })
    expect(onChange).toHaveBeenLastCalledWith({
      title: 'Fix crash properly',
      body: 'Steps to reproduce',
      number: 7,
      labels: ['bug'],
    })

    act(() => { typeInto(body!, 'New body') })
    expect(onChange).toHaveBeenLastCalledWith({
      title: 'Fix crash',
      body: 'New body',
      number: 7,
      labels: ['bug'],
    })
  })

  it("uses S6's text carrier for a non-GitHub text/markdown document", () => {
    const onChange = vi.fn()
    openDocument({
      id: 'file-1',
      title: 'Readme',
      sourceId: 'builtin.files',
      typeId: 'builtin.files.markdown',
      data: { text: '# hello', path: 'README.md' } as unknown as JsonValue,
      onChange,
    })
    const window = frame('Readme')
    // The renderer keeps S6's built-in carrier contract (wrapper, data
    // attributes and flex layout), not just the textarea.
    const carrier = window.querySelector<HTMLElement>(
      '[data-window-text-content][data-window-text-format="text/markdown"]',
    )
    expect(carrier).not.toBeNull()
    const editor = carrier?.querySelector<HTMLTextAreaElement>('[data-window-text-editor]')
    expect(editor?.value).toBe('# hello')
    act(() => { typeInto(editor!, '# bye') })
    expect(onChange).toHaveBeenLastCalledWith({ text: '# bye', path: 'README.md' })
  })

  it('renders a read-only document when the window says so (preview)', () => {
    openDocument({
      id: 'preview-1',
      title: 'Issue preview',
      data: { title: 'Read me only', body: 'Source body' },
      readOnly: true,
    })
    const window = frame('Issue preview')
    expect(window.querySelector('[data-github-title]')).toBeNull()
    expect(window.querySelector('[data-github-body]')).toBeNull()
    const readOnly = window.querySelector('[data-github-read-only]')
    expect(readOnly).not.toBeNull()
    expect(window.textContent).toContain('Read me only')
    expect(window.textContent).toContain('Source body')
    // S6 already renders the shared badge for a host preview; the renderer
    // must not duplicate it.
    expect((window.textContent?.match(/只读/g) ?? []).length).toBe(1)
  })

  it('honours a source-marked read-only document (archived / no write permission / too large)', () => {
    openDocument({
      id: 'archived-1',
      title: 'Archived issue',
      data: {
        title: 'Archived title',
        body: 'Archived body',
        readOnly: true,
        readOnlyReason: 'archived',
      },
    })
    const window = frame('Archived issue')
    expect(window.querySelector('[data-github-title]')).toBeNull()
    const readOnly = window.querySelector('[data-github-read-only]')
    expect(readOnly?.getAttribute('data-github-read-only-reason')).toBe('archived')
    // Existing localized copy only: the host's read-only badge key. The
    // source reason is visible as well until S9 localizes the data attribute.
    expect(window.textContent).toContain('只读')
    expect(window.textContent).toContain('archived')
  })

  it('shows the save-in-flight state without claiming success and locks the inputs', () => {
    const onSave = vi.fn()
    openDocument({
      id: 'saving-1',
      title: 'Saving issue',
      data: { title: 'T', body: 'B' },
      saving: true,
      onSave,
    })
    const window = frame('Saving issue')
    // S6 owns the saving indicator; the renderer must not fake a "saved" state.
    expect(window.querySelector('[data-github-saved]')).toBeNull()
    expect(window.querySelector('[data-window-saving]')).not.toBeNull()
    // No edit can be typed into a save that will soon clear the dirty state.
    expect(window.querySelector<HTMLInputElement>('[data-github-title]')?.disabled).toBe(true)
    const body = window.querySelector<HTMLTextAreaElement>('[data-github-body]')
    expect(body?.disabled).toBe(true)
    act(() => {
      body?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('exposes the source-owned onSave on Ctrl/Cmd+Enter, never saving by itself', () => {
    const onSave = vi.fn()
    openDocument({
      id: 'save-key-1',
      title: 'Save key issue',
      data: { title: 'T', body: 'B' },
      onSave,
    })
    const window = frame('Save key issue')
    const body = window.querySelector<HTMLTextAreaElement>('[data-github-body]')
    act(() => {
      body?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onSave).not.toHaveBeenCalled()
    act(() => {
      body?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    act(() => {
      body?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
    })
    expect(onSave).toHaveBeenCalledTimes(2)
  })
})
