/**
 * App-locale time formatting for the Feishu client renderers.
 *
 * The sidebar's own date selectors use `isZh()` rather than the browser
 * locale: the Host-backed locale preference can differ from the OS/browser
 * language, and an ISO stamp rendered by `toLocaleString()` would silently
 * follow the browser. This module is the single fallback used by both Feishu
 * renderers; S9 can still pass an explicit `formatDateTime` formatter.
 */
import { isZh } from '../../../locales.ts'

/** The BCP-47 locale used for date/time presentation (the app's zh branch). */
export function appLocaleId(): string {
  return isZh() ? 'zh-CN' : 'en-US'
}

/** Parse a millisecond timestamp or an ISO/date string without throwing. */
function dateOf(value: string | number): Date | undefined {
  if (typeof value === 'number') {
    const date = new Date(value)
    return Number.isFinite(date.getTime()) ? date : undefined
  }
  const millis = Number(value)
  if (value.trim() !== '' && Number.isFinite(millis)) {
    const date = new Date(millis)
    return Number.isFinite(date.getTime()) ? date : undefined
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed) : undefined
}

/** App-locale date + time; the raw value when it is not parseable. */
export function appDateTime(value: string | number): string {
  return dateOf(value)?.toLocaleString(appLocaleId()) ?? String(value)
}

/** App-locale date only (all-day times). */
export function appDate(value: string | number): string {
  return dateOf(value)?.toLocaleDateString(appLocaleId()) ?? String(value)
}
