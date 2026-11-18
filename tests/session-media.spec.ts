/**
 * Session media catalogue contract: the fold that turns a conversation's
 * durable event log into the media the viewer lists.
 *
 * The log is shared with the host, so every case here is a SHAPE the host
 * really writes (see DSH's `dsh-session` / `dsh-tool-fs` sources):
 *  - a user message's `{ type: 'image', attachment }` block,
 *  - a tool result's identical block (a `read_image` return),
 *  - the PTC / subagent replay of those blocks as `agent/inbox/spliced`,
 *  - a `deliverables/presented` file list (a workspace path, NOT an attachment).
 *
 * The two behaviours worth pinning are the ones a naive implementation gets
 * wrong: identity is the CONTENT ADDRESS (so a replayed block must not become a
 * second row), and a delivered file is identified by its PATH (two turns can
 * hand over the same picture).
 */
import { describe, expect, it } from 'vitest'
import {
  deliveredExtOf, foldSessionMedia, isAttachmentItem, isMediaCandidate, leafOf, mediaKindOf, mediaLabelOf,
  SessionMediaIndex, type SessionMediaItem,
} from '../src/session-media.ts'
import type { SidebarSessionEvent } from '../src/context-types.ts'

/** One image attachment reference, as the log carries it. */
function ref(id: string, name = 'shot.png', mediaType = 'image/png') {
  return { attachmentId: id, mediaType, bytes: 12, width: 4, height: 3, ...(name === '' ? {} : { name }) }
}

/** One `{ type: 'image' }` block. */
function imageBlock(id: string, name?: string) {
  return { type: 'image', attachment: ref(id, name) }
}

/** One log event. */
function event(seq: number, type: string, data: Record<string, unknown>): SidebarSessionEvent {
  return { type, seq, time: 1_000 + seq, data }
}

describe('mediaKindOf', () => {
  it('trusts an image block\'s media type over its name', () => {
    expect(mediaKindOf('image/png', 'notes.txt')).toBe('image')
    expect(mediaKindOf('image/webp', '')).toBe('image')
  })

  it('classifies a delivered file by its extension', () => {
    expect(mediaKindOf(undefined, 'C:\\out\\clip.mp4')).toBe('video')
    expect(mediaKindOf(undefined, '/tmp/take.WEBM')).toBe('video')
    expect(mediaKindOf(undefined, '/tmp/voice.m4a')).toBe('audio')
    expect(mediaKindOf(undefined, '/tmp/report.PDF')).toBe('document')
    expect(mediaKindOf(undefined, 'C:\\x\\a.png')).toBe('image')
  })

  it('answers "other" for an extension it does not know', () => {
    expect(mediaKindOf(undefined, '/tmp/archive.tar.gz')).toBe('other')
    expect(mediaKindOf(undefined, '/tmp/noext')).toBe('other')
    // A `.ts` file is source code, not media: the viewer must not list the
    // whole workspace just because a file was delivered.
    expect(mediaKindOf(undefined, '/tmp/a.ts')).toBe('other')
    expect(isMediaCandidate('/tmp/a.ts')).toBe(false)
  })
})

