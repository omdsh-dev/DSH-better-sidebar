# 任务输出常驻浮动窗 + 节点卡去竖线 + 手机设置

日期：2026-09-27　分支：`feat/tasks-graph-polish`（承接 PR #680 的打磨线）

## 背景（用户原话）

> 1. 后台任务弹窗没有高度限制，输出很长会导致看不到。同时让其变为常驻的全屏弹窗(带关闭/拉伸，建议抽取为全局组件方便后续复用)
> 2. 优化节点UI，加上圆角，同时取消左侧装饰条，让整个节点看起来更为统一
> 3. 设置中新增手机设置，里面放各种和手机端的适配设置，目前加上这么几项：检测到处于手机状态时，有新的后台任务或Agent任务时不会自动弹出，任务管理的默认状态切换为树状图

## 用户确认的决策（问答摘要）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 弹窗形态 | 可拖拽 + 可拉伸的**常驻浮动窗**（默认约视口 70%×60%，最小 320×240） |
| 2 | 复用范围 | 抽成**全局组件**，本轮只把后台任务输出换过去（节点/工作流详情、任务窗保持现状） |
| 3 | 常驻边界 | 只靠**关闭按钮 / Escape**；外部点击、失焦、锚点离屏都不关；切会话/关标签、任务结算后都保留 |
| 4 | 左侧竖条 | 「就是左侧的竖条，这个去掉」 |
| 5 | 层级组色 | 「这个可以留着，只是那个竖线不要了」 |
| 6 | 当前会话标记 | 「边框加粗高亮即可」 |
| 7 | 圆角 | **8px**，并**保留类型描边**（成员 accent 描边、工作流 accent 描边 + 底色） |
| 8 | 手机设置 | **自动检测（沿用 768px 窄屏判定）+ 两个独立开关（默认都开）**，分组放在设置页 |

## 架构与文件

```
新增
  src/client/FloatingWindow.tsx         常驻浮动窗（拖拽 + 拉伸 + 关闭，内容区自滚动）
  src/client/FloatingWindow.module.css  窗框/标题栏/内容区/底部行/三个拉伸柄样式
  tests/floating-window.spec.tsx        9 例：结构、尺寸与定位、关闭契约、两个手势
改写
  src/client/JobsDrawer.tsx             JobOutputPopoverContent → JobOutputWindow
  src/client/SubagentView.tsx           任务分支改渲染窗口；默认视图加窄屏覆盖
  src/client/tasks-graph.module.css     卡片：去两条左侧竖条、圆角 8px、当前会话 1.5px 描边
  src/client/sidebar/use-host-feeds.ts  两个自动弹出 gate 加手机压制
  src/client/SideCardSection.tsx        新增「手机」分组（两行开关）
  src/prefs-shared.ts / src/config.ts / src/client/prefs.ts
                                        两个新偏好 mobileNoAutoOpen / mobileDefaultTree
  src/client/locales*.ts（20 份）       5 条手机设置词条
```

## 关键设计

### 1. 常驻浮动窗（`FloatingWindow.tsx`）

- **为什么不是复用 `AnchoredPopover`**：那是 popover —— 锚定元素、按内容定尺寸、外部 mousedown / window blur / 锚点离开视口都会关它。被**持续观察**的面（一个跑几分钟的任务输出）需要的恰好相反的生命周期：只有关闭按钮与 Escape 结束它，而且必须能挪开、能拉伸。
- **内容区就是高度上限**：`data-window-body` 自己 `overflow: auto`，所以「输出很长看不到」这条被结构性修掉（旧 popover 完全没有高度约束，`.popPre` 那个 160px 滚动井在改用 `TerminalBlock` 之后已成死规则 —— 本轮一并删掉）。
- **手势复用既有范式**：移动走 window 级 `pointermove`（同 `AnchoredPopover` 的拖拽，容器捕获会重定向 click、杀掉窗内按钮），拉伸走 `setPointerCapture` + `createFrameBatcher()`（同 `EditorHost` 的面板拉伸；逐事件 setState 是 #315 的拖拽卡顿）。
- **几何**：`position: fixed`；尺寸在**挂载时量一次**（之后每条流式输出帧都不会挪动读者摆好的窗）；拖拽保证标题栏至少 48px 留在视口内；拉伸夹取到 `minSize` 与视口；window `resize` 时把窗夹回视口。
- **常驻**：不注册外部 mousedown / blur / IntersectionObserver；只注册 Escape（捕获阶段）。
- **皮肤契约**：令牌全量、8px 圆角与节点卡一致、浮动层保留 `--dsw-shadow-lv3`。

