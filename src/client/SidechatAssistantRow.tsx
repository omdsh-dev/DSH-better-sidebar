/** Keep the host Markdown renderer as the default; a registered consumer may
 * enhance only this real row root while it is visible and durably identified. */
import { useLayoutEffect, useRef } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownTextProps, type MarkdownCopyLabels } from './markdown-labels.tsx'
import { attachSidechatSurface, isSidechatSurfaceIdentity } from './sidechat-surface.ts'
import type { SidechatTranscriptRow } from './sidechat-transcript.ts'
import css from './SideChatView.module.css'

export interface SidechatRowSurfaceBinding {
  service: object | undefined
  threadId: string | undefined
  visible: boolean
  sendPrompt: (text: string) => Promise<void>
}

export function SidechatAssistantRow(props: {
  row: Extract<SidechatTranscriptRow, { kind: 'assistant' }>
  labels: MarkdownCopyLabels
  rewrite: (text: string) => string
  surface: SidechatRowSurfaceBinding
}): React.ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { row, labels, rewrite, surface } = props
  const { service, threadId, visible, sendPrompt } = surface
  const renderedText = rewrite(row.text)
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!visible || !row.settled || root === null || threadId === undefined
      || row.contentBlockIndex === undefined
      || !isSidechatSurfaceIdentity(threadId, row.seq, row.contentBlockIndex)) return
    return attachSidechatSurface(service, {
      root,
      source: 'dsh-better-sidebar/sidechat',
      threadId,
      eventSeq: row.seq,
      contentBlockIndex: row.contentBlockIndex,
      text: row.text,
      sendPrompt,
    })
  }, [service, threadId, visible, sendPrompt, row.settled, row.seq, row.contentBlockIndex, row.text, renderedText])
  return (
    <div ref={rootRef} className={css.sidechatAssistant} data-genui-surface="dsh-better-sidebar/sidechat">
      <MarkdownText {...markdownTextProps(renderedText, labels)} />
    </div>
  )
}
