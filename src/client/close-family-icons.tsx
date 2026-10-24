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
 * and a DOUBLE × is "the whole set". A bin was the obvious candidate for the
 * last one and was rejected: closing tabs deletes nothing, and a trash can
 * says it does. Glyphs are the host's own artwork where one exists (14px, on
 * the menu's 12px text line); "all" is drawn here because no host glyph encodes
 * "several of a thing" without also implying deletion.
 */
import type { ReactNode } from 'react'
import {
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCloseCircleFillRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Leading glyph for "close other tabs". */
export const closeOthersIcon: ReactNode = <IconCloseCircleFillRegular size={14} />
/** Leading glyph for "close tabs to the left". */
export const closeLeftIcon: ReactNode = <IconChevronLeftOutlineRegular size={14} />
/** Leading glyph for "close tabs to the right". */
export const closeRightIcon: ReactNode = <IconChevronRightOutlineRegular size={14} />
/**
 * Leading glyph for "close all tabs": two × marks, i.e. the host's own close
 * mark doubled. Drawn rather than imported because the host's nearest bulk
 * glyph is a bin, which promises deletion.
 */
export const closeAllIcon: ReactNode = (
  <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path
      d="M2.9 5.4 6.3 8.8M6.3 5.4 2.9 8.8M7.7 5.4 11.1 8.8M11.1 5.4 7.7 8.8"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
    />
  </svg>
)
