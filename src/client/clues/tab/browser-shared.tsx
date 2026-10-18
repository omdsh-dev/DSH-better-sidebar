/**
 * Shared building blocks of the clue browser and the pack add-member page (S9).
 *
 * Both surfaces browse the SAME sources with the same range vocabulary: a
 * source glyph, the per-source scope form/summary, the direct-resource URL
 * detector and the stable candidate key. Keeping them here (instead of
 * re-implementing the add page) means a range parsed in the tab means the
 * same thing inside the pack window.
 */
import type { ReactNode } from 'react'
import { VscFile, VscReferences } from 'react-icons/vsc'
import type {
  ClueCandidate,
  ClueSourceDisplayDescriptor,
  JsonValue,
} from '../../../clues/types.ts'
import { BUILTIN_SOURCE_IDS } from '../../../clues/types.ts'
import { parseGithubRepoRef } from '../../../clues/sources/github/url.ts'
import { t } from '../../locales.ts'
import css from './clues-tab.module.css'

/** Stable row key of one candidate (the locator is source-normalized JSON). */
export function candidateKey(candidate: ClueCandidate): string {
  return `${candidate.sourceId}\u0000${candidate.typeId}\u0000${JSON.stringify(candidate.locator)}`
}


/** Render one source glyph (a factory receives the standard 16px). */
export function sourceIcon(
  sourceId: string,
  displays: readonly ClueSourceDisplayDescriptor[],
): ReactNode {
  const display = displays.find(candidate => candidate.sourceId === sourceId)
  const icon = display?.icon
  if (typeof icon === 'function') return icon(16)
  if (icon !== undefined) return icon
  return sourceId === BUILTIN_SOURCE_IDS.files
    ? <VscFile size={16} />
    : <VscReferences size={16} />
}


/** Whether this source needs an explicitly chosen range before listing. */
export function scopeRequired(sourceId: string): boolean {
  return sourceId === BUILTIN_SOURCE_IDS.githubIssues
    || sourceId === BUILTIN_SOURCE_IDS.githubPulls
    || sourceId === BUILTIN_SOURCE_IDS.feishuDocs
}

/** The `kind` of a persisted Feishu docs range, when it has one. */
export function feishuRangeKind(scope: JsonValue | undefined): string | undefined {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return undefined
  const kind = (scope as Record<string, unknown>).kind
  return typeof kind === 'string' ? kind : undefined
}

/** Whether a LIST request still lacks an explicitly chosen range. */
export function listNeedsScope(sourceId: string, scope: JsonValue | undefined): boolean {
  return scopeRequired(sourceId) && scope === undefined
}

/**
 * Whether a SEARCH request still lacks a SEARCHABLE range.
 *
 * A GitHub range is searchable as soon as it names a repository. The Feishu
 * drive root and the wiki-space list are BROWSE-only ranges: the source can
 * list their children but cannot search "everything" without a concrete
 * folder / wiki node. Sending the browse range to search would fail as an
 * `invalid-request`, so the UI asks for the narrower range first.
 */
export function searchNeedsScope(sourceId: string, scope: JsonValue | undefined): boolean {
  if (!scopeRequired(sourceId)) return false
  if (scope === undefined) return true
  if (sourceId !== BUILTIN_SOURCE_IDS.feishuDocs) return false
  const kind = feishuRangeKind(scope)
  return kind === 'drive-root' || kind === 'wiki-spaces'
}


/** Whether one input text is a resource URL/path rather than a keyword. */
export function looksLikeResource(text: string): boolean {
  return /^https?:\/\//i.test(text)
    || text.startsWith('/')
    || text.startsWith('./')
    || text.startsWith('../')
    || text.startsWith('~/')
    || text.includes('\\')
    || /^[A-Za-z]:[\\/]/.test(text)
    || /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+#\d+$/.test(text)
}


