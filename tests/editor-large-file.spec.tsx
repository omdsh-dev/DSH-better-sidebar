/**
 * Over-limit reads: a file above the editable threshold (`MAX_EDITABLE_BYTES`)
 * is never handed to a viewer as a document. The viewer that owns its
 * extension still renders, but as the read-only paged preview — so the pane
 * carries the too-large notice and a download link, and there is NO editor at
 * all: no CodeMirror instance and no save surface. This replaces the retired
 * #732 premise (a capped read rendered a read-only editor over a prefix of the
 * file): the host refuses the document instead of handing over a prefix, so
 * "save the prefix back over the file" is not a state that can exist any more
 * (see src/editor-limits.ts).
 */
// @vitest-environment jsdom
import './browser-globals.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { downloadUrl } from '../src/client/api.ts'
import { LargeFileView, MAX_PREVIEW_ROWS } from '../src/client/LargeFileView.tsx'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { attachLocale, t } from '../src/client/locales.ts'
import { formatByteSize, MAX_EDITABLE_LABEL } from '../src/editor-limits.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import type { FileViewerProps } from '../src/client/service.ts'

setupReactAct()

/** The paged preview's reads; `api.fsReadPage` is the only route it uses. */
const readPage = vi.fn()
// Partial mock: the paged preview reads through `api.fsReadPage` on mount, and
// `downloadUrl` (the notice's link) must stay the real implementation.
vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      fsReadPage: (...args: unknown[]) => readPage(...args),
      // The code viewer's git gutter polls the shared status store; a
      // non-repo answer keeps the editor mount off the network.
      gitStatus: async () => ({ isRepo: false, entries: [] }),
    },
  }
})

/** Minimal structural fake of the DSH LocaleService face the sidebar uses. */
class FakeLocale {
  active: string = 'en'
  getSnapshot(): { active: string } {
    return { active: this.active }
  }
  subscribe(_fn: () => void): () => void {
    return () => {}
  }
  register(_ns: string, _locale: string, _dict: Record<string, string>): () => void {
    return () => {}
  }
}

const CTX = {} as Context
const SCOPE = { sessionId: 's1', cwd: '/p' }
const PATH = '/p/big.txt'
/** Above MAX_EDITABLE_BYTES (5 MiB): the host answers `too-large`. */
const SIZE = 6 * 1024 * 1024
const PAGE = 'alpha\nbeta\n'

function viewerProps(overrides: Partial<FileViewerProps> = {}): FileViewerProps {
  return {
    ctx: CTX,
    store: createSidebarStore(),
    scope: SCOPE,
    path: PATH,
    title: 'big.txt',
    viewerId: 'code',
    ...overrides,
  }
}

/** Settle the pager's first read (mount effect → promise → state). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(() => {
  attachLocale(undefined)
  readPage.mockReset()
})

describe('TextEditor over-limit preview', () => {
  it('renders the paged preview: notice + download link, no editor and no save', async () => {
    attachLocale(new FakeLocale())
    readPage.mockResolvedValue({
      kind: 'text', text: PAGE, offset: 0, nextOffset: SIZE, eof: true, size: SIZE, encoding: 'utf8',
    })
    // The load plan's shape for a `too-large` read: size + largeFile, and no
    // content (see planFsReadOutcome).
    const { container, unmount } = renderRoot(
      createElement(TextEditor, viewerProps({ size: SIZE, largeFile: { size: SIZE } })),
    )
    try {
      await flush()

      // (a) The notice names the file's size and the edit threshold.
      expect(container.textContent).toContain(
        t('previewOnlyNotice', { size: formatByteSize(SIZE), limit: MAX_EDITABLE_LABEL }),
      )
      // (b) The download link points at the raw-bytes route.
      const link = container.querySelector('a[download]')
      expect(link, 'the over-limit preview offers the download').not.toBeNull()
      expect(link!.getAttribute('href')).toBe(downloadUrl(SCOPE, PATH))
      expect(link!.textContent).toBe(t('downloadToView'))
      // (c) No editor is built at all: the component returns before the
      // CodeMirror host exists, which is what makes "no save" structural
      // rather than a hidden button.
      expect(container.querySelector('.cm-editor')).toBeNull()
      expect(container.querySelector('.cm-content')).toBeNull()
      expect(container.querySelector('button[aria-label="Save"]')).toBeNull()
      // The preview is live, not a placeholder: it paged the file from offset
      // 0 and renders the page it got back.
      expect(readPage).toHaveBeenCalledWith(expect.anything(), PATH, 0)
      expect(container.textContent).toContain('alpha')
    } finally {
      unmount()
    }
  })

  it('keeps the CodeMirror editor and its save button for an editable load', async () => {
    attachLocale(new FakeLocale())
    // (d) The contrast that gives the assertions above their meaning: the same
    // component, only without `largeFile`, mounts the editor and offers save.
    const { container, unmount } = renderRoot(
      createElement(TextEditor, viewerProps({ content: 'hello\n', size: 6 })),
    )
    try {
      expect(container.querySelector('.cm-editor')).not.toBeNull()
      expect(container.querySelector('button[aria-label="Save"]')).not.toBeNull()
      expect(readPage, 'an editable load never pages').not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })
})

/**
 * The append-on-scroll behaviour and the row ceiling.
 *
 * These render {@link LargeFileView} directly (the TextEditor cases above pin
 * how it is reached), because the questions here are about the preview's own
 * scrolling: does reaching the bottom APPEND rather than replace, does the
 * notice's "load all" pull everything, and does the ceiling stop it with an
 * explanation instead of a frozen tab.
 *
 * jsdom reports zero geometry for every element, which the real component reads
 * as "the content does not fill the pane" and answers by pulling another page —
 * correct behaviour, but it makes a scroll test meaningless. The element metrics
 * are therefore stubbed per test: `overflow` for the scroll cases, `empty` for
 * the fill-the-viewport case.
 */
