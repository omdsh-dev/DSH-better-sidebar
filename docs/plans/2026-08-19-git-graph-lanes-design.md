# Git 面板历史提交图（lane 图）设计

> 日期：2026-08-19
> 状态：已实现（v0.14 开发分支 `feat/git-graph-lanes`）
> 范围：`dsh-better-sidebar` 插件，Git 面板（`GitView.tsx`）历史列表的提交图渲染
> 参考：`docs/prototypes/gitgraph-lines`（git graph 风格 node line 渲染 demo，移植其 lane/弧线/圆点视觉语言）

## 1. 背景与问题

Git 面板的历史列表目前是纯文本行（hash + subject + refs + author/date）。仓库**已存在一半基础设施**（工作区未提交 WIP，随本 PR 一并纳入）：

- host：`src/git.ts` 的 `graphLog`（`git log --topo-order`，`%P` 输出完整父哈希）+ `parseGraphLines`
- host 路由：`src/index.ts` 的 `git.log-graph`
- client API：`src/client/api.ts` 的 `gitLogGraph` 与 `GitGraphEntry`

缺的是**客户端 lane 布局 + SVG 渲染**——即 `docs/prototypes/gitgraph-lines` demo 的核心内容。该 demo 为嵌套调用链（`ChainStep`）生成 git graph 行序列（lane 竖线 / 汇入弧 / 分叉弧 / 圆点形态），但其输入模型（subChain / parallelGroup / branchKey）与真实 git 提交（parent 哈希链）完全不同，不能直接复用，需要**移植视觉语言、重写布局算法**。

## 2. 方案

### 2.1 纯布局模块 `src/client/git-graph.ts`

输入：`GitGraphEntry[]`（`--topo-order`，新→旧，每行带完整 `parents` 哈希）。输出：每行的 `dotCol` / lane 快照 / `below` 续线集 / `merges`（汇入弧）/ `forks`（分叉弧）+ 图宽。

**Lane 模型**（lane = 携带一个"等待显示"的提交完整哈希的列；topo 序保证父提交总在子提交之后）：

| 规则 | 说明 |
|---|---|
| **dot lane** | 携带本提交哈希的最左列（菱形时最左胜出）；否则最左空闲列；否则右缘新列 |
| **first parent** | 直下延续 dot lane；根提交（无 parents）结束该 lane |
| **汇入弧（merge arc）** | 仅菱形合并：多列携带**同一哈希**时，非 dot 列在本行以「竖线 + 圆角」弧汇入圆点并释放。**携带本提交父哈希的 lane 不汇入**——父提交在后面（topo 序），其 lane 保持直行 |
| **分叉弧（fork arc）** | 每个非 first parent：优先复用已携带该哈希的既有 lane（同一父的后来兄弟）；否则最左空闲列；否则右缘新列。**merge 释放的列不在同一行复用**（避免「V 形弹跳」），从下一行起可回收 |
| **列回收** | lane 结束（圆点显示或汇入）后列号立即释放复用，图宽只随活跃分支数增长（同 git graph 工具） |

**配色**：`laneColor(col) = var(--gg-lane-N)`（N = col % 6）——CSS 自定义属性定义在 `sidebar.module.css`，默认值全部映射 DSH 语义令牌（`--dsw-alias-brand-primary` / `state-success-primary` / `state-warn-primary` / `state-error-primary` / `state-business-primary` / `label-secondary`），遵守 §8 皮肤兼容规则（无硬编码颜色，皮肤覆盖令牌即换色）。列号固定取色 → 同一列全生命周期颜色稳定，回收后不变。

**几何**：`CELL_W=24` / `ROW_H=40` / `CURVE_R=12`（原型 22/34/11 按双行历史行微调）。路径生成 `pathV` / `pathMergeIn` / `pathForkOut` 与原型逐行对齐。

### 2.2 React 渲染组件 `src/client/GitGraph.tsx`

`GitGraphSvg({ row, prev, graphWidth })` 把一行几何渲染为内联 `<svg>`：

- 每列按 `prev.lanes.has(col)`（上方连续）+ `row.below.has(col)`（下方连续）+ 是否 merge/fork 列决定绘制：dot 列上下分段、merge 列画整条 `pathMergeIn`（含竖线+弧）、fork 列画 `pathForkOut`（含既有列的上段竖线）、直行 lane 画整高竖线；
- 圆点：实心圆（r=5.2），fill = 所在列 lane 色。**不画外环**（dot 列线已按 mid 分段，无穿越遮挡问题；也避免 hover 背景与环色不匹配）。

### 2.3 GitView 接入

- `refresh` / `loadMoreLog` 改用 `api.gitLogGraph`（分页语义与普通 log 一致，`--skip` 在 topo 排序后应用，已实测）；
- `useMemo(computeGraphRows(logEntries))` 累积分页重算布局；每行左侧渲染 `GitGraphSvg`，正文（hash/subject/refs/author）保持原结构不变，行点击/右键菜单行为不变；
- 分页边界：每页独立布局，首行无承诺 lane 时落到列 0；越过折叠的 lane 悬垂（below 集持续直行）——与 gitk 分页行为一致。

### 2.4 测试

- `tests/git-graph.spec.ts`：纯几何断言——直线主链、分支/合并分叉、菱形合并（汇入弧）、章鱼合并（3+ parents）、列回收（同行不复用 + 后续复用）、既有 lane 复用、列色循环；
- `tests/git.spec.ts`：补 `parseGraphLines` 解析测试（merge 行双 parent、根提交空 parents、短 hash 派生）。

## 3. 实施偏差记录

- **merge 规则修正**：初版把「携带本提交父哈希的 lane」也当汇入弧，导致父提交 lane 在其子提交行错误结束；按 topo 序语义改为仅菱形（同哈希）汇入（见 2.1 表）。
- **fork 目标优先级**：初版允许复用「本行 merge 释放列」，会画成同列先汇入再分叉的 V 形；改为本行排除、下一行起可复用。
- **host/API 半**为工作区既有 WIP（`graphLog` / `git.log-graph` / `gitLogGraph`），review 后随本 PR 一并提交（同一特性、互相依赖），并补上缺失的解析器测试。
- **变高历史行（评审反馈，两轮）**：带 tag chips 的行（`gitLogLine2` 换行）比 40px 的 lane SVG 高，行内出现空白间距。第一版用 ResizeObserver 测量行高回填给 SVG——形成「行高 ↔ SVG 高度」的反馈循环（行被 SVG 撑高 → 再测量 → 再撑高），被评审驳回。最终方案**纯 CSS、零测量、零循环**：图 wrapper `position: absolute; top:0; bottom:0` 不参与行高（行高只由正文决定），SVG 用 `viewBox="0 0 W ROW_H"` + `preserveAspectRatio="none"` 把名义几何 y 向拉伸到块的实际高度（竖线保持竖直、x 像素精确，弧线圆角轻微变形可接受），圆点改为 CSS 元素（`top: 50%`）保持正圆垂直居中；正文 `margin-left = graphWidth + 8` 让开图区。`vector-effect="non-scaling-stroke"` 防止 y 拉伸把描边变粗。

## 4. 参考实现

- `docs/prototypes/gitgraph-lines/src/{layout,svg,paths,constants}.ts`：原型 lane 算法与 SVG 视觉（本设计的移植源；`docs/prototypes/` 为本地参考目录，**未纳入版本库**）
- `src/client/GitView.tsx`：历史行结构与交互（点击/右键菜单/分页）
- `src/git.ts` / `src/index.ts` / `src/client/api.ts`：host 半 graphLog 数据链
