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
import { TextEditor, HTML_IFRAME_SANDBOX } from '../src/client/TextEditor.tsx'
import { BrowserView, BrowserEmbedBlocked, BROWSER_IFRAME_SANDBOX, iframeSandboxFor } from '../src/client/BrowserView.tsx'
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

describe('browser tab iframe sandbox', () => {
  function tabProps(store: ReturnType<typeof createSidebarStore>, path?: string) {
    return {
      ctx: CTX,
      store,
      scope: { sessionId: 's1', cwd: '/p' },
      tab: { id: 'browser:1', type: 'browser', title: 'Browser', ...(path !== undefined ? { path } : {}) },
      visible: true,
    }
  }

  it('renders the start page before any navigation (no iframe, no auto-load)', () => {
    const store = createSidebarStore()
    const html = renderToString(createElement(BrowserView, tabProps(store)))
    expect(html).not.toContain('<iframe')
    expect(html).toContain('输入网址开始浏览')
  })

  it('sandboxes the iframe without same-origin / top-navigation', () => {
    const store = createSidebarStore()
    const html = renderToString(createElement(BrowserView, tabProps(store, 'https://example.com/')))
    const iframe = /<iframe[^>]*>/.exec(html)?.[0]
    expect(iframe).toBeDefined()
    expect(iframe).toContain(`sandbox="${BROWSER_IFRAME_SANDBOX}"`)
    expect(BROWSER_IFRAME_SANDBOX).not.toContain('allow-same-origin')
    expect(BROWSER_IFRAME_SANDBOX).not.toContain('allow-top-navigation')
    expect(iframe).toContain('src="https://example.com/"')
    expect(iframe).toContain('referrerPolicy="no-referrer"')
    expect(iframe).toContain('allow=""')
  })

  it('never grants allow-same-origin to the GUI\'s own origin, even when allowlisted', () => {
    // A bare-host allowlist entry covers every port, so an allowlisted GUI
    // host also matches the GUI's exact origin — but a page at the GUI's
    // origin must keep the opaque-origin sandbox: allow-same-origin there
    // would make it same-origin with its parent and hand it GUI storage/API.
    const allowlist = 'localhost'
    const guiOrigin = 'http://localhost:5173'
    expect(iframeSandboxFor('http://localhost:5173/', allowlist, guiOrigin)).toBe(BROWSER_IFRAME_SANDBOX)
    expect(iframeSandboxFor('http://localhost:5173/', allowlist, guiOrigin)).not.toContain('allow-same-origin')
    // Other allowlisted loopback origins still get the same-origin token.
    const sandbox = iframeSandboxFor('http://localhost:4000/', allowlist, guiOrigin)
    expect(sandbox).not.toBe(BROWSER_IFRAME_SANDBOX)
    expect(sandbox).toContain('allow-same-origin')
    // A different (non-GUI) origin with no allowlist stays opaque.
    expect(iframeSandboxFor('https://example.com/', '', guiOrigin)).toBe(BROWSER_IFRAME_SANDBOX)
  })

  it('renders the live sandbox status row with the temporary unlock action', () => {
    const store = createSidebarStore()
    const html = renderToString(createElement(BrowserView, tabProps(store, 'https://example.com/')))
    expect(html).toContain('沙箱模式：已启用')
    expect(html).toContain('临时解锁（不安全）')
  })

  it('offers the open-in-browser action once a URL is loaded (disabled before navigation)', () => {
    const store = createSidebarStore()
    // No URL yet: the external-open action is disabled.
    const start = renderToString(createElement(BrowserView, tabProps(store)))
    expect(start).toContain('aria-label="在浏览器中打开"')
    expect(start).toContain('title="在浏览器中打开" disabled=""')
    // With a URL: enabled.
    const loaded = renderToString(createElement(BrowserView, tabProps(store, 'https://example.com/')))
    expect(loaded).toContain('aria-label="在浏览器中打开"')
    expect(loaded).not.toContain('title="在浏览器中打开" disabled=""')
  })

  it('drops the sandbox attribute with the red warning when the setting is on (no restore action — the global setting owns it)', () => {
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), browserNoSandbox: true })
    const html = renderToString(createElement(BrowserView, tabProps(store, 'https://example.com/')))
    const iframe = /<iframe[^>]*>/.exec(html)?.[0]
    expect(iframe).toBeDefined()
    expect(iframe).not.toContain('sandbox=')
    expect(html).toContain('沙箱已关闭')
    expect(html).not.toContain('临时解锁（不安全）')
    expect(html).not.toContain('恢复沙箱')
  })
})

describe('browser embed-refusal panel', () => {
  it('explains the refusal with the host, the reason, and both actions', () => {
    const html = renderToString(createElement(BrowserEmbedBlocked, {
      url: 'https://arxiv.org/abs/2401.10001',
      onOpenInBrowser: () => {},
      onLoadAnyway: () => {},
    }))
    expect(html).toContain('arxiv.org 拒绝了嵌入请求')
    expect(html).toContain('X-Frame-Options / frame-ancestors')
    expect(html).toContain('在浏览器中打开')
    expect(html).toContain('仍然加载')
  })
})