interface Metrics {
  scrollHeight: number
  clientHeight: number
}

/** Force every element to report the given scroll geometry. */
function stubMetrics({ scrollHeight, clientHeight }: Metrics): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true, get: () => scrollHeight,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true, get: () => clientHeight,
  })
}

afterEach(() => {
  // Restore jsdom's own (zero) geometry for the next test.
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
})

/** One page fixture with an explicit continuation. */
function page(text: string, offset: number, nextOffset: number, eof: boolean) {
  return { kind: 'text' as const, text, offset, nextOffset, eof, size: nextOffset, encoding: 'utf8' }
}

/** The preview's scroll container. */
function bodyOf(container: HTMLElement): HTMLElement {
  const body = container.querySelector('[class*="largeFileBody"]')
  expect(body, 'the preview renders a scroll body').not.toBeNull()
  return body as HTMLElement
}

describe('LargeFileView appends on scroll', () => {
  it('pulls the next page at the bottom and KEEPS the one already read', async () => {
    attachLocale(new FakeLocale())
    stubMetrics({ scrollHeight: 1000, clientHeight: 300 })
    readPage
      .mockResolvedValueOnce(page('one\n', 0, 4, false))
      .mockResolvedValueOnce(page('two\n', 4, 8, false))
      .mockResolvedValueOnce(page('three\n', 8, 12, true))
    const { container, unmount } = renderRoot(createElement(LargeFileView, {
      scope: SCOPE, path: PATH, size: SIZE, visible: true, revision: 0,
    }))
    try {
      await flush()
      expect(readPage).toHaveBeenCalledTimes(1)
      expect(container.textContent).toContain('one')

      // Scrolling to within the threshold of the bottom appends page two.
      const body = bodyOf(container)
      Object.defineProperty(body, 'scrollTop', { value: 750, configurable: true })
      await act(async () => { body.dispatchEvent(new Event('scroll')) })
      await flush()
      expect(readPage).toHaveBeenLastCalledWith(expect.anything(), PATH, 4)
      // BOTH pages are on screen: appending does not throw away what was read.
      expect(container.textContent).toContain('one')
      expect(container.textContent).toContain('two')
      // Line numbering continues across the boundary — the appended page's
      // first row is number 2, not a fresh 1.
      expect(container.textContent).toContain('1one')
      expect(container.textContent).toContain('2two')
    } finally {
      unmount()
    }
  })

  it('does not pull anything while the reader is mid-document', async () => {
    attachLocale(new FakeLocale())
    stubMetrics({ scrollHeight: 10_000, clientHeight: 300 })
    readPage.mockResolvedValue(page('one\n', 0, 4, false))
    const { container, unmount } = renderRoot(createElement(LargeFileView, {
      scope: SCOPE, path: PATH, size: SIZE, visible: true, revision: 0,
    }))
    try {
      await flush()
      const body = bodyOf(container)
      Object.defineProperty(body, 'scrollTop', { value: 0, configurable: true })
      await act(async () => { body.dispatchEvent(new Event('scroll')) })
      await flush()
      expect(readPage).toHaveBeenCalledTimes(1)
    } finally {
      unmount()
    }
  })

  it('fills the viewport by itself when the first page does not overflow', async () => {
    attachLocale(new FakeLocale())
    // Zero geometry everywhere: the pane is never "full", so the preview keeps
    // pulling until EOF rather than leaving the reader in front of a stub.
    stubMetrics({ scrollHeight: 0, clientHeight: 0 })
    readPage
      .mockResolvedValueOnce(page('one\n', 0, 4, false))
      .mockResolvedValueOnce(page('two\n', 4, 8, true))
    const { container, unmount } = renderRoot(createElement(LargeFileView, {
      scope: SCOPE, path: PATH, size: SIZE, visible: true, revision: 0,
    }))
    try {
      await flush()
      await flush()
      expect(readPage).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('two')
    } finally {
      unmount()
    }
  })
})

