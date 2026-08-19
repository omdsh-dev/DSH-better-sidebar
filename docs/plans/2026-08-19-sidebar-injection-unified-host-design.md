# 侧边栏面板注入方案设计：统一面板宿主（插件侧） + 官方槽位路线（上游侧）

**日期**：2026-08-19
**状态**：评审中（设计文档先行，实现待批准）
**作者**：DSH 工程模式会话
**当前版本**：v0.13.0（main）
**目标版本**：v0.13.x（不 bump 大版本）

## 1. 目标

1. 解决侧边栏面板的**注入方法**问题：找到一个同时兼容「纯浏览器 / Electron 套壳（DSH Desktop）/ 各类 Tauri/WebView 套壳 / 移动 webview」且**性能良好**的统一注入方案。
2. 消灭现有症状级补丁 PR 簇（#226 desktop 布局推挤、#135 dsh-web-mobile、#82/#108/#111/#138/#153 桌面标题栏）背后的结构性根因：**插件选择器深入宿主 DOM 形状（nth-child 锚点）+ 桌面壳依赖手动设置（titleBarCompat）+ 几何写路径分散（拖拽/状态两条）+ 懒加载缓存每次激活清空（重注入重执行）**。
3. 探索并文档化「官方槽位路线」：参考 DSH 内置插件 `ui-sidebar`（官方左侧边栏本身就是以插件方式占用 `sidebar` 槽），评估外部插件接管官方面板槽的可行性与代价，作为中期北极星；上游未落地前以插件侧方案为主线。

## 2. 非目标（Out of Scope）

- **不修改 DSH 官方源码**（仓库硬约束，`~/.dsh/source/current` 零写入）；官方槽位路线只产出 issue/设计建议给上游。
- 不做 shadow DOM / iframe 全隔离注入（令牌穿透、事件与 portal 代价高，仅在宿主样式污染实测出现时作为兜底启用）。
- 不重构 tab/viewer 扩展点本身（`ctx.betterSidebar` 服务契约不变）。
- 不承诺禁用官方 `ui-sidebar` 的行为由插件自动完成——那是 **profile 层用户决策**，插件只文档化。
- 不处理 #69（browser 探测，独立域）。

## 3. 已验证事实（证据先行，2026-08-19 核对）

### 3.1 当前注入实现（本仓库）

| 事实 | 证据 |
|---|---|
| 注入 = body 直下 `div[data-dsh-better-sidebar]` + **第二个 React root**（非 portal） | `src/client/index.tsx:120-141` |
| 宿主推挤 = html 上 `--dsh-sidebar-width/height` + `#root{margin-right}` + **`#root > [data-slot=root] > div > div:nth-child(2)` 锚点** | `src/client/layout.css:22-32` |
| 拖拽：pointer 事件 + rAF 单帧写面板尺寸与 html 变量（无强制 reflow 读） | `src/client/Sidebar.tsx:494-518` |
| 懒加载 chunk：每次激活 `resetChunks()` 清内存缓存 → 下次懒打开**重注入+重执行**脚本；HTTP 层已有 ETag 304（**不重下载**） | `src/client/index.tsx:120` 注释、`chunk-loader.ts` |
| 会话切换：只换 snapshot，面板 DOM 不重建（保持） | `Sidebar.tsx` store 驱动 |
| **已具备（实施勿重做）**：拖拽 rAF 批处理（`scheduleDrag` 单帧一次 `applyDrag`，无强制 reflow 读）；窄屏不推挤宿主（narrow 时宽/高变量写 0）；`measureCenter` ResizeObserver 已 rAF 节流；header 推挤已用弱锚点 `[data-slot="conversation.session.header"]` | `Sidebar.tsx:368-424,487-533,563-585`、`layout.css:45` |

### 3.2 DSH 官方架构（`~/.dsh/source/current`，只读）