### 2. 任务输出接入

- `JobOutputWindow`：标题栏（任务 label + 复制按钮 + 关闭）／内容区（状态行 + `TerminalBlock`，`maxLines: Infinity` 保留「看完整输出」）／底部行（跟随最新 + 两击终止）。
- **顺带修掉的 bug**：「跟随最新」原先滚的是包在 `TerminalBlock` 外面的普通 `div`（永不滚动）——现在滚窗口内容区。
- 页面侧：`popover.kind === 'job'` 不再走 `AnchoredPopover`；节点/工作流详情仍是 280px 锚定小卡，任务窗不变。
- 任务从宿主 roster 消失时窗口关闭（无处再观察）；**结算不掉行，窗口继续**。

### 3. 节点卡（`tasks-graph.module.css`）

| 变更 | 说明 |
|---|---|
| 删除 `.cardTop::before` | 层级竖条；层级改由上段极淡底色承担，并把色调从 7/5/3.5/2.5% 抬到 **9/7/5/3.5%** 补偿对比度损失 |
| 删除 `.nodeCurrent::before` | 当前会话竖条；`.nodeCurrent` 改为 **2px accent 描边**（「边框加粗高亮」） |
| `.node` 圆角 4px → **8px** | 与新的浮动窗同一圆角，卡与窗成为一个家族 |
| `.cardTop` 左内边距 10px → 8px | 竖条消失后的回正 |
| `.nodeTeam` / `.nodeWorkflow` / `.nodeFold` / `.nodeError` | 按用户选择**保留**类型区分；只继承新圆角 |
| 删除 `.popPre` / `.jobPopPre` | 随旧弹窗一起死掉的规则 |

**几何安全性**：`.node` 是 `box-sizing: border-box` + 布局给的 `min-height`，加粗描边被吸收在盒内，卡片外框尺寸不变 —— `tasks-graph-layout.ts` 的高度/行距预算**不需要改**，`tests/tasks-graph-layout.spec.ts` 保持全绿。

### 4. 手机设置

| 键 | 默认 | 语义 |
|---|---|---|
| `mobileNoAutoOpen` | true | 窄屏时**同时**压制子代理与后台任务两个自动弹出（既有两个开关的值不被改写；宽屏行为不变） |
| `mobileDefaultTree` | true | 窄屏时任务页默认树状图（页内切换仍是临时覆盖，优先级最高） |

- 判定沿用插件既有的 `isNarrowWidth`（768px 断点，与侧边栏手机布局、park 逻辑同源），在**触发时**读视口。
- 设置 UI：DSH 设置页「侧边卡片」分区新增「手机」分组（两行 title/desc + 宿主 `Switch`，走既有 `applyPref` 写入）。

## 实施偏差记录（写给复审）

1. **窗口尺寸只在挂载时量一次**（`useEffect(..., [])` + 一条 eslint-disable）：若跟着 props/内容重算，每条流式输出帧都会把读者拖好的窗口弹回去。视口变化仍会夹取。
2. **`aria-label` 用 `<title>` 而不是 `<h1>` 之类**：与既有 `AnchoredPopover`/`Modal` 的可访问名做法一致（`role="dialog"` + 可访问名）。
3. **拉伸只给三个柄**（右、下、右下）：实际用法是「日志变长 → 往右下长」，两轴各自还可单独拉；八个柄属于没被要求的能力。
4. **没有做焦点陷阱**：与插件现有的两个浮层（`AnchoredPopover` / 宿主 `Modal` 之外的弹窗）一致；Escape 是唯一键盘出口。
5. **窄屏自动激活的既有两个 spec 显式关掉了手机开关**：它们钉的是「窄屏也激活 + 收回列（park）」这条更早的承诺，而压制行为有自己的新用例；把 harness 的默认值改成「关」会让 spec 脱离真实默认，所以选择在用例里显式声明。
6. **`mobileDefaultTree` 只在有 store 时生效**：`SubagentView` 的 prefs 来自 `store` prop，spec harness 里多数用例不传 store（读作 `graph`）；视图默认的新用例显式传入 `createSidebarStore()`。
7. **当前会话的加粗描边用 2px 而不是 1.5px**：真机自测发现 Chromium 在 device-pixel ratio 1 下**向下取整**亚像素边框宽度 —— 1.5px 的计算值直接是 1px，"加粗"完全看不出来（recon 实测 `borderTopWidth: "1px"`，而 class 与 accent 颜色都在）。改成整数 2px 后在 DPR 1 与 2 上都成立。
8. **`.popPre` / `.jobPopPre` 被删除**：旧 `jobs` 弹窗改用 `TerminalBlock` 之后它们就没有消费者了，本轮顺手清掉（与上次「drop the dead rules」同类）。

