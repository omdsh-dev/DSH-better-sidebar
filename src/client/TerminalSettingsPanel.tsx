/**
 * The terminal card's settings panel (the gear on the Side card page's
 * `terminal-bottom` card).
 *
 * TWO settings, and the difference between them is the design:
 *
 * 1. THE DEFAULT SHELL answers "what does a new bottom terminal start with".
 *    Its options are the shells the HOST ACTUALLY DISCOVERED
 *    (`webTerminals.launchShells`), never the configured candidate list: a
 *    picker that offers a shell the host cannot launch would only produce a
 *    selection that gets refused at spawn time. It also always SHOWS a value —
 *    the stored name when it still resolves, otherwise the host's own current
 *    choice — because "blank" would misrepresent a setting that is always in
 *    effect. Picking here stores a NAME (`bash`, not `/usr/bin/bash`); the
 *    view resolves it to a path on every launch through the host's discovery,
 *    so a moved or updated binary keeps working.
 *
 * 2. THE CANDIDATE LIST decides what the host can discover at all. It is the
 *    `shellCandidates` array of the profile's `terminal-controller` row, read
 *    and written through the HOST's config editor
 *    (`/sidebar/api/terminal.shells`). A candidate list kept in this plugin's
 *    own prefs would be a lie: the host resolves a requested `shellPath`
 *    against its OWN discovery result and refuses anything absent from it, so
 *    only the row the host reads can change what it will launch. Native
 *    candidates are read-only (the host's defaults); a custom one is a
 *    whole-array replacement, so every write restates the native set. A
 *    candidate may be a bare name OR an absolute path, and a chip shows both
 *    its short label and the stored value, because which one the user typed is
 *    exactly what they need to check.
 *
 * The candidate box's browser (`ShellPathPicker`) is the paste-or-browse
 * affordance for that second setting: an absolute path is easy to get wrong
 * from memory, so it can be pasted into the dialog's own box, navigated to, or
 * both.
 *
 * A deployment with no config editor (or no `terminal-controller` row) gets
 * `null` from the read: the candidate half then renders a one-line explanation
 * while the default-shell picker keeps working off the host's discovery — the
 * two settings fail independently.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  IconCheckOutlineRegular, IconFolderOpenOutlineRegular, IconPlusOutlineRegular, Input, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type SessionScope } from './api.ts'
import { t } from './locales.ts'
import type { SidebarSettingsRenderProps } from './service.ts'
import { shellKeyOf, shellLabelOf, type ShellCandidateView } from '../terminal-shells.ts'
import { TERMINAL_DEFAULT_SHELL_SETTING, terminalDefaultShellOf } from '../prefs-shared.ts'
import {
  shortShellName, webTerminals, type HostShellCatalog, type HostShellChoice,
} from './terminal-client.ts'
import type { Context } from '../context-types.ts'
import { mountedSessions } from './native/surface.ts'
import { ShellPathPicker } from './ShellPathPicker.tsx'
import css from './terminal-settings.module.css'

/** The plugin-local key holding the default shell's NAME (never a path). */
export const DEFAULT_SHELL_KEY = TERMINAL_DEFAULT_SHELL_SETTING

/** Read the stored default-shell name from a descriptor's own blob. */
export const storedDefaultShell = terminalDefaultShellOf

/**
 * Whether one discovered shell IS the name a user stored.
 *
 * Both spellings the host and this plugin produce must match: the display
 * label (`powershell`), the host's executable basename (`powershell.exe`) and
 * the switcher's short alias (`pwsh`, which is what the bottom terminal writes
 * back). Comparing all three through `shellKeyOf` keeps one shell from reading
 * as two.
 */
function storedNameNamesShell(stored: string, shell: HostShellChoice): boolean {
  const wanted = shellKeyOf(stored)
  return wanted === shellKeyOf(shell.name) || wanted === shellKeyOf(shortShellName(shell.name))
}

/**
 * Pick the shell the picker should PRESENT as current: the stored choice when
 * the host still discovers it, otherwise the host's own default.
 *
 * Falling back rather than rendering a blank is the point — a shell is always
 * in effect, so an unset or stale preference must read as "this is what you
 * will get", not as "nothing".
 */
function effectiveShell(
  catalog: HostShellCatalog | null | undefined,
  stored: string | undefined,
): HostShellChoice | undefined {
  if (catalog === null || catalog === undefined) return undefined
  if (stored !== undefined) {
    const matched = catalog.shells.find(shell => storedNameNamesShell(stored, shell))
    if (matched !== undefined) return matched
  }
  const preferred = catalog.shells.find(shell => shell.path === catalog.selectedShell)
  return preferred ?? catalog.shells[0]
}

/** Props of the terminal card's settings panel. */
export interface TerminalSettingsPanelProps extends SidebarSettingsRenderProps {
  /**
   * The client context, supplied by the descriptor's registration. The
   * settings slot is NOT session-scoped and cannot reach the host terminal
   * service on its own, so the descriptor — which captured `ctx` when it
   * registered — hands it over. Missing here means no terminal service, and
   * the default-shell row then explains itself instead of guessing.
   */
  terminalCtx?: Context
}


