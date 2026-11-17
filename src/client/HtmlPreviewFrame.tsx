/**
 * The HTML preview iframe shared by the editor's html viewer and the changes
 * tab. In a normal web deployment it is the historical route-src frame. In the
 * desktop shell with the sandbox ON it must be self-contained: the shell
 * rejects every `dsh-app:` request from an opaque-origin subframe (#1143),
 * so the trusted top frame fetches the document and its local resources,
 * rewrites them through `html-preview-inline.ts`, and frames the result as a
 * sandboxed `blob:` document. The sandbox attribute never gains
 * `allow-same-origin`.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { hostHttpBase, isDesktopShell } from './desktop-env.ts'
import { HTML_IFRAME_SANDBOX } from './html-preview.ts'
import { inlineHtmlDocument } from './html-preview-inline.ts'

/** One preview frame; `src` is the route URL of the saved HTML file. */
export interface HtmlPreviewFrameProps {
  /** Absolute (or page-relative) `/sidebar/html/...` URL. */
  src: string
  title: string
  className?: string
  /** Whether the sandbox attribute is applied. Off is the explicit unsafe
   *  escape hatch owned by the editor settings; the changes surface always
   *  sandboxes. */
  sandboxed: boolean
  /** The page base; injected for tests. Defaults to `hostHttpBase()`. */
  baseUrl?: string
}

/** Fetch one same-origin resource for the inliner. */
async function fetchInlineResource(url: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; mediaType: string } | undefined> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-cache', signal })
  if (!response.ok) return undefined
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() || 'application/octet-stream'
  return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType }
}

/**
 * Render the HTML preview. Browser / unsandboxed desktop: route-src iframe,
 * exactly as before. Sandboxed desktop: fetch the saved document and its local
 * assets from the top frame, then frame an inlined blob. A fetch failure falls
 * back to route-src rather than inventing a new error surface.
 */
export function HtmlPreviewFrame(props: HtmlPreviewFrameProps): ReactNode {
  const { src, title, className, sandboxed } = props
  const baseUrl = props.baseUrl ?? hostHttpBase()
  const inline = sandboxed && isDesktopShell(baseUrl)
  const [blobUrl, setBlobUrl] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!inline || src === '') {
      setBlobUrl(undefined)
      setFailed(false)
      return
    }
    const controller = new AbortController()
    let cancelled = false
    let objectUrl: string | undefined
    setBlobUrl(undefined)
    setFailed(false)
    void (async () => {
      try {
        const documentUrl = new URL(src, baseUrl).href
        const response = await fetch(documentUrl, {
          credentials: 'same-origin',
          cache: 'no-cache',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`html preview fetch failed: ${response.status}`)
        const source = await response.text()
        const inlined = await inlineHtmlDocument(source, documentUrl, (url) => fetchInlineResource(url, controller.signal))
        if (cancelled || controller.signal.aborted) return
        objectUrl = URL.createObjectURL(new Blob([inlined], { type: 'text/html;charset=utf-8' }))
        setBlobUrl(objectUrl)
      } catch {
        if (cancelled || controller.signal.aborted) return
        setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl)
    }
  }, [inline, src, baseUrl])

  const frameSrc = inline ? (failed ? src : blobUrl) : src
  return (
    <iframe
      className={className}
      src={frameSrc}
      sandbox={sandboxed ? HTML_IFRAME_SANDBOX : undefined}
      referrerPolicy="no-referrer"
      allow=""
      title={title}
    />
  )
}
