/**
 * The Windows-style path picker behind the terminal settings' candidate box.
 *
 * The location row is an Explorer-style ADDRESS BAR, not a plain text box:
 *
 *  - It starts at "This PC" (the computer icon). Clicking the icon opens the
 *    DRIVE CHOOSER in the list area below; picking a drive lists its root.
 *  - A drive plus every folder down to the current directory is a row of
 *    buttons, each navigating to that level. Clicking the EMPTY SPACE at the
 *    end of the row — or DOUBLE-CLICKING the last folder button — switches
 *    the whole row into a plain text input. Enter navigates to the typed
 *    directory (or selects a typed file in its parent), refreshes the list,
 *    and the row snaps back to buttons. Enter is navigation, NEVER commit:
 *    confirming the candidate is the dialog's button.
 *  - The list below BROWSEs: directory rows open, executable rows select.
 *    Every row writes its full path into the bar's current text.
 *
 * A shell candidate may be a BARE NAME (`nu`, resolved through PATH) or an
 * ABSOLUTE PATH (`C:\Apps\nu.exe`); the latter is what this dialog is for.
 * Browsing reuses the plugin's own fs routes through the session scope, the
 * same ones the file tree reads: no second filesystem client, no path
 * containment of its own (see src/path-security.ts — the routes reach whatever
 * the host user can reach). Drives come from the host's `fs.drives` route,
 * which probes the machine without shelling out to wmic/powershell.
 *
 * An absent scope (no active session yet) leaves browsing unavailable rather
 * than guessing a cwd — the row stays a plain text input so pasting works.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconBrowseOutlineRegular, IconChevronRightOutlineRegular, IconFolderCloseRegular, Input, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type FsDrive, type FsEntry, type SessionScope } from './api.ts'
import { t } from './locales.ts'
import css from './shell-path-picker.module.css'

/** Suffixes that name something the host could plausibly launch as a shell. */
const EXECUTABLE_SUFFIXES = ['.exe', '.cmd', '.bat', '.com', '.ps1', '.sh']

/**
 * Whether one directory row is an executable candidate worth offering.
 * A suffix-less file counts too (that is the shape of every shell on POSIX),
 * but a plain `.txt` does not: the list stays about launchable programs
 * instead of mirroring the whole directory.
 */
function looksExecutable(entry: FsEntry): boolean {
  if (entry.isDir) return false
  const name = entry.name.toLowerCase()
  if (!name.includes('.')) return true
  return EXECUTABLE_SUFFIXES.some(suffix => name.endsWith(suffix))
}

/** The parent of one absolute path, in whatever dialect it is already written
 *  in (`\` or `/`) — the browser never re-spells a Windows path with POSIX
 *  separators, because that string is handed straight back to the user. */
function parentDirOf(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/u, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (cut <= 0) return undefined
  const parent = trimmed.slice(0, cut)
  // `C:\` keeps its trailing separator (a bare `C:` is not a directory).
  return /^[A-Za-z]:$/u.test(parent) ? `${parent}\\` : parent
}

/** One clickable segment of the address bar. */
interface Crumb {
  label: string
  path: string
}

/** Split an absolute directory into the drive/root crumb plus one per folder. */
function crumbsOf(dir: string | undefined): Crumb[] {
  if (dir === undefined || dir === '') return []
  const win = /^([A-Za-z]:)([\\/].*)?$/u.exec(dir)
  if (win !== null) {
    const drive = `${win[1]!}\\`
    const crumbs: Crumb[] = [{ label: win[1]!, path: drive }]
    let acc = drive
    for (const part of (win[2] ?? '').split(/[\\/]/u).filter(part => part !== '')) {
      acc = `${acc}${acc.endsWith('\\') ? '' : '\\'}${part}`
      crumbs.push({ label: part, path: acc })
    }
    return crumbs
  }
  if (dir.startsWith('/')) {
    const crumbs: Crumb[] = [{ label: '/', path: '/' }]
    let acc = ''
    for (const part of dir.split('/').filter(part => part !== '')) {
      acc = `${acc}/${part}`
      crumbs.push({ label: part, path: acc })
    }
    return crumbs
  }
  // UNC or an unusual spelling: one crumb is better than a wrong decomposition.
  return [{ label: dir, path: dir }]
}

