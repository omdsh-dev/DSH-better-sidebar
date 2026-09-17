# 任务管理页重构：工作流图 + Agent Teams + 后台任务抽屉（v0.20 设计）

日期：2026-09-14　分支：`feat/tasks-graph-workflow-teams`

## 背景与目标

DSH 0.1.5-rc.2 引入两个新的可观测面：**workflow**（`dsh-tool-workflow` 的 run/agent 生命周期事件）与 **Agent Teams**（实验层，`ctx.agentTeams` 的共享任务板）。任务管理页（原「子代理拓扑」）系统性地接纳两者，并按用户确认的「简洁后现代主义」方向重构为 **Variant D 工作流图**：分层节点 + 贝塞尔连线、拖拽平移、滚轮缩放、右下角控制条、已完成节点折叠聚合、点击浮窗取代页内 dock。

用户确认的关键交互决策（问答摘要）：

1. 数据范围 = 当前会话树（主代理 + 全部后代）。
2. 节点点击 = 跳转转录；ⓘ = 详情浮窗。
3. 后台任务输出 = 锚定浮窗（替换页内底部 dock）。
4. 自动折叠**只**作用于后台任务抽屉，阈值 8 个代理；图节点的折叠是「已完成」语义的折叠聚合，点击展开、控制条可再折叠。
5. 图/树切换按钮在**两种模式下都可用**（mockup 的 toggle 藏在画布容器内、树模式下无法切回——真实实现把控制条移出滚动面）。
6. 默认视图由设置 select 决定（默认工作流图），页内切换为临时态。
7. 任务板 v1 只做基础操作（完成/重开/删除/改派/新建/编辑，CAS）。

## 数据源事实（侦察结论）

### Workflow

- **没有**服务注册表 / 持久化 / HTTP 接口；只有调用方会话日志里的 4 个会话事件：`tool-workflow/run-start | agent-start | agent-end | run-end`。
- 只有**顶层 run** 落事件（`exec.parent === undefined`），嵌套 run 不可见——与官方 `dsh-client-ui-workflow-run` 面板折叠的恰好是同 4 类事件，因此插件折叠结果与官方面板一致。
- run 的 member agent 是普通子会话（catalog 里有行），`childId` 即子会话 id——图模式把它们**重挂**到 run 节点下；catalog 里没有的 member 用 run 自带数据合成占位节点。

### Agent Teams（实验层）

- 只在 `~/.dsh-web` 类 profile 的实验 bundle 里存在；`ctx.get('agentTeams')` 缺席时返回 `undefined`（不抛）——**结构性降级**的支点。
- TeamId ≡ lead SessionId；`tryMembership(agent)` 命中后 `remoteView(agent) → {members, tasks}`；`remoteCreateTask` / `remoteUpdateTask`（CAS，`expectedRevision`，冲突走 `team-task-conflict` union 返回而非抛错）。
- 成员上限 8、任务上限 256；teammate = lead 的可续接子会话（`member.id` = 子会话 id，与拓扑树天然关联）。
- `~/.dsh/task-board/ledger-v2.json` 与 Agent Teams **无关**（名字误导，已核证）。
- 官方团队面板是 read-mostly + 手动刷新——客户端 5s 轮询（仅页面可见时）不是过度设计。

### Jobs

沿用既有：`jobsBySession` push 镜像 + `jobs.output` 事件回放（不碰模型游标）+ 两击终止。

## 架构

```
host 半（src/）
  workflow-runs.ts    纯折叠 foldWorkflowRuns(events, originSessionId) → WorkflowRunView[]
  workflow-routes.ts  workflows.list：树枚举 + 存储日志与 live 镜像按 seq 去重合并
  team-routes.ts      teams.view / taskCreate / taskUpdate：结构镜像 Remote 词汇，三分支降级
client 半（src/client/）
  tasks-model.ts      统一视图模型（图/树共用）：catalog 走树、run 重挂、team 富化、fold 聚合
  tasks-graph-layout.ts  免依赖 tidy-tree 分层布局（<100 节点无需虚拟化；bundle 纯度禁图库）
  TasksGraph.tsx      画布：pan / wheel-zoom-to-cursor / 相位虚线框 / 控制条（图树切换+折叠+缩放）
  TasksTree.tsx       树模式：缩进行 + 键盘导航（官方 catalog 配方）
  TasksPopovers.tsx   节点详情 / run 详情 / 团队任务板（CAS 操作）
  JobsDrawer.tsx      底部抽屉（≥8 代理自动折叠，手动优先）+ 输出浮窗（回放，尾钉）
  AnchoredPopover.tsx 锚定浮窗：geometry + 关闭契约（沿用 selection-popup 的 #425 修复）
  tool-icons.tsx      工具字形映射（宿主 primitives 图标，currentColor）
```

### 降级矩阵（可证伪）

| 环境 | workflows.list | teams.view | 页面表现 |
|---|---|---|---|
| 无 workflow/无 team（3384 桌面 profile r） | `{runs: []}`（200，空而非错） | `{available:false}` | 图/树照常，无 run 节点、无团队 chip |
| 有 team 无 workflow（3080） | `{runs: []}` | `{available:true, team:{...}}` | roster 富化节点 + chip + 任务板 |
| 有 workflow | 折叠结果 | — | run 节点 + 相位框 + member 重挂 |
| subagents 服务缺席 | 仅折叠 root | 不影响 | 旧快照退化行为 |

## 关键取舍

