# 任务管理页：小条只说原生状态 + 按组展开 + 浮窗活动行

日期：2026-10-11　分支：`feat/tasks-status-and-group-fold`（自 `dev` 顶端 `64a61cc` 切出）

## 背景：用户 brief（原文）

> 优化任务管理面板：
> - 下方条不再显示运行中，进行中时直接写为：正在分析请求/正在准备读取文件/正在更新计划等待这个原生的状态，现在往往大部分时间是一直显示正在分析请求
> - 最近活动的内容可以以小字号的形式写到标题下方
> - 优化下展开/折叠的逻辑，不要点一个展开就把全部都展开
> - 其他你认为需要优化的UI部分
>
> 保持KISS原则，如有任意不清楚的地方，都向我详细确认

「下方条」经确认 = 图模式卡片的下方小条（`src/client/tasks-card.tsx` 的 `CardBar`），它当时的真机读数见
[2026-09-27-tasks-graph-polish.md](2026-09-27-tasks-graph-polish.md) G1：根卡 `主代理 / … / 运行中 / 正在分析请求`。

## 用户确认的决策（问答摘要)

| # | 问题 | 结论 |
|---|---|---|
| 1 | 「下方条」范围 | **图模式小条**：状态点 ＋ 原生状态，不再出现「运行中」；**树模式行内 meta 保持现状**（仍是「一次性 · 运行中」），本轮不动 |
| 2 | 「一直是正在分析请求」怎么处理 | **两处都修**：① 根卡接上 live 数据；② 浮窗按节点状态取措辞、无数据就不显示该行 |
| 3 | 「最近活动」写到哪里 | 节点详情浮窗**去掉「最近活动」标签**，内容以 10px 小字写在标题下方（对应词条一并删除） |
| 4 | 展开/折叠语义 | **点聚合卡只展开该组**；控制条按钮仍是全局展开/折叠 |
| 5 | 其它 UI 优化（多选） | ✅ 树模式实时行图标按活动类别取 ✅ 已结算小条同样去重（不显示「已完成」） ✅ 聚合卡不再两处都写计数 |

## 现状与根因（读码核实，非推测）

1. **小条渲染两段**：`CardBar` = `[状态点] 状态词 + 活动行`。运行中卡片因此是「● 运行中 正在运行命令 · npm run build」——状态词与活动行说了同一件事。
2. **根节点没有 live**：`buildTasksModel` 的根节点字面量不含 `live` 字段（子节点有），而 `subagent-live-route.ts` 早已把根的 fold 结果放进 `live[rootSessionId]`。于是**主代理卡片的状态文本恒为 `liveActivityLabel(undefined)` 的 thinking 兜底**，它与主会话在做什么无关——这就是「大部分时间一直显示正在分析请求」的第一处真因。
3. **浮窗的活动行恒有话说**：`AgentNodePopover` 用 `liveActivityLabel(node.live?.summary)`；`summary` 为 undefined 时宿主词典在真实部署里存在，函数返回 `message.stepProcess.thinking`（正在分析请求）。于是**每个节点的详情浮窗几乎恒显示「最近活动：正在分析请求」**，已结算节点也走运行中措辞——第二处真因。
4. **聚合点击 = 全部展开**：`SubagentView.expandFold()` 清空 `foldedIds` 并 `setFolded(false)`；树里的聚合行也是 `onToggleFold`（全局）。两处都是「点一个，全开」。
5. **聚合徽标印的是字母 N**：`tasksFoldIdleGroup` 在 20 份词典里都是字面量 `'N waiting' / 'N 个待命'`（无 `{count}` 插值），徽标因此永远显示「N 个待命」。
6. **树模式实时行恒画终端图标**：`LiveLine` 写死 `toolGlyph('bash')`，而 `tool-icons.tsx` 的工具名映射其余部分是死代码（该函数只有这一个调用点）。

## 关键设计

### 1. 状态词让位活动行（`CardBar`）

