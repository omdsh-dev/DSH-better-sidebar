# 浮层让出桌面壳的原生窗口控件带

日期：2026-11-04　分支：`fix/floating-window-titlebar-band`

关联 issue：[#805](https://github.com/omdsh-dev/DSH-better-sidebar/issues/805)（mermaid 放大图工具栏，同一根因）、PR [#812](https://github.com/omdsh-dev/DSH-better-sidebar/pull/812)（读已删除变量，无效）、[#430](https://github.com/omdsh-dev/DSH-better-sidebar/issues/430) / [2026-10-05 移除 titleBar 让位机制](2026-10-05-remove-titlebar-compat-strip.md)（被删的旧机制，本方案与之无关）

## 症状与根因

用户在 DSH 桌面壳（Windows）里点任务卡片，弹出的「任务详情」浮窗右上角 × 点不动。

- 壳用 Electron `titleBarOverlay` 在视口顶部画原生「最小化/最大化/关闭」。**带子里的指针事件到不了网页**（`elementFromPoint` 仍返回网页元素，所以从页面侧看一切正常，这是排查最费时的一点）。
- `FloatingWindow` 的顶部下限写死 `VIEWPORT_MARGIN = 8`，自绘标题栏高 34px → × 的纵向范围约 8~42，正落在带子里。
- 同一根因的另外两处：任务页节点详情弹层（`AnchoredPopover`，锚点行靠近窗口顶部时弹层标题区落进带子）、mermaid 放大图工具栏（#805，`top: 16px`）。

## 方案

新增 `src/client/viewport-inset.ts` 作为**唯一**几何来源：

- 读标准 `navigator.windowControlsOverlay`：`visible !== true` → 0；否则 `Math.round(rect.y + rect.height)`。取 `y + height` 而不是 `height`：macOS 的控件在左上、窗口按钮占左侧一段，区域矩形可以带 `y` 偏移。
- 模块求值时探测一次并挂 `geometrychange`（首帧就拿到真值，不会先画在 8px 再跳），`window.resize` 兜底重读；值变了才广播。
- 导出 `useViewportInsetTop()`（`useSyncExternalStore`）与 `setViewportInsetSourceForTests()`。不写 CSS 变量、不碰 DOM。

三个消费者只做一件事——把可交互区的**纵向下限**从 `VIEWPORT_MARGIN` 抬到 `VIEWPORT_MARGIN + insetTop`：

| 消费者 | 改动 |
| --- | --- |
| `FloatingWindow.tsx` | `initialBox` 有/无锚点两条路径都用 `topFloor`；高度上限扣掉 `topFloor`；拖拽与 resize 的纵向夹取同步；几何变化时把已摆好的窗抬出带子，**不主动下拉** |
| `AnchoredPopover.tsx` | 布局 effect 补 `top = Math.max(topFloor, top)`（锚点自身在带子里时也要退让）；拖拽纵向下限同步 |
| `mermaid.tsx` | 工具栏 `style={{ top: 16 + insetTop }}` + `data-mermaid-toolbar`（稳定寻址，供挂载 lane 量真实布局） |

`insetTop === 0` 时三者与改动前逐字等价。

## 与 #430 删除的机制不是一回事

维护者刚在 2026-10-05 整套删过同类东西，必须正面说清区别：

| | #430 删掉的机制 | 本方案 |
| --- | --- | --- |
| 来源 | 五级取值链（声明式服务 → WCO → URL 戳记 → 壳预设 → 手动 px） | 单一标准 API（`navigator.windowControlsOverlay`） |
| 配置 | 4 个偏好键 + 设置界面 + 壳预设表 | 零配置、零设置项 |
| 输出 | 写 `body[data-dsh-title-bar-compat]` + `--dsh-title-bar-strip` | 不写任何全局值，只经 hook 返回一个数 |
| 消费者 | **零**（CSS 无人读、宿主不读） | 三个真实浮层（本次修复的直接对象） |
| 删掉后的症状 | 无——顶部行为不变，删掉的只是一条没人读的写路径 | 浮层标题栏压在原生按钮下，点不动 |

共同点只有「都读 WCO 求顶部高度」；旧机制失败的原因是**没有消费者**，不是读取方式错——它还在位时的表现正是「改设置什么都不动」。

## 降级表

| 情况 | `insetTop` | 效果 |
| --- | --- | --- |
| 普通浏览器 / 网页版（无 API） | 0 | 与今天完全一致 |
| 有 API 但 `visible: false`（headless Chromium、部分 macOS 构建） | 0 | 同上 |
| 区域高度 0 / 非有限数 / 抛错 | 0 | 同上 |
| 有 API、`visible: true`、高度 h | h | 浮层让出 h |

已知残留：壳若不暴露 WCO，本方案退化为 0，症状仍在——这种情况需要壳侧修，插件没有别的可靠来源（URL 戳记已证实与真实几何脱节，见 #864）。

## 测试证据

- `tests/viewport-inset.spec.ts`（11 例）：API 缺失 / 读到带高 36 / 高度 0 / `visible:false` / 读取抛错不炸 / 小数四舍五入（35.6→36）/ `y:4,height:32`→36 / 只在值真变时通知（同值重发不唤醒订阅者）/ `resize` 兜底重读 / `visible` 运行时翻转 / 换源清理旧监听。
- `tests/floating-window.spec.tsx` 新增 6 例：锚点在带内时抬到 52（8+44）/ 拖到最上仍停 52 / 带子出现把已摆好的窗抬起 / 带子消失不下拉 / 高度上限让出带子（400 高视口 + 44 带子 → 340）/ 幽灵接口保持原 8px。
- `tests/anchored-popover.spec.tsx`（3 例）：锚点在带内时弹层落到 52 / 无带子时仍是锚点下方 26px / 视口最顶的锚点保持历史位置 6px（不因本次改动被抬到 8）。
- `tests/e2e/mount.e2e.ts`：`addInitScript` 注入假 WCO（初始 0，保证其余断言不受影响），在放大图流程里量真实布局——工具栏 `top` 16 → 设带高 36 → 52 → 归零 → 16。

## 风险

- **壳不暴露 WCO**：见降级表，退化为 0，需壳侧修复。
- **核心 bundle 与 mermaid chunk 各打包一份模块**：各自读同一 API、各自挂一个监听，无共享状态；两个监听都只在值变化时广播，代价可忽略。
- **不动的部分**：没有任何 `-webkit-app-region` 声明被修改——问题在原生命中带，不是拖拽区；给交互浮层加 `initial` 会重演 #103/#111。
