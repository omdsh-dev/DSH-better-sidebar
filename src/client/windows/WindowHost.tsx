/**
 * The React host of the public window face, mounted exactly ONCE by the
 * plugin's activation (see `client/index.tsx`). It subscribes to the host
 * store's immutable snapshot and renders one {@link FloatingWindow} per open
 * window; the store owns identity/geometry/dirty/navigation, the shell owns
 * the frame and the dismissal contract.
 *
 * Navigation pages are all MOUNTED: covered pages are hidden with CSS rather
 * than unmounted, which is what lets a caller return to a search box,
 * selection or half-typed form exactly as it was left. The React tree is
 * therefore the retention mechanism — no serialized page state, no second
 * state store.
 *
 * Every page's content sits inside its own {@link RenderBoundary}: a crashing
 * third-party renderer blanks ITS page, never the sidebar, the other windows
 * or even the window's own close control (the plugin's per-surface rule).
 */
import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { Button, IconChevronLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useViewportSize } from '../breakpoints.ts'
import { FloatingWindow } from '../FloatingWindow.tsx'
import { RenderBoundary } from '../RenderBoundary.tsx'
import { ClueFormatHost, type FormatRendererRegistry } from './format-content.tsx'
import { isWindowDocumentContent, windowHostLayerKey } from './host.ts'
import type { WindowContent, WindowHostController, WindowView } from './types.ts'
import { t } from '../locales.ts'
import css from './windows.module.css'

/** Props of the single mounted host. */
export interface WindowHostProps {
  host: WindowHostController
  /** `ctx.betterSidebar.clues` — the S1 format-renderer registry. */
  formats: FormatRendererRegistry
}

/** Render one page's content (plain nodes as-is; documents through the format host). */
function pageContent(content: WindowContent, formats: FormatRendererRegistry, saving: boolean): ReactNode {
  if (!isWindowDocumentContent(content)) return <>{content}</>
  // The effective flag wins over the descriptor's own copy: the shell shows
  // exactly what the renderer receives.
  return <ClueFormatHost {...content} saving={saving} registry={formats} />
}

/** One open window: shell + every mounted navigation page. */
function WindowFrame(props: {
  host: WindowHostController
  formats: FormatRendererRegistry
  view: WindowView
}): ReactNode {
  const { host, formats, view } = props
  const id = view.id
  const close = useCallback((): void => { host.finishClose(id) }, [host, id])
  const confirmClose = useCallback((): Promise<boolean> => host.confirmClose(id), [host, id])
  const changeBox = useCallback((box: WindowView['box']): void => { host.setBox(id, box) }, [host, id])
  const changeMaximized = useCallback((maximized: boolean): void => { host.setMaximized(id, maximized) }, [host, id])
  const back = useCallback((): void => { host.popPage(id) }, [host, id])

  return (
    <FloatingWindow
      title={view.title}
      onClose={close}
      onBeforeClose={confirmClose}
      box={view.box}
      onBoxChange={changeBox}
      maximized={view.maximized}
      onMaximizeChange={changeMaximized}
      minSize={view.minSize}
      layerKey={windowHostLayerKey(id)}
      toolbar={view.actions}
      footer={view.footer}
      bodyLayout={view.bodyLayout}
      dirty={view.dirty}
      saving={view.saving}
      titleLeading={view.canGoBack
        ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<IconChevronLeftOutlineRegular size={14} />}
            aria-label={t('windowBack')}
            title={t('windowBack')}
            onClick={back}
          />
        )
        : undefined}
    >
      <div className={css.pages} data-layout={view.bodyLayout} data-window-pages>
        {view.pages.map((entry, index) => (
          <div
            key={entry.key}
            className={css.page}
            data-window-page={index === view.activeIndex ? 'active' : 'hidden'}
            data-window-page-index={index}
          >
            <RenderBoundary className={css.windowBoundary}>
              {pageContent(entry.page.content, formats, view.saving)}
            </RenderBoundary>
          </div>
        ))}
      </div>
    </FloatingWindow>
  )
}

/**
 * Mount the public window host once. Every open window is portaled by
 * {@link FloatingWindow}; this component contributes no page wrapper of its
 * own beyond the per-window frame.
 */
export function WindowHost(props: WindowHostProps): ReactNode {
  const { host, formats } = props
  const subscribe = useCallback((listener: () => void) => host.subscribe(listener), [host])
  const getSnapshot = useCallback(() => host.getSnapshot(), [host])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const { width, height } = useViewportSize()

  // A viewport change re-clamps every open window (never moves one off
  // screen); the maximized window follows the new viewport. An INJECTED
  // viewport (tests / exotic hosts) is authoritative — the mounted host must
  // not overwrite it with the browser's own metrics.
  useEffect(() => {
    if (!host.followsLiveViewport) return
    host.setViewport({ width, height })
  }, [host, width, height])

  return (
    <>
      {snapshot.windows.map(view => (
        <WindowFrame key={view.id} host={host} formats={formats} view={view} />
      ))}
    </>
  )
}
