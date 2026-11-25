/** Flow-list motion. Canvas nodes use their own coordinate-space tween. */
import autoAnimate, { type AutoAnimationPlugin, type AnimationController } from '@formkit/auto-animate'
import { useEffect, type RefObject } from 'react'

/** The library passes the previous box first, then the current box for a move. */
export const tasksFlowAnimation: AutoAnimationPlugin = (element, action, previous, current) => {
  const frames = action === 'remain' && previous !== undefined && current !== undefined
    ? [
        { transform: `translate(${previous.left - current.left}px, ${previous.top - current.top}px)` },
        { transform: 'translate(0, 0)' },
      ]
    : action === 'remove'
      ? [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-4px)' }]
      : [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }]
  return new KeyframeEffect(element, frames, { duration: 180, easing: 'ease-out' })
}

/** Attach only while both the native surface and the document are visible. */
export function useAutoAnimateRef<T extends HTMLElement>(ref: RefObject<T | null>, visible = true): void {
  useEffect(() => {
    const element = ref.current
    if (element === null || typeof Element.prototype.animate !== 'function'
      || typeof KeyframeEffect === 'undefined' || typeof Animation === 'undefined') return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let controller: AnimationController | undefined
    const sync = (): void => {
      controller?.destroy?.()
      controller = undefined
      if (visible && !document.hidden && !reduced.matches) controller = autoAnimate(element, tasksFlowAnimation)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    reduced.addEventListener('change', sync)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      reduced.removeEventListener('change', sync)
      controller?.destroy?.()
    }
  }, [ref, visible])
}
