/**
 * The markdown-native visual editor. MDXEditor owns the rich document model
 * and serializes every edit back to Markdown; this wrapper fixes the plugin
 * set, keeps the heavy dependency inside the editor lazy chunk, and exposes
 * only the imperative surface TextEditor needs for refresh/save.
 */
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  ChangeCodeMirrorLanguage,
  CodeToggle,
  ConditionalContents,
  CreateLink,
  InsertCodeBlock,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  MDXEditor,
  type MDXEditorMethods,
  Separator,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  frontmatterPlugin,
  headingsPlugin,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
} from '@mdxeditor/editor'
import '@mdxeditor/editor/style.css'
import css from './sidebar.module.css'

export interface MarkdownVisualEditorHandle {
  getMarkdown(): string
  setMarkdown(markdown: string): void
}

export const MarkdownVisualEditor = forwardRef<MarkdownVisualEditorHandle, {
  markdown: string
  onChange: (markdown: string, initialMarkdownNormalize: boolean) => void
  onError: (message: string) => void
  imagePreviewHandler: (source: string) => Promise<string>
}>(function MarkdownVisualEditor(props, forwardedRef) {
  const { markdown, onChange, onError, imagePreviewHandler } = props
  const editorRef = useRef<MDXEditorMethods>(null)

  useImperativeHandle(forwardedRef, () => ({
    getMarkdown: () => editorRef.current?.getMarkdown() ?? markdown,
    setMarkdown: (next) => { editorRef.current?.setMarkdown(next) },
  }), [markdown])

  const plugins = useMemo(() => [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    imagePlugin({ imagePreviewHandler }),
    tablePlugin(),
    frontmatterPlugin(),
    codeBlockPlugin({ defaultCodeBlockLanguage: '' }),
    codeMirrorPlugin({
      autoLoadLanguageSupport: true,
      codeBlockLanguages: {
        '': 'Plain text',
        bash: 'Bash',
        css: 'CSS',
        go: 'Go',
        html: 'HTML',
        java: 'Java',
        javascript: 'JavaScript',
        json: 'JSON',
        markdown: 'Markdown',
        mermaid: 'Mermaid',
        php: 'PHP',
        python: 'Python',
        rust: 'Rust',
        sql: 'SQL',
        typescript: 'TypeScript',
        xml: 'XML',
        yaml: 'YAML',
      },
    }),
    markdownShortcutPlugin(),
    toolbarPlugin({
      toolbarContents: () => (
        <ConditionalContents options={[
          {
            when: editor => editor?.editorType === 'codeblock',
            contents: () => (
              <div className={css.markdownToolbarActions}>
                <ChangeCodeMirrorLanguage />
                <Separator />
                <UndoRedo />
              </div>
            ),
          },
          {
            fallback: () => (
              <div className={css.markdownToolbarActions}>
                <UndoRedo />
                <Separator />
                <BlockTypeSelect />
                <BoldItalicUnderlineToggles />
                <CodeToggle />
                <Separator />
                <ListsToggle />
                <CreateLink />
                <InsertImage />
                <InsertTable />
                <InsertCodeBlock />
                <InsertThematicBreak />
              </div>
            ),
          },
        ]} />
      ),
    }),
  ], [imagePreviewHandler])

  return (
    <MDXEditor
      ref={editorRef}
      className={`mdxeditor-full-height ${css.markdownVisualRoot}`}
      contentEditableClassName={css.markdownVisualContent}
      markdown={markdown}
      plugins={plugins}
      spellCheck
      trim={false}
      onChange={onChange}
      onError={({ error }) => { onError(error) }}
    />
  )
})
