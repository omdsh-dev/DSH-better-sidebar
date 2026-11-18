/**
 * The bottom workbench's terminal: an xterm.js emulator driven by the HOST's
 * session-scoped terminal service (`ctx.webTerminals`, see
 * ./terminal-client.ts). The plugin owns no PTY — the host keeps process
 * lifetime, screen recovery and reconnection, and this view is only the
 * emulator plus the command plumbing.
 *
 * This module is the LAZY CHUNK's payload (`src/client/chunks/terminal.tsx`):
 * xterm is hundreds of KB, so it must never be reachable from the core
 * bundle. `tsdown.config.ts` builds `lib/client-terminal.js`, and
 * `tests/chunk-artifact.spec.ts` pins that xterm is inside the chunk and NOT
 * inside `lib/client.js`. Never import this file from a core-bundle module —
 * reach it through `lazyChunkComponent('terminal', …)` instead.
 *
 * The host's terminal model is frame-based, not a stream:
 *
 * - `view.state.render` holds the NEXT frame awaiting
 *   {@link HostTerminalView.acknowledge}; a `snapshot` frame carries the whole
 *   serialized screen and must be REPLAYED (reset + resize + write), an
 *   `output` frame is appended. The emulator's write callback is what releases
 *   the following frame, so an unacknowledged frame stops output for good.
 * - `mount()` attaches the DOM lifetime and returns a DETACH callback: a
 *   remount (tab switch, panel collapse, session switch) re-attaches to the
 *   same live process. Unmounting must NOT close the terminal — the host's
 *   contract is "a view survives DOM unmount; its process only ends on
 *   explicit close", and it is what makes a reload restore the same shell. The
 *   descriptor's `onClose` is the one place that does close it.
 * - The process identity is restored through the host's persisted
 *   `(sessionId, contentId) -> terminalId` binding, so the content identity
 *   must be STABLE across mounts ({@link bottomTerminalContentId}). "New
 *   terminal" deliberately mints a new one, because the old binding points at
 *   a process that is gone (host restart, terminal closed elsewhere) and
 *   reusing it would wedge the tab on `missingTerminal` forever.
 * - `write` / `resize` go through the model (which serializes them and refuses
 *   them while the view is not writable), never straight to the remote —
 *   otherwise two windows' keystrokes would interleave.
 *
 * Colors come from theme tokens: the stylesheet paints the screen from
 * `--dsw-*` / `--ds-*` and the concrete values are read back through
 * `getComputedStyle`, the same token bridge `theme.ts` documents for xterm's
 * palette. This module carries no color literal (`tests/theme.spec.ts`).
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import '@xterm/xterm/css/xterm.css'
import type { Context } from '../context-types.ts'
import type { SessionScope } from './api.ts'
import type { SidebarStore, SidebarTab } from './state.ts'
import { TERMINAL_DEFAULT_SHELL_SETTING, TERMINAL_PREFS_ID, terminalDefaultShellOf } from '../prefs-shared.ts'
import { t } from './locales.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import {
  bottomTerminalContentId, matchShellPath, nextTerminalMeta, shortShellName, terminalInstanceOf, terminalRunOf,
  terminalShellOf, webTerminals,
  type HostTerminalEnvironment, type HostTerminalView, type HostTerminalViewState,
} from './terminal-client.ts'
import { terminalClipboardKey } from './terminal-clipboard.ts'
import { TerminalShellSwitcher, canSwitchShells } from './terminal-shells.tsx'
import { updatePluginSettings } from './plugin-settings.ts'
import css from './terminal.module.css'

/** The props the bottom terminal view consumes from its tab descriptor. */
export interface TerminalBottomProps {
  ctx: Context
  /**
   * The sidebar store, used to persist a shell picked inside the terminal as the
   * descriptor's default. Optional: the view renders without it (and then a
   * switch only affects the current tab), which keeps the props honest for
   * callers that have no store to write.
   */
  store?: SidebarStore
  scope: SessionScope
  tab: SidebarTab
  visible: boolean
}

