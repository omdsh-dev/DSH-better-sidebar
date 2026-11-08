/**
 * The UI half of the optional dsh-context diagnostics: three entry points into
 * ONE conversation's "Context" view (an agent node's detail card, a background
 * job's output window, the session header's utilities row) and the frame-wide
 * error alert they share.
 *
 * Availability comes from the controller (./context-diagnostics.ts), never from
 * a guess here: it re-proves the optional runtime faces and answers `available`
 * (the tab type AND its keyed body), and its single `busy` flag disables all
 * three entry points for the duration of an open.
 *
 * The controller is threaded PER ACTIVATION — created in ./index.tsx, handed to
 * the host's two slots by closure, to the plugin's tree through the provider,
 * and to the native bodies through the native surface's deps bag. No
 * module-level store on purpose: two activations must never share one, and a
 * body unmounting must never clear another entry point's controller.
 */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import {
  Button, IconCloseOutlineRegular, IconContextInjectionOutlineRegular, IconWarningTriangleOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context, SidebarSubagentAddress } from '../context-types.ts'
import {
  createContextDiagnostics,
  type ContextDiagnosticError,
  type ContextDiagnosticTarget,
  type ContextDiagnostics,
  type ContextDiagnosticsSnapshot,
} from './context-diagnostics.ts'
import { mountedSessionId } from './native/surface.ts'
import { t, type CopyKey } from './locales.ts'
import css from './context-diagnostics.module.css'

/** The entry id both slot registrations use. */
export const HEADER_ENTRY_ID = 'dsh-better-sidebar:context-diagnostics'

/** The three entry points, as the e2e lane tells them apart. */
export type DiagnosticsEntryKind = 'session' | 'agent' | 'job'

/** Testid of an entry point's control; ABSENT while the control is not offered. */
export const DIAGNOSTICS_ENTRY_ATTR = 'data-dsh-ctx-entry'

/** Testid of the frame-wide alert. */
export const DIAGNOSTICS_ALERT_ATTR = 'data-dsh-ctx-alert'

/** The controller's carrier; `undefined` = this tree has no diagnostics. */
const DiagnosticsStoreContext = createContext<ContextDiagnostics | undefined>(undefined)

/** Thread one activation's controller into a subtree (shell, native tab body). */
export function ContextDiagnosticsHost(props: {
  controller?: ContextDiagnostics
  children?: ReactNode
}): ReactNode {
  return (
    <DiagnosticsStoreContext.Provider value={props.controller}>
      {props.children}
    </DiagnosticsStoreContext.Provider>
  )
}

/** The controller in scope for this tree (undefined = no entry point renders). */
function useDiagnosticsStore(): ContextDiagnostics | undefined {
  return useContext(DiagnosticsStoreContext)
}

function useDiagnosticsSnapshot(store: ContextDiagnostics | undefined): ContextDiagnosticsSnapshot | undefined {
  return useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIBE, store?.getSnapshot ?? NO_SNAPSHOT)
}

const NO_SUBSCRIBE = (): (() => void) => () => {}
const NO_SNAPSHOT = (): undefined => undefined

/**
 * One entry point's control, shared so the three surfaces cannot drift apart:
 * the gate (capability available AND a resolved target), the single-open
 * disable, and the e2e handle.
 */
export function ContextDiagnosticsButton(props: {
  kind: DiagnosticsEntryKind
  /** `undefined` = this surface has nothing addressable to offer. */
  target: ContextDiagnosticTarget | undefined
  /** The host glyph's size (the header uses 14, the floating window 12). */
  iconSize: number
  /** The caller's box class, when the glyph must not take row width. */
  className?: string
  /** Dismiss source UI after dispatch; the controller owns the pending request. */
  onNavigate?(): void
}): ReactNode {
  const { kind, target, iconSize, className } = props
  const store = useDiagnosticsStore()
  const snapshot = useDiagnosticsSnapshot(store)
  if (store === undefined || target === undefined || snapshot?.available !== true) return null
  const busy = snapshot.busy === true
  return (
    <Button
      variant="ghost"
      size="sm"
      {...(className === undefined ? {} : { className })}
      {...{ [DIAGNOSTICS_ENTRY_ATTR]: kind }}
      // Busy is announced as well as enforced: one open at a time disables
      // every entry point while it runs.
      aria-busy={busy ? 'true' : undefined}
      icon={<IconContextInjectionOutlineRegular size={iconSize} />}
      aria-label={t('contextDiagnostics')}
      title={t('contextDiagnostics')}
      disabled={busy}
      onClick={() => {
        store.open(target)
        props.onNavigate?.()
      }}
    />
  )
}

