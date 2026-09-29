/**
 * 终端字体覆盖（src/client/terminal-font.ts）：让「终端字体」偏好也作用于 DSH 自己的终端。
 *
 * 宿主的 `ui-sidebar-terminal` 把 fontFamily 写死且无设置项，所以偏好只能经 CSS 变量 +
 * `!important` 规则透过去。钉住三件事：规则只注入一次；偏好非空 → 变量带上带引号的字体族
 * 与兜底栈；偏好清空 → 变量移除（宿主终端回落自己的字体，零副作用）。
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { attachTerminalFontOverride, TERMINAL_FONT_VAR } from '../src/client/terminal-font.ts'
import { createSidebarStore } from '../src/client/state.ts'

/** 注入的样式表选择器（与实现里的标记一致）。 */
const STYLE_SELECTOR = 'style[data-plugin-css="dsh-better-sidebar-terminal-font"]'

describe('terminal font override', () => {
  it('injects the rule once and mirrors the preference into the CSS variable', () => {
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), terminalFontFamily: 'MesloLGS NF' })
    const dispose = attachTerminalFontOverride(store)

    expect(document.querySelectorAll(STYLE_SELECTOR).length).toBe(1)
    expect(document.documentElement.style.getPropertyValue(TERMINAL_FONT_VAR))
      .toBe('"MesloLGS NF", ui-monospace, SFMono-Regular, Menlo, monospace')

    // 清空偏好 → 变量移除（宿主终端回落自己的写死字体）。
    store.setPrefs({ ...store.getPrefs(), terminalFontFamily: '' })
    expect(document.documentElement.style.getPropertyValue(TERMINAL_FONT_VAR)).toBe('')
    dispose()

    // 重复挂载不会重复注入规则。
    const again = attachTerminalFontOverride(store)
    expect(document.querySelectorAll(STYLE_SELECTOR).length).toBe(1)
    again()
  })
})