| 事实 | 证据 |
|---|---|
| 外壳 = `#root` 单挂载点 + `__DSH_BOOT__` 引导；真实 UI 树全挂在 `root` 槽 | `apps/web/index.html:10-12`、`packages/client/web/src/app.tsx:38-43` |
| `ui-layout` 声明 `root` 槽的 children：`sidebar`/`conversation`/`details` 三个 **single 独占槽**；single 槽重复声明**抛错** | `ui-layout/src/client/index.ts:80-96`、`ui-slots/src/index.ts:747` |
| **官方左侧边栏 = 内置插件 `ui-sidebar`**：注册 `name:'sidebar'`，渲染在 AppFrame 的 grid 列内；几何经 layout store → `gridTemplateColumns` 内联传导（非 CSS 变量）；**官方不持久化宽度/折叠**；折叠按钮在 SidebarRoot 内自渲染并调 `ctx.layout.toggleSidebar()`；拖拽把手由 AppFrame 免费提供 | `ui-sidebar/src/client/index.ts:39`、`ui-layout/src/client/AppFrame.tsx:164-196` |
| `details` 槽（右侧面板）被 `ui-conversation` 的 DetailsPanel 占用；禁 ui-conversation = 会话列整体空置，代价极高 | `ui-conversation/src/client/apply.ts:445-458` |
| 官方浮层（Menu/Modal/Toast/HoverCard）全部 `createPortal(document.body)`——**body 级 portal 是官方姿势** | `ui-primitives/Menu.tsx:299`、`Modal.tsx:55-85` |
| 槽位注入消费者经 `slots.inject` 注入；槽未声明时**静默跳过**（禁用 ui-sidebar 不会炸树，但接管者需自实现会话/设置入口） | `runtime/src/client/slots.ts:130-192` |
| profile 可禁用内置插件行：`cordis.patch.yml` `- id: <plugin-id>` + `disabled: true`（皮肤 10 款禁用先例） | `~/.dsh/profiles/web/cordis.patch.yml` |
| 性能参考：拖拽 rAF 合并最新 delta 单帧应用 + `[data-dragging]` 禁过渡 + 纯函数让步结算 + 「关闭=宽 0 保活不卸载」 | `AppFrame.tsx:59-62`、`AppFrame.module.css:8-17`、`columns.ts:62-77` |

### 3.4 实证核对（真实 dsh web 页面，Playwright 探针，2026-08-19）

对 http://127.0.0.1:3080/（本机 profile，better-sidebar 已挂载）实测 DOM 与推挤行为：

| 事实 | 实测结果 |
|---|---|
| 外壳 DOM 链 | `#root > div[data-slot="root"]`（**display:contents**）`> div[data-dsh-frame]`（grid，CSS module 哈希类名） |
| frame 子项 | **5 个**：`[data-pane=sidebar]` / `[data-pane=conversation]` / `[data-pane=details]` / `[data-shell-overlay]`（浮层）/ 拖拽 handle——`nth-child(2)` 当前仍命中 centerCol，但**位置脆弱性实锤**（浮层/handle 已混入子项序列） |
| 稳定锚点 | centerCol 带 `data-pane="conversation"`；frame 带 `data-dsh-frame` → 弱锚点 = `#root [data-dsh-frame] > [data-pane="conversation"]` |
| ~~`[data-slot="conversation"]` 锚点候选~~ | **作废**：该元素 `display: contents`（无盒，margin 无效，rect 0×0） |
| 推挤无溢出（web） | 设 `--dsh-sidebar-width:300px` 后：`#root` margin-right 生效（过渡中 92px），`scrollWidth == clientWidth == 1440`，**无水平溢出** → `width: calc(100% - var)` 改动在 web 无副作用；桌面壳溢出修复（#226 目标）保留并标注「web 已验证无害、Desktop 待实测」 |
| 当前 host 本体 | `[data-dsh-better-sidebar]` 为 `position: static` 的普通块（fixed 在**内层面板**上）→ 新增 `data-dsh-panel-host` 固定含块层是宿主内新元素，外部契约不变 |
| 页面错误 | 0 个 pageerror（探针期间） |

### 3.3 桌面套壳（本机 DSH Desktop.app，Electron）

