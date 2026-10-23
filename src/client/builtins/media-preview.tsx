/**
 * Inline media preview — the pane behind an opened `.mp4` (or `.mp3`).
 *
 * Why this exists: without a viewer for these extensions the open fell through
 * to the `code` catch-all, whose `fsRead` strategy classifies any NUL-carrying
 * file as binary and lands on the download pane — the only way to watch a clip
 * the agent just produced was to download it and leave the GUI.
 *
 * The player is the BARE element on the media route: `/sidebar/file` answers a
 * media container with its real content type (see `MEDIA_TYPES` in
 * `src/index.ts`) and honours `Range` (see `file-stream.ts`), so the element
 * streams from disk and seeks natively. Nothing here copies bytes into a Blob
 * or buffers the file, which is what keeps a 10-minute clip as cheap as a
 * 10-second one.
 *
 * The transport is chosen by container, not by a user setting: an audio file's
 * whole UI IS its transport, while a video needs the stage for the picture.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { downloadUrl } from '../api.ts'
import type { FileViewerProps } from '../service.ts'
import { t } from '../locales.ts'
import css from '../sidebar.module.css'

/** Extensions rendered with an `<audio>` transport instead of a video stage. */
export const AUDIO_EXTS: readonly string[] = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus']

/** Lowercase extension without its dot; `''` for a path that carries none. */
function extOf(path: string): string {
  const match = /\.([A-Za-z0-9]+)$/u.exec(path)
  return match?.[1]?.toLowerCase() ?? ''
}

/** Whether this path belongs on the audio transport. */
export function mediaIsAudio(path: string): boolean {
  return AUDIO_EXTS.includes(extOf(path))
}

export function MediaPreview(props: FileViewerProps): ReactNode {
  const { scope, path, mediaUrl } = props
  const [failed, setFailed] = useState(false)
  const onError = (): void => { setFailed(true) }
  return (
    <div className={css.mediaPreview}>
      {mediaUrl === undefined || failed
        ? <div className={css.mediaPreviewNotice}>{t('mediaUnplayable')}</div>
        : mediaIsAudio(path)
          ? (
              <audio
                className={css.mediaPreviewAudio}
                src={mediaUrl}
                controls
                preload="metadata"
                onError={onError}
              />
            )
          : (
              <video
                className={css.mediaPreviewVideo}
                src={mediaUrl}
                controls
                playsInline
                preload="metadata"
                onError={onError}
              />
            )}
      {/* The download escape hatch stays for every state: a container the
          bundled ffmpeg cannot decode (an exotic codec, a damaged file) must
          still end in a file the user can take elsewhere. */}
      <a className={css.editorDownloadLink} href={downloadUrl(scope, path)} download>
        {t('download')}
      </a>
    </div>
  )
}
