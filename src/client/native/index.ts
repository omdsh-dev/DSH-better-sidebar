/**
 * The plugin's content, registered into DSH's native right Sidebar.
 *
 * Every tab the plugin can draw becomes a native tab TYPE plus a BODY:
 *
 * - the `editor` type is both a page (the files window) and a resource
 *   viewer — it claims `dsh-resource://file/**` at the default `extension`
 *   band, which outranks the built-in `text` preview (`fallback`) and the
 *   built-in `files` tree (`builtin`), so every file the product opens lands
 *   in the plugin's editor;
 * - the built-in `files` page kind is TAKEN OVER by an `extension`
 *   registration of the same kind, so `openTab('files')` draws the plugin's
 *   explorer instead of the built-in tree; the built-in resumes when this
 *   plugin unregisters;
 * - every other descriptor (changes / subagent / side chat / terminal /
 *   browser / diff) becomes a page type of its own.
 *
 * The registrations follow the plugin's registry lifecycle: a descriptor
 * registered later (an external plugin) gets its native type too, and a type
 * the user disabled in the side-card settings is unregistered — so it is
 * absent from the native guide and `openTab` refuses it.
 */
import type { Context } from '../../context-types.ts'
import { t } from '../locales.ts'
import { parseFileAddress } from '../resource-address.ts'
import type { BetterSidebarService, TabDescriptor } from '../service.ts'
import type { SidebarStore } from '../state.ts'
import {
  NativeTabBody,
  NativeTabTitle,
  type NativeBodyInjected,
  type NativeTabInfo,
  type NativeTabParams,
  type NativeTabRecords,
} from './tab-adapter.tsx'

/** The native tab-type registry face (`ctx.sidebarRightTabs`). */
interface NativeTabRegistry {
  register(definition: {
    id: string
    kind: string
    patterns?: readonly string[]
    priority?: 'extension' | 'builtin' | 'fallback'
    canOpen?: (address: string) => boolean
    title: (address: string) => string
    guide?: readonly { order: number; title: () => string; description?: () => string; icon?: unknown }[]
  }): () => void
}

/** The kind the plugin's files window owns (page + file viewer). */
const EDITOR_KIND = 'editor'

/** The built-in page kind this plugin takes over. */
const FILES_KIND = 'files'

/**
 * The descriptor whose tab navigates to a URL. Its open seed arrives as
 * `navigation.params.url`, while the view reads — and the session state
 * persists — `tab.path`, so the descriptor needs the mapping declared below;
 * without it the seed stops at `meta.url` and the tab opens with an empty
 * address bar.
 */
const BROWSER_KIND = 'browser'

/** The plugin's implementation id for a descriptor (unique across kinds). */
function nativeId(descriptorId: string): string {
  return `dsh-better-sidebar:${descriptorId}`
}

/** The descriptor's title text, evaluated fresh for the current locale. */
function titleOf(descriptor: TabDescriptor): string {
  return typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title
}

/**
 * The URL a browser tab's record carries in its `meta`, when it has one.
 * `meta.url` is where a native open stores the seed (`tab-adapter` keeps a
 * navigation's `url` there), so reading it back is what makes an already-open
 * or persisted tab render instead of showing an empty browser.
 * @param meta - the native record's custom state.
 * @returns the URL, or `undefined` when the record carries none.
 */
function urlOfMeta(meta: unknown): string | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const url = (meta as { url?: unknown }).url
  return typeof url === 'string' && url !== '' ? url : undefined
}

/**
 * The guide fields carrying the descriptor's own description line, evaluated
 * fresh for the current locale. DSH 0.1.5-rc.1+ renders `description` only
 * while the guide lists at most 4 entries, and a descriptor that declares
 * none must reach the host with NO `description` field at all — the host has
 * no fallback of its own, so an empty string would render as a blank second
 * line rather than a clean title-only capsule.
 * @param descriptor - the tab descriptor owning the guide entry.
 * @returns the `description` field, or an empty object.
 */
function guideDescriptionOf(descriptor: TabDescriptor | undefined): { description?: () => string } {
  const description = descriptor?.description
  return description === undefined ? {} : { description: () => (typeof description === 'function' ? description() : description) }
}

