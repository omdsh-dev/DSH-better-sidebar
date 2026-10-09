/**
 * The DOM half of markdown cross-file / anchor navigation, rendered through the
 * REAL TextEditor (and therefore the real host `MarkdownText`): heading slugs
 * on rendered headings, the host delegate that makes a claimed local link
 * clickable at all, the DECODED `%23` fragment carrier, same-page scrolling in
 * the preview's own container, and the parked cross-file fragment landing once
 * the target document renders.
 *
 * Why the delegate is the mechanism (and not a click listener on the
 * container): the host renderer gives a local destination a clickable element
 * ONLY when a surrounding `MarkdownDelegateProvider` supplies `openFile` —
 * otherwise the link is inert prose, and a heading fragment makes the whole
 * destination unparseable for the renderer. Both halves are asserted here,
 * including the boundary: the same markdown rendered OUTSIDE the plugin's
 * surface stays inert.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react-dom/test-utils'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { DiffPane } from '../src/client/changes/DiffPane.tsx'
import { attachLocale } from '../src/client/locales.ts'
import { createSidebarStore, allLeaves } from '../src/client/state.ts'
import { createBetterSidebarService, type FileViewerProps } from '../src/client/service.ts'
import { hideEmptyAnchors, jumpToFragment } from '../src/client/markdown-navigation.ts'
import { MARKDOWN_SURFACE_ATTR } from '../src/client/use-markdown-surface.ts'
import type { Context } from '../src/context-types.ts'

setupReactAct()

/** Minimal structural fake of the DSH LocaleService face the sidebar uses. */
class FakeLocale {
  active: string = 'en'
  getSnapshot(): { active: string } {
    return { active: this.active }
  }
  subscribe(_fn: () => void): () => void {
    return () => {}
  }
}

/**
 * A fresh session id per test (or per test GROUP — a cross-file jump parks its
 * fragment under session + path, so the source and target mounts of one case
 * must share one id).
 *
 * Why not one fixed id: the sidebar store persists each session's layout to
 * localStorage with a 200ms debounce, so an id reused across cases can load a
 * PREVIOUS case's tabs (the debounced write lands between them) — the mount
 * then starts with tabs nobody opened in it.
 */
let sessionCounter = 0
function nextSession(): string {
  sessionCounter += 1
  return `s${sessionCounter}`
}

interface Mounted {
  container: HTMLDivElement
  /** Every editor tab the sidebar currently holds (path-typed ones last). */
  tabs: () => { type: string; path?: string }[]
  unmount: () => void
}

/** The sidebar service + ctx one surface is mounted with, and a reader of the
 *  tabs an open landed: the app's own observation point, not a stub. */
function sidebarCtx(sessionId: string): {
  ctx: Context
  store: ReturnType<typeof createSidebarStore>
  tabs: () => { type: string; path?: string }[]
} {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // openTab refuses a type nobody registered.
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  store.setSession(sessionId)
  const ctx = {
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: { [sessionId]: { cwd: '/p' } } }) } },
  } as unknown as Context
  return { ctx, store, tabs: () => allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs) }
}

/**
 * Mount the real TextEditor on one markdown file, backed by the plugin's own
 * sidebar service — so a claimed link's open is observed the way the app
 * observes it (a tab landing in the store), not through a stub.
 */
function mountEditor(content: string, path: string, sessionId: string = nextSession()): Mounted {
  attachLocale(new FakeLocale())
  const { ctx, store, tabs } = sidebarCtx(sessionId)
  const props: FileViewerProps = {
    ctx,
    store,
    scope: { sessionId, cwd: '/p' },
    path,
    title: path.slice(path.lastIndexOf('/') + 1),
    viewerId: 'markdown',
    content,
  }
  const mounted = renderRoot(createElement(TextEditor, props))
  return { container: mounted.container, tabs, unmount: mounted.unmount }
}

