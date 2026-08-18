/** Standard cross-plugin MIME for workspace-relative local path drags. */
export const LOCAL_PATH_MIME = 'application/x-dsh-local-path'

/**
 * Publish one workspace-relative path for maintained-sidebar drag consumers.
 * text/plain keeps the gesture useful in ordinary text drop targets.
 */
export function setLocalPathDragData(dataTransfer: DataTransfer, relativePath: string): void {
  dataTransfer.effectAllowed = 'copy'
  dataTransfer.setData(LOCAL_PATH_MIME, relativePath)
  dataTransfer.setData('text/plain', relativePath)
}
