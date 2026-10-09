import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { t } from './locales.ts'

interface ChatFileMentions {
  forClosing(owner: { openFile: (path: string) => void }, sessionId: string): MarkdownFileMentions | undefined
}

/** 根据会话工作目录判定绝对 Markdown 路径，并拒绝宿主会改写的 POSIX 路径。 */
export function isAbsoluteMarkdownPath(value: string, cwd?: string): boolean {
  if (!/\.(?:md|markdown)$/i.test(value) || /[\s\p{Cc}]/u.test(value)) return false
  const windowsWorkspace = cwd !== undefined && (/^[A-Za-z]:[\\/]/.test(cwd)
    || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(cwd))
  if (value.startsWith('/')) return windowsWorkspace || !value.includes('\\')
  return windowsWorkspace && (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/.test(value))
}

/** 在宿主文件认领结果之后追加绝对 Markdown 路径入口。 */
export function markdownMentionsFor(
  owner: { openFile: (path: string) => void },
  stock: MarkdownFileMentions | undefined,
  cwd?: string,
  isActive: () => boolean = () => true,
): MarkdownFileMentions {
  return {
    resolve(value) {
      const existing = stock?.resolve(value)
      if (existing !== undefined) return existing
      if (!isAbsoluteMarkdownPath(value, cwd)) return undefined
      return { open: () => { if (isActive()) owner.openFile(value) }, label: t('openFileSide') + ': ' + value, title: value }
    },
  }
}

/** 随宿主服务生命周期注册聊天 Markdown 路径，并在释放后停止扩展认领结果。 */
export function registerChatMarkdownMentions(ctx: Context): () => Promise<void> {
  const seat = ctx.inject(['chatFileMentions'], injected => {
    const service = injected.get('chatFileMentions') as ChatFileMentions
    const original = service.forClosing
    let active = true
    const wrapped: ChatFileMentions['forClosing'] = (owner, sessionId) => {
      const stock = original.call(service, owner, sessionId)
      if (!active) return stock
      const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
      return markdownMentionsFor(owner, stock, cwd, () => active)
    }
    service.forClosing = wrapped
    return () => {
      active = false
      if (service.forClosing === wrapped) service.forClosing = original
    }
  })
  return () => seat.dispose()
}
