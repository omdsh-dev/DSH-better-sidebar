import { useEffect, useRef } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { t } from './locales.ts'
import css from './sidebar.module.css'

export interface WritingEditorProps {
  value: string
  onChange(value: string): void
  onSave(): void
}

interface CommandButtonProps {
  label: string
  active?: boolean
  children: string
  run(editor: Editor): void
  editor: Editor
}

/** 执行写作编辑器的格式命令，并保留当前文本选区。 */
function CommandButton({ label, active, children, run, editor }: CommandButtonProps) {
  return <button type="button" className={css.writingToolButton} data-active={active || undefined} aria-label={label} title={label} onMouseDown={(event) => { event.preventDefault(); run(editor) }}>{children}</button>
}

/** 在 Markdown 草稿上提供可视化写作和格式工具。 */
export function WritingEditor({ value, onChange, onSave }: WritingEditorProps) {
  const emitted = useRef(value)
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit, Markdown],
    content: value,
    contentType: 'markdown',
    editorProps: {
      attributes: { class: css.writingProse ?? '', spellcheck: 'true' },
      handleKeyDown: (_view, event) => {
        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return false
        event.preventDefault()
        saveRef.current()
        return true
      },
    },
    onUpdate: ({ editor: current }) => {
      const markdown = current.getMarkdown()
      emitted.current = markdown
      onChange(markdown)
    },
  })

  useEffect(() => {
    if (editor === null || editor.isFocused || value === emitted.current) return
    emitted.current = value
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
  }, [editor, value])

  if (editor === null) return <div className={css.editorPlaceholder}>{t('loading')}</div>

  return <div className={css.writingEditor}>
    <div className={css.writingToolbar} role="toolbar" aria-label={t('writing')}>
      <CommandButton editor={editor} label={t('writingHeading')} active={editor.isActive('heading', { level: 1 })} run={current => { current.chain().focus().toggleHeading({ level: 1 }).run() }}>H1</CommandButton>
      <CommandButton editor={editor} label={t('writingBold')} active={editor.isActive('bold')} run={current => { current.chain().focus().toggleBold().run() }}>B</CommandButton>
      <CommandButton editor={editor} label={t('writingItalic')} active={editor.isActive('italic')} run={current => { current.chain().focus().toggleItalic().run() }}>I</CommandButton>
    </div>
    <div className={css.writingScroll}><EditorContent editor={editor} /></div>
  </div>
}
