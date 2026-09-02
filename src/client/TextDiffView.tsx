/**
 * HEAD-vs-current text comparison for the built-in editor. HEAD stays
 * read-only while the current document is editable and synchronized back to
 * TextEditor. Heavy CodeMirror merge code stays in the existing editor lazy
 * chunk because this module is only imported by TextEditor.
 */
import { useEffect, useRef, useState } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
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

/** CodeMirror defaults to scanLimit=500, which falls back to a coarse diff
 * for long prose blocks. Keep detailed character matching useful for normal
 * source/Markdown files while bounding worst-case main-thread work. */
export const TEXT_DIFF_CONFIG = { scanLimit: 10_000, timeout: 250 } as const

export interface TextDiffViewProps {
  original: string
  current: string
  path: string
  dark: boolean
  onCurrentChange: (current: string) => void
  onSave: () => void
}

/** Shared presentation extensions for both sides of the comparison. */
function diffEditorExtensions(path: string, dark: boolean): Extension[] {
  const language = languageForPath(path)
  const theme = new CmThemeCompartment()
  return [
    EditorView.lineWrapping,
    lineNumbers(),
    cmSurfaceTheme,
    theme.of(dark),
    ...(language === null ? [] : [language]),
  ]
}

/** HEAD is an immutable baseline, never an editing target. */
function readOnlyExtensions(path: string, dark: boolean): Extension[] {
  return [
    ...diffEditorExtensions(path, dark),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
  ]
}

export function TextDiffView({ original, current, path, dark, onCurrentChange, onSave }: TextDiffViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const activeViewRef = useRef<EditorView | null>(null)
  const currentDocumentRef = useRef(current)
  const onCurrentChangeRef = useRef(onCurrentChange)
  const onSaveRef = useRef(onSave)
  const syncingExternalRef = useRef(false)
  const [layout, setLayout] = useState<TextDiffLayout>('split')
  const [collapse, setCollapse] = useState(false)
  const [chunkCount, setChunkCount] = useState(0)

  onCurrentChangeRef.current = onCurrentChange
  onSaveRef.current = onSave

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const collapseUnchanged = collapse ? { margin: 3, minSize: 4 } : undefined
    let destroy: () => void
    const editableExtensions: Extension[] = [
      ...diffEditorExtensions(path, dark),
      history(),
      EditorState.tabSize.of(2),
      EditorView.contentAttributes.of({ spellcheck: 'false' }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        const next = update.state.doc.toString()
        currentDocumentRef.current = next
        const chunks = getChunks(update.state)
        if (chunks !== null) setChunkCount(chunks.chunks.length)
        if (!syncingExternalRef.current) onCurrentChangeRef.current(next)
      }),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => { onSaveRef.current(); return true },
        },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
    ]

    if (layout === 'split') {
      const merge = new MergeView({
        a: { doc: original, extensions: readOnlyExtensions(path, dark) },
        b: { doc: currentDocumentRef.current, extensions: editableExtensions },
        parent: host,
        highlightChanges: true,
        gutter: true,
        collapseUnchanged,
        diffConfig: TEXT_DIFF_CONFIG,
      })
      activeViewRef.current = merge.b
      setChunkCount(merge.chunks.length)
      destroy = () => { merge.destroy() }
    } else {
      const view = new EditorView({
        state: EditorState.create({
          doc: currentDocumentRef.current,
          extensions: [
            ...editableExtensions,
            unifiedMergeView({
              original,
              highlightChanges: true,
              gutter: true,
              mergeControls: false,
              allowInlineDiffs: true,
              collapseUnchanged,
              diffConfig: TEXT_DIFF_CONFIG,
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
  }, [original, path, dark, layout, collapse])

  // Content may also change through the hidden primary editor (for example,
  // a host refresh or another editor surface). Update the live diff document
  // in place so external synchronization does not destroy its undo history.
  useEffect(() => {
    const view = activeViewRef.current
    currentDocumentRef.current = current
    if (view === null || view.state.doc.toString() === current) return
    syncingExternalRef.current = true
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: current } })
    } finally {
      syncingExternalRef.current = false
    }
  }, [current])

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
