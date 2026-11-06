/**
 * The main conversation's "work details" preference, read from the host's
 * public cross-plugin settings service and applied to the side transcript.
 *
 * The host stores two fields in its `ui-chat` settings namespace — the
 * presentation mode (`transcriptView`) and an independent collapse timing
 * (`collapseTiming`) — and its own chat view folds a settled Turn's process
 * rows behind one control. The side chat rendered every Turn fully expanded and
 * read no preference at all, so the same conversation looked twice as busy in
 * the panel as in the main pane.
 *
 * Source and normalization mirror the host exactly
 * (`ui-chat/src/client/transcript-view.ts` `adopt()` and `chat-settings.ts`):
 * - `ctx.get('configForms')` → `.get('ui-chat')` is the PUBLIC service (a
 *   structural probe — not an `inject`, and no value-import of the settings
 *   package, which the client bundle may not take);
 * - the two legacy saved values (`normal` / `expanded`) read as `detailed`;
 * - a missing service, a form that is not `ready`, or an unusable value keep
 *   the client default (`detailed` on the Web, `standard` on the desktop shell,
 *   exactly like the host's own construction);
 * - `collapseTiming` defaults to `completion`.
 *
 * The reading is LIVE: the form's `subscribe()` drives a state update, so a
 * settings change re-renders the mounted transcript instead of waiting for a
 * remount.
 */
import { useEffect, useMemo, useState } from 'react'
import type { Context } from '../context-types.ts'

/** Work-details presentation modes (host `TRANSCRIPT_VIEW_MODES`). */
export type SidechatWorkDetailsMode = 'compact' | 'standard' | 'detailed' | 'verbose'

/** When a completed Turn returns to its folded presentation. */
export type SidechatCollapseTiming = 'completion' | 'next-input'

/** The settings namespace the Chat target owns. */
const CHAT_NAMESPACE = 'ui-chat'

/** What the side transcript needs from the preference. */
export interface SidechatWorkDetails {
  mode: SidechatWorkDetailsMode
  collapseTiming: SidechatCollapseTiming
}

/** The client default, by shell: the desktop shell opens at `standard`
 *  (host `apply.ts`), every other client at `detailed`. */
function defaultMode(): SidechatWorkDetailsMode {
  return 'dshDesktop' in globalThis ? 'standard' : 'detailed'
}

/**
 * Normalize one saved `transcriptView` value the way the host does.
 * @param value - the raw saved value (any JSON).
 * @returns the mode to present.
 */
export function workDetailsModeOf(value: unknown): SidechatWorkDetailsMode {
  if (value === 'compact' || value === 'standard' || value === 'detailed' || value === 'verbose') return value
  // The two-mode generation's saved values read as `detailed`.
  if (value === 'normal' || value === 'expanded') return 'detailed'
  return defaultMode()
}

/**
 * Normalize one saved `collapseTiming` value.
 * @param value - the raw saved value (any JSON).
 * @returns the timing to present (`completion` when absent or unusable).
 */
export function collapseTimingOf(value: unknown): SidechatCollapseTiming {
  return value === 'next-input' ? 'next-input' : 'completion'
}

/** Whether this mode folds a settled Turn's process rows at all. */
export function foldsSettledTurns(mode: SidechatWorkDetailsMode): boolean {
  return mode !== 'verbose'
}

/** Whether this mode puts the RUNNING Turn's process detail on its line
 *  (host `liveProcessDetail`: true for `standard` and `detailed`). */
export function showsLiveProcessDetail(mode: SidechatWorkDetailsMode): boolean {
  return mode === 'standard' || mode === 'detailed'
}

/** The form face this module reads (host `ConfigForm`, structurally). */
interface ConfigFormFace {
  getSnapshot: () => { status?: unknown; value?: unknown } | undefined
  subscribe: (listener: () => void) => () => void
}

/** The settings service face (host `configForms`, structurally). */
interface ConfigFormsFace {
  get: (id: string) => ConfigFormFace | undefined
}

/** The `ui-chat` form of the composition, or undefined when there is none. */
function chatFormOf(ctx: Context): ConfigFormFace | undefined {
  try {
    return (ctx.get('configForms') as ConfigFormsFace | undefined)?.get(CHAT_NAMESPACE)
  } catch {
    return undefined
  }
}

/**
 * Read the live work-details preference.
 *
 * Deliberately NOT `useSyncExternalStore`: the host form may hand out a fresh
 * snapshot object per call (`getSnapshot()` identity is not part of its
 * contract), which would make React loop. Subscribing through local state keeps
 * the view stable whatever identity the form returns.
 * @param ctx - client context (the settings service is read off it).
 * @returns the mode and collapse timing to present.
 */
export function useSidechatWorkDetails(ctx: Context): SidechatWorkDetails {
  const form = useMemo(() => chatFormOf(ctx), [ctx])
  const [snapshot, setSnapshot] = useState(() => form?.getSnapshot())
  useEffect(() => {
    if (form === undefined) {
      setSnapshot(undefined)
      return undefined
    }
    const sync = (): void => { setSnapshot(form.getSnapshot()) }
    sync()
    return form.subscribe(sync)
  }, [form])
  return useMemo(() => {
    // A form that has not accepted values yet (`status !== 'ready'`, or a ready
    // form without a value) leaves both fields at their defaults.
    const section = snapshot?.status === 'ready' && typeof snapshot.value === 'object' && snapshot.value !== null
      ? snapshot.value as { transcriptView?: unknown; collapseTiming?: unknown }
      : undefined
    return {
      mode: workDetailsModeOf(section?.transcriptView),
      collapseTiming: collapseTimingOf(section?.collapseTiming),
    }
  }, [snapshot])
}