| 事实 | 证据 |
|---|---|
| 渲染 URL 注入信号：`?dsh-desktop-mode=<compatibility\|advanced>&dsh-desktop-platform=<…>` | `app.asar.unpacked/lib/src-B5373ech.js` |
| win32：`titleBarStyle:"hidden"` + `titleBarOverlay({height:32})`（右上角 32px 为窗口控制钮） | `electron-runtime-C_i38SKA.js:338-348` |
| darwin：`titleBarStyle:"hiddenInset"` + `trafficLightPosition(16,16)`（左上红绿灯区 ~78px） | 同文件 `:325-333` |
| 安全基线：`contextIsolation/sandbox:true`、`nodeIntegration:false`；preload 仅暴露 `__DSH_DESKTOP_FILE_PATH__` | `preload.cjs:5-9` |
| 社区 Tauri 套壳（kyorakuyk/dsh-desktop、Lotus-c/DSH-Desktop）用**原生系统标题栏**，fixed 语义与纯浏览器一致 | 子代理调研（来源 URL 见 §10） |
| 套壳最大注入风险：祖先 `transform/will-change` 劫持 fixed 包含块、标题栏 overlay 遮顶、drag 区吞事件、移动键盘盖 `bottom:0` | 子代理调研 |

## 4. 方案总览：双路线

```
路线 A（主线，本仓库可控）┐
  统一面板宿主：body 固定含块包裹层            ├─ 现在 → v0.13.x
  + 桌面信号自动适配 + rAF 几何批处理           │
路线 B（北极星，依赖上游）┘
  ui-sidebar 模式：占用官方槽位（grid 内渲染） ─ 上游落地后 → 迁移（浮层部分保留）
```

- **路线 A 立即做**：不依赖 DSH 新能力，纯插件侧，直接吸收桌面/移动/性能问题。
- **路线 B 并行提官方 issue**：请求上游提供「可替换/可接管的右侧面板槽」（details 支持外部替换或新增 bottom-panel 槽），落地后 better-sidebar 主体迁入 grid，body 浮层收敛为纯浮层（菜单/弹窗/右键，与官方 ui-primitives 同姿势）。

## 5. 路线 A 详细设计：统一面板宿主

### 5.1 挂载层（兼容性根因修复）

**A1.1 固定含块包裹层**：保留 body 级锚点（官方 portal 姿势），但结构升级为：

```
document.body
└─ div[data-dsh-better-sidebar]           ← 唯一锚点（属性不变，兼容既有契约/皮肤）
   └─ div[data-dsh-panel-host]            ← 新增：position:fixed; inset:0; pointer-events:none; z-index:40
      ├─ 右侧面板（absolute; right:0; pointer-events:auto）
      └─ 底部面板（absolute; bottom:0; pointer-events:auto）
```

- 面板在**自己的固定含块**内 absolute 定位 → 宿主中间层（套壳注入的 wrapper）transform 不再劫持面板 fixed 语义。
- 折叠按钮簇 z-index 45 不变（skin 契约 §8 同步）。
- **挂载自检（一次）**：挂载后对比 `getBoundingClientRect()` 与 `window.innerWidth/Height`；若 html/body 本身被套壳 transform/偏移（罕见），自动降级为「absolute + 每帧 rAF 同步宿主 rect」模式并 console.warn 一次。
- **MutationObserver 守卫（默认开，可关）**：body childList 变化检测锚点被宿主清空/挪位时自动重挂（SPA 导航/套壳重排兜底）；观察器廉价（仅 childList、无 subtree）。

**A1.2 桌面信号自动探测**（替代手动 titleBarCompat）：

- 信号源：URL `dsh-desktop-mode` / `dsh-desktop-platform`（Electron 官方注入）+ `window.__DSH_DESKTOP_FILE_PATH__` 存在性（preload 标记）+ UA 兜底。
- 适配表：