/**
 * Render the bottom workbench's terminal tab.
 * @param props - the client context, the tab's session scope and visibility.
 * @returns the terminal screen plus its status/degradation panels.
 */
export function TerminalBottomView({ ctx, store, scope, tab, visible }: TerminalBottomProps): ReactNode {
  const sessionId = scope.sessionId
  // The service is probed structurally, never injected: a deployment without
  // it keeps the tray row disabled and renders the explanation below.
  const service = useMemo(() => webTerminals(ctx), [ctx])
  const run = terminalRunOf(tab)
  const instance = terminalInstanceOf(tab)
  // One identity value serves as BOTH the host occurrence key and the content
  // identity (`view(sessionId, key, contentId)`), and the instance keeps two
  // bottom terminals in one session from sharing it (#774 follow-up).
  const contentId = bottomTerminalContentId(run, instance)
  // The descriptor's settings blob rides the sidebar snapshot's prefs, so the
  // default shell is read here rather than threaded through props: a settings
  // change has to reach an ALREADY-MOUNTED terminal (native tabs stay mounted),
  // and only the snapshot subscription can deliver that.
  const sidebar = ctx.get('betterSidebar')
  // Optional chaining throughout: `getSnapshot` runs on every render, so a
  // service that predates the state subscription (or a test double) must not
  // turn the whole tab into a thrown render.
  const prefs = useSyncExternalStore(
    useMemo(() => (listener: () => void) => sidebar?.subscribeState?.(listener) ?? (() => {}), [sidebar]),
    useCallback(() => sidebar?.getSnapshot?.().prefs, [sidebar]),
  )
  // A tab runs the shell it was PINNED to; an unpinned one follows the
  // descriptor's default shell. The default is stored as a NAME (it has to
  // survive a re-install: `bash` is `bash.exe` here and `/bin/bash` there),
  // while the host starts only a PATH from its own discovery result — anything
  // else throws when the PTY starts. So an unpinned tab spends ONE discovery
  // round trip first: `view()` freezes its shellPath at construction, and
  // starting a terminal and re-pointing it afterwards would mean closing a live
  // process on every mount.
  const pinnedShell = terminalShellOf(tab)
  const defaultShell = terminalDefaultShellOf(prefs?.pluginSettings[TERMINAL_PREFS_ID])
  const [probe, setProbe] = useState<{ readonly name: string; readonly path: string | undefined } | undefined>(undefined)
  // Settled means "there is nothing left to look up": the tab is pinned, no
  // default is configured, or the default was already resolved — to a path, or
  // to nothing, which falls back to the host's own choice.
  const shellSettled = pinnedShell !== undefined || defaultShell === undefined || probe?.name === defaultShell
  const shellPath = pinnedShell ?? probe?.path

  useEffect(() => {
    if (shellSettled || service === undefined || defaultShell === undefined) return
    const lifetime = new AbortController()
    void Promise.resolve(service.launchShells?.(sessionId, lifetime.signal)).then(
      (catalog) => {
        if (lifetime.signal.aborted) return
        setProbe({ name: defaultShell, path: matchShellPath(catalog, defaultShell) })
      },
      () => {
        // A failed discovery is not worth an error panel: the terminal still has
        // a shell to run, it is just the host's own choice.
        if (!lifetime.signal.aborted) setProbe({ name: defaultShell, path: undefined })
      },
    )
    return () => { lifetime.abort() }
  }, [defaultShell, service, sessionId, shellSettled])

  // `view()` allocates the terminal eagerly and memoizes one model per
  // (session, key) on the host side, so this memo must be the ONLY creation
  // path: a repeat `view()` for the same key is free, a new key is a new PTY.
  // It also waits for `shellSettled`: allocating before the shell is known
  // would start the host's own choice and freeze it for this occurrence.
  const model = useMemo(
    () => (shellSettled ? service?.view(sessionId, contentId, contentId, undefined, shellPath) : undefined),
    [service, sessionId, contentId, shellPath, shellSettled],
  )
  const state = useSyncExternalStore(
    useMemo(() => (callback: () => void) => model?.state.subscribe(callback) ?? (() => {}), [model]),
    useCallback(() => model?.state.getSnapshot(), [model]),
  )
  const scheme = useSyncExternalStore(subscribeColorScheme, isDarkScheme)

  // The DOM lifetime only — the detach leaves the shell running. The app's
  // own teardown for the process is the descriptor's `onClose`.
  useEffect(() => {
    if (model === undefined) return
    return model.mount()
  }, [model])

  const newTerminal = useCallback(() => {
    // Writing the generation is what mints the replacement: the memo above
    // rebuilds against a fresh content identity, so the host allocates a new
    // terminal instead of adopting a binding whose process is gone.
    ctx.get('betterSidebar')?.updateTab(tab.id, { meta: nextTerminalMeta(tab) }, sessionId)
  }, [ctx, tab, sessionId])

  // The "+" half of the switcher: a SIBLING terminal in the same workbench,
  // allocated from the host's remembered shell. `createTab` on the descriptor
  // mints the tab (a fresh instance id), so nothing here names an id.
  const openTerminal = useCallback(() => {
    ctx.get('betterSidebar')?.openTab({ type: 'terminal-bottom', target: 'bottom' }, { sessionId })
  }, [ctx, sessionId])

  // A pick inside the terminal IS the new default: the settings panel and the
  // switcher edit the same key, so there is one answer to "which shell does a
  // new bottom terminal start", not two that drift apart. The write goes
  // through the descriptor's own blob (never the host-wide
  // `localStorage['dsh.terminal.shell']`), and is skipped when the caller gave
  // no store — a view rendered without one still switches this tab.
  const rememberDefault = useCallback((name: string) => {
    if (store === undefined) return
    updatePluginSettings(store, TERMINAL_PREFS_ID, blob => ({ ...blob, [TERMINAL_DEFAULT_SHELL_SETTING]: name }))
  }, [store])

  // The tab names the shell it actually runs. The Host is the only authority on
  // what it started (a menu pick only expresses a preference), so the title
  // follows `info.shell.name` once the process reports it. Writing only on a
  // real difference keeps a remount (session switch, panel toggle) from
  // rewriting the persisted layout on every render.
  const shellName = state?.info?.shell?.name
  const shellTitle = shellName === undefined || shellName === ''
    ? undefined
    : t('terminalTitleWithShell', { name: shortShellName(shellName) })
  useEffect(() => {
    if (shellTitle === undefined || tab.title === shellTitle) return
    ctx.get('betterSidebar')?.updateTab(tab.id, { title: shellTitle }, sessionId)
  }, [ctx, shellTitle, tab.id, tab.title, sessionId])

  if (service === undefined) {
    return (
      <section className={css.root} data-dsh-bottom-terminal data-terminal-state="unavailable">
        <p className={css.notice} role="alert">{t('terminalUnavailable')}</p>
      </section>
    )
  }
  if (model === undefined || state === undefined) {
    // `model` is undefined only while the shell is still being resolved (see the
    // memo above). A blank panel would read as a broken tab, so it says what it
    // is waiting for instead — the same loading line a starting terminal shows.
    return (
      <section className={css.root} data-dsh-bottom-terminal data-terminal-state="loading">
        <p className={css.status} role="status">{t('loading')}</p>
      </section>
    )
  }
  const missing = state.issue === 'missingTerminal'
  const ended = state.info?.state === 'exited' || state.phase === 'closed'
  // The missing/ended panels carry their own message, so the pending-phase
  // status line is only for a terminal that is still worth waiting on —
  // without this gate a closed terminal would say "exited" twice.
  const status = missing || ended ? undefined : statusOf(state)

  return (
    <section className={css.root} data-dsh-bottom-terminal data-terminal-state={state.phase}>
      {canSwitchShells(service) && (
        <div className={css.switcher} data-dsh-bottom-terminal-switcher>
          <TerminalShellSwitcher
            service={service}
            ctx={ctx}
            scope={scope}
            tab={tab}
            shellName={shellName}
            onNewTerminal={openTerminal}
            onDefaultShell={rememberDefault}
          />
        </div>
      )}
      {status !== undefined && (
        <div className={css.status} role="status">
          <span>{status}</span>
          {reconnectable(state) && (
            <button
              type="button"
              className={css.action}
              onClick={() => {
                // The host's own rule: a view with a terminal but no live
                // attachment reconnects (a fresh snapshot follows); a view
                // that never got one re-runs environment/terminal lookup.
                if (state.info === undefined) void model.refresh()
                else model.connect()
              }}
            >
              {t('terminalRetry')}
            </button>
          )}
        </div>
      )}
      {(missing || ended) && (
        <div className={css.noticeBlock}>
          <p className={missing ? css.notice : css.status} role={missing ? 'alert' : 'status'}>
            {missing ? t('terminalGone') : t('exited')}
          </p>
          <button type="button" className={css.action} onClick={newTerminal}>{t('terminalNew')}</button>
        </div>
      )}
      {state.info !== undefined && !missing && (
        <TerminalScreen model={model} state={state} visible={visible} scheme={scheme} label={t('terminal')} />
      )}
      {state.error !== undefined && state.issue === undefined && (
        <p className={css.error} role="alert">{t('terminalError')}: {state.error}</p>
      )}
    </section>
  )
}

