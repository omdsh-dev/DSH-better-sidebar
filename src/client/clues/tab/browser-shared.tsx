/**
 * Shared building blocks of the clue browser and the pack add-member page (S9).
 *
 * Both surfaces browse the SAME sources with the same range vocabulary: a
 * source glyph, the per-source scope form/summary, the direct-resource URL
 * detector and the stable candidate key. Keeping them here (instead of
 * re-implementing the add page) means a range parsed in the tab means the
 * same thing inside the pack window.
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import { VscReferences } from 'react-icons/vsc'
import type {
  ClueCandidate,
  ClueSourceDescriptor,
  ClueSourceDisplayDescriptor,
  JsonValue,
} from '../../../clues/types.ts'
import { BUILTIN_SOURCE_IDS } from '../../../clues/types.ts'
import { parseGithubRepoRef } from '../../../clues/sources/github/url.ts'
import { t } from '../../locales.ts'
import { Field, SourceSwitcher, TextInput } from '../../ui/index.ts'
import css from './clues-tab.module.css'

/** Stable row key of one candidate (the locator is source-normalized JSON). */
export function candidateKey(candidate: ClueCandidate): string {
  return `${candidate.sourceId}\u0000${candidate.typeId}\u0000${JSON.stringify(candidate.locator)}`
}


/** Render one source glyph (a factory receives the standard 16px). */
export function sourceIcon(
  sourceId: string,
  displays: readonly ClueSourceDisplayDescriptor[],
  size = 16,
): ReactNode {
  const display = displays.find(candidate => candidate.sourceId === sourceId)
  const icon = display?.icon
  if (typeof icon === 'function') return icon(size)
  if (icon !== undefined) return icon
  return sourceId === BUILTIN_SOURCE_IDS.files
    ? <FileTypeIcon kind="folder" size={size} />
    : <VscReferences size={size} />
}

/** Local resources use the host's file-type artwork; registrations still win. */
export function resourceIcon(
  candidate: Pick<ClueCandidate, 'sourceId' | 'typeId' | 'locator' | 'title'>,
  displays: readonly ClueSourceDisplayDescriptor[],
  size = 16,
): ReactNode {
  if (displays.some(display => display.sourceId === candidate.sourceId && display.icon !== undefined)) return sourceIcon(candidate.sourceId, displays, size)
  if (folderScopeOf(candidate) !== undefined) return <FileTypeIcon kind="folder" size={size} />
  if (candidate.sourceId !== BUILTIN_SOURCE_IDS.files) {
    return sourceIcon(candidate.sourceId, displays, size)
  }
  if (candidate.typeId === 'builtin.files.directory') return <FileTypeIcon kind="folder" size={size} />
  const path = typeof candidate.locator.path === 'string' ? candidate.locator.path : candidate.title
  return <FileTypeIcon path={path} size={size} />
}


/** Folder/scope rows navigate one level; they are never unreadable documents. */
export function folderScopeOf(candidate: Pick<ClueCandidate, 'sourceId' | 'typeId' | 'locator'>): JsonValue | undefined {
  if (candidate.sourceId === BUILTIN_SOURCE_IDS.files && candidate.typeId === 'builtin.files.directory') return { locator: candidate.locator }
  if (candidate.sourceId !== BUILTIN_SOURCE_IDS.feishuDocs) return undefined
  if (candidate.locator.kind === 'drive-folder' && typeof candidate.locator.folderToken === 'string') return { kind: 'drive', folderToken: candidate.locator.folderToken }
  if (candidate.locator.kind === 'wiki-space' && typeof candidate.locator.spaceId === 'string') return { kind: 'wiki', spaceId: candidate.locator.spaceId }
  return undefined
}

/** Shared single source selector for the browser and pack member browser. */
export function SourceNavigation(props: {
  readonly sources: readonly ClueSourceDescriptor[]
  readonly displays: readonly ClueSourceDisplayDescriptor[]
  readonly activeId: string
  onChange(sourceId: string): void
}): ReactNode {
  const { sources, displays, activeId, onChange } = props
  const items = sources.map(source => {
    const label = source.sourceId === BUILTIN_SOURCE_IDS.files
      ? t('clueLocalFilesName')
      : displays.find(display => display.sourceId === source.sourceId)?.name ?? source.name
    return {
      value: source.sourceId,
      label,
      icon: sourceIcon(source.sourceId, displays, 14),
    }
  })
  return (
    <SourceSwitcher className={css.sourceNav} items={items} value={activeId} onChange={onChange} ariaLabel={t('clueSourceLabel')} />
  )
}


/** Whether this source needs an explicitly chosen range before listing. */
function scopeRequired(sourceId: string): boolean {
  return sourceId === BUILTIN_SOURCE_IDS.githubIssues
    || sourceId === BUILTIN_SOURCE_IDS.githubPulls
    || sourceId === BUILTIN_SOURCE_IDS.feishuDocs
}

