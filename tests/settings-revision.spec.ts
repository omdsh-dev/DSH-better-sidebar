import { describe, expect, it, vi } from 'vitest'
import {
  getSettingsRevision,
  queueSettingsUpdate,
  setSettingsRevision,
  subscribeSettingsRevision,
} from '../src/client/settings-revision.ts'

describe('shared settings revision tracker', () => {
  it('stores and reads the latest revision', () => {
    setSettingsRevision(7)
    expect(getSettingsRevision()).toBe(7)
  })

  it('lets the next queued write read the revision produced by the previous one', async () => {
    let revisionSeenBySecondWrite: number | undefined
    queueSettingsUpdate(async () => {
      setSettingsRevision(2)
      return 'first'
    })
    const second = queueSettingsUpdate(async () => {
      revisionSeenBySecondWrite = getSettingsRevision()
      return 'second'
    })
    await second
    expect(revisionSeenBySecondWrite).toBe(2)
  })

  it('serializes queued settings writes and continues after a failure', async () => {
    const order: string[] = []
    const first = queueSettingsUpdate(async () => {
      order.push('first')
      throw new Error('write failed')
    })
    const second = queueSettingsUpdate(async () => {
      order.push('second')
      return 'ok'
    })

    await expect(first).rejects.toThrow('write failed')
    await expect(second).resolves.toBe('ok')
    expect(order).toEqual(['first', 'second'])
  })

  it('notifies subscribers only when the revision changes', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeSettingsRevision(listener)

    setSettingsRevision(1)
    expect(listener).toHaveBeenCalledTimes(1)

    // Same value is a no-op.
    setSettingsRevision(1)
    expect(listener).toHaveBeenCalledTimes(1)

    setSettingsRevision(2)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(getSettingsRevision()).toBe(2)

    unsubscribe()
    setSettingsRevision(3)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