/**
 * The header's control: an entry is drawn for the session the SLOT was mounted
 * with and can outlive it by a moment while the host rebuilds the row, so the
 * click re-checks `sidebarRight.mounted` and refuses to act once that session
 * left the screen — a stale header must never navigate into the previous
 * conversation.
 */
function ContextDiagnosticsHeader(props: {
  controller: ContextDiagnostics
  sessionId: string
  isCurrent(): boolean
}): ReactNode {
  const { controller, sessionId, isCurrent } = props
  const snapshot = useDiagnosticsSnapshot(controller)
  if (snapshot?.available !== true) return null
  const busy = snapshot.busy === true
  return (
    <Button
      variant="ghost"
      size="sm"
      className={css.headerButton}
      {...{ [DIAGNOSTICS_ENTRY_ATTR]: 'session' satisfies DiagnosticsEntryKind }}
      aria-busy={busy ? 'true' : undefined}
      icon={<IconContextInjectionOutlineRegular size={14} />}
      aria-label={t('contextDiagnostics')}
      title={t('contextDiagnostics')}
      disabled={busy}
      onClick={() => {
        if (!isCurrent()) return
        controller.open({ sessionId, label: t('contextDiagnosticsTarget') })
      }}
    />
  )
}

/** The copy key of one failure reason. */
function reasonKey(reason: ContextDiagnosticError['reason']): CopyKey {
  switch (reason) {
    case 'navigation': return 'contextDiagnosticsNavigation'
    case 'timeout': return 'contextDiagnosticsTimeout'
    case 'open': return 'contextDiagnosticsOpenFailed'
    case 'unavailable': return 'contextDiagnosticsUnavailable'
  }
}

/**
 * The ONE error alert (`shell.overlay`), dismissed by the controller's own
 * `dismissError()` — never a timer. Gated on the ERROR only, not on
 * `available`: an open already in flight when the capability went away must
 * still report why it failed.
 */
export function ContextDiagnosticsAlert(props: { controller: ContextDiagnostics }): ReactNode {
  const { controller } = props
  const snapshot = useDiagnosticsSnapshot(controller)
  const error = snapshot?.error
  if (error === undefined) return null
  return (
    <div className={css.alertLayer} {...{ [DIAGNOSTICS_ALERT_ATTR]: '' }}>
      <div className={css.alert} role="alert">
        <span className={css.alertIcon} aria-hidden="true">
          <IconWarningTriangleOutlineRegular size={14} />
        </span>
        <span className={css.alertText}>
          <span className={css.alertTitle}>
            {t('contextDiagnosticsFailed', { label: error.targetLabel })}
          </span>
          <span className={css.alertReason}>{t(reasonKey(error.reason))}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className={css.alertClose}
          icon={<IconCloseOutlineRegular size={12} />}
          aria-label={t('contextDiagnosticsDismiss')}
          title={t('contextDiagnosticsDismiss')}
          onClick={() => { controller.dismissError() }}
        />
      </div>
    </div>
  )
}

/**
 * Contribute the header control and the frame-wide alert. Both ride
 * `slots.inject`: neither declaration is guaranteed to be on the ledger at
 * activation (the header and the frame come from other entries), and the
 * callback re-runs if one collapses and is re-declared.
 * @param ctx - the client context (slots + the native right column probe).
 * @param controller - the controller of this activation.
 * @returns a disposer unregistering both entries.
 */
export function registerContextDiagnosticsUI(ctx: Context, controller: ContextDiagnostics): () => void {
  const disposers: Array<() => void> = []
  try {
    disposers.push(ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: HEADER_ENTRY_ID,
      // After the host's own utilities and after the bottom-workbench toggle
      // (order 10), so the two plugin controls sit together at the row's edge.
      order: 20,
      registrant: 'dsh-better-sidebar',
      inject: (sessionId: string) => ({
        controller,
        sessionId,
        isCurrent: () => mountedSessionId(ctx) === sessionId,
      }),
    }, ContextDiagnosticsHeader)))
    disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: HEADER_ENTRY_ID,
      order: 20,
      registrant: 'dsh-better-sidebar',
      inject: () => ({ controller }),
    }, ContextDiagnosticsAlert)))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
    disposers.length = 0
  }
}

/** The activation's diagnostics controller (one per client activation). */
export function createContextDiagnosticsHost(ctx: Context): ContextDiagnostics {
  return createContextDiagnostics(ctx)
}

/** A tree node's navigable address, when the tree really has one: the ROOT node
 *  carries none (it IS the main session) and is addressed by its own id, and an
 *  incomplete pair (a stale parent, a synthesized member) yields no control. */
export function diagnosticAddressOf(
  nodeId: string,
  address: SidebarSubagentAddress | undefined,
): SidebarSubagentAddress | undefined {
  return address !== undefined && address.parentSessionId !== '' && address.childSessionId === nodeId
    ? address
    : undefined
}
