/**
 * S8 "Add source plugin" modal body — a deliberate MIRROR of the repository's
 * generic `PluginListBody` (`src/client/add-plugin-modal.tsx`, outside S8's
 * write scope): GitHub topic button, live search, category-grouped rows and
 * the same two per-entry actions (jump to the repository, copy the install
 * command). The install action ONLY writes the command to the clipboard and
 * flashes "Copied" when the write succeeded — no terminal opens, nothing
 * closes, and nothing ever claims the plugin (or its CLI) was installed.
 *
 * Data comes from `source-catalog.ts` (shape and S9 replacement path are
 * documented there). The body is extracted from the Modal so tests can render
 * it directly: the host Modal primitive runs hooks unconditionally, so an open
 * Modal must never be renderToString'd (same rule as `PluginListBody`).
 */
import { useState, type ReactNode } from 'react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from '../../locales.ts'
import { PLUGIN_TOPIC_URL } from '../../plugins-shared.ts'
import { builtinClueSourcePlugins, type ClueSourceCatalogEntry } from './source-catalog.ts'
// Reuse the generic add-plugin modal's styles: this body is the same shape,
// and the source modal must not grow a second visual language.
import css from '../../SideCardSection.module.css'

/** How long the "Copied" feedback stays on the copy button. */
const COPIED_FEEDBACK_MS = 1500

/** Resolve an i18n-friendly string-or-function value. */
function textOf(value: string | (() => string) | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'function' ? value() : value
}

/** Props of the catalog body (tests inject a custom/empty catalog). */
export interface SourceCatalogBodyProps {
  /** Defaults to the shipped source-plugin catalog. */
  readonly entries?: readonly ClueSourceCatalogEntry[]
}

/**
 * Render the source-plugin catalog body.
 * @param props - optional catalog override (tests / future host catalog).
 */
export function SourceCatalogBody(props: SourceCatalogBodyProps = {}) {
  const catalog = props.entries ?? builtinClueSourcePlugins
  // Which entry's copy button currently shows the "Copied" feedback.
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const needle = query.trim().toLowerCase()
  const filtered = catalog.filter((entry) => {
    if (needle === '') return true
    return textOf(entry.name).toLowerCase().includes(needle)
      || entry.id.toLowerCase().includes(needle)
      || textOf(entry.description).toLowerCase().includes(needle)
  })
  // Group by category in first-appearance order (the catalog is authored in
  // display order); a category is always present in this catalog.
  const groups = new Map<string, ClueSourceCatalogEntry[]>()
  for (const entry of filtered) {
    const category = textOf(entry.category)
    const list = groups.get(category)
    if (list === undefined) groups.set(category, [entry])
    else list.push(entry)
  }

  /**
   * Copy the entry's install command and flash its button. The feedback only
   * appears after a successful clipboard write (`writeClipboard` resolves
   * false when unavailable/denied), so the user is never told to paste a
   * command that was not placed on the clipboard.
   */
  const copy = async (entry: ClueSourceCatalogEntry): Promise<void> => {
    const written = await writeClipboard(entry.install)
    if (!written) return
    setCopiedId(entry.id)
    window.setTimeout(() => {
      setCopiedId(current => (current === entry.id ? null : current))
    }, COPIED_FEEDBACK_MS)
  }

  /** Open the repository in a REAL new browser tab (a button, not an anchor,
   *  so the sidebar link takeover cannot reroute it). */
  const jump = (entry: ClueSourceCatalogEntry): void => {
    window.open(entry.url, '_blank', 'noopener')
  }

  /** One catalog row (same structure as PluginListBody's entry row). */
  const renderEntry = (entry: ClueSourceCatalogEntry): ReactNode => {
    const name = textOf(entry.name)
    return (
      <div key={entry.id} className={css.pluginEntry} data-clue-source-plugin={entry.id}>
        <div className={css.pluginEntryHead}>
          <button
            type="button"
            className={css.pluginName}
            aria-label={`${t('openPlugin')}: ${name}`}
            onClick={() => { jump(entry) }}
          >
            {name}
          </button>
          <span className={css.pluginEntryActions}>
            <button
              type="button"
              className={css.pluginJumpBtn}
              aria-label={`${t('openPlugin')}: ${name}`}
              onClick={() => { jump(entry) }}
            >
              {t('openPlugin')}
            </button>
            <button
              type="button"
              className={css.pluginCopyBtn}
              aria-label={`${t('copyInstall')}: ${name}`}
              onClick={() => { void copy(entry) }}
            >
              {copiedId === entry.id ? t('copied') : t('copy')}
            </button>
          </span>
        </div>
        <div className={css.pluginDesc}>{textOf(entry.description)}</div>
        <code className={css.pluginInstall}>{entry.install}</code>
      </div>
    )
  }

  return (
    <div className={css.pluginList} data-clue-add-source="">
      <button
        type="button"
        className={css.pluginTopicBtn}
        onClick={() => { window.open(PLUGIN_TOPIC_URL, '_blank', 'noopener') }}
      >
        {t('addPluginsBrowseMore')}
      </button>
      <input
        type="search"
        className={css.pluginSearch}
        placeholder={t('addPluginsSearch')}
        aria-label={t('addPluginsSearch')}
        value={query}
        onChange={event => { setQuery(event.currentTarget.value) }}
      />
      <div className={css.groupHeading}>
        <span>{t('addPluginsRecommended')}</span>
        <span className={css.count}>{filtered.length}</span>
      </div>
      {catalog.length === 0 ? (
        <div className={css.pluginEmpty}>{t('addPluginsEmpty')}</div>
      ) : filtered.length === 0 ? (
        <div className={css.pluginEmpty}>{t('addPluginsNoMatch')}</div>
      ) : (
        <div className={css.pluginEntries}>
          {[...groups.entries()].map(([category, entries]) => (
            <div key={category} className={css.pluginGroup}>
              <div className={css.pluginGroupHeading}>{category}</div>
              {entries.map(renderEntry)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
