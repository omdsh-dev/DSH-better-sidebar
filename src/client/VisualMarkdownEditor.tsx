import { useEffect, useRef, useState } from 'react'
import { Editor, defaultValueCtx, rootCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import css from './sidebar.module.css'

export interface VisualMarkdownEditorProps {
  initialMarkdown: string
  onChange: (markdown: string) => void
  loadingLabel: string
  errorLabel: string
}

/** Milkdown-powered rendered GFM editing surface (loaded in its own chunk). */
export function VisualMarkdownEditor(props: VisualMarkdownEditorProps) {
  const { initialMarkdown, onChange, loadingLabel, errorLabel } = props
  const rootRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  onChangeRef.current = onChange

  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    let cancelled = false
    let editor: Editor | undefined
    setState('loading')
    const instance = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        ctx.set(defaultValueCtx, initialMarkdown)
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, previous) => {
          if (markdown !== previous) onChangeRef.current(markdown)
        })
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
    void instance.create().then((created) => {
      editor = created
      if (cancelled) {
        void created.destroy()
        return
      }
      setState('ready')
    }).catch(() => {
      if (!cancelled) setState('error')
    })
    return () => {
      cancelled = true
      if (editor !== undefined) void editor.destroy()
    }
  }, [initialMarkdown])

  return (
    <div className={css.editorVisual}>
      {state === 'loading' && <div className={css.editorPlaceholder}>{loadingLabel}</div>}
      {state === 'error' && <div className={css.editorError}>{errorLabel}</div>}
      <div ref={rootRef} className={state === 'ready' ? undefined : css.editorVisualPending} />
    </div>
  )
}
