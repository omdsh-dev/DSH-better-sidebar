/** One source's existing install/authorization page, shared by browse and settings. */
import { createElement } from 'react'
import type { ClueSourceDescriptor, ClueSourceDisplayDescriptor } from '../../../clues/types.ts'
import type { BetterSidebarWindowsClientFace, WindowHandle } from '../../windows/types.ts'
import type { ClueRuntimeApi } from '../runtime-api.ts'
import { SourceConfigPage } from '../settings/config.tsx'
import { cluePermissionPreferences } from '../settings/permission-preferences.ts'
import { sourceDisplayName } from '../settings/sources.tsx'
import { t } from '../../locales.ts'

export function openClueSourceConfigWindow(options: {
  windows: BetterSidebarWindowsClientFace
  source: ClueSourceDescriptor
  display?: ClueSourceDisplayDescriptor
  runtime?: ClueRuntimeApi
  initialAction?: 'install'
  onClose?(): void
}): WindowHandle {
  const { source } = options
  const name = sourceDisplayName(source, options.display)
  return options.windows.open({
    id: `clue-source:${source.sourceId}`,
    title: t('clueConfigTitle', { source: name }),
    size: 'collection',
    bodyLayout: 'fill',
    content: createElement(SourceConfigPage, {
      sourceId: source.sourceId,
      sourceName: name,
      dependencyIds: source.dependencyIds ?? [],
      permissionPreferences: cluePermissionPreferences,
      ...(source.connectionId === undefined ? {} : { connectionId: source.connectionId }),
      ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
      ...(options.initialAction === undefined ? {} : { initialAction: options.initialAction }),
    }),
    ...(options.onClose === undefined ? {} : { onClose: options.onClose }),
  })
}
