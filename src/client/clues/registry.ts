/**
 * The client half of the clue extension face (S1).
 *
 * The host catalogue carries only serializable source metadata (`icon` is a
 * string id); the React renderer stays in the plugin that owns the source and
 * is registered HERE. This registry deliberately has no UI: S9 composes the
 * surfaces, S1 only fixes the public seam.
 *
 * Preference reads use the shared "absent entry means ON" helpers
 * (`prefs-shared.ts`), so a source the user never toggled is enabled and an
 * explicit `false` is the only disable.
 */
import type {
  ClueFormatRenderer,
  ClueSourceDisplayDescriptor,
} from '../../clues/types.ts'
import {
  isCluePacksMentionEnabled,
  isClueSourceEnabled,
  isClueSourceMentionEnabled,
  type SidebarPrefs,
} from '../../prefs-shared.ts'
import { cluesApi, type CluesClientApi } from './api.ts'

/** The clue extension face published as `ctx.betterSidebar.clues`. */
export interface BetterSidebarCluesClientFace {
  /**
   * Register the client renderer metadata (name override / icon) of one
   * source. A duplicate `sourceId` is rejected explicitly — registration
   * order never silently wins. The returned disposer only removes this
   * registration (a re-registration after disposal is accepted again).
   */
  registerSourceDisplay(descriptor: ClueSourceDisplayDescriptor): () => void
  /** Every registered display, in registration order. */
  getSourceDisplays(): readonly ClueSourceDisplayDescriptor[]
  /**
   * Register the React renderer of one content format (S6 composes the
   * editor/floating window). A duplicate format is rejected explicitly and
   * the returned disposer removes exactly this registration.
   */
  registerFormatRenderer(format: string, renderer: ClueFormatRenderer): () => void
  /** The renderer registered for one format, if any. */
  getFormatRenderer(format: string): ClueFormatRenderer | undefined
  /** Every format renderer, in registration order (a copy). */
  getFormatRenderers(): ReadonlyMap<string, ClueFormatRenderer>
  /** Subscribe to display/format-renderer registration/disposal. */
  subscribe(listener: () => void): () => void
  /** Whether a clue source is enabled (absent pref entry = ON). */
  isSourceEnabled(sourceId: string): boolean
  /** Whether a source contributes @ candidates (absent = ON; a disabled source is effectively off). */
  isSourceMentionEnabled(sourceId: string): boolean
  /** Whether the local pack library contributes @ candidates (absent = ON). */
  isPacksMentionEnabled(): boolean
  /** The typed wire methods of the clue surface. */
  readonly api: CluesClientApi
}

/**
 * Create the client clue registry.
 * @param getPrefs - live access to the bound store's current prefs.
 */
export function createCluesClientRegistry(getPrefs: () => SidebarPrefs): BetterSidebarCluesClientFace {
  const displays = new Map<string, ClueSourceDisplayDescriptor>()
  const formatRenderers = new Map<string, ClueFormatRenderer>()
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  return {
    registerSourceDisplay(descriptor: ClueSourceDisplayDescriptor): () => void {
      if (typeof descriptor.sourceId !== 'string' || descriptor.sourceId.trim() === '') {
        throw new Error('[dsh-better-sidebar] a clue source display needs a non-empty sourceId')
      }
      if (displays.has(descriptor.sourceId)) {
        throw new Error(`[dsh-better-sidebar] clue source display "${descriptor.sourceId}" already registered`)
      }
      // Store our own copy and hand out copies on read: the descriptor is
      // caller-owned metadata, and a later mutation of it (or of a returned
      // row) must never rewrite what the registry publishes.
      const stored: ClueSourceDisplayDescriptor = { ...descriptor }
      displays.set(stored.sourceId, stored)
      notify()
      return () => {
        if (displays.get(stored.sourceId) !== stored) return
        displays.delete(stored.sourceId)
        notify()
      }
    },

    getSourceDisplays(): readonly ClueSourceDisplayDescriptor[] {
      return [...displays.values()].map(display => ({ ...display }))
    },

    registerFormatRenderer(format: string, renderer: ClueFormatRenderer): () => void {
      if (typeof format !== 'string' || format.trim() === '') {
        throw new Error('[dsh-better-sidebar] a clue format renderer needs a non-empty format')
      }
      if (typeof renderer !== 'function') {
        throw new Error(`[dsh-better-sidebar] clue format renderer "${format}" needs a function`)
      }
      if (formatRenderers.has(format)) {
        throw new Error(`[dsh-better-sidebar] clue format renderer "${format}" already registered`)
      }
      formatRenderers.set(format, renderer)
      notify()
      return () => {
        if (formatRenderers.get(format) !== renderer) return
        formatRenderers.delete(format)
        notify()
      }
    },

    getFormatRenderer(format: string): ClueFormatRenderer | undefined {
      return formatRenderers.get(format)
    },

    getFormatRenderers(): ReadonlyMap<string, ClueFormatRenderer> {
      return new Map(formatRenderers)
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    isSourceEnabled(sourceId: string): boolean {
      return isClueSourceEnabled(getPrefs(), sourceId)
    },

    isSourceMentionEnabled(sourceId: string): boolean {
      // The source switch is authoritative: a disabled source never mentions,
      // even while its own @ switch stays stored as true.
      const prefs = getPrefs()
      return isClueSourceEnabled(prefs, sourceId) && isClueSourceMentionEnabled(prefs, sourceId)
    },

    isPacksMentionEnabled(): boolean {
      return isCluePacksMentionEnabled(getPrefs())
    },

    api: cluesApi,
  }
}
