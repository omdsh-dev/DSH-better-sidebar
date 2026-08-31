/**
 * The one diff renderer every file-change surface shares (the changes tab's
 * inline preview pane and the diff tab): fold-capable hunk rows with old/new
 * line gutters, rewrite (mod) tinting with intra-line character highlights,
 * lightweight syntax coloring, and long-line folding. Presentational — the
 * segments arrive precomputed (session ops via buildDiffSegments, git diffs
 * via unifiedSegments) so both producers render identically.
 */
import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { t } from '../locales.ts'
import { coalesceInline, diffInline, MIN_FOLD, type DiffRow, type DiffSegment, type InlineDiff } from './rows.ts'
import { hasBlockComment, isColored, scanLine, type CodeToken, type TokenType } from './highlight.ts'
import css from './diff.module.css'

/** Long diff lines fold to one ellipsized row; the threshold is the char count. */
const FOLD_THRESHOLD = 120

/** Rendered hunk rows per file capped at this count; expand reveals the rest. */
const MAX_ROWS = 600

/** Token class -> CSS color class ('' inherits the row's diff color). */
const TOKEN_CLASS: Readonly<Record<TokenType, string>> = {
  plain: '',
  comment: css.tokComment ?? '',
  string: css.tokString ?? '',
  keyword: css.tokKeyword ?? '',
  number: css.tokNumber ?? '',
  type: css.tokType ?? '',
  function: css.tokFunction ?? '',
  macro: css.tokMacro ?? '',
}

/** One token span's class list: its color class, plus the change tint. */
function tokenSpanClass(type: TokenType, changed: boolean): string {
  const color = TOKEN_CLASS[type]
  return changed ? `${color} ${css.inlineChange}` : color
}

/** Render scanned tokens as colored nodes; uncolored runs stay text. */
function tokensToNodes(tokens: readonly CodeToken[], changed = false): ReactNode[] {
  const nodes: ReactNode[] = []
  for (const token of tokens) {
    if (!changed && !isColored(token)) nodes.push(token.text)
    else nodes.push(<span key={String(nodes.length)} className={tokenSpanClass(token.type, changed)}>{token.text}</span>)
  }
  return nodes
}

/**
 * Intra-line diffs for mod-row pairs, keyed by row identity: each mod-run's
 * first half (old side) pairs with its second half (new side), each pair
 * diffed by common prefix/suffix so both sides highlight the exact changed
 * substring.
 */
function buildInlineMap(segments: readonly DiffSegment[]): Map<DiffRow, InlineDiff> {
  const map = new Map<DiffRow, InlineDiff>()
  for (const segment of segments) {
    if (segment.kind !== 'hunk') continue
    const rows = segment.rows
    let i = 0
    while (i < rows.length) {
      if (rows[i]!.kind !== 'mod') { i += 1; continue }
      let j = i
      while (j < rows.length && rows[j]!.kind === 'mod') j += 1
      const block = rows.slice(i, j)
      const half = Math.floor(block.length / 2)
      for (let p = 0; p < half; p += 1) {
        const delRow = block[p]!
        const addRow = block[p + half]!
        const inline = diffInline(delRow.text, addRow.text)
        map.set(delRow, inline)
        map.set(addRow, inline)
      }
      i = j
    }
  }
  return map
}

/**
 * Per-row block-comment entry state for a diff: the old side threads along
 * old-line order and the new side along new-line order (the row order
 * preserves both), so multi-line comments color correctly on each side.
 */
function diffBlockEntries(segments: readonly DiffSegment[], lang: string | undefined): Map<DiffRow, boolean> {
  const entries = new Map<DiffRow, boolean>()
  if (!hasBlockComment(lang)) return entries
  let oldIn = false
  let newIn = false
  for (const segment of segments) {
    if (segment.kind !== 'hunk') continue
    for (const row of segment.rows) {
      const isOld = row.oldLine !== undefined
      const isNew = row.newLine !== undefined
      entries.set(row, isOld ? oldIn : newIn)
      if (isOld) oldIn = scanLine(row.text, lang, oldIn).inBlock
      if (isNew) newIn = scanLine(row.text, lang, newIn).inBlock
    }
  }
  return entries
}

export interface DiffRowsProps {
  /** Precomputed segments (hunks and folds) for one file's diff. */
  segments: readonly DiffSegment[]
  /** Syntax language id (langOfPath); undefined renders plain text. */
  lang?: string
}

