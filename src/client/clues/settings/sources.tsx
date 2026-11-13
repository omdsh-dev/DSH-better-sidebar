/**
 * S8 clue source table (presentational, node-free).
 *
 * The PRIMARY surface stays deliberately small: one row per registered source
 * carrying its icon + name, derived availability badge, the source switch and
 * (only when the source actually declares a dependency or connection) exactly
 * one configure action. The technical `sourceId` is identity, not copy, so it
 * lives on the DOM (`data-clue-source`) instead of the visible row.
 *
 * Everything that is a secondary preference or a bulk operation — the per
 * source @ switches, the local pack @ switch and the four batch actions — is
 * folded into ONE native `<details>` disclosure at the bottom. This is a
 * layout-only move: the same prefs object and the same handlers are consumed,
 * so no preference is migrated or dropped. The add-source entry stays outside
 * the disclosure because it is a primary journey of its own.
 *
 * Preference semantics are S1's: an absent entry means ON. A source whose
 * plugin is not loaded any more stays visible with its stored switches (the
 * approved spec keeps that configuration), labelled unavailable and disabled —
 * never rendered as ready.
 */
import type { ReactNode } from 'react'
import { FileTypeIcon, IconLinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { BUILTIN_SOURCE_IDS } from '../../../clues/types.ts'
import { CluePackArtwork } from '../artwork.tsx'
import { LoadingIndicator } from '../../ui/LoadingIndicator.tsx'
import { ActionButton, ToggleSwitch } from '../../ui/index.ts'
import { t, type CopyKey } from '../../locales.ts'
import {
  isCluePacksMentionEnabled,
  isClueSourceEnabled,
  isClueSourceMentionEnabled,
  type SidebarPrefs,
} from '../../../prefs-shared.ts'
import type { ClueSourceDescriptor, ClueSourceDisplayDescriptor } from '../../../clues/types.ts'
import type { ClueSourceStatus, ClueSourceStatusKind } from './status.ts'
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

/**
 * The configure action's label for one derived state.
 *
 * The action always opens the SAME configuration window (and keeps the
 * unchanged `Configure source: …` accessible name); only the verb is tuned to
 * the state the reader is looking at, so a missing CLI reads as an install
 * entry point and an unauthorized account as an authorization one. No label
 * here starts work by itself: installing still goes through the page's
 * plan → confirm → task pipeline and authorizing still needs its explicit
 * click.
 */
function configureLabel(kind: ClueSourceStatusKind): CopyKey {
  if (kind === 'missing' || kind === 'incompatible') return 'clueDependencyInstall'
  if (kind === 'not-authorized' || kind === 'auth-expired' || kind === 'authorizing') {
    return 'clueConnectionAuthorize'
  }
  return 'clueConfigure'
}

/**
 * Resolve a display's icon node.
 *
 * The descriptor only carries a SERIALIZABLE icon id (`descriptor.icon`); a
 * client display registration is what turns it into a themed glyph. Without
 * one the generic link glyph is the honest fallback — never an empty slot —
 * and the row keeps its accessible name (the visible source name plus the
 * labeled switches), so the icon is never the only identity.
 */
function displayIcon(display: ClueSourceDisplayDescriptor | undefined, sourceId: string): ReactNode {
  if (display?.icon === undefined) return sourceId === BUILTIN_SOURCE_IDS.files
    ? <FileTypeIcon kind="folder" size={16} />
    : <IconLinkOutlineRegular size={16} />
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
  if (source.sourceId === BUILTIN_SOURCE_IDS.files) return t('clueLocalFilesName')
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
 * Render the source table + the advanced disclosure + the add-source entry.
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

  const modifiedMentionCount = [...sources.map(source => source.sourceId), ...configuredOnly]
    .filter(sourceId => !isClueSourceMentionEnabled(prefs, sourceId)).length
    + (isCluePacksMentionEnabled(prefs) ? 0 : 1)

  /** One @ switch row (inside the advanced disclosure). */
  const mentionRow = (sourceId: string, name: string, mention: boolean, disabled: boolean) => (
    <div className={css.advancedRow} key={`mention:${sourceId}`} data-clue-mention={sourceId}>
      <span className={css.advancedLabel}>{t('clueSourceMentionAria', { source: name })}</span>
      <ToggleSwitch
        aria-label={t('clueSourceMentionAria', { source: name })}
        checked={mention}
        disabled={disabled}
        title={disabled ? t('clueSourcesIntro') : undefined}
        onChange={next => { props.onToggleMention(sourceId, next) }}
      />
      {writeErrors[`sourceMention:${sourceId}`] !== undefined && (
        <p className={css.rowError} role="alert" data-settings-error={`sourceMention:${sourceId}`}>
          {writeErrors[`sourceMention:${sourceId}`]}
        </p>
      )}
    </div>
  )

  /** The add-source journey stays outside every catalogue-dependent fold. */
  const addSourceEntry = (
    <div className={css.addSource}>
      <ActionButton variant="outline" type="button" className={css.smallButton} onClick={props.onAddSource}>
        {t('clueAddSource')}
      </ActionButton>
    </div>
  )

  return (
    <div className={css.sources}>

      {error !== null && (
        <div className={css.error} role="alert">
          <span>{t('clueSourcesLoadFailed')} {error}</span>
          <ActionButton variant="outline" type="button" className={css.smallButton} onClick={props.onReload}>
            {t('retry')}
          </ActionButton>
        </div>
      )}

      {statusError !== null && (
        <div className={css.error} role="alert">
          <span>{t('clueStateRequestFailed')} {statusError}</span>
          <ActionButton variant="outline" type="button" className={css.smallButton} onClick={props.onReload}>
            {t('retry')}
          </ActionButton>
        </div>
      )}

      {loading && !catalogueLoaded ? (
        <>
          <LoadingIndicator className={css.loading} />
          {addSourceEntry}
        </>
      ) : (
        <>
          {/* A reload over an already-loaded table keeps the old rows visible;
              this busy line is the only cue that the list is being refreshed. */}
          {loading && (
            <LoadingIndicator className={css.loading} />
          )}

          {!catalogueLoaded && error === null ? (
            <LoadingIndicator className={css.loading} />
          ) : catalogueLoaded ? (
            sources.length === 0 && configuredOnly.length === 0
              ? <div className={css.empty}>{t('clueSourcesEmpty')}</div>
              : (
                <ul className={css.sourceList} aria-label={t('settingsGroupSources')}>
                  {sources.map(source => {
                    const display = displayById.get(source.sourceId)
                    const name = sourceDisplayName(source, display)
                    const enabled = isClueSourceEnabled(prefs, source.sourceId)
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
                          {/* The descriptor's serializable icon id is preserved on
                              the DOM for a future display registration; without
                              one the generic glyph renders and the row's text
                              names the source (the icon stays decorative). */}
                          <span
                            className={css.sourceIcon}
                            aria-hidden="true"
                            data-clue-source-icon={display?.icon === undefined ? 'fallback' : 'display'}
                            {...(display?.icon === undefined && source.icon !== undefined
                              ? { 'data-clue-source-icon-id': source.icon }
                              : {})}
                          >
                            {displayIcon(display, source.sourceId)}
                          </span>
                          <span className={css.sourceText}>
                            <span className={css.sourceName}>{name}</span>
                          </span>
                        </span>
                        <StatusBadge status={status} detailId={detailId} />
                        <span className={css.sourceControls}>
                          <ToggleSwitch
                            aria-label={t('clueSourceToggleAria', { source: name })}
                            checked={enabled}
                            onChange={next => { props.onToggleSource(source.sourceId, next) }}
                          />
                          {hasSourceConfiguration(source) && (
                            <ActionButton variant="outline"
                              type="button"
                              className={css.smallButton}
                              aria-label={t('clueSourceConfigureAria', { source: name })}
                              onClick={() => { props.onConfigure(source.sourceId) }}
                            >
                              {t(configureLabel(status.kind))}
                            </ActionButton>
                          )}
                        </span>
                        {writeErrors[`source:${source.sourceId}`] !== undefined && (
                          <p className={css.rowError} role="alert" data-settings-error={`source:${source.sourceId}`}>
                            {writeErrors[`source:${source.sourceId}`]}
                          </p>
                        )}
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
                    return (
                      <li
                        key={sourceId}
                        className={css.sourceRow}
                        data-clue-source={sourceId}
                        data-clue-source-status="unavailable"
                      >
                        <span className={css.sourceIdentity}>
                          <span className={css.sourceIcon} aria-hidden="true" data-clue-source-icon="fallback">
                            <IconLinkOutlineRegular size={16} />
                          </span>
                          <span className={css.sourceText}>
                            <span className={css.sourceName}>{sourceId}</span>
                          </span>
                        </span>
                        <span className={css.status} data-kind="unavailable" title={t('clueSourcesUnavailable')}>
                          {t('clueSourcesUnavailable')}
                        </span>
                        <span className={css.sourceControls}>
                          <ToggleSwitch
                            aria-label={t('clueSourceToggleAria', { source: sourceId })}
                            checked={enabled}
                            disabled
                            title={t('clueSourcesUnavailable')}
                            onChange={() => {}}
                          />
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )
          ) : null}

          {addSourceEntry}

          {/* Secondary preferences and bulk operations. The disclosure is a
              native <details> (keyboard/touch semantics for free); the pack
              switch stays available even when the catalogue itself failed, so
              no capability depends on a successful read. */}
          <details className={css.advanced} data-clue-advanced>
            <summary className={css.advancedSummary}>
              {t('clueSettingsAdvanced')}
              {modifiedMentionCount > 0 && (
                <span className={css.disclosureMeta}>{t('clueSettingsModified', { count: String(modifiedMentionCount) })}</span>
              )}
            </summary>
            <div className={css.advancedBody}>
              {catalogueLoaded && sources.map(source => mentionRow(
                source.sourceId,
                sourceDisplayName(source, displayById.get(source.sourceId)),
                isClueSourceMentionEnabled(prefs, source.sourceId),
                !isClueSourceEnabled(prefs, source.sourceId),
              ))}
              {configuredOnly.map(sourceId => mentionRow(
                sourceId,
                sourceId,
                isClueSourceMentionEnabled(prefs, sourceId),
                true,
              ))}

              {/* The local clue-pack library is NOT a source: its own @ switch,
                  no source switch and no configure entry. */}
              <div className={css.advancedRow} data-clue-packs="">
                <span className={css.packIdentity}>
                  <span className={css.sourceIcon} aria-hidden="true"><CluePackArtwork size={16} /></span>
                  <span className={css.sourceText}>
                    <span className={css.sourceName}>{t('cluePacksName')}</span>
                  </span>
                </span>
                <ToggleSwitch
                  aria-label={t('cluePacksMentionAria')}
                  checked={isCluePacksMentionEnabled(prefs)}
                  onChange={next => { props.onTogglePacksMention(next) }}
                />
                {writeErrors.packs !== undefined && (
                  <p className={css.rowError} role="alert" data-settings-error="packs">
                    {writeErrors.packs}
                  </p>
                )}
              </div>

              {catalogueLoaded && (
                <div className={css.batchBar} role="group" aria-label={t('settingsGroupSources')}>
                  <span className={css.batchScope}>{t('clueSourcesBatchScope')}</span>
                  <span className={css.batchButtons}>
                    {/* No registered source = no batch scope: the handlers would
                        no-op, so the controls must not look actionable. */}
                    <ActionButton variant="outline" type="button" className={css.smallButton} disabled={sources.length === 0} onClick={props.onEnableAll}>
                      {t('clueSourcesEnableAll')}
                    </ActionButton>
                    <ActionButton variant="outline" type="button" className={css.smallButton} disabled={sources.length === 0} onClick={props.onDisableAll}>
                      {t('clueSourcesDisableAll')}
                    </ActionButton>
                    <ActionButton variant="outline" type="button" className={css.smallButton} disabled={sources.length === 0} onClick={props.onMentionAll}>
                      {t('clueSourcesMentionAll')}
                    </ActionButton>
                    <ActionButton variant="outline" type="button" className={css.smallButton} disabled={sources.length === 0} onClick={props.onMentionNone}>
                      {t('clueSourcesMentionNone')}
                    </ActionButton>
                  </span>
                  {writeErrors.batch !== undefined && (
                    <p className={css.rowError} role="alert" data-settings-error="batch">
                      {writeErrors.batch}
                    </p>
                  )}
                </div>
              )}
            </div>
          </details>

        </>
      )}
    </div>
  )
}
