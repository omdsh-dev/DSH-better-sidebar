/**
 * User-facing copy of the Feishu client renderers.
 *
 * The locale dictionaries are owned by S9, so S4 never writes into
 * `src/client/locales*`. Instead the registration function accepts an
 * optional label override; S9 passes its localized dictionary here. The
 * defaults are English and are also the fallback for a missing key.
 */
export interface FeishuClientLabels {
  readonly docsName: string
  readonly tasksName: string
  readonly readOnly: string
  readonly xml: string
  readonly markdown: string
  readonly revision: string
  readonly contentTruncated: string
  readonly showFullContent: string
  readonly showLess: string
  readonly limitedFragment: string
  readonly emptyContent: string
  readonly invalidDocument: string
  readonly title: string
  readonly description: string
  readonly emptyDescription: string
  readonly start: string
  readonly due: string
  readonly allDay: string
  readonly completed: string
  readonly save: string
  readonly saving: string
  readonly setTime: string
  readonly titleRequired: string
  readonly docsTitleRequired: string
  readonly startAfterDue: string
  readonly allDayMismatch: string
  readonly taskGuid: string
  readonly noTime: string
  readonly open: string
  /** Docs editor copy. */
  readonly docsEditScopeNote: string
  readonly blocks: string
  readonly blockReadOnly: string
  readonly noBlocks: string
  readonly sourceLink: string
  readonly resourceLink: string
  readonly fetchedAt: string
  readonly freshness: string
  readonly freshnessLive: string
  readonly freshnessSnapshot: string
  readonly fragmentBlocks: string
  readonly fragmentBytes: string
  readonly updatedAt: string
  readonly markdownReadOnly: string
  /** Task validation / time-editing copy. */
  readonly invalidTask: string
  readonly invalidTime: string
  readonly genericValidation: string
}

/** English defaults; every key can be overridden by S9's localized copy. */
export const DEFAULT_FEISHU_LABELS: FeishuClientLabels = {
  docsName: 'Feishu docs',
  tasksName: 'Feishu tasks',
  readOnly: 'Read-only preview',
  xml: 'XML',
  markdown: 'Markdown',
  revision: 'Revision',
  contentTruncated: 'Preview limited to keep the window responsive.',
  showFullContent: 'Show full content',
  showLess: 'Show less',
  limitedFragment: 'This is one fragment of a longer document.',
  emptyContent: 'This document has no text content.',
  invalidDocument: 'This document payload could not be previewed.',
  title: 'Title',
  description: 'Description',
  emptyDescription: 'No description.',
  start: 'Start',
  due: 'Due',
  allDay: 'All day',
  completed: 'Completed',
  save: 'Save',
  saving: 'Saving…',
  setTime: 'Set time',
  titleRequired: 'A task title is required.',
  docsTitleRequired: 'A document title is required.',
  startAfterDue: 'The start must not be later than the due time.',
  allDayMismatch: 'The start and due times must both be all-day or both be timed.',
  taskGuid: 'Task GUID',
  noTime: 'Not set',
  open: 'Open',
  docsEditScopeNote:
    'Only text blocks are editable (title, paragraphs, headings, lists, todos, quotes and code); '
    + 'tables, callouts, grids, images and other complex blocks stay read-only. '
    + 'Markdown is a read-only projection and never a save input.',
  blocks: 'Text blocks',
  blockReadOnly: 'Read-only block',
  noBlocks: 'This document has no editable text blocks.',
  sourceLink: 'Open in Feishu',
  resourceLink: 'Open resource',
  fetchedAt: 'Fetched',
  freshness: 'Freshness',
  freshnessLive: 'Live',
  freshnessSnapshot: 'Snapshot',
  fragmentBlocks: 'This is a fragment made of whole blocks from a longer XML document.',
  fragmentBytes: 'This is a raw byte fragment of a longer document; markup may be split.',
  updatedAt: 'Updated',
  markdownReadOnly: 'Markdown is a read-only projection of this document.',
  invalidTask: 'This task payload could not be previewed.',
  invalidTime: 'This time is not a valid instant.',
  genericValidation: 'This value is not valid.',
}

/** Merge caller overrides over the defaults. */
export function resolveFeishuLabels(overrides?: Partial<FeishuClientLabels>): FeishuClientLabels {
  return overrides === undefined ? DEFAULT_FEISHU_LABELS : { ...DEFAULT_FEISHU_LABELS, ...overrides }
}
