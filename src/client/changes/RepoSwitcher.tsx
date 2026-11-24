/**
 * Multi-repository switcher for a workspace CONTAINER (a project directory
 * that is not itself a repository but holds several).
 *
 * The row is responsive by content, not by a fixed viewport breakpoint: the
 * chips render at their natural width whenever every discovered root fits on
 * one line; once they do not (many roots, long location labels, or a narrow
 * side card) the same list becomes one native select. A hidden measurement row
 * keeps the decision stable even while the select is mounted — there is no
 * flip-flop between the two forms.
 *
 * Both forms are display-only over the same label list; selecting a root calls
 * the lens's existing chooseRepo, so reads, writes and the commit graph stay
 * pinned to one root.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { t } from '../locales.ts'
import type { RepositoryLabel } from './repo-labels.ts'
import css from './changes.module.css'

/** The switcher's current presentation. */
type RepoSwitcherMode = 'chips' | 'select'

export interface RepoSwitcherProps {
  /** Discovered roots in discovery order, with display-only labels. */
  readonly labels: readonly RepositoryLabel[]
  /** The RESOLVED root (never the stale request), when known. */
  readonly value: string | undefined
  /** Label for a resolved root that is no longer in the discovered list. */
  readonly standInLabel: string | undefined
  readonly disabled: boolean
  /** Whether the hosting tab is on screen (gates the resize observer). */
  readonly visible: boolean
  readonly onChoose: (root: string) => void
}

/** One root's display row, including the server-fallback stand-in. */
interface SwitcherOption extends RepositoryLabel {
  readonly standIn?: boolean
}

/**
 * Render the responsive repository switcher.
 * @param props - labels, resolved root, and the existing chooseRepo callback.
 * @returns the switcher, or nothing when only one root exists.
 */
export function RepoSwitcher({ labels, value, standInLabel, disabled, visible, onChoose }: RepoSwitcherProps) {
  const [mode, setMode] = useState<RepoSwitcherMode>('chips')
  const hostRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const options: readonly SwitcherOption[] = value !== undefined && standInLabel !== undefined
    ? [...labels, { root: value, label: standInLabel, standIn: true }]
    : labels

  /** Compare the chips' natural width with the row's content box. */
  const measure = useCallback((): void => {
    const host = hostRef.current
    const row = measureRef.current
    if (host === null || row === null) return
    // A hidden tab (and jsdom) reports width 0: keep the current form rather
    // than deciding on a meaningless measurement. The observer re-runs once
    // the tab is on screen.
    if (host.clientWidth <= 0) {
      setMode('chips')
      return
    }
    // The row's horizontal padding (6px each side) is not available content.
    const available = host.clientWidth - 12
    setMode(row.scrollWidth > available ? 'select' : 'chips')
  }, [])

  useLayoutEffect(() => { measure() }, [measure, labels, value, standInLabel, visible])

  useEffect(() => {
    if (!visible) return
    const host = hostRef.current
    const row = measureRef.current
    if (host === null || row === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { measure() })
    observer.observe(host)
    observer.observe(row)
    measure()
    return () => { observer.disconnect() }
  }, [visible, measure, labels, value, standInLabel])

  if (options.length <= 1) return null

  return (
    <div ref={hostRef} className={css.repoSwitcher} data-scm-repos role="group"
      aria-label={t('gitRepository')} data-repo-mode={mode}>
      {mode === 'chips'
        ? (
          <div className={css.repoChips} role="presentation">
            {options.map(item => (
              <button key={item.root} type="button" className={css.repoChip} data-scm-repo={item.root}
                data-active={item.standIn === true || item.root === value ? 'true' : undefined}
                data-standin={item.standIn === true ? 'true' : undefined}
                aria-pressed={item.root === value} title={item.root}
                disabled={disabled || item.standIn === true}
                onClick={() => { onChoose(item.root) }}>
                {item.label}
              </button>
            ))}
          </div>
        )
        : (
          <label className={css.repoPick}>
            <span className={css.repoPickLabel}>{t('gitRepository')}</span>
            <select className={css.repoPickSelect} aria-label={t('gitRepository')}
              value={value ?? ''} disabled={disabled}
              onChange={event => { onChoose(event.target.value) }}>
              {value === undefined && <option value="" disabled>{t('gitRepository')}</option>}
              {value !== undefined && standInLabel !== undefined &&
                <option value={value} disabled>{standInLabel}</option>}
              {labels.map(item => <option key={item.root} value={item.root}>{item.label}</option>)}
            </select>
          </label>
        )}

      {/* Natural-width measurement copy. Hidden from layout, AT and tests. */}
      <div ref={measureRef} className={css.repoMeasure} data-repo-measure aria-hidden="true">
        {options.map(item => <span key={item.root} className={css.repoChip}>{item.label}</span>)}
      </div>
    </div>
  )
}
