import { WebSocket, type RawData } from 'ws'
import type { BetterSidebarTerminalHandle, BetterSidebarWorkspaceProvider, BetterSidebarWorkspaceScope } from './workspace-provider.ts'
import type { WorkspaceTerminalAttachment, WorkspaceTerminalManager } from './workspace-terminal.ts'

/** Keep the wire shared with local terminal tabs; buffer input during asynchronous SSH startup. */
export async function connectWorkspaceTerminal(
  ws: WebSocket,
  manager: WorkspaceTerminalManager,
  resolve: () => Promise<{ provider: BetterSidebarWorkspaceProvider; scope: BetterSidebarWorkspaceScope; sessionId: string; tabId: string }>,
): Promise<void> {
  let attachment: WorkspaceTerminalAttachment | undefined
  let terminal: BetterSidebarTerminalHandle | undefined
  let off: (() => void) | undefined
  let parked = false
  let closed = false
  let pending: string[] = []
  let pendingBytes = 0
  let resize: { cols: number; rows: number } | undefined
  let resizing = false
  const fail = (error: unknown): void => {
    if (closed) return
    const message = error instanceof Error ? error.message : String(error)
    if (ws.readyState === WebSocket.OPEN) ws.send(`\r\n[terminal error: ${message}]\r\n`)
    // RFC 6455 caps UTF-8 close reasons at 123 bytes.
    ws.close(1011, Buffer.from(message).subarray(0, 110).toString('utf8'))
  }
  const send = (text: string): void => {
    if (ws.readyState !== WebSocket.OPEN) return
    if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.close(1013, 'terminal output backpressure; reconnect for retained output'); return }
    ws.send(text)
  }
  const flushResize = async (): Promise<void> => {
    if (resizing) return
    resizing = true
    try {
      while (resize && terminal && !closed) {
        const value = resize
        resize = undefined
        await terminal.resize(value.cols, value.rows)
      }
    } finally { resizing = false }
  }
  const consume = (text: string): void => {
    let control: { type?: unknown; cols?: unknown; rows?: unknown } | undefined
    try { const value = JSON.parse(text); if (value && typeof value === 'object') control = value } catch { /* raw input */ }
    if (control?.type === 'close') {
      void attachment?.close().catch(fail)
      ws.close(1000, 'terminal tab closed')
      return
    }
    if (control?.type === 'park') { parked = true; return }
    if (!terminal || terminal.snapshot().exited) return
    if (control?.type === 'resize') {
      if (typeof control.cols !== 'number' || typeof control.rows !== 'number'
        || !Number.isFinite(control.cols) || !Number.isFinite(control.rows)) return
      resize = { cols: Math.min(1024, Math.max(2, Math.floor(control.cols))), rows: Math.min(1024, Math.max(2, Math.floor(control.rows))) }
      void flushResize().catch(fail)
    } else void terminal.write(text).catch(fail)
  }
  const onMessage = (data: RawData): void => {
    const text = data.toString('utf8')
    if (!terminal) {
      // Close/park controls must work even before the SSH handshake finishes.
      try {
        const type = JSON.parse(text)?.type
        if (type === 'close' || type === 'park') { consume(text); return }
      } catch { /* raw startup input */ }
      pendingBytes += Buffer.byteLength(text)
      if (pendingBytes > 1024 * 1024) { ws.close(1009, 'terminal startup input exceeds 1 MiB'); return }
      pending.push(text)
    } else {
      try { consume(text) } catch (error) { fail(error) }
    }
  }
  ws.on('message', onMessage)
  ws.once('close', () => {
    closed = true
    pending = []
    off?.()
    attachment?.release(parked)
    ws.off('message', onMessage)
  })
  try {
    const target = await resolve()
    if (closed || ws.readyState !== WebSocket.OPEN) return
    attachment = manager.attach(target.provider, target.scope, {
      sessionId: target.sessionId, tabId: target.tabId, cols: 80, rows: 24,
    })
    terminal = await attachment.ready
    if (closed || ws.readyState !== WebSocket.OPEN) return
    const snapshot = terminal.snapshot()
    if (snapshot.error) throw new Error(snapshot.error)
    if (snapshot.truncated) send('\r\n[earlier terminal output omitted]\r\n')
    if (snapshot.text) send(snapshot.text)
    off = terminal.subscribe(event => {
      if (event.type === 'data') send(event.data)
      else if (event.type === 'error') fail(new Error(event.message))
      else send(event.exitCode === null ? '\r\n[process ended]\r\n' : `\r\n[process exited with code ${event.exitCode}]\r\n`)
    })
    for (const text of pending) { if (closed) break; consume(text) }
    pending = []
    pendingBytes = 0
  } catch (error) { fail(error) }
}
