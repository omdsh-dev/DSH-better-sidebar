/** Selection tasks keep their captured parent; only the initial surface is responsive. */
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { Context } from '../context-types.ts'
import { SideChatView, parkSidechatReopen } from './SideChatView.tsx'
import { isNarrowWidth } from './breakpoints.ts'
import { t } from './locales.ts'
import { sidechatSubmitKeyOf } from './prefs.ts'
import { useSessionRoot } from './use-session-root.ts'
import { useSessionScope } from './session-scope.ts'
import type { SidebarTab } from './state.ts'
import type { WindowHandle } from './windows/types.ts'

function SelectionSidechat(props: { ctx: Context; sessionId: string; threadId: string; handle(): WindowHandle }) {
  const { ctx, sessionId, threadId, handle } = props
  const [tab, setTab] = useState<SidebarTab>(() => ({ id: 'selection-side:' + threadId, type: 'sidechat', title: t('sideChat'), meta: { threadId } }))
  const service = ctx.get('betterSidebar')!
  const prefs = useSyncExternalStore(service.subscribeState, service.getSnapshot).prefs
  const cwd = useSessionRoot(ctx, sessionId)
  const scope = useSessionScope(sessionId, cwd)
  const update = useCallback((patch: Partial<SidebarTab>): void => {
    setTab(current => ({ ...current, ...patch }))
    if (patch.title !== undefined) handle().update({ title: patch.title })
  }, [handle])
  return <SideChatView ctx={ctx} scope={scope} tab={tab} visible
    submitKey={sidechatSubmitKeyOf(prefs)}
    onTabChange={update}
    onOpenThread={id => {
      if (id === threadId) return
      openSelectionSidechat(ctx, sessionId, id)
      void handle().close()
    }} />
}

export function openSelectionSidechat(ctx: Context, sessionId: string, threadId: string): void {
  const service = ctx.get('betterSidebar')!
  if (isNarrowWidth(window.innerWidth)) {
    parkSidechatReopen(threadId)
    service.openTab({ type: 'sidechat' }, { sessionId })
    return
  }
  const getHandle = (): WindowHandle => handle
  const handle = service.windows.open({
    id: 'selection-side:' + threadId,
    sessionId,
    title: t('sideChat'),
    size: 'document',
    surface: 'floating',
    dockable: false,
    bodyLayout: 'fill',
    content: <SelectionSidechat ctx={ctx} sessionId={sessionId} threadId={threadId} handle={getHandle} />,
  })
}
