/**
 * The Git card's pinned-model setting: which provider/model drafts commit
 * messages. It renders through the descriptor's `settings.render` seam because
 * the option list is DISCOVERED at runtime (`git.models` asks the harness what
 * it can serve) — a declarative toggle can only declare a static option set.
 *
 * Shape: a "follow the conversation" SWITCH plus a searchable `provider/model`
 * box. Following is the default (an empty stored value), and it disables the
 * box: while the panel tracks the conversation there is nothing to pin. The
 * box is a filter over the discovered catalog AND accepts a hand-typed
 * `provider/model` route, so a model the harness never advertises stays
 * selectable.
 *
 * The value lives in the descriptor's own plugin-settings blob
 * (`pluginSettings.git.commitModel`); empty/absent means "follow".
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type GitModelCatalog } from '../api.ts'
import { t } from '../locales.ts'
import type { SidebarSettingsRenderProps } from '../service.ts'
import css from './changes.module.css'

/** The plugin-owned setting key (mirrored host-side in src/index.ts). */
export const COMMIT_MODEL_SETTING_KEY = 'commitModel'

/** Cap of the filtered candidate list (a huge catalog stays scrollable). */
const OPTION_LIMIT = 40

/**
 * One selectable route. The displayed text IS the route (`provider/model`) —
 * the same string the search box filters on and the host dispatches on — so a
 * catalog entry and the harness default read identically instead of one being
 * a decorated "<provider> · <model>" rendering.
 */
interface ModelOption {
  /** The stored and displayed `provider/model` route. */
  value: string
  /** Source badge text ('' for a plain catalog entry). */
  note: string
}

/** The stored `provider/model` route of one option ('' = follow). */
function routeValue(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** Build the candidate list: harness default and used routes first, then the
 *  adapter catalog. De-duplicated by route, newest/most-relevant first. */
function optionsOf(catalog: GitModelCatalog | null): ModelOption[] {
  if (catalog === null) return []
  const options: ModelOption[] = []
  const seen = new Set<string>()
  const push = (provider: string, model: string, note: string): void => {
    const value = routeValue(provider, model)
    if (seen.has(value)) return
    seen.add(value)
    options.push({ value, note })
  }
  if (catalog.default !== undefined) {
    push(catalog.default.provider, catalog.default.model, t('commitModelDefaultNote'))
  }
  for (const route of catalog.recent) {
    push(route.provider, route.model, t('commitModelRecentNote'))
  }
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      push(provider.provider, model.id, '')
    }
  }
  return options
}