/**
 * The guide row's glyph for a descriptor icon (nothing when it has none).
 * The native guide renders `entry.icon`, so a takeover registered without one
 * is the only row in the list with a blank leading slot.
 * @param icon - the descriptor's icon value.
 * @returns the guide-entry icon fields, or an empty object.
 */
function guideIconOf(icon: TabDescriptor['icon']): { icon?: (props: { size?: number }) => unknown } {
  return typeof icon === 'function' ? { icon: (props: { size?: number }) => icon(props.size ?? 16) } : {}
}

/**
 * The chip title of a file address: its own file name. A resource tab is
 * identified by its address, so the strip must name the FILE — the
 * descriptor's title ("Files") would make every open file look identical.
 * @param address - the native tab's content address.
 * @returns the file name, or undefined when the address is not a file.
 */
function fileTitleOf(address: string): string | undefined {
  const parsed = parseFileAddress(address)
  if (parsed === undefined) return undefined
  const segments = parsed.path.split('/').filter(segment => segment !== '')
  return segments.length === 0 ? undefined : segments[segments.length - 1]
}

/** One descriptor's live native registrations. */
interface Registration {
  readonly dispose: () => void
}

/** Everything the registrations need. */
export interface NativeSurfaceDeps {
  readonly ctx: Context
  readonly store: SidebarStore
  readonly service: BetterSidebarService
  /** The shared native tab record registry (the surface writes it too). */
  readonly records: NativeTabRecords
}

/**
 * Register the plugin's tabs into the native right Sidebar and keep them in
 * step with the plugin's own registry and settings.
 * @param deps - client context, the plugin store/service, and the records.
 * @returns a disposer unregistering everything.
 */
