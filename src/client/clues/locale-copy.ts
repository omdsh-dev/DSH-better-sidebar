/**
 * Localized copy handed to the S4/S5 client halves (S9 wiring).
 *
 * S4's Feishu renderers and S5's `@` sources deliberately own no locale
 * dictionary: they accept copy through their public options. S9 owns the
 * `betterSidebar` namespace, so this module is the ONE place that maps those
 * options onto `t()` keys. Keeping it separate from `index.tsx` lets the
 * locale contract be tested without mounting the whole client plugin.
 */
import type { FeishuClientLabels } from './sources/feishu/labels.ts'
import type { ClueContentReferenceErrorReason, ClueMentionsCopy } from './mentions.ts'
import { t } from '../locales.ts'

/** A key of the sidebar dictionary. */
type CopyKey = Parameters<typeof t>[0]

/** The content-reference error copy per stable reason code. */
const REFERENCE_ERROR_KEYS: Readonly<Record<ClueContentReferenceErrorReason, CopyKey>> = {
  malformed: 'clueMentionsRefMalformed',
  'unknown-kind': 'clueMentionsRefUnknownKind',
  'unserializable-id': 'clueMentionsRefUnserializableId',
  'missing-workspace': 'clueMentionsRefMissingWorkspace',
  'invalid-session': 'clueMentionsRefInvalidSession',
  'empty-workspace': 'clueMentionsRefEmptyWorkspace',
  'empty-session': 'clueMentionsRefEmptySession',
  'kind-mismatch': 'clueMentionsRefKindMismatch',
}

/**
 * The complete localized label set of the Feishu source renderers.
 * `xml`/`markdown` are format names, not sentences: they stay verbatim in
 * every locale.
 */
export function feishuClientLabels(): FeishuClientLabels {
  return {
    docsName: t('clueFeishuDocsName'),
    tasksName: t('clueFeishuTasksName'),
    readOnly: t('windowReadOnly'),
    xml: 'XML',
    markdown: 'Markdown',
    revision: t('clueFeishuRevision'),
    contentTruncated: t('clueFeishuContentTruncated'),
    showFullContent: t('clueFeishuShowFullContent'),
    showLess: t('clueFeishuShowLess'),
    limitedFragment: t('clueFeishuLimitedFragment'),
    emptyContent: t('clueFeishuEmptyContent'),
    invalidDocument: t('clueFeishuInvalidDocument'),
    title: t('clueFeishuTitle'),
    description: t('clueFeishuDescription'),
    emptyDescription: t('clueFeishuEmptyDescription'),
    start: t('clueFeishuStart'),
    due: t('clueFeishuDue'),
    allDay: t('clueFeishuAllDay'),
    completed: t('clueFeishuCompleted'),
    save: t('save'),
    saving: t('windowSaving'),
    setTime: t('clueFeishuSetTime'),
    titleRequired: t('clueFeishuTitleRequired'),
    docsTitleRequired: t('clueFeishuDocsTitleRequired'),
    startAfterDue: t('clueFeishuStartAfterDue'),
    allDayMismatch: t('clueFeishuAllDayMismatch'),
    taskGuid: t('clueFeishuTaskGuid'),
    noTime: t('clueFeishuNoTime'),
    open: t('clueFeishuOpen'),
    docsEditScopeNote: t('clueFeishuDocsEditScopeNote'),
    blocks: t('clueFeishuBlocks'),
    blockReadOnly: t('clueFeishuBlockReadOnly'),
    noBlocks: t('clueFeishuNoBlocks'),
    sourceLink: t('clueFeishuSourceLink'),
    resourceLink: t('clueFeishuResourceLink'),
    fetchedAt: t('clueFeishuFetchedAt'),
    freshness: t('clueFeishuFreshness'),
    freshnessLive: t('clueFeishuFreshnessLive'),
    freshnessSnapshot: t('clueFeishuFreshnessSnapshot'),
    fragmentBlocks: t('clueFeishuFragmentBlocks'),
    fragmentBytes: t('clueFeishuFragmentBytes'),
    updatedAt: t('clueFeishuUpdatedAt'),
    markdownReadOnly: t('clueFeishuMarkdownReadOnly'),
    invalidTask: t('clueFeishuInvalidTask'),
    invalidTime: t('clueFeishuInvalidTime'),
    genericValidation: t('clueFeishuGenericValidation'),
  }
}

/**
 * The localized user-visible copy of the `@` trigger sources (S5).
 *
 * Every callback receives already-escaped display metadata and stable
 * reference tokens only, so localization cannot mint or leak a reference.
 */
export function clueMentionsCopy(): Partial<ClueMentionsCopy> {
  return {
    includeContentSuffix: t('clueMentionsIncludeContentSuffix'),
    clueReferenceDescription: (source, type) => t('clueMentionsReferenceDescription', { source, type }),
    clueContentDescription: (source, type) => t('clueMentionsContentDescription', { source, type }),
    packContentDescription: count => t('clueMentionsPackContentDescription', { n: count }),
    clueInsertFailed: t('clueInsertFailed'),
    packInsertFailed: t('cluePackInsertFailed'),
    contentFailure: (what, _category, detail) =>
      t('clueMentionsContentFailure', { what, detail: detail === '' ? '' : `: ${detail}` }),
    contentLimit: (size, max) => t('clueMentionsContentLimit', { size, max }),
    contentReferenceError: reason => t(REFERENCE_ERROR_KEYS[reason]),
    contentMissing: (kind, token) => t('clueMentionsContentMissing', {
      kind: kind === 'clue' ? t('clueHelpClueLabel') : t('clueHelpPackLabel'),
      token,
    }),
    packMemberLimit: (token, count, max) => t('clueMentionsPackMemberLimit', { token, count, max }),
    packMemberMissing: (token, memberId) => t('clueMentionsPackMemberMissing', { token, memberId }),
    packMemberNotTokenSafe: token => t('clueMentionsPackMemberNotTokenSafe', { token }),
    partialRead: (token, nextOffset) => t('clueMentionsPartialRead', { token, next: String(nextOffset) }),
  }
}

/** The localized heading of the explicit "include content" candidate rows. */
export function clueMentionsContentSection(): string {
  return t('clueMentionsContentSection')
}
