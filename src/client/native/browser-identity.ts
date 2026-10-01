/** Browser identity recovery: native layouts persist tabs, but not navigation params. */
import type { NativeTabParams } from './tab-adapter.tsx'
import { loadViewState, saveViewIdentity } from '../browser-mode.ts'

/** Recover only the Browser's public site address; an explicit new navigation wins. */
export function browserIdentityParams(sessionId: string | undefined, tabId: string, params: NativeTabParams | undefined): NativeTabParams | undefined {
  if (sessionId === undefined) return params
  try {
    const saved = loadViewState(sessionId, tabId)
    if (saved === null || typeof saved.siteKey !== 'string' || typeof saved.url !== 'string') return params
    if (!['http:', 'https:'].includes(new URL(saved.url).protocol)) return params
    const meta = typeof params?.meta === 'object' && params.meta !== null ? params.meta as Record<string, unknown> : {}
    if (typeof meta.siteKey === 'string' && meta.siteKey !== saved.siteKey) return params
    const address = typeof meta.url === 'string' ? meta.url : params?.url
    if (address !== undefined && address !== saved.url) return params
    return { ...params, title: params?.title ?? saved.siteKey, url: address ?? saved.url,
      meta: { siteKey: saved.siteKey, url: saved.url, ...meta } }
  } catch { return params }
}

/** Store the identity even if this native tab has never mounted its body. */
export function rememberBrowserIdentity(sessionId: string | undefined, tabId: string, siteKey: string, address: unknown): void {
  if (sessionId === undefined || typeof address !== 'string') return
  try {
    const url = new URL(address)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return
    saveViewIdentity(sessionId, tabId, siteKey, address)
  } catch { /* Storage may be unavailable; the live metadata still carries the identity. */ }
}
