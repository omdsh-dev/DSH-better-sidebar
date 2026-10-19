# 右侧栏 tab 中键关闭

日期：2026-10-19　分支：`feat/tab-middle-click-close`（从 `dev` 切出）

## 1. 背景与现状证据

用户要求「中键关闭 Tab」。查证后这条能力**只有一半存在**：

| tab 条 | 渲染方 | 中键关闭 |
|---|---|---|
| 底部 workbench 分屏 (`src/client/TabBar.tsx`) | 插件自己 | **已实现**，提交 `76aacdd`，8 个用例在 `tests/tab-bar-middle-click.spec.tsx` |
| 右侧栏顶部 strip | 宿主 `ui-dockkit` 的 `TabStrip` | **不存在** |

宿主无此能力的三处证据：

1. `packages/client/ui-dockkit/src/components/TabPanel.tsx`：chip 的 `onPointerDown` 只对 `event.button === 2` 提前 return，其余一律交给 `callbacks.onTabPressed`（拖拽/选择起点）；chip 上没有 `onMouseDown` / `onAuxClick` / 任何 `button === 1` 分支。
2. `PaneCallbacks` 没有中键相关成员，宿主也不给插件注入 chip 级 handler 的缝。
3. `rg 'button === 1|auxclick' packages/` 在宿主全树只命中 `experimental/session-inspector` 的一个指针事件常量表，与 tab 无关。

因此插件侧只有两条路：改宿主源码（违反零源码 patch，否决）或 DOM 事件委托（采纳）。

### 右侧栏里有哪些 tab

宿主自己只注册了一个 tab 类型 `guide`（`ui-sidebar-right/src/client/tabs/guide/definition.ts`），其余（explorer / 编辑器 / 改动 / 任务 / 终端 / 侧边对话 / diff …）都是本插件经 `ctx.sidebarRight` 注册的 descriptor。用户确认**全部 chip 都要支持**，含「指南」。

### 关闭通道的现状与缺口

`service.closeTab(tabId)` 是唯一完整入口（`src/client/service.ts:1293`）：先问 `surface.close`，插件 tab 走 `records.drop` + `controller.close` 并回调 descriptor 的 `onClose`（未保存保护、dirty 询问都在那条路上）；否则回落 bottom-workbench 的 store reducer。

`surface.close` 对**插件没有记录**的 tab 直接 `return undefined`（`src/client/native/surface.ts:268`）。「指南」永远没有记录，且插件的 tab 若非激活过、body 从未渲染，`records.ensure` 也没铸造过它 —— 这两类 tab 今天都关不掉。所以中键功能必须同时补上这个兜底，否则会出现「有的 chip 能关、有的点了没反应」。

## 2. 设计

### 2.1 新模块 `src/client/native/tab-middle-click.ts`

导出 `registerTabMiddleClick({ service })`，返回 disposer（经 `ctx.effect` 挂载，随 fiber 释放）。单个 document 级监听器，全插件单例，不按 tab/session 复制。

**按下**（capture 阶段，两路都要拦）：

| 事件 | 处理 | 为什么这一路不可省 |
|---|---|---|
| `pointerdown` `button === 1` | `stopPropagation` | 宿主在 chip 上用 `onPointerDown` 起拖拽；不拦就会把中键当拖拽起点 |
| `mousedown` `button === 1` | `preventDefault` | 抑制 Chromium 的中键 autoscroll；不拦会进入滚动模式 |

命中判据（三者同时满足才记录，否则什么都不做、**也不 preventDefault**）：

```
target.closest('[data-dockkit-tab]')                 // 宿主 chip，tabId = chip.dataset.dockkitTab
&& chip.querySelector('[data-dockkit-tab-close]')    // 宿主自己的 closable 判据在 DOM 上的投影
```

第二个条件直接复用宿主「可关」的可见判据（有 × 按钮才有 `data-dockkit-tab-close`），不自己重写 canCloseTab 策略，也不会对独存且不可关的 chip 抢走浏览器默认行为。

