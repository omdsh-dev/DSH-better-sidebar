# 任务管理页「工作图」打磨：双段式卡片 + 主 Agent 同款合并活动 + 折叠聚合 + 窄栏可读性

日期：2026-09-27　分支：`feat/tasks-graph-polish`（基于 `feat/tasks-graph-workflow-teams`，接 PR #680）

## 背景：为什么不是「再做一版卡片列表」

上一轮（`feat/tasks-page-card-redesign`）把任务页当成「树 + 卡片」重做了一遍，方向被用户否掉：**主显示模式仍然是工作流图**（`feat/tasks-graph-workflow-teams` 里那一版图），树模式保留即可；图模式才是与官方做出差异化的地方。用户随后给出这一轮的 brief（原文）：

> 参考图分支，将其 UI 等合并到之前我说的现代美观干净的风格：
> - 改为组合的双段式的结构，即上方为显示节点类型和节点详细内容，而下方是一个小条，用于显示当前的状态、执行的及执行的工具，已完成、折叠展开等操作。
> - 执行时有一个从左到右扫光的特效，同时执行的工具逻辑和主 Agent 中合并显示的逻辑一样。
> - 当为已完成的状态时，要有一个可点击的折叠按钮，在下方的小横条中。
> - 优化排布逻辑，考虑有很多节点/阶段的情况，考虑窄屏的特点。

因此这一轮 = **图分支的骨架 + 上一轮验证过的视觉/交互语言**。上一轮的卡片 UI 与树改造整体丢弃，只把钱花在已验证的数据层上（见「移植与丢弃」）。

## 用户确认的决策（问答摘要）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 打磨范围 | ② 运行中节点的扫光/执行态视觉；③ 后台任务改读 `ctx.jobs`；④ 图布局与窄栏可读性；⑤ 折叠聚合打磨 |
| 2 | 「阶段」要不要做成可展示列表 | **不要**：「阶段做到卡片徽标 + 颜色标明分组即可」 |
| 3 | 阶段徽标针对哪种分组 | **两者都要**：层级/分支分组 + workflow 相位分组 |
| 4 | 图节点双段式怎么落地 | 图上也是**真两段**（宽度保持现有量级，高度按新结构重算） |
| 5 | 树模式要不要一起换新语言 | **不要**：树模式保持现状 |
| 6 | 图节点小条上的折叠按钮 | **收进「已完成聚合」**（不是收起上段） |
| 7 | 窄栏具体痛点 | a 卡片太窄文字被截 / b 偏小、不居中、缩放手感 / c 节点内信息太密 / d 连线与相位框 / e 拖拽与缩放手感 / f 折叠聚合 —— 全选 |
| 8 | 代码落点 | 本工作区从图分支开新分支；上一轮版本丢弃 |

## 架构与文件

```
host 半（src/）
  process-activity.ts     新增：宿主 ui-chat 的 process group 算法移植（分类 / live 详情 /
                          范围切割），裁剪掉逐阶段列表（阶段改由徽标表达）
  subagent-live-route.ts  改为：树内每个子节点（含已结算）与拓扑根都回一帧
                          SidebarChildLiveView { running?, text?, summary?, lastEventTime? }
  context-types.ts        SidebarChildLiveView / SidebarClientJobsService / SidebarJobsSnapshot /
                          SidebarObservedJob；SidebarJobView 补 owner、progress
  删 jobs-routes.ts        自建三条路由退出历史（见下）
client 半（src/client/）
  process-labels.ts       新增：宿主 chat 命名空间措辞（liveActivityLabel / doneActivityTitle）
  tasks-card.tsx          新增：卡片两段（CardTop / CardBar）+ 类型徽章 + 深度/相位色阶
  jobs-client.ts          新增：ctx.jobs 读取层（watchRows 引用计数 / observe / collectRows）
  block-labels.ts         新增：TerminalBlock 的 labels（零新增词条）
  TasksGraph.tsx          三个节点渲染器改双段式；fit / 缩放 / 平移 / 连线重做
  tasks-graph.module.css  卡片两段 / 徽标 / 小条 / 扫光 / 相位框配色
  tasks-graph-layout.ts   卡片高度预算按新行重算，宽度 176 → 190
  SubagentView.tsx        foldedIds（手动折叠集）+ 树内 jobs 改读客户端服务
  sidebar/use-host-feeds.ts  任务自动激活改骑推送 roster（detectNewJob 加观测起点时钟）
```

## 关键设计

### 1. 卡片两段（图模式）

