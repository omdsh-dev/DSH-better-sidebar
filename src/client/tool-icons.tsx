/**
 * Tool-call glyphs for the live activity lines of the Tasks page (the
 * "icon + tool + args" row on running agent nodes). A small explicit map of
 * the common tool families onto host primitive icons; anything unmapped
 * gets the generic ellipsis glyph. All icons are the host's own components
 * (currentColor — zero color literals, the theme contract stays intact).
 */
import type { ReactNode } from 'react'
import {
  IconCodeOutlineRegular,
  IconEditOutlineRegular,
  IconEllipsisOutlineRegular,
  IconGlobeOutlineRegular,
  IconPlayOutlineRegular,
  IconSearchOutlineRegular,
  IconThinkOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** One glyph renderer (host icon components accept a pixel size). */
type Glyph = (size: number) => ReactNode

/** The explicit tool-family map (longest-prefix wins at lookup). */
const TOOL_GLYPHS: ReadonlyArray<readonly [string, Glyph]> = [
  ['read', size => <IconCodeOutlineRegular size={size} />],
  ['write', size => <IconEditOutlineRegular size={size} />],
  ['edit', size => <IconEditOutlineRegular size={size} />],
  ['glob', size => <IconSearchOutlineRegular size={size} />],
  ['grep', size => <IconSearchOutlineRegular size={size} />],
  ['search', size => <IconSearchOutlineRegular size={size} />],
  ['bash', size => <IconPlayOutlineRegular size={size} />],
  ['shell', size => <IconPlayOutlineRegular size={size} />],
  ['web', size => <IconGlobeOutlineRegular size={size} />],
  ['fetch', size => <IconGlobeOutlineRegular size={size} />],
  ['think', size => <IconThinkOutlineRegular size={size} />],
]

/** The fallback glyph for unmapped tools. */
const FALLBACK_GLYPH: Glyph = size => <IconEllipsisOutlineRegular size={size} />

/**
 * The glyph of one tool name: exact match first, then a prefix match so
 * `mcp__fs__read_file`-style names still land on their family glyph. The
 * lookup is case-insensitive.
 */
export function toolGlyph(toolName: string): Glyph {
  const name = toolName.toLowerCase()
  for (const [key, glyph] of TOOL_GLYPHS) {
    if (name === key) return glyph
  }
  for (const [key, glyph] of TOOL_GLYPHS) {
    if (name.includes(key)) return glyph
  }
  return FALLBACK_GLYPH
}