**松开**：window 级 `mouseup` `button === 1`，仅当记录仍在、节点仍 `isConnected`、且 `pressed.node.contains(event.target)` 时关闭；无论成立与否都清空记录（一次按下只结算一次）。这就是 VS Code / Chrome 的 release-position 语义，与 `TabBar.tsx` 已实现的那份一致：按下后在别处松手 = 取消。

**关闭动作**：`service.closeTab(tabId)`。它已经负责插件 tab 的生命周期回调与 workbench 回落，中键不另开一条关闭路径，未保存保护自动继承。

### 2.2 `surface.close` 兜底（`src/client/native/surface.ts`）

`records` 无记录时不再直接返回，而是在 controller 可用时调 `controller.close(tabId)`（跨会话场景沿用现有 `closeIn` 分支的判据），返回值仍是 `undefined`。

这样 `service.closeTab` 的行为变成：插件 tab → 完整生命周期；宿主 tab（指南）/ 未铸造记录的插件 tab → 宿主自己关掉，skill 收尾时回落到 store reducer（`tabOpenIn` 不匹配即原样返回，无害 no-op）。

**为什么不新增独立方法**：现有 `SidebarSurface.close` 的契约是「关这个 id 的 native tab」，兜底是这个语义的补全，不是新语义；加一个平行方法会让「关 tab」有两个入口，调用方还得自己选。

### 2.3 必须保持不动的相邻行为

- 左键点击 = 激活；右键 = 宿主 tab 菜单（`onContextMenu` 那条完全不经手）。
- 终端 tab 的 xterm 中键粘贴：xterm 在 chip **之外**的 body 里，`closest('[data-dockkit-tab]')` 不命中。
- 插件自己的 `TabBar`（底部 workbench）的 tab **没有** `data-dockkit-tab`，不会与已实现的中键路径双重触发。
- 悬浮窗（float）的 chip 同样由 dockkit 渲染、同样带 `data-dockkit-tab` → 顺带获得中键关闭，视为一致收益而非新范围。

## 3. 测试

新增 `tests/tab-middle-click-native.spec.ts`（jsdom，与 `tab-bar-middle-click.spec.tsx` 同一套写法：直接派发原生事件、断言 service 调用）。用例：

1. chip 上按下 + 松开 → `service.closeTab(tabId)` 恰好一次
2. `pointerdown` 被 stopPropagation（宿主拖拽不会起）
3. `mousedown` 的 `defaultPrevented === true`（autoscroll 被抑制）
4. 按下后松在别处 → 不关；随后在 chip 上再松一次仍不关（一次性）
5. 松在**另一个** chip 上 → 不关
6. 无 `[data-dockkit-tab-close]` 的 chip → 完全不拦（`defaultPrevented === false`，不调 close）
7. 左键按下松开 → 不关
8. 只有 `auxclick` 而没有记录 → 不关（钉住「结算在 mouseup 而不是 auxclick」）
9. disposer 之后 → 不关

`tests/native-surface.spec.ts` 追加：`records` 无记录时 `close` 仍调用 controller 的 `close`。

## 4. 已知取舍

- **依赖两个宿主 DOM 属性** `data-dockkit-tab` / `data-dockkit-tab-close`。宿主改名则功能静默失效（表现为中键无反应，不报错、不影响其他路径）。宿主自己的 `ui-sidebar-right/src/client/focus.ts` 也在 `querySelector` 同一批 `data-dockkit-*` 属性，属已存在的同类依赖；`native-surface.spec.ts` 之类契约测试不覆盖它，故在此显式记录。
- 不实现「中键关闭后激活哪个 tab」的额外策略：完全交给宿主的 close 切换逻辑与插件的回落，与点 × 按钮的结果一致。
- 不做可配置开关：行为与浏览器/VS Code 一致，无配置价值。
