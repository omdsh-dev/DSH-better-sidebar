/**
 * Read-only HEAD-vs-current text comparison for the built-in editor. Heavy
 * CodeMirror merge code stays in the existing editor lazy chunk because this
 * module is only imported by TextEditor.
 */
import { useEffect, useRef, useState } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import {
  MergeView,
  getChunks,
  goToNextChunk,
  goToPreviousChunk,
  unifiedMergeView,
} from '@codemirror/merge'
import {
  LuArrowDown,
  LuArrowUp,
  LuColumns2,
  LuFoldVertical,
  LuRows3,
  LuUnfoldVertical,
} from 'react-icons/lu'
import clsx from 'clsx'
import { cmSurfaceTheme, CmThemeCompartment } from './cm-themes.ts'
import { languageForPath } from './lang.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

export type TextDiffLayout = 'split' | 'unified'

export interface TextDiffViewProps {
  original: string
  current: string
  path: string
  dark: boolean
}

/** Common read-only editor extensions for both sides of the comparison. */
function diffEditorExtensions(path: string, dark: boolean): Extension[] {
  const language = languageForPath(path)
  const theme = new CmThemeCompartment()
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.lineWrapping,
    lineNumbers(),
    cmSurfaceTheme,
    theme.of(dark),
    ...(language === null ? [] : [language]),
  ]
}

export function TextDiffView({ original, current, path, dark }: TextDiffViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const activeViewRef = useRef<EditorView | null>(null)
  const [layout, setLayout] = useState<TextDiffLayout>('split')
  const [collapse, setCollapse] = useState(false)
  const [chunkCount, setChunkCount] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const collapseUnchanged = collapse ? { margin: 3, minSize: 4 } : undefined
    let destroy: () => void

    if (layout === 'split') {
      const merge = new MergeView({
        a: { doc: original, extensions: diffEditorExtensions(path, dark) },
        b: { doc: current, extensions: diffEditorExtensions(path, dark) },
        parent: host,
        highlightChanges: true,
        gutter: true,
        collapseUnchanged,
      })
      activeViewRef.current = merge.b
      setChunkCount(merge.chunks.length)
      destroy = () => { merge.destroy() }
    } else {
      const view = new EditorView({
        state: EditorState.create({
          doc: current,
          extensions: [
            ...diffEditorExtensions(path, dark),
            unifiedMergeView({
              original,
              highlightChanges: true,
              gutter: true,
              mergeControls: false,
              collapseUnchanged,
            }),
          ],
        }),
        parent: host,
      })
      activeViewRef.current = view
      setChunkCount(getChunks(view.state)?.chunks.length ?? 0)
      destroy = () => { view.destroy() }
    }

    return () => {
      activeViewRef.current = null
      destroy()
    }
  }, [original, current, path, dark, layout, collapse])

  const navigate = (direction: 'previous' | 'next'): void => {
    const view = activeViewRef.current
    if (view === null) return
    if (direction === 'previous') goToPreviousChunk(view)
    else goToNextChunk(view)
    view.focus()
  }

  return (
    <div className={css.textDiffRoot} data-text-diff-view>
      <div className={css.textDiffToolbar} role="toolbar" aria-label={t('editorDiffToolbar')}>
        <button
          type="button"
          className={css.textDiffToolButton}
          disabled={chunkCount === 0}
          title={t('editorDiffPrevious')}
          aria-label={t('editorDiffPrevious')}
          onClick={() => { navigate('previous') }}
        >
          <LuArrowUp size={14} />
          <span>{t('editorDiffPrevious')}</span>
        </button>
        <button
          type="button"
          className={css.textDiffToolButton}
          disabled={chunkCount === 0}
          title={t('editorDiffNext')}
          aria-label={t('editorDiffNext')}
          onClick={() => { navigate('next') }}
        >
          <LuArrowDown size={14} />
          <span>{t('editorDiffNext')}</span>
        </button>
        <span className={css.textDiffToolbarDivider} aria-hidden="true" />
        <div className={css.textDiffLayoutToggle} aria-label={t('editorDiffLayout')}>
          <button
            type="button"
            className={clsx(css.textDiffToolButton, layout === 'split' && css.textDiffToolActive)}
            title={t('editorDiffSplit')}
            aria-label={t('editorDiffSplit')}
            aria-pressed={layout === 'split'}
            onClick={() => { setLayout('split') }}
          >
            <LuColumns2 size={14} />
            <span>{t('editorDiffSplit')}</span>
          </button>
          <button
            type="button"
            className={clsx(css.textDiffToolButton, layout === 'unified' && css.textDiffToolActive)}
            title={t('editorDiffUnified')}
            aria-label={t('editorDiffUnified')}
            aria-pressed={layout === 'unified'}
            onClick={() => { setLayout('unified') }}
          >
            <LuRows3 size={14} />
            <span>{t('editorDiffUnified')}</span>
          </button>
        </div>
        <button
          type="button"
          className={clsx(css.textDiffToolButton, collapse && css.textDiffToolActive)}
          title={t('editorDiffCollapse')}
          aria-label={t('editorDiffCollapse')}
          aria-pressed={collapse}
          onClick={() => { setCollapse(value => !value) }}
        >
          {collapse ? <LuUnfoldVertical size={14} /> : <LuFoldVertical size={14} />}
          <span>{t('editorDiffCollapse')}</span>
        </button>
        <span className={css.textDiffCount}>{t('editorDiffCount', { count: chunkCount })}</span>
      </div>
      <div className={clsx(css.textDiffLabels, layout === 'unified' && css.textDiffLabelsUnified)} aria-hidden="true">
        {layout === 'split'
          ? <><span>{t('editorDiffHead')}</span><span>{t('editorDiffCurrent')}</span></>
          : <span>{t('editorDiffUnifiedLabel')}</span>}
      </div>
      <div className={css.textDiffSurface} ref={hostRef} />
    </div>
  )
}