```
┌────────────────────────────────┐
│▎[类型徽章] [相位徽标]            │ ← 上段：身份 + 组色左描边（2px）+ 极淡底色
│ 名称（最多两行 clamp）           │
│ mode/model · 角色（mono）        │
│ ☑ 任务主题 · 状态 +N（团队成员）  │
├────────────────────────────────┤
│ ● 运行中 · 正在运行命令 · npm… ⌄ │ ← 小条 22px：状态点 + 状态词 + 合并活动 + 折叠
└────────────────────────────────┘
```

- 类型徽章用页面自己的词汇：`subagentMainAgent`（主代理，复用）+ 新增 `tasksKindSubagent` / `tasksKindTeammate` / `tasksKindWorkflow`；聚合节点用 `tasksFoldCompleted`（`✓N 已完成`）。
- **组色 = 树深度**：4 档令牌色阶（`color-mix(in srgb, var(--dsw-alias-state-business-primary) 100/72/48/28%, transparent)`），作用于左描边与上段底色；更深层级钳到最后一档。
- **相位徽标 = workflow 相位**：走 ink 色族（`--dsw-alias-label-primary` 的 100/78/58/42% 色阶），与组色族分开，避免两套分组撞色；虚线相位框保留（空间分组），改用同色极淡描边。
- **皮肤契约约束**：宿主不提供图表调色板，插件也不允许硬编码颜色，所以「颜色分组」只能做成令牌色阶 —— 这是本轮唯一被契约限死的设计点，不是取舍。

### 2. 合并活动（主 Agent 同款）

`foldProcess(events, { live })` 把子会话日志折成宿主 process group 的形状：分类计数（`activityOf` 表逐条照抄）、最新未结算调用（含 `preparing` = 模型宣布但未派发）、`runningDetail`（宿主键优先级 + 160 字 grapheme 截断）、范围边界（`user/message` 与带文本的 `assistant/message`）。客户端 `liveActivityLabel` / `doneActivityTitle` 用宿主 `chat` 命名空间的 `message.stepProcess.*` 词条合成措辞（`chatT` 失败即回退插件文案），所以卡片上的字与主对话完全一致。

**一条刻意偏差**：最新范围为空（子代理刚回复完）时回退到上一个「做过事」的范围 —— 否则已结算卡片的小条只会显示「已完成分析」。回退范围永不报告运行中。

### 3. 扫光（执行态）

小条 `data-running="true"` 时叠加一条 45% 宽的令牌渐变带，`background-position 0% → 100%`，1.5s `cubic-bezier(0.33,0,0.67,1)` 循环、末 1/3 停顿；`prefers-reduced-motion: reduce` 下关闭动画（状态词与活动文本已承载同样信息）。方向从左到右（用户确认；宿主的文本 shimmer 是反向，这里刻意不同）。

### 4. 折叠聚合

- 页面持有 `foldedIds`（读者从卡片小条逐个收起）与 `folded`（控制条的全局规则），模型里两者走**同一组守卫**：只折已结算叶子、永不折当前会话、永不折有子节点的、永不折团队成员。
- 聚合节点（`fold:<parentId>`）点击 = **全部展开**（清空手动集 + 关闭全局折叠）；控制条按钮只切全局规则。
- 折叠/展开不重置读者当前的缩放与平移（自动 fit 只在读者未触碰视图时生效）。

### 5. 后台任务改读宿主客户端服务

0.1.7 的 web profile 挂载 `ctx.jobs`（`@deepseek-ai/dsh-api-job-controller/client`）：`state` 是整份快照（按被观察会话的 roster + 按任务 id 的保留输出），`watchRows` 是按会话引用计数的**推送** roster，`observe` 是**非消费**输出流（返回释放函数），`kill` 是注册表准入。插件因此删掉自建的三条路由与事件回放：

- 删除 `src/jobs-routes.ts`、`index.ts` 的 `jobs.list/output/kill`、`api.jobsList/jobOutput/jobKill`、`SidebarJobsService`、页面的 `jobs.list` 轮询与 `collectTreeJobs`；
- 抽屉的行来自推送 roster（状态/时长/owner/进度）、输出面换宿主 `TerminalBlock` 显示观察流（`gapBefore` → 截断提示、`error` → 失败提示）、kill 走 `jobs.kill(owner, jobId)`（两击确认不变）；
- 无 `ctx.jobs` 的部署**整段不渲染**（结构性降级），插件的其它面不受影响。

