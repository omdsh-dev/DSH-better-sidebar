/**
 * S8 clue source table (presentational, node-free).
 *
 * One compact row per REGISTERED source — icon + name, source switch, @ switch,
 * derived availability state and the configure entry — plus the local
 * clue-pack @ switch (an independent preference, never dressed up as a remote
 * source), the four batch actions over the currently registered set, and the
 * add-source plugin entry. All values and handlers arrive from the settings
 * section; this module owns only layout and accessible names.
 *
 * Preference semantics are S1's: an absent entry means ON. A source whose
 * plugin is not loaded any more stays visible with its stored switches (the
 * approved spec keeps that configuration), labelled unavailable and disabled —
 * never rendered as ready.
 */
import type { ReactNode } from 'react'
import { IconFolderOpenRegular, IconLinkOutlineRegular, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { t, type CopyKey } from '../../locales.ts'
import type { ClueSourceDescriptor, ClueSourceDisplayDescriptor } from '../../../clues/types.ts'
import type { ClueSourceStatus, ClueSourceStatusKind } from './status.ts'
import css from './settings.module.css'

/** The three clue preference maps/values the panel renders. */
export interface ClueSourcesPrefs {
  readonly clueSourcesEnabled: Record<string, boolean>
  readonly clueSourcesMentionEnabled: Record<string, boolean>
  readonly cluePacksMentionEnabled: boolean
}

/** Props of the whole sources panel. */
export interface ClueSourcesPanelProps {
  readonly sources: readonly ClueSourceDescriptor[]
  readonly displays: readonly ClueSourceDisplayDescriptor[]
  /** Derived state per source id (absent = unchecked, never fabricated ready). */
  readonly statuses: ReadonlyMap<string, ClueSourceStatus>
  readonly prefs: ClueSourcesPrefs
  readonly loading: boolean
  readonly error: string | null
  onToggleSource(sourceId: string, next: boolean): void
  onToggleMention(sourceId: string, next: boolean): void
  onTogglePacksMention(next: boolean): void
  onEnableAll(): void
  onDisableAll(): void
  onMentionAll(): void
  onMentionNone(): void
  onConfigure(sourceId: string): void
  onAddSource(): void
  onReload(): void
}

/** Copy key of each derived state. */
const STATE_COPY: Record<ClueSourceStatusKind, CopyKey> = {
  unchecked: 'clueStateUnchecked',
  missing: 'clueStateMissing',
  incompatible: 'clueStateIncompatible',
  installing: 'clueStateInstalling',
  'not-configured': 'clueStateNotConfigured',
  authorizing: 'clueStateAuthorizing',
  'auth-expired': 'clueStateAuthExpired',
  'request-failed': 'clueStateRequestFailed',
  ready: 'clueStateReady',
}

/** Resolve a display's icon node (fallback: the generic link glyph). */
function displayIcon(display: ClueSourceDisplayDescriptor | undefined): ReactNode {
  if (display?.icon === undefined) return <IconLinkOutlineRegular size={16} />
  return typeof display.icon === 'function' ? display.icon(16) : display.icon
}

/** The display name of one source (client override → descriptor → id). */
function displayName(source: ClueSourceDescriptor, display: ClueSourceDisplayDescriptor | undefined): string {
  const name = display?.name ?? source.name
  return name.trim() === '' ? source.sourceId : name
}

/** One compact status badge. */
function StatusBadge(props: { status: ClueSourceStatus }) {
  const { status } = props
  return (
    <span
      className={css.status}
      data-kind={status.kind}
      title={status.detail}
    >
      {t(STATE_COPY[status.kind])}
    </span>
  )
}

/**
 * Render the source table + pack row + batch controls + add-source entry.
 * @param props - inventory, preferences, derived statuses and handlers.
 */
export function ClueSourcesPanel(props: ClueSourcesPanelProps) {
  const { sources, displays, statuses, prefs, loading, error } = props
  const displayById = new Map(displays.map(display => [display.sourceId, display]))
  const registered = new Set(sources.map(source => source.sourceId))
  const configuredOnly = [...new Set([
    ...Object.keys(prefs.clueSourcesEnabled),
    ...Object.keys(prefs.clueSourcesMentionEnabled),
  ])].filter(sourceId => !registered.has(sourceId)).sort()

  return (
    <div className={css.sources}>
      <p className={css.sourcesIntro}>{t('clueSourcesIntro')}</p>

      {error !== null && (
        <div className={css.error} role="alert">
          <span>{t('clueSourcesLoadFailed')} {error}</span>
          <button type="button" className={css.smallButton} onClick={props.onReload}>
            {t('retry')}
          </button>
        </div>
      )}

      {loading ? (
        <div className={css.loading} role="status">{t('loading')}</div>
      ) : (
        <>
          <div className={css.batchBar} role="group" aria-label={t('settingsGroupSources')}>
            <span className={css.batchScope}>{t('clueSourcesBatchScope')}</span>
            <span className={css.batchButtons}>
              <button type="button" className={css.smallButton} onClick={props.onEnableAll}>
                {t('clueSourcesEnableAll')}
              </button>
              <button type="button" className={css.smallButton} onClick={props.onDisableAll}>
                {t('clueSourcesDisableAll')}
              </button>
              <button type="button" className={css.smallButton} onClick={props.onMentionAll}>
                {t('clueSourcesMentionAll')}
              </button>
              <button type="button" className={css.smallButton} onClick={props.onMentionNone}>
                {t('clueSourcesMentionNone')}
              </button>
            </span>
          </div>

          {sources.length === 0 && configuredOnly.length === 0 ? (
            <div className={css.empty}>{t('clueSourcesEmpty')}</div>
          ) : (
            <ul className={css.sourceList} aria-label={t('settingsGroupSources')}>
              {sources.map(source => {
                const display = displayById.get(source.sourceId)
                const name = displayName(source, display)
                const enabled = prefs.clueSourcesEnabled[source.sourceId] !== false
                // The stored @ preference is preserved even while the source is
                // off; the switch is inert because the effective mention is off.
                const mention = prefs.clueSourcesMentionEnabled[source.sourceId] !== false
                const status = statuses.get(source.sourceId) ?? { kind: 'unchecked' as const }
                return (
                  <li
                    key={source.sourceId}
                    className={css.sourceRow}
                    data-clue-source={source.sourceId}
                    data-clue-source-status={status.kind}
                  >
                    <span className={css.sourceIdentity}>
                      <span className={css.sourceIcon} aria-hidden="true">{displayIcon(display)}</span>
                      <span className={css.sourceText}>
                        <span className={css.sourceName}>{name}</span>
                        <span className={css.sourceId}>{source.sourceId}</span>
                      </span>
                    </span>
                    <StatusBadge status={status} />
                    <span className={css.sourceControls}>
                      <Switch
                        label={t('clueSourceToggleAria', { source: name })}
                        checked={enabled}
                        onChange={next => { props.onToggleSource(source.sourceId, next) }}
                      />
                      <Switch
                        label={t('clueSourceMentionAria', { source: name })}
                        checked={mention}
                        disabled={!enabled}
                        title={!enabled ? t('clueSourcesIntro') : undefined}
                        onChange={next => { props.onToggleMention(source.sourceId, next) }}
                      />
                      <button
                        type="button"
                        className={css.smallButton}
                        aria-label={t('clueSourceConfigureAria', { source: name })}
                        onClick={() => { props.onConfigure(source.sourceId) }}
                      >
                        {t('clueConfigure')}
                      </button>
                    </span>
                  </li>
                )
              })}

              {/* Configured-but-unloaded sources: the stored switches and the
                  fact that the plugin is missing are both preserved (never
                  presented as ready, never silently dropped). */}
              {configuredOnly.map(sourceId => {
                const enabled = prefs.clueSourcesEnabled[sourceId] !== false
                const mention = prefs.clueSourcesMentionEnabled[sourceId] !== false
                return (
                  <li
                    key={sourceId}
                    className={css.sourceRow}
                    data-clue-source={sourceId}
                    data-clue-source-status="unavailable"
                  >
                    <span className={css.sourceIdentity}>
                      <span className={css.sourceIcon} aria-hidden="true"><IconLinkOutlineRegular size={16} /></span>
                      <span className={css.sourceText}>
                        <span className={css.sourceName}>{sourceId}</span>
                        <span className={css.sourceId}>{sourceId}</span>
                      </span>
                    </span>
                    <span className={css.status} data-kind="unavailable" title={t('clueSourcesUnavailable')}>
                      {t('clueSourcesUnavailable')}
                    </span>
                    <span className={css.sourceControls}>
                      <Switch
                        label={t('clueSourceToggleAria', { source: sourceId })}
                        checked={enabled}
                        disabled
                        title={t('clueSourcesUnavailable')}
                        onChange={() => {}}
                      />
                      <Switch
                        label={t('clueSourceMentionAria', { source: sourceId })}
                        checked={mention}
                        disabled
                        title={t('clueSourcesUnavailable')}
                        onChange={() => {}}
                      />
                    </span>
                  </li>
                )
              })}
            </ul>
          )}

          {/* The local clue-pack library is NOT a source: its own @ switch, no
              source switch and no configure entry. */}
          <div className={css.packsRow} data-clue-packs="">
            <span className={css.sourceIdentity}>
              <span className={css.sourceIcon} aria-hidden="true"><IconFolderOpenRegular size={16} /></span>
              <span className={css.sourceText}>
                <span className={css.sourceName}>{t('cluePacksName')}</span>
                <span className={css.sourceId}>{t('cluePacksDesc')}</span>
              </span>
            </span>
            <span className={css.sourceControls}>
              <Switch
                label={t('cluePacksMentionAria')}
                checked={prefs.cluePacksMentionEnabled !== false}
                onChange={next => { props.onTogglePacksMention(next) }}
              />
            </span>
          </div>

          {/* The add-source entry reuses the repository's plugin discovery /
              install-instruction flow (AddPluginModal body). Plugin install and
              CLI install stay two separate things; nothing here claims either
              one completed. */}
          <div className={css.addSource}>
            <button type="button" className={css.smallButton} onClick={props.onAddSource}>
              {t('clueAddSource')}
            </button>
            <span className={css.addSourceDesc}>{t('clueAddSourceDesc')}</span>
          </div>
        </>
      )}
    </div>
  )
}