| 探测结果 | 自动适配 |
|---|---|
| win32 + advanced | 右上角保留 32px 标题栏 overlay 区：折叠按钮簇/设置按钮下移，面板顶部内边距 +32px |
| darwin | 左上角保留 ~78px 红绿灯区：左侧贴边控件（若存在）避让 |
| compatibility / 无信号 | 原生 frame，不避让（现状行为） |
| 移动 webview | 窄屏 overlay 抽屉 + `visualViewport` 键盘监听 + `env(safe-area-inset-*)` 内边距 |

- 保留现有手动开关（titleBarCompat）作为覆盖位，但默认值改为「自动」。

**A1.3 移动端**：窄屏（断点沿用 `breakpoints.ts`）面板从「推挤宿主」切「overlay 抽屉」：不写 `#root` margin、面板 transform 滑入滑出；`visualViewport` 变化（键盘弹起）时底部面板上移。

### 5.2 几何层（性能）

**A2.1 单一几何写入器**：现状有两条写路径——拖拽的 `applyDrag`（Sidebar.tsx:487-505）与打开态 effect（:563-585），都写同一组变量但互不感知。统一为 `writeGeometry({width,height})` 单函数，两条路径共用（拖拽仍走 `scheduleDrag` 的 rAF 单帧批写）；折叠/会话恢复等非拖拽变更也收敛到它。**不改变对外契约**：`--dsh-sidebar-width/height` 变量与 `#root` margin 推挤机制不变。

**A2.2 拖拽**（现状已达标，微调即可）：

- pointer capture + 最新 delta + 单帧 rAF 应用（**已具备**，保留）；
- 拖拽期 `body[data-dsh-sidebar-dragging]` 禁过渡（**已具备**，`layout.css:49`）；
- 新增：拖拽期面板根挂 `will-change: transform`；面板根常驻 `contain: layout style`（CSS 一处，隔离内部布局回流）。

**A2.3 chunk 缓存精确化**：HTTP 层已 304 不重下载；缺口只在「激活后内存缓存清空 → 重注入+重执行」。改为：缓存键 = chunk 名 + 脚本内容哈希；激活时若哈希未变则保留内存缓存（跳过重注入），仅 HMR 核心 bundle 变化（版本变化）才清。保留失败路径（失败清缓存重试）。

**A2.4 保活策略（保持现状并文档化）**：面板 DOM 跨会话不重建；tab 内容按 `visible` prop 懒挂载/卸载；树/终端等重组件不随会话切换重挂。

### 5.3 契约层（可维护性）

- **锚点弱化**：`layout.css:31` 的 `#root > [data-slot=root] > div > div:nth-child(2)` 替换为 `#root [data-dsh-frame] > [data-pane="conversation"]`（稳定 data 属性锚定，实证见 §3.4；`[data-slot="conversation"]` 为 display:contents 不可用）；推挤逻辑收敛进几何写入器（一处实现）。
- **推挤可关闭**：`SidebarPrefs` 新增（或复用既有）「宿主推挤」开关，默认开；桌面套壳/移动端自动切 overlay 时关闭推挤（修 #226 根因：不再依赖 `#root{width:100%}` 之外的宿主形状）。
- **契约文档化**：挂载点（`data-dsh-better-sidebar` / `data-dsh-panel-host`）、z-index 栈、CSS 变量（`--dsh-sidebar-width/height` 保持对外）、桌面信号（URL/全局标记）、推挤锚点策略 —— 同步 AGENTS.md §8 与本文档。
- **服务契约不变**：`ctx.betterSidebar` API 零变化；#135 的 service 读取问题（dsh-web-mobile 下 `ctx.betterSidebar` 直接读抛错）由「注入层与服务的解耦」顺带收敛（面板渲染不再假设服务存在即可读）。

### 5.4 性能清单（验收口径）

| 指标 | 现状 | 目标 |
|---|---|---|
| 拖拽期宿主 layout 次数 | 每帧 1 次批写（`applyDrag` rAF，已达标） | 保持；拖拽 0 次 reflow 读 |
| 懒加载 chunk 二次打开 | 不重下载（304）但重注入+重执行 | 内容哈希不变 → 内存缓存命中，0 脚本执行 |
| 会话切换 | 面板 DOM 不重建（已满足） | 保持 + 重组件懒挂载 |
| 面板显隐动画 | transform+width/margin 过渡 | transform 优先（overlay 模式），推挤模式过渡保留 |
| 观察器 | ResizeObserver 已 rAF 节流（已达标） | 保持；新增挂载自检/MutationObserver 守卫均为一次性廉价检查 |