/**
 * Mount the changes tab's inline preview on one markdown file op and flip it to
 * reading mode — the plugin's SECOND markdown surface, whose base is the op
 * target's own path.
 */
function mountReadingPane(path: string, markdown: string, sessionId: string = nextSession()): Mounted {
  attachLocale(new FakeLocale())
  const { ctx, tabs } = sidebarCtx(sessionId)
  const mounted = renderRoot(createElement(DiffPane, {
    target: {
      kind: 'op',
      path,
      op: {
        callId: 'c1', kind: 'read', path, time: 0, running: false, isError: false,
        read: `<content>1: ${markdown}\n</content>`,
      },
    },
    ctx,
    scope: { sessionId, cwd: '/p' },
    height: 300,
    onHeightCommit: () => {},
    onClose: () => {},
    onExpand: () => {},
  }))
  // Reading mode is off by default: the raw diff is what a change shows first.
  const toggle = [...mounted.container.querySelectorAll('button')]
    .find(button => button.textContent === 'Reading')
  if (toggle === undefined) throw new Error('reading toggle not found')
  click(toggle)
  return { container: mounted.container, tabs, unmount: mounted.unmount }
}

/** The plugin's markdown surface container inside a mounted editor. */
function surfaceOf(container: HTMLElement): HTMLElement {
  const surface = container.querySelector<HTMLElement>(`[${MARKDOWN_SURFACE_ATTR}]`)
  if (surface === null) throw new Error('markdown surface container not found')
  return surface
}

/** The host-rendered file link whose destination is `title`, or null. */
function fileLink(surface: HTMLElement, title: string): HTMLButtonElement | null {
  return [...surface.querySelectorAll('button')].find(button => button.title === title) ?? null
}

/** Pin one element's measured top edge (jsdom has no layout). */
function stubRectTop(element: Element, top: number): void {
  element.getBoundingClientRect = (): DOMRect => ({
    top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top,
    toJSON: () => ({}),
  }) as DOMRect
}

/** Observe every write to an element's scrollTop (jsdom accepts the write but
 *  has no layout to derive one from). */
function watchScrollTop(element: HTMLElement): () => number {
  let value = 0
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => value,
    set: (next: number) => { value = next },
  })
  return () => value
}

/** Click one element the way a reader would. */
function click(element: HTMLElement): void {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

/** Flush the microtasks the surface installer queues (pending anchor, pass). */
async function flushMicrotasks(): Promise<void> {
  await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
}

/** `scrollIntoView` is absent in jsdom; a spy proves the jump never uses it
 *  (it would drag every scrollable ancestor, i.e. the whole sidebar). */
const scrollIntoView = vi.fn()
const scrollTo = vi.fn()
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView })
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo
})
afterEach(() => {
  scrollIntoView.mockClear()
  scrollTo.mockClear()
  attachLocale(undefined)
  document.body.innerHTML = ''
  // The layout persistence above outlives a test (its debounced write may land
  // after the unmount); a later case must not inherit it.
  localStorage.clear()
})

