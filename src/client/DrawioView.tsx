/** Read-only draw.io preview: decode the file, render its first page as SVG. */
import { useEffect, useState } from 'react'
import { decodeDrawio, DrawioParseError } from './drawio.ts'
import { renderDrawioSvg, type DrawioSvg } from './drawio-render.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; diagram: DrawioSvg }
  | { status: 'error'; message: string }

/**
 * Render one `.drawio` / `.dio` file. Native tabs stay mounted while parked,
 * but a preview is deterministic for its bytes; the load runs again only when
 * the path or content changes.
 */
export function DrawioView(props: { content?: string; size?: number; largeFile?: { size: number }; path: string }) {
  const { content, largeFile, path } = props
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    setLoad({ status: 'loading' })
    if (content === undefined) {
      setLoad({
        status: 'error',
        message: largeFile === undefined ? t('drawioNoContent') : t('drawioLargeFile', { size: largeFile.size }),
      })
      return
    }
    try {
      setLoad({ status: 'ready', diagram: renderDrawioSvg(decodeDrawio(content)) })
    } catch (error) {
      // Parser messages are ours and localized; a renderer failure carries
      // maxGraph internals, which belong in the console, not in the UI.
      if (!(error instanceof DrawioParseError)) {
        console.warn('[better-sidebar] drawio render failed', error)
      }
      setLoad({
        status: 'error',
        message: error instanceof DrawioParseError ? error.message : t('drawioCannotRender'),
      })
    }
  }, [content, largeFile, path])

  if (load.status === 'loading') {
    return <div className={css.editorPlaceholder}>{t('loading')}</div>
  }
  if (load.status === 'error') {
    return (
      <div className={css.editorDrawioError} data-drawio-preview="error">
        <span>{t('drawioCannotRender')}</span>
        <span className={css.editorDrawioErrorDetail}>{load.message}</span>
      </div>
    )
  }

  return (
    <div className={css.editorDrawio} data-drawio-preview="ready">
      <img
        className={css.editorDrawioImage}
        src={load.diagram.url}
        alt={t('drawioPreviewAlt', { name: path.split(/[/\\]/u).pop() ?? path })}
        width={load.diagram.width}
        height={load.diagram.height}
        decoding="async"
        draggable={false}
        referrerPolicy="no-referrer"
      />
    </div>
  )
}
