/**
 * A full unified-diff document (one changed file, or every file of a commit
 * patch): collapsible per-file headers — source files open by default, tests
 * / docs / generated files stay folded — each expanded file rendering through
 * the shared {@link DiffRows} (so git diffs get the same rewrite tinting,
 * intra-line highlights, syntax colors and hunk folds as session-op diffs).
 * Untracked files produce no `git diff` output; the caller passes their
 * content to render as a full-file addition instead.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { t } from '../locales.ts'
import { diffStats, displayPath, parseUnifiedDiff, unifiedSegments, untrackedFile, type DiffFile } from './rows.ts'
import { langOfPath } from './highlight.ts'
import { DiffRows } from './DiffRows.tsx'
import css from './diff.module.css'

const TEST_PATH = /(^|\/)(?:__tests__|tests?|specs?|fixtures?|mocks?|snapshots?)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i
const DOC_PATH = /(^|\/)(?:docs?|documentation)(?:\/|$)|(^|\/)(?:readme|changelog|contributing|license|authors|notice)(\.[^/]*)?$/i
const GENERATED_PATH = /(^|\/)(?:dist|build|coverage|generated|vendor|node_modules)(?:\/|$)|(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|composer\.lock|cargo\.lock|poetry\.lock)$/i
const SOURCE_PATH = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyw|rb|php|java|kt|kts|scala|go|rs|swift|c|h|cc|cpp|cxx|hpp|hh|hxx|cs|fs|fsx|vb|dart|lua|r|ex|exs|erl|hrl|clj|cljs|cljc|groovy|sh|bash|zsh|fish|ps1|sql|vue|svelte|astro|html|htm|css|scss|sass|less)$/i

/** Source files open by default; tests, docs, generated files and unknown types stay folded. */
function defaultExpandedFiles(files: readonly DiffFile[]): Set<number> {
  const expanded = new Set<number>()
  files.forEach((file, index) => {
    const path = displayPath(file.newPath === '/dev/null' ? file.oldPath : file.newPath)
    if (!file.binary && file.hunks.length > 0
      && !TEST_PATH.test(path) && !DOC_PATH.test(path) && !GENERATED_PATH.test(path)
      && SOURCE_PATH.test(path)) {
      expanded.add(index)
    }
  })
  return expanded
}

/** The file header badge: added / deleted / renamed / binary ('' for a plain edit). */
function fileTag(file: DiffFile): string | null {
  if (file.binary) return t('diffBinary')
  if (file.oldPath === '/dev/null') return t('diffAdded')
  if (file.newPath === '/dev/null') return t('diffDeleted')
  const oldPath = displayPath(file.oldPath)
  const newPath = displayPath(file.newPath)
  if (oldPath !== newPath) return t('diffRenamed')
  return null
}

export interface DiffFilesProps {
  /** Unified diff text (`git.diff` or `git.commit-diff` payloads). */
  diff: string
  /** Untracked-file content: when present, renders as a full-file addition instead of parsing. */
  untrackedPath?: string
  untrackedContent?: string
}

export function DiffFiles({ diff, untrackedPath, untrackedContent }: DiffFilesProps) {
  const parsed = useMemo(() => {
    if (untrackedPath !== undefined) {
      return { files: [untrackedFile(untrackedPath, untrackedContent ?? '')] }
    }
    return parseUnifiedDiff(diff)
  }, [diff, untrackedPath, untrackedContent])
  const [expandedFiles, setExpandedFiles] = useState<Set<number>>(() => defaultExpandedFiles(parsed.files))
  useEffect(() => { setExpandedFiles(defaultExpandedFiles(parsed.files)) }, [parsed])

  // Segments and header stats computed once per file.
  const files = useMemo(
    () => parsed.files.map((file) => {
      const segments = unifiedSegments(file)
      return { file, segments, stats: diffStats(segments) }
    }),
    [parsed],
  )

  const renderFile = (entry: (typeof files)[number], fileIndex: number): ReactNode => {
    const { file, segments, stats } = entry
    const tag = fileTag(file)
    const from = displayPath(file.oldPath)
    const to = displayPath(file.newPath)
    const expandable = !file.binary && file.hunks.length > 0
    const fileExpanded = expandedFiles.has(fileIndex)
    return (
      <div key={`file-${String(fileIndex)}`} className={css.fileBlock}>
        <button
          type="button"
          className={css.file}
          disabled={!expandable}
          aria-expanded={expandable ? fileExpanded : undefined}
          onClick={() => {
            setExpandedFiles(current => {
              const next = new Set(current)
              if (next.has(fileIndex)) next.delete(fileIndex)
              else next.add(fileIndex)
              return next
            })
          }}
        >
          {expandable && <span aria-hidden="true" className={clsx(css.fileChevron, fileExpanded && css.fileChevronExpanded)}>›</span>}
          <span className={css.filePath}>{to}</span>
          {from !== to && <span className={css.fileOld}>← {from}</span>}
          {tag !== null && <span className={css.fileTag}>{tag}</span>}
          {expandable && (stats.added > 0 || stats.deleted > 0) && (
            <span className={css.fileStats}>
              {stats.added > 0 && <span className={css.statAdd}>+{String(stats.added)}</span>}
              {stats.deleted > 0 && <span className={css.statDel}>−{String(stats.deleted)}</span>}
            </span>
          )}
        </button>
        {expandable && fileExpanded && (
          <DiffRows segments={segments} lang={langOfPath(to)} />
        )}
      </div>
    )
  }

  if (parsed.files.length === 0) return null
  return (
    <div className={css.files}>
      {files.map(renderFile)}
    </div>
  )
}
