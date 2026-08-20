/**
 * The title-bar strip resolution chain: standard WCO geometry first
 * (authoritative even when 0), then the documented URL inset contract
 * parameter, then the opt-in preset / custom scheme — and 0 (plain web,
 * nothing modified) otherwise. No per-shell branch lives in the core.
 */
import { describe, expect, it } from 'vitest'
import { computeTitleBarStrip } from '../src/client/titlebar-strip.ts'
import type { DesktopEnv } from '../src/client/desktop-env.ts'
import type { WcoSnapshot } from '../src/client/wco.ts'
import type { ShellPreset } from '../src/client/shell-presets.ts'

const env = (partial: Partial<DesktopEnv>): DesktopEnv => ({
  desktop: false,
  mode: null,
  platform: null,
  titlebarInset: 0,
  ...partial,
})

const wco = (present: boolean, height = 0): WcoSnapshot => ({ present, height })

const noPreset: ShellPreset | undefined = undefined

describe('computeTitleBarStrip', () => {
  it('keeps plain web untouched: no WCO, no inset, no scheme → 0', () => {
    expect(computeTitleBarStrip(env({}), wco(false), 'auto', noPreset, 40)).toBe(0)
    expect(computeTitleBarStrip(env({}), wco(false), 'custom', noPreset, 40)).toBe(40)
  })

  it('the explicit WEB scheme forces 0 — not even standard WCO geometry applies', () => {
    const desktop = env({ desktop: true, mode: 'advanced', platform: 'win32' })
    // The user declared "DSH official web": no adaptation at all, even when
    // a real overlay exists or a preset is active.
    expect(computeTitleBarStrip(desktop, wco(true, 36), 'web', noPreset, 40)).toBe(0)
    expect(computeTitleBarStrip(desktop, wco(false), 'web', noPreset, 40)).toBe(0)
    expect(computeTitleBarStrip(desktop, wco(false), 'web', {
      id: 't', title: 't', desc: '', stripFor: () => 20,
    }, 40)).toBe(0)
  })

  it('trusts the standard WCO geometry first in every scheme (even 0 — e.g. maximized)', () => {
    const desktop = env({ desktop: true, mode: 'advanced', platform: 'win32' })
    expect(computeTitleBarStrip(desktop, wco(true, 36), 'auto', noPreset, 0)).toBe(36)
    expect(computeTitleBarStrip(desktop, wco(true, 36), 'preset', noPreset, 0)).toBe(36)
    expect(computeTitleBarStrip(desktop, wco(true, 36), 'custom', noPreset, 40)).toBe(36)
    // Authoritative zero: the overlay is hidden while maximized — no strip.
    expect(computeTitleBarStrip(desktop, wco(true, 0), 'auto', noPreset, 40)).toBe(0)
  })

  it('applies the documented URL inset contract parameter before any scheme', () => {
    const stamped = env({ desktop: true, mode: 'advanced', platform: 'darwin', titlebarInset: 20 })
    expect(computeTitleBarStrip(stamped, wco(false), 'auto', noPreset, 0)).toBe(20)
    expect(computeTitleBarStrip(stamped, wco(false), 'preset', noPreset, 0)).toBe(20)
  })

  it('uses the opt-in preset strip under the preset scheme only', () => {
    const preset: ShellPreset = {
      id: 't', title: 't', desc: '',
      stripFor: (e) => e.platform === 'darwin' ? 20 : undefined,
    }
    const darwin = env({ desktop: true, mode: 'advanced', platform: 'darwin' })
    expect(computeTitleBarStrip(darwin, wco(false), 'preset', preset, 0)).toBe(20)
    // Auto never applies the preset — only standard signals.
    expect(computeTitleBarStrip(darwin, wco(false), 'auto', preset, 0)).toBe(0)
    // Custom never applies the preset either.
    expect(computeTitleBarStrip(darwin, wco(false), 'custom', preset, 0)).toBe(0)
  })

  it('uses the manual strip px under the custom scheme only', () => {
    expect(computeTitleBarStrip(env({}), wco(false), 'custom', noPreset, 56)).toBe(56)
    expect(computeTitleBarStrip(env({}), wco(false), 'auto', noPreset, 56)).toBe(0)
    expect(computeTitleBarStrip(env({}), wco(false), 'preset', noPreset, 56)).toBe(0)
  })
})
