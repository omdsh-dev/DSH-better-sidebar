/** Durable thread identity for native side-chat occurrences. The host persists
 * contentId, but not navigation.params. Never restore by tab1 or session-last:
 * both can name a different conversation after a new tab/layout is created. */
export const SIDECHAT_BINDINGS_KEY = 'dsh-sidebar:v1:native-sidechat-bindings'
const MAX_BINDINGS = 512

export interface SidechatBinding {
  sessionId: string
  contentId: string
  threadId: string
  title: string
}

/** Only identity and a display label are persisted; never transcripts/drafts. */
export function createSidechatBindings() {
  const rows = new Map<string, SidechatBinding>()
  const keyOf = (sessionId: string, contentId: string): string => JSON.stringify([sessionId, contentId])
  let loaded = false
  const trim = (): void => {
    while (rows.size > MAX_BINDINGS) rows.delete(rows.keys().next().value!)
  }
  const load = (): void => {
    if (loaded) return
    loaded = true
    try {
      const value: unknown = JSON.parse(localStorage.getItem(SIDECHAT_BINDINGS_KEY) ?? '[]')
      if (!Array.isArray(value)) return
      for (const row of value.slice(-MAX_BINDINGS)) {
        if (row === null || typeof row !== 'object') continue
        const { sessionId, contentId, threadId, title } = row as Partial<SidechatBinding>
        if (typeof sessionId !== 'string' || !sessionId || typeof contentId !== 'string'
          || !contentId.startsWith('sidebar://sidechat') || typeof threadId !== 'string'
          || !threadId || typeof title !== 'string') continue
        rows.set(keyOf(sessionId, contentId), { sessionId, contentId, threadId, title })
      }
    } catch { /* Denied/corrupt storage must not prevent new conversations. */ }
  }
  const save = (): void => {
    trim()
    try { localStorage.setItem(SIDECHAT_BINDINGS_KEY, JSON.stringify([...rows.values()])) } catch { /* best effort */ }
  }
  return {
    get(sessionId: string, contentId: string): SidechatBinding | undefined {
      load()
      return rows.get(keyOf(sessionId, contentId))
    },
    set(sessionId: string, contentId: string, threadId: string, title: string): void {
      load()
      const key = keyOf(sessionId, contentId)
      const previous = rows.get(key)
      if (previous?.threadId === threadId && previous.title === title) return
      rows.delete(key)
      rows.set(key, { sessionId, contentId, threadId, title })
      save()
    },
    delete(sessionId: string, contentId: string): void {
      load()
      if (rows.delete(keyOf(sessionId, contentId))) save()
    },
  }
}
