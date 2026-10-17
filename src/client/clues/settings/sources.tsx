/**
 * S8 clue source table (presentational, node-free).
 *
 * One compact row per REGISTERED source — icon + name, source switch, @ switch,
 * derived availability state and (only when the source actually declares a
 * dependency or connection) the configure entry — plus the local clue-pack @
 * switch (an independent preference, never dressed up as a remote source), the
 * four batch actions over the currently registered set, and the add-source
 * plugin entry. All values and handlers arrive from the settings section; this
 * module owns only layout and accessible names.
 *
 * Preference semantics are S1's: an absent entry means ON. A source whose
 * plugin is not loaded any more stays visible with its stored switches (the
 * approved spec keeps that configuration), labelled unavailable and disabled —
 * never rendered as ready.
 */
import type { ReactNode } from 'react'
import { IconFolderOpenRegular, IconLinkOutlineRegular, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from '../../locales.ts'
import {
  isCluePacksMentionEnabled,
  isClueSourceEnabled,
  isClueSourceMentionEnabled,
  type SidebarPrefs,
} from '../../../prefs-shared.ts'
import type { ClueSourceDescriptor, ClueSourceDisplayDescriptor } from '../../../clues/types.ts'
import type { ClueSourceStatus } from './status.ts'
import { CLUE_SOURCE_STATUS_COPY } from './copy.ts'
import css from './settings.module.css'

/** Props of the whole sources panel. */
export interface ClueSourcesPanelProps {
  readonly sources: readonly ClueSourceDescriptor[]
  readonly displays: readonly ClueSourceDisplayDescriptor[]
  /** Derived state per source id (absent = unchecked, never fabricated ready). */
  readonly statuses: ReadonlyMap<string, ClueSourceStatus>
  /**
   * The full shared preferences object. The "absent entry means ON" rule is
   * S1's (`prefs-shared.ts`); the panel calls those helpers instead of
   * re-deriving `!== false` locally, so a future default change is one edit.
   */
  readonly prefs: SidebarPrefs
  /** Row-addressed save failures (`source:<id>`, `packs`, `batch`). */
  readonly writeErrors?: Readonly<Record<string, string>>
  readonly loading: boolean
  /** The catalogue request failed; Retry is offered. */
  readonly error: string | null
  /**
   * A status probe failed even though the catalogue may be known. Unlike
   * `error`, this line does NOT pretend the source list itself is unknown:
   * the affected rows already say request-failed.
   */
  readonly statusError: string | null
  /**
   * Whether the catalogue was actually read. Before that, the stored
   * preference maps cannot be classified as "configured but unloaded" — doing
   * so would falsely label every known source as a missing plugin.
   */
  readonly catalogueLoaded: boolean
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

/** Whether a source declares something the configuration page can show. */
export function hasSourceConfiguration(source: ClueSourceDescriptor): boolean {
  return (source.dependencyIds?.length ?? 0) > 0 || source.connectionId !== undefined
}

/** Resolve a display's icon node (fallback: the generic link glyph). */
function displayIcon(display: ClueSourceDisplayDescriptor | undefined): ReactNode {
  if (display?.icon === undefined) return <IconLinkOutlineRegular size={16} />
  return typeof display.icon === 'function' ? display.icon(16) : display.icon
}

/**
 * The display name of one source (client override → descriptor → id).
 *
 * ONE fallback chain for every surface: the source table row AND the S6
 * configuration window title both call this, so a whitespace-only override
 * can never produce an empty window title while the row shows a name.
 */
export function sourceDisplayName(
  source: ClueSourceDescriptor,
  display: ClueSourceDisplayDescriptor | undefined,
): string {
  if (display?.name !== undefined && display.name.trim() !== '') return display.name
  if (source.name.trim() !== '') return source.name
  return source.sourceId
}

/** One compact status badge (its detail is also rendered on the row). */
function StatusBadge(props: { status: ClueSourceStatus; detailId?: string }) {
  const { status, detailId } = props
  return (
    <span
      className={css.status}
      data-kind={status.kind}
      title={status.detail}
      aria-describedby={status.detail === undefined ? undefined : detailId}
    >
      {t(CLUE_SOURCE_STATUS_COPY[status.kind])}
    </span>
  )
}

/**
 * Render the source table + pack row + batch controls + add-source entry.
 * @param props - inventory, preferences, derived statuses and handlers.
 */
export function ClueSourcesPanel(props: ClueSourcesPanelProps) {
  const { sources, displays, statuses, prefs, writeErrors = {}, loading, error, statusError, catalogueLoaded } = props
  const displayById = new Map(displays.map(display => [display.sourceId, display]))
  const registered = new Set(sources.map(source => source.sourceId))
  // Only a READ catalogue proves a source is unloaded. Before that (initial
  // paint / failed request) the preference maps merely name sources; calling
  // them unavailable would be a fabricated "plugin not loaded" verdict.
  //
  // LIMIT: this retains only sources that carry an explicit preference entry.
  // A source that stayed at the default (absent entry = ON) leaves no durable
  // identity in S8's owned state, so it cannot be listed after its plugin
  // unloads without a persisted non-secret source inventory (S1/S2 wiring,
  // outside this Spec). Writing such entries from a catalogue read would
  // fabricate "configured" sources, so it is deliberately not done.
  const configuredOnly = catalogueLoaded
    ? [...new Set([
      ...Object.keys(prefs.clueSourcesEnabled),
      ...Object.keys(prefs.clueSourcesMentionEnabled),
    ])].filter(sourceId => !registered.has(sourceId)).sort()
    : []

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

      {statusError !== null && (
        <div className={css.error} role="alert">
          <span>{t('clueStateRequestFailed')} {statusError}</span>
          <button type="button" className={css.smallButton} onClick={props.onReload}>
            {t('retry')}
          </button>
        </div>
      )}

      {loading && !catalogueLoaded ? (
        <div className={css.loading} role="status">{t('loading')}</div>
      ) : (
        <>
          {/* A reload over an already-loaded table keeps the old rows visible;
              this busy line is the only cue that the list is being refreshed. */}
          {loading && (
            <div className={css.loading} role="status">{t('loading')}</div>
          )}
          {catalogueLoaded && (
          <div className={css.batchBar} role="group" aria-label={t('settingsGroupSources')}>
            <span className={css.batchScope}>{t('clueSourcesBatchScope')}</span>
            <span className={css.batchButtons}>
              {/* No registered source = no batch scope: the handlers would
                  no-op, so the controls must not look actionable. */}
              <button type="button" className={css.smallButton} disabled={sources.length === 0} onClick={props.onEnableAll}>
                {t('clueSourcesEnableAll')}
              </button>
              <button type="button" className={css.smallButton} disabled={sources.length === 0} onClick={props.onDisableAll}>
                {t('clueSourcesDisableAll')}
              </button>
              <button type="button" className={css.smallButton} disabled={sources.length === 0} onClick={props.onMentionAll}>
                {t('clueSourcesMentionAll')}
              </button>
              <button type="button" className={css.smallButton} disabled={sources.length === 0} onClick={props.onMentionNone}>
                {t('clueSourcesMentionNone')}
              </button>
            </span>
            {writeErrors.batch !== undefined && (
              <p className={css.rowError} role="alert" data-settings-error="batch">
                {writeErrors.batch}
              </p>
            )}
          </div>
          )}

          {!catalogueLoaded && error === null ? (
            <div className={css.loading} role="status">{t('loading')}</div>
          ) : catalogueLoaded && sources.length === 0 && configuredOnly.length === 0 ? (
            <div className={css.empty}>{t('clueSourcesEmpty')}</div>
          ) : catalogueLoaded ? (
            <ul className={css.sourceList} aria-label={t('settingsGroupSources')}>
              {sources.map(source => {
                const display = displayById.get(source.sourceId)
                const name = sourceDisplayName(source, display)
                const enabled = isClueSourceEnabled(prefs, source.sourceId)
                // The stored @ preference is preserved even while the source is
                // off; the switch is inert because the effective mention is off.
                const mention = isClueSourceMentionEnabled(prefs, source.sourceId)
                const status = statuses.get(source.sourceId) ?? { kind: 'unchecked' as const }
                const detailId = `clue-source-status-detail:${source.sourceId}`
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
                    <StatusBadge status={status} detailId={detailId} />
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
                      {hasSourceConfiguration(source) && (
                        <button
                          type="button"
                          className={css.smallButton}
                          aria-label={t('clueSourceConfigureAria', { source: name })}
                          onClick={() => { props.onConfigure(source.sourceId) }}
                        >
                          {t('clueConfigure')}
                        </button>
                      )}
                    </span>
                    {(['source', 'sourceMention'] as const).map(kind => {
                      const rowKey = `${kind}:${source.sourceId}`
                      return writeErrors[rowKey] === undefined ? null : (
                        <p key={rowKey} className={css.rowError} role="alert" data-settings-error={rowKey}>
                          {writeErrors[rowKey]}
                        </p>
                      )
                    })}
                    {/* The sanitized reason is ROW TEXT (plus the badge's
                        aria-describedby), not a hover-only title: keyboard and
                        screen-reader users get the same explanation. */}
                    {status.detail !== undefined && (
                      <p
                        className={css.sourceDetail}
                        id={detailId}
                        data-clue-source-detail={source.sourceId}
                      >
                        {status.detail}
                      </p>
                    )}
                  </li>
                )
              })}

              {/* Configured-but-unloaded sources: the stored switches and the
                  fact that the plugin is missing are both preserved (never
                  presented as ready, never silently dropped). */}
              {configuredOnly.map(sourceId => {
                const enabled = isClueSourceEnabled(prefs, sourceId)
                const mention = isClueSourceMentionEnabled(prefs, sourceId)
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
          ) : null}
        </>
      )}

      {/* The pack switch and the add-source entry are independent of the
          catalogue read, so they stay usable while it loads / after it fails. */}

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
            checked={isCluePacksMentionEnabled(prefs)}
            onChange={next => { props.onTogglePacksMention(next) }}
          />
        </span>
        {writeErrors.packs !== undefined && (
          <p className={css.rowError} role="alert" data-settings-error="packs">
            {writeErrors.packs}
          </p>
        )}
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
    </div>
  )
}
