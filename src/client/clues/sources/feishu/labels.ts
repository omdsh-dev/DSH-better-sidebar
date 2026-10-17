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
  readonly limitedFragment: string
  readonly invalidDocument: string
  readonly title: string
  readonly description: string
  readonly start: string
  readonly due: string
  readonly allDay: string
  readonly completed: string
  readonly save: string
  readonly saving: string
  readonly setTime: string
  readonly titleRequired: string
  readonly startAfterDue: string
  readonly taskGuid: string
  readonly noTime: string
  readonly open: string
}

/** English defaults; every key can be overridden by S9's localized copy. */
export const DEFAULT_FEISHU_LABELS: FeishuClientLabels = {
  docsName: 'Feishu docs',
  tasksName: 'Feishu tasks',
  readOnly: 'Read-only preview',
  xml: 'XML',
  markdown: 'Markdown',
  revision: 'Revision',
  contentTruncated: 'Preview truncated; the full document is available through the source.',
  limitedFragment: 'This is one fragment of a longer document.',
  invalidDocument: 'This document payload could not be previewed.',
  title: 'Title',
  description: 'Description',
  start: 'Start',
  due: 'Due',
  allDay: 'All day',
  completed: 'Completed',
  save: 'Save',
  saving: 'Saving…',
  setTime: 'Set time',
  titleRequired: 'A task title is required.',
  startAfterDue: 'The start must not be later than the due time.',
  taskGuid: 'Task GUID',
  noTime: 'Not set',
  open: 'Open',
}

/** Merge caller overrides over the defaults. */
export function resolveFeishuLabels(overrides?: Partial<FeishuClientLabels>): FeishuClientLabels {
  return overrides === undefined ? DEFAULT_FEISHU_LABELS : { ...DEFAULT_FEISHU_LABELS, ...overrides }
}