## 6. 路线 B 详细设计：官方槽位迁移（ui-sidebar 模式）

### 6.1 可行性结论（已验证）

- **`sidebar` 槽：可接管**。条件：profile 层 `cordis.patch.yml` 禁用 `ui-sidebar`（`disabled: true`），`ui-layout` 必须保留；接管者需自实现 `sidebar.workspaces`/`sidebar.settings` 子槽内容或留空（`slots.inject` 静默跳过，不炸树）；折叠按钮自渲染 + `ctx.layout.toggleSidebar()`；宽度/折叠持久化**自做**（官方不持久化）。
- **`details` 槽：不可行（当前）**。唯一占用者 ui-conversation 的 DetailsPanel 与其会话 UI 同包，禁用即空置会话列；需上游把 DetailsPanel 拆为可替换槽位或提供优先级机制。
- **几何传导**：槽位渲染在 AppFrame grid 列内，官方拖拽把手/折叠/让步结算免费生效；session scope 槽的 sessionId 由框架注入为标准 prop。

### 6.2 上游 issue 建议（本仓库只出建议，不改源码）

1. 将 `details` 槽的占用者改为**可替换**（如 single 槽支持「替换注册」或 DetailsPanel 拆独立包），使外部插件能接管右侧面板。
2. 新增（或声明）`bottom-panel` 槽，供底部面板类插件使用。
3. ui-sidebar 宽度/折叠持久化下沉到 layout store（官方侧目前不持久化）。

**issue 草案（PR3 提交时使用，已备好）**：

> **Title**: External plugins cannot take over the `details` panel slot
> **Repo**: deepseek-ai/dsh（或官方插件仓库）
> **Body**:
> - Context: `ui-layout` declares `root` → `{sidebar, conversation, details}` as single-exclusive child slots. `ui-conversation`'s DetailsPanel is the sole occupant of `details`; an external panel plugin (e.g. dsh-better-sidebar) cannot register into it without disabling `ui-conversation` (which empties the conversation column). Meanwhile `ui-sidebar` (the official left sidebar) is itself a plugin and CAN be replaced from the profile layer (`cordis.patch.yml` `disabled: true`), which proves the pattern.
> - Ask: make the `details` occupant replaceable — either (a) allow single-slot "replacement registration" with explicit opt-out by the default occupant, (b) extract DetailsPanel into a standalone optional plugin so profiles can disable it without losing the conversation column, or (c) declare a new `bottom-panel` slot for bottom panel plugins.
> - Reference implementation to mirror: `ui-sidebar/src/client/index.ts:39` (register `name:'sidebar'`), `ui-layout/src/client/AppFrame.tsx:164-196` (grid geometry + drag handles come free), `runtime/src/client/slots.ts:130-192` (`slots.inject` consumers skip silently when a slot is undeclared).

### 6.3 迁移路径（上游落地后）

1. better-sidebar 增加「槽位渲染后端」：注册 `details`/`bottom-panel` 槽，`Sidebar` 树渲染进 grid（同一套 store/组件，仅挂载点不同）。
2. body 浮层收敛为纯浮层：菜单、弹窗、右键、拖出浮窗（与官方 ui-primitives portal 同姿势）。
3. 保留路线 A 的固定含块层作为浮层宿主；推挤/几何写入器退役（grid 接管）。

### 6.4 收益与代价

| 收益 | 代价 |
|---|---|
| 零 body 注入、零宿主 DOM 依赖 | 契约绑定上游 SlotMap，DSH 升级需跟随 |
| 官方几何/拖拽/折叠/让步结算免费 | 官方不持久化宽度，需自做持久化 |
| 任何套壳天然一致（grid 与套壳无关） | 上游排期不可控（issue 周期） |
| 拖拽性能与官方同源 | 迁移期间双后端并存（维护成本） |

