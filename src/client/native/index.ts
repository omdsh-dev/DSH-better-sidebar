/**
 * The plugin's content, registered into DSH's native right Sidebar.
 *
 * Every tab the plugin can draw becomes a native tab TYPE plus a BODY:
 *
 * - the `editor` type is both a page (the files window) and a resource
 *   viewer — it claims `dsh-resource://file/**` at the default `extension`
 *   band, which outranks the built-in `text` preview (`fallback`), so a file
 *   the product opens lands in the plugin's editor — EXCEPT the formats
 *   {@link HOST_OWNED_EXTS} hands back to DSH's own previews, which are
 *   strictly better for binary documents (host-side Office→PDF conversion,
 *   a worker-backed spreadsheet table, a zoom viewport);
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

/**
 * Extensions DSH's own previews own, and this plugin therefore refuses.
 *
 * DSH 0.1.7 grew a real document-preview package (host-side Office→PDF
 * conversion, a worker-backed spreadsheet table, image/PDF zoom viewports and
 * per-directory auto-refresh) for exactly these formats, while the plugin's
 * equivalents are read-only fallbacks. The plugin keeps what the built-in does
 * NOT do: Markdown through its own renderer, HTML through its sandboxed route
 * with the `htmlViewerNoSandbox` safety valve, and — through the `code`
 * catch-all — a genuinely EDITABLE CodeMirror buffer for every text file.
 *
 * Refusing here is what hands the address over: `canOpen` returning false
 * leaves the built-in `text` type (the `fallback` band) as the only claimant.
 *
 * The list is exactly the set the host renders — nothing more. Nine extensions
 * that the host has NO renderer for (`xlsb xlt xltx xltm ots dot dotx avif`)
 * used to be refused here too, and refusing them turned "the plugin shows a
 * download panel" into "the host shows 'preview is not available for this file
 * type yet'" — a dead end. They are claimed again, so the `code` catch-all
 * takes them to the binary download pane. `fods` stays refused on purpose: the
 * host's plain-text fallback renders flat ODS XML, which beats a download.
 * `tests/native-surface.spec.ts` pins both directions of this boundary.
 */
const HOST_OWNED_EXTS: ReadonlySet<string> = new Set([
  // Spreadsheets: the built-in renders a table in a worker.
  'xlsx', 'xls', 'csv', 'tsv', 'fods',
  // PDF: the built-in viewer pages and zooms.
  'pdf',
  // Images: the built-in viewer adds a zoom viewport.
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico',
  // Office documents: the built-in converts them to PDF host-side.
  'doc', 'docx', 'ppt', 'pptx',
])

/**
 * Whether DSH's own preview owns one path.
 * @param path - the address's decoded path.
 * @returns true for a {@link HOST_OWNED_EXTS} extension (a dotfile is not one).
 */
function hostOwnedPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && HOST_OWNED_EXTS.has(name.slice(dot + 1).toLowerCase())
}

/** The native tab-type registry face (`ctx.sidebarRightTabs`). */
interface NativeTabRegistry {
  register(definition: {
    id: string
    kind: string
    multiple?: boolean
    patterns?: readonly string[]
    priority?: 'extension' | 'builtin' | 'fallback'
    canOpen?: (address: string) => boolean
    title: (address: string) => string
    guide?: readonly { id: string; order: number; title: () => string; description?: () => string; icon?: unknown }[]
  }): () => void
}

/** The kind the plugin's files window owns (page + file viewer). */
const EDITOR_KIND = 'editor'

/** The built-in page kind this plugin takes over. */
const FILES_KIND = 'files'

/** The plugin's implementation id for a descriptor (unique across kinds). */
function nativeId(descriptorId: string): string {
  return `dsh-better-sidebar:${descriptorId}`
}

/** The descriptor's title text, evaluated fresh for the current locale. */
function titleOf(descriptor: TabDescriptor): string {
  return typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title
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

/**
 * Whether the host registry rejected a registration because the id is taken.
 *
 * `@deepseek-ai/dsh-client-ui-sidebar-right` throws
 * `sidebarRight: tab type id "<id>" is already registered`, and the sibling
 * kind guard throws `… tab kind "<kind>" is already registered (…)`. Both mean
 * "the registry already holds this", which is exactly the case a re-entrant
 * `sync()` must tolerate rather than propagate. Matching on the message is the
 * only handle available: the host exports no error class for it, and the two
 * guards are separate `throw new Error` sites.
 * @param error - the value thrown by `register`.
 * @returns true when the registry refused a duplicate id.
 */
function isAlreadyRegisteredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('is already registered')
}

/** Everything the registrations need. */
export interface NativeSurfaceDeps {
  readonly ctx: Context
  readonly store: SidebarStore
  readonly service: BetterSidebarService
  /** The shared native tab record registry (the surface writes it too). */
  readonly records: NativeTabRecords
  /**
   * Report a tab-type registration failure (phase label + cause).
   *
   * `ctx.inject`'s callback body and the registry's own subscriber callbacks
   * run OUTSIDE this module's control flow, so a throw from
   * `sidebarRightTabs.register` is swallowed by cordis and the whole native
   * surface stays empty with no symptom beyond a missing guide. Reporting
   * through the client's diagnostic strip (index.tsx `fail`) turns a silent
   * contract break into a visible one — the failure mode observed when DSH
   * 0.1.6-alpha.2 made `SidebarRightGuideEntry.id` required.
   */
  readonly reportFailure?: (phase: string, error: unknown) => void
}

