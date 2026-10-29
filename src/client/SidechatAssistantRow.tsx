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
  /** The view's row-level prose pass (image destinations first, then local
   *  links) — takes the ROW so an unchanged row reuses its cached rewrite. */
  rewrite: (row: Extract<SidechatTranscriptRow, { text: string }>) => string
  surface: SidechatRowSurfaceBinding
}): React.ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { row, labels, rewrite, surface } = props
  const { service, threadId, visible, sendPrompt } = surface
  const renderedText = rewrite(row)
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
      {/* `streaming` keeps the host's incremental parse across chunks
          instead of restarting it; only the durable (settled) message is
          the final parse. It rides the row's own flag so a superseded
          live row never claims to be settled. */}
      <MarkdownText {...markdownTextProps(renderedText, labels)} streaming={!row.settled} />
    </div>
  )
}