/** The one-line status for a view whose screen is not worth showing yet. */
function statusOf(state: HostTerminalViewState): string | undefined {
  switch (state.phase) {
    case 'idle':
    case 'loading':
    case 'creating':
    case 'connecting':
      return t('loading')
    case 'disconnected':
      return t('disconnected')
    case 'failed':
      return t('terminalConnectFailed')
    default:
      return undefined
  }
}

/**
 * Whether the retry affordance applies: the two phases that describe a
 * terminal that exists but is not currently attached (an ended or missing
 * terminal gets the "new terminal" action instead).
 */
function reconnectable(state: HostTerminalViewState): boolean {
  return state.phase === 'failed' || state.phase === 'disconnected'
}

interface TerminalScreenProps {
  model: HostTerminalView
  state: HostTerminalViewState
  visible: boolean
  scheme: boolean
  label: string
}

/**
 * The emulator cell, mounted once the host reported a terminal and bound to
 * the MODEL: a status change re-renders around it, only a new terminal
 * (a "new terminal" mint, or the tab remounting) opens a new emulator.
 */
function TerminalScreen({ model, state, visible, scheme, label }: TerminalScreenProps): ReactNode {
  const element = useRef<HTMLDivElement | null>(null)
  const emulator = useRef<Terminal | undefined>(undefined)
  const fit = useRef<FitAddon | undefined>(undefined)
  const lastRevision = useRef(0)
  // Read inside the xterm effects without re-creating the emulator on every
  // snapshot: the emulator is bound to the MODEL, the live flags are read
  // through this ref (the host's own terminal body does exactly this).
  const current = useRef({ state, visible })
  current.current = { state, visible }

  useLayoutEffect(() => {
    const node = element.current
    if (node === null) return
    const xterm = new Terminal({
      // The screen element is painted from theme tokens; xterm needs the
      // concrete stack, so read it back instead of hardcoding one.
      fontFamily: getComputedStyle(node).fontFamily,
      fontSize: 13,
      minimumContrastRatio: 4.5,
      cursorBlink: true,
      scrollback: current.current.state.environment?.scrollback ?? 0,
    })
    const addon = new FitAddon()
    xterm.loadAddon(addon)
    xterm.open(node)
    xterm.textarea?.setAttribute('aria-label', label)
    // Ctrl/Cmd+C copies only when a selection exists (no selection stays the
    // shell's SIGINT); Ctrl/Cmd+V pastes. The policy lives in a pure helper
    // because jsdom cannot construct a real xterm.
    xterm.attachCustomKeyEventHandler((event) =>
      terminalClipboardKey(event, xterm, navigator.clipboard))
    emulator.current = xterm
    fit.current = addon
    lastRevision.current = 0
    const input = xterm.onData((data) => { model.write(data) })
    const measure = (): void => {
      const live = current.current
      if (!live.visible || !live.state.writable || node.clientWidth === 0 || node.clientHeight === 0) return
      fitScreen(xterm, addon, live.state.environment, model)
    }
    // jsdom has no ResizeObserver; the explicit fit effect below still applies.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(node)
    return () => {
      observer?.disconnect()
      input.dispose()
      xterm.dispose()
      emulator.current = undefined
      fit.current = undefined
    }
  }, [model, label])

  // xterm takes concrete colors, so they are read off the screen element the
  // stylesheet paints from tokens (the bridge theme.ts documents). A scheme
  // flip, or a new terminal, re-reads them in place.
  useLayoutEffect(() => {
    const node = element.current
    const xterm = emulator.current
    if (node === null || xterm === undefined) return
    const style = getComputedStyle(node)
    xterm.options.theme = {
      background: style.backgroundColor,
      foreground: style.color,
      cursor: style.color,
      cursorAccent: style.backgroundColor,
      selectionBackground: style.color,
      selectionForeground: style.backgroundColor,
    }
  }, [scheme, model, state.phase])

  // The frame protocol: replay a snapshot, append output, then ACK — the host
  // holds the next frame until this write's callback runs.
  useLayoutEffect(() => {
    const xterm = emulator.current
    const render = state.render
    if (xterm === undefined || render === undefined || render.revision <= lastRevision.current) return
    lastRevision.current = render.revision
    if (render.frame.type === 'snapshot') {
      xterm.reset()
      xterm.resize(render.frame.info.cols, render.frame.info.rows)
    }
    xterm.write(render.frame.type === 'snapshot' ? render.frame.screen : render.frame.data, () => {
      model.acknowledge(render.revision)
    })
  }, [state.render, model])

  // Size and input control both follow the view state: fitting a view that
  // does not hold control would fight the window that does. Read the fields
  // out first so the effect's dependency list is exactly what it uses.
  const { writable, environment, info } = state
  useLayoutEffect(() => {
    const xterm = emulator.current
    if (xterm === undefined) return
    xterm.options.disableStdin = !writable
    if (visible && writable) fitScreen(xterm, fit.current, environment, model)
    else if (info !== undefined && !writable) xterm.resize(info.cols, info.rows)
  }, [visible, writable, environment, info, model])

  useEffect(() => {
    if (visible && writable) emulator.current?.focus()
  }, [visible, writable])

  return <div className={css.screen} ref={element} />
}

/**
 * Fit the emulator to its box and publish the size, clamped to the host's
 * per-terminal limits (a size the host refuses would leave the shell's own
 * idea of the window wrong).
 */
function fitScreen(
  xterm: Terminal,
  addon: FitAddon | undefined,
  environment: HostTerminalEnvironment | undefined,
  model: HostTerminalView,
): void {
  const dimensions = addon?.proposeDimensions()
  if (dimensions === undefined || environment === undefined) return
  const cols = Math.min(dimensions.cols, environment.maxCols)
  const rows = Math.min(dimensions.rows, environment.maxRows)
  if (cols < 2 || rows < 1) return
  xterm.resize(cols, rows)
  model.resize(cols, rows)
}
