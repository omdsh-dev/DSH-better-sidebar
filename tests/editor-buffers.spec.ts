// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deleteEditorBuffersUnder,
  getEditorBuffer,
  listEditorBuffersUnder,
  moveEditorBuffers,
  pathAtOrUnder,
  resetEditorBuffersForTests,
  saveEditorBuffer,
} from '../src/client/editor-buffers.ts'

afterEach(async () => { await resetEditorBuffersForTests() })

describe('durable editor buffers', () => {
  it('stores and restores dirty text with its disk base version and mode', async () => {
    await saveEditorBuffer({
      sessionId: 's1', path: '/work/note.md', text: '# draft', baseVersion: 'v1', mode: 'visual',
    })
    await expect(getEditorBuffer('s1', '/work/note.md')).resolves.toMatchObject({
      text: '# draft', baseVersion: 'v1', mode: 'visual',
    })
    await expect(getEditorBuffer('s2', '/work/note.md')).resolves.toBeUndefined()
  })

  it('remaps descendant buffers on folder move and removes them on delete', async () => {
    await Promise.all([
      saveEditorBuffer({ sessionId: 's', path: '/work/docs/a.md', text: 'a', baseVersion: '1', mode: 'edit' }),
      saveEditorBuffer({ sessionId: 's', path: '/work/docs/sub/b.md', text: 'b', baseVersion: '2', mode: 'preview' }),
      saveEditorBuffer({ sessionId: 's', path: '/work/other.md', text: 'c', baseVersion: '3', mode: 'edit' }),
    ])
    await moveEditorBuffers('s', '/work/docs', '/work/archive')
    expect((await listEditorBuffersUnder('s', '/work/archive')).map(row => row.path).sort()).toEqual([
      '/work/archive/a.md', '/work/archive/sub/b.md',
    ])
    expect(await getEditorBuffer('s', '/work/docs/a.md')).toBeUndefined()
    await deleteEditorBuffersUnder('s', '/work/archive')
    // A late component-unmount cleanup cannot resurrect a deleted draft.
    await saveEditorBuffer({ sessionId: 's', path: '/work/archive/a.md', text: 'late', baseVersion: '1', mode: 'edit' })
    expect(await listEditorBuffersUnder('s', '/work/archive')).toEqual([])
    expect(await getEditorBuffer('s', '/work/other.md')).toBeDefined()
  })

  it('uses path-boundary and Windows case-insensitive matching', () => {
    expect(pathAtOrUnder('/work/doc', '/work/docs/a.md')).toBe(false)
    expect(pathAtOrUnder('/work/docs', '/work/docs/a.md')).toBe(true)
    expect(pathAtOrUnder('C:\\Work\\Docs', 'c:/work/docs/A.md')).toBe(true)
  })
})
