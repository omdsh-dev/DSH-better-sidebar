/**
 * The native tab adapter's seeded-id contract (v0.19.2): a plugin-side id
 * carried in navigation params (`params.id`, e.g. an agent terminal's
 * `agent:<uuid>`) becomes the synthetic record's `tab.id`, is resolvable
 * back to the native key (`nativeIdOf`), is enumerable (`entries`), and the
 * native surface (createNativeSurface) resolves that synthetic id for
 * `has` / `close` — the plumbing that lets service.syncAgentTerminals open
 * and close agent terminals on DSH's native right Sidebar by the id the
 * rest of the plugin already speaks.
 */
import { describe, expect, it } from 'vitest'
import { createNativeTabRecords } from '../src/client/native/tab-adapter.tsx'

describe('native records seeded ids (params.id)', () => {
  it('mints the synthetic tab.id from params.id, falling back to the native id', () => {
    const records = createNativeTabRecords()
    const seeded = records.ensure({
      id: 'native-1',
      kind: 'terminal',
      title: 'Shell',
      params: { id: 'agent:u-1', title: 'dev server' },
      scope: { sessionId: 's1' },
      mint: undefined,
    })
    expect(seeded.tab.id).toBe('agent:u-1')
    expect(seeded.tab.title).toBe('dev server')
    const plain = records.ensure({
      id: 'native-2',
      kind: 'terminal',
      title: 'Shell 2',
      params: undefined,
      scope: { sessionId: 's1' },
      mint: undefined,
    })
    expect(plain.tab.id).toBe('native-2')
  })

  it('resolves a seeded id back to its native key and enumerates it', () => {
    const records = createNativeTabRecords()
    records.ensure({
      id: 'native-1',
      kind: 'terminal',
      title: 'Shell',
      params: { id: 'agent:u-1', title: 'dev server' },
      scope: { sessionId: 's1' },
      mint: undefined,
    })
    expect(records.nativeIdOf('agent:u-1')).toBe('native-1')
    // A native key resolves to itself (the host-close passthrough).
    expect(records.nativeIdOf('native-1')).toBe('native-1')
    // Unknown ids resolve to undefined (close/has stay safe no-ops).
    expect(records.nativeIdOf('agent:nope')).toBeUndefined()
    expect(records.entries()).toEqual([{ nativeId: 'native-1', tabId: 'agent:u-1' }])
    records.drop('native-1')
    expect(records.nativeIdOf('agent:u-1')).toBeUndefined()
    expect(records.entries()).toEqual([])
  })

  it('keeps the seeded id across a navigation refresh (identity is stable)', () => {
    const records = createNativeTabRecords()
    const first = records.ensure({
      id: 'native-1',
      kind: 'terminal',
      title: 'Shell',
      params: { id: 'agent:u-1', title: 'dev server' },
      scope: { sessionId: 's1' },
      mint: undefined,
    })
    const again = records.ensure({
      id: 'native-1',
      kind: 'terminal',
      title: 'Shell',
      // A later navigation that (oddly) drops the id must NOT re-key the
      // record: the first mint owns the identity.
      params: { title: 'renamed' },
      scope: { sessionId: 's1' },
      mint: undefined,
    })
    expect(again).toBe(first)
    expect(records.nativeIdOf('agent:u-1')).toBe('native-1')
  })
})
