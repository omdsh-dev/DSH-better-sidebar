/**
 * The leading glyphs of the four "close family" actions.
 *
 * They exist because the rows share one verb: "Close other tabs", "Close tabs
 * to the left", "Close tabs to the right" and "Close all tabs" all start with
 * the same word, so a reader has to reach the middle of each row to tell them
 * apart. A distinct silhouette per row settles it at a glance, in every
 * locale, without leaning on word order (which differs by language).
 *
 * The metaphor is the SCOPE, not the verb: the × is the host's own "close this
 * one", a circled × is "the rest", chevrons point at the side being closed,
 * and the bin is the bulk sweep. Every glyph is the host's own artwork, drawn
 * at 14px to sit on the menu's 12px text line.
 */
import type { ReactNode } from 'react'
import {
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCloseCircleFillRegular,
  IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Leading glyph for "close other tabs". */
export const closeOthersIcon: ReactNode = <IconCloseCircleFillRegular size={14} />
/** Leading glyph for "close tabs to the left". */
export const closeLeftIcon: ReactNode = <IconChevronLeftOutlineRegular size={14} />
/** Leading glyph for "close tabs to the right". */
export const closeRightIcon: ReactNode = <IconChevronRightOutlineRegular size={14} />
/** Leading glyph for "close all tabs". */
export const closeAllIcon: ReactNode = <IconTrashOutlineRegular size={14} />