```
运行中卡片     ● 正在读取文件 · main.ts        ← 活动行取代状态词（原生措辞）
已结算卡片     ● 已读取文件、执行了命令        ← 同为活动行
空闲 / 出错    ● 空闲  …    ● 出错 已调用工具  ← 保留状态词
无任何数据     ● 运行中 / 已完成               ← 回退状态词，小条不空
```

- 判据：`activity` 非空且 `state` 不是 `idle` / `error` 时不渲染状态词。**`idle` 与 `error` 刻意保留**：「待命」「失败」不被任何活动措辞蕴含，去掉就是把那条小条唯一该说的话藏起来（这条写进了 `CardBar` 的 docstring）。
- 状态点、`data-running` 扫光、折叠 chevron 全部不变；卡片高度预算（小条恒 22px）不变，所以 `tasks-graph-layout.ts` 与画布几何零改动。

### 2. 一条共享的活动规则 `activityLine(node)`

`tasks-shared.tsx` 新增（卡片小条与详情浮窗共用，两处不可能再各说各话）：

```
summary === undefined            → undefined（调用方回退状态词，绝不谎报）
state === 'running'              → liveActivityLabel(summary)   // 宿主 message.stepProcess.*
否则（done / idle / error）      → doneActivityTitle(summary)   // 宿主 message.stepProcess.done.*
```

它替掉了 `TasksGraph` 里私有的 `barActivity`，也修掉了浮窗对已结算节点用运行中措辞的问题。

### 3. 根节点接上 live

`buildTasksModel` 的根节点 push 带上 `live: childLive(live, rootId)`（缺失时不挂字段）。
由此：主代理卡片显示真实状态；树模式根行的实时行也从恒定的「思考中…」变成真实活动。
`live[rootId]` 为空对象时行为退回状态词——这是**有意的**：不知道的事不说。

### 4. 按组展开

- 模型新增入参 `expandedGroups?: ReadonlySet<string>`，键是**组 id**：`foldGroupId(foldKind, parentId)` →
  `fold:<parentId>`（已完成组）/ `fold:<parentId>:idle`（待命组），`foldNode()` 与页面共用它，一处定义。
- 折叠判定只在「本来要折」的分支上追加一次询问：组被展开 → 该成员落回 `kept`（保持目录顺序），
  兄弟组、页级规则与逐节点手动折叠**都不受影响**。
- 页面：`expandGroup(node)` 把组 id 入集，并把 `node.memberIds` 从 `foldedIds` 摘掉
  （聚合点击的含义是「现在给我看这些节点」，不该被手工折叠留在里面）；
  **控制条收起时清空 `expandedGroups`**（全局收起必须真的收起），展开时不动它。
- 树里的聚合行同一语义，行内副文案固定为「展开」——该行只在折叠态存在，旧实现按页级 `folded` 写「折叠」是自相矛盾的。

### 5. 聚合卡计数只说一次

徽标是计数的家：待命组徽标改为 `tasksFoldIdleGroup` 的**真实插值**（`{count} 个待命`），小条只保留
`foldErrorTally(node)`（`出错 N`，无出错则空）＋展开箭头。完整 tally（`foldTally`）仍是卡片的
`aria-label` 与 tooltip —— 屏幕阅读器看不到徽标，只有这一条路。

### 6. 实时行图标按活动类别

`tool-icons.tsx` → `activity-icons.tsx`：`activityGlyph(kind: ProcessActivity | undefined)`，
`Record<ProcessActivity, Glyph>`（**类型强制全覆盖**，上游加类别会编译失败而不是静默兜底）。
`undefined`（尚未派发，宿主措辞就是「正在分析请求」）→ 思考图标。已删除无消费者的工具名映射。

## 实施偏差记录（写给复审）

