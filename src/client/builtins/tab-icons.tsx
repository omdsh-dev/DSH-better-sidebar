/**
 * The built-in tab glyphs, in color.
 *
 * Every built-in tab type and the incoming 8th (changes) declare their icon
 * here, so the three surfaces that draw a tab's glyph — the bottom workbench's
 * tab strip, the native right Sidebar's guide capsules and its tab chips — all
 * read the same colorful glyph from `descriptor.icon`.
 *
 * Each glyph draws in `currentColor`; its wrapper supplies a skin-owned
 * token. File preview and Clues use distinct outline silhouettes so their
 * meaning remains clear at dense tab-strip sizes. Collection rows retain
 * their separate layered artwork. `tests/theme.spec.ts` guards the palette.
 */
import type { ReactNode } from 'react'
import styles from './tab-icons.module.css'
import {
  VscCommentDiscussion,
  VscGitCommit,
  VscLayers,
  VscTerminal,
} from 'react-icons/vsc'
/** The styled wrapper classes; typed so a renamed rule fails the build. */
const css = styles as Record<'files' | 'clues' | 'changes' | 'tasks' | 'sidechat' | 'terminal', string>

/** One tab type's glyph, sized by the caller's surface (14px in a strip). */
export type TabIcon = (size: number) => ReactNode

/** Surround a glyph with the class that hands it its token-driven color. */
function themed(className: string, glyph: ReactNode): ReactNode {
  return <span className={className}>{glyph}</span>
}

/** File preview: a folded document with a clear reading aperture. */
export const filesTabIcon: TabIcon = (size) => themed(css.files,
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
    <path d="M4 2h7l4 4v4M15 16v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M11 2v4h4M6 6h2M6 9h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8 13.5s2-3 5-3 5 3 5 3-2 3-5 3-5-3-5-3Z" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="13" cy="13.5" r="1.4" fill="currentColor" />
  </svg>,
)

/** Changes / diff: the commit glyph, green like the diff affordances. */
export const changesTabIcon: TabIcon = (size) =>
  themed(css.changes, <VscGitCommit size={size} />)

/**
 * Tasks (subagents and background jobs) — the live-activity amber. The glyph
 * is layered sheets, not a checklist: this page lists RUNNING work (subagent
 * sessions plus the host's background jobs), not a to-do list.
 */
export const tasksTabIcon: TabIcon = (size) =>
  themed(css.tasks, <VscLayers size={size} />)

/** Side chat — the conversational/secondary accent. */
export const sidechatTabIcon: TabIcon = (size) =>
  themed(css.sidechat, <VscCommentDiscussion size={size} />)

/**
 * Terminal — primary ink, the shell is text. Rendered one step down from the
 * strip's 14px: the VSCodicon terminal is a wide filled rectangle and read
 * heavier than its neighbours at full size.
 */
export const terminalTabIcon: TabIcon = (size) =>
  themed(css.terminal, <VscTerminal size={Math.max(10, Math.round(size * 0.85))} />)

/** Clues: collected cards with a bookmark, distinct from the file viewer. */
export const cluesTabIcon: TabIcon = (size) => themed(css.clues,
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
    <path d="M3 13H2.5A1.5 1.5 0 0 1 1 11.5v-8A1.5 1.5 0 0 1 2.5 2h10A1.5 1.5 0 0 1 14 3.5V4" stroke="currentColor" strokeWidth="1.5" />
    <rect x="5" y="6" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M12 6v6l2-1.5 2 1.5V6M8 14h3M8 16h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>,
)