## 7. 兼容矩阵（注入策略 × 场景）

| 场景 | body 固定含块（路线 A） | 官方槽位（路线 B） | shadow DOM | iframe |
|---|---|---|---|---|
| 纯浏览器 | ✅ 推荐 | ✅ | ✅（令牌穿透） | ⚠️ 令牌/交互断裂 |
| Electron 套壳（DSH Desktop） | ✅ + 信号自动避让 | ✅ | ✅ | ⚠️ |
| Tauri 套壳（原生标题栏） | ✅ | ✅ | ✅ | ⚠️ |
| 移动 webview | ✅ + overlay 抽屉/visualViewport | 需上游槽位 | ✅ | ⚠️ |
| 页面内嵌 iframe | ⚠️ 需宿主放行 | ❌ | ✅ | ✅（天然隔离） |
| 祖先 transform 劫持 | ✅ 自检降级 | ✅ 天然免疫 | ✅ | ✅ |
| 性能（拖拽/显隐） | rAF 批写 + contain | 官方 grid | 中 | 低 |

## 8. 实施拆分与验证

### 8.1 拆分（文件级改动清单）

- **PR1（核心注入 + 性能，外部契约零变化）**
  - `src/client/index.tsx`：挂载结构升级——`host` 内新增 `data-dsh-panel-host` 固定含块层（`position:fixed; inset:0; pointer-events:none; z-index:40`），面板子级 `pointer-events:auto`；挂载后一次性自检（`host.getBoundingClientRect()` vs 视口，偏差阈值内通过；否则降级 absolute+同步模式并 warn 一次）；`MutationObserver`（仅 body childList）守卫锚点被宿主清空时重挂。
  - `src/client/Sidebar.tsx`：抽取 `writeGeometry` 统一两条写路径（`applyDrag` + 打开态 effect）；拖拽/折叠行为不变。
  - `src/client/chunk-loader.ts` + `index.tsx`：缓存键加内容哈希，激活时哈希未变保留内存缓存（跳过重注入）。
  - `src/client/layout.css`：底部推挤锚点 `nth-child(2)` → `#root [data-dsh-frame] > [data-pane="conversation"]`（§3.4 实证的稳定锚点，注释更新）；`#root` 增加 `width: calc(100% - var(--dsh-sidebar-width, 0px))` 消除桌面壳 margin 溢出（#226 目标以根因方式吸收；web 环境实测无溢出、改动无副作用，Desktop 实测待 PR1 验证）；面板根 `contain: layout style` + 拖拽期 `will-change`。
  - 测试：`tests/` 新增几何写入器单测（fake timers 断言单帧单写）、挂载自检降级单测；`tests/e2e/mount.e2e.ts` 深扫不变并新增 `data-dsh-panel-host` 断言。
- **PR2（桌面/移动自动适配 + 契约文档）**
  - 新增 `src/client/desktop-env.ts`：解析 URL `dsh-desktop-mode/platform` + `__DSH_DESKTOP_FILE_PATH__` → 类型化 `DesktopEnv`（win32-advanced / darwin / compatibility / web / unknown）。
  - `Sidebar.tsx` + CSS：win32-advanced → `--dsh-desktop-top-inset: 32px`（折叠按钮簇/面板顶部内边距避让）；darwin → 左侧红绿灯区避让（~78px，仅左侧贴边控件）；现有 `titleBarCompat/titleBarStripPx`（`lib/types/prefs-shared.d.ts:77-84`）降级为手动覆盖位，默认「自动」。
  - 移动端：`visualViewport` 键盘弹起时底部面板上移（`resize` 事件 + rAF 节流，沿用 `useNarrowViewport` 模式）；CSS 加 `env(safe-area-inset-*)` 内边距。
  - 契约文档：AGENTS.md §8 同步（挂载点/`data-dsh-panel-host`/z-index/桌面信号/推挤锚点策略）。
