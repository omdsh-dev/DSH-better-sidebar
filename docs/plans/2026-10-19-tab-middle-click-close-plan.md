# 右侧栏 tab 中键关闭 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让宿主右侧栏的每个 tab chip 支持中键关闭，含宿主自己的「指南」tab。

**Architecture:** 宿主 dockkit 的 chip 没有中键路由（`onPointerDown` 只特判右键），插件侧用 document 级 capture 事件委托补上：同时拦 `pointerdown`（阻止宿主起拖拽）与 `mousedown`（抑制中键 autoscroll），在第一次中键 `mouseup` 落回同一 chip 时结算。关闭统一走 `service.closeTab`；为让插件没有记录的 tab 也能关，`surface.close` 在记录缺失时兜底调宿主 controller。

**Tech Stack:** TypeScript / React（仅类型）/ vitest + jsdom / DSH 0.2.1-rc.1 的 `ctx.sidebarRight`。

**Spec:** `docs/plans/2026-10-19-tab-middle-click-close.md`

## Global Constraints

- 零源码 patch：`D:\Projects\deepseek-harness\dsh` 整目录只读，任何改动只在 `dsh-better-sidebar` 内。
- 只处理 `button === 1`；左键激活与右键菜单的现有路径不得改变。
- chip 可关性沿用宿主判据：chip 内存在 `[data-dockkit-tab-close]` 才响应；否则不拦、不 preventDefault。
- 结算语义：按下与松开必须落在同一 chip（release-position），一次按下只结算一次。
- 单例：一个 document 级监听器随 client activation 挂载/释放，不按 tab 或 session 复制。
- 视觉零改动（无新增 CSS、无新增词典 key）。
- `bash` 说明：仓库`build`已用 Node `rmSync` 跨平台；本计划命令在仓库根执行。

---

### Task 1: `surface.close` 的宿主兜底

**Files:**
- Modify: `src/client/native/surface.ts:268-284`（`close` 方法）与 `src/client/service.ts:597`（该方法的 JSDoc 一行）
- Test: `tests/native-surface.spec.ts`

**Interfaces:**
- Consumes: `NativeTabRecords`（已有）、`controllerOf(ctx)`（已有）、`mountedSessionId(ctx)`（已有）。
- Produces: 不变更签名 —— `close(sessionId, tabId): { type: string; title: string; meta?: unknown } | undefined`；新语义是「记录缺失时仍向宿主发出关闭」。

- [ ] **Step 1: 写失败测试**

在 `tests/native-surface.spec.ts` 追加（沿用该文件已有的 fake ctx / controller 构造方式）：

```ts
it('closes a tab the plugin has no record for through the host controller', () => {
  const closed: string[] = []
  const ctx = fakeCtxWithController({ close: (id: string) => { closed.push(id) } })
  const records = createNativeTabRecords()
  const surface = createNativeSurface(ctx, records)
  try {
    expect(surface.close('s1', 'host-guide-tab')).toBeUndefined()
    expect(closed).toEqual(['host-guide-tab'])
  } finally {
    surface.dispose()
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/native-surface.spec.ts -t 'no record'`
Expected: FAIL —— `closed` 为 `[]`。

- [ ] **Step 3: 实现兜底**

`src/client/native/surface.ts` 的 `close` 改为：

```ts
    close(sessionId, tabId) {
      // Read through the SESSION: the same native id names a tab in every
      // session, so a bare read can hand back another session's record.
      const record = records.get(sessionId, tabId)
      const api = controller()
      const closeOnHost = (): void => {
        if (api === undefined) return
        if (sessionId === mountedSessionId(ctx)) api.close(tabId)
        else if (api.closeIn !== undefined) api.closeIn(sessionId, tabId)
      }
      if (record === undefined) {
        // A tab this plugin never registered (the host's own guide tab) or one
        // whose body never rendered: the host still owns closing it. The caller
        // gets no record because there is none to report.
        closeOnHost()
        return undefined
      }
      records.drop(sessionId, tabId)
      closeOnHost()
      return {
        type: record.tab.type,
        title: record.tab.title,
        ...(record.tab.meta === undefined ? {} : { meta: record.tab.meta }),
      }
    },
```

