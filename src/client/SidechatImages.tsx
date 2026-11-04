import { useEffect, useState } from 'react'
import type { SidechatImageOccurrence } from '../sidechat-images.ts'
import { hostRouteUrl } from './host-route-url.ts'
import { t } from './locales.ts'
import css from './SideChatView.module.css'

function SavedImage({ childId, messageId, image, visible }: { childId: string; messageId: string; image: SidechatImageOccurrence; visible: boolean }): React.ReactNode {
  const [state, setState] = useState<{ url: string } | { unavailable: true } | null>(null)
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    let url: string | undefined
    setState(null)
    const params = new URLSearchParams({ childId, messageId, blockIndex: String(image.blockIndex) })
    void fetch(hostRouteUrl(`sidebar/sidechat-image?${params}`).href, { credentials: 'include', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Image unavailable')
        const blob = await response.blob()
        if (controller.signal.aborted) return
        url = URL.createObjectURL(blob)
        setState({ url })
      }).catch(() => { if (!controller.signal.aborted) setState({ unavailable: true }) })
    return () => { controller.abort(); if (url !== undefined) URL.revokeObjectURL(url) }
  }, [childId, messageId, image.blockIndex, visible])
  if (state === null) return <span>{t('sideChatImageLoading')}</span>
  if ('unavailable' in state) return <span role="status">{t('sideChatImageUnavailable')}</span>
  return <a href={state.url} target="_blank" rel="noreferrer"><img className={css.sidechatImage} src={state.url} alt={image.name ?? t('sideChatImage')} onError={() => { setState({ unavailable: true }) }} /></a>
}

export function SidechatImages({ childId, messageId, images, visible }: { childId?: string; messageId?: string; images?: readonly SidechatImageOccurrence[]; visible: boolean }): React.ReactNode {
  if (images === undefined || images.length === 0) return null
  return <div className={css.sidechatImages}>{images.map(image => childId === undefined || messageId === undefined
    ? <span key={image.blockIndex}>{t('sideChatImageUnavailable')}</span>
    : <SavedImage key={`${messageId}:${image.blockIndex}`} childId={childId} messageId={messageId} image={image} visible={visible} />)}</div>
}
