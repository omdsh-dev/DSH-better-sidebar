/**
 * The terminal's shell switcher: the control that decides WHICH shell a bottom
 * terminal runs, and the two things it can do with that choice.
 *
 * This is the split control the host's own guide advertises (a "new terminal"
 * button plus a shell menu), reproduced against the host's structural contract
 * ({@link WebTerminalsFace.launchShells} / {@link WebTerminalsFace.selectShell})
 * with one addition the host does not need: the second action REBUILDS the tab
 * you are looking at, because a bottom terminal is a workbench tab the reader
 * keeps around rather than a guide card they open once.
 *
 * Why the switch is implemented as "close, then mint a new occurrence" instead
 * of something cleverer: the host allocates a PTY from its REMEMBERED shell
 * preference, and a live process never re-reads that preference. There is no
 * in-place "restart with another shell" in the contract, so the only honest
 * sequence is
 *
 *   1. `close(sessionId, key, contentId)` — release the current process,
 *   2. `updateTab(tab.id, { meta })` — bump the content identity, which is the
 *      only thing that makes the view memo allocate a NEW host terminal
 *      (reusing the identity would adopt the binding pointing at the process
 *      we just closed, wedging the tab on `missingTerminal`),
 *   3. the rebuilt view calls `view(sessionId, key, contentId)` — and because no
 *      explicit `shellPath` is passed, the host starts the shell we just
 *      selected.
 *
 * Thumbnail of the state machine: `launchShells` is queried lazily, only while
 * the menu is open (with an `AbortController` lifetime), so a terminal nobody
 * switches never pays for discovery.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular, IconPlusOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import type { SessionScope } from './api.ts'
import type { SidebarTab } from './state.ts'
import { t } from './locales.ts'
import {
  restartBottomTerminal, shortShellName,
  type HostShellCatalog, type WebTerminalsFace,
} from './terminal-client.ts'
import css from './terminal.module.css'

/** What the shell menu currently shows. */
type MenuState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly choices: HostShellCatalog }
  | { readonly phase: 'failed'; readonly message: string }

/** Props of the shell switcher. */
export interface TerminalShellSwitcherProps {
  /** The probed host terminal service (the two optional members are checked here). */
  service: WebTerminalsFace
  ctx: Context
  scope: SessionScope
  tab: SidebarTab
  /** The shell the current process reports, when the host disclosed it. */
  shellName: string | undefined
  /** Open a fresh bottom terminal tab (the "+" half). */
  onNewTerminal: () => void
  /**
   * Record a picked shell as the descriptor's default for FUTURE bottom
   * terminals. Given the shell's NAME, not its path: the default is stored in
   * the plugin's own prefs and has to survive a reinstall (``bash`` is
   * ``bash.exe`` on one machine and ``/bin/bash`` on the next), so the path is
   * resolved again on each launch rather than persisted. Omitted when the
   * caller cannot write prefs.
   */
  onDefaultShell?: (name: string) => void
}

/**
 * Whether this deployment can offer a shell switcher at all.
 *
 * Both members are optional in the structural contract, so a host that mounts
 * the terminal service without shell discovery keeps working — it simply has
 * no menu, and the control degrades to its "+" half.
 * @param service - the probed host terminal service.
 * @returns true when discovery AND preference writes are both available.
 */
export function canSwitchShells(service: WebTerminalsFace | undefined): boolean {
  return service !== undefined
    && typeof service.launchShells === 'function'
    && typeof service.selectShell === 'function'
}

/**
 * Render the split control: "new terminal" plus the shell menu.
 * @param props - the service, the tab being rebuilt and the new-tab action.
 * @returns the control, or null when the host cannot switch shells.
 */
export function TerminalShellSwitcher(props: TerminalShellSwitcherProps): ReactNode {
  const { service, ctx, scope, tab, shellName, onNewTerminal, onDefaultShell } = props
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<MenuState>({ phase: 'loading' })
  useEffect(() => {
    if (!open) return
    const lifetime = new AbortController()
    const sessionId = scope.sessionId
    void Promise.resolve(service.launchShells?.(sessionId, lifetime.signal)).then(
      (choices) => {
        if (lifetime.signal.aborted || choices === undefined) return
        setState({ phase: 'ready', choices })
      },
      (error: unknown) => {
        if (lifetime.signal.aborted) return
        setState({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => { lifetime.abort() }
  }, [open, attempt, service, scope.sessionId])

  const restartWith = useCallback((path: string): void => {
    // Three writes, in this order, because they answer different questions:
    // `selectShell` moves the HOST's remembered preference (so the sibling the
    // "+" opens starts the same shell), the pin handed to
    // `restartBottomTerminal` keeps THIS tab on the pick even after the
    // descriptor's default shell changes or the page reloads, and
    // `onDefaultShell` makes the pick the default for bottom terminals opened
    // LATER. Without that last one a switch would be a per-tab state that the
    // next "+" contradicts — the user picks bash, then the new tab opens cmd.
    service.selectShell?.(path)
    restartBottomTerminal(ctx, service, tab, scope.sessionId, path)
    const picked = state.phase === 'ready'
      ? state.choices.shells.find(shell => shell.path === path)
      : undefined
    // The default is stored as a NAME, so it survives a reinstall (``bash`` is
    // ``bash.exe`` here and ``/bin/bash`` there); the path is a property of
    // this machine's discovery result only.
    if (picked !== undefined) onDefaultShell?.(shortShellName(picked.name))
  }, [ctx, onDefaultShell, service, scope.sessionId, state, tab])

  const items = state.phase === 'ready'
    ? state.choices.shells.map(shell => ({ id: shell.path, label: shortShellName(shell.name) }))
    : state.phase === 'failed'
      ? [{ id: 'retry', label: t('retry') }]
      : [{ id: 'loading', label: t('loading'), disabled: true }]

  return (
    <span className={css.launch}>
      <button
        type="button"
        className={css.action}
        title={t('terminalNew')}
        aria-label={t('terminalNew')}
        onClick={onNewTerminal}
      >
        <IconPlusOutlineRegular size={14} />
      </button>
      <Menu
        open={open}
        portal
        autoFocus
        align="end"
        items={items.length === 0 ? [{ id: 'empty', label: t('guideShellEmpty'), disabled: true }] : items}
        selectedId={state.phase === 'ready' ? state.choices.selectedShell : undefined}
        onClose={() => { setOpen(false) }}
        onSelect={(path) => {
          // A failed discovery retries instead of selecting its own error row.
          if (state.phase === 'failed') { setState({ phase: 'loading' }); setAttempt(value => value + 1); return }
          setOpen(false)
          restartWith(path)
        }}
        anchor={(
          <button
            type="button"
            className={css.action}
            // The chip names what the process actually runs; before the host
            // reports it there is nothing specific to say, so it says what the
            // menu is for.
            title={t('terminalShell')}
            aria-label={t('terminalShell')}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setState({ phase: 'loading' }); setOpen(value => !value) }}
          >
            {shellName === undefined ? t('terminalShell') : shortShellName(shellName)}
            <IconChevronDownOutlineRegular size={14} />
          </button>
        )}
      />
    </span>
  )
}