同步 `src/client/service.ts:597` 的文档注释：

```ts
  /**
   * Close one native tab and return the closed record's type/title/meta, or
   * undefined when the plugin holds no record for the id — the tab is then
   * still closed through the host controller (a host-owned tab, or a plugin
   * tab whose body never rendered).
   */
  close(sessionId: string, tabId: string): { type: string; title: string; meta?: unknown } | undefined
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/native-surface.spec.ts`
Expected: PASS（含既有用例）。

- [ ] **Step 5: 提交**

```bash
git add src/client/native/surface.ts src/client/service.ts tests/native-surface.spec.ts
git commit -m "feat(native): surface.close 对插件无记录的 tab 兜底走宿主 controller"
```

---

### Task 2: 中键委托模块

**Files:**
- Create: `src/client/native/tab-middle-click.ts`
- Test: `tests/tab-middle-click-native.spec.ts`

**Interfaces:**
- Consumes: 无（不 import 宿主或 service）。
- Produces: `registerTabMiddleClick(deps: { closeTab: (tabId: string) => void }): () => void` —— 返回 disposer。

- [ ] **Step 1: 写失败测试**

新建 `tests/tab-middle-click-native.spec.ts`：

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerTabMiddleClick } from '../src/client/native/tab-middle-click.ts'

/** One dockkit-shaped chip: the strip attribute, the title, and (optionally) the close control. */
function chip(id: string, closable = true): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute('data-dockkit-tab', id)
  element.textContent = id
  if (closable) {
    const close = document.createElement('button')
    close.setAttribute('data-dockkit-tab-close', id)
    element.append(close)
  }
  document.body.append(element)
  return element
}

function fire(target: EventTarget, type: string, button: number): Event {
  const event = type.startsWith('pointer')
    ? new PointerEvent(type, { bubbles: true, cancelable: true, button })
    : new MouseEvent(type, { bubbles: true, cancelable: true, button })
  target.dispatchEvent(event)
  return event
}

function install() {
  const closeTab = vi.fn()
  const dispose = registerTabMiddleClick({ closeTab })
  return { closeTab, dispose }
}

afterEach(() => { document.body.innerHTML = '' })