- **PR3（可选）**：路线 B 上游 issue 提交（§6.2 草案已备）+ 槽位渲染后端原型（feature-flag 后）。
- 各 PR 独立可验证；PR1 不依赖 PR2。

### 8.2 验证

- **单元**：几何写入器 rAF 批处理（fake timers 断言单帧单写）；桌面信号解析（URL param × platform × 全局标记）；挂载自检降级路径；chunk 缓存命中/失效。
- **e2e**：`tests/e2e/mount.e2e.ts` 深扫保持不变并新增断言：`data-dsh-panel-host` 存在、锚点属性不变；新增 desktop-mode URL 参数场景（模拟 win32 advanced → 顶栏避让类生效）。
- **skin 契约**：`tests/theme.spec.ts` 令牌读取不变（§8 契约同步守护）。
- **CI**：全绿门禁（build/typecheck/test/consumer-types/plugin-mount）；#180 的 plugin-mount flake 与本次改动无关，重跑确认。
- **度量**：拖拽期 PerformanceObserver 记录 layout 次数；懒加载二次打开网络计数为 0。

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 固定含块改变既有 fixed 行为（罕见宿主） | 挂载自检 + 降级模式；锚点属性/CSS 变量不变，可一键回退旧实现 |
| 几何写入器集中化引入回归 | PR1 内保留旧写入路径开关（feature-flag），e2e 深扫覆盖 |
| 桌面自动探测误判（套壳改 URL 格式） | 信号解析白名单 + 手动覆盖位保留 |
| 路线 B 上游不落地 | 路线 A 完整自洽，不阻塞 |
| 禁用 ui-sidebar 属 profile 用户决策 | 插件仅文档化，不自动执行 |

## 10. 参考来源

- DSH 源码：`~/.dsh/source/current`（只读）：`ui-layout/src/client/{index.ts,AppFrame.tsx,columns.ts,stores.ts,AppFrame.module.css}`、`ui-slots/src/index.ts`、`ui-sidebar/src/client/index.ts`、`ui-conversation/src/client/apply.ts`、`ui-primitives/Menu.tsx`、`runtime/src/client/slots.ts`
- DSH Desktop 运行时（本机 .app，只读）：`lib/src-B5373ech.js`、`lib/electron-runtime-C_i38SKA.js`、`lib/preload.cjs`
- 社区套壳：kyorakuyk/dsh-desktop（https://github.com/kyorakuyk/dsh-desktop）、Lotus-c/DSH-Desktop（https://github.com/Lotus-c/DSH-Desktop）
- 本仓库：`src/client/index.tsx`、`src/client/Sidebar.tsx`、`src/client/layout.css`、`docs/plans/2026-08-15-skin-compat-design.md`
- 相关 PR：#226、#135、#82、#108、#111、#138、#153（症状级补丁，本方案吸收其目标）；#208/#90（issue）

## 11. 决策记录与实施偏差记录

- 2026-08-19（第一轮）：方案定稿——路线 A（统一面板宿主）为主线、路线 B（官方槽位）并行提 issue；先出设计文档，实现拆 PR1/PR2 待批准。
- 2026-08-19（第二轮，实施就绪打磨）：对照源码核实现状——拖拽 rAF 批处理/窄屏不推挤/观察器节流/header 弱锚点**已具备**（§3.1 已标注「实施勿重做」）；chunk 缺口精确为「激活后内存缓存清空重注入」（HTTP 已 304）；§8.1 落到文件级改动清单；§6.2 备好上游 issue 草案。**等待用户批准后开 PR1**。
- 2026-08-19（第三轮，实证核对）：真实 dsh web 页面 Playwright 探针（§3.4）——frame 子项已含 overlay/handle（nth-child 脆弱性实锤）；`data-pane="conversation"` 为新弱锚点（`[data-slot=conversation]` display:contents 作废）；推挤在 web 无溢出（calc 改动无害）；host 本体 static（fixed 在内层面板，含块层为新元素）。设计文档据此更新 §5.3/§8.1。
- 实施偏差记录：待实施时按既有文档惯例补充。
