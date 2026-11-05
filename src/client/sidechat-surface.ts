/** A deliberately narrow, opt-in bridge for settled sidechat Markdown.
 * The renderer lives in the consumer; this module never searches or forges
 * main-conversation DOM and holds only currently attached row roots. */
export interface SidechatSurface {
  readonly root: HTMLElement
  readonly source: 'dsh-better-sidebar/sidechat'
  readonly threadId: string
  readonly eventSeq: number
  readonly contentBlockIndex: number
  /** Original assistant text, before Markdown link rewriting. */
  readonly text: string
  readonly sendPrompt: (text: string) => Promise<void>
}

export interface SidechatSurfaceAdapter {
  readonly id: string
  /** Own only this root; return an idempotent cleanup that restores Markdown.
   * A throwing mount must roll back its own partial changes before throwing. */
  readonly mount: (surface: SidechatSurface) => (() => void)
}

interface Registration {
  adapter: SidechatSurfaceAdapter
  active: boolean
}

interface AttachedSurface {
  surface: SidechatSurface
  active: boolean
  mounts: Map<Registration, () => void>
}

const noop = (): void => {}

function safely(action: () => void): void {
  try {
    action()
  } catch (error) {
    console.error('[dsh-better-sidebar] sidechat surface adapter error:', error)
  }
}

/** Identity is log-owned, never guessed from a DOM position or parent session. */
export function isSidechatSurfaceIdentity(threadId: unknown, eventSeq: unknown, contentBlockIndex: unknown): boolean {
  return typeof threadId === 'string' && threadId.trim() !== ''
    && typeof eventSeq === 'number' && Number.isSafeInteger(eventSeq) && eventSeq >= 0
    && typeof contentBlockIndex === 'number' && Number.isSafeInteger(contentBlockIndex) && contentBlockIndex >= 0
}

function createRegistry() {
  const adapters = new Map<string, Registration>()
  const roots = new Map<HTMLElement, AttachedSurface>()
  let disposed = false

  const mount = (registration: Registration, attached: AttachedSurface): void => {
    if (!registration.active || !attached.active || attached.mounts.has(registration)) return
    safely(() => {
      const cleanup = registration.adapter.mount({
        ...attached.surface,
        sendPrompt: async (text: string): Promise<void> => {
          if (!registration.active || !attached.active) throw new Error('Sidechat surface is no longer active')
          await attached.surface.sendPrompt(text)
        },
      })
      if (typeof cleanup !== 'function') throw new Error('Sidechat surface adapter must return a cleanup function')
      // A callback can synchronously unregister itself or detach the row.
      if (!registration.active || !attached.active) safely(cleanup)
      else attached.mounts.set(registration, cleanup)
    })
  }

  const detach = (attached: AttachedSurface): void => {
    if (!attached.active) return
    attached.active = false
    if (roots.get(attached.surface.root) === attached) roots.delete(attached.surface.root)
    const cleanups = [...attached.mounts.values()]
    attached.mounts.clear()
    for (const cleanup of cleanups) safely(cleanup)
  }

  return {
    register(adapter: SidechatSurfaceAdapter): () => void {
      if (disposed) throw new Error('[dsh-better-sidebar] sidechat surface registry is disposed')
      if (typeof adapter.id !== 'string' || adapter.id.trim() === '' || typeof adapter.mount !== 'function') {
        throw new Error('[dsh-better-sidebar] invalid sidechat surface adapter')
      }
      if (adapters.has(adapter.id)) {
        throw new Error(`[dsh-better-sidebar] sidechat surface adapter "${adapter.id}" already registered`)
      }
      const registration: Registration = { adapter, active: true }
      adapters.set(adapter.id, registration)
      for (const attached of [...roots.values()]) mount(registration, attached)
      return () => {
        if (!registration.active) return
        registration.active = false
        if (adapters.get(adapter.id) === registration) adapters.delete(adapter.id)
        for (const attached of [...roots.values()]) {
          const cleanup = attached.mounts.get(registration)
          attached.mounts.delete(registration)
          if (cleanup !== undefined) safely(cleanup)
        }
      }
    },
    attach(surface: SidechatSurface): () => void {
      if (disposed || surface.source !== 'dsh-better-sidebar/sidechat'
        || !isSidechatSurfaceIdentity(surface.threadId, surface.eventSeq, surface.contentBlockIndex)
        || typeof surface.text !== 'string' || typeof surface.sendPrompt !== 'function') return noop
      const Element = surface.root?.ownerDocument?.defaultView?.HTMLElement
      if (Element === undefined || !(surface.root instanceof Element)) return noop
      const previous = roots.get(surface.root)
      if (previous !== undefined) detach(previous)
      const attached: AttachedSurface = { surface, active: true, mounts: new Map() }
      roots.set(surface.root, attached)
      for (const registration of [...adapters.values()]) mount(registration, attached)
      return () => { detach(attached) }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const registration of adapters.values()) registration.active = false
      adapters.clear()
      for (const attached of [...roots.values()]) detach(attached)
    },
  }
}

/** Weak service ownership avoids adding attach/dispose to the public service. */
const registries = new WeakMap<object, ReturnType<typeof createRegistry>>()

/** @internal Bind once while the BetterSidebar service is being constructed. */
export function bindSidechatSurfaces(service: object): (adapter: SidechatSurfaceAdapter) => (() => void) {
  const registry = createRegistry()
  registries.set(service, registry)
  return adapter => registry.register(adapter)
}

/** @internal Only SideChatView attaches real, visible settled Markdown roots. */
export function attachSidechatSurface(service: object | undefined, surface: SidechatSurface): () => void {
  return service === undefined ? noop : registries.get(service)?.attach(surface) ?? noop
}

/** @internal Plugin teardown, even if a React row has not unmounted yet. */
export function disposeSidechatSurfaces(service: object): void {
  registries.get(service)?.dispose()
  registries.delete(service)
}
