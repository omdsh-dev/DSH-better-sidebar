/**
 * Carry locally owned React state into the existing persistent window host.
 * The portal keeps event/state ownership in the caller; the host supplies the
 * frame, drag/resize, maximize, Escape and close controls. No second overlay.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { BetterSidebarWindowsClientFace, WindowHandle, WindowSizePreset } from './types.ts'
import css from './hosted-window.module.css'

/** A controlled window for a task whose draft remains in its owner component. */
export function HostedWindow(props: {
  readonly windows: BetterSidebarWindowsClientFace
  readonly id: string
  readonly title: string
  readonly open: boolean
  readonly busy?: boolean
  readonly size?: WindowSizePreset
  readonly anchor?: HTMLElement | null
  readonly children: ReactNode
  onOpenChange(open: boolean): void
}): ReactNode {
  const latest = useRef(props)
  latest.current = props
  const handle = useRef<WindowHandle | null>(null)
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!props.open) return
    let active = true
    const options = latest.current
    const opened = props.windows.open({
      id: props.id,
      title: options.title,
      size: options.size ?? 'collection',
      anchor: options.anchor,
      bodyLayout: 'fill',
      content: <div ref={setTarget} className={css.body} />,
      onBeforeClose: () => !active || latest.current.busy !== true,
      onClose: () => {
        if (!active) return
        latest.current.onOpenChange(false)
      },
    })
    handle.current = opened
    return () => {
      active = false
      handle.current = null
      setTarget(null)
      void opened.close()
    }
  }, [props.windows, props.id, props.open])
  useEffect(() => {
    handle.current?.update({ title: props.title, saving: props.busy === true })
  }, [props.title, props.busy, target])
  return props.open && target !== null ? createPortal(props.children, target) : null
}