1. **README 的 v0.22.0 发布说明改写了两条（zh 227/229）＋ en 对应两条**（计划里原写「同步 4 条」）。
   过程记录：`git log -L` 显示那四条自 2026-09-27 的发布提交后再未被任何提交碰过——它们是**冻结的发布历史**，
   而仓库的进行中通道是 `CHANGELOG.md` 的 `### Unreleased`（先例：`2f66c92` 的 #774 批次）。初版因此只写了
   CHANGELOG + 本文档并把偏差报给维护者；**维护者随后明确选择「现在就改写那四条」**，故按当前行为改写
   （小条只显示原生状态、聚合按组展开 + 徽标真实计数），CHANGELOG 的 Unreleased 段同时保留。
2. **`idle` / `error` 保留状态词**：用户选项只点名了「运行中」与「已完成」。这两个状态的活动措辞
   （子代理的 `done.*` 摘要）读起来都像「刚做完事」，去掉状态词会把「在等下一轮」「失败了」藏起来。
3. **`tasksFoldIdleGroup` 是插值改动而不是删词条**：它本来就是给徽标用的键，只是值写成了占位符
   `N`。改为 `{count} …`（zh/en/zh-HK/zh-MO/zh-TW/ja 各自保留自己的语序），20 份同批改。
4. **`tasksNodeActivity` 从 20 份词典删除**（不是留着不用）：浮窗那一行没了，留着就是死词条；
   `tests/locales.spec.ts` 的键集合相等守护要求这一次同批改完。
5. **`CardBar` 的判定写在组件里而不是调用方**：`stateWord` 是调用方参数（聚合卡传 false），
   「活动行取代状态词」是同一条呈现规则的内部细节，让每个调用点各判一次只会让两处漂移。
6. **树模式行内 meta 不动**（用户明确选择）。它仍是「一次性 · 运行中」＋下方实时行，
   与图模式小条的读法不同是有意保留的差异。
7. **自查抓到并修掉的一处判据反了**：按组展开的清空时机最初写在**展开**分支上
   （`if (folded) setExpandedGroups(∅)`），应该写在**收起**分支（`if (!folded) …`）——否则
   「页级展开 → 手工折一个 → 打开该聚合 → 点控制条收起」会留下那个组仍然展开，而兄弟节点全折了。
   已补 `tests/tasks-page.spec.tsx` 的「drops the per-group openings when the CLUSTER collapses the page」
   用例；把判据翻回去即红（实测），这条用例是判别性的。

## 第二轮（用户真机测试反馈，同日）

用户在 3080 实例上实际测试后报回六条，逐条处置：

| # | 反馈 | 处置 |
|---|---|---|
| 1 | 已完成的【聚合】卡下方空荡荡 | **是我上一轮的取舍造成的**：把计数收进徽标后，没有出错时那条只剩右侧一个 chevron。现在小条是**动作行**：组图标 + 「展开」+ 出错尾注 + 展开箭头（`tasksFoldExpandShort` 新词条，20 份词典） |
| 2 | 展开后的子代理点不回去 | **真缺陷**：`expandedGroups` 压过了 `foldedIds`，导致展开组内卡片的 chevron 失效。改为**手动折叠优先**（手动 → 页级规则 → 组展开），并补两层判别性用例（模型 + 组件） |
| 3 | 一次性子代理一直显示「一次性」 | 模式词**搬进徽标行**成 chip（用户口径：「和可续接等状态放到和子代理那个徽标一行上」）。智能体卡因此不再有 mono 元信息行，卡片高度预算拆成 `GRAPH_AGENT_NODE_H` / `GRAPH_NODE_H`（只有 workflow run 卡保留元信息行），`rowStrideFor(nodes)` 按模型里有没有 run 选行距 |
| 4 | 动效，允许引入新库 | 用户选定 `@formkit/auto-animate`（~3KB，无依赖无安装脚本）。加 `useAutoAnimateRef` 包装（WAAPI 守卫 → jsdom 空转；尊重 `prefers-reduced-motion`），挂到画布卡片层 / 树视图 / 任务抽屉；详情卡另加 140ms 入场关键帧。核心 bundle 因此增大约 56KB（未压缩 CJS，含库源码 27KB） |
| 5 | 弹窗多显示 token 与耗时 | 新增 **Token 用量** + **耗时** 两行。数据来自宿主投影（`tokenUsage` 四桶求和；`subagentTiming` 已结算 + 本次运行，按页面 3s 轮询刷新），`SidebarProjectionSnapshot.values` 镜像补两个键、模型新增 `metrics` 入参。**按存在性渲染**：没有测量就不显示这一行（0 是投影的初始态，与「没工作过」不可区分） |
| 6 | 「查看转录」改为在侧边栏打开（原生能力），右侧加下拉按钮可在主窗打开 | 确认宿主确有该能力：`@deepseek-ai/dsh-client-ui-subagent` 注册 `subagentchat` tab 类型，宿主自己的子代理列表就是「点行 = 主窗、点 chevron = 侧栏」。插件照抄其地址公式（宿主不导出 builder/parser）并调 `openResource(addr, {kind:'subagentchat', preferNewPane:true})`，三级降级回主窗；页脚变为「主按钮 + caret 菜单（在主窗口中打开）」 |

