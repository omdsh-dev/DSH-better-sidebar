/**
 * The editor tab host: resolves a file's previewer through the sidebar
 * registry (`matchFileViewer`), fetches bytes per the matched viewer's
 * fetch strategy, and renders its component — or the shared download pane
 * when nothing can render the file. The header shows the file title; the
 * editable code/markdown viewers render their own toolbar below it.
 *
 * The strategy dispatch is pure (planFirstMatch / planFsReadOutcome in
 * editor-load.ts); this component only wires it to the host APIs.
 */
import { useEffect, useState } from 'react'
import { createElement } from 'react'
import {
  IconCopyOutline16, IconEllipsisOutline16, IconFolderOpenOutline16, IconRightUpOutline16, Menu, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { api, mediaUrl, type SessionScope } from './api.ts'
import { BinaryDownload } from './binary-download.tsx'
import { planFirstMatch, planFsReadOutcome, type EditorLoadAction } from './editor-load.ts'
import { t } from './locales.ts'
import { relativeTo } from './paths.ts'
import type { FileViewerDescriptor } from './service.ts'
import type { SidebarStore } from './state.ts'
import css from './sidebar.module.css'

type EditorLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; viewer: FileViewerDescriptor; content?: string; truncated?: boolean; mediaUrl?: string; customData?: unknown }
  | { status: 'binary' }

export function EditorHost(props: { ctx: Context; store: SidebarStore; scope: SessionScope; path: string; title: string }) {
  const { ctx, store, scope, path, title } = props
  const [load, setLoad] = useState<EditorLoad>({ status: 'loading' })
  /** The "⋯" header menu open state (file actions: copy paths / open externally). */
  const [menuOpen, setMenuOpen] = useState(false)
  /** Transient error from a failed "open in file manager / default app" action. */
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoad({ status: 'loading' })
    const mediaUrlOf = (): string => mediaUrl(scope, path)
    const apply = (action: EditorLoadAction): void => {
      if (cancelled) return
      switch (action.kind) {
        case 'binary':
          setLoad({ status: 'binary' })
          return
        case 'render':
          setLoad({
            status: 'ready',
            viewer: action.viewer,
            content: action.content,
            truncated: action.truncated,
            mediaUrl: action.mediaUrl,
            customData: action.customData,
          })
          return
        case 'customLoad':
          void action.viewer.load?.(path, scope).then((data) => {
            if (cancelled) return
            setLoad({ status: 'ready', viewer: action.viewer, customData: data })
          }).catch((error: unknown) => {
            if (cancelled) return
            setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          })
          return
        case 'fetchFsRead':
          api.fsRead(scope, path).then((result) => {
            if (cancelled) return
            // Binary reads carry the head bytes for the detect re-match.
            const outcome = planFsReadOutcome(action.viewer, {
              binary: result.kind === 'binary',
              content: result.kind === 'text' ? result.content : '',
              truncated: result.truncated,
              head: result.kind === 'binary' ? result.head : undefined,
            }, (head) => ctx.betterSidebar?.matchFileViewer(path, head), mediaUrlOf)
            apply(outcome)
          }).catch((error: unknown) => {
            if (cancelled) return
            setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          })
          return
      }
    }
    apply(planFirstMatch(ctx.betterSidebar?.matchFileViewer(path), mediaUrlOf))
    return () => { cancelled = true }
  }, [scope.sessionId, scope.cwd, path, ctx])

  /** Reveal/open this file in the OS file manager, or open it with the default app. */
  const openExternal = async (action: 'explorer' | 'default'): Promise<void> => {
    try {
      if (action === 'explorer') await api.fsOpenInExplorer(scope, path)
      else await api.fsOpenDefault(scope, path)
      setActionError(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className={css.editor}>
      <div className={css.editorHeader}>
        <span className={css.editorTitle} title={path}>{title}</span>
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          align="end"
          items={[
            { id: 'copy-relative', label: t('copyRelative'), icon: <IconCopyOutline16 size={14} /> },
            { id: 'copy-absolute', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={14} /> },
            { type: 'separator', id: 'sep-open' },
            { id: 'open-explorer', label: t('revealInExplorer'), icon: <IconFolderOpenOutline16 size={14} /> },
            { id: 'open-default', label: t('openWithDefaultApp'), icon: <IconRightUpOutline16 size={14} /> },
          ]}
          onSelect={(id) => {
            setMenuOpen(false)
            if (id === 'copy-relative') {
              void writeClipboard(relativeTo(scope.cwd ?? '', path))
              return
            }
            if (id === 'copy-absolute') {
              void writeClipboard(path)
              return
            }
            if (id === 'open-explorer') {
              void openExternal('explorer')
              return
            }
            if (id === 'open-default') {
              void openExternal('default')
            }
          }}
          anchor={(
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('moreActions')}
              title={t('moreActions')}
              onClick={(event) => {
                event.stopPropagation()
                setMenuOpen(open => !open)
              }}
            >
              <IconEllipsisOutline16 />
            </button>
          )}
        />
      </div>
      {actionError !== null && <div className={css.editorError}>{actionError}</div>}
      {load.status === 'loading' && <div className={css.editorPlaceholder}>{t('loading')}</div>}
      {load.status === 'error' && <div className={css.editorError}>{load.message}</div>}
      {load.status === 'binary' && <BinaryDownload scope={scope} path={path} />}
      {load.status === 'ready' && createElement(load.viewer.component, {
        ctx, store, scope, path, title,
        viewerId: load.viewer.id,
        content: load.content,
        truncated: load.truncated,
        mediaUrl: load.mediaUrl,
        customData: load.customData,
      })}
    </div>
  )
}
