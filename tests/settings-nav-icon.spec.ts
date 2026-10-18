// @vitest-environment jsdom
/**
 * Settings-navigation icon marker tests (including delayed dialog mount).
 *
 * v0.25 的稳态开销治理：观察者改 rAF 合帧 + 去掉 `characterData`。三条契约：
 * 1. 标记仍然落在本地化标签匹配的那一行上（挂载/改标签的既有用例）；
 * 2. 同一帧里的一串 DOM 文本 mutation 只做**一次**全文档行查询；
 * 3. 纯文本节点内容变化（对话流式输出就是它）不再触发任何查询。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSettingsNavIcon, SETTINGS_NAV_MARKER } from '../src/client/settings-nav-icon.ts'

/** 被观察者查询的行选择器（统计它，而不是 disposer 的标记清理查询）。 */
const NAV_SELECTOR = '[role="dialog"] nav button'

/** 确定性 rAF：只有在 flushFrame() 里才推进一帧。 */
let frames: Map<number, FrameRequestCallback>
let nextFrameId: number

function flushFrame(): void {
  const callbacks = [...frames.values()]
  frames.clear()
  for (const callback of callbacks) callback(0)
}

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

/** 一次 mutation 走到「观察者回调（微任务）→ 合帧后的一次 sync」。 */
async function settleMarker(): Promise<void> {
  await mutationTick()
  flushFrame()
}

/** 观察者查询行的次数（标记清理的查询不算）。 */
function navQueries(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(call => call[0] === NAV_SELECTOR).length
}

beforeEach(() => {
  frames = new Map()
  nextFrameId = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(nextFrameId, callback)
    return nextFrameId++
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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
    await settleMarker()

    expect(english.hasAttribute(SETTINGS_NAV_MARKER)).toBe(true)
    expect(chinese.hasAttribute(SETTINGS_NAV_MARKER)).toBe(false)

    label = '侧边卡片'
    chinese.querySelector('span')!.textContent = '侧边卡片 '
    await settleMarker()
    expect(english.hasAttribute(SETTINGS_NAV_MARKER)).toBe(false)
    expect(chinese.hasAttribute(SETTINGS_NAV_MARKER)).toBe(true)

    dispose()
  })

  it('coalesces a burst of mutations into one sync per frame', async () => {
    const dispose = registerSettingsNavIcon(() => 'Side card')
    const button = navButton('Side card')
    document.body.append(dialogWith(button))
    // 对话正文的形态：转写每来一个 token 就往正文容器里插一个文本节点，而设置行本身
    // 一动不动。观察者盯的是整个 body，所以这些 mutation 都会打到它身上。
    const stream = document.createElement('div')
    document.body.append(stream)
    await settleMarker()

    const query = vi.spyOn(document, 'querySelectorAll')
    for (let index = 0; index < 6; index++) {
      stream.append(document.createTextNode(`token ${index}`))
      // 每个 token 一个宏任务（流式输出的节拍）：观察者是同步回调时，每次都会跑一次
      // 全文档行查询。
      await mutationTick()
    }
    expect(navQueries(query), '还没到帧，一次都不该查').toBe(0)
    flushFrame()
    expect(navQueries(query), '同一帧内的一串 mutation 只查一次').toBe(1)
    // 合帧不改变结果：帧末那次 sync 仍把标记留在唯一匹配的行上。
    expect(button.hasAttribute(SETTINGS_NAV_MARKER)).toBe(true)
    dispose()
  })

  it('ignores characterData-only mutations (streamed conversation tokens)', async () => {
    const dispose = registerSettingsNavIcon(() => 'Side card')
    const button = navButton('Side card')
    document.body.append(dialogWith(button))
    // 对话正文那样的一串文本节点：先排掉挂载那一次观察者回调。
    const streamed = document.createTextNode('streaming 0')
    document.body.append(streamed)
    await settleMarker()

    const query = vi.spyOn(document, 'querySelectorAll')
    for (let index = 1; index <= 5; index++) {
      streamed.data = `streaming ${index}`
      await mutationTick()
    }
    flushFrame()
    expect(navQueries(query), 'characterData 已被移出观察面').toBe(0)
    expect(button.hasAttribute(SETTINGS_NAV_MARKER), '标记不受正文影响').toBe(true)
    dispose()
  })

  it('cancels a pending frame when disposed', async () => {
    const dispose = registerSettingsNavIcon(() => 'Side card')
    document.body.append(dialogWith(navButton('Side card')))
    // 观察到 mutation，但帧还没到就 dispose：回调必须被取消，不能再查一次。
    await mutationTick()
    const query = vi.spyOn(document, 'querySelectorAll')
    dispose()
    expect(frames.size, '待处理的那一帧被取消').toBe(0)
    flushFrame()
    expect(navQueries(query)).toBe(0)
  })
})
