import { useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { t } from './locales.ts'
import css from './RestartButton.module.css'

export interface RestartButtonProps {
  restart?: () => Promise<{ pid: number }>
  status?: (signal?: AbortSignal) => Promise<{ pid: number }>
  reload?: () => void
  sleep?: (delayMs: number) => Promise<void>
}

type RestartPhase = 'idle' | 'requesting' | 'restarting' | 'error'

const RESTART_POLL_ATTEMPTS = 150
const RESTART_DEADLINE_MS = 90000
const STATUS_TIMEOUT_MS = 2000

const defaultSleep = (delayMs: number): Promise<void> => new Promise(resolve => {
  window.setTimeout(resolve, delayMs)
})

/**
 * Persistent lower-right restart control. After the Host accepts the handoff,
 * it probes the process id until the replacement is listening, then reloads
 * the page so the user returns to the same route and session automatically.
 */
export function RestartButton({
  restart = api.hostRestart,
  status = api.hostStatus,
  reload = () => window.location.reload(),
  sleep = defaultSleep,
}: RestartButtonProps): JSX.Element {
  const [phase, setPhase] = useState<RestartPhase>('idle')
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const requestRestart = async (): Promise<void> => {
    if (phase === 'requesting' || phase === 'restarting') return
    setPhase('requesting')
    try {
      const accepted = await restart()
      if (!mounted.current) return
      setPhase('restarting')
      const deadline = Date.now() + RESTART_DEADLINE_MS
      for (let attempt = 0; attempt < RESTART_POLL_ATTEMPTS && Date.now() < deadline; attempt += 1) {
        await sleep(400)
        if (!mounted.current) return
        const controller = new AbortController()
        const timeout = window.setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS)
        try {
          const current = await status(controller.signal)
          if (current.pid !== accepted.pid) {
            reload()
            return
          }
        } catch {
          // Expected while the old listener is down and the replacement is
          // still booting; keep probing the same origin until the deadline.
        } finally {
          window.clearTimeout(timeout)
        }
      }
      throw new Error('replacement host did not become ready before the restart deadline')
    } catch (error) {
      console.error('[dsh-better-sidebar] host restart failed:', error)
      if (mounted.current) setPhase('error')
    }
  }

  const busy = phase === 'requesting' || phase === 'restarting'
  const label = phase === 'error'
    ? t('restartHostFailed')
    : busy
      ? t('restartHostStarting')
      : t('restartHost')

  return (
    <button
      type="button"
      className={css.button}
      data-phase={phase}
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={() => { void requestRestart() }}
    >
      <span className={css.icon} aria-hidden="true">↻</span>
    </button>
  )
}