export function CommitModelSettings(props: SidebarSettingsRenderProps) {
  const { store, pluginSettings, updatePluginSetting } = props
  const sessionId = store.getSnapshot().sessionId
  const stored = pluginSettings[COMMIT_MODEL_SETTING_KEY]
  const value = typeof stored === 'string' ? stored : ''
  const [catalog, setCatalog] = useState<GitModelCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Following is the DEFAULT (an empty stored value). The switch keeps its own
  // draft so it can be turned off before any model is picked — the stored value
  // then stays empty and generation still follows the conversation.
  const [follow, setFollow] = useState(value === '')
  // The search box is a FILTER, never a projection of the stored value: after
  // picking a route it clears, so reopening the menu lists every candidate
  // instead of filtering down to the one already selected. The selection
  // itself is shown on its own line (below).
  const [query, setQuery] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (sessionId === undefined) return
    let cancelled = false
    setError(null)
    api.gitModels({ sessionId })
      .then(view => { if (!cancelled) setCatalog(view) })
      .catch((reason: unknown) => {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => { cancelled = true }
  }, [sessionId])

  const inputRef = useRef<HTMLInputElement | null>(null)

  const options = useMemo(() => optionsOf(catalog), [catalog])
  const needle = query.trim().toLowerCase()
  const matches = useMemo(
    () => (needle === ''
      ? options.slice(0, OPTION_LIMIT)
      : options.filter(option => option.value.toLowerCase().includes(needle)).slice(0, OPTION_LIMIT)),
    [options, needle],
  )
  const listOpen = open && !follow && matches.length > 0

  /**
   * The primitives Menu lays its portalled list out from the anchor rect but
   * sizes it from CSS (`min-width: 218px`, `max-width: 360px`) — it has no
   * "match the anchor width" mode, and its `className` only reaches the root
   * wrapper. The list is a direct child of <body> (portal), so it is reachable
   * here: while open, pin its width to the input's own width so the dropdown
   * is never narrower than the box it drops out of.
   */
  useLayoutEffect(() => {
    if (!listOpen) return
    const sync = (): void => {
      const input = inputRef.current
      if (input === null) return
      const width = Math.round(input.getBoundingClientRect().width)
      if (width <= 0) return
      const children: Element[] = Array.from(document.body.children)
      for (let index = children.length - 1; index >= 0; index--) {
        const element = children[index]
        if (!(element instanceof HTMLElement) || element.getAttribute('role') !== 'menu') continue
        // A floor, never a ceiling: the card may grow past the input to fit a
        // long route plus its source badge (the Menu's own max-width caps it).
        element.style.minWidth = `${width}px`
        element.style.removeProperty('max-width')
        return
      }
    }
    sync()
    window.addEventListener('resize', sync)
    return () => { window.removeEventListener('resize', sync) }
  }, [listOpen, matches.length])

  /** Commit one typed/clicked route (both halves must be non-empty). */
  const commitRoute = (raw: string): boolean => {
    const trimmed = raw.trim()
    const slash = trimmed.indexOf('/')
    const provider = slash <= 0 ? '' : trimmed.slice(0, slash).trim()
    const model = slash < 0 ? '' : trimmed.slice(slash + 1).trim()
    if (provider === '' || model === '') {
      setInvalid(true)
      return false
    }
    setInvalid(false)
    setQuery('')
    updatePluginSetting(COMMIT_MODEL_SETTING_KEY, routeValue(provider, model))
    return true
  }

  const pick = (option: ModelOption): void => {
    // Clear the filter (see the `query` note above) and close.
    setQuery('')
    setInvalid(false)
    setOpen(false)
    updatePluginSetting(COMMIT_MODEL_SETTING_KEY, option.value)
  }

  return (
    <div className={css.commitModel}>
      <div className={css.commitModelRow}>
        <span className={css.commitModelTitle}>{t('commitModelTitle')}</span>
        <label className={css.commitModelSwitch}>
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => {
              const next = event.currentTarget.checked
              setFollow(next)
              if (next) {
                setQuery('')
                setInvalid(false)
                updatePluginSetting(COMMIT_MODEL_SETTING_KEY, '')
              }
            }}
          />
          <span>{t('commitModelFollow')}</span>
        </label>
      </div>
      <div className={css.commitModelDesc}>{t('commitModelDesc')}</div>
      {/* The candidate menu is PORTALLED (the primitives Menu), like every
          other dropdown in the side card: this panel renders inside the
          settings modal, whose body clips overflow, so an in-flow or absolute
          list would be cut off at the dialog edge. The input itself is the
          menu's anchor, so typing filters the open menu in place. */}
      <div className={css.commitModelBox}>
        {!follow && value !== '' && (
          <div className={css.commitModelCurrent}>{t('commitModelCurrent', { route: value })}</div>
        )}
        <Menu
          open={open && !follow && matches.length > 0}
          className={css.commitModelMenuRoot}
          anchor={(
            <input
              ref={inputRef}
              className={css.commitModelInput}
              type="text"
              value={query}
              disabled={follow}
              placeholder={t('commitModelSearchPlaceholder')}
              aria-label={t('commitModelSearchPlaceholder')}
              onChange={(event) => {
                setQuery(event.currentTarget.value)
                setInvalid(false)
                setOpen(true)
              }}
              onFocus={() => { setOpen(true) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  if (commitRoute(event.currentTarget.value)) setOpen(false)
                }
                if (event.key === 'Escape') setOpen(false)
              }}
            />
          )}
          items={matches.map(option => ({
            id: option.value,
            label: (
              <span className={css.commitModelOption}>
                <span className={css.commitModelOptionText}>{option.value}</span>
                {option.note !== '' && <span className={css.commitModelOptionNote}>{option.note}</span>}
              </span>
            ),
          }))}
          selectedId={value === '' ? undefined : value}
          onSelect={(id) => {
            const option = matches.find(candidate => candidate.value === id)
            if (option !== undefined) pick(option)
          }}
          onClose={() => { setOpen(false) }}
          portal
        />
      </div>
      {invalid && <div className={css.gitError}>{t('commitModelInvalid')}</div>}
      {catalog !== null && !catalog.llm && <div className={css.commitModelHint}>{t('commitModelUnavailable')}</div>}
      {catalog !== null && catalog.llm && options.length === 0 && (
        <div className={css.commitModelHint}>{t('commitModelEmpty')}</div>
      )}
      {error !== null && <div className={css.gitError}>{error}</div>}
    </div>
  )
}
