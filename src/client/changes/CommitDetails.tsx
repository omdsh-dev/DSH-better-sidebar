/**
 * The bottom pane's `details` tab: the commit card the graph lens used to
 * render under its own list (title, author, date, full hash + copy, parents,
 * refs, message), lifted out of {@link GitGraphSection} so selecting a commit no
 * longer stacks a second pane below the shared diff preview — the two views are
 * now tabs of ONE pane (see `ChangesTab` / `DiffPane`).
 *
 * Frameless by design: the pane frame, the tab strip and the height belong to
 * the shared bottom region, so this fills whatever body it is given and scrolls
 * itself — there is no inner height cap and no nested scroller any more, and
 * the message is rendered through the same `MarkdownText` the rest of the
 * plugin uses instead of a `<pre>`.
 */
import {
  IconClockOutlineRegular, IconCopyOutlineRegular, IconUserOutlineRegular, MarkdownText, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { relativeTime, t } from '../locales.ts'
import { markdownTextProps } from '../markdown-labels.tsx'
import { IconButton } from '../ui/index.ts'
import { refPills, RefPill, type GraphEntry } from './GitGraphSection.tsx'
import css from './graph.module.css'

export interface CommitDetailsProps {
  /** The graph page's entry for the selected commit. */
  entry: GraphEntry
  /** The graph's remote ref names, so `origin/main`-style pills read muted;
   *  only the lens holds the branch inventory this set is derived from. */
  remotes?: ReadonlySet<string>
  /** The palette slot of the commit's lane, so the card's pills wear the same
   *  colour as the graph row the commit sits on. */
  slot?: number
}

/**
 * `git log %B` is the RAW body: its first line is the very subject the card
 * already shows as its title, so the markdown block renders only what follows
 * (the split GitHub's commit page makes). When the first line is not the
 * subject — a hand-written message whose `%s` was folded differently — the
 * whole body renders rather than silently dropping a line.
 */
export function messageBodyOf(entry: GraphEntry): string {
  const lines = entry.message.replace(/\r\n/g, '\n').split('\n')
  const head = (lines[0] ?? '').trim()
  const rest = head === entry.subject.trim() ? lines.slice(1) : lines
  return rest.join('\n').trim()
}

export function CommitDetails({ entry, remotes = new Set<string>(), slot }: CommitDetailsProps) {
  const body = messageBodyOf(entry)
  // The host renderer falls back to hardcoded Chinese when the nested chrome
  // labels are omitted, so the code-card labels ride the plugin dictionary.
  const labels = {
    copyLabel: t('copy'),
    copiedLabel: t('copied'),
    codeLabel: t('codeBlockTitle'),
    wrapLabel: t('codeBlockWrap'),
    unwrapLabel: t('codeBlockUnwrap'),
  }
  // No section band here: the pane's tab already says "commit details", so the
  // card opens with the commit's own title instead of repeating that label.
  // The section keeps the label for assistive tech only (aria-label, not text).
  return <section className={css.details} aria-label={t('graphDetails')}>
    <strong className={css.detailSubject}>{entry.subject}</strong>
    <div className={css.metaRow}>
      <span className={css.metaGlyph} aria-hidden="true"><IconUserOutlineRegular size={12} /></span>
      <span className={css.metaValue}>{entry.author}</span>
    </div>
    <div className={css.metaRow}>
      <span className={css.metaGlyph} aria-hidden="true"><IconClockOutlineRegular size={12} /></span>
      <span className={css.metaValue}>{relativeTime(entry.date)} · {entry.date}</span>
    </div>
    <div className={css.metaRow}>
      <code className={css.hashChip}>{entry.hashFull}</code>
      <IconButton size="sm" icon={<IconCopyOutlineRegular size={14} />} label={t('copyFullHash')}
        onClick={() => { void writeClipboard(entry.hashFull) }} />
    </div>
    <div className={css.metaRow}>
      <span className={css.metaLabel}>{t('graphParents')}</span>
      <span className={css.parents}>
        {entry.parents.length === 0
          ? <span className={css.dash}>—</span>
          : entry.parents.map(parent => <code key={parent} className={css.parentChip}
            title={parent}>{parent.slice(0, 7)}</code>)}      </span>
    </div>
    {entry.refs.length > 0 && <div className={css.detailRefs}>
      {refPills(entry.refs, remotes).map(pill => <RefPill key={pill.name} pill={pill} slot={slot} />)}
    </div>}
    {body !== '' && <div className={css.messageBody}>
      <MarkdownText {...markdownTextProps(body, labels)} />
    </div>}
  </section>
}