describe('right-Sidebar chip middle-click close', () => {
  it('closes when the middle mouseup lands on the same chip', () => {
    const { closeTab, dispose } = install()
    const target = chip('t1')
    try {
      fire(target, 'pointerdown', 1)
      fire(target, 'mousedown', 1)
      fire(target, 'mouseup', 1)
      expect(closeTab).toHaveBeenCalledWith('t1')
      expect(closeTab).toHaveBeenCalledTimes(1)
    } finally { dispose() }
  })

  it('keeps the press from reaching the chip (no host drag)', () => {
    const { dispose } = install()
    const target = chip('t1')
    let reached = false
    target.addEventListener('pointerdown', () => { reached = true })
    try {
      fire(target, 'pointerdown', 1)
      expect(reached).toBe(false)
    } finally { dispose() }
  })

  it('disarms the middle-click autoscroll', () => {
    const { dispose } = install()
    const target = chip('t1')
    try {
      expect(fire(target, 'mousedown', 1).defaultPrevented).toBe(true)
    } finally { dispose() }
  })

  it('cancels when released elsewhere, once per press', () => {
    const { closeTab, dispose } = install()
    const target = chip('t1')
    try {
      fire(target, 'pointerdown', 1)
      fire(target, 'mousedown', 1)
      fire(document.body, 'mouseup', 1)
      expect(closeTab).not.toHaveBeenCalled()
      fire(target, 'mouseup', 1)
      expect(closeTab).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('does not close when the release lands on a different chip', () => {
    const { closeTab, dispose } = install()
    const first = chip('t1')
    const second = chip('t2')
    try {
      fire(first, 'pointerdown', 1)
      fire(first, 'mousedown', 1)
      fire(second, 'mouseup', 1)
      expect(closeTab).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('leaves a chip without a close control completely alone', () => {
    const { closeTab, dispose } = install()
    const target = chip('t1', false)
    try {
      fire(target, 'pointerdown', 1)
      expect(fire(target, 'mousedown', 1).defaultPrevented).toBe(false)
      fire(target, 'mouseup', 1)
      expect(closeTab).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('ignores the left button entirely', () => {
    const { closeTab, dispose } = install()
    const target = chip('t1')
    try {
      fire(target, 'pointerdown', 0)
      expect(fire(target, 'mousedown', 0).defaultPrevented).toBe(false)
      fire(target, 'mouseup', 0)
      expect(closeTab).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('does not close on a bare auxclick', () => {
    const { closeTab, dispose } = install()
    const target = chip('t1')
    try {
      fire(target, 'auxclick', 1)
      expect(closeTab).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('stops closing after dispose', () => {
    const { closeTab, dispose } = install()
    const target = chip('t1')
    fire(target, 'pointerdown', 1)
    fire(target, 'mousedown', 1)
    dispose()
    fire(target, 'mouseup', 1)
    expect(closeTab).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/tab-middle-click-native.spec.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现**

新建 `src/client/native/tab-middle-click.ts`：

```ts
/**
 * Middle-click close for the host right-Sidebar tab chips.
 *
 * The host's dockkit strip treats a chip press as a drag or a selection and
 * only special-cases the secondary button, and its callback bag has no
 * middle-button route a plugin could hook. The chips do carry the tab id
 * (`data-dockkit-tab`) and, while the host's own `canCloseTab` allows, a
 * nested `data-dockkit-tab-close` control — its closability decision projected
 * onto the DOM — so the gesture is delegated here instead.
 *
 * The press is taken in the CAPTURE phase on two events for two reasons:
 * `pointerdown` must not reach the chip handler (the host starts a drag from
 * it), and `mousedown` must be preventDefaulted to disarm the browser's
 * middle-click autoscroll. The close settles on the first middle `mouseup`
 * over the pressed chip — release-position semantics matching the plugin's own
 * tab strip and VS Code: pressing a chip and releasing elsewhere cancels.
 */

/** A chip this module may act on: its element and the tab id it names. */
interface ChipPress {
  readonly chip: HTMLElement
  readonly id: string
}

export interface TabMiddleClickDeps {
  /** Close one tab id through the plugin's own close path (lifecycle included). */
  closeTab: (tabId: string) => void
}

const CHIP = '[data-dockkit-tab]'
const CHIP_CLOSE = '[data-dockkit-tab-close]'

/**
 * The closable chip a pointer event landed in, or undefined.
 * @param target - the event target.
 * @returns the chip and its tab id, when the press belongs to a closable chip.
 */
function chipOf(target: EventTarget | null): ChipPress | undefined {
  if (!(target instanceof Element)) return undefined
  const chip = target.closest(CHIP)
  if (!(chip instanceof HTMLElement)) return undefined
  // Only a closable chip answers: the host draws the nested close control
  // exactly while its own policy allows, so the gesture inherits that policy
  // instead of restating it. A lone, unclosable chip keeps browser defaults.
  if (chip.querySelector(CHIP_CLOSE) === null) return undefined
  const id = chip.dataset.dockkitTab
  if (id === undefined || id === '') return undefined
  return { chip, id }
}

/**
 * Install the delegated middle-click close.
 * @param deps - the close entry point.
 * @returns a disposer removing every listener and dropping a pending press.
 */
export function registerTabMiddleClick(deps: TabMiddleClickDeps): () => void {
  let pressed: ChipPress | undefined

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 1) return
    const target = chipOf(event.target)
    if (target === undefined) return
    // The host begins a chip drag from this event.
    event.stopPropagation()
    pressed = target
  }

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 1) return
    const target = chipOf(event.target)
    if (target === undefined) return
    // Chromium's middle-click autoscroll starts here.
    event.preventDefault()
    pressed = target
  }

  const onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 1) return
    const target = pressed
    pressed = undefined
    if (target === undefined) return
    // Close only when the release lands on the pressed chip; a drag-away
    // release cancels the press (one-shot per press).
    if (!target.chip.isConnected) return
    if (!target.chip.contains(event.target instanceof Node ? event.target : null)) return
    deps.closeTab(target.id)
  }

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('mousedown', onMouseDown, true)
  window.addEventListener('mouseup', onMouseUp, true)
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('mousedown', onMouseDown, true)
    window.removeEventListener('mouseup', onMouseUp, true)
    pressed = undefined
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/tab-middle-click-native.spec.ts`
Expected: PASS（9 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/client/native/tab-middle-click.ts tests/tab-middle-click-native.spec.ts
git commit -m "feat(native): 右侧栏 tab chip 中键关闭（document 级事件委托）"
```

---

### Task 3: 挂载 + 变更登记 + 全量门禁

**Files:**
- Modify: `src/client/index.tsx:197-204` 区域（新增一个 `ctx.effect`）
- Modify: `CHANGELOG.md`（v0.28.0 段落下加一条未发布条目）

**Interfaces:**
- Consumes: `registerTabMiddleClick`（Task 2）、`service.closeTab`（已有）。
- Produces: 无导出变化。

- [ ] **Step 1: 在 activation 里挂载**

`src/client/index.tsx`，紧跟 bottom-workbench toggle 的 effect 之后加：

```tsx
  // Middle-click close for the host's right-Sidebar chips: the dockkit strip
  // has no middle-button route, so the gesture is delegated at the document.
  // Installed once per activation and released with this fiber.
  ctx.effect(
    () => registerTabMiddleClick({ closeTab: (tabId) => { service.closeTab(tabId) } }),
    'dsh-better-sidebar: tab middle-click close',
  )
```

并在 import 区加：

```tsx
import { registerTabMiddleClick } from './native/tab-middle-click.ts'
```

- [ ] **Step 2: 登记用户可见变更**

`CHANGELOG.md` 在 `### v0.28.0` 之前插入：

```md
### 未发布

- 🖱️ **右侧栏 tab 支持中键关闭**：宿主 dockkit 的 tab strip 没有中键路由，插件用 document 级事件委托补齐——按下与松开都落在同一个可关闭 chip 才关闭（与浏览器 / VS Code 一致的 release-position 语义），左键激活与右键菜单不受影响。宿主自己的「指南」tab 同样支持。
```

- [ ] **Step 3: 门禁**

```bash
pnpm run typecheck
pnpm exec vitest run tests/tab-middle-click-native.spec.ts tests/native-surface.spec.ts tests/tab-bar-middle-click.spec.tsx tests/manifest-consistency.spec.ts
pnpm run build
```

Expected: 三者全部 exit 0；`lib/` 重建出新的 client bundle。

- [ ] **Step 4: 提交**

```bash
git add src/client/index.tsx CHANGELOG.md
git commit -m "feat: 挂载右侧栏 tab 中键关闭并登记变更"
```

---

## Self-Review

**Spec 覆盖**：§2.1 委托模块 → Task 2；§2.2 `surface.close` 兜底 → Task 1；§2.3 相邻行为不变 → Task 2 的用例 6/7 与 Task 3 的回归门禁；§3 测试清单 → Task 2 的 9 个用例 + Task 1 的 1 个用例；§4 已知取舍 → 无需代码，已在设计文档记录。

**类型一致性**：`registerTabMiddleClick` 的签名在 Task 2 定义、Task 3 消费，均为 `{ closeTab: (tabId: string) => void }`；`ChipPress` 仅在模块内使用。

**未决**：无。
