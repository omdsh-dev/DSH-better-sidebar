/**
 * The "no preview — download instead" pane: shown by the editor host when no
 * viewer can render a file (binary without a registered renderer, or the
 * `binary-download` strategy) and registered as the `binary-download` viewer
 * component so the declarative route and the host fallback share one UI.
 *
 * The pane is the shared {@link FallbackPane}; only its sentence and its way
 * out belong to this file.
 */
import type { ReactNode } from 'react'
import type { SessionScope } from './api.ts'
import { downloadUrl } from './api.ts'
import { t } from './locales.ts'
import { DownloadLink, FallbackPane } from './ui/index.ts'

export function BinaryDownload(props: { scope: SessionScope; path: string }): ReactNode {
  const { scope, path } = props
  return (
    <FallbackPane
      title={t('binaryNoPreview')}
      actions={<DownloadLink href={downloadUrl(scope, path)}>{t('downloadToView')}</DownloadLink>}
    />
  )
}