**旧路由为什么必须死**：它读的是「模型已读到的输出」（事件回放），因为注册表当时只有模型的**消费**游标可读；宿主服务把这条约束变成了能力（观察流不碰游标），继续维护回放既多余又永远落后于流。

### 6. 布局与窄栏（a–f 全项）

- 卡片高度预算重算：徽章 16 + 两行标题 36 + 元信息 16 + 小条 22 + 内边距 11 + 边框 2 = **103px**（团队成员 +18 任务行）；宽度 176 → **190px**（360px 侧栏仍两列，缩放 ~0.86）。**live 行不再占高度** —— 合并活动在小条里，任何状态的行高一致。
- fit 按**内容包围盒**（而非含 padding 的整张画布）双轴居中，`FIT_MAX_SCALE` 1.15 → 1.30；空画布**双击**重新适配并恢复自动 fit。
- 缩放范围 0.3–1.5 → **0.4–2.0**，并按 `deltaMode` 归一化滚轮刻度（行模式鼠标不再比触控板慢 30 倍）。
- 平移加**边界夹取**（至少 72px 内容留在视口内），拖不出视野。
- 连线改「垂直出线 stub（8px）+ 贝塞尔」，线宽 1 → **1.5px**（0.78–0.86 的 fit 缩放下 1px 会落到一个设备像素以下，整棵层级会糊掉）。

## 移植与丢弃

| 上一轮产物 | 处置 |
|---|---|
| `src/process-activity.ts` + 44 例 | **移植并裁剪**（删逐阶段机制，保留分类/详情/范围切割）；新增「空范围回退」一条并补测 |
| `src/client/process-labels.ts` + 10 例 | 原样移植 |
| `chatT` + 4 例回归（含「不许解绑 bind」） | 原样移植 |
| `src/client/block-labels.ts` | 原样移植（jobs 输出面复用） |
| `ctx.jobs` 读取层（`clientJobs` / `useJobsSnapshot` / `collectRows`） | 移植数据层；展示组件丢弃（本分支有自己的抽屉） |
| `subagents.live` 新载荷 + `SidebarChildLiveView` | 移植（去掉 `expand`/`stages`） |
| 卡片 UI（`subagent-card.tsx` / `subagent-runs.ts` / 树重写 / 5 个词条） | **丢弃** |

## 后续变更（同日，`2026-09-27-floating-window-mobile-settings.md`）

本文描述的卡片语言随后被两处调整：**左侧竖条（层级条 + 当前会话条）删除**，层级改由上段极淡底色承担、
当前会话改用加粗 accent 描边；**圆角 4px → 8px**。任务输出的锚定浮窗也换成了常驻浮动窗。
以新文档为准。

## 后续修正（2026-09-27，用户反馈）

用户反馈两条，都在真机上定位并修掉：

### 1. 扫光只有「部分」→ 改成整条完整扫过

第一版用 `background-size: 45%` 的窄带 + `background-position: 0% → 100%`：亮带确实在移动，
但它始终只覆盖小条的一部分（峰值从 22.5% 走到 77.5%，两端永远扫不到），看起来像中间游走的
一小块光斑。现改为**与小条等宽的渐变带 + `transform: translateX(-100%) → translateX(100%)`**：
光带从左边外侧进入、中途覆盖整条、再从右边外侧离开，行程就是用条宽本身表达的（任意条宽都成立），
末 1/3 周期停在右侧外侧（两轮之间留白）。`tests/theme.spec.ts` 新增一条守护钉住这个形状。

真机证据（242px 宽的小条，每 90ms 采样一次 `::after` 的 `matrix` 平移量）：
`[-23, 32, 85, 131, 163, -139, -94, -46, 9, 64, 114, 152, 179, 188]` —— 光带在小条左侧
（-139）到右侧（+188）之间被连续观察到，单调推进、跨度超过一个条宽；并截到一张行程中的帧。

### 2. 折叠按钮与展开按钮长得一样 → 两者分向

三处控件原来共用向下箭头（`IconChevronDownOutlineRegular`）：卡片的逐节点「收进已完成聚合」按钮、
聚合卡片的「展开」、以及控制条的折叠开关（后者更糟：无论将要折叠还是展开都画同一个清单图标）。
现在按**动作方向**区分：

| 控件 | 折叠方向（chevron up） | 展开方向（chevron down） |
|---|---|---|
| 卡片小条的逐节点按钮 | ✅ `收进已完成聚合` | — |
| 聚合卡片的小条 | — | ✅ `展开已完成的节点` |
| 控制条折叠开关 | ✅（当前已展开时） | ✅（当前已折叠时） |

