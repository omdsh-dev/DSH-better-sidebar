/**
 * The built-in tab glyphs, in color.
 *
 * Every built-in tab type declares its icon here, so the three surfaces that
 * draw a tab's glyph — the bottom workbench's tab strip, the native right
 * Sidebar's guide capsules and its tab chips — all read the same colorful
 * glyph from `descriptor.icon`.
 *
 * The color always arrives from a theme token, never from the plugin: the
 * glyph is a VSCodicon drawn in `currentColor`, and the wrapper class supplies
 * that color. A skin therefore keeps control of everything (the guide's §12);
 * this module is what `tests/theme.spec.ts` checks for color literals.
 *
 * `files` is the one exception in kind rather than in color: it renders DSH's
 * own folder artwork (`FileTypeIcon`), matching the file rows this tab shows.
 */
import type { ReactNode } from 'react'
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './tab-icons.module.css'
import {
  VscCommentDiscussion,
  VscGitCommit,
  VscGlobe,
  VscLayers,
  VscNote,
  VscTerminal,
} from 'react-icons/vsc'
/** The styled wrapper classes; typed so a renamed rule fails the build. */
const css = styles as Record<'files' | 'changes' | 'plan' | 'tasks' | 'sidechat' | 'terminal' | 'browser', string>

/** One tab type's glyph, sized by the caller's surface (14px in a strip). */
export type TabIcon = (size: number) => ReactNode

/** Surround a glyph with the class that hands it its token-driven color. */
function themed(className: string, glyph: ReactNode): ReactNode {
  return <span className={className}>{glyph}</span>
}

/** The Files tab: the host's folder artwork, like the rows it opens. */
export const filesTabIcon: TabIcon = (size) => (
  <span className={css.files}>
    <FileTypeIcon kind="folder" size={size} />
  </span>
)

/** Changes / diff: the commit glyph, green like the diff affordances. */
export const changesTabIcon: TabIcon = (size) =>
  themed(css.changes, <VscGitCommit size={size} />)

/**
 * Plan — the document the model presented for review. The glyph is a written
 * note, not a checklist: the page shows one plan DOCUMENT per revision, and
 * the tasks glyph's own comment (below) already rules the to-do reading out.
 */
export const planTabIcon: TabIcon = (size) =>
  themed(css.plan, <VscNote size={size} />)

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

/** Browser — the same secondary accent as the side chat's sibling surfaces. */
export const browserTabIcon: TabIcon = (size) =>
  themed(css.browser, <VscGlobe size={size} />)