/**
 * Register the plugin's tabs into the native right Sidebar and keep them in
 * step with the plugin's own registry and settings.
 * @param deps - client context, the plugin store/service, and the records.
 * @returns a disposer unregistering everything.
 */
export function registerNativeSurface(deps: NativeSurfaceDeps): () => void {
  const { ctx, store, service, records, reportFailure } = deps
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
    // The live registrations live OUTSIDE `sync()` so a re-entrant call can
    // release what an earlier one registered before it re-registers.
    //
    // `sync` is subscribed to BOTH the descriptor registry and the sidebar
    // store, and `SidebarStore.notify()` runs its listeners INLINE — so every
    // preference write, session switch and state mutation calls `sync`
    // synchronously, more than once per frame. The host registry's duplicate
    // guard is a synchronous `ids.has(id)`, while its `ids.add(id)` runs
    // inside the registration's effect, so a registration that throws AFTER
    // the host has already taken the id leaves `live` without a handle for it
    // (the `live.set` never ran) — and the next `sync` then calls `register`
    // on an id that is still held. That is the observed
    // `sidebarRight: tab type id "dsh-better-sidebar:files" is already
    // registered`.
    const live = new Map<string, Registration>()

    const fileParamsOf = (info: NativeTabInfo): NativeTabParams | undefined => {
      const address = parseFileAddress(info.tab.contentId)
      return address === undefined ? undefined : { path: address.path }
    }
    const fileSessionIdOf = (info: NativeTabInfo): string | undefined => {
      const address = parseFileAddress(info.tab.contentId)
      return address !== undefined && address.scope === 'session' ? address.sessionId : undefined
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
      // Same last-resort idempotence as `registerFilesKind`: a type the host
      // already holds is reused instead of aborting this descriptor's whole
      // registration (which would also skip its body/title slots below).
      let disposeType: () => void
      try {
        disposeType = tabs.register({
          id,
          kind: descriptor.id,
          ...(isEditor
            ? {
              patterns: ['dsh-resource://file/**'],
              canOpen: (address: string) => {
                const file = parseFileAddress(address)
                // A non-file address, or one of the formats the built-in
                // previews own, leaves the address to DSH's own `text` type.
                return file !== undefined && !hostOwnedPath(file.path)
              },
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
                // DSH 0.1.6-alpha.2 made `id` REQUIRED and unique per provider
                // (a duplicate throws `sidebarRight: duplicate guide entry id`).
                // The descriptor id is already unique per implementation, which
                // is exactly the uniqueness the registry asks for.
                id: descriptor.id,
                order: descriptor.order ?? 100,
                title: () => titleOf(descriptor),
                ...guideDescriptionOf(descriptor),
                ...guideIconOf(icon),
              }],
            }),
        })
      } catch (error) {
        if (!isAlreadyRegisteredError(error)) throw error
        // Already held: keep the host's row, contribute nothing to dispose.
        disposeType = () => {}
      }
      const slots = registerSlots(
        id,
        { ctx, store, service, records, descriptorId: descriptor.id },
        isEditor ? { paramsOf: fileParamsOf, sessionIdOf: fileSessionIdOf } : {},
      )
      return () => {
        for (const dispose of slots.reverse()) dispose()
        disposeType()
      }
    }

    /** One `files`-kind takeover: the plugin's explorer under the built-in kind. */
    const registerFilesKind = (editor: TabDescriptor | undefined): (() => void) => {
      const id = 'dsh-better-sidebar:files'
      // Last-resort idempotence. The re-entry guard above already disposes a
      // previous run's registrations before this one registers, so reaching
      // this catch means the host still holds the id for a reason this module
      // cannot see (an aggregate bundle mounting the same package under its
      // own entry id is the known one). The host's guard is a synchronous
      // `ids.has(id)` check, and its `ids.add(id)` happens inside the
      // registration's effect — so a same-tick second registration can also
      // slip past the host's own check and blow up on the effect instead.
      // Reusing the existing type keeps the takeover WORKING instead of
      // trading a crash for a missing explorer.
      let disposeType: () => void
      try {
        disposeType = tabs.register({
          id,
          kind: FILES_KIND,
          priority: 'extension',
          title: () => t('files'),
          guide: [{
            // Required and unique per provider since DSH 0.1.6-alpha.2. This
            // takeover is its own implementation id, so its guide row takes
            // that same id.
            id: 'files',
            order: 10,
            title: () => t('files'),
            // The takeover IS the editor descriptor's page, so it carries the
            // editor's glyph AND guide line: without them the "Files" row is
            // the only guide entry with a blank icon slot and no description.
            ...guideDescriptionOf(editor),
            ...guideIconOf(editor?.icon),
          }],
        })
      } catch (error) {
        if (!isAlreadyRegisteredError(error)) throw error
        // Already held: keep the host's row, contribute nothing to dispose.
        disposeType = () => {}
      }
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
        // One descriptor must not take the rest of the surface down with it:
        // report and continue so the remaining types still register.
        try {
          live.set(descriptorId, { dispose: create() })
        } catch (error) {
          reportFailure?.(`register ${descriptorId}`, error)
        }
      }
      // The built-in files kind follows the editor type's switch: with the
      // editor disabled the plugin has no explorer to put there.
      const wantsFiles = service.isTabEnabled(EDITOR_KIND)
      const hasFiles = live.has(FILES_KIND)
      if (wantsFiles && !hasFiles) {
        try {
          live.set(FILES_KIND, { dispose: registerFilesKind(service.getTab(EDITOR_KIND)) })
        } catch (error) {
          reportFailure?.(`register ${FILES_KIND}`, error)
        }
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