describe('foldSessionMedia', () => {
  it('reads a user message\'s image block and records where it came from', () => {
    const items = foldSessionMedia([
      event(3, 'user/message', { content: [imageBlock('sha256:aa')], source: { kind: 'user' } }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'sha256:aa', kind: 'image', source: 'user', block: 'image', seq: 3 })
    expect(isAttachmentItem(items[0]!)).toBe(true)
  })

  it('reads a tool result\'s image block (a read_image return)', () => {
    const items = foldSessionMedia([
      event(9, 'tool/result', {
        turn: 2,
        message: { content: [{ type: 'text', text: 'ok' }, imageBlock('sha256:bb')] },
      }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'sha256:bb', source: 'tool', turn: 2 })
  })

  it('folds the inbox replay of the same blocks into the SAME row', () => {
    // The host records a tool's image twice: once as the tool result and once
    // as the PTC splice that fed it back to the model. One picture, one row.
    const items = foldSessionMedia([
      event(4, 'tool/result', { message: { content: [imageBlock('sha256:cc')] } }),
      event(5, 'agent/inbox/spliced', { inserted: [{ content: [imageBlock('sha256:cc')], source: { kind: 'ptc-mode' } }] }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'sha256:cc', seq: 4, source: 'tool' })
  })

  it('keeps the EARLIEST sighting as the introducing event', () => {
    // A replay can arrive before the event it replays (surface order is not
    // seq order); the row must still point at the lowest seq.
    const items = foldSessionMedia([
      event(8, 'agent/inbox/spliced', { inserted: [{ content: [imageBlock('sha256:dd')], source: { kind: 'user' } }] }),
      event(2, 'user/message', { content: [imageBlock('sha256:dd')], source: { kind: 'user' } }),
    ])
    expect(items[0]).toMatchObject({ id: 'sha256:dd', seq: 2 })
  })

  it('fills fields a later sighting knows and the first one lacked', () => {
    const bare = { type: 'image', attachment: { attachmentId: 'sha256:ee' } }
    const full = imageBlock('sha256:ee')
    const items = foldSessionMedia([
      event(1, 'user/message', { content: [bare], source: { kind: 'user' } }),
      event(2, 'tool/result', { message: { content: [full] } }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'sha256:ee', mediaType: 'image/png', bytes: 12, width: 4, height: 3, name: 'shot.png' })
  })

  it('lists a delivered workspace file by PATH, with its own source', () => {
    const items = foldSessionMedia([
      event(12, 'deliverables/presented', { turn: 3, callId: 'c1', files: [{ path: 'D:\\out\\clip.mp4', description: 'x' }] }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'D:\\out\\clip.mp4',
      kind: 'video',
      source: 'presented',
      path: 'D:\\out\\clip.mp4',
      name: 'clip.mp4',
      seq: 12,
    })
    expect(isAttachmentItem(items[0]!)).toBe(false)
  })

  it('skips a delivered file that is not media at all', () => {
    const items = foldSessionMedia([
      event(1, 'deliverables/presented', { files: [{ path: '/w/index.ts' }, { path: '/w/shot.png' }] }),
    ])
    expect(items.map(item => item.id)).toEqual(['/w/shot.png'])
  })

  it('keeps a delivered file that reappears later as ONE row', () => {
    const items = foldSessionMedia([
      event(1, 'deliverables/presented', { files: [{ path: '/w/a.png' }] }),
      event(30, 'deliverables/presented', { files: [{ path: '/w/a.png' }] }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]?.seq).toBe(1)
  })

  it('returns the catalogue newest-first', () => {
    const items = foldSessionMedia([
      event(1, 'user/message', { content: [imageBlock('sha256:01')], source: { kind: 'user' } }),
      event(7, 'user/message', { content: [imageBlock('sha256:02')], source: { kind: 'user' } }),
      event(4, 'user/message', { content: [imageBlock('sha256:03')], source: { kind: 'user' } }),
    ])
    expect(items.map(item => item.id)).toEqual(['sha256:02', 'sha256:03', 'sha256:01'])
  })

  it('ignores malformed input instead of throwing', () => {
    // The log is untrusted JSON: a broken block must cost that one row, not
    // the whole page.
    const items = foldSessionMedia([
      event(1, 'user/message', { content: [null, 'x', { type: 'image' }, { type: 'image', attachment: {} }] }),
      event(2, 'tool/result', {}),
      event(3, 'agent/inbox/spliced', { inserted: 'nope' }),
      event(4, 'deliverables/presented', { files: [null, { path: 12 }] }),
    ])
    expect(items).toEqual([])
  })

  it('reads an assistant message\'s image block too (an imported log can carry one)', () => {
    const items = foldSessionMedia([
      event(5, 'assistant/message', { message: { content: [imageBlock('sha256:ff')] } }),
    ])
    expect(items[0]).toMatchObject({ id: 'sha256:ff', source: 'tool' })
  })
})

describe('SessionMediaIndex', () => {
  it('merges rows by id and never loses the earliest seq', () => {
    const index = new SessionMediaIndex()
    const base: SessionMediaItem = { id: 'x', kind: 'image', source: 'user', seq: 5, time: 1 }
    index.add(base)
    index.add({ ...base, seq: 9, name: 'later.png' })
    index.add({ ...base, seq: 1, name: 'earlier.png' })
    const drained = index.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0]).toMatchObject({ id: 'x', seq: 1, name: 'earlier.png' })
  })
})

describe('labels', () => {
  it('prefers the display name, then the path leaf, then the id', () => {
    const base: SessionMediaItem = { id: 'sha256:aa', kind: 'image', source: 'user', seq: 1, time: 1 }
    expect(mediaLabelOf({ ...base, name: 'n.png' })).toBe('n.png')
    expect(mediaLabelOf({ ...base, path: 'C:\\a\\b\\c.mp4' })).toBe('c.mp4')
    expect(mediaLabelOf(base)).toBe('sha256:aa')
  })

  it('reads a leaf under either separator', () => {
    expect(leafOf('C:\\a\\b\\c.png')).toBe('c.png')
    expect(leafOf('/a/b/c.png')).toBe('c.png')
    expect(leafOf('c.png')).toBe('c.png')
  })

  it('names the extension a delivered row\'s thumbnail mirrors', () => {
    const base: SessionMediaItem = { id: 'p', kind: 'video', source: 'presented', seq: 1, time: 1, path: 'C:\\a\\clip.MP4' }
    expect(deliveredExtOf(base)).toBe('mp4')
    expect(deliveredExtOf({ ...base, path: 'C:\\a\\noext' })).toBe('bin')
  })
})
