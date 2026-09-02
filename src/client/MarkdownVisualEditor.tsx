/**
 * The markdown-native visual editor. MDXEditor owns the rich document model
 * and serializes every edit back to Markdown; this wrapper fixes the plugin
 * set, keeps the heavy dependency inside the editor lazy chunk, and exposes
 * only the imperative surface TextEditor needs for refresh/save.
 */
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
import clsx from 'clsx'
import { useCell } from '@mdxeditor/gurx'
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
  diffSourcePlugin,
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
  viewMode$,
} from '@mdxeditor/editor'
import '@mdxeditor/editor/style.css'
import { t } from './locales.ts'
import css from './sidebar.module.css'

export interface MarkdownVisualEditorHandle {
  getMarkdown(): string
  setMarkdown(markdown: string): void
}

/** Source/preview belongs to the content toolbar, not the file header. The
 *  MDX realm remains the single document owner in both modes. */
function MarkdownModeToggle() {
  const [mode, setMode] = useCell(viewMode$)
  return (
    <div
      className={clsx(css.editorModeToggle, css.markdownModeToggle)}
      role="group"
      aria-label={t('editorContentMode')}
    >
      <button
        type="button"
        className={clsx(css.editorModeButton, mode === 'source' && css.editorModeActive)}
        aria-pressed={mode === 'source'}
        onClick={() => { setMode('source') }}
      >
        {t('source')}
      </button>
      <button
        type="button"
        className={clsx(css.editorModeButton, mode === 'rich-text' && css.editorModeActive)}
        aria-pressed={mode === 'rich-text'}
        onClick={() => { setMode('rich-text') }}
      >
        {t('preview')}
      </button>
    </div>
  )
}

function MarkdownToolbarContents() {
  const [mode] = useCell(viewMode$)
  return (
    <>
      <div
        className={clsx(css.markdownToolbarActions, mode !== 'rich-text' && css.markdownToolbarActionsHidden)}
        data-markdown-toolbar-actions
        data-hidden={mode !== 'rich-text'}
        aria-hidden={mode !== 'rich-text'}
      >
        <ConditionalContents options={[
          {
            when: editor => editor?.editorType === 'codeblock',
            contents: () => (
              <>
                <ChangeCodeMirrorLanguage />
                <Separator />
                <UndoRedo />
              </>
            ),
          },
          {
            fallback: () => (
              <>
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
              </>
            ),
          },
        ]} />
      </div>
      <MarkdownModeToggle />
    </>
  )
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
    diffSourcePlugin({ viewMode: 'rich-text' }),
    toolbarPlugin({
      toolbarContents: MarkdownToolbarContents,
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
