/**
 * Clues tab shell (S9).
 *
 * Resolves the session's stable workspace id (the address of every clue call)
 * and owns the page frame: header actions, the explicit empty/error states and
 * the two working regions (the pack library above, the multi-source browser
 * below). The regions live in their own modules; this file is the ONE place
 * that knows which workspace the page is looking at.
 *
 * Visibility gating: the tab body stays mounted while hidden (`keepMounted`),
 * so a hidden page performs no requests at all — the resolver and both regions
 * only run for `visible`.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { TabComponentProps } from '../../service.ts'
import { resolveWorkspaceIdForSession } from '../workspace-id.ts'
import { t } from '../../locales.ts'
import css from './clues-tab.module.css'

/** The subset of the tab component props the clue page consumes. */
export type CluesTabProps = Pick<TabComponentProps, 'ctx' | 'store' | 'scope' | 'visible'>

/** The page's workspace resolution state. */
type WorkspaceState =
  | { readonly phase: 'resolving' }
  | { readonly phase: 'ready'; readonly workspaceId: string }
  | { readonly phase: 'missing' }

/** The tab body. */
export function CluesTab({ ctx, scope, visible }: CluesTabProps): ReactNode {
  const [workspace, setWorkspace] = useState<WorkspaceState>({ phase: 'resolving' })
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => { setAttempt(value => value + 1) }, [])

  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    let active = true
    setWorkspace({ phase: 'resolving' })
    void resolveWorkspaceIdForSession(ctx, scope.sessionId, controller.signal).then((workspaceId) => {
      if (!active || controller.signal.aborted) return
      setWorkspace(workspaceId === undefined ? { phase: 'missing' } : { phase: 'ready', workspaceId })
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [ctx, scope.sessionId, visible, attempt])

  return (
    <div className={css.root}>
      <div className={css.header}>
        <h2 className={css.heading}>{t('clueTabTitle')}</h2>
      </div>
      {workspace.phase === 'resolving' ? (
        <div className={css.state} role="status">{t('loading')}</div>
      ) : workspace.phase === 'missing' ? (
        <div className={css.state}>
          <span>{t('clueTabNoWorkspace')}</span>
          <button type="button" className={css.stateAction} onClick={retry}>{t('retry')}</button>
        </div>
      ) : (
        // The two working regions arrive in the next milestone; the shell
        // already owns the workspace address they need.
        <div className={css.state}>{t('clueTabTitle')}</div>
      )}
    </div>
  )
}
