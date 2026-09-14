/**
 * Tool-call glyphs for the live activity lines of the Tasks page (the
 * "icon + tool + args" row on running agent nodes). A small explicit map of
 * the common tool families onto host primitive icons; anything unmapped
 * gets the generic ellipsis glyph. All icons are the host's own components
 * (currentColor — zero color literals, the theme contract stays intact).
 */
import type { ReactNode } from 'react'
import {
  IconCodeOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconGlobeOutline14,
  IconPlayOutline16,
  IconSearchOutline16,
  IconThinkOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** One glyph renderer (host icon components accept a pixel size). */
type Glyph = (size: number) => ReactNode

/** The explicit tool-family map (longest-prefix wins at lookup). */
const TOOL_GLYPHS: ReadonlyArray<readonly [string, Glyph]> = [
  ['read', size => <IconCodeOutline16 size={size} />],
  ['write', size => <IconEditOutline16 size={size} />],
  ['edit', size => <IconEditOutline16 size={size} />],
  ['glob', size => <IconSearchOutline16 size={size} />],
  ['grep', size => <IconSearchOutline16 size={size} />],
  ['search', size => <IconSearchOutline16 size={size} />],
  ['bash', size => <IconPlayOutline16 size={size} />],
  ['shell', size => <IconPlayOutline16 size={size} />],
  ['web', size => <IconGlobeOutline14 size={size} />],
  ['fetch', size => <IconGlobeOutline14 size={size} />],
  ['think', size => <IconThinkOutline16 size={size} />],
]

/** The fallback glyph for unmapped tools. */
const FALLBACK_GLYPH: Glyph = size => <IconEllipsisOutline16 size={size} />

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
