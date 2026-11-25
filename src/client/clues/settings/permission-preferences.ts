import { api } from '../../api.ts'
import { parsePrefs, type SidebarSettingsClient } from '../../prefs.ts'

export interface CluePermissionPreferences {
  load(connectionId: string): Promise<readonly string[] | undefined>
  save(connectionId: string, capabilities: readonly string[]): Promise<void>
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isSettingsConflict(error: unknown): boolean {
  return error !== null && typeof error === 'object'
    && (error as { code?: unknown }).code === 'settings-conflict'
}

/** Persist only the next requested capability ids; OAuth credentials stay with lark-cli. */
export function createCluePermissionPreferences(
  settings: SidebarSettingsClient = api,
): CluePermissionPreferences {
  let writes = Promise.resolve()

  const load = async (connectionId: string): Promise<readonly string[] | undefined> => {
    await writes
    const view = await settings.settingsGet()
    const clueSettings = parsePrefs(view.value).pluginSettings.clues
    const requests = recordOf(clueSettings?.requestedCapabilities)
    const value = requests?.[connectionId]
    if (!Array.isArray(value)) return undefined
    return value.filter((entry): entry is string => typeof entry === 'string')
  }

  const saveOne = async (connectionId: string, capabilities: readonly string[]): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = await settings.settingsGet()
      if (view.revision === undefined) throw new Error('the settings document revision is unavailable')
      const clueSettings = parsePrefs(view.value).pluginSettings.clues ?? {}
      const requests = recordOf(clueSettings.requestedCapabilities) ?? {}
      try {
        await settings.settingsUpdate({
          pluginSettings: {
            clues: {
              requestedCapabilities: {
                ...requests,
                [connectionId]: [...capabilities],
              },
            },
          },
        }, view.revision)
        return
      } catch (error) {
        if (!isSettingsConflict(error) || attempt === 1) throw error
      }
    }
  }

  return {
    load,
    save(connectionId, capabilities) {
      const write = writes.then(() => saveOne(connectionId, capabilities))
      writes = write.then(() => undefined, () => undefined)
      return write
    },
  }
}

export const cluePermissionPreferences = createCluePermissionPreferences()