/** The most crumb buttons the address row shows before the middle folds. */
const MAX_VISIBLE_CRUMBS = 4

/** A crumb that stands for the folded middle instead of a real directory. */
interface VisibleCrumb extends Crumb {
  readonly folded?: boolean | undefined
}

/**
 * A long path cannot fit the address row. Keep the root and the last two
 * folders clickable and fold everything between them into one `..` marker —
 * plain text, NOT a button: revealing the middle only makes the row wrap or
 * overlap again, which is the very problem the fold is meant to solve.
 */
function visibleCrumbs(crumbs: readonly Crumb[]): readonly VisibleCrumb[] {
  if (crumbs.length <= MAX_VISIBLE_CRUMBS) return crumbs
  const hidden = crumbs.slice(1, -2)
  if (hidden.length === 0) return crumbs
  return [
    crumbs[0]!,
    { label: '..', path: hidden.map(crumb => crumb.label).join('\\'), folded: true },
    ...crumbs.slice(-2),
  ]
}

/** Props of the shell-candidate file browser. */
export interface ShellPathPickerProps {
  open: boolean
  /** Session scope for the fs routes (`undefined` = browsing unavailable). */
  scope: SessionScope | undefined
  /** The box's current text, used to open the browser where the user already is. */
  initialPath: string
  /** Take the chosen path (always a full path this dialog resolved). */
  onPick: (path: string) => void
  onClose: () => void
}

/**
 * Render the shell-candidate file browser.
 * @param props - open state, session scope, the text to start from, and the pick/close commands.
 * @returns the dialog tree (null when closed).
 */
