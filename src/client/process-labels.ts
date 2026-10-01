/**
 * The two labels the Tasks page borrows from the main conversation's merged
 * activity display: the LIVE line ("正在运行命令 · npm run build") and the
 * DONE title for a settled range ("已读取文件、执行了命令").
 *
 * Both are ports of the host's own composition
 * (`dsh-client-ui-chat`'s `ProcessGroupHeader` + `step-process.js`
 * `processTitle`), reading the host's `chat` dictionary through
 * {@link chatT} so the wording — and every language the host ships — matches
 * what the main chat shows for the same work.
 *
 * The translator is injectable for tests; the default is the host bridge. When
 * a key does not resolve (a host that renamed it, or a deployment where the
 * chat target never mounted) the call answers undefined and the card falls
 * back to the tool detail it already has, never to a raw `message.…` key.
 */
import type { ProcessActivitySummary } from '../process-activity.ts'
import { chatT } from './locales.ts'

/** A host-namespace translator; undefined means "this key is not available". */
export type ChatTranslate = (key: string, params?: Record<string, string | number>) => string | undefined

/** The host's `' · '` line separator (`message.turnProcess.separator`). */
function separator(t: ChatTranslate): string {
  return t('message.turnProcess.separator') ?? ' · '
}

/**
 * The live line of one stage: the running category's `…ing` wording plus the
 * running call's detail, or the "thinking" default while nothing is dispatched
 * (exactly the host's `ProcessGroupHeader` label rule).
 *
 * @param summary - the newest stage's summary (absent while the child has none).
 * @param t - host translator (defaults to the `chat` namespace bridge).
 * @returns the line, or undefined when there is nothing to say.
 */
export function liveActivityLabel(
  summary: ProcessActivitySummary | undefined,
  t: ChatTranslate = chatT,
): string | undefined {
  const activity = summary?.running ?? 'thinking'
  const preparing = summary?.preparing === true
  // The host maps its `thinking` fallback onto `prepare.tools` (there is no
  // `prepare.thinking` key).
  const label = preparing
    ? t(`message.stepProcess.prepare.${activity === 'thinking' ? 'tools' : activity}`)
    : t(`message.stepProcess.${activity}`)
  if (label === undefined) {
    // No host wording for this category: the detail is the honest fallback.
    return summary?.runningDetail === undefined || summary.runningDetail === ''
      ? undefined
      : summary.runningDetail
  }
  const detail = preparing ? '' : summary?.runningDetail ?? ''
  return detail === '' ? label : `${label}${separator(t)}${detail}`
}

/**
 * The last-resort activity text: the ranked categories spelled out as
 * `kind ×count`. It keeps a card informative when the host's `chat` wording is
 * unavailable (renamed keys, or a deployment where the chat target never
 * mounted) without inventing a second vocabulary for the normal case — the
 * category names are the host's own, and they are language-neutral.
 *
 * @param summary - a stage's summary.
 * @returns the counts text, or undefined when the stage called nothing.
 */
export function activityCountsText(
  summary: ProcessActivitySummary | undefined,
): string | undefined {
  const counts = summary?.counts ?? []
  if (counts.length === 0) return undefined
  return counts.map(entry => `${entry.kind} ×${entry.count}`).join(' · ')
}

/**
 * The settled range's title: the top three categories' `done.*` wording joined
 * the way the host joins it (two labels share the "已" prefix; more than three
 * append the "等" suffix). Counts are never printed.
 *
 * @param summary - a stage's summary.
 * @param t - host translator (defaults to the `chat` namespace bridge).
 * @returns the title, or undefined when the host wording is unavailable.
 */
export function doneActivityTitle(
  summary: ProcessActivitySummary | undefined,
  t: ChatTranslate = chatT,
): string | undefined {
  const counts = summary?.counts ?? []
  if (counts.length === 0) return t('message.stepProcess.done.thinking')
  const labels: string[] = []
  for (const { kind } of counts.slice(0, 3)) {
    const label = t(`message.stepProcess.done.${kind}`)
    if (label === undefined) return undefined
    labels.push(label)
  }
  const first = labels[0]
  if (first === undefined) return undefined
  const second = labels[1]
  if (second === undefined) return first
  // The host lowercases every label after the first for latin languages; a
  // Chinese label is unaffected by that.
  const continuation = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1)
  if (labels.length === 2) {
    const prefix = t('message.stepProcess.sharedPrefix') ?? ''
    const stripped = prefix !== '' && first.startsWith(prefix) && second.startsWith(prefix)
      ? second.slice(prefix.length)
      : second
    return t('message.stepProcess.joinTwo', { first, second: continuation(stripped) })
      ?? `${first}${separator(t)}${continuation(stripped)}`
  }
  const joined = [first, ...labels.slice(1).map(continuation)].join(t('message.stepProcess.comma') ?? ', ')
  if (counts.length > 3) return t('message.stepProcess.more', { title: joined }) ?? joined
  return joined
}