describe('the markdown preview surface', () => {
  it('slugs rendered headings like GitHub, keeps authored ids, and reserves them first', () => {
    const mounted = mountEditor([
      '## Hello, World!',
      '',
      '## Hello, World!',
      '',
      '### 中文标题',
      '',
      '<h2 id="custom">Authored</h2>',
      '',
      '<a id="anchor"></a>',
      '',
      '## custom',
      '',
    ].join('\n'), '/p/docs/README.md')
    const surface = surfaceOf(mounted.container)
    const ids = [...surface.querySelectorAll('h2, h3')].map(heading => heading.id)
    // The host renders bare `h1..h6` (no ids) — every id below is the plugin's.
    expect(ids).toEqual(['hello-world', 'hello-world-1', '中文标题', 'custom', 'custom-1'])
    // The authored id is kept AND reserved: the later heading with the same
    // slug gets the suffix instead of stealing it.
    expect(surface.querySelector('h2#custom')?.textContent).toBe('Authored')
    mounted.unmount()
  })

  it('collapses an explicit empty anchor without losing its id, and deep links still land', async () => {
    const mounted = mountEditor('intro <a id="hidden-anchor"></a> tail\n\n[jump](#hidden-anchor)\n', '/p/docs/README.md')
    const surface = surfaceOf(mounted.container)
    // The raw-HTML pass ran before the surface pass observed the tree.
    await flushMicrotasks()
    const hidden = surface.querySelector<HTMLAnchorElement>('a#hidden-anchor')
    expect(hidden?.hidden).toBe(true)
    // …and the id is still there, so `#hidden-anchor` keeps resolving: the jump
    // measures the nearest VISIBLE ancestor (a hidden box has no position).
    expect(hidden?.id).toBe('hidden-anchor')
    const scrollTop = watchScrollTop(surface)
    stubRectTop(surface, 0)
    stubRectTop(hidden!.parentElement!, 260)
    click(fileLink(surface, '#hidden-anchor')!)
    expect(scrollTop()).toBe(252)
    mounted.unmount()
  })

  it('renders a claimed .md link as the host file link and opens the DOCUMENT-relative target', () => {
    const mounted = mountEditor('See [other](./other.md) and [abs](/p/docs/third.md).\n', '/p/docs/README.md')
    const surface = surfaceOf(mounted.container)
    const link = fileLink(surface, './other.md')
    expect(link).not.toBeNull()
    // The claim is the host's file link, not an anchor: nothing here navigates
    // the page away (the host renders a button).
    expect(link?.closest('a')).toBeNull()
    click(link!)
    // `/p/docs/other.md`, NOT `/p/other.md`: the base is the rendered document.
    expect(mounted.tabs().map(tab => tab.path)).toEqual(['/p/docs/other.md'])
    click(fileLink(surface, '/p/docs/third.md')!)
    expect(mounted.tabs().map(tab => tab.path)).toEqual(['/p/docs/other.md', '/p/docs/third.md'])
    mounted.unmount()
  })

  it('keeps remote links as links and non-markdown local links as inert text', () => {
    const mounted = mountEditor([
      '[site](https://example.com/a.md)',
      '',
      '[notes](./notes.txt)',
      '',
      '[image](./pic.png)',
      '',
      '[dir](./docs)',
      '',
    ].join('\n'), '/p/docs/README.md')
    const surface = surfaceOf(mounted.container)
    // http(s) keeps today's behavior verbatim: a real anchor to the destination.
    const external = surface.querySelector<HTMLAnchorElement>('a[href="https://example.com/a.md"]')
    expect(external).not.toBeNull()
    // Everything the plugin does not claim stays what it renders as today —
    // plain text — instead of a file-mention button that would do nothing.
    for (const label of ['notes', 'image', 'dir']) {
      expect(surface.textContent, label).toContain(label)
    }
    for (const destination of ['./notes.txt', './pic.png', './docs']) {
      expect(fileLink(surface, destination), destination).toBeNull()
    }
    // …and no link of the document produced a tab.
    click(surface)
    expect(mounted.tabs()).toEqual([])
    mounted.unmount()
  })

  it('scopes the claim to the plugin surface: the same markdown elsewhere stays inert', () => {
    const bare = renderRoot(createElement(MarkdownText, {
      text: '[other](./other.md)\n',
      labels: { code: { copyLabel: 'c', copiedLabel: 'C' }, footnotes: '' },
    }))
    // No provider, no claim: the host renders the local destination as text
    // (this is exactly why the plugin has to wrap its own surfaces).
    expect(bare.container.querySelector('button')).toBeNull()
    expect(bare.container.querySelector('a')).toBeNull()
    expect(bare.container.textContent).toContain('other')
    bare.unmount()
  })

  it('scrolls the preview container itself for a same-page fragment', () => {
    const mounted = mountEditor('[jump](#目标标题)\n\n## 目标标题\n', '/p/docs/README.md')
    const surface = surfaceOf(mounted.container)
    const heading = surface.querySelector<HTMLElement>('h2#目标标题')!
    const scrollTop = watchScrollTop(surface)
    stubRectTop(heading, 120)
    // The link is a host file link whose destination the delegate decodes back
    // into a same-document fragment.
    const link = fileLink(surface, '#目标标题')
    expect(link).not.toBeNull()
    click(link!)
    expect(scrollTop()).toBe(112) // 120 - the 8px padding
    // Never the window, never scrollIntoView (that would scroll every ancestor).
    expect(scrollTo).not.toHaveBeenCalled()
    expect(scrollIntoView).not.toHaveBeenCalled()
    // A same-page jump opens nothing.
    expect(mounted.tabs()).toEqual([])
    mounted.unmount()
  })

  it('ignores a fragment the document does not carry', () => {
    const mounted = mountEditor('[jump](#missing)\n\n## Present\n', '/p/docs/README.md')
    const surface = surfaceOf(mounted.container)
    const scrollTop = watchScrollTop(surface)
    click(fileLink(surface, '#missing')!)
    expect(scrollTop()).toBe(0)
    expect(scrollTo).not.toHaveBeenCalled()
    expect(mounted.tabs()).toEqual([])
    mounted.unmount()
  })

  it('scrolls the nearest SCROLLABLE ANCESTOR, not the container itself', () => {
    // jsdom applies no stylesheet and derives no overflow from layout, so the
    // one way to reach the "found an ancestor scroller" branch is to inject the
    // computed style the browser would report. Without this case the branch was
    // unreachable from the shipped suite: making `scrollHostFor` return the
    // container unconditionally left all 33 cases green.
    const scroller = document.createElement('div')
    const container = document.createElement('div')
    scroller.append(container)
    document.body.append(scroller)
    const containerScrollTop = watchScrollTop(container)
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 })
    scroller.scrollTop = 20
    const computed = window.getComputedStyle.bind(window)
    const style = vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element: Element): CSSStyleDeclaration => {
        const real = computed(element as HTMLElement)
        if (element === scroller) {
          return { ...real, overflowY: 'auto', overflow: 'auto' } as unknown as CSSStyleDeclaration
        }
        return { ...real, overflowY: 'visible', overflow: 'visible' } as unknown as CSSStyleDeclaration
      },
    )
    try {
      const target = document.createElement('h2')
      container.append(target)
      // The scroll offset is measured against the SCROLLER's own box and its
      // live scrollTop: 480 - 100 + 20 - 8 = 392.
      stubRectTop(scroller, 100)
      stubRectTop(container, 100)
      stubRectTop(target, 480)
      expect(jumpToFragment(container, 'anything')).toBe(false) // no such id yet
      target.id = 'found'
      expect(jumpToFragment(container, 'found')).toBe(true)
      expect(scroller.scrollTop).toBe(392)
      // The container is NOT the scroller: it must not be written to at all.
      expect(containerScrollTop()).toBe(0)
      expect(scrollTo).not.toHaveBeenCalled()
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      style.mockRestore()
    }
  })

  it('scrolls the container itself when no ancestor scrolls', () => {
    // The fallback half of the same branch: with every ancestor reporting
    // `visible`, the container is the scroller (no `window.scrollTo`, no
    // `scrollIntoView` — either would drag the whole sidebar).
    const mounted = mountEditor('[jump](#目标标题)\n\n## 目标标题\n', '/p/docs/README.md')
    const surface = surfaceOf(mounted.container)
    const scrollTop = watchScrollTop(surface)
    stubRectTop(surface, 60)
    stubRectTop(surface.querySelector('h2')!, 260)
    click(fileLink(surface, '#目标标题')!)
    expect(scrollTop()).toBe(192)
    expect(scrollTo).not.toHaveBeenCalled()
    expect(scrollIntoView).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it('drives the ancestor scroller through the real surface too', () => {
    // The same branch, end to end: the real TextEditor's own delegate, a click
    // on a real rendered link, and the write landing on the surrounding pane.
    const mounted = mountEditor('[jump](#目标标题)\n\n## 目标标题\n', '/p/docs/README.md')
    const scroller = document.createElement('div')
    document.body.append(scroller)
    scroller.append(mounted.container)
    const surface = surfaceOf(mounted.container)
    const heading = surface.querySelector<HTMLElement>('h2#目标标题')!
    const containerScrollTop = watchScrollTop(surface)
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 })
    const computed = window.getComputedStyle.bind(window)
    const style = vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element: Element): CSSStyleDeclaration => {
        const real = computed(element as HTMLElement)
        const overflowY = element === scroller ? 'auto' : 'visible'
        return { ...real, overflowY, overflow: overflowY } as unknown as CSSStyleDeclaration
      },
    )
    try {
      stubRectTop(scroller, 0)
      stubRectTop(surface, 0)
      stubRectTop(heading, 300)
      scroller.scrollTop = 0
      click(fileLink(surface, '#目标标题')!)
      expect(scroller.scrollTop).toBe(292)
      expect(containerScrollTop()).toBe(0)
      expect(scrollTo).not.toHaveBeenCalled()
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      style.mockRestore()
    }
    mounted.unmount()
  })

  it('opens a line destination without treating its line as an anchor', async () => {
    // `#L24` is the host's own grammar (the parser hands it over as
    // `options.line`), so the rewriter must leave it alone and the open must
    // not park a fragment named "L24".
    const session = nextSession()
    const source = mountEditor('[jump](./other.md#L24)\n', '/p/docs/README.md', session)
    const link = fileLink(surfaceOf(source.container), './other.md')
    expect(link).not.toBeNull()
    click(link!)
    expect(source.tabs().map(tab => tab.path)).toEqual(['/p/docs/other.md'])
    source.unmount()

    const target = mountEditor('## L24 is not a heading\n', '/p/docs/other.md', session)
    const scrollTop = watchScrollTop(surfaceOf(target.container))
    stubRectTop(surfaceOf(target.container).querySelector('h2')!, 300)
    await flushMicrotasks()
    expect(scrollTop()).toBe(0)
    target.unmount()
  })

  it('claims links in the changes reading pane too, based on the op target path', () => {
    // The second surface: its markdown comes from a tool op, and its relative
    // base is the read file's own path.
    const mounted = mountReadingPane('/p/docs/README.md', 'See [other](./other.md).')
    const surface = surfaceOf(mounted.container)
    const link = fileLink(surface, './other.md')
    expect(link).not.toBeNull()
    click(link!)
    expect(mounted.tabs().map(tab => tab.path)).toEqual(['/p/docs/other.md'])
    mounted.unmount()
  })

  it('opens a cross-file target and lands the parked fragment once that file renders', async () => {
    // The link's fragment cannot reach the host parser as authored — this is
    // the `%23` carrier, end to end: rewrite → host decode → delegate → park.
    const session = nextSession()
    const source = mountEditor('[jump](./other.md#目标标题)\n', '/p/docs/README.md', session)
    const link = fileLink(surfaceOf(source.container), './other.md#目标标题')
    expect(link).not.toBeNull()
    click(link!)
    expect(source.tabs().map(tab => tab.path)).toEqual(['/p/docs/other.md'])
    source.unmount()

    // The target document renders in its own editor (same session, same path
    // spelling the open used) and takes the parked fragment.
    const target = mountEditor('## 目标标题\n', '/p/docs/other.md', session)
    const targetSurface = surfaceOf(target.container)
    const scrollTop = watchScrollTop(targetSurface)
    const heading = targetSurface.querySelector<HTMLElement>('h2#目标标题')!
    stubRectTop(heading, 200)
    await flushMicrotasks()
    expect(scrollTop()).toBe(192)
    expect(scrollTo).not.toHaveBeenCalled()
    expect(scrollIntoView).not.toHaveBeenCalled()
    target.unmount()

    // Consumed: a later mount of the same document does not jump again.
    const again = mountEditor('## 目标标题\n', '/p/docs/other.md', session)
    const againSurface = surfaceOf(again.container)
    const againScrollTop = watchScrollTop(againSurface)
    stubRectTop(againSurface.querySelector<HTMLElement>('h2#目标标题')!, 200)
    await flushMicrotasks()
    expect(againScrollTop()).toBe(0)
    again.unmount()
  })

  it('renders a CRLF document exactly like its LF twin, ids included', () => {
    // Line endings are not content. The scanner half of this invariant is
    // pinned in tests/markdown-crlf.spec.ts; this is the half a reader sees,
    // through the real renderer — and it is asserted SYNCHRONOUSLY after the
    // mount, because that is when the surface pass runs: every id it writes
    // onto the headings is thrown away if the preview re-renders the document
    // under the other spelling one commit later. That is what a CRLF file used
    // to do — CodeMirror holds every document with LF endings, so the draft it
    // snapshots differs from the loaded bytes by line endings alone, and the
    // host renderer rebuilds the markdown elements it owns on that change.
    const lf = [
      '# 标题',
      '',
      '<div align="center">',
      '  <img alt="badge" src="https://img.shields.io/badge/x-y-blue" />',
      '</div>',
      '',
      '## 🚀 安装',
      '',
      'See [other](./other.md#安装).',
      '',
    ].join('\n')
    /** Everything the surface pass and the delegate are responsible for. */
    const shapeOf = (text: string): Record<string, unknown> => {
      const mounted = mountEditor(text, '/p/README.md')
      const surface = surfaceOf(mounted.container)
      const shape = {
        ids: [...surface.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].map(heading => heading.id),
        htmlSegments: surface.querySelectorAll('[data-dsh-html-segment]').length,
        // Whitespace-normalized: a raw-HTML run's own last line keeps its `\r`
        // in the CRLF spelling, and the sanitizer turns that terminator into a
        // whitespace text node inside the rendered leaf. Invisible (browsers
        // collapse it), so the reader-visible text is what is compared.
        text: (surface.textContent ?? '').replace(/\s+/g, ' ').trim(),
        claimedLinks: [...surface.querySelectorAll<HTMLButtonElement>('button')]
          .map(button => button.title)
          .filter(title => title.startsWith('./')),
      }
      mounted.unmount()
      return shape
    }
    const crlf = shapeOf(lf.replace(/\n/g, '\r\n'))
    // Guard the guard: the fixture really does exercise both halves — a
    // heading that slugs to its own text, one whose id carries the space the
    // emoji left behind, and a claimed `.md` link carrying a heading fragment.
    expect(crlf.ids).toEqual(['标题', '-安装'])
    expect(crlf.claimedLinks).toEqual(['./other.md#安装'])
    expect(shapeOf(lf)).toEqual(crlf)
  })

  it('resolves every README anchor from a CRLF copy, on every lane', () => {
    // The acceptance case below reads whatever line endings the checkout has,
    // so on the ubuntu/macOS lanes it never sees the spelling the `ci-windows`
    // lane checks out. This copy pins that spelling on EVERY lane, and it
    // asserts synchronously for the reason given in the case above.
    const crlf = readFileSync(join(process.cwd(), 'README.md'), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\n/g, '\r\n')
    const mounted = mountEditor(crlf, '/p/README.md')
    const surface = surfaceOf(mounted.container)
    const headings = [...surface.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')]
    const tocAnchors = crlf.split(/\r?\n/).slice(34, 44)
      .flatMap(line => [...line.matchAll(/\]\((#[^)\s]*)\)/g)])
      .map(match => match[1] ?? '')
      .filter(anchor => anchor !== '')
    expect(tocAnchors.length).toBeGreaterThanOrEqual(15)

    const unresolved = tocAnchors.filter((anchor) => {
      const fragment = decodeURIComponent(anchor.slice(1))
      const heading = headings.find(candidate => candidate.id === fragment)
      const link = [...surface.querySelectorAll<HTMLButtonElement>('button')].find(button => button.title === anchor)
      return heading === undefined || link === undefined
    })
    expect(unresolved).toEqual([])
    mounted.unmount()
  })

  it('resolves and scrolls for EVERY table-of-contents anchor of the repo\u2019s own READMEs', () => {
    // The acceptance case for the slug fix, through the real renderer: the
    // READMEs are the documents whose anchors were 0/15 before it (the heading
    // `🚀 安装` got the id `安装` while its contents entry pointed at `#-安装`,
    // so the click was claimed and then did nothing). The probe takes each
    // TOC bullet's link, finds the heading with that very id, and requires the
    // click to move the surface's own scroller.
    for (const name of ['README.md', 'README_EN.md']) {
      const mounted = mountEditor(readFileSync(join(process.cwd(), name), 'utf8'), `/p/${name}`)
      const surface = surfaceOf(mounted.container)
      const headings = [...surface.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')]
      // CRLF checkout: a README line carries a `\r` terminator, so split on
      // both endings. (The anchor pattern below happens to survive a trailing
      // `\r` — `\s` is excluded from the destination — but the slice must not
      // depend on that accident.)
      const tocLines = readFileSync(join(process.cwd(), name), 'utf8').split(/\r?\n/).slice(34, 44)
      const tocAnchors = tocLines.flatMap(line => [...line.matchAll(/\]\((#[^)\s]*)\)/g)])
        .map(match => match[1] ?? '')
        .filter(anchor => anchor !== '')
      expect(tocAnchors.length, name).toBeGreaterThanOrEqual(15)

      stubRectTop(surface, 0)
      const readScrollTop = watchScrollTop(surface)
      const unresolved: string[] = []
      for (const anchor of tocAnchors) {
        const fragment = decodeURIComponent(anchor.slice(1))
        const heading = headings.find(candidate => candidate.id === fragment)
        const link = [...surface.querySelectorAll<HTMLButtonElement>('button')].find(button => button.title === anchor)
        if (heading === undefined || link === undefined) {
          unresolved.push(`${anchor} (id=${heading === undefined ? 'missing' : 'ok'}, link=${link === undefined ? 'missing' : 'ok'})`)
          continue
        }
        stubRectTop(heading, 300)
        surface.scrollTop = 0
        click(link)
        if (readScrollTop() === 0) unresolved.push(`${anchor} (click did not scroll)`)
      }
      expect(unresolved, name).toEqual([])
      mounted.unmount()
    }
  })
})

describe('the document pass', () => {
  it('measures a collapsed anchor through its nearest visible ancestor', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p id="wrapper"><a id="empty"></a></p>'
    hideEmptyAnchors(root)
    const empty = root.querySelector<HTMLElement>('a#empty')!
    expect(empty.hidden).toBe(true)
    // A hidden element has no box of its own: the paragraph carries the
    // position, and that is what the jump must measure.
    stubRectTop(root, 0)
    stubRectTop(empty, 0)
    stubRectTop(root.querySelector<HTMLElement>('p#wrapper')!, 300)
    const scrollTop = watchScrollTop(root)
    expect(jumpToFragment(root, 'empty')).toBe(true)
    expect(scrollTop()).toBe(292)
  })

  it('opens a collapsed details block a fragment lives in', () => {
    const root = document.createElement('div')
    root.innerHTML = '<details><summary>more</summary><h2 id="deep">Deep</h2></details>'
    stubRectTop(root, 0)
    expect(jumpToFragment(root, 'deep')).toBe(true)
    expect(root.querySelector('details')?.hasAttribute('open')).toBe(true)
  })
})
