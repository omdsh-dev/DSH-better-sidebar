/**
 * Built-in video viewer: a native `<video>` element playing the file straight
 * off the `/sidebar/file` media route. That route answers byte ranges (206),
 * which is what makes scrubbing work, and caps video with its own
 * `videoLimit` instead of the image-oriented `mediaLimit` — clips stream
 * instead of being read whole.
 *
 * Decoding is the engine's business: a container/codec the browser cannot
 * play fires `onError`, and the pane degrades to the same download-instead
 * affordance the binary viewer uses rather than leaving a dead black
 * rectangle with no way out.
 */
import { useEffect, useState } from 'react'
import { downloadUrl, type SessionScope } from './api.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

export interface VideoViewProps {
  scope: SessionScope
  path: string
  title: string
  /** The media route URL from the descriptor's `mediaUrl` fetch strategy. */
  mediaUrl?: string
}

/** One video file pane (registered as the builtin `video` viewer). */
export function VideoView({ scope, path, title, mediaUrl }: VideoViewProps) {
  const [failed, setFailed] = useState(false)
  // The pane can be reused for another path (a tab whose file changed); reset
  // the fallback so the next clip gets its own playback attempt.
  useEffect(() => { setFailed(false) }, [path])
  if (mediaUrl === undefined || failed) {
    return (
      <div className={css.editorMediaWrap} data-dsh-video-view="fallback">
        <div className={css.editorMediaFallback}>
          <span className={css.editorBinaryNotice}>{t('videoUnsupported')}</span>
          <a className={css.editorDownloadLink} href={downloadUrl(scope, path)} download>
            {t('downloadToView')}
          </a>
        </div>
      </div>
    )
  }
  return (
    <div className={css.editorMediaWrap} data-dsh-video-view="player">
      <video
        className={css.editorVideo}
        src={mediaUrl}
        controls
        preload="metadata"
        playsInline
        aria-label={title}
        onError={() => setFailed(true)}
      />
    </div>
  )
}
