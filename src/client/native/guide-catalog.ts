/**
 * The live inventory of host guide cards (the native start page), as the
 * plugin's own start page and settings section consume it.
 *
 * The host's tab registry is the single authority: a type disabled in the
 * side-card settings unregisters its native type, so its card leaves this
 * catalog too. Entries are kept as thunks/components rather than resolved
 * strings so a language switch re-renders without a registry notification.
 */
import type { ComponentType } from 'react'
import type { Context } from '../../context-types.ts'
import { descriptorIdOfGuideEntry, guideKeyOf } from './guide-ids.ts'

/** One host guide card, normalized for the plugin's own surfaces. */
export interface NativeGuideEntry {
  /** Stable identity: providerId::entryId. */
  readonly key: string
  /** Implementation id of the type that contributed the card. */
  readonly providerId: string
  /** Entry id inside that provider. */
  readonly entryId: string
  /** The kind openTab accepts. */
  readonly kind: string
  /** Card title in the active language. */
  readonly title: () => string
  /** Optional one-line description in the active language. */
  readonly description?: () => string
  /** Optional card glyph component. */
  readonly icon?: ComponentType<{ size?: number }>
  /** The Better Sidebar descriptor that owns this card, when it is ours. */
  readonly descriptorId?: string
}

/** The catalog face the guide body and the settings section share. */
export interface NativeGuideCatalog {
  /** Reference-stable snapshot of the registered guide cards. */
  getSnapshot(): readonly NativeGuideEntry[]
  /** Observe registry changes. */
  subscribe(listener: () => void): () => void
}

/** The slice of the host tab registry this module reads. */
interface GuideRegistry {
  guide(): readonly {
    readonly id: string
    readonly kind: string
    readonly providerId: string
    readonly title: () => string
    readonly description?: () => string
    readonly icon?: ComponentType<{ size?: number }>
  }[]
  subscribe(listener: () => void): () => void
}

const EMPTY: readonly NativeGuideEntry[] = []

/** One registry snapshot, normalized. */
function entriesOf(registry: GuideRegistry | undefined): readonly NativeGuideEntry[] {
  if (registry === undefined) return EMPTY
  return registry.guide().map((entry) => {
    const descriptorId = descriptorIdOfGuideEntry(entry.providerId, entry.id)
    return {
      key: guideKeyOf(entry.providerId, entry.id),
      providerId: entry.providerId,
      entryId: entry.id,
      kind: entry.kind,
      title: entry.title,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.icon === undefined ? {} : { icon: entry.icon }),
      ...(descriptorId === undefined ? {} : { descriptorId }),
    }
  })
}

/**
 * Create the catalog and wait for the host registry.
 * @param ctx - the client context.
 * @returns the catalog plus the disposer releasing its registry subscription.
 */
export function createNativeGuideCatalog(ctx: Context): { catalog: NativeGuideCatalog; dispose: () => void } {
  const listeners = new Set<() => void>()
  let snapshot: readonly NativeGuideEntry[] = EMPTY
  let registry: GuideRegistry | undefined
  let unsubscribe: (() => void) | undefined

  const publish = (): void => {
    snapshot = entriesOf(registry)
    for (const listener of listeners) listener()
  }

  const seat = ctx.inject(['sidebarRightTabs'], (injected) => {
    registry = injected.get('sidebarRightTabs') as unknown as GuideRegistry | undefined
    if (registry === undefined) {
      publish()
      return
    }
    unsubscribe = registry.subscribe(publish)
    publish()
    return () => {
      unsubscribe?.()
      unsubscribe = undefined
      registry = undefined
      publish()
    }
  })

  return {
    catalog: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    dispose: () => { void seat.dispose() },
  }
}
