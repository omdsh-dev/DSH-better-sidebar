# 原生右侧栏的中键关闭：由插件补回（2026-09-10）

> 起因：DSH 0.1.5 把右列交给宿主（v0.19.0-alpha.0 的承载面迁移）后，**中键关闭 tab 失效**。
> 本文记录定位证据、方案取舍与验证方式；实现见 `src/client/native/tab-middle-click.ts`。

---

## 1. 问题与证据

v0.18.x 的右侧栏是插件自绘的，中键关闭由 `src/client/TabBar.tsx` 提供（PR #145 的按下/释放语义）。
承载面迁移后，右侧栏的 tab 条由宿主渲染（`@deepseek-ai/dsh-client-ui-sidebar-right` +
`@deepseek-ai/dsh-client-ui-dockkit`），插件只贡献 tab 的**类型**、**正文**与**标题 chip**。

对运行中的 DSH 0.1.5-rc.1 前端包逐一核对（`/assets/index-*.js` 与本地安装包 sha256 一致）：

- dockkit 的 tab 元素只挂四个处理器：`onPointerDown`（`button!==2` → 拖拽跟踪）、`onClick`（激活）、
  `onKeyDown`（方向键 / Home / End / Enter / Space）、`onContextMenu`（右键菜单）；
- 全包只有 React DOM 自身的 `auxclick` 字样，**没有任何 `button===1` 分支**，也没有键盘关闭绑定；
- 关闭入口只有两个：× 按钮（`data-dockkit-tab-close`）与右键菜单项（`data-dockkit-menu-close`）。

结论：这不是插件回归，而是**宿主的 tab 条从未实现该手势**；插件的 TabBar 现在只服务底部工作台，
所以底部工作台的中键关闭仍然有效，右侧栏失效。

## 2. 方案取舍

| 方案 | 取舍 |
|---|---|
| **A. chip 标记 + 文档级捕获监听 + `tab.actions.close()`（采用）** | chip 是插件在原生 tab 里唯一渲染的元素，标记即归属；`actions.close()` 由宿主按 `(sessionId, tabId)` 绑定（`navigator.closeIn`），与 × 按钮同一条路径，无需探测/排队 |
| B. DOM 扫描 `[data-dockkit-tab]` + `ctx.sidebarRight.close(tabId)` | `close()` 只对**在屏会话**写入，跨会话要走不在接口里的 `closeIn`（需结构化探测）；且拿不到"这个 tab 是不是我的"的可靠判据 |
| C. 用插件的 records 判归属（`records.has`） | records 由**正文**渲染时铸造、卸载时丢弃 —— 后台 tab（非活动页签）没有记录，关闭会漏 |
| D. 反馈上游 | `deepseek-ai/deepseek-harness` **禁用了 issue**，且仓库硬约束禁止改 DSH 源码 |

## 3. 行为规格

- **归属**：只有带 `data-dsh-better-sidebar-native-tab` 标记的 chip（即插件自己的 tab）参与；
  宿主 tab（内置指南 / 文档预览 / 内置 files 复位后）完全不受影响——不 `preventDefault`、不 `stopPropagation`。
- **热区**：条带的整个 tab 元素（`[data-dockkit-tab]`）或浮动面板的**表头**（`[data-dockkit-float-grip]`），
  **绝不含面板正文**——终端与网页里中键是粘贴 / 后台打开，不能被当成关闭；宿主自己不渲染关闭控件
  （`canCloseTab` 为假）的 tab 也不参与，避免插件对"能否关闭"另立一套判断。
- **语义**（与 `TabBar.tsx`、VS Code、Chrome 一致）：中键**按下**落在插件 tab 上 → 记录；**释放**落在同一个
  热区内（含 × 与标题两侧的空白）才关闭；换位置释放、或漂移超过 4px（视为中键拖拽）→ 取消。
- **消费手势**：`pointerdown` + `mousedown` 上 `preventDefault()`（关掉 Chrome 中键自动滚动）与
  `stopPropagation()`（宿主的拖拽跟踪挂在 pointerdown 上，否则中键会变成拖 tab）；左键、右键、滚轮路径不变。
- **生命周期**：控制器每次客户端激活新建一个（非模块单例），随 `registerNativeSurface` 的 disposer 一起
  `dispose()`（解绑全部监听、清空已发布动作），不会在文档上留悬挂监听。

## 4. 已知边界

- 标题槽未渲染（该类型没注册 title，或 chip 尚未挂载）时没有标记 → 中键无动作；当前插件每个 tab 类型都注册了 title。
- 标记是插件自定义 data 属性（宿主契约允许 title 槽内容自定），若上游改变 chip 的宿主元素结构，
  受影响的是"整个 tab 都是热区"这一点，chip 自身仍可关闭。
- 浮动面板的表头标题同属该标题槽，因此浮动 tab 也支持中键关闭（热区是表头，不是整个浮动窗口）。

## 5. 验证

- 单测 `tests/native-tab-middle-click.spec.tsx`（12 例）：归属、按下/释放语义、漂移取消、单次结算、
  宿主 tab 不受影响、左键不受影响、动作发布/撤回、dispose 解绑、`NativeTabTitle` 集成。
- 真机挂载冒烟 `tests/e2e/mount.e2e.ts`：在真实 `dsh web` 里经插件文件树打开种子文件后，
  断言 chip 带标记 → `click({button:'middle'})` → 该 tab 在宿主 store 里消失（整条链路真机验证）。

## 6. 实施偏差

- 无（实现与本文一致）。
