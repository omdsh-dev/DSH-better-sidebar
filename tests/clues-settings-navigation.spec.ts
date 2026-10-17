/**
 * S8 settings deep links: the Tab gear (S9) and any other in-product entry
 * point the user to the Clue sources group (and optionally one source's
 * configuration) through ONE module-level target, never a second settings
 * store. The mounted section subscribes, switches the group and (when a
 * source id is present) opens that source's config window.
 *
 * The target is consumed once by the settings surface, so a later plain open
 * of the settings dialog starts on the remembered/default group instead of
 * replaying a stale deep link from an earlier session.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  consumeClueSettingsTarget,
  openClueSettings,
  peekClueSettingsTarget,
  subscribeClueSettingsTarget,
} from '../src/client/clues/settings/navigation.ts'

afterEach(() => {
  // Drain any target a test left behind; the module holds one value by design.
  consumeClueSettingsTarget()
})

describe('clue settings navigation target', () => {
  it('notifies subscribers with the requested group and source', () => {
    const seen: unknown[] = []
    const dispose = subscribeClueSettingsTarget(target => { seen.push(target) })
    openClueSettings({ group: 'sources', sourceId: 'builtin.feishu.docs' })
    expect(seen).toEqual([{ group: 'sources', sourceId: 'builtin.feishu.docs' }])
    dispose()
    openClueSettings({ group: 'tabs' })
    expect(seen).toHaveLength(1)
  })

  it('is a one-shot target: consuming it clears the pending deep link', () => {
    openClueSettings({ group: 'sources' })
    expect(peekClueSettingsTarget()).toEqual({ group: 'sources' })
    expect(consumeClueSettingsTarget()).toEqual({ group: 'sources' })
    expect(peekClueSettingsTarget()).toBeUndefined()
    expect(consumeClueSettingsTarget()).toBeUndefined()
  })

  it('a later deep link replaces the pending one (last request wins)', () => {
    openClueSettings({ group: 'sources', sourceId: 'one' })
    openClueSettings({ group: 'sources', sourceId: 'two' })
    expect(consumeClueSettingsTarget()).toEqual({ group: 'sources', sourceId: 'two' })
  })

  it('a throwing subscriber never blocks the other subscribers or the target', () => {
    const seen: string[] = []
    const disposeBad = subscribeClueSettingsTarget(() => { throw new Error('boom') })
    const disposeGood = subscribeClueSettingsTarget(target => { seen.push(target.group) })
    expect(() => { openClueSettings({ group: 'appearance' }) }).not.toThrow()
    expect(seen).toEqual(['appearance'])
    expect(peekClueSettingsTarget()).toEqual({ group: 'appearance' })
    disposeBad()
    disposeGood()
  })
})
