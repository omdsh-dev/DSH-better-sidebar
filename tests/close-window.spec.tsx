/**
 * 会话头「一键关闭窗口」控件（`src/client/sidebar/close-window.tsx`）。
 *
 * 钉住四条行为：
 * 1. **桌面窗口里渲染**：`<html data-platform>` 是 Electron preload 打的戳，
 *    有戳才出按钮（宿主主进程的 `shortcuts.closeWindow` 只有桌面版有 keyboard 桥）；
 * 2. **Web 部署不渲染**：没有戳时整个控件缺席——不给用户一个点了只会
 *    throw 'Desktop keyboard bridge unavailable' 的按钮；
 * 3. **点击走宿主通道**：调 `ctx.get('shortcuts').closeWindow()`，
 *    并且方法要绑回服务本身（它内部读自己的 keyboard 与 revision）；
 * 4. **失败只报一条控制台错误并恢复可用**：关窗是异步的，失败后不能把按钮永久禁用。
 *
 * `shortcuts` 服务缺席时（宿主还没激活该服务）点击必须给出明确错误而不是静默什么都不做。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
// First import: browser globals before the primitive-carrying sidebar graph loads.
import './browser-globals.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import {
  CLOSE_WINDOW_ATTR, CLOSE_WINDOW_ENTRY_ID, CloseWindowButton, desktopWindowOpen, registerCloseWindow,
} from '../src/client/sidebar/close-window.tsx'
import { attachLocale, t } from '../src/client/locales.ts'
import type { Context } from '../src/context-types.ts'

setupReactAct()

/** 宿主 locale 服务面：`attachLocale` 只需要一个 snapshot。 */
function attachZhLocale(): void {
  attachLocale({ getSnapshot: () => ({ active: 'zh' }) })
}

beforeEach(() => { attachZhLocale() })

afterEach(() => {
  attachLocale(undefined)
  delete document.documentElement.dataset['platform']
  for (const element of document.querySelectorAll('[data-codex-test-root]')) element.remove()
})

/** 把页面标成 Desktop 窗口（preload 写的就是这个属性）。 */
function markDesktop(platform = 'darwin'): void {
  document.documentElement.dataset['platform'] = platform
}

/** 控件本体；`closeWindow` 是本次用例的替身。 */
function renderButton(closeWindow: () => Promise<void>): { unmount: () => void } {
  const view = renderRoot(createElement('div', { 'data-codex-test-root': '' }, createElement(CloseWindowButton, { closeWindow })))
  return { unmount: view.unmount }
}

/** 点一次按钮（`act` 里派发 click，让 React 的 busy 状态落地）。 */
function clickButton(): void {
  const element = document.querySelector('button[' + CLOSE_WINDOW_ATTR + ']')
  if (element === null) throw new Error('missing element: close window button')
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** 一个只实现 `get` 的活上下文替身：`ctx.get(name, false)` 读服务。 */
function fakeCtx(services: Record<string, unknown>): Context {
  return {
    get: (name: string) => services[name],
    slots: {
      inject: (_key: string, callback: () => () => void) => callback(),
      register: (options: Record<string, unknown>, _component: unknown) => {
        registrations.push(options)
        return () => {}
      },
    },
  } as unknown as Context
}

let registrations: Record<string, unknown>[] = []

beforeEach(() => { registrations = [] })

describe('desktopWindowOpen', () => {
  it('只有 preload 打过 data-platform 戳时才算桌面窗口', () => {
    expect(desktopWindowOpen()).toBe(false)
    markDesktop('darwin')
    expect(desktopWindowOpen()).toBe(true)
  })
})

describe('CloseWindowButton', () => {
  it('桌面窗口里渲染一个带中文无障碍名的按钮', () => {
    markDesktop()
    const { unmount } = renderButton(() => Promise.resolve())
    try {
      const element = document.querySelector('button[' + CLOSE_WINDOW_ATTR + ']')
      expect(element, '桌面版要有关窗入口').not.toBeNull()
      expect(element?.getAttribute('aria-label')).toBe(t('closeWindow'))
      expect(element?.getAttribute('aria-label')).toBe('关闭窗口')
    } finally {
      unmount()
    }
  })

  it('Web 部署下整个控件缺席', () => {
    const { unmount } = renderButton(() => Promise.resolve())
    try {
      expect(document.querySelector('button[' + CLOSE_WINDOW_ATTR + ']'), 'Web 版不该出按钮').toBeNull()
    } finally {
      unmount()
    }
  })

  it('点击调用传入的关窗动作', async () => {
    markDesktop()
    const closeWindow = vi.fn(async () => {})
    const { unmount } = renderButton(closeWindow)
    try {
      clickButton()
      await act(async () => { await Promise.resolve() })
      expect(closeWindow).toHaveBeenCalledTimes(1)
    } finally {
      unmount()
    }
  })

  it('关窗失败时只打一条控制台错误，按钮恢复可用', async () => {
    markDesktop()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const closeWindow = vi.fn(async () => { throw new Error('window not focused') })
      const { unmount } = renderButton(closeWindow)
      try {
        clickButton()
        await act(async () => { await Promise.resolve() })
        const element = document.querySelector('button[' + CLOSE_WINDOW_ATTR + ']')
        expect(error, '失败要留在控制台').toHaveBeenCalledWith('Window close failed', expect.any(Error))
        expect(error).toHaveBeenCalledTimes(1)
        expect((element as HTMLButtonElement | null)?.disabled, '失败后按钮要能再点').toBe(false)
      } finally {
        unmount()
      }
    } finally {
      error.mockRestore()
    }
  })
})

describe('registerCloseWindow', () => {
  /** 注册一次，返回这一轮的 slot 入口（含它的 inject 工厂）。 */
  function register(services: Record<string, unknown>): Record<string, unknown> {
    registerCloseWindow(fakeCtx(services))
    const entry = registrations.find(candidate => candidate['id'] === CLOSE_WINDOW_ENTRY_ID)
    if (entry === undefined) throw new Error('no registration for the close-window entry')
    return entry
  }

  it('占用会话头 utilities，排在整排末尾（工作台 10 / 诊断 20 之后）', () => {
    const entry = register({})
    expect(entry['name']).toBe('conversation.session.header.utilities')
    expect(entry['order']).toBe(30)
    expect(entry['registrant']).toBe('dsh-better-sidebar')
  })

  it('inject 产出的动作把 closeWindow 绑回 shortcuts 服务本身', async () => {
    const calls: number[] = []
    const shortcuts = {
      revision: 7,
      // 故意用 this 读自己的字段：不绑定就会拿到 undefined
      async closeWindow(): Promise<void> { calls.push(this.revision) },
    }
    const entry = register({ shortcuts })
    const inject = entry['inject'] as (() => { closeWindow: () => Promise<void> }) | undefined
    if (inject === undefined) throw new Error('the entry carries no inject factory')
    await inject().closeWindow()
    expect(calls).toEqual([7])
  })

  it('shortcuts 服务缺席时给出明确错误，而不是静默什么都不做', async () => {
    const entry = register({})
    const inject = entry['inject'] as (() => { closeWindow: () => Promise<void> }) | undefined
    if (inject === undefined) throw new Error('the entry carries no inject factory')
    await expect(inject().closeWindow()).rejects.toThrow('Desktop window close bridge unavailable')
  })
})
