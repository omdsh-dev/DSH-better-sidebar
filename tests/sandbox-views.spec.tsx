/**
 * Sandbox-contract tests for the two built-in web surfaces (HTML preview
 * iframe and the browser tab iframe). The iframe sandbox — opaque origin,
 * no allow-same-origin, no top-navigation — is the PRIMARY security
 * boundary of both features; these tests pin the exact attribute so a
 * refactor cannot silently widen it. The side card settings can drop the
 * sandbox per-feature (warned); those paths render the warning bar and no
 * sandbox attribute.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import './browser-globals.ts'
import type { Context } from '../src/context-types.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { HTML_IFRAME_SANDBOX } from '../src/client/html-preview.ts'
import { DiffPane, HtmlRenderPreview } from '../src/client/changes/DiffPane.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { FileViewerProps } from '../src/client/service.ts'

const CTX = {} as Context

// The copy assertions below pin the zh strings: force the zh locale (the
// test environment's navigator may be the real Node one with an en locale).
beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

function viewerProps(store: ReturnType<typeof createSidebarStore>, overrides: Partial<FileViewerProps> = {}): FileViewerProps {
  return {
    ctx: CTX,
    store,
    scope: { sessionId: 's1', cwd: '/p' },
    path: '/p/a/index.html',
    title: 'index.html',
    viewerId: 'html',
    content: '<h1>hi</h1>',
    ...overrides,
  }
}

describe('HTML preview iframe sandbox', () => {
  it('renders the preview iframe with the exact sandbox tokens and no same-origin / top-navigation', () => {
    const store = createSidebarStore()
    const html = renderToString(createElement(TextEditor, viewerProps(store)))
    const iframe = /<iframe[^>]*>/.exec(html)?.[0]
    expect(iframe).toBeDefined()
    // The sandbox tokens are exactly the exported constant...
    expect(iframe).toContain(`sandbox="${HTML_IFRAME_SANDBOX}"`)
    // ...which must never contain the dangerous tokens.
    expect(HTML_IFRAME_SANDBOX).not.toContain('allow-same-origin')
    expect(HTML_IFRAME_SANDBOX).not.toContain('allow-top-navigation')
    // Cross-origin framing by construction: route-src (never srcdoc).
    expect(iframe).toContain('src="/sidebar/html/s1/p/a/index.html"')
    expect(iframe).not.toContain('srcdoc=')
    // Referrer + permissions policy stay locked even when sandboxed.
    // (React SSR renders the referrerPolicy prop camelCase as written.)
    expect(iframe).toContain('referrerPolicy="no-referrer"')
    expect(iframe).toContain('allow=""')
  })

  it('renders the live sandbox status row (green on + temporary unlock action)', () => {
    const store = createSidebarStore()
    const html = renderToString(createElement(TextEditor, viewerProps(store)))
    // Sandbox ON: the green status + the one-tap temporary unlock button.
    expect(html).toContain('沙箱模式：已启用')
    expect(html).toContain('临时解锁（不安全）')
    // No restore action while the sandbox is on.
    expect(html).not.toContain('恢复沙箱')
  })

  it('drops the sandbox attribute with the red warning when the setting is on (no restore action — the global setting owns it)', () => {
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), htmlViewerNoSandbox: true })
    const html = renderToString(createElement(TextEditor, viewerProps(store)))
    const iframe = /<iframe[^>]*>/.exec(html)?.[0]
    expect(iframe).toBeDefined()
    expect(iframe).not.toContain('sandbox=')
    // The red persistent warning copy is rendered; the temporary-unlock
    // action is NOT offered (re-enabling is the settings page's job).
    expect(html).toContain('沙箱已关闭')
    expect(html).not.toContain('临时解锁（不安全）')
    expect(html).not.toContain('恢复沙箱')
  })

  it('starts unsandboxed (red, restorable) when the default-unsafe pref is on', () => {
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), htmlViewerDefaultUnsafe: true })
    const html = renderToString(createElement(TextEditor, viewerProps(store)))
    const iframe = /<iframe[^>]*>/.exec(html)?.[0]
    expect(iframe).toBeDefined()
    expect(iframe).not.toContain('sandbox=')
    // The red warning + the one-tap restore (this is the LOCAL state).
    expect(html).toContain('沙箱已关闭')
    expect(html).toContain('恢复沙箱')
    expect(html).not.toContain('临时解锁（不安全）')
  })

  it('markdown preview keeps rendering markdown, not an iframe', () => {
    const store = createSidebarStore()
    const html = renderToString(createElement(TextEditor, viewerProps(store, {
      viewerId: 'markdown',
      path: '/p/readme.md',
      content: '# hi',
    })))
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('/sidebar/html/')
    // The markdown is rendered into markup, not framed.
    expect(html).toContain('<h1')
  })
})

describe('changes tab HTML render preview sandbox', () => {
  function opProps(path: string) {
    return {
      target: {
        kind: 'op' as const,
        path,
        op: { callId: 'c1', kind: 'read' as const, path, time: 0, running: false, isError: false, read: '<content>1: <html><body>hi</body></html></content>' },
      },
      scope: { sessionId: 's1', cwd: '/p' },
      height: 300,
      onHeightCommit: () => {},
      onClose: () => {},
      onExpand: () => {},
    }
  }

  it('render iframe is ALWAYS sandboxed (no escape hatch) with the route src, never srcdoc', () => {
    const html = renderToString(createElement(HtmlRenderPreview, { src: '/sidebar/html/s1/p/a/index.html', title: '/p/a/index.html' }))
    const iframe = /<iframe[^>]*>/.exec(html)?.[0]
    expect(iframe).toBeDefined()
    // The sandbox tokens are exactly the shared constant — and unlike the
    // editor viewer this surface has NO no-sandbox escape hatch.
    expect(iframe).toContain(`sandbox="${HTML_IFRAME_SANDBOX}"`)
    expect(HTML_IFRAME_SANDBOX).not.toContain('allow-same-origin')
    expect(HTML_IFRAME_SANDBOX).not.toContain('allow-top-navigation')
    // Cross-origin framing by construction: route-src (never srcdoc).
    expect(iframe).toContain('src="/sidebar/html/s1/p/a/index.html"')
    expect(iframe).not.toContain('srcdoc=')
    expect(iframe).toContain('referrerPolicy="no-referrer"')
    expect(iframe).toContain('allow=""')
  })

  it('html op targets show the render toggle (off by default, no iframe); non-html and error targets show none', () => {
    const htmlOpHtml = renderToString(createElement(DiffPane, opProps('/p/a/index.html')))
    expect(htmlOpHtml).toContain('渲染')
    expect(htmlOpHtml).not.toContain('<iframe')
    const md = renderToString(createElement(DiffPane, opProps('/p/a/readme.md')))
    expect(md).not.toContain('渲染')
    const errorProps = opProps('/p/a/index.html')
    const html = renderToString(createElement(DiffPane, {
      ...errorProps,
      target: { ...errorProps.target, op: { ...errorProps.target.op, isError: true, errorText: 'boom' } },
    }))
    expect(html).not.toContain('渲染')
  })
})
