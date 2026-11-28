import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { HTMLAttributes } from 'react'
import type { Context } from '../context-types.ts'
import { t } from './locales.ts'

/** The gesture props the host attaches to one resolved file mention. */
type FileMentionTriggerProps = Pick<HTMLAttributes<HTMLElement>, 'onContextMenu' | 'onKeyDown' | 'tabIndex'>

/**
 * The optional Host provider consumed by Chat. DSH 0.2.2 added the third
 * argument; it carries the ordinary file gesture binding (the file context
 * menu), so a wrapper MUST forward it to the stock provider even when it only
 * wants to add matches.
 */
interface ChatFileMentions {
  forClosing(
    owner: { openFile: (path: string) => void },
    sessionId: string,
    getFileTriggerProps?: (path: string) => FileMentionTriggerProps,
  ): MarkdownFileMentions | undefined
}

/** 根据会话工作目录判定绝对 Markdown 路径，并拒绝宿主会改写的 POSIX 路径。 */
export function isAbsoluteMarkdownPath(value: string, cwd?: string): boolean {
  if (!/\.(?:md|markdown)$/i.test(value) || /[\s\p{Cc}]/u.test(value)) return false
  const windowsWorkspace = cwd !== undefined && (/^[A-Za-z]:[\\/]/.test(cwd)
    || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(cwd))
  if (value.startsWith('/')) return windowsWorkspace || !value.includes('\\')
  return windowsWorkspace && (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/.test(value))
}

/** Resolve the host gesture binding without letting a host refusal break the click path. */
function triggerPropsOf(
  getFileTriggerProps: ((path: string) => FileMentionTriggerProps) | undefined,
  path: string,
): FileMentionTriggerProps | undefined {
  if (getFileTriggerProps === undefined) return undefined
  try {
    return getFileTriggerProps(path)
  } catch {
    return undefined
  }
}

/** 在宿主文件认领结果之后追加绝对 Markdown 路径入口。 */
export function markdownMentionsFor(
  owner: { openFile: (path: string) => void },
  stock: MarkdownFileMentions | undefined,
  cwd?: string,
  isActive: () => boolean = () => true,
  getFileTriggerProps?: (path: string) => FileMentionTriggerProps,
): MarkdownFileMentions {
  return {
    resolve(value) {
      const existing = stock?.resolve(value)
      if (existing !== undefined) return existing
      if (!isAbsoluteMarkdownPath(value, cwd)) return undefined
      const contextMenuProps = triggerPropsOf(getFileTriggerProps, value)
      return {
        open: () => { if (isActive()) owner.openFile(value) },
        label: t('openFileSide') + ': ' + value,
        title: value,
        ...(contextMenuProps === undefined ? {} : { contextMenuProps }),
      }
    },
  }
}

/** 随宿主服务生命周期注册聊天 Markdown 路径，并在释放后停止扩展认领结果。 */
export function registerChatMarkdownMentions(ctx: Context): () => Promise<void> {
  const seat = ctx.inject(['chatFileMentions'], injected => {
    const service = injected.get('chatFileMentions') as ChatFileMentions
    const original = service.forClosing
    let active = true
    const wrapped: ChatFileMentions['forClosing'] = (owner, sessionId, getFileTriggerProps) => {
      // Forward the third argument even when this extension is inactive:
      // dropping it would strip the host's own file context menu.
      const stock = original.call(service, owner, sessionId, getFileTriggerProps)
      if (!active) return stock
      const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
      return markdownMentionsFor(owner, stock, cwd, () => active, getFileTriggerProps)
    }
    service.forClosing = wrapped
    return () => {
      active = false
      if (service.forClosing === wrapped) service.forClosing = original
    }
  })
  return () => seat.dispose()
}
