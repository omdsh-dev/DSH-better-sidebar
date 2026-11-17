/**
 * HtmlPreviewFrame tests: the browser / unsandboxed paths keep the exact
 * route-src iframe; the desktop sandboxed path fetches the document and its
 * local assets from the top frame, frames a sandboxed blob, and revokes it.
 * A failed document fetch falls back to the route src.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act } from 'react-dom/test-utils'
import { HtmlPreviewFrame } from '../src/client/HtmlPreviewFrame.tsx'
import { HTML_IFRAME_SANDBOX } from '../src/client/html-preview.ts'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

const SRC = 'dsh-app://app/sidebar/html/s1/p/docs/index.html'
const ORIGIN = 'dsh-app://app/'

/** Resolve after the effect's fetch chain has had a turn. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Install a fetch that serves one HTML document plus one image. */
function stubFetch(options: { htmlOk?: boolean } = {}): { calls: string[]; restore: () => void } {
  const calls: string[] = []
  const original = globalThis.fetch
  const fetchMock = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    if (url.endsWith('/index.html')) {
      const ok = options.htmlOk !== false
      return {
        ok,
        status: ok ? 200 : 403,
        text: async () => '<!doctype html><img src="./pic.png">',
        headers: new Headers(),
      } as unknown as Response
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      headers: new Headers({ 'content-type': 'image/png' }),
    } as unknown as Response
  }
  vi.stubGlobal('fetch', fetchMock)
  return { calls, restore: () => { globalThis.fetch = original } }
}

let root: Root | undefined

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount())
    root = undefined
  }
  vi.unstubAllGlobals()
  delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
  delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
})

describe('HtmlPreviewFrame', () => {
  it('renders the route-src iframe on a normal web page', () => {
    const html = renderToString(createElement(HtmlPreviewFrame, {
      src: '/sidebar/html/s1/p/a/index.html',
      title: 'index.html',
      className: 'frame',
      sandboxed: true,
      baseUrl: 'http://localhost/',
    }))
    const iframe = /<iframe[^>]*>/.exec(html)?.[0]
    expect(iframe).toBeDefined()
    expect(iframe).toContain('src="/sidebar/html/s1/p/a/index.html"')
    expect(iframe).toContain(`sandbox="${HTML_IFRAME_SANDBOX}"`)
    expect(iframe).toContain('referrerPolicy="no-referrer"')
    expect(iframe).toContain('allow=""')
  })

  it('keeps the route-src iframe when the desktop sandbox is explicitly off', () => {
    const html = renderToString(createElement(HtmlPreviewFrame, {
      src: SRC,
      title: 'index.html',
      className: 'frame',
      sandboxed: false,
      baseUrl: ORIGIN,
    }))
    const iframe = /<iframe[^>]*>/.exec(html)?.[0]
    expect(iframe).toBeDefined()
    expect(iframe).toContain(`src="${SRC}"`)
    expect(iframe).not.toContain('sandbox=')
  })

  it('inlines the document and local assets into a sandboxed blob in the desktop shell', async () => {
    const { calls } = stubFetch()
    const created: Blob[] = []
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => { created.push(blob); return 'blob:mock-1' },
    })
    const revoke = vi.fn()
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })

    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(createElement(HtmlPreviewFrame, {
        src: SRC,
        title: 'index.html',
        className: 'frame',
        sandboxed: true,
        baseUrl: ORIGIN,
      }))
      await flush()
    })

    const iframe = container.querySelector('iframe')
    expect(iframe, 'the preview must render one iframe').not.toBeNull()
    expect(iframe?.getAttribute('src')).toBe('blob:mock-1')
    expect(iframe?.getAttribute('sandbox')).toBe(HTML_IFRAME_SANDBOX)
    expect(iframe?.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(calls[0]).toBe(SRC)
    expect(calls).toContain('dsh-app://app/sidebar/html/s1/p/docs/pic.png')
    expect(created).toHaveLength(1)
    const html = await created[0]!.text()
    expect(html).toContain('data:image/png;base64,AQID')

    act(() => root?.unmount())
    root = undefined
    expect(revoke).toHaveBeenCalledWith('blob:mock-1')
    container.remove()
  })

  it('falls back to the route src when the document fetch fails', async () => {
    stubFetch({ htmlOk: false })
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(createElement(HtmlPreviewFrame, {
        src: SRC,
        title: 'index.html',
        className: 'frame',
        sandboxed: true,
        baseUrl: ORIGIN,
      }))
      await flush()
    })
    const iframe = container.querySelector('iframe')
    expect(iframe?.getAttribute('src')).toBe(SRC)
    expect(iframe?.getAttribute('sandbox')).toBe(HTML_IFRAME_SANDBOX)
    container.remove()
  })
})
