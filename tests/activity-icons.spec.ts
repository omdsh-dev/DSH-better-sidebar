/**
 * Unit tests for the merged-activity glyph map (the tree mode's live row).
 *
 * The row used to draw ONE fixed terminal glyph whatever the wording said, so
 * "正在读取文件" was prefixed by the icon for running a shell command. The map is
 * total by type, and these cases pin the two facts a type cannot: every kind
 * renders something, and the kinds the reader sees side by side do NOT share a
 * glyph.
 */
import { describe, expect, it } from 'vitest'
import { activityGlyph } from '../src/client/activity-icons.tsx'
import type { ProcessActivity } from '../src/process-activity.ts'

/** The host's category union, spelled out (see src/process-activity.ts). */
const KINDS: readonly ProcessActivity[] = [
  'read', 'readImage', 'search', 'write', 'edit', 'commands', 'code',
  'webSearch', 'webFetch', 'subagents', 'plan', 'questions', 'tools',
]

/** The rendered icon's element type — what the reader actually sees. */
function glyphType(kind: ProcessActivity | undefined): unknown {
  const element = activityGlyph(kind)(9) as { type?: unknown } | null
  expect(element).toBeTruthy()
  return element?.type
}

describe('activityGlyph', () => {
  it('renders a glyph for every category', () => {
    for (const kind of KINDS) {
      expect(glyphType(kind)).toBeTypeOf('function')
    }
  })

  it('gives the reading and the command categories DIFFERENT glyphs', () => {
    // The reader's report: every live row wore the terminal icon. These two
    // sit next to each other in a real session, so sharing one would bring the
    // bug straight back.
    expect(glyphType('read')).not.toBe(glyphType('commands'))
    expect(glyphType('search')).not.toBe(glyphType('read'))
    expect(glyphType('webSearch')).not.toBe(glyphType('commands'))
  })

  it('draws a category glyph for the running family and the think glyph when nothing is dispatched', () => {
    // `undefined` is the "nothing running yet" case (the host's thinking
    // wording), which must not read as any concrete kind of work.
    const thinking = glyphType(undefined)
    expect(thinking).toBeTypeOf('function')
    for (const kind of KINDS) {
      expect(glyphType(kind)).not.toBe(thinking)
    }
  })
})
