/**
 * The bottom workbench's expand/collapse control, registered into DSH's
 * session header utilities list (`conversation.session.header.utilities`).
 *
 * DSH 0.1.5 draws its own right-Sidebar expand button in the header's corner
 * slot (`conversation.session.header.corner`, a SINGLE slot owned by the
 * native sidebar package), so the plugin cannot take that seat. The utilities
 * list sits immediately left of it — the same row as the host's "Session
 * log" capsule — which is where a dock toggle belongs: in flow, so it never
 * overlaps host chrome and needs no absolute positioning or measurement.
 *
 * Registration goes through `slots.inject` because the declaration may not be
 * on the ledger yet at plugin activation (the ui-conversation parent entry
 * declares it); the callback re-runs if the declaration collapses and is
 * re-declared. `order: 10` places the button after the host's own utilities.
 */
import type { Context } from '../../context-types.ts'
import type { SidebarStore } from '../state.ts'
import { BottomDockToggle } from '../Sidebar.tsx'

/** Register the header toggle; returns the disposer. */
export function registerBottomToggle(ctx: Context, store: SidebarStore): () => void {
  return ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'dsh-better-sidebar:bottom-toggle',
    order: 10,
    registrant: 'dsh-better-sidebar',
  }, () => <BottomDockToggle store={store} />))
}
