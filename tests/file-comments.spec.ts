import { describe, expect, it, vi } from 'vitest'
import { FileCommentStore, formatFileCommentsPrompt, sharedFileCommentStore } from '../src/client/file-comments.ts'

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

function makeStore(storage = new MemoryStorage()): FileCommentStore {
  let now = 100
  let id = 0
  return new FileCommentStore(storage, () => ++now, () => `id-${++id}`)
}

describe('FileCommentStore', () => {
  it('shares one store when independently bundled module copies use the same page registry', () => {
    const registry: Record<symbol, unknown> = {}
    const first = makeStore()
    const createFirst = vi.fn(() => first)
    const createSecond = vi.fn(() => makeStore())

    const fromCoreBundle = sharedFileCommentStore(registry, createFirst)
    const fromEditorChunk = sharedFileCommentStore(registry, createSecond)

    expect(fromEditorChunk).toBe(fromCoreBundle)
    expect(createFirst).toHaveBeenCalledOnce()
    expect(createSecond).not.toHaveBeenCalled()

    const listener = vi.fn()
    fromCoreBundle.subscribe('s1', listener)
    fromEditorChunk.add('s1', { path: '/a.ts', selectedText: 'value', body: 'rename it' })
    expect(listener).toHaveBeenCalledOnce()
    expect(fromCoreBundle.getSnapshot('s1')).toHaveLength(1)
  })

  it('persists pending comments per session and notifies subscribers', () => {
    const storage = new MemoryStorage()
    const store = makeStore(storage)
    const listener = vi.fn()
    store.subscribe('s1', listener)

    store.add('s1', {
      path: '/work/a.ts',
      lines: { start: 2, end: 4 },
      selectedText: 'const answer = 42',
      body: '  extract this value  ',
    })

    expect(listener).toHaveBeenCalledOnce()
    expect(store.getSnapshot('s1')).toMatchObject([{
      id: 'id-1',
      path: '/work/a.ts',
      lines: { start: 2, end: 4 },
      body: 'extract this value',
    }])
    expect(makeStore(storage).getSnapshot('s1')).toHaveLength(1)
    expect(store.getSnapshot('other')).toEqual([])
  })

  it('allows editing and deleting only pending comments', () => {
    const store = makeStore()
    const first = store.add('s1', { path: '/a.ts', selectedText: 'a', body: 'first' })
    expect(store.update('s1', first.id, 'updated')).toBe(true)
    expect(store.getSnapshot('s1')[0]?.body).toBe('updated')

    store.markSent('s1', [first.id])
    expect(store.update('s1', first.id, 'too late')).toBe(false)
    expect(store.remove('s1', first.id)).toBe(false)

    const second = store.add('s1', { path: '/a.ts', selectedText: 'b', body: 'second' })
    expect(store.remove('s1', second.id)).toBe(true)
    expect(store.getSnapshot('s1')).toHaveLength(1)
  })

  it('deletes multiple pending comments atomically without touching history', () => {
    const store = makeStore()
    const first = store.add('s1', { path: '/a.ts', selectedText: 'a', body: 'first' })
    const sent = store.add('s1', { path: '/a.ts', selectedText: 'b', body: 'sent' })
    const last = store.add('s1', { path: '/a.ts', selectedText: 'c', body: 'last' })
    store.markSent('s1', [sent.id])
    const listener = vi.fn()
    store.subscribe('s1', listener)

    expect(store.removeMany('s1', [first.id, sent.id, 'missing'])).toBe(1)
    expect(listener).toHaveBeenCalledOnce()
    expect(store.getSnapshot('s1').map(comment => comment.id)).toEqual([last.id, sent.id])

    expect(store.removeMany('s1', [sent.id, 'missing'])).toBe(0)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('marks only the submitted id snapshot when comments arrive during a send', () => {
    const store = makeStore()
    const first = store.add('s1', { path: '/a.ts', selectedText: 'a', body: 'first' })
    const submittedIds = [first.id]
    const later = store.add('s1', { path: '/a.ts', selectedText: 'b', body: 'later' })

    store.markSent('s1', submittedIds, 500, 'batch-1')

    expect(store.getSnapshot('s1').find(row => row.id === first.id)).toMatchObject({ sentAt: 500, batchId: 'batch-1' })
    expect(store.getSnapshot('s1').find(row => row.id === later.id)?.sentAt).toBeUndefined()
  })

  it('does not notify when a sent snapshot no longer contains pending rows', () => {
    const store = makeStore()
    const listener = vi.fn()
    const row = store.add('s1', { path: '/a.ts', selectedText: 'a', body: 'first' })
    store.subscribe('s1', listener)

    store.markSent('s1', [row.id])
    expect(listener).toHaveBeenCalledOnce()

    store.markSent('s1', [row.id, 'missing'])
    expect(listener).toHaveBeenCalledOnce()
  })

  it('drops oversized selected text while retaining its location and comment', () => {
    const store = makeStore()
    const row = store.add('s1', {
      path: '/work/a.ts',
      lines: { start: 7, end: 9 },
      selectedText: 'x'.repeat(501),
      body: 'simplify this block',
    })

    expect(row).toMatchObject({ selectedText: '', selectionOmitted: true })
    expect(formatFileCommentsPrompt([row], '/work')).toContain('a.ts:7-9')
    expect(formatFileCommentsPrompt([row], '/work')).not.toContain('xxx')
  })
})

describe('formatFileCommentsPrompt', () => {
  it('serializes file locations, selected source, and comments in order', () => {
    const store = makeStore()
    const rows = [
      store.add('s1', { path: '/work/a.ts', lines: { start: 2, end: 2 }, selectedText: 'const a = 1', body: 'rename a' }),
      store.add('s1', { path: '/work/a.ts', lines: { start: 8, end: 10 }, selectedText: 'if (ready) {}', body: 'add the false branch' }),
    ]

    const prompt = formatFileCommentsPrompt(rows, '/work')
    expect(prompt).toContain('```a.ts:2\nconst a = 1\n```')
    expect(prompt).toContain('rename a')
    expect(prompt.indexOf('rename a')).toBeLessThan(prompt.indexOf('add the false branch'))
  })
})