/** The `kind` of a persisted Feishu docs range, when it has one. */
function feishuRangeKind(scope: JsonValue | undefined): string | undefined {
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
 *
 * One exception is deliberate: Feishu docs accepts a keyword with NO range at
 * all (`drive +search --query` without a filter searches everything the
 * account can see). The caller passes the query so this global search is
 * allowed; the UI then shows the explicit account-wide range hint.
 */
export function searchNeedsScope(
  sourceId: string,
  scope: JsonValue | undefined,
  query?: string,
): boolean {
  if (!scopeRequired(sourceId)) return false
  if (sourceId === BUILTIN_SOURCE_IDS.feishuDocs
    && scope === undefined
    && query !== undefined
    && query.trim() !== '') {
    return false
  }
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
    const locator = record?.locator as Record<string, unknown> | undefined
    return { ...EMPTY_FORM, filesPath: typeof record?.path === 'string' ? record.path : typeof locator?.path === 'string' ? locator.path : '' }
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
  if (scope === undefined || scope === null) {
    return sourceId === BUILTIN_SOURCE_IDS.files ? t('clueBrowserScopeFilesRoot') : undefined
  }
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
    const locator = record?.locator as Record<string, unknown> | undefined
    return typeof record?.path === 'string' ? record.path : typeof locator?.path === 'string' ? locator.path : t('clueBrowserScopeFilesRoot')
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
  const choiceName = useId()
  if (sourceId === BUILTIN_SOURCE_IDS.githubIssues || sourceId === BUILTIN_SOURCE_IDS.githubPulls) {
    return (
      <>
        <Field label={t('clueBrowserScopeGithubRepo')} htmlFor={`${choiceName}-repo`}>
          <TextInput
            id={`${choiceName}-repo`}
            value={form.repo}
            placeholder={t('clueBrowserScopeGithubRepoPlaceholder')}
            onChange={(event) => { onChange({ ...form, repo: event.target.value }) }}
          />
        </Field>
        <fieldset className={css.scopeChoices}>
          <legend className={css.fieldLabel}>{t('clueBrowserScopeGithubState')}</legend>
          {([
            ['open', 'clueBrowserStateOpen'],
            ['closed', 'clueBrowserStateClosed'],
            ['all', 'clueBrowserStateAll'],
          ] as const).map(([state, label]) => (
            <label key={state} className={css.scopeChoice}>
              <input className={css.scopeChoiceInput} type="radio" name={`${choiceName}-state`} value={state} checked={form.state === state}
                onChange={() => { onChange({ ...form, state }) }} />
              <span>{t(label)}</span>
            </label>
          ))}
        </fieldset>
      </>
    )
  }
  if (sourceId === BUILTIN_SOURCE_IDS.feishuDocs) {
    return (
      <>
        <fieldset className={css.scopeChoices}>
          <legend className={css.fieldLabel}>{t('clueBrowserScopeHeading')}</legend>
          {([
            ['drive-root', 'clueBrowserScopeDocsDriveRoot'],
            ['drive', 'clueBrowserScopeDocsFolder'],
            ['wiki', 'clueBrowserScopeDocsWiki'],
            ['wiki-spaces', 'clueBrowserScopeDocsWikiAll'],
          ] as const).map(([docsKind, label]) => (
            <label key={docsKind} className={css.scopeChoice}>
              <input className={css.scopeChoiceInput} type="radio" name={`${choiceName}-docs-kind`} value={docsKind} checked={form.docsKind === docsKind}
                onChange={() => { onChange({ ...form, docsKind }) }} />
              <span>{t(label)}</span>
            </label>
          ))}
        </fieldset>
        {form.docsKind === 'drive' && (
          <Field label={t('clueBrowserScopeDocsFolder')} htmlFor={`${choiceName}-folder`}>
            <TextInput
              id={`${choiceName}-folder`}
              value={form.docsToken}
              placeholder={t('clueBrowserScopeTokenPlaceholder')}
              onChange={(event) => { onChange({ ...form, docsToken: event.target.value }) }}
            />
          </Field>
        )}
        {form.docsKind === 'wiki' && (
          <Field label={t('clueBrowserScopeDocsWiki')} htmlFor={`${choiceName}-wiki`}>
            <TextInput
              id={`${choiceName}-wiki`}
              value={form.docsSpace}
              placeholder={t('clueBrowserScopeSpacePlaceholder')}
              onChange={(event) => { onChange({ ...form, docsSpace: event.target.value }) }}
            />
          </Field>
        )}
      </>
    )
  }
  return (
    <Field label={t('clueBrowserScopeFilesPath')} htmlFor={`${choiceName}-path`}>
      <TextInput
        id={`${choiceName}-path`}
        value={form.filesPath}
        placeholder={t('clueBrowserScopeFilesPathPlaceholder')}
        onChange={(event) => { onChange({ ...form, filesPath: event.target.value }) }}
      />
    </Field>
  )
}
