/**
 * The built-in tab glyphs, in color.
 *
 * Every built-in tab type and the incoming 8th (changes) declare their icon
 * here, so the three surfaces that draw a tab's glyph — the bottom workbench's
 * tab strip, the native right Sidebar's guide capsules and its tab chips — all
 * read the same colorful glyph from `descriptor.icon`.
 *
 * Each glyph draws in `currentColor`; its wrapper supplies a skin-owned
 * token. Files uses the host's folder artwork, matching Local files; Clues
 * uses a separate outline silhouette. Collection rows retain
 * their separate layered artwork. `tests/theme.spec.ts` guards the palette.
 */
import type { ReactNode } from 'react'
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives/client'
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

/** Match the Local files source and the host's folder artwork. */
export const filesTabIcon: TabIcon = size => themed(css.files, <FileTypeIcon kind="folder" size={size} />)

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
