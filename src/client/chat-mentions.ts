import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { t } from './locales.ts'

interface ChatFileMentions {
  forClosing(owner: { openFile: (path: string) => void }, sessionId: string): MarkdownFileMentions | undefined
}

/** 判定内联代码是否为完整的绝对 Markdown 文件路径。 */
export function isAbsoluteMarkdownPath(value: string): boolean {
  if (!/\.(?:md|markdown)$/i.test(value) || /[\s\p{Cc}]/u.test(value)) return false
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/.test(value)
}

/** 在宿主文件认领结果之后追加绝对 Markdown 路径入口。 */
export function markdownMentionsFor(owner: { openFile: (path: string) => void }, stock: MarkdownFileMentions | undefined): MarkdownFileMentions {
  return {
    resolve(value) {
      const existing = stock?.resolve(value)
      if (existing !== undefined) return existing
      if (!isAbsoluteMarkdownPath(value)) return undefined
      return { open: () => { owner.openFile(value) }, label: t('openFileSide') + ': ' + value, title: value }
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
      return active ? markdownMentionsFor(owner, stock) : stock
    }
    service.forClosing = wrapped
    return () => {
      active = false
      if (service.forClosing === wrapped) service.forClosing = original
    }
  })
  return () => seat.dispose()
}
