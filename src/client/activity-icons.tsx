/**
 * The glyph of one MERGED ACTIVITY line on the Tasks page — the icon the tree
 * mode's live row draws beside the host's own wording ("正在读取文件",
 * "正在运行命令 · npm run build", …).
 *
 * The key is the host's `ProcessActivity` category (the same union
 * `process-activity.ts` reproduces from the chat bundle), not a tool name: the
 * row shows a MERGED summary of the newest range, which is a category, and the
 * previous fixed terminal glyph made every row claim to be running a shell
 * command. The `Record` type keeps the map TOTAL — a category added upstream
 * fails the build here instead of silently falling back.
 *
 * All icons are the host's own components (currentColor — zero color literals,
 * the theme contract stays intact).
 */
import type { ReactNode } from 'react'
import {
  IconCodeOutlineRegular,
  IconEditOutlineRegular,
  IconEllipsisOutlineRegular,
  IconGlobeOutlineRegular,
  IconPlanOutlineRegular,
  IconPlayOutlineRegular,
  IconQuestionOutlineRegular,
  IconSearchOutlineRegular,
  IconThinkOutlineRegular,
  IconUsersOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProcessActivity } from '../process-activity.ts'

/** One glyph renderer (host icon components accept a pixel size). */
type Glyph = (size: number) => ReactNode

/** The explicit category map, one family per kind of work. */
const ACTIVITY_GLYPHS: Record<ProcessActivity, Glyph> = {
  read: size => <IconCodeOutlineRegular size={size} />,
  readImage: size => <IconCodeOutlineRegular size={size} />,
  search: size => <IconSearchOutlineRegular size={size} />,
  write: size => <IconEditOutlineRegular size={size} />,
  edit: size => <IconEditOutlineRegular size={size} />,
  commands: size => <IconPlayOutlineRegular size={size} />,
  code: size => <IconPlayOutlineRegular size={size} />,
  webSearch: size => <IconGlobeOutlineRegular size={size} />,
  webFetch: size => <IconGlobeOutlineRegular size={size} />,
  subagents: size => <IconUsersOutlineRegular size={size} />,
  plan: size => <IconPlanOutlineRegular size={size} />,
  questions: size => <IconQuestionOutlineRegular size={size} />,
  tools: size => <IconEllipsisOutlineRegular size={size} />,
}

/**
 * The glyph of one activity line.
 *
 * @param kind - the newest range's running category, or undefined while
 *   nothing is dispatched (the host's "thinking" wording, which is what the
 *   live line prints in that case).
 */
export function activityGlyph(kind: ProcessActivity | undefined): Glyph {
  if (kind === undefined) return size => <IconThinkOutlineRegular size={size} />
  return ACTIVITY_GLYPHS[kind]
}
