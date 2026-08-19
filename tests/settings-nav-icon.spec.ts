// @vitest-environment jsdom
/** Settings-navigation icon marker tests (including delayed dialog mount). */
import { afterEach, describe, expect, it } from 'vitest'
import { registerSettingsNavIcon, SETTINGS_NAV_MARKER } from '../src/client/settings-nav-icon.ts'

function navButton(label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.innerHTML = `<svg data-fallback="gear"></svg><span>${label}</span>`
  return button
}

function dialogWith(...buttons: HTMLButtonElement[]): HTMLElement {
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  const nav = document.createElement('nav')
  nav.append(...buttons)
  dialog.append(nav)
  return dialog
}

async function mutationTick(): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('registerSettingsNavIcon', () => {
  it('marks only the matching settings row and preserves the shell icon DOM', () => {
    const general = navButton('General')
    const sideCard = navButton('Side card')
    document.body.append(dialogWith(general, sideCard))

    const dispose = registerSettingsNavIcon(() => 'Side card')

    expect(general.hasAttribute(SETTINGS_NAV_MARKER)).toBe(false)
    expect(sideCard.hasAttribute(SETTINGS_NAV_MARKER)).toBe(true)
    expect(sideCard.querySelector('[data-fallback="gear"]')).not.toBeNull()
    dispose()
    expect(sideCard.hasAttribute(SETTINGS_NAV_MARKER)).toBe(false)
  })

  it('marks a dialog mounted later and follows a localized label change', async () => {
    let label = 'Side card'
    const dispose = registerSettingsNavIcon(() => label)
    const english = navButton('Side card')
    const chinese = navButton('侧边卡片')
    const dialog = dialogWith(english, chinese)
    document.body.append(dialog)
    await mutationTick()

    expect(english.hasAttribute(SETTINGS_NAV_MARKER)).toBe(true)
    expect(chinese.hasAttribute(SETTINGS_NAV_MARKER)).toBe(false)

    label = '侧边卡片'
    chinese.querySelector('span')!.textContent = '侧边卡片 '
    await mutationTick()
    expect(english.hasAttribute(SETTINGS_NAV_MARKER)).toBe(false)
    expect(chinese.hasAttribute(SETTINGS_NAV_MARKER)).toBe(true)

    dispose()
  })
})