- **零实验包 import**：`context-types.ts` 结构镜像 `TeamService` 的 Remote 词汇；`ctx.get('agentTeams')` 探活在路由内。实验层缺席时 mutation 抛 503 `team-error`（与 `subagents-unavailable` 同形）。
- **workflow 无事件 = 空列表不是错误**：旧会话/无 workflow 会话静默为空（jobs 镜像同款语义）。
- **fold 规则**：per-parent 的「已完成/出错的**叶子** agent」折叠为一个聚合节点；当前会话、teammate、有子节点的、run 节点**永不折叠**（折叠父节点会藏住活跃分支）。
- **树/图同一模型**：fold 状态、团队富化、run 重挂两种模式共享——不会视觉漂移。
- **控制条移出滚动面**：图模式的缩放按钮与图/树切换都在视图容器级（绝对定位右下），树模式下缩放按钮不渲染但切换在（mockup bug 的教训，有测试守护）。
- **页内视图切换是临时态**，默认视图走 `tasksViewMode` pref（schemastery `z.union([z.const('graph'), z.const('tree')])`——schemastery 无 `z.enum`）。
- **AnchoredPopover 不复用 primitives 的 HoverCard**：浮窗需要持久交互（任务板表单、输出滚动），HoverCard 是悬停语义；关闭契约（外部 mousedown / Escape / anchor 离屏的 IntersectionObserver）沿用 selection-popup 已验证的模式。
- **主题硬阴影用 `color-mix(in srgb, var(--dsw-alias-border-l1) 55%, transparent)`**：后现代硬投影但颜色全部出自令牌（theme.spec 只守 `color:`，皮肤契约的精神照旧满足）。

## 实施偏差记录

1. **诊断行（diagnostic catalog entries）从模型中省略**：旧树逐 parent 渲染 corrupt/unavailable 行；新模型跳过它们，目录加载失败改由页头横幅「N 个分支加载失败 + 重试（逐个 refresh）」统一承载。理由：诊断行罕见（通常是 side-chat 遗产），逐 parent 内联会破坏图的 tidy 布局；横幅保留可达性与重试。
2. **catalog `state:'error'` 不再逐层内联**，同上进横幅。
3. **loadin rows**：图模式无「加载中占位卡」；树模式保留 `summaryBackedLoading` 的 loading 行。图模式靠 5s 轮询自然收敛。
4. **子代理 keyboard 导航保留在树模式**；图模式节点 `tabIndex=-1`（平移/缩放下 tab 序无意义，树模式是可达性面）。
5. **本地 `pnpm test:mount` 需要绕过桌面 shim**：桌面版 `~/.local/bin/dsh` shim 回退到桌面捆绑 CLI 且**不尊重 `DSH_HOME`**（`dsh plugin add` 会写到真实 `~/.dsh` profile——本次亲历，把真实 profile web 的 better-sidebar 指到了本分支 tarball）。正确姿势与 CI 一致：`DSH_CMD="npx -y --package @deepseek-ai/dsh@0.1.5-rc.2 dsh" pnpm test:mount`。
6. **测试断言从 `container.textContent` 迁到 `document.body`**：输出浮窗 portal 到 body（#425 契约），jobs-view 套件相应更新。
7. **fold 聚合节点的 aria-label 带计数文本**：与控制条的 fold 切换按钮消歧（两者同文案会导致 a11y 选择器歧义）。

## 复审返工（2026-09-14 晚，真机截图反馈）

用户在 3384（`DSH_HOME=~/.dsh`，profile web）看到首版实现后给出四条反馈，逐条定位并修复：

| 反馈 | 根因 | 修法 |
|---|---|---|
| 「按钮和文本的颜色不对，不够后现代」 | 新 CSS **17 处裸用 `var(--dsw-alias-accent)`——该令牌在 DSH 主题里不存在**（旧文件的用法都带 fallback 才没暴露），声明被浏览器整条丢弃；容器边框用的 `border-l1` 只有 4% 黑，几乎不可见 | accent → `--dsw-alias-state-business-primary`；容器边 → `--dsw-alias-border-l4`（16%）；整体改回 mockup 语言：ink 边框、3px 硬投影、mono 微型字 + 字距大写标签、点阵画布、横向缩放条 |
| 「点 ⓘ 没反应 / 图里点不动（树能点）」 | 画布 `pointerdown` 里对容器 `setPointerCapture`，捕获把派生 click 重定向到容器，节点永远收不到点击（jsdom 不模拟捕获语义，所以单测全绿——**只有真实浏览器能暴露**） | 去掉 capture，pan 仅从背景起手（`closest('[data-graph-node]'/'[data-graph-controls]')` 直接返回），监听挂 window |
| 「图很小 / 不在中间 / 任务板没显示」 | fit 在容器为 0 尺寸时静默放弃且不再重试；只居中横轴、上限 1.0；窄面板里 5 个兄弟节点挤成 770px 宽 → 缩到 35% | ResizeObserver + 首次非零尺寸补 fit、双轴居中、`FIT_MIN_SCALE=0.78` 可读性下限；**按容器宽度求解排布**（`layoutTasksGraphForWidth`：先取仍满足可读性预算的最宽排布，只有窄到 ≤1 列才允许 20% 横向溢出）；任务板改为**常驻可见条**（不再藏在 chip 后） |
| 「卡片信息过多过杂，都被省略看不见」 | 卡片同时塞 displayTitle + 模式 + 状态 + 模型 + live 文本，132px 宽（窄面板的目标宽度）下全部省略号 | 卡片只留三层：标题（1 行）/ mono 元信息（模式或模型 · 状态）/ live 行（仅运行中）；其余（会话标题、team 角色、模型全名、最新文本、跳转）进 ⓘ 浮窗 |
| 「非常窄，非常挤」 | 设计按宽画布做，未以原生右侧栏窄宽为目标 | 度量全部改按 mockup 的 360×660 基准（卡片 132×46、行距 112）；行高/间距/字号显式声明（宿主 body 行高曾把行撑高）；`user-select: none` 防拖拽选中文本 |

