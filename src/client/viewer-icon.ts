import type { ReactNode } from 'react'
import type { BetterSidebarService, FileViewerDescriptor } from './service.ts'

/** Render a descriptor icon at the requested file-chrome size. */
export function renderViewerIcon(
  icon: FileViewerDescriptor['icon'],
  size: number,
): ReactNode {
  return typeof icon === 'function' ? icon(size) : icon ?? null
}

/** Resolve the registered viewer for a path and render its icon. */
export function viewerIconForPath(
  service: Pick<BetterSidebarService, 'matchFileViewer'> | undefined,
  path: string,
  size: number,
): ReactNode {
  return renderViewerIcon(service?.matchFileViewer(path)?.icon, size)
}
