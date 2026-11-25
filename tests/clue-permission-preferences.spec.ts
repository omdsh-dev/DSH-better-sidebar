import { describe, expect, it, vi } from 'vitest'
import { createCluePermissionPreferences } from '../src/client/clues/settings/permission-preferences.ts'

function fakeSettings(initial: Record<string, unknown>) {
  let value: Record<string, unknown> = structuredClone(initial)
  let revision = 4
  const settingsGet = vi.fn(async () => ({ value, revision }))
  const settingsUpdate = vi.fn(async (patch: Record<string, unknown>, expectedRevision?: number) => {
    if (expectedRevision !== revision) {
      const error = Object.assign(new Error('settings changed'), { code: 'settings-conflict' })
      revision += 1
      throw error
    }
    const currentPlugins = value.pluginSettings as Record<string, unknown>
    const patchPlugins = patch.pluginSettings as Record<string, unknown>
    const currentClues = currentPlugins.clues as Record<string, unknown>
    const patchClues = patchPlugins.clues as Record<string, unknown>
    const currentRequests = currentClues.requestedCapabilities as Record<string, unknown>
    const patchRequests = patchClues.requestedCapabilities as Record<string, unknown>
    value = {
      ...value,
      pluginSettings: {
        ...currentPlugins,
        clues: {
          ...currentClues,
          ...patchClues,
          requestedCapabilities: { ...currentRequests, ...patchRequests },
        },
      },
    }
    revision += 1
    return { value, revision }
  })
  return { settingsGet, settingsUpdate, get value() { return value }, set revision(value: number) { revision = value } }
}

describe('clue permission preferences', () => {
  it('saves and restores request selections without replacing sibling plugin settings', async () => {
    const settings = fakeSettings({
      pluginSettings: {
        clues: { requestedCapabilities: { 'feishu.docs': ['docs.read'] }, packs: { pinned: ['x'] } },
        other: { enabled: true },
      },
    })
    const preferences = createCluePermissionPreferences(settings)
    await preferences.save('feishu.docs', ['docs.read', 'docs.search'])

    expect(await preferences.load('feishu.docs')).toEqual(['docs.read', 'docs.search'])
    expect(settings.value).toMatchObject({
      pluginSettings: {
        clues: {
          requestedCapabilities: { 'feishu.docs': ['docs.read', 'docs.search'] },
          packs: { pinned: ['x'] },
        },
        other: { enabled: true },
      },
    })
    expect(settings.settingsUpdate).toHaveBeenCalledWith({
      pluginSettings: {
        clues: {
          requestedCapabilities: { 'feishu.docs': ['docs.read', 'docs.search'] },
        },
      },
    }, 4)
  })

  it('waits for a queued permission save before loading after a remount', async () => {
    const settings = fakeSettings({ pluginSettings: { clues: {} } })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const write = settings.settingsUpdate.getMockImplementation()!
    settings.settingsUpdate.mockImplementationOnce(async (patch, revision) => {
      await gate
      return await write(patch, revision)
    })
    const preferences = createCluePermissionPreferences(settings)
    const saving = preferences.save('feishu.docs', ['docs.read'])
    await Promise.resolve()
    await Promise.resolve()
    const loading = preferences.load('feishu.docs')
    expect(settings.settingsGet).toHaveBeenCalledTimes(1)
    release()
    await saving
    await expect(loading).resolves.toEqual(['docs.read'])
  })

  it('re-reads and retries once after a revision conflict', async () => {
    const settings = fakeSettings({ pluginSettings: { clues: {} } })
    settings.revision = 8
    settings.settingsUpdate.mockImplementationOnce(async () => {
      settings.revision = 9
      throw Object.assign(new Error('conflict'), { code: 'settings-conflict' })
    })
    const preferences = createCluePermissionPreferences(settings)
    await preferences.save('feishu.tasks', ['tasks.read'])
    expect(settings.settingsGet).toHaveBeenCalledTimes(2)
    expect(settings.settingsUpdate).toHaveBeenNthCalledWith(2, {
      pluginSettings: { clues: { requestedCapabilities: { 'feishu.tasks': ['tasks.read'] } } },
    }, 9)
  })
})
