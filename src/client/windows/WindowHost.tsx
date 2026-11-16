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
import { Component, useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { IconChevronLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconButton } from '../ui/index.ts'
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

interface RetainedSurfaceProps {
  readonly target: HTMLDivElement
  readonly id: string
  readonly surface: WindowView['surface']
  readonly destination: HTMLElement | undefined
  readonly children: ReactNode
  readonly onPlaced: () => void
}

/**
 * DOM identity does not retain a browser layout box: ordinary append detaches
 * a subtree and can reset its scroll offsets. Snapshot BEFORE React changes
 * the frame's docked styles, then restore after its final parent is attached.
 * A parent layout effect/cleanup is too late: child DOM mutations precede it.
 */
class RetainedSurface extends Component<RetainedSurfaceProps> {
  private readonly scroll = new Map<HTMLElement, { top: number; left: number }>()

  private relocating(previous: RetainedSurfaceProps): boolean {
    return previous.surface !== this.props.surface || previous.destination !== this.props.destination
  }

  getSnapshotBeforeUpdate(previous: RetainedSurfaceProps): HTMLElement | null {
    if (!this.relocating(previous)) return null
    const { target } = this.props
    // A queued/temporarily removed destination has no layout. Its zero cannot
    // replace the last connected snapshot while the native body mounts again.
    if (!target.isConnected) return null
    for (const node of this.scroll.keys()) {
      if (!target.contains(node)) this.scroll.delete(node)
    }
    for (const node of [target, ...target.querySelectorAll<HTMLElement>('*')]) {
      const top = node.scrollTop
      const left = node.scrollLeft
      if (top !== 0 || left !== 0 || (this.scroll.has(node) && (node.clientHeight > 0 || node.clientWidth > 0))) {
        this.scroll.set(node, { top, left })
      }
    }
    const active = document.activeElement
    return active instanceof HTMLElement && target.contains(active) ? active : null
  }

  private place(active: HTMLElement | null): void {
    const { target, id, surface, destination } = this.props
    target.className = css.surfaceTarget ?? ''
    target.dataset.windowOwner = id
    target.dataset.windowSurfaceTarget = id
    target.dataset.windowSurface = surface
    if (destination === undefined) target.remove()
    else if (target.parentElement !== destination) destination.append(target)
    if (!target.isConnected) return
    for (const [node, position] of this.scroll) {
      if (!target.contains(node)) continue
      node.scrollTop = position.top
      node.scrollLeft = position.left
    }
    if (active?.isConnected && document.activeElement !== active) active.focus({ preventScroll: true })
    this.props.onPlaced()
  }

  componentDidMount(): void { this.place(null) }
  componentDidUpdate(previous: RetainedSurfaceProps, _state: unknown, active: HTMLElement | null): void {
    if (this.relocating(previous)) this.place(active)
  }
  componentWillUnmount(): void { this.props.target.remove() }
  render(): ReactNode { return this.props.children }
}

/** One open window: shell + every mounted navigation page. */
function WindowFrame(props: {
  host: WindowHostController
  formats: FormatRendererRegistry
  view: WindowView
}): ReactNode {
  const { host, formats, view } = props
  const id = view.id
  // The portal container is minted once. Only its DOM parent changes; React
  // sees the same portal target and keeps every page/renderer/input mounted.
  const [target] = useState(() => document.createElement('div'))
  const close = useCallback((): void => { host.finishClose(id) }, [host, id])
  const confirmClose = useCallback((): Promise<boolean> => host.confirmClose(id), [host, id])
  const changeBox = useCallback((box: WindowView['box']): void => { host.setBox(id, box) }, [host, id])
  const changeMaximized = useCallback((maximized: boolean): void => { host.setMaximized(id, maximized) }, [host, id])
  const back = useCallback((): void => { host.popPage(id) }, [host, id])
  const placed = useCallback((): void => { host.completeSurfaceMove(id) }, [host, id])

  return (
    <RetainedSurface target={target} id={id} surface={view.surface}
      destination={view.surface === 'floating' ? document.body : view.sidebarTarget} onPlaced={placed}>
    <FloatingWindow
      title={view.title}
      portalTarget={target}
      docked={view.surface === 'sidebar'}
      onDock={view.canDock ? () => { host.setSurface(id, 'sidebar') } : undefined}
      onFloat={() => { host.setSurface(id, 'floating') }}
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
          <IconButton
            size="sm"
            icon={<IconChevronLeftOutlineRegular size={14} />}
            label={t('windowBack')}
            title={t('windowBack')}
            onClick={back}
          />
        )
        : undefined}
    >
      <div className={css.pages} data-layout={view.bodyLayout} data-window-pages data-window-owner={id}>
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
    </RetainedSurface>
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