### 第二轮的实施偏差与未验证项

1. **画布动效：FLIP 库 → 布局坐标补间**（维护者两轮真机反馈：「折叠展开的动效都特别怪」→「还是突然直接出现」）。
   读 `@formkit/auto-animate` 源码确认它在缩放层里两处几何都不可修：`remove(el)` 把离场元素重新插入 DOM 并钉上
   由 `getBoundingClientRect` 换算的绝对 `left/top/width/height`（卡片层带 `transform: scale(k)`，这个钉位无法表达
   → 跳位）；移动项用 `el.animate` 播未缩放的 `translate`，而量测是缩放过的（行程差 k 倍）。于是分两步收口：
   - **画布改用自己的补间** `tasks-layout-tween.ts`：rAF 逐帧插值每张卡在**画布坐标**里的 `x`/`y`/高度（`left`/`top`
     是画布单位，缩放对它和对终点位置一样生效），并把 `fromRef` 跟着**已绘制**状态走（中途再来一次布局变化时接着当前位置走，
     不会弹回上一个目标）。连线路径与相位框改为读**补间后的盒子**，所以线跟着卡片走；新入场的卡片在引入它的那一帧就带着
     目标盒子渲染（否则会有「先消失一帧再出现」的闪烁，首版实测就踩到了）。
   - **入场用 CSS 关键帧**：300ms 上浮 + `scale(0.88→1)` + 淡入（轻微过冲），按节点页序**错峰 26ms**，`fill-mode: backwards`
     让等待中的卡片先隐形。`prefers-reduced-motion` 下补间与入场都关闭。
   - **自动适配改为滑行**（维护者第三轮反馈：「最开始在 fit 档位，展开后也要是自适应的位置，避免节点溢出屏幕 / 不在中间」）。
     上一版让折叠「接管视图」，代价正是这一条。收口方式：**视图变换本身也补间**（`tasks-view-glide.ts`：把 fit 的算术抽成
     纯函数并单测，`applyFit(animate)` 用 rAF 把 `x/y/k` 从当前位置滑到新目标，220ms 与卡片同一条缓动）。于是
     「保持自适应」与「不许瞬跳」不再二选一：布局一变就滑到新取景，展开后画面仍是居中、内容仍完整；只有读者拖过 / 缩放过
     （`touchedRef`）才不再自动重框，任何读者手势（pointerdown / 滚轮 / 缩放按钮）都会立刻取消滑行。切会话仍旧直接落位（内容整体换掉）。
   - **FLIP 库保留在流式布局**（树视图、任务抽屉）；`tests/tasks-motion.spec.ts` 把「画布不得 import 它」写进守护，
     `tests/tasks-layout-tween.spec.tsx` 钉住插值 / 缓动 / 中途位置 / 画布尺寸不中途变化 / 入场盒子不缺席。