export function ShellPathPicker(props: ShellPathPickerProps): ReactNode {
  const { open, scope, initialPath, onPick, onClose } = props
  /** The address bar's current text — a directory, or a selected file path. */
  const [draft, setDraft] = useState(initialPath)
  const draftRef = useRef(draft)
  draftRef.current = draft
  /** The listed directory's absolute path; empty before the first listing. */
  const [trail, setTrail] = useState<readonly string[]>([])
  const [entries, setEntries] = useState<readonly FsEntry[]>([])
  const [drives, setDrives] = useState<readonly FsDrive[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /** The row is a text input instead of crumb buttons. */
  const [editing, setEditing] = useState(false)
  /** The list area shows the drive chooser instead of a directory. */
  const [showDrives, setShowDrives] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reopening starts from whatever the box holds now — the dialog is a view
  // of that text, not a second place to keep state.
  useEffect(() => {
    if (!open) return
    setDraft(initialPath)
    setTrail([])
    setEntries([])
    setError(null)
    setEditing(false)
    setShowDrives(false)
  }, [open, initialPath])

  const currentDir = trail.length > 0 ? trail[trail.length - 1] : undefined
  const crumbs = useMemo(() => crumbsOf(currentDir), [currentDir])

  // Editing focuses and selects the full path so typing replaces it.
  useEffect(() => {
    if (!open || !editing) return
    const input = inputRef.current
    if (input === null) return
    input.focus()
    input.select()
  }, [open, editing])

  /** List one directory. `syncDraft` puts the resolved path in the address
   *  bar — true when navigating, false when falling back to a file's parent. */
  const list = useCallback(async (dir: string | undefined, syncDraft: boolean): Promise<void> => {
    if (scope === undefined) return
    setLoading(true)
    setError(null)
    try {
      // `undefined` asks the route for the SESSION cwd, which is the only
      // sensible starting point when the box is still empty.
      const listing = await api.fsTree(scope, dir, undefined)
      setTrail([listing.path])
      setEntries(listing.entries)
      if (syncDraft) setDraft(listing.path)
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [scope])

  useEffect(() => {
    if (!open) return
    if (trail.length > 0) return
    // Fresh dialog with an empty bar: show the session cwd there. A bar that
    // already holds the user's text is left alone — it is a starting point,
    // not something navigation should silently overwrite.
    void list(undefined, draftRef.current.trim() === '')
  }, [open, trail.length, list])

  /** Load the machine's drives when the computer icon is clicked. */
  useEffect(() => {
    if (!open || !showDrives || scope === undefined) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void api.fsDrives().then((answer) => {
      if (!cancelled) setDrives(answer.drives)
    }).catch((failure: unknown) => {
      if (!cancelled) {
        setError(failure instanceof Error ? failure.message : String(failure))
        setDrives([])
      }
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, showDrives, scope])

  /** The address bar's Enter: NAVIGATE, never commit. Returns whether the
   *  location resolved (only a success snaps the row back to buttons). */
  const navigate = useCallback(async (target: string): Promise<boolean> => {
    if (scope === undefined) return false
    const clean = target.trim()
    if (clean === '') return false
    setLoading(true)
    setError(null)
    try {
      try {
        const listing = await api.fsTree(scope, clean, undefined)
        setTrail([listing.path])
        setEntries(listing.entries)
        setDraft(listing.path)
        setShowDrives(false)
        return true
      } catch (first) {
        // A FILE path: open its parent and leave the typed path in the bar so
        // the confirm button commits exactly what the user entered.
        const parent = parentDirOf(clean)
        if (parent === undefined) throw first
        const listing = await api.fsTree(scope, parent, undefined)
        setTrail([listing.path])
        setEntries(listing.entries)
        setDraft(clean)
        setShowDrives(false)
        return true
      }
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setEntries([])
      return false
    } finally {
      setLoading(false)
    }
  }, [scope])

  /** Enter in the editing row: navigate, and only then leave edit mode. */
  const commitEdit = useCallback(async (): Promise<void> => {
    if (await navigate(draft)) setEditing(false)
  }, [draft, navigate])

  const enter = useCallback((entry: FsEntry): void => {
    void list(entry.path, true)
  }, [list])

  const openCrumb = useCallback((crumb: Crumb): void => {
    setShowDrives(false)
    void list(crumb.path, true)
  }, [list])

  const pickDrive = useCallback((drive: FsDrive): void => {
    setShowDrives(false)
    void list(drive.path, true)
  }, [list])

  const visible = useMemo(() => {
    const dirs = entries.filter(entry => entry.isDir)
    const programs = entries.filter(looksExecutable)
    return { dirs, programs }
  }, [entries])

  /** The dialog's sole commit path: confirm the address bar's current text. */
  const commit = useCallback((): void => {
    const next = draft.trim()
    if (next === '') return
    onPick(next)
  }, [draft, onPick])

  /** The address row: crumb buttons by default, a text input while editing. */
  const addressRow = scope === undefined || editing
    ? (
      <Input
        type="text"
        ref={inputRef}
        className={css.pathInput}
        value={draft}
        placeholder={t('terminalCandidateBrowsePlaceholder')}
        aria-label={t('terminalPathEdit')}
        data-dsh-path-input
        onChange={(event) => { setDraft(event.target.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void commitEdit()
          if (event.key === 'Escape') {
            // Escape leaves only the address row. The Modal installs its
            // close handler on `document` (bubble phase) and skips events
            // whose defaultPrevented is set, so claim this keystroke.
            event.preventDefault()
            event.stopPropagation()
            setEditing(false)
          }
        }}
        onBlur={() => { setEditing(false) }}
      />
    )
    : (
      <div className={css.breadcrumb} data-dsh-path-breadcrumb>
        <button
          type="button"
          className={`${css.computer} ${showDrives ? css.computerActive : ''}`}
          title={t('terminalPathThisPc')}
          aria-label={t('terminalPathThisPc')}
          data-dsh-path-computer
          onClick={() => { setShowDrives(true); setEditing(false) }}
        >
          <IconBrowseOutlineRegular size={14} />
        </button>
        {visibleCrumbs(crumbs).map((crumb, index, shown) => (
          <span className={css.crumbSlot} key={crumb.folded ? 'folded' : crumb.path}>
            <IconChevronRightOutlineRegular size={12} />
            {crumb.folded
              ? <span className={css.folded} title={crumb.path} data-dsh-path-expand>{crumb.label}</span>
              : (
                <button
                  type="button"
                  className={index !== shown.length - 1 ? css.crumb : css.crumbLast}
                  title={crumb.path}
                  data-dsh-path-crumb=""
                  onClick={() => { openCrumb(crumb) }}
                  onDoubleClick={() => { setEditing(true) }}
                >
                  <span className={css.crumbLabel}>{crumb.label}</span>
                </button>
              )}
          </span>
        ))}
        {/* The empty tail of the row: a single click here edits the address. */}
        <span
          className={css.crumbSpacer}
          title={t('terminalPathEdit')}
          data-dsh-path-edit
          onClick={() => { setEditing(true) }}
        />
      </div>
    )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('terminalCandidateBrowseTitle')}
      closeLabel={t('terminalCandidateBrowseClose')}
      description={t('terminalCandidateBrowseDesc')}
      contentClassName={css.content}
      footer={(
        <>
          <button type="button" className={css.cancel} onClick={onClose}>{t('terminalCandidateBrowseCancel')}</button>
          <button type="button" className={css.confirm} onClick={commit}>
            {t('terminalCandidateBrowseConfirm')}
          </button>
        </>
      )}
    >
      <div className={css.root} data-dsh-shell-path-picker>
        {addressRow}
        {scope === undefined
          ? <span className={css.hint}>{t('terminalCandidateBrowseUnavailable')}</span>
          : (
            <div className={css.browser}>
              {showDrives
                ? (
                  <div className={css.list} role="listbox" aria-label={t('terminalPathDrivesTitle')} data-dsh-drives>
                    {drives.map(drive => (
                      <button
                        key={drive.path}
                        type="button"
                        role="option"
                        aria-selected={false}
                        className={css.row}
                        title={drive.path}
                        data-dsh-drive
                        onClick={() => { pickDrive(drive) }}
                      >
                        <IconFolderCloseRegular size={14} />
                        <span className={css.rowName}>{drive.name}</span>
                      </button>
                    ))}
                    {!loading && drives.length === 0 && (
                      <span className={css.hint}>{t('terminalPathDrivesEmpty')}</span>
                    )}
                  </div>
                )
                : (
                  <>
                    {loading && <span className={css.hint}>{t('terminalCandidatesLoading')}</span>}
                    {!loading && (
                      <div className={css.list} role="listbox" aria-label={t('terminalCandidateBrowseTitle')}>
                        {visible.dirs.map(entry => (
                          <button
                            key={`dir:${entry.path}`}
                            type="button"
                            role="option"
                            aria-selected={false}
                            className={css.row}
                            title={entry.path}
                            onClick={() => { enter(entry) }}
                          >
                            <IconFolderCloseRegular size={14} />
                            <span className={css.rowName}>{entry.name}</span>
                            <IconChevronRightOutlineRegular size={14} />
                          </button>
                        ))}
                        {visible.programs.map(entry => (
                          <button
                            key={`file:${entry.path}`}
                            type="button"
                            role="option"
                            aria-selected={entry.path === draft.trim()}
                            className={css.row}
                            title={entry.path}
                            onClick={() => { setDraft(entry.path) }}
                          >
                            <span className={css.rowName}>{entry.name}</span>
                          </button>
                        ))}
                        {visible.dirs.length === 0 && visible.programs.length === 0 && (
                          <span className={css.hint}>{t('terminalCandidateBrowseEmpty')}</span>
                        )}
                      </div>
                    )}
                  </>
                )}
            </div>
          )}
        {error !== null && <span className={css.error} role="alert">{error}</span>}
      </div>
    </Modal>
  )
}