真机证据（比对三处 `<svg>` 内容）：`expandVsCollapse: true`（两个方向确实不同）、
`clusterMatchesExpand: true`（控制条在折叠态画的就是聚合卡的展开箭头）、
`clusterFlips: true`（状态切换时图标跟着换）、`clusterCollapseMatchesCard: true`
（控制条的折叠箭头与卡片逐节点按钮一致）。组件级守护见 `tests/tasks-page.spec.tsx`
的「draws COLLAPSE and EXPAND with different glyphs」。

### 3. 小条里「运行中」与「正在分析请求」没对齐 → 两者统一字体

字体度量问题，不是布局问题：两者的行盒完全一致（都是 11px/14px、`align-items: center` 下
同一位置），但 11px 下 sans 字族的 ascent/descent 是 **11/2**，而 mono 字族是 **10/3** ——
基线因此低 1px，蓝字看起来就是没对齐。而中文在这个 mono 栈里本来就走同一个 CJK 回退字族
（PingFang SC），mono 只改到句子里的拉丁片段，等于「半句等宽、整体低一像素」。

修法是让两者共用小条自己的字族（`.barActivity` 不再声明 `font-family`）；机器文本的等宽语气
留在它该在的地方（上方 meta 行、后台任务行、终端输出井）。`tests/theme.spec.ts` 增加守护：
`.barActivity` 不得声明 `font-family`。

真机证据：真实运行中卡片的小条（3× DPR 截图 `/tmp/dsh-selfcheck/17-bar-real.png`）两段文字
同处一行，且两个 span 的 `font-family` 计算值完全相同（断言 `new Set(fonts).size === 1` 通过）。

## 实施偏差记录（写给复审）

1. **`process-activity.ts` 是裁剪版而不是原样搬运**：本轮「阶段」= 徽标 + 颜色，逐阶段列表没有消费者，留着就是死代码。裁剪后 44 例 → 30 例（阶段相关用例随机制一起删除）。
2. **`CardBar` 的折叠 chevron 用新词条 `tasksFoldOne`（收进已完成聚合）而不是复用 `tasksFoldCollapse`（折叠已完成的节点）**：后者已经是控制条全局开关的可访问名，同一个 aria-label 出现在两个按钮上会让屏幕阅读器与测试都无法区分「折一个」和「折全部」。
3. **`TasksAgentNode.depth` 是为此新增的字段**：卡片组色需要层级，而模型的递归本来就知道深度；顺带给图节点加 `data-depth`（用户 CSS 与测试的可寻址面，和树行的 `aria-level` 同性质）。
4. **`detectNewJob` 加了第三个参数（观测起点时钟）**：roster 改成推送后，宿主在「该会话没有任务」时会**删掉这个 key**，于是空的首页帧与「还没送到」不可区分 —— 页面挂载时已经在跑的任务会被 id 差集误判成新工作并弹任务页。用 `job.startedAt >= 观测开始时刻` 过滤；自动激活 spec 里两条用例钉住这个语义。
5. **两个测试期望被改而不是改代码**：`subagent-live-polling.spec.tsx` 原先断言卡片上有「思考中…」/「hello」文本行 —— 那是旧卡片的 live 行，现在文本行只在小条的活动行里；`subagent-jobs-view.spec.tsx` 的「多任务仍紧凑」用例原先假设抽屉默认折叠，而折叠阈值数的是**代理数**（1 个代理 → 默认展开）。两处都是断言跟随设计，不是放宽。

## 验证证据（2026-09-27）

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 0 错误 |
| `pnpm lint` | ✅ 0 错误 |
| `pnpm test` | ✅ **1240 passed / 9 skipped / 0 failed**（119 文件） |
| `pnpm build` + `pnpm pack` | ✅ tarball `dsh-better-sidebar-0.21.1.tgz`，`lib/client.js` 含 `dsh-tasks-bar-sweep` 与卡片类 |
| 新增/改写的守护 | `process-activity`（30）/ `process-labels`（10）/ `tasks-model`（depth、phase、foldedIds）/ `tasks-graph-layout`（新高度预算与带宽）/ `tasks-page`（双段结构、`data-running`、chevron→聚合、聚合→全展开、相位徽标）/ `subagent-jobs-view`（14，假 `ctx.jobs`）/ `sidebar-auto-activation`（12，假 `ctx.jobs`）/ `locales`（新词条 ×20 词典） |
| `pnpm test:mount` | 见下节（真机挂载 lane） |
| 3080 真机自测 | 见下节（Playwright 驱动真实工作 + 截图） |

