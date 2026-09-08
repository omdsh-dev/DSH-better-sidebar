import type { BetterSidebarTerminalHandle, BetterSidebarTerminalRequest, BetterSidebarWorkspaceProvider, BetterSidebarWorkspaceScope } from './workspace-provider.ts'
import { SidebarError } from './wire.ts'

interface Entry {
  sessionId: string
  cwd: string
  provider: BetterSidebarWorkspaceProvider
  users: Set<symbol>
  controller: AbortController
  ready: Promise<BetterSidebarTerminalHandle>
  handle?: BetterSidebarTerminalHandle
  parked: boolean
  closed: boolean
  timer?: ReturnType<typeof setTimeout>
  closing?: Promise<void>
}

export interface WorkspaceTerminalAttachment {
  ready: Promise<BetterSidebarTerminalHandle>
  release(park?: boolean): void
  close(): Promise<void>
}

/** One process per session/tab, with connection leases and bounded pending spawns. */
export class WorkspaceTerminalManager {
  private readonly entries = new Map<string, Entry>()
  private readonly closing = new Set<Promise<void>>()
  private readonly failed = new Set<Entry>()
  private disposed = false

  constructor(private readonly maxPerSession: number, private readonly graceMs: number,
    private readonly onError: (error: unknown) => void = () => {}) {}

  attach(provider: BetterSidebarWorkspaceProvider, scope: BetterSidebarWorkspaceScope,
    request: Omit<BetterSidebarTerminalRequest, 'signal'>): WorkspaceTerminalAttachment {
    if (this.disposed) throw new Error('terminal manager is disposed')
    if (!provider.terminal) throw new SidebarError('pty-error', 'this workspace provider does not support interactive terminals')
    const key = JSON.stringify([request.sessionId, request.tabId])
    let entry = this.entries.get(key)
    if (entry && (entry.provider !== provider || entry.cwd !== scope.cwd || entry.handle?.snapshot().exited)) {
      void this.closeEntry(key, entry).catch(this.onError)
      entry = undefined
    }
    if (!entry) {
      const count = [...this.entries.values()].filter(item => item.sessionId === request.sessionId).length
      if (count >= this.maxPerSession) throw new SidebarError('pty-error', `terminal limit reached (${this.maxPerSession}) for this session`)
      const controller = new AbortController()
      const created: Entry = {
        sessionId: request.sessionId, cwd: scope.cwd, provider, users: new Set(), controller,
        ready: undefined as unknown as Promise<BetterSidebarTerminalHandle>, parked: false, closed: false,
      }
      created.ready = Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return provider.terminal!.open(scope, { ...request, signal: controller.signal })
      }).then(async handle => {
        created.handle = handle
        if (created.closed) {
          await handle.close()
          throw new Error('terminal closed while opening')
        }
        return handle
      }).catch(error => {
        if (this.entries.get(key) === created) this.entries.delete(key)
        if (!created.handle) {
          created.closed = true
          if (created.timer) clearTimeout(created.timer)
        }
        throw error
      })
      // A socket can disappear before it starts awaiting readiness.
      void created.ready.catch(() => {})
      this.entries.set(key, created)
      entry = created
    }
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    entry.parked = false
    const owned = entry
    const lease = Symbol('terminal socket')
    owned.users.add(lease)
    return {
      ready: owned.ready,
      release: (park = false) => {
        if (!owned.users.delete(lease) || owned.closed) return
        if (owned.users.size) return
        if (park) owned.parked = true
        if (owned.parked) return
        if (owned.timer) clearTimeout(owned.timer)
        owned.timer = setTimeout(() => { void this.closeEntry(key, owned).catch(this.onError) }, this.graceMs)
      },
      close: () => this.closeEntry(key, owned),
    }
  }

  async close(sessionId: string, tabId: string): Promise<void> {
    const key = JSON.stringify([sessionId, tabId])
    const entry = this.entries.get(key)
    if (entry) await this.closeEntry(key, entry)
  }

  private closeEntry(key: string, entry: Entry): Promise<void> {
    if (entry.closing) return entry.closing
    if (entry.closed && !this.failed.has(entry)) return Promise.resolve()
    entry.closed = true
    entry.controller.abort(new Error('terminal closed'))
    if (entry.timer) clearTimeout(entry.timer)
    if (this.entries.get(key) === entry) this.entries.delete(key)
    const closing = (async () => {
      try {
        if (entry.handle) await entry.handle.close()
        else {
          try { await entry.ready } catch (error) {
            // The pending opener either aborts or closes its late handle.
            // A cleanup failure must remain visible and retryable.
            const acquiredHandle = (): BetterSidebarTerminalHandle | undefined => entry.handle
            if (acquiredHandle() && error !== entry.controller.signal.reason
              && !(error instanceof Error && error.message === 'terminal closed while opening')) throw error
          }
        }
        this.failed.delete(entry)
      } catch (error) { this.failed.add(entry); throw error }
    })()
    entry.closing = closing
    this.closing.add(closing)
    void closing.finally(() => { this.closing.delete(closing); entry.closing = undefined }).catch(() => {})
    return closing
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const results = await Promise.allSettled([
      ...this.closing,
      ...[...this.entries].map(([key, entry]) => this.closeEntry(key, entry)),
      ...[...this.failed].map(entry => this.closeEntry('', entry)),
    ])
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'workspace terminal cleanup failed')
  }
}