2. **真机只跑通到「插件挂载 + 零 pageerror」**：新构建已装进 `sidebar-test` profile 并在 http://127.0.0.1:3080 提供服务（`[data-dsh-better-sidebar]` 挂载、`/sidebar/api/*` 200、无 pageerror / console error）。但**动效与观感的逐帧复核没做成**：宿主右栏在无头上下文里以 `transform` 平移到视口外，我的合成点击无法稳定地把任务页调出来（多次尝试后放弃）。这一条由维护者自己在实例上看。
3. **实机数据的两个新行未在真机核验**：Token / 耗时两行通过夹具断言（25.5K / 2 分 42 秒）与 `session-metrics` 单测覆盖，但没有在真实子代理会话上截图确认数值口径（真实会话的 `tokenUsage` 是整段日志累计，包含 fork 继承前缀这一点已写进 `context-types.ts` 的注释）。
4. **`uses` 依赖新增**：`@formkit/auto-animate@^0.10.0` 进 `dependencies`（无 `cordis`、无安装脚本，市场约束满足）。本 worktree 的 `node_modules` 因此从符号链接物化为独立副本（源仓库未被触碰，见仓库规则）。


## 第三轮（同日，再次真机反馈）

用户在新构建上确认「非常好」，随即提两条：

1. **「最近活动的内容写到标题下方」这件事，卡片（详情弹窗外）也要有；两处都要限制显示量**。
   确认口径：卡片**小条保留合并活动**，标题下新增的是**最新助手文本尾行**（卡片此前没有、只有弹窗里有）；
   显示量用**行数**限制而不是字符数——两处都**最多夹三行**。
   实现：`textTailLines()`（按字符宽度估算折行、上限 3）在布局里为每个节点**预留实际行数**（预留最大值会让一行文本的卡片
   在状态条上方留一个 26px 的洞，正是用户此前抱怨过的「空荡荡」换了个位置），估算值同时写进卡片的 `-webkit-line-clamp`，
   渲染与预留因此永远一致；`rowStrideFor()` 改为按**模型里最高的一张卡**算行距。弹窗文本块同步 2 → 3 行。
2. **树状图显示改进**（多选：模式词 chip、嵌套层级动效、层级缩进/连线/密度）。本轮做了前两项 + 连线的实修：
   - 模式词从行内 mono 行搬成标题旁 chip（与卡片一致的读法），mono 行只留状态；
   - 新增 `TreeLevel` 组件：**每个嵌套层级各自拥有一个 FLIP host**（库只观察容器的直接子节点，单个 host 会让嵌套折叠硬闪）；
   - 连线从「整组一条 border-left」改成**每个子节点自己画的肘线**：竖线对齐父行的标记列，最后一个兄弟的竖线停在自身标记处
     （不再拖出组外）；
   - **密度刻意没有改**：树的 32px 行节奏（18px 标题 + 14px 元信息）与侧栏其它面同一套度量，压紧行高只会让它在面板里显得发紧。
     维护者若想要更密，给出目标值（例如 28px 节奏）即可单点调整。
## 第四轮（同日，第三次真机反馈）

用户：「树目录还缺单个收起/全部收起/全部展开的按钮」。

读码确认：树**根本没有按节点的展开收起**——它只有页级的「已结算节点聚合」（`FoldToggleButton`），
`aria-expanded="true"` 还是硬编码的，所以「全部收起/全部展开」在树的语境里也确实不存在。

实现（与既有折叠轴并存，互不干扰）：
- **单个收起/展开**：有子节点的行右侧一个 16px chevron（收起态 →、展开态 ⌄），位置与画布卡片小条的
  chevron 一致；叶子行不画（避免死控件）；点它 `stopPropagation`，不会同时打开详情窗。