/** The structured range a scope editor saves for one source. */
export interface ScopeForm {
  repo: string
  state: 'open' | 'closed' | 'all'
  docsKind: 'drive-root' | 'drive' | 'wiki' | 'wiki-spaces'
  docsToken: string
  docsSpace: string
  filesPath: string
}

export const EMPTY_FORM: ScopeForm = {
  repo: '',
  state: 'open',
  docsKind: 'drive-root',
  docsToken: '',
  docsSpace: '',
  filesPath: '',
}

/** Derive the editor's text fields from the persisted scope value. */
export function formOf(sourceId: string, scope: JsonValue | undefined): ScopeForm {
  const record = scope !== null && typeof scope === 'object' && !Array.isArray(scope)
    ? scope as Record<string, unknown>
    : undefined
  if (sourceId === BUILTIN_SOURCE_IDS.githubIssues || sourceId === BUILTIN_SOURCE_IDS.githubPulls) {
    const repo = typeof record?.repo === 'string' ? record.repo : ''
    const state = record?.state === 'closed' || record?.state === 'all' ? record.state : 'open'
    return { ...EMPTY_FORM, repo, state }
  }
  if (sourceId === BUILTIN_SOURCE_IDS.feishuDocs) {
    const kind = record?.kind
    if (kind === 'drive') {
      return { ...EMPTY_FORM, docsKind: 'drive', docsToken: typeof record?.folderToken === 'string' ? record.folderToken : '' }
    }
    if (kind === 'wiki') {
      return { ...EMPTY_FORM, docsKind: 'wiki', docsSpace: typeof record?.spaceId === 'string' ? record.spaceId : '' }
    }
    if (kind === 'wiki-spaces') return { ...EMPTY_FORM, docsKind: 'wiki-spaces' }
    return { ...EMPTY_FORM, docsKind: 'drive-root' }
  }
  if (sourceId === BUILTIN_SOURCE_IDS.files) {
    return { ...EMPTY_FORM, filesPath: typeof record?.path === 'string' ? record.path : '' }
  }
  return EMPTY_FORM
}

/** Build the persisted scope value from the editor form, or a validation error. */
export function scopeOfForm(sourceId: string, form: ScopeForm): { scope?: JsonValue; error?: string } {
  if (sourceId === BUILTIN_SOURCE_IDS.githubIssues || sourceId === BUILTIN_SOURCE_IDS.githubPulls) {
    const repo = parseGithubRepoRef(form.repo)
    if (repo === undefined) return { error: t('clueBrowserScopeInvalid') }
    return { scope: { repo: `${repo.owner}/${repo.repo}`, state: form.state } }
  }
  if (sourceId === BUILTIN_SOURCE_IDS.feishuDocs) {
    if (form.docsKind === 'drive') {
      const token = form.docsToken.trim()
      if (token === '') return { error: t('clueBrowserScopeInvalid') }
      return { scope: { kind: 'drive', folderToken: token } }
    }
    if (form.docsKind === 'wiki') {
      const spaceId = form.docsSpace.trim()
      if (spaceId === '') return { error: t('clueBrowserScopeInvalid') }
      return { scope: { kind: 'wiki', spaceId } }
    }
    return { scope: { kind: form.docsKind } }
  }
  if (sourceId === BUILTIN_SOURCE_IDS.files) {
    const path = form.filesPath.trim()
    // An emptied path CLEARS the range. `null` is an explicit tombstone: the
    // host's settings merge is a deep patch, so omitting the key (or sending
    // `undefined`, which its clone strips) would keep the previously saved
    // path alive. The container persists it and normalizes it back to
    // "no range" for readers.
    return { scope: path === '' ? null : { path } }
  }
  return { scope: undefined }
}

