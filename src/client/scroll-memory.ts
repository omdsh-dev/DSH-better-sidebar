/**
 * Per-file scroll-position memory for the viewer surfaces. Each surface
 * stores its own `scrollTop` under a localStorage key scoped by session and
 * file path, so switching tabs or conversations — which remounts the viewer
 * and recreates the editor — restores the last position instead of jumping
 * back to the top of the file.
 */

const PREFIX = 'dsh-better-sidebar:scroll'

/** The storage key for one (session, file, surface) triple. */
export function scrollKey(sessionId: string, path: string, surface: 'editor' | 'preview'): string {
  return `${PREFIX}:${sessionId}:${path}${surface === 'preview' ? ':md' : ''}`
}

/** Read a stored scrollTop (null when absent, malformed, or negative). */
export function readScrollTop(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as { top?: unknown } | null
    if (parsed === null || typeof parsed !== 'object') return null
    return typeof parsed.top === 'number' && Number.isFinite(parsed.top) && parsed.top >= 0
      ? parsed.top
      : null
  } catch {
    return null
  }
}

/** Write the current scrollTop under `key` (storage failures are no-ops). */
export function writeScrollTop(key: string, top: number): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ top, at: Date.now() }))
  } catch {
    /* storage unavailable */
  }
}

/**
 * Restore `target` into `el` once it has measurable overflow (the content is
 * laid out asynchronously after mount): one rAF pass plus one late fallback,
 * whichever observes the scroll height first. No-op for null targets.
 */
export function scheduleScrollRestore(el: HTMLElement, target: number | null): void {
  if (target === null) return
  let done = false
  const restore = (): void => {
    if (done) return
    const max = el.scrollHeight - el.clientHeight
    if (max <= 0) return
    el.scrollTop = Math.min(target, max)
    done = true
  }
  requestAnimationFrame(restore)
  setTimeout(restore, 150)
}
