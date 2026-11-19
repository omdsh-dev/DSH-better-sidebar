/**
 * React bindings for the two language sources `t()` resolves from. A native
 * tab body renders in the HOST's tree, outside the plugin shell, so a locale
 * switch does not re-render it by itself; these hooks subscribe to the DSH
 * locale service and the optional better-locale override directly.
 *
 * Both services are probed rather than assumed: older hosts may provide
 * neither, and `subscribe` itself is optional.
 */
import { useEffect, useState } from 'react'
import type { Context } from '../context-types.ts'
import { localeSignature } from './locales.ts'

type Unsubscribe = () => void

interface Subscribable {
  subscribe?: (listener: () => void) => Unsubscribe
}

/** Subscribe to both language sources as one lifetime. */
function subscribeLocale(ctx: Context, onChange: () => void): Unsubscribe {
  const locale = (ctx as unknown as { locale?: Subscribable }).locale
  const betterLocale = typeof ctx.get === 'function'
    ? ctx.get('betterLocale') as Subscribable | undefined
    : undefined
  const offLocale = locale?.subscribe?.(onChange)
  const offOverride = betterLocale?.subscribe?.(onChange)
  return () => {
    offLocale?.()
    offOverride?.()
  }
}

/**
 * The effective language signature ({@link localeSignature}), kept fresh
 * across a DSH locale switch and an override switch. Components that cache
 * localized text outside React state use this as an effect dependency.
 * @param ctx - the client context carrying the language services.
 * @returns the current signature; changes with the active language.
 */
export function useLocaleSignature(ctx: Context): string {
  const [signature, setSignature] = useState(localeSignature)
  useEffect(() => {
    const sync = (): void => { setSignature(localeSignature()) }
    // Re-read once: the language may have changed between the initial state
    // and the subscription.
    sync()
    return subscribeLocale(ctx, sync)
  }, [ctx])
  return signature
}

/**
 * Re-render on any language change, for components whose copy is read
 * through `t()` during render and needs no cached value.
 * @param ctx - the client context carrying the language services.
 */
export function useLocaleRefresh(ctx: Context): void {
  const [, setVersion] = useState(0)
  useEffect(
    () => subscribeLocale(ctx, () => { setVersion(version => version + 1) }),
    [ctx],
  )
}
