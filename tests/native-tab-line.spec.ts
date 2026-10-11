/**
 * The landing line a file reference carries (`a/b.c#L131`, `a/b.c:131`).
 *
 * `fileParamsOf` already split the `path:line` form off the address (#826
 * first half, `src/client/path-line.ts`); what is left — the second half — is
 * that nothing CONSUMED the line it parsed. `NativeTabParams.line` was
 * declared, the host's own `#L131` fragment already arrives as
 * `navigation.params.line`, and the record simply dropped both on the floor,
 * so `[path](path:131)` opened the file and left the reader on line 1.
 *
 * These assertions are on the RECORD's event surface, not on the editor's
 * pixels: the record is what carries the line from the address to the viewer,
 * and it is where a stale line would survive (the host keeps a visited tab
 * body mounted and re-delivers its navigation, so "just put it in the record"
 * is only half of it — the record must also let it go again).
 */
import { describe, expect, it } from 'vitest'
import { createNativeTabRecords } from '../src/client/native/tab-adapter.tsx'

describe('the landing line on a native tab record (#826)', () => {
  const records = createNativeTabRecords()
  const scope = { sessionId: 's1', cwd: '/work' }

  const ensure = (params: { path?: string; title?: string; line?: number } | undefined, revision?: number) =>
    records.ensure({
      sessionId: 'seat-1',
      id: 'tab-1',
      kind: 'editor',
      title: 'CMakeLists.txt',
      params,
      scope,
      revision,
    }).tab

  it('seeds the line a `path:line` address named', () => {
    const tab = ensure({ path: 'omlx/CMakeLists.txt', title: 'CMakeLists.txt', line: 131 })
    expect(tab.path).toBe('omlx/CMakeLists.txt')
    expect(tab.line).toBe(131)
  })

  it('carries the host’s own `#L131` fragment the same way', () => {
    // The host parses `path#L131` and hands it down as a navigation param;
    // both spellings must land on the same row, so both take this one field.
    expect(ensure({ path: 'omlx/CMakeLists.txt', line: 131 }).line).toBe(131)
  })

  it('seeds no line on an ordinary open', () => {
    expect(ensure({ path: 'src/main.ts' }).line).toBeUndefined()
  })

  it('re-seeds the line when a new navigation moves it', () => {
    records.ensure({
      sessionId: 'seat-1', id: 'tab-2', kind: 'editor', title: 'a.ts',
      params: { path: 'a.ts', line: 10 }, scope, revision: 1,
    })
    const moved = records.ensure({
      sessionId: 'seat-1', id: 'tab-2', kind: 'editor', title: 'a.ts',
      params: { path: 'a.ts', line: 90 }, scope, revision: 2,
    })
    expect(moved.tab.line).toBe(90)
  })

  it('CLEARS the line when the same tab is navigated to a bare path', () => {
    // An in-place switch from `a.ts:131` to `a.ts` must not leave 131 behind:
    // the reader asked for the file, not for that line of it.
    records.ensure({
      sessionId: 'seat-1', id: 'tab-3', kind: 'editor', title: 'a.ts',
      params: { path: 'a.ts', line: 131 }, scope, revision: 1,
    })
    const bare = records.ensure({
      sessionId: 'seat-1', id: 'tab-3', kind: 'editor', title: 'a.ts',
      params: { path: 'a.ts' }, scope, revision: 2,
    })
    expect(bare.tab.line).toBeUndefined()
  })

  it('keeps the record identity when the navigation repeats unchanged', () => {
    // The host re-delivers the last navigation on every store notification;
    // an unchanged line must not mint a new record (a new object identity is
    // what re-renders every kept-mounted body).
    const first = ensure({ path: 'a.ts', line: 5 }, 1)
    const again = ensure({ path: 'a.ts', line: 5 }, 1)
    expect(again).toBe(first)
  })
})