/**
 * Identity vocabulary shared by the native tab registration and the start-page
 * takeover. Kept dependency-free so the catalog and the slot registration can
 * both use it without importing each other.
 */

/** The kind the plugin's files window owns (page + file viewer). */
export const EDITOR_KIND = 'editor'

/** The built-in page kind this plugin takes over. */
export const FILES_KIND = 'files'

/** The prefix of every implementation id this plugin registers natively. */
const NATIVE_ID_PREFIX = 'dsh-better-sidebar:'

/** The plugin's implementation id for a descriptor (unique across kinds). */
export function nativeId(descriptorId: string): string {
  return NATIVE_ID_PREFIX + descriptorId
}

/** Stable identity of one host guide card: provider implementation + entry id. */
export function guideKeyOf(providerId: string, entryId: string): string {
  return providerId + '::' + entryId
}

/** The native identity a Better Sidebar descriptor registers under. */
export function guideIdentityOfDescriptor(descriptorId: string): {
  providerId: string
  entryId: string
  kind: string
} {
  if (descriptorId === EDITOR_KIND) {
    return { providerId: nativeId(FILES_KIND), entryId: FILES_KIND, kind: FILES_KIND }
  }
  return { providerId: nativeId(descriptorId), entryId: descriptorId, kind: descriptorId }
}

/**
 * The Better Sidebar descriptor that owns one native guide card, when it is
 * one of ours. The files takeover is its own registration id but is the
 * editor descriptor's page.
 */
export function descriptorIdOfGuideEntry(providerId: string, entryId: string): string | undefined {
  if (providerId === nativeId(FILES_KIND) && entryId === FILES_KIND) return EDITOR_KIND
  if (!providerId.startsWith(NATIVE_ID_PREFIX)) return undefined
  const implementation = providerId.slice(NATIVE_ID_PREFIX.length)
  return entryId === implementation ? implementation : undefined
}