回归面：`tests/tasks-page.spec.tsx` 增 3 例（背景 pointerdown 后节点仍可激活、节点上的手势绝不启动 pan、团队任务板无需点击即常驻可见）；`tests/tasks-graph-layout.spec.ts` 重写 9 例（band 换行、换行 band 不得压到兄弟子树行、宽度求解两段式、运行时预留 live 行）。

### 本地可视化自检 harness（未入库，`tmp-visual/`，git-excluded）

真实浏览器里的组件级回归无法靠 jsdom 覆盖（点击捕获、fit/居中、主题令牌解析都是浏览器行为）。harness 用 esbuild 把**真实组件** + mockup 形状的 fixture（走 `buildTasksModel`，因此折叠/重挂/富化都真实生效）打包进一个页面，注入从 `dsh-client-ui-theme` 抽出的令牌 CSS，`@deepseek-ai/dsh-client-ui-primitives` 别名到轻量桩（避免把 katex/shiki 资源拖进截图包），再由 Playwright 在 360px / 720px 两档宽度截图并断言：节点点击回调、ⓘ 回调、背景拖拽平移量。本次返工的四条反馈里有三条正是它先复现、修完再确认的。

## 第二轮返工（2026-09-14 深夜，13 条反馈）

用户第二轮反馈三条，逐条落地：

| 反馈 | 做法 |
|---|---|
| 任务板「太窄太小」，且任务应显示到**对应节点**上 | 任务按 `ownerName → 成员名 → 成员会话 id` 映射进模型（`TasksNodeTask`），节点第 4 行渲染「☑ 主题 · 状态 +N」；任务板改为：成员 Pill 行**兼当负责人筛选**、任务行 = 状态点 + 主题 + 负责人 + 状态 Tag + **一个**溢出菜单；新建/编辑改为 `Modal` + `Input`（真正的宽表单），负责人用 Pill 选择 |
| 所有组件用自建、不用原生 HTML | 任务板全量换成宿主 primitives：`Menu`（含子菜单的改派）/`Modal`/`Input`/`Button`/`Pill`/`Tag`/`Switch`/`StateDot`；后台任务行的 kind/状态用 `Tag`、终止用 `Button`、输出浮窗的复制/跟随/终止同理。页面仅剩结构性 div（卡片、树行）不是表单控件 |
| Agent 用图标而非自绘 SVG；优化工具展示 | `◉/◇/▶/✓/⇪/⇩/i/☰/⌗/⌂` 等字形全部删除，改用宿主图标：`IconAgentPresetOutline16`（代理）、`IconUserOutline16`（teammate）、`IconBranchOutline16`（workflow run）、`IconChecklistOutline14`（折叠聚合 / 任务行 / 折叠按钮）、`IconTreeCorner8x10`（树视图）、`IconFullscreenOutline16`（适应）、`IconEllipsisOutline16`（节点详情）、`IconCopyOutline16`/`IconStopFill16`（作业）。live 行改为工具自身图标 + 工具名 + 参数（去掉手绘方框） |
| 后台任务弹窗要能拖动 + 体验 | `AnchoredPopover` 增加 `draggable`（拖动整体、按钮/输入/`pre` 不拦截、双击复位、视口内钳制）与 `width` 参数；输出浮窗宽 380 且可拖，新增「复制输出」「跟随最新」开关（关闭后不再尾钉）、kind/状态 Tag、拖动提示；抽屉行高亮当前打开的作业 |

i18n：本轮新增 19 条文案，zh/en/ja + 18 份第三语言词典同步（`tests/locales.spec.ts` 16/16）。

## 第三轮返工（2026-09-14 深夜，交互统一）

用户第三轮反馈两点，都指向「减少控件、统一入口」：

| 反馈 | 做法 |
|---|---|
| 图卡片去掉详情按钮，「统一改为弹出详细」 | 删除每张卡片右上角的 `…` 按钮（树行同理）：**卡片/行本身就是详情入口**，点击即弹详情窗口；跳转转录改为详情窗口内的主按钮。折叠聚合节点仍保留「点击=展开/再折叠」的语义 |
| 任务所有入口统一为「点击弹出非全屏可拖动编辑（兼查看）窗口」，含 编辑owner + 编辑 + 重开 + 删除；默认多行 markdown 预览，点编辑才进入多行编辑 | 新增单一组件 `TaskWindow.tsx`：`TaskWindow`（内容）+ `TaskPopover`（可拖动外壳，宽 430）+ `MultilineField`（自建多行输入）+ `OwnerPicker`（Pill 即点即改派）+ `TaskCreateButton`。三处入口全部复用它——任务板行、节点任务行、节点详情里的任务清单；「新建」也走同一个窗口（create 模式直接进入编辑态）。任务板由此**删掉了溢出菜单与 Modal**，只留筛选 Pills、任务行与新建按钮 |

新文案 3 条（任务详情 / 暂无描述 / 被阻塞），zh/en/ja + 18 份第三语言同步。

组件复用清单（本轮）：

| 组件 | 复用点 |
|---|---|
| `TaskPopover` | 任务板行、节点任务行、节点详情任务清单、新建按钮（4 处） |
| `MultilineField` | 任务描述编辑（宿主 primitives 无多行输入，故自建） |
| `TaskCreateButton` | 任务板 / 其它入口共用同一外观 |
| `AgentGlyph` / `WorkflowGlyph` / `FoldGlyph` / `TaskLine` | 图与树两种模式共用 |

## 验证结果（2026-09-14）