describe('LargeFileView load-all and its ceiling', () => {
  it('loads every remaining page from the notice button and then disables it', async () => {
    attachLocale(new FakeLocale())
    stubMetrics({ scrollHeight: 1000, clientHeight: 300 })
    readPage
      .mockResolvedValueOnce(page('one\n', 0, 4, false))
      .mockResolvedValueOnce(page('two\n', 4, 8, false))
      .mockResolvedValueOnce(page('three\n', 8, 12, true))
    const { container, unmount } = renderRoot(createElement(LargeFileView, {
      scope: SCOPE, path: PATH, size: SIZE, visible: true, revision: 0,
    }))
    try {
      await flush()
      const button = [...container.querySelectorAll('button')]
        .find(node => node.textContent === t('loadAll'))
      expect(button, 'the notice offers load all').toBeDefined()
      expect(button!.hasAttribute('disabled')).toBe(false)

      await act(async () => { button!.click() })
      await flush()
      await flush()
      // Every page is in, sequential and in order.
      expect(readPage.mock.calls.map(call => call[2])).toEqual([0, 4, 8])
      expect(container.textContent).toContain('three')
      expect([...container.querySelectorAll('button')]
        .find(node => node.textContent === t('loadAll'))!.hasAttribute('disabled')).toBe(true)
    } finally {
      unmount()
    }
  })

  it('stops at the row ceiling and says so instead of growing the DOM forever', async () => {
    attachLocale(new FakeLocale())
    stubMetrics({ scrollHeight: 1000, clientHeight: 300 })
    // A tiny ceiling stands in for MAX_PREVIEW_ROWS: the page below is three
    // rows, so the first window already spends the budget.
    readPage.mockResolvedValue(page('a\nb\nc\n', 0, 6, false))
    const { container, unmount } = renderRoot(createElement(LargeFileView, {
      scope: SCOPE, path: PATH, size: SIZE, visible: true, revision: 0, maxRows: 2,
    }))
    try {
      await flush()
      await flush()
      // Exactly one page: the ceiling stopped the walk, and the reader is told
      // why rather than being left with a silently dead scroll.
      expect(readPage).toHaveBeenCalledTimes(1)
      expect(container.textContent).toContain(t('previewRowLimit', { rows: 2 }))
      const button = [...container.querySelectorAll('button')]
        .find(node => node.textContent === t('loadAll'))
      expect(button!.hasAttribute('disabled'), 'load all is spent').toBe(true)
    } finally {
      unmount()
    }
  })

  it('uses the shipped ceiling when the caller does not override it', async () => {
    attachLocale(new FakeLocale())
    stubMetrics({ scrollHeight: 1000, clientHeight: 300 })
    readPage.mockResolvedValue(page('a\n', 0, 2, false))
    const { container, unmount } = renderRoot(createElement(LargeFileView, {
      scope: SCOPE, path: PATH, size: SIZE, visible: true, revision: 0,
    }))
    try {
      await flush()
      // Three rows is nowhere near the real ceiling, so nothing is capped and
      // the button stays live.
      expect(container.textContent).not.toContain(t('previewRowLimit', { rows: MAX_PREVIEW_ROWS }))
    } finally {
      unmount()
    }
  })
})