/** One file's diff rows: fold chips between hunks, highlighted code rows. */
export function DiffRows({ segments, lang }: DiffRowsProps) {
  // Long diff lines fold to one ellipsized row; the set holds expanded row keys.
  const [expandedLines, setExpandedLines] = useState<ReadonlySet<string>>(new Set())
  // Hunk-fold segments expanded by index; default collapsed.
  const [expandedFolds, setExpandedFolds] = useState<ReadonlySet<number>>(new Set())
  // Row-count cap expanded: a huge file renders head rows plus this button.
  const [expandedAll, setExpandedAll] = useState(false)
  // Reset all folding when the segments identity changes (new target).
  useEffect(() => {
    setExpandedLines(new Set())
    setExpandedFolds(new Set())
    setExpandedAll(false)
  }, [segments])

  const inlineMap = useMemo(() => buildInlineMap(segments), [segments])
  const blockEntries = useMemo(() => diffBlockEntries(segments, lang), [segments, lang])

  /** One diff row: colored sign + syntax-colored text, long-line fold toggle. */
  const renderDiffRow = (row: DiffRow, rowKey: string): ReactElement => {
    if (row.kind === 'meta') {
      return (
        <div key={rowKey} className={css.row} data-kind="meta">
          <span className={css.metaText}>{row.text}</span>
        </div>
      )
    }
    const isLong = row.text.length > FOLD_THRESHOLD
    const isFolded = isLong && !expandedLines.has(rowKey)
    const blockEntry = blockEntries.get(row) ?? false
    return (
      <div
        key={rowKey}
        className={css.row}
        data-kind={row.kind}
        data-folded={isFolded ? 'true' : undefined}
        onClick={isLong ? () => {
          setExpandedLines(prev => {
            const next = new Set(prev)
            if (next.has(rowKey)) next.delete(rowKey)
            else next.add(rowKey)
            return next
          })
        } : undefined}
        title={isFolded ? row.text : undefined}
      >
        <span className={css.lineNo}>{row.oldLine !== undefined ? String(row.oldLine) : ''}</span>
        <span className={css.lineNo}>{row.newLine !== undefined ? String(row.newLine) : ''}</span>
        <span className={css.sign}>{row.kind === 'del' ? '-' : row.kind === 'add' ? '+' : row.kind === 'mod' ? '~' : ' '}</span>
        <span className={css.text} data-folded={isFolded ? 'true' : undefined}>
          {row.kind === 'mod' && (() => {
            const inline = inlineMap.get(row)
            if (inline === undefined) return tokensToNodes(scanLine(row.text, lang, blockEntry).tokens)
            // Coalesced change runs, each split into syntax tokens with
            // block-comment state threaded across the runs of this line.
            const side = coalesceInline(row.oldLine !== undefined ? inline.old : inline.next)
            const nodes: ReactNode[] = []
            let state = blockEntry
            for (const seg of side) {
              const scan = scanLine(seg.text, lang, state)
              state = scan.inBlock
              nodes.push(...tokensToNodes(scan.tokens, seg.changed))
            }
            return nodes
          })()}
          {row.kind !== 'mod' && tokensToNodes(scanLine(row.text, lang, blockEntry).tokens)}
        </span>
      </div>
    )
  }

  let renderedRows = 0
  const renderSegment = (segment: DiffSegment, segIndex: number): ReactNode => {
    if (segment.kind === 'hunk') {
      const capped = !expandedAll && renderedRows + segment.rows.length > MAX_ROWS
      const rows = capped ? segment.rows.slice(0, Math.max(MAX_ROWS - renderedRows, 0)) : segment.rows
      renderedRows += rows.length
      return (
        <div key={`hunk-${String(segIndex)}`}>
          {rows.map((row, index) => renderDiffRow(row, `${segIndex}-${String(index)}`))}
        </div>
      )
    }
    const expandable = segment.rows !== undefined && segment.count >= MIN_FOLD
    if (!expandable) {
      // A tiny fold (or a git gap with no rows to reveal): a quiet marker.
      return (
        <div key={`fold-${String(segIndex)}`} className={css.foldRow}>
          <span className={css.foldMarker} title={t('changesContext')}>
            {t('changesFold', { count: segment.count })}
          </span>
        </div>
      )
    }
    const isExpanded = expandedFolds.has(segIndex)
    return (
      <div
        key={`fold-${String(segIndex)}`}
        className={css.foldRow}
        data-expandable="true"
        data-expanded={isExpanded ? 'true' : undefined}
        onClick={() => {
          setExpandedFolds(prev => {
            const next = new Set(prev)
            if (next.has(segIndex)) next.delete(segIndex)
            else next.add(segIndex)
            return next
          })
        }}
      >
        {isExpanded
          ? segment.rows!.map((row, index) => renderDiffRow(row, `${segIndex}-${String(index)}`))
          : (
            <span className={css.foldMarker} title={t('changesContext')}>
              {t('changesFold', { count: segment.count })}
            </span>
          )}
      </div>
    )
  }

  const parts = segments.map(renderSegment)
  return (
    <div className={css.rows}>
      {parts}
      {renderedRows >= MAX_ROWS && !expandedAll && (
        <button type="button" className={css.expand} onClick={() => { setExpandedAll(true) }}>
          {t('diffExpand', { count: segments.reduce((sum, s) => sum + (s.kind === 'hunk' ? s.rows.length : 0), 0) - renderedRows })}
        </button>
      )}
    </div>
  )
}

export interface ReadRowsProps {
  /** The file lines with their real line numbers (parseReadLines output). */
  lines: ReadonlyArray<{ line: number; text: string }>
  /** Syntax language id (langOfPath); undefined renders plain text. */
  lang?: string
}

/** The read view: a line-numbered, syntax-colored slice of a read file. */
export function ReadRows({ lines, lang }: ReadRowsProps) {
  const rows = useMemo(() => {
    let state = false
    return lines.map((line) => {
      const scan = scanLine(line.text, lang, state)
      state = scan.inBlock
      return { line: line.line, nodes: tokensToNodes(scan.tokens) }
    })
  }, [lines, lang])
  return (
    <div className={css.rows}>
      {rows.map((row) => (
        <div key={String(row.line)} className={css.row} data-kind="read">
          <span className={css.lineNo}>{String(row.line)}</span>
          <span className={css.text}>{row.nodes}</span>
        </div>
      ))}
    </div>
  )
}
