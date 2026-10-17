/**
 * The composer's "open reference" gesture (S9).
 *
 * S5 hands a clue/pack reference back to the client when the reader activates a
 * chip (`openReference`). The gesture must NOT touch the draft: it opens the
 * same S6 surfaces the Tab opens — the detail window for a clue, the pack
 * management window for a pack.
 *
 * The reference carries only the stable id, so the surface is resolved from
 * the workspace library first (one read, no remote body). Resolution is async
 * while the gesture is synchronous; the callback claims the gesture once the
 * published client service exists and a visible notice reports an unknown id.
 */
import type { Context } from '../../context-types.ts'
import type { BetterSidebarService } from '../service.ts'
import type { Clue } from '../../clues/types.ts'
import { resolveWorkspaceIdForSession } from './workspace-id.ts'
import { openClueDetailWindow } from './windows/detail.tsx'
import { openPackManagementWindow } from './windows/pack.tsx'
import { notifyClue } from './notify.ts'
import { insertClueReference, insertPackReference } from './insert.ts'
import { t } from '../locales.ts'

/** One reference activation from the composer (`kind` + stable id). */
export interface ClueReferenceGesture {
  readonly kind: 'clue' | 'pack'
  readonly id: string
  readonly sessionId: string
}

/** Read the published client service (undefined before the client applies). */
function serviceOf(ctx: Context): BetterSidebarService | undefined {
  try {
    return ctx.get('betterSidebar') as BetterSidebarService | undefined
  } catch {
    return undefined
  }
}

/** Look one clue up in its workspace library. */
async function clueOf(
  service: BetterSidebarService,
  workspaceId: string,
  clueId: string,
): Promise<Clue | undefined> {
  try {
    const library = await service.clues.api.clues(workspaceId)
    return library.clues.find(clue => clue.id === clueId)
  } catch {
    return undefined
  }
}

/**
 * Handle one composer reference activation.
 * @param ctx - the client plugin context.
 * @param gesture - the stable reference the reader activated.
 * @returns whether the plugin owns the gesture (false = leave it to the host).
 */
export function openClueReference(ctx: Context, gesture: ClueReferenceGesture): boolean {
  const service = serviceOf(ctx)
  if (service === undefined) return false
  void (async () => {
    const workspaceId = await resolveWorkspaceIdForSession(ctx, gesture.sessionId)
    if (workspaceId === undefined) {
      notifyClue(t('clueTabNoWorkspace'))
      return
    }
    if (gesture.kind === 'clue') {
      const clue = await clueOf(service, workspaceId, gesture.id)
      if (clue === undefined) {
        notifyClue(t('clueDetailMissing'))
        return
      }
      openClueDetailWindow({
        windows: service.windows,
        face: service.clues,
        workspaceId,
        target: {
          sourceId: clue.sourceId,
          typeId: clue.typeId,
          clueId: clue.id,
          title: clue.title,
        },
        sessionId: gesture.sessionId,
      })
      return
    }
    try {
      const result = await service.clues.api.packsList(workspaceId)
      const pack = result.packs.find(candidate => candidate.id === gesture.id)
      if (pack === undefined) {
        notifyClue(t('cluePackMissing'))
        return
      }
      const workspaces = (() => {
        try {
          const face = ctx.get('workspaces') as { list?: { getSnapshot?: () => unknown } } | undefined
          const snapshot = face?.list?.getSnapshot?.() as
            | { readonly items?: readonly { readonly workspaceId?: string; readonly path?: string }[] }
            | undefined
          return (snapshot?.items ?? [])
            .filter(item => typeof item.workspaceId === 'string' && item.workspaceId !== '')
            .map(item => ({ workspaceId: item.workspaceId!, title: item.path ?? item.workspaceId! }))
        } catch {
          return []
        }
      })()
      openPackManagementWindow({
        windows: service.windows,
        workspaceId,
        face: service.clues,
        workspaces: workspaces.length > 0 ? workspaces : [{ workspaceId, title: workspaceId }],
        pack,
        onInsertClue: (clueId, title) =>
          insertClueReference(ctx, gesture.sessionId, { kind: 'clue', id: clueId, title }),
        onInsertPack: packValue =>
          insertPackReference(ctx, gesture.sessionId, packValue.id, packValue.name),
        onNotice: notifyClue,
      })
    } catch {
      notifyClue(t('cluePackMissing'))
    }
  })()
  return true
}