- **全部收起 / 全部展开**：控制条里两个**文字**单元格（`controlText`，与集群里其它 28px 控件同形）。
  用文字而不是更多 chevron：旁边的「折叠已完成的节点」开关已经占了 chevron 的图形语汇，两套轴不能共用图形。
  「全部收」= 所有**有子节点**的节点（只留拓扑根）；「全部展开」= 清空集合。
- **键盘**：→ 展开折叠的行（已展开则进入子级）、← 收起展开的行（已收起则退回父级）——标准树绑定。
- **状态归属**：折叠集存在 `SubagentView`（与图/树切换、页级折叠同一层），切模式来回不丢。
- 与「已结算聚合」是两条独立的轴：一个收**子树**，一个把**已完成的叶子**收进聚合卡。

新词条 4 个 × 20 词典：`tasksTreeCollapseAll` / `tasksTreeExpandAll` / `tasksTreeCollapseRow` / `tasksTreeExpandRow`。
测试：`tests/tasks-page.spec.tsx` 新增 4 条（单个收放 + 叶子无控件 + 集群全收/全展 + 方向键收放）。

## 验证证据

| 项 | 结果 |
|---|---|
| `tsc --noEmit`（等价 `pnpm typecheck`） | ✅ 0 错误 |
| `eslint .` | ✅ 0 错误 |
| `vitest run`（全套） | ✅ **2238 passed / 17 skipped / 0 failed**（191 文件，含第二轮新增的 3 个 spec 文件） |
| `tsc -p tsconfig.build.json` + `tsdown` | ✅ 构建通过（核心 bundle 1,333,699 字节，较首轮 +56KB = auto-animate 及其包装） |
| 真机挂载（`sidebar-test` profile，DSH 0.2.0-rc.2，:3080） | ✅ 装进独立 profile 后 `[data-dsh-better-sidebar]` 挂载、`/sidebar/api/*`（settings.get / session.phase / session.cwd）200、**0 pageerror / 0 console error**；动效观感未逐帧核验（见偏差 2） |

本轮新增/改写的守护：

| 文件 | 内容 |
|---|---|
| `tests/tasks-model.spec.ts` | 按组展开（done 组开了、idle 组仍折叠；反向亦然）、组 id 就是聚合行 id、`expandedGroups` 盖过残留的手工折叠、run 成员组的展开、根节点带 live（含「无数据即无字段」） |
| `tests/tasks-page.spec.tsx` | 运行中小条 = 原生状态且**不含**「运行中」；无 summary 回退「运行中」；已结算小条不含「已完成」；根卡显示主会话真实状态；浮窗活动块位置/文案/无数据不渲染且不含「最近活动」「正在分析请求」；**一次点击只开一组、兄弟组仍折叠**，控制条全局收起把展开过的组重新折回（含那条判别性用例）；待命徽标真实计数、小条不再重复计数 |
| `tests/activity-icons.spec.ts`（新） | 13 个类别各渲染出元素；`read` / `commands` / `search` / `webSearch` 互不同型（钉住「不再恒画终端图标」）；`undefined` 走思考图标且不等于任何类别 |
| 既有期望跟随设计 | 待命聚合的 `'3 待命' / 'N 个待命'` → `'3 个待命'`（徽标插值） |

`tests/tasks-page.spec.tsx` 新增一个 `FakeChatLocale`（`active: 'zh'` + `bind('chat')` 供
`message.stepProcess.*`），`afterEach` 里 `attachLocale(undefined)`：**活动行的字来自宿主 `chat`
命名空间**，不挂这个假 locale 就只能断言到 fallback 的 detail，钉不住真正的契约。

## 未验证项（如实记录）

- **没有跑真机**：本 worktree 未装进任何 DSH profile，也没有起服务器。上面全部结论来自 jsdom 单测与构建产物；
  卡片小条的实际观感（原生状态与状态点/扫光的搭配、260px 窄栏下的省略行为）、浮窗那两行小字的真实换行
  都需要真机或截图复核。
- 因此也没有 `pnpm test:mount` 记录。
