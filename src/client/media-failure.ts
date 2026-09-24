/**
 * Why the media route refused a file — the diagnosis behind the image/video
 * viewers' failure panes.
 *
 * The route answers JSON errors (`{ ok: false, error: { code, message } }`),
 * so the pane can name the real cause (outside the workspace while the fence
 * is armed, over the media limit, unknown session, file gone) instead of
 * leaving the browser's `<img alt>` / dead player as the only feedback.
 * Kept free of React and the bundler's CSS import so it is unit-testable.
 */
import { t } from './locales.ts'

/**
 * Ask the media route why it refused `url`.
 *
 * @param url - the media route URL the viewer tried to render.
 * @param fetchImpl - injectable fetch (tests).
 * @returns the host's own error message, or the HTTP status when the body is
 *          not our envelope, or the generic headline when the call itself failed.
 */
export async function failureReason(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } })
    const text = await response.text()
    try {
      const body = JSON.parse(text) as { error?: { message?: unknown } }
      if (typeof body.error?.message === 'string' && body.error.message !== '') return body.error.message
    } catch {
      // Not our envelope (an intercepted HTML error page, a proxy notice, …).
    }
    return `HTTP ${response.status}`
  } catch {
    return t('mediaLoadFailed')
  }
}