/**
 * Render the terminal card's settings panel.
 * @param props - the descriptor's own blob, its persistence helper, and the shell probe.
 * @returns the two setting groups.
 */
export function TerminalSettingsPanel(props: TerminalSettingsPanelProps): ReactNode {
  const { pluginSettings, updatePluginSetting, terminalCtx, store } = props
  // `undefined` = still reading, `null` = this deployment cannot edit config.
  const [candidates, setCandidates] = useState<ShellCandidateView | null | undefined>(undefined)
  // `undefined` = still probing, `null` = the terminal service is absent.
  const [available, setAvailable] = useState<HostShellCatalog | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // The settings slot is a GLOBAL surface: it is NOT mounted inside the
  // Sidebar, so `store.getSnapshot().sessionId` is only filled in by the
  // Sidebar's own effect and can still be `undefined` when settings is opened
  // directly — which made the shell probe read as "no terminal service" even
  // though the bottom terminal (whose scope is a LIVE subscription) sees every
  // shell. Subscribe to the native seat's mounted feed, the same source the
  // start-page shell menu and the tab bodies use. A fake context with no seat
  // falls back to the store's own subscription.
  const seat = terminalCtx === undefined ? undefined : mountedSessions(terminalCtx)
  const sessionId = useSyncExternalStore(
    useCallback((listener: () => void) => (
      seat !== undefined
        ? seat.subscribe(listener)
        : (store as { subscribe?: (listener: () => void) => () => void }).subscribe?.(listener) ?? (() => {})
    ), [seat, store]),
    useCallback(() => seat?.getSnapshot() ?? store.getSnapshot().sessionId, [seat, store]),
  )
  const scope: SessionScope | undefined = sessionId === undefined ? undefined : { sessionId }

  useEffect(() => {
    let cancelled = false
    void api.terminalShells()
      .then((view) => { if (!cancelled) setCandidates(view) })
      .catch((failure: unknown) => {
        if (cancelled) return
        setCandidates(null)
        setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => { cancelled = true }
  }, [])

  // Ask the HOST what it can actually launch. This is the only source the
  // default picker may offer: the candidate list says what MAY be discovered,
  // not what exists on this machine.
  useEffect(() => {
    const service = terminalCtx === undefined ? undefined : webTerminals(terminalCtx)
    const probe = service?.launchShells
    if (sessionId === undefined || probe === undefined) {
      setAvailable(null)
      return
    }
    const lifetime = new AbortController()
    let cancelled = false
    // Call the method ON THE SERVICE: the catalog reads its own `remote`
    // field, and a detached call throws "Cannot read properties of undefined
    // (reading 'remote')" (see 64a91dac).
    void probe.call(service, sessionId, lifetime.signal)
      .then((catalog) => { if (!cancelled) setAvailable(catalog) })
      .catch(() => { if (!cancelled) setAvailable(null) })
    return () => { cancelled = true; lifetime.abort() }
  }, [terminalCtx, sessionId])

  // The picker offers DISCOVERED shells only, in discovery order (which puts
  // the host's default first). No config editor, no session or no terminal
  // service simply leaves it empty and the row explains why.
  const usable = useMemo<readonly HostShellChoice[]>(
    () => available?.shells ?? [],
    [available],
  )
  const stored = storedDefaultShell(pluginSettings)
  const current = effectiveShell(available, stored)
  const items = useMemo(
    () => usable.map(shell => ({ id: shell.path, label: shellLabelOf(shell.name) })),
    [usable],
  )

  const addCandidate = useCallback((raw: string) => {
    const name = raw.trim()
    if (name === '') return
    setError(null)
    void api.terminalShellsUpdate('addCandidate', name)
      .then((view) => { setCandidates(view); setDraft('') })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure))
      })
  }, [])

  const removeCandidate = useCallback((name: string) => {
    setError(null)
    void api.terminalShellsUpdate('removeCandidate', name)
      .then(view => { setCandidates(view) })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure))
      })
  }, [])

  /**
   * Start the next entry: an empty box, focused, ready for another shell.
   *
   * Separate from committing on purpose — adding must not depend on whether
   * the user remembered to clear the box first, and the list is an array:
   * `nu` then `elvish` is two commits, not one.
   */
  const startAnother = useCallback(() => {
    setDraft('')
    setError(null)
    inputRef.current?.focus()
  }, [])

  const pickBrowserPath = useCallback((path: string) => {
    setDraft(path)
    setBrowseOpen(false)
    // Straight into the list: the dialog already resolved a concrete file, so
    // a second confirmation click would only re-ask what was just chosen.
    addCandidate(path)
  }, [addCandidate])

  return (
    <div className={css.root} data-dsh-terminal-settings>
      <div className={css.group}>
        <div className={css.groupHead}>
          <span className={css.groupTitle}>{t('terminalDefaultShellTitle')}</span>
          <span className={css.groupDesc}>{t('terminalDefaultShellDesc')}</span>
        </div>
        <Menu
          open={pickerOpen}
          portal
          autoFocus
          align="start"
          items={items}
          selectedId={current?.path}
          onClose={() => { setPickerOpen(false) }}
          onSelect={(path: string) => {
            setPickerOpen(false)
            const picked = usable.find(shell => shell.path === path)
            if (picked === undefined) return
            // Always a real shell the host just confirmed it can launch: this
            // preference IS the bottom terminal's default, so there is no
            // "unset" state to fall back from — the terminal's own switcher
            // writes here too.
            updatePluginSetting(DEFAULT_SHELL_KEY, shellLabelOf(picked.name))
          }}
          anchor={(
            <button
              type="button"
              className={css.picker}
              aria-label={t('terminalDefaultShellTitle')}
              onClick={() => { setPickerOpen(open => !open) }}
            >
              <span>
                {current !== undefined
                  ? shellLabelOf(current.name)
                  : available === undefined
                    ? t('terminalCandidatesLoading')
                    : stored ?? t('terminalDefaultShellPick')}
              </span>
            </button>
          )}
        />
        {available === null && <span className={css.hint}>{t('terminalDefaultShellUnavailable')}</span>}
      </div>

      <div className={css.group}>
        <div className={css.groupHead}>
          <span className={css.groupTitle}>{t('terminalCandidatesTitle')}</span>
          <span className={css.groupDesc}>{t('terminalCandidatesDesc')}</span>
        </div>
        {candidates === undefined && <span className={css.hint}>{t('terminalCandidatesLoading')}</span>}
        {candidates === null && (
          <span className={css.hint}>{t('terminalCandidatesUnavailable')}</span>
        )}
        {candidates !== null && candidates !== undefined && (
          <>
            <div className={css.chips}>
              {candidates.native.map(name => (
                <span key={`native:${name}`} className={css.chipNative} title={name}>
                  {shellLabelOf(name)}
                </span>
              ))}
              {candidates.custom.map(name => (
                <span key={`custom:${name}`} className={css.chip}>
                  <span className={css.chipStack}>
                    {/* The SHORT label is what the switcher and the default
                        row will show; the stored value below it is what the
                        host will actually try to launch. Both matter, so both
                        are on screen instead of one hiding in `title`. */}
                    <span className={css.chipLabel}>{shellLabelOf(name)}</span>
                    {shellLabelOf(name) !== name && (
                      <span className={css.chipPath} title={name}>{name}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    className={css.chipRemove}
                    aria-label={`${t('terminalCandidateRemove')} ${name}`}
                    title={t('terminalCandidateRemove')}
                    onClick={() => { removeCandidate(name) }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className={css.addRow}>
              <Input
                ref={inputRef}
                type="text"
                className={css.addInput}
                value={draft}
                placeholder={t('terminalCandidatePlaceholder')}
                aria-label={t('terminalCandidatesTitle')}
                onChange={(event) => { setDraft(event.target.value) }}
                onKeyDown={(event) => { if (event.key === 'Enter') addCandidate(draft) }}
              />
              <button
                type="button"
                className={css.addButton}
                aria-label={t('terminalCandidateBrowse')}
                title={t('terminalCandidateBrowse')}
                onClick={() => { setBrowseOpen(true) }}
              >
                <IconFolderOpenOutlineRegular size={14} />
              </button>
              <button
                type="button"
                className={css.addButton}
                aria-label={t('terminalCandidateAdd')}
                title={t('terminalCandidateAdd')}
                onClick={() => { addCandidate(draft) }}
              >
                <IconCheckOutlineRegular size={14} />
              </button>
            </div>
            {/*
              Show what a path will be called before it is added. The user
              types one THING (`C:\\Apps\\nu.exe`) and the chip has to read
              something shorter (`nu`), so the resolution is stated up front
              instead of being a surprise after the write.
            */}
            {draft.trim() !== '' && shellLabelOf(draft) !== draft.trim() && (
              <span className={css.hint} data-dsh-terminal-label-preview>
                {t('terminalCandidateLabelPreview', { name: shellLabelOf(draft) })}
              </span>
            )}
            {/*
              The array holds as many candidates as the user wants; the row
              above only commits ONE at a time. `+` is therefore not a second
              confirm — it clears the box and starts the NEXT entry, which is
              what the previous `+`-only button never made clear.
            */}
            <div className={css.moreRow}>
              <button
                type="button"
                className={css.moreButton}
                aria-label={t('terminalCandidateAddMore')}
                title={t('terminalCandidateAddMore')}
                onClick={startAnother}
              >
                <IconPlusOutlineRegular size={14} />
                <span>{t('terminalCandidateAddMore')}</span>
              </button>
            </div>
            <ShellPathPicker
              open={browseOpen}
              scope={scope}
              initialPath={draft}
              onPick={pickBrowserPath}
              onClose={() => { setBrowseOpen(false) }}
            />
          </>
        )}
        {error !== null && <span className={css.error} role="alert">{error}</span>}
      </div>
    </div>
  )
}