### 真机挂载 lane

`DSH_CMD=/tmp/dsh-rc-home-shim.sh DSH_EXPECT_VERSION=0.1.7-rc.2 bash scripts/e2e-mount.sh` → **7 passed**（日志 `/tmp/e2e-polish.log`）。本地的 shim 是必需的：桌面版 `~/.local/bin/dsh` 把 `DSH_HOME` 硬编码成 `~/.dsh`，lane 的 scratch profile 会写进真实配置目录。lane 同时证明宿主侧挂了 `@deepseek-ai/dsh-api-job-controller/client.js` 与 `@deepseek-ai/dsh-client-ui-jobs/client.js`（本轮 `ctx.jobs` 依赖的服务确实在 web profile 里）。

### 3080 真机自测（真实工作 + Playwright）

装法：`cp` 到一个**新文件名**再 `dsh plugin --profile web add file:...` —— 同路径同版本号的 tarball 会被 pnpm 当成已装而不换内容（实测：旧的 client bundle 仍在，页面渲染的还是上一轮的卡片版）。装完 `pm2 restart dsh-web`，从 pm2 日志取一次性 token。

驱动真实工作（两个后台任务 + 一个子代理），逐项核验：

| 目标 | 真机证据 |
|---|---|
| G1 双段式 | 根卡 innerText = `主代理 / 并行启动后台任务与统计子代理 / 运行中 / 正在分析请求`（徽章 + 名称 + 小条），每张卡都有 `[data-card-bar]` |
| G2 扫光 | 运行中小条的 `::after` computed style：`animationName` 含 `dsh-tasks-bar-sweep`、`1.5s`、`cubic-bezier(0.33, 0, 0.67, 1)`、`infinite`、`background-size: 45% 100%`，采样时正处在 `6.03%` 的行程中 |
| G3 合并活动 | 小条文案 `正在分析请求`（宿主 `chat` 词条的运行时输出，不是插件自造词）；结算后读数为 `已调用工具` / `已完成分析` |
| G4 折叠聚合 | 一次点击 `button[aria-label="收进已完成聚合"]` 后该节点从画布消失、聚合卡出现（`✓ 1 已完成 / Count files in directory`）；点聚合后节点回归 |
| G5 徽标与组色 | 卡片徽章 `主代理` / `✓ 1 已完成`；上段左侧 2px 组色描边在截图中可见；相位徽标**未在真机复现**（该实例没有 workflow run） |
| G6 窄栏 | 视口收到 820px 时宿主把面板给到 **364px**：面板 `scrollWidth == clientWidth == 364`（无横向溢出）、文档两轴都不可滚、画布 363×672、卡片 **247×134**（= 190×1.30 / 103×1.30，与布局预算逐像素一致）、小条 30px（= 22×1.30）、fit 读数 130% |
| G7 后台任务 | 抽屉显示两个真实任务（`运行中 · 0 秒` / 结算后 `已完成 · exit code: 0 · 30 秒`）；点开一行后输出浮窗用宿主 `TerminalBlock` 流式显示 `tick 1`（`ctx.jobs.observe` 的非消费流），并带 `终止`（两击）与 `跟随最新` |
| 无崩溃 | 无 pageerror、无插件错误条 |

截图：`/tmp/dsh-selfcheck/01-running-graph.png`（运行态）、`02-job-stream.png`（后台任务输出流）、`03-settled-graph.png`、`04-folded-one.png`、`05-final.png`、`06/08-narrow*.png`（364px 窄栏）。

**未在真机复现的两项**（如实记录）：① 相位徽标/相位框的真机观感（该实例没有 workflow run，无法在不造数据的前提下产生）；② 扫光的**像素级**运动（只验证了 computed style 与行程采样，没有做逐帧像素 diff）。另外宿主面板的宽度手柄对本轮的合成拖拽不响应，窄栏是通过视口宽度达成的。

### 已知取舍（复审可见）

- 组色只能做成令牌色阶（宿主无图表调色板，皮肤契约禁止字面色），超过 4 档的深度钳到最后一档：颜色不再区分，徽章文本仍区分。
- 结算节点的合并摘要只反映「最近一个做过事的范围」；再往前的历史只能进节点详情浮窗。
- `Session.snapshotEvents()` 在 0.1.7 标了 `@deprecated`（实现是缓存冻结快照，成本可接受），折叠过程只扫到第一个可汇报的范围边界。