export function registerNativeSurface(deps: NativeSurfaceDeps): () => void {
  const { ctx, store, service, records } = deps
  // Wait for the tab-type REGISTRY (a service), not for the slot declaration:
  // the native seat declares `sidebar.right.pane.tab` BEFORE it provides
  // `sidebarRightTabs`, so a declaration-triggered registration reads the
  // service as missing and — because the declaration never collapses —
  // registers nothing, permanently. Observed on a real profile: the
  // declaration callback fired with both `sidebarRight` and
  // `sidebarRightTabs` undefined, and the registry appeared a moment later.
  // `ctx.inject` re-runs this body whenever the service appears/reappears,
  // which is the lifecycle the registrations need.
  const seat = ctx.inject(['sidebarRightTabs'], (injected) => {
    const tabs = injected.get('sidebarRightTabs') as unknown as NativeTabRegistry | undefined
    if (tabs === undefined) return
    const live = new Map<string, Registration>()

    const fileParamsOf = (info: NativeTabInfo): NativeTabParams | undefined => {
      const address = parseFileAddress(info.tab.contentId)
      return address === undefined ? undefined : { path: address.path }
    }
    const fileSessionIdOf = (info: NativeTabInfo): string | undefined => {
      const address = parseFileAddress(info.tab.contentId)
      return address !== undefined && address.scope === 'session' ? address.sessionId : undefined
    }
    /**
     * The browser tab's open seed, mapped to the field its view reads: the
     * seed arrives as `params.url` (how `openTab({ type, url })` and the
     * agent/`sidebar_open` flow address it), and `BrowserView` mounts from
     * `tab.path`. Declaring `path` also keeps a reload working, because the
     * record's `path` is the field the session state persists.
     */
    const browserParamsOf = (info: NativeTabInfo): NativeTabParams | undefined => {
      const params = info.tab.navigation.params
      const url = params?.url ?? urlOfMeta(params?.meta)
      return url === undefined ? undefined : { path: url }
    }

    /** Register the body + chip-title slots for one native implementation id. */
    const registerSlots = (
      id: string,
      injected: Omit<NativeBodyInjected, 'sessionId'>,
      params: Pick<NativeBodyInjected, 'paramsOf' | 'sessionIdOf'>,
    ): Array<() => void> => [
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: id,
        inject: (sessionId: string) => ({ ...injected, ...params, sessionId }),
      }, NativeTabBody)),
      ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: id,
        inject: () => ({ records, service, descriptorId: injected.descriptorId }),
      }, NativeTabTitle)),
    ]

    /** One descriptor's native type + body + title, as one disposable. */
    const registerDescriptor = (descriptor: TabDescriptor): (() => void) => {
      const id = nativeId(descriptor.id)
      const isEditor = descriptor.id === EDITOR_KIND
      const icon = descriptor.icon
      const disposeType = tabs.register({
        id,
        kind: descriptor.id,
        ...(isEditor
          ? {
            patterns: ['dsh-resource://file/**'],
            canOpen: (address: string) => parseFileAddress(address) !== undefined,
          }
          : {}),
        // An external implementation outranks the product's own viewers, which
        // is what lets the plugin's editor take over file addresses.
        priority: 'extension',
        // A resource tab is titled by the file it shows; a page tab keeps the
        // descriptor's own title.
        title: (address: string) => (isEditor ? fileTitleOf(address) ?? titleOf(descriptor) : titleOf(descriptor)),
        // No guide entry for the editor: its page identity is the `files`
        // kind takeover below (same view, same title), so listing both would
        // offer the reader two identical "Files" rows. The type itself stays
        // registered as the file RESOURCE viewer.
        ...(descriptor.hidden === true || isEditor
          ? {}
          : {
            guide: [{
              order: descriptor.order ?? 100,
              title: () => titleOf(descriptor),
              ...guideDescriptionOf(descriptor),
              ...guideIconOf(icon),
            }],
          }),
      })
      const slots = registerSlots(
        id,
        { ctx, store, service, records, descriptorId: descriptor.id },
        isEditor
          ? { paramsOf: fileParamsOf, sessionIdOf: fileSessionIdOf }
          : descriptor.id === BROWSER_KIND ? { paramsOf: browserParamsOf } : {},
      )
      return () => {
        for (const dispose of slots.reverse()) dispose()
        disposeType()
      }
    }

    /** One `files`-kind takeover: the plugin's explorer under the built-in kind. */
    const registerFilesKind = (editor: TabDescriptor | undefined): (() => void) => {
      const id = 'dsh-better-sidebar:files'
      const disposeType = tabs.register({
        id,
        kind: FILES_KIND,
        priority: 'extension',
        title: () => t('files'),
        guide: [{
          order: 10,
          title: () => t('files'),
          // The takeover IS the editor descriptor's page, so it carries the
          // editor's glyph AND guide line: without them the "Files" row is
          // the only guide entry with a blank icon slot and no description.
          ...guideDescriptionOf(editor),
          ...guideIconOf(editor?.icon),
        }],
      })
      const slots = registerSlots(id, { ctx, store, service, records, descriptorId: EDITOR_KIND }, {})
      return () => {
        for (const dispose of slots.reverse()) dispose()
        disposeType()
      }
    }

    /** Bring the live registrations in line with the registry + the settings. */
    const sync = (): void => {
      const wanted = new Map<string, () => () => void>()
      for (const descriptor of service.getTabs()) {
        if (!service.isTabEnabled(descriptor.id)) continue
        wanted.set(descriptor.id, () => registerDescriptor(descriptor))
      }
      for (const [descriptorId, registration] of live) {
        if (wanted.has(descriptorId)) continue
        registration.dispose()
        live.delete(descriptorId)
      }
      for (const [descriptorId, create] of wanted) {
        if (live.has(descriptorId)) continue
        live.set(descriptorId, { dispose: create() })
      }
      // The built-in files kind follows the editor type's switch: with the
      // editor disabled the plugin has no explorer to put there.
      const wantsFiles = service.isTabEnabled(EDITOR_KIND)
      const hasFiles = live.has(FILES_KIND)
      if (wantsFiles && !hasFiles) {
        live.set(FILES_KIND, { dispose: registerFilesKind(service.getTab(EDITOR_KIND)) })
      }
      if (!wantsFiles && hasFiles) {
        live.get(FILES_KIND)?.dispose()
        live.delete(FILES_KIND)
      }
    }

    const disposeSubscriptions = [service.subscribe(sync), store.subscribe(sync)]
    sync()
    return () => {
      for (const registration of live.values()) registration.dispose()
      live.clear()
      for (const dispose of disposeSubscriptions.reverse()) dispose()
    }
  })
  return () => {
    void seat.dispose()
  }
}

export type { NativeTabRecords }