/** A short, human range summary for the bar. */
export function scopeSummary(sourceId: string, scope: JsonValue | undefined): string | undefined {
  if (scope === undefined || scope === null) return undefined
  const record = scope !== null && typeof scope === 'object' && !Array.isArray(scope)
    ? scope as Record<string, unknown>
    : undefined
  if (sourceId === BUILTIN_SOURCE_IDS.githubIssues || sourceId === BUILTIN_SOURCE_IDS.githubPulls) {
    const repo = typeof record?.repo === 'string' ? record.repo : undefined
    if (repo === undefined) return undefined
    const state = record?.state === 'closed' ? t('clueBrowserStateClosed')
      : record?.state === 'all' ? t('clueBrowserStateAll')
        : t('clueBrowserStateOpen')
    return `${repo} · ${state}`
  }
  if (sourceId === BUILTIN_SOURCE_IDS.feishuDocs) {
    if (record?.kind === 'drive') return t('clueBrowserScopeDocsFolder')
    if (record?.kind === 'wiki') return t('clueBrowserScopeDocsWiki')
    if (record?.kind === 'wiki-spaces') return t('clueBrowserScopeDocsWikiAll')
    return t('clueBrowserScopeDocsDriveRoot')
  }
  if (sourceId === BUILTIN_SOURCE_IDS.files) {
    return typeof record?.path === 'string' ? record.path : t('clueBrowserScopeFilesRoot')
  }
  return undefined
}


/** The per-source range editor fields. */
export function ScopeFields(props: {
  readonly sourceId: string
  readonly form: ScopeForm
  onChange(next: ScopeForm): void
}): ReactNode {
  const { sourceId, form, onChange } = props
  if (sourceId === BUILTIN_SOURCE_IDS.githubIssues || sourceId === BUILTIN_SOURCE_IDS.githubPulls) {
    return (
      <>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('clueBrowserScopeGithubRepo')}</span>
          <input
            className={css.textInput}
            value={form.repo}
            placeholder={t('clueBrowserScopeGithubRepoPlaceholder')}
            onChange={(event) => { onChange({ ...form, repo: event.target.value }) }}
          />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('clueBrowserScopeGithubState')}</span>
          <select
            className={css.select}
            value={form.state}
            onChange={(event) => { onChange({ ...form, state: event.target.value as ScopeForm['state'] }) }}
          >
            <option value="open">{t('clueBrowserStateOpen')}</option>
            <option value="closed">{t('clueBrowserStateClosed')}</option>
            <option value="all">{t('clueBrowserStateAll')}</option>
          </select>
        </label>
      </>
    )
  }
  if (sourceId === BUILTIN_SOURCE_IDS.feishuDocs) {
    return (
      <>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('clueBrowserScopeHeading')}</span>
          <select
            className={css.select}
            value={form.docsKind}
            onChange={(event) => { onChange({ ...form, docsKind: event.target.value as ScopeForm['docsKind'] }) }}
          >
            <option value="drive-root">{t('clueBrowserScopeDocsDriveRoot')}</option>
            <option value="drive">{t('clueBrowserScopeDocsFolder')}</option>
            <option value="wiki">{t('clueBrowserScopeDocsWiki')}</option>
            <option value="wiki-spaces">{t('clueBrowserScopeDocsWikiAll')}</option>
          </select>
        </label>
        {form.docsKind === 'drive' && (
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('clueBrowserScopeDocsFolder')}</span>
            <input
              className={css.textInput}
              value={form.docsToken}
              placeholder={t('clueBrowserScopeTokenPlaceholder')}
              onChange={(event) => { onChange({ ...form, docsToken: event.target.value }) }}
            />
          </label>
        )}
        {form.docsKind === 'wiki' && (
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('clueBrowserScopeDocsWiki')}</span>
            <input
              className={css.textInput}
              value={form.docsSpace}
              placeholder={t('clueBrowserScopeSpacePlaceholder')}
              onChange={(event) => { onChange({ ...form, docsSpace: event.target.value }) }}
            />
          </label>
        )}
      </>
    )
  }
  return (
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('clueBrowserScopeFilesPath')}</span>
      <input
        className={css.textInput}
        value={form.filesPath}
        placeholder={t('clueBrowserScopeFilesPathPlaceholder')}
        onChange={(event) => { onChange({ ...form, filesPath: event.target.value }) }}
      />
    </label>
  )
}
