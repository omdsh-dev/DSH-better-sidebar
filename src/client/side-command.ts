/** Client-only /side entry: use the same tab factory as the Side Chat menu. */
import type { Context } from '../context-types.ts'
import type { BetterSidebarService } from './service.ts'
import type { SidebarStore } from './state.ts'
import { t } from './locales.ts'

/** Structural subset of DSH's commandUi contribution contract. */
export interface SideCommand {
  name: string
  description(): string
  available(session: { sessionId: string }): boolean
  ui: { kind: 'action'; run(session: { sessionId: string }): void }
}

/** Build the action separately so availability and session targeting are testable. */
export function sideCommand(service: BetterSidebarService, store: SidebarStore): SideCommand {
  const available = () => !store.getSuspended() && service.getTab('sidechat') !== undefined && service.isTabEnabled('sidechat')
  return {
    name: 'side',
    description: () => t('guideDescSidechat'),
    available,
    ui: {
      kind: 'action',
      run: ({ sessionId }) => {
        if (available()) service.openTab({ type: 'sidechat' }, { sessionId })
      },
    },
  }
}

/** Wait for the optional host service; Cordis owns registration disposal. */
export function registerSideCommand(ctx: Context, service: BetterSidebarService, store: SidebarStore): () => void {
  const seat = ctx.inject(['commandUi'], scope => {
    const commands = scope.get('commandUi') as { register(command: SideCommand): () => void } | undefined
    if (commands === undefined) return
    scope.effect(() => commands.register(sideCommand(service, store)), 'dsh-better-sidebar: /side')
  })
  return () => { void seat.dispose() }
}