PR：[#680](https://github.com/omdsh-dev/DSH-better-sidebar/pull/680)（分支 `feat/tasks-graph-workflow-teams`）。

- `pnpm typecheck` ✅；`pnpm vitest run` **133 文件 / 1400 用例通过**（新增：host 路由 29、模型 7、布局 9、页面交互 9）；`pnpm build` ✅（皮肤契约 / 市场清单 / chunk 纯度守卫全绿）。
- `pnpm test:mount`（`DSH_CMD="npx -y --package @deepseek-ai/dsh@0.1.5-rc.2 dsh"`，本地必须绕开桌面 shim，见实施偏差 5）**7/7 通过**：真实挂载 + 无头 tab 全扫。其 PERF_JSON 里可读到 scratch profile（**无实验层**，等价 3384 的 profile）上 `/sidebar/api/workflows.list → {runs:[]}`、`/sidebar/api/teams.view → {available:false}` —— 即降级矩阵左列的实测证据。
- 3080（`~/.dsh-web`，含实验层）实景协议验证：`teams.view → {available:true, team:null}`、`workflows.list → {runs:[]}`、`teams.taskCreate → 404 team-error "the tree root leads no team"`（三分支里「层在、无团队」这条）。
- 本地可视化自检 harness（真实组件 + 真实主题令牌 + Playwright，360px/720px 两档）：节点点击、ⓘ 浮窗、背景平移（Δ+60/+40）、折叠聚合、任务板常驻全部通过；本轮四条真机反馈中的三条由它先复现。
- 复现步骤与陷阱（令牌提取、primitives 桩、shim 与 tarball 重装坑）已沉淀到 `.workspace-docs/notes/dsh/09-14-dsh-better-sidebar任务管理页重构（工作流图与Teams任务板）.md`。

未在本机自动化验证、留给用户实机确认的一项：3384 桌面应用**重启后**的 UI 级复看（新 bundle 已装进 `~/.dsh/profiles/web`，与仓库构建产物 SHA-256 一致）。

## shadcn/ui 迁移（2026-09-17，视觉基座替换）

三轮返工把**行为**收敛到位（统一的详情窗口、常驻任务板、可拖动浮窗），但**视觉基座**仍是自建：

- 每张卡片 / 每个节点 / 每行都是一次手写样式，同一种「卡片」在四个文件里有四份近似声明；
- 卡片自带 `color-mix()` 硬投影与描边，节点一多**满屏阴影相互叠加**，正是「辣眼睛」的根因（阴影是层级手段，被当成了装饰）；
- 控件形态靠逐处微调对齐，hover / focus-visible / disabled 三态在不同文件里覆盖程度不一。

处置不是再打磨一轮自建样式，而是**换基座**：把 shadcn/ui 的组件源码 vendoring 进 `src/client/ui/`，样式统一由 Tailwind v4 工具类产出，颜色统一走 shadcn 语义令牌 → `--dsw-*` 的桥接，**静态面板零阴影**（层级改由 1px hairline + 表面阶梯承载）。行为语义、稳定钩子、i18n 全部不变，因此这次迁移对上层是不可见的。

### 依赖与实际版本

| 包 | 版本 | 归属 | 作用 |
|---|---|---|---|
| `radix-ui` | `^1.6.7` | dependencies | vendored 组件的无样式原语（聚合包，不是 `@radix-ui/react-*` 一族） |
| `class-variance-authority` | `^0.7.1` | dependencies | `buttonVariants` / `badgeVariants` / `toggleVariants` 的变体表 |
| `clsx` | `^2.1.1` | dependencies | `cn()` 的条件拼装 |
| `tailwind-merge` | `^3.7.0` | dependencies | `cn()` 的同族工具类去重（调用方的 `px-4` 胜过组件默认的 `px-2`） |
| `tailwindcss` | `^4.3.3` | devDependencies | v4 引擎（只构建期用；运行期产物是编译后的 CSS） |
| `@tailwindcss/postcss` | `^4.3.3` | devDependencies | 构建管线，被 `tsdown.config.ts` 与 `scripts/ui-css.mjs` 共用 |
| `postcss` | `^8.5.26` | devDependencies | 上面的宿主管线 |

`components.json`（CLI 上下文，非运行期配置）：`style: new-york` / `base: radix` / `rsc: false` / `css: src/client/ui/theme.css`，`aliases` 全部指向 `src/client/ui`——**所以 CLI 的默认 `@/lib/utils` 不会出现在这个仓库**（见下文「统一改动」第 2 条）。

CLI 曾顺手注入一个 `cn: ^0.3.0` 依赖（npm 上真实存在的同名包，仓库里无任何 import）——已删除并 `pnpm install` 重同步 `pnpm-lock.yaml` / `node_modules`。

### Tailwind 接入方式

入口是唯一的：`src/client/ui/theme.css`，编译有**两个**消费方但只有一份定义（`tsdown.config.ts` 导出 `compileTailwind()`，`scripts/ui-css.mjs` 复用它产出可视化 harness 的 `tailwind.css`）：

```
src/client/ui/theme.css ──┬─ tsdown css-inline 插件（生产）→ 内联进 lib/client.js 的 <style data-plugin>
                          └─ scripts/ui-css.mjs（pnpm ui:css，仅本地 harness）
```

**为什么只引 `theme` + `utilities`**：插件注入的样式表是**全局 `<style data-plugin>`**（`injectTag()`，无 shadow DOM）。Tailwind 的完整入口 `@import "tailwindcss"` 会连带 preflight，而 preflight 的 `*,::before,::after { box-sizing; margin: 0; padding: 0; border: 0 solid }` 与 `html { -webkit-text-size-adjust }` 是对**整张 DSH 宿主页面**的重置——会话正文、原生右侧栏、设置页全部会被改版。所以只引：

```css
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@source "../**/*.tsx";
```

`@source` 是**显式**的：不给它，Tailwind 会以项目根为扫描面，把 `lib/`、`tests/`、`node_modules/` 里像类名的字符串也算进产物（既胖又不可控）。它只扫 `src/client/**/*.tsx`。

**深浅主题**：`@custom-variant dark (&:where([data-ds-dark-theme], [data-ds-dark-theme] *))` —— DSH 的主题翻转是给 `<body>` 打 `data-ds-dark-theme`，不是加 `.dark` 类（不给这条 `@custom-variant`，Tailwind 的 `dark:` 变体会去找 `.dark` 祖先，在本宿主里**永远不会命中**）。但**本次迁移把所有 `dark:` 覆写都删了**：`--dsw-*` 令牌本身就随主题翻转，再写一遍 `dark:` 是双重记账（上游 `dark:bg-destructive/60`、`dark:border-input`、`dark:aria-invalid:ring-destructive/40`、`dark:hover:bg-accent/50` 全属此类）。`@custom-variant` 保留是为了将来确需「令牌之外」的主题分支时有正确锚点。

**级联层与 `dsw-tasks` 作用域根类**（这一条是本仓库特有的坑）：宿主的样式表是**无层级（unlayered）**的，而无层级声明**优先于任何 `@layer` 内的声明**——与特异性无关。也就是说 `layer(utilities)` 里的 `.rounded-md` 打不过宿主任何一条裸元素规则。补偿手段是把页面自己的补偿规则放进层里但抬到**类特异性**，并挂在 **`.dsw-tasks`**（任务页根类，`SubagentView` 的页面根 + `TaskWindow` 的内容根）上：

```css
@layer base {
  .dsw-tasks { color: var(--dsw-alias-label-primary); }
  .dsw-tasks :where(button, input, textarea, select) { font: inherit; }
  .dsw-tasks :where(*, *::before, *::after) { box-sizing: border-box; }
  .dsw-tasks :where(a, button, input, textarea, select, [tabindex]):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
}
```

`:where()` 把元素重置压回类特异性，所以这几条既到得了页面内的元素，又**不越出 `.dsw-tasks`**——用作用域根类换回了 preflight 里真正需要的三条（`box-sizing` / 控件继承字体 / 前景色），代价是不碰宿主页面。附带的两组：`@layer utilities` 里的细滚动条（走 `--dsw-alias-scrollbar-*`）与 `@media (prefers-reduced-motion: reduce)` 的动效全量关闭。

**`radix-ui` 的入口解析**：`tsdown.config.ts` 把 `module`/`browser` 放在 `mainFields` 首位（`react-remove-scroll` 家族的 `main` 是 `dist/es5`），并给 `tailwind-merge` 加显式 alias（它的 exports map 把 `require` 列在 `import` 之前，会解析到不可 tree-shake 的 `bundle-cjs.js`）。

### shadcn 令牌 → `--dsw-*` 映射表

`theme.css` 的 `:root` 是唯一的桥。每个值都是 `var(--dsw-…)` 引用，**没有颜色字面量**；`@theme inline` 把这些名字再接成 Tailwind 的 `--color-*`（`inline` 保证产物里留着 `var(--background)` 这层间接，宿主皮肤改令牌能立刻生效）。

| shadcn 令牌 | DSH 令牌 | 备注 |
|---|---|---|
| `--background` | `--dsw-alias-bg-base` | |
| `--foreground` | `--dsw-alias-label-primary` | 正文墨色第 1 档 |
| `--card` | `--dsw-alias-bg-layer-1` | 表面阶梯第 2 级（静态面板） |
| `--card-foreground` | `--dsw-alias-label-primary` | |
| `--popover` | `--dsw-alias-bg-layer-2` | 表面阶梯第 3 级（浮层） |
| `--popover-foreground` | `--dsw-alias-label-primary` | |
| `--primary` | `--dsw-alias-state-business-primary` | 只给主操作 / 焦点环 / 进行中 |
| `--primary-foreground` | `--dsw-alias-label-primary-foreground` | |
| `--secondary` | `--dsw-alias-interactive-bg-hover` | |
| `--secondary-foreground` | `--dsw-alias-label-primary` | |
| `--muted` | `--dsw-alias-interactive-bg-hover` | |
| `--muted-foreground` | `--dsw-alias-label-secondary` | 墨色第 2 档 |
| `--accent` | `--dsw-alias-interactive-bg-hover` | |
| `--accent-foreground` | `--dsw-alias-label-primary` | |
| `--destructive` | `--dsw-alias-state-error-primary` | 错误 / 删除 |
| `--destructive-foreground` | `--dsw-alias-label-primary-foreground` | 上游此处是 `text-white`（迁移时删掉的唯一颜色字面量） |
| `--border` | `--dsw-alias-border-l4` | 1px hairline 的来源 |
| `--input` | `--dsw-alias-border-l4` | |
| `--ring` | `--dsw-alias-state-business-primary` | |
| `--success` | `--dsw-alias-state-success-primary` | 非 stock shadcn，任务状态需要 |
| `--warning` | `--dsw-alias-state-warn-primary` | 非 stock shadcn，阻塞 / 审批需要 |
| `--foreground-3` | `--dsw-alias-label-tertiary` | 墨色第 3 档（靠重量分层，不靠色数） |
| `--border-strong` | `--dsw-alias-label-tertiary` | 需要更实的分隔时用 |

圆角是唯一不来自令牌的一组（`--radius` 6px / `sm` 4px / `md` 6px / `lg` 8px / `xl` 12px，纯几何，与皮肤无关）；字体走 `--font-sans: var(--dsw-font-family-default)` / `--font-mono: var(--dsw-font-family-code)`，所以插件不可能与 DSH 的字阶漂移。

### vendored 组件清单与对上游的每处改动

安装命令（16 个组件，17 个文件——`toggle.tsx` 是 `toggle-group` 的 cva 依赖，随 `add` 一起到达）：

```
npx -y shadcn@latest add button card badge separator input textarea tooltip popover \
  dropdown-menu scroll-area collapsible toggle-group skeleton spinner empty
```

按**消费面**清点（`src/client/ui/` 下 18 个文件：16 个组件 + `toggle.tsx` + `utils.ts`）：

> **两个当前无消费者的文件**：`popover.tsx` 与 `skeleton.tsx`。浮层全部走自建的 `AnchoredPopover`（它需要锚定 + 拖动 + 关闭契约，shadcn popover 是 portal 语义，两者不通用），加载态走 `Spinner`。二者按简报要求随 `add` 一起 vendoring 进来，**保留原样**——但「保留」不等于「发货」：实测 `lib/client.js` 里**这两个模块的代码与 `@radix-ui/react-popover` 全部缺席**（rollup 按 import 图 tree-shake；`toggle.tsx` 则相反，`toggle-group` 只取 `toggleVariants`，模块在包内而 `Toggle` 组件不在）。若下次复盘确认仍无消费者，删除这两个文件是纯收益（少两份要跟上游 diff 的源码）。

| 文件 | 实际消费者 | 上游改动摘要 |
|---|---|---|
| `button.tsx` | JobsDrawer / SubagentView（别名 `UiButton`）/ TaskWindow / TasksGraph / TasksPopovers | 删 `link` 变体与 `xs` / `lg` / `icon-xs` / `icon-sm` / `icon-lg` 尺寸；`outline` 去掉 `shadow-xs` |
| `card.tsx` | TaskWindow / TasksGraph / TasksPopovers / TeamBoard | 去掉卡片阴影（静态面板零阴影） |
| `badge.tsx` | JobsDrawer / TaskWindow / TasksGraph / TasksPopovers / TeamBoard | 删 `ghost` / `link` 变体；`text-white` → `--destructive-foreground` |
| `separator.tsx` | TaskWindow / TasksPopovers / TeamBoard | 无（保留 `data-slot` 与 orientation 数据属性） |
| `input.tsx` | TaskWindow | 删上游 7 条 `file:` 变体工具类 |
| `textarea.tsx` | TaskWindow | 无 |
| `tooltip.tsx` | SubagentView / TasksGraph | 删 `dark:` 覆写 |
| `popover.tsx` | **无消费者**（见下） | 只保留 `shadow-md`（真浮层）、删 `dark:` 覆写；删 `PopoverHeader` / `PopoverTitle` / `PopoverDescription` |
| `dropdown-menu.tsx` | TeamBoard（改派负责人子菜单） | 删 `DropdownMenuCheckboxItem` / `DropdownMenuRadioGroup` / `DropdownMenuRadioItem`（无消费者，顺带消灭唯一的 `CircleIcon` 用法）、删 `DropdownMenuShortcut`；保留 `Sub` 家族；子菜单箭头换宿主图标；`shadow-md` / `shadow-lg` 保留（真浮层） |
| `scroll-area.tsx` | JobsDrawer / TasksTree | 无 |
| `collapsible.tsx` | JobsDrawer / TasksTree | 无 |
| `toggle-group.tsx` | TaskWindow / TeamBoard | 删 `shadow-none`；`src/client/ui/toggle` → `./toggle` |
| `toggle.tsx` | 无直接消费者（`toggle-group` 的 cva 依赖） | 删 `lg` 尺寸；`toggleVariants` 保留 |
| `skeleton.tsx` | **无消费者**（见上） | 无 |
| `spinner.tsx` | TasksTree | **重建**在宿主 `IconLoadingOutline16` 上（上游用 `Loader2Icon`），可访问状态包一层 `role="status"` |
| `empty.tsx` | SubagentView / TeamBoard | 删 `dark:` 覆写 |
| `utils.ts` | 全部 vendored 组件 | CLI 重建后重写（`clsx` + `twMerge`） |

逐条列出六类**统一改动**（每处在文件里都有注释说明理由）：

1. **图标一律换宿主 primitives**：删掉 `lucide-react` 后，vendored 文件里只剩两处图标 import——`spinner.tsx` 的 `IconLoadingOutline16`（并据此重建了组件）与 `dropdown-menu.tsx` 的 `IconChevronRightOutline14`（子菜单箭头）。**没有新写一个 SVG**。宿主图标渲染的就是 `svg`，所以组件里的 `[&_svg]` / `[&_svg:not([class*='size-'])]:size-4` 选择器照旧成立。
2. **`import { cn } from "cn"` → `./utils`**（全部 16 个文件）：CLI 默认写的是 `cn` 这个**npm 上真实存在的包名**，本项目没有该依赖；同时 `toggle-group` 的 `src/client/ui/toggle` 改成相对路径 `./toggle`。全目录不再有 `@/lib/utils` 与裸包名 alias。
3. **删所有 `dark:` 颜色覆写**（理由见上）。
4. **非浮层变体删 `shadow-*`**：上游给 `card`（`shadow-sm`）/ `input`（`shadow-xs`）/ `textarea`（`shadow-xs`）/ `toggle`（outline 的 `shadow-xs`）/ `toggle-group`（`shadow-xs` + `data-[spacing=0]:shadow-none`）/ `button`（outline 的 `shadow-xs`）都带了投影，全部删除。迁移后全目录只剩三处 `shadow-*`：`popover.tsx` 一处 `shadow-md`、`dropdown-menu.tsx` 的 `shadow-md` 与 `shadow-lg`。**静态面板零阴影是设计语言，不是遗漏。**
5. **删无消费者的变体 / 尺寸 / 子组件**：`button` 的 `link` + 5 个尺寸、`badge` 的 `ghost` / `link`、`toggle` 的 `lg`、`popover` 的 `PopoverHeader` / `PopoverTitle` / `PopoverDescription`、`dropdown-menu` 的 `DropdownMenuShortcut`。它们都是**运行期对象里的类字符串**，留着就会进 bundle。
6. **`input.tsx` 的 `file:` 类删除是双重理由**：页面没有 `<input type="file">` 面，且它们编译出 `::file-selector-button` 选择器——那正是 Tailwind preflight 的特征串，构建产物守卫用它证明「preflight 从未入包」。保留这 7 条会让该守卫**永远误报**。守卫本身也据此收紧了识别方式：改判「chunk CSS 里的重置声明负载 + html 块」，而不是选择器拼写（`tests/ui-bundle.spec.ts` 的 docstring 记录了这次修正）。

外加上游 CLI 之外的两件事：`package.json` 删除 CLI 注入的 `cn` 依赖；`theme.css` 与 `utils.ts` 曾在迁移中误删，按同一定义重建并重新逐条复核（两者都由 `tests/ui-foundation.spec.ts` 完整守护，重建后全绿）。

### 阴影策略（静态面板零阴影，仅浮层）

层级由「重量」承担：1px `border-border` hairline + 表面阶梯（`background` → `card`/`layer-1` → `popover`/`layer-2`）+ 三档墨色。**阴影只允许出现在真正浮动、由自己的锚定几何定位的层**：

| 允许阴影 | 位置 |
|---|---|
| `AnchoredPopover`（`shadow-lg`） | 任务窗口 / 节点详情 / 输出浮窗的外壳（自建锚定 + 拖动） |
| `ui/popover.tsx`（`shadow-md`） | portal 渲染的 shadcn popover |
| `ui/dropdown-menu.tsx`（`shadow-md` / `shadow-lg`） | portal 渲染的菜单与子菜单 |
| `ui/tooltip.tsx`（**白名单成员但当前不带阴影**） | portal 渲染的 tooltip 本来就是实心 `bg-foreground` 反色块，不需要投影；列入 `FLOATING_FILES` 只是承认它是浮层 |

守护是**源码级**的（`tests/ui-shadows.spec.ts`）：`STATIC_PANEL_FILES`（页面内布局的 10 个文件）不得出现任何 Tailwind 阴影工具类，`FLOATING_FILES` 是唯一白名单，且最后一条断言要求白名单**不空转**（`AnchoredPopover` 必须真的带阴影，否则白名单在替别处的回归打掩护）。`box-shadow` 声明式写法同样被禁。

### 实测体积与 mount 结果（含返工：把任务页下沉为懒加载 chunk）

第一次门禁的唯一未达成项是体积：迁移后 `lib/client.js` **1452623 bytes（1418.6 KiB）**，比基线 +457.6 KiB，超出计划里 +250 KiB 的预算。定位结论是**浮层栈的固有成本**（`radix-ui` 的 popover / dropdown-menu / tooltip / scroll-area / collapsible 一族 + `floating-ui` + `react-remove-scroll` + `tailwind-merge`，逐生成行归属：浮动层 263.9 KiB、tailwind-merge 59.4 KiB）。

处置不是放宽预算，而是**把这层负载移出启动路径**：任务页（工作流图 + 树 + 任务窗口 + 团队任务板 + 后台任务抽屉 + 整个 vendored shadcn 层与其样式表）整体下沉为既有的懒加载 chunk——

- `src/client/chunks/tasks.tsx` 只 re-export `SubagentView`，并 `import '../ui/theme.css'`（Tailwind 产物随 chunk 走，不占核心包）；
- `CHUNK_NAMES`（`src/bundle-route.ts`）与 `CHUNKS`（`tsdown.config.ts`）与 `ChunkName`（`chunk-loader.ts`）各加一个 `tasks`，产出 `lib/client-tasks.js`，经 `/sidebar/bundle/tasks.js` 按需下发；
- 任务页的 tab 描述符改用 `lazyChunkComponent('tasks', mod => mod.SubagentView)`（与终端同款机制：加载中显示占位、失败显示重试），**核心包不再静态 import 任何 chunk 入口**；
- 从未打开任务页的用户完全不下载这 700 KiB；stub/树/浮窗的既有 hook 与行为全部不变。

返工后实测（同一次 `pnpm build`）：

| 指标 | 值 |
|---|---|
| `lib/client.js`（迁移前基线，HEAD `12b4716` 同工具链实测） | 1012271 bytes = 988.5 KiB |
| `lib/client.js`（迁移后） | **855612 bytes = 835.6 KiB** |
| 核心包增量 | **−156659 bytes（−153.0 KiB，比迁移前更小）** |
| `lib/client-tasks.js`（打开任务页时才拉） | 723656 bytes = 706.7 KiB |
| 体积预算（核心包 ≤ 基线 +250 KiB） | ✅ 达成（且核心包净减） |
| 核心包含 Tailwind / radix / tailwind-merge / `oklch(` / `lucide-react` | 全部为 0（由 `tests/ui-bundle.spec.ts` 断言） |
| `lib/client-tasks.js` 含 Tailwind 产物 + radix + 令牌桥 | ✅（同一 spec 断言） |

因此 `tests/ui-bundle.spec.ts` 现在**双向断言**：核心包必须干净（无 utilities/radix/tailwind-merge、无 preflight、无调色板字面量）且 ≤ 基线 +250 KiB；chunk 必须携带 Tailwind 产物、radix 层、`var(--dsw-…)` 桥接与 `__dshChunks__["tasks"]` 槽位，同样不得带 preflight/oklch/lucide。

其余门禁（同一份构建产物）：

- `pnpm typecheck` 0；`pnpm lint` 0；`pnpm vitest run` **136 文件 / 1499 用例通过 / 9 skipped**；
- `pnpm build` 的四条产物断言全绿：Tailwind 产物确在包内（`--tw-*` + `.flex{`）、**无 preflight**、**无 `oklch(`**、**无 `lucide-react`**；
- `pnpm pack` ✅；`pnpm test:mount`（真实挂载 + 无头 tab 全扫）**7/7**，`PERF_JSON`：`mountLatencyMs 437`、`longtaskCount 2`（≤ 8 预算）、并且资源清单里出现 **`/sidebar/bundle/tasks.js`** —— 懒加载路径在真实 DSH 外壳里被走到。

新增的守护文件：`tests/ui-foundation.spec.ts`（入口 import 清单 / 令牌桥全表 / 级联层 / 作用域根类 / `@source`）、`tests/ui-bundle.spec.ts`（核心包与 chunk 的双向产物断言 + 体积预算）、`tests/ui-shadows.spec.ts`（静态面板零阴影）。`tests/theme.spec.ts` 追加「迁移后皮肤契约」一节：`src/client/ui/**` 与迁移文件的**颜色字面量**、**Tailwind 默认调色板类**与**未解析 `var()`** 三类回归。

### 迁移返工记录（门禁与审查发现）

**1. 体积 → 任务页整体下沉为懒加载 chunk。** 见上一节的返工说明：核心包从 988.5 KiB 降到 835.6 KiB（净减 153.0 KiB），shadcn/radix/Tailwind 产物（706.7 KiB）随 `lib/client-tasks.js` 按需加载。这次返工同时把 Tailwind 样式表挪进 chunk——它只服务任务页，没有理由占启动路径。

**2. React 18 的 ref 兼容（vendored 组件的必要本地适配）。** DSH 宿主跑的是 **React 18**（`@deepseek-ai/dsh-client-ui-primitives` 的 peer 是 `react@^18.2.0`），而 shadcn registry 的组件是按 **React 19** 写的（19 起 `ref` 是普通 prop，所以上游 `Button` 刻意不写 `forwardRef`）。后果：`<TooltipTrigger asChild><Button/></TooltipTrigger>` 里 radix 的 `Slot` 把 ref 递给函数组件会被丢掉 —— **dev 构建打印 "Function components cannot be given refs"，生产构建静默地量不到锚点**（浮层定位失效）。修法是在 `src/client/ui/button.tsx` 上做一处有注释的本地适配（`React.forwardRef`），并在文件里写明升级时会被 CLI `--diff` 抹掉、需要重新施加。**这条只在 dev/可视化 harness 里可见，生产 bundle 不报错，所以 mount e2e 抓不到它** —— 依赖 harness 的 console 断言。

**3. 密度回归 → 卡片两行标题。** 迁移把卡片文字从 11px 提到 shadcn 的 13px，但节点宽度仍是 132px：实测标题只剩约 7 个汉字（"图形重布重写" 被截成 "图…"），密集场景下比迁移前更难读。修法：`GRAPH_NODE_W` 132 → 150、标题改 `text-xs` + `line-clamp-2` + `[overflow-wrap:anywhere]`、`GRAPH_NODE_H` 46 → 60 预留两行高度（`GRAPH_LIVE_H` 13 → 14）。**教训：换字号必须同步核对卡片宽度预算**。

**4. 模型去重（重复 React key 的根因）。** 可视化 harness 在压力 fixture 上抓到 `sub-live-011` 等三个重复 key：根因在 `tasks-model.ts` —— workflow member 的 `childId` 若**不在 run 发起者的 catalog 里**（但存在于树中别处），代码会走"合成节点"分支，生成一个与真实节点**同 id** 的第二张卡片。修法：先按整棵树收集 `knownAgentIds`，只对 catalog 完全不知道的 id 合成节点；并在返回前加一条"每个 session id 只出现一次"的兜底去重。新增两条单测（已知 member 不重复 / 未知 member 仍合成）。

### 升级路径（未来用 shadcn CLI `--diff` 跟进上游）

`components.json` 已把 CLI 上下文钉在这个仓库上，`npx -y shadcn@latest info` 能正确列出 16 个已装组件（`base: radix`、`tailwindVersion: v4`、`tailwindCss: src/client/ui/theme.css`），所以**不要手动从 GitHub 抄文件**，走 CLI：

```bash
npx -y shadcn@latest info                        # 当前上下文与已装组件清单
npx -y shadcn@latest add <component> --dry-run   # 先看会动哪些文件
npx -y shadcn@latest add <component> --diff      # 逐文件看上游 vs 本地差异
npx -y shadcn@latest add <component>             # 确认后再落盘
```

**实测**（`npx -y shadcn@latest add button --diff`，本次迁移后执行）：上游会把 `cn` 的 import 写回裸包名 `"cn"`、带回 `dark:bg-destructive/60` 与 `dark:focus-visible:ring-destructive/40`、把 `text-destructive-foreground` 换回 `text-white`、给 `outline` 加回 `shadow-xs`、并恢复被删的 `link` 变体与 `xs` / `lg` / `icon-xs` / `icon-sm` / `icon-lg` 五个尺寸——正是本文件记录的六类统一改动。所以升级的流程是**逐文件判断**：没有本地改动的文件可被覆盖，有本地改动的（几乎全部）读 diff 后**只取上游的结构性更新，重新施加本仓库的六类改动**——尤其 `input.tsx` 的 `file:` 类一旦回来，`tests/ui-bundle.spec.ts` 的 preflight 守卫会开始误报。落盘后必须复跑三个守卫 spec（`ui-foundation` / `ui-bundle` / `ui-shadows`）与 `pnpm build`（体积测量是 `ui-bundle` 的一部分），再跑 `pnpm vitest run tests/theme.spec.ts` 确认皮肤契约未被上游带回的颜色字面量破坏。

`--overwrite` 与本仓库不兼容：它会一次性抹掉上面全部改动。真要用，先 `git stash` 出可对比的基线。
