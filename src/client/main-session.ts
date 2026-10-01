/**
 * The session in the MAIN view — the conversation this side card is beside.
 *
 * dsh up to 0.1.6-alpha.1 published it on the sessions list itself, as `list.current`, and
 * `ctx.sessions.open(id)` switched it. dsh 0.1.6-alpha.2 (upstream `6830e1460d`, "own Client
 * Session generations") moved view selection out of the Session Controller — "view selection
 * remains outside the Controller" — into `ui-workspace`, which RETAINS the session it shows under
 * the reference source `mainView`; the list now carries each session's local retention counts by
 * source, and nothing named `current`. A reader of `.current` on that dsh gets `undefined` with no
 * error, and this card then shows no session at all.
 *
 * This side card follows upstream dsh across that line, so it reads both shapes: a published
 * `current` when the host still has one, else the retention. (Tracy, 0.18.1-tracy.6.)
 */

/** The fields of a list snapshot this reads — a structural slice of `SidebarSessionList`. */
export interface MainSessionListSlice {
  readonly current?: string | undefined
  readonly byId: Readonly<Record<string, { readonly retainedBy?: Readonly<Partial<Record<string, number>>> } | undefined>>
}

/**
 * @param list - a sessions list snapshot.
 * @returns the id of the session in the main view, or undefined when none is.
 */
export function mainSessionId(list: MainSessionListSlice): string | undefined {
  if (list.current !== undefined) return list.current
  for (const [id, row] of Object.entries(list.byId)) {
    if ((row?.retainedBy?.mainView ?? 0) > 0) return id
  }
  return undefined
}

/** The two faces that can switch the main view, across the same dsh line. */
export interface MainSessionSwitcher {
  readonly sessions: { open?(id: string): void }
  /** cordis `Context.get` — `uiWorkspace` is a service, never a property on the context. */
  get?(name: string): unknown
}

/**
 * Put a session in the main view: `sessions.open` where the host still has it (dsh ≤ 0.1.6-alpha.1),
 * else `uiWorkspace.openSession` (0.1.6-alpha.2, where switching belongs to `ui-workspace`).
 * A host with neither does nothing, as the optional call did before.
 * @param ctx - the plugin context.
 * @param id - the session to show.
 */
export function switchMainSession(ctx: MainSessionSwitcher, id: string): void {
  if (ctx.sessions.open !== undefined) {
    ctx.sessions.open(id)
    return
  }
  const workspace = ctx.get?.('uiWorkspace') as { openSession?: (id: string) => void } | undefined
  workspace?.openSession?.(id)
}

/**
 * Whether a tab of `sessionId` belongs to the conversation on screen (Tracy round 6, acceptance v4
 * SEND-v4-new-1): the Browser tab of a conversation left behind stays mounted, and it must neither
 * answer the Comments view nor list its comments (`comment-store.ts` `actIsFor`). A host that names no
 * main view (or a tab with no session) falls back to the tab's own visibility.
 * @param list - a sessions list snapshot, or undefined when the host gives none.
 * @param sessionId - the tab's session ('' for none).
 * @param visible - the tab is on screen.
 * @returns true when the tab's conversation is the one shown.
 */
export function conversationShown(list: MainSessionListSlice | undefined, sessionId: string, visible: boolean): boolean {
  if (list === undefined || sessionId === '') return visible
  const main = mainSessionId(list)
  return main === undefined ? visible : main === sessionId
}
