/**
 * Display copy for the host primitives the sidebar renders OUTSIDE the main
 * conversation: `TerminalBlock` (a captured command's output surface) is
 * cordis-free and takes every label as a prop, so the owning render site must
 * supply them.
 *
 * One builder, two consumers (the Side Chat tool card and the Tasks page's
 * background-job output panel): the two surfaces must read identically, and a
 * new required label on the host side has exactly one place to land.
 */
import { t } from './locales.ts'

/** Labels for the sidebar's markdown / diff / read Block chrome. */
export interface BlockLabels {
  copy: string
  copied: string
  collapse: string
  collapseAria: string
  expand: (hidden: number) => string
  expandAria: (hidden: number) => string
}

/**
 * The sidebar's Blocks reuse the Side Chat dictionary's chrome family (copy
 * pair + the collapse/expand family that is common to every Block kind).
 */
export function blockLabels(): BlockLabels {
  return {
    copy: t('copy'),
    copied: t('copied'),
    collapse: t('sideChatBlockCollapse'),
    collapseAria: t('sideChatBlockCollapseAria'),
    expand: (hidden: number) => t('sideChatBlockExpand', { hidden }),
    expandAria: (hidden: number) => t('sideChatBlockExpandAria', { hidden }),
  }
}

/** The `TerminalBlockLabels` shape (structural mirror; the host owns the type). */
export interface TerminalLabels {
  signal: (signal: string) => string
  exitCode: (exitCode: number) => string
  noExitCode: string
  running: string
  failed: string
  done: string
  copy: string
  copied: string
  noOutput: string
  collapseAria: string
  collapse: string
  expandAria: (hidden: number) => string
  expand: (hidden: number) => string
}

/** Labels for one `TerminalBlock` (a captured command plus its output). */
export function terminalBlockLabels(): TerminalLabels {
  return {
    ...blockLabels(),
    signal: (signal: string) => t('sideChatBlockSignal', { signal }),
    exitCode: (exitCode: number) => t('sideChatBlockExitCode', { code: exitCode }),
    // DSH 0.1.6-alpha.2 added this pill text: a settle the view cannot
    // name (killed by an unknown signal, or never started).
    noExitCode: t('sideChatBlockNoExitCode'),
    running: t('sideChatBlockRunning'),
    failed: t('sideChatBlockFailed'),
    done: t('sideChatBlockDone'),
    noOutput: t('sideChatBlockNoOutput'),
  }
}