## 验证证据（2026-09-27）

| 项 | 结果 |
|---|---|
| `pnpm typecheck` / `pnpm lint` | ✅ 0 错误 |
| `pnpm test` | ✅ **1254 passed / 9 skipped / 0 failed**（120 文件；新增 14 例：窗口 9 / prefs 1 / 设置分组 1 / 自动激活压制 2 / 视图默认 1） |
| 真机挂载 lane | ✅ **7 passed**（真实 DSH 0.1.7-rc.2，scratch profile + 无头渲染 + 全 tab 扫描 + 性能测量；日志 `/tmp/e2e-win.log`） |
| 3080 真机自测 | ✅ 见下表（真实工作：长输出后台任务 + 子代理；截图 `/tmp/dsh-selfcheck/10-13-*.png`） |

### 3080 真机证据（逐项）

| 项 | 实测 |
|---|---|
| 卡片去竖条 + 圆角 + 加粗描边 | `radius: 8px`；`::before` 的 `content: none`（层级条与当前会话条都不存在了）；当前会话 `borderTopWidth: 2px` + `rgb(65,118,230)`（accent）；卡片外框 **247×134** 与布局预算逐像素一致（去掉竖条/加粗描边都不改几何） |
| 窗口限高（原始 bug） | 240 行输出的任务：窗口 1008×540 全在 1440×900 视口内，内容区 `scrollHeight 5459 > clientHeight 449` —— **真的在窗内滚动**；滚到底能看到末行 `THE-END` |
| 窗口结构 | 标题栏（任务名 + 复制 + 关闭）、内容区、底部行（跟随最新 + 终止）与三个拉伸柄（x / y / both）都在 |
| 拖拽与拉伸 | 拖标题栏：(424,352) → (304,352)；拖右下角：1008×540 → **918×480** |
| 常驻语义 | 外部点击（窗口上方面板区、左侧会话列）后窗口仍在（count 仍为 1）；Escape 关闭 |
| 手机适配 | 窄屏（700×900）起后台任务 + 子代理后，右侧栏**未被打开**（`data-sidebar-right-panel` 不存在）；手动打开任务页 → `tree: 2 / graph: 0`（默认树状图） |

### 真机自测发现并修掉的两处

1. **1.5px 的「加粗」边框在 DPR 1 下等于 1px**：Chromium 向下取整亚像素边框宽度，真机上完全看不出加粗（recon 实测 `borderTopWidth: "1px"`，而 class 与 accent 颜色都在）。改成整数 **2px**（DPR 1 与 2 都成立）。
2. **拖拽只保证标题栏可达，会把窗口的右下角推出视口**：第一次真机拖拽后窗口底部落到 y=932（视口 900），拉伸柄随之点不到。改为「放得下就整窗留在视口内，放不下才退化成保留 48px 可达」——两个轴都套用，视口变化时同样处理。

### 未在真机复现 / 已知限制

- 关掉两个手机开关后的真机行为（真机只验了默认开启的一侧；关闭一侧由单测覆盖，且既有窄屏 park 用例显式关掉该开关后仍然全绿）。
- **切会话会关掉窗口**：窗口状态属于该会话的 Tasks 页组件，宿主在切走时卸载该会话视图（实测点击左侧会话列表即窗口消失）。设计文档已列为限制：若要真正跨会话常驻，需要把开启状态提到 `SidebarStore`（本轮范围外）。
