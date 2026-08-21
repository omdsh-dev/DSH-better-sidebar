# 侧边对话（Side Chat）Tab 设计

**日期**：2026-08-20
**状态**：已批准，实施中
**作者**：opencode + 用户
**当前版本**：v0.14.1（分支 `feat/sidechat-tab`）
**目标版本**：v0.14.1（不 bump）

## 1. 目标

1. 对标 Codex 的 side 对话，为 better-sidebar 新增内置 Tab **sidechat**：在当前主会话下开一个**继承主会话完整上下文**的独立子会话线程，线程在 Tab 内可续聊、可查看完整时间线（user / assistant / reasoning / tool）。
2. **继承必须是结构化的**：线程种子 = 父会话点击时刻的全部事件——已完成回合 + 未回答的 user 消息 + **进行中回合的 assistant 流式输出与工具调用**（原样复制，合成 `step/end`+`turn/end{reason:'interrupted'}` 诚实闭合，子会话看到的是「被切断的进行中回合」而非完整定稿）。
3. **前缀缓存复用**：子会话与父会话同组合（同 preset / 同 provider/model、无 persona/toolFilter、非 continuable 无 report 增量）→ 子会话首个请求的 token 前缀与父会话当前请求一致（到未回答 user 消息为止），命中 provider 前缀缓存。
4. **即用即销语义 + 保存为新会话**：线程以 `origin:'subagent'` 创建（主会话列表不可见、子代理目录零噪音）；用户可一键「保存为新会话」——`session.fork` 提升为顶层会话（自动命名、挂工作区、打开）。
5. 零 dsh-subagent 依赖；dsh-subagent 缺失时功能不受影响。

## 2. 非目标（Out of Scope）

- 不做 `/btw` 一次性侧问（只做持续可续聊线程）。
- 不做合并回主会话 / 重命名线程。
- **不改 DSH 源码**：不加 promote RPC、不改 fork 边界、不改 continuation 机制。
- 工具执行中途（悬挂 tool/call）的事件级继承不可行（provider 拒绝悬挂 assistant 调用）→ 该窗口回退为「截断 + 结构化文本转储」（见 §4）。

## 3. 为什么自建机制（重实现）

用户明确拍板：不走 `ctx.subagents.startContinuable`。原因（已核实源码）：

1. **种子粒度受限**：fork provider 的 `completedTurnPrefix` 固定切在最后一个 `turn/end`（`subagent-fork-in-process/src/index.ts`），`session.fork` RPC 显式拒绝 open-turn 锚点（`core/session` `OPEN_TURN`）——进行中回合永远进不了种子。
2. **continuable 组合破坏前缀复用**：continuable 子会话的请求头部在继承历史之前插入 `report` 工具 + `tool:report` 提示段（`.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md`，issue #2124）——前缀从请求头即分叉，重发整个转录却零 cache 收益。DSH 官方因此把 fork 绑定为 one-shot。
3. **无法注入自定义种子**：`ContinuableStartSpec` 无 seed 字段，创建路径无注入点。

自建机制只复用 DSH 公开 host 能力：`ctx.agents.create/resume`（AgentRegistry 公开方法，api-proxy fork 与 subagent driver 同用）、`agent.followup/cancel`（公开方法）、`ctx.get('agentPresets')`、`ctx.get('sessionTitle')`、`ctx.get('sessionPersistence')`。客户端复用 `ctx.sessions.list / fork / binding / open` 与通用 `session.history` RPC。

## 4. 种子算法（`src/sidechat-core.ts`）

1. 复制父会话**全部事件**（点击时刻快照；live 日志 seq === 数组下标，保持连续）。
2. 日志结束于 turn 外（最后 turn 边界是 turn/end 或无 turn）：种子 = 全部复制事件（可能以未回答 user 消息结尾，合法）。
3. 结束于 open turn 内：
   - **当前 step 存在无配对 tool/call（悬挂）** → 回退：切到该 turn 的 `turn/start` 之前（保留已完成回合 + 未回答 user 消息）；进行中内容（含执行中的工具调用，标注 executing）走 `buildOpenTurnSnapshot` 结构化文本转储并入 boundary 消息。原因：validator 不拒悬挂调用（step/end 清空 pendingCalls），但 **provider 拒绝悬挂 assistant 调用**（`core/session/src/repair.ts:108`）。
   - 否则：追加合成 `step/end{turn,step}`（若 step 未闭合）+ `turn/end{turn, reason:{kind:'interrupted'}}`（编号取自已复制事件的 turn/start、step/start）→ 种子平衡合法（种子逐事件过同一不变式检查器，`core/session/src/index.ts:517-541`；`turn/end` schema 要求 reason，`interrupted` 是合法持久化变体，语义即「回合未完成被切断」——诚实标记，客户端对冻结局部渲染「已停止」）。

子会话首个请求（常见路径）= [已完成回合][未回答 user][冻结的进行中回合：chunk 文本 + 已完成工具调用/结果][boundary+question]。前缀复用不受影响：共享前缀到未回答 user 消息为止，冻结回合位于共享前缀之后。

## 5. 线程生命周期（host 路由，`/sidebar/api/sidechat.*`，既有信任 fence）

- **start** `{sessionId, question}`：父 Agent 必须 live；`buildSidechatInheritance` 出种子 + 转储；`ctx.agents.create({meta:{cwd,parentSession,seedLength,origin:'subagent',delegationDepth:父+1,agentPreset}, seed, agentOptions:父 provider/model, setup:preset 组合})`；`agent.followup(createUserMessage({content:[boundary+转储?+question], source:{kind:'user'}}))`；`sessionTitle.rename(session,'Side: '+截断(question,48))` 钉死线程标签；返回 `{childId}`。
- **prompt** `{childId, text}`：live → `followup`；absent（重启/关闭后）→ `ctx.agents.resume`（`resolvePresetId` 从 persisted header/events 解析 preset，`agentPresets.resolve/mount` 组合）→ `followup`。
- **cancel** `{childId}`：`agent.cancel({kind:'user'},{keepInbox:true})`。
- **dispose** `{childId}`：释放创建/恢复时保存的 AgentHandle disposer（会话与历史保留）。

为什么全走自有路由：`origin:'subagent'` 的会话被通用 RPC 的 agent-lookup 所有权 fence 全面封锁（`api/remotes/agent-lookup.ts` `hasApiRemoteSubagentOwner`），`subagents.prompt` 对我们的线程也无法寻址——自有路由直接调 registry/agent 绕开 fence，且只依赖公开方法。~~线程没有 subagent/descriptor（无目录注册、零噪音：`list-children.ts` 投影为 undefined 即丢弃）~~ **修正（v3 起）**：该判断只对 live 线程成立——cold 线程无 descriptor 时 `resolveColdIdentity` 确定性产出 `corrupt` 诊断行（`list-children.ts:405`），用户实测在 Subagent 页看到「目录损坏」。修复 = 线程种子尾部追加合法的 `subagent/descriptor`（`snapshotSubagentDescriptor`，version 2 / continuable / provider `'sidechat'` / label 即 `Side: ` 标题），线程成为目录里的健康行；SubagentView 与 `subagent-detect.ts` 按 `Side: ` 标签/标题前缀过滤，拓扑 UI 与自动打开触发保持零噪音（模型侧 `list_agents` 也会列出带标签的健康行，而非 corrupt 垃圾）。

## 6. 客户端 Tab（`src/client/SideChatView.tsx`）

- 内置 descriptor：`id:'sidechat'`、`order:35`、`single:true`、图标 `IconNewChatOutline16`。
- 两栏布局：左线程列表（`sideThreadRows`：`origin==='subagent' && parentId===当前 && displayTitle 前缀 'Side: '`；订阅 `ctx.sessions.list`）；右详情（时间线 + 输入框 + 保存/停止/关闭按钮）。
- 时间线：轮询 `connection.api.sessions.history`（通用 RPC，未 fence；`session/end-seed` 截断 + boundary 行丢弃 + chunk 流式累加 + 工具配对——`src/client/sidechat-transcript.ts` 纯映射）；可见且运行中 ~2s，seq 去重缓存；`visible=false` 停轮询。
- 保存为新会话：`ctx.sessions.fork({sessionId: threadId, increaseTitle:true})` → `binding(newId).session.rename(标题去前缀)` → `ctx.sessions.open(newId)`。无已完成回合 → 禁用 + 提示；末条追问未完成 → 提示不包含（fork 边界=最后 turn/end）。
- 选中线程持久化：`tab.meta.threadId`（既有 per-session localStorage 通道）。

## 7. 边界情况与失败模式

| 场景 | 行为 |
|---|---|
| 父会话无 live agent | 409 `sidechat-error` 内联提示 |
| 父会话进行中（流式/思考/工具已返回） | 完整事件入种子 + interrupted 合成闭合 |
| 父会话工具执行中途点击新建 | 悬挂 tool/call → 截断 + 结构化转储（工具标注 executing） |
| seam 缺失（agentPresets/sessionTitle/sessionPersistence） | 降级：默认组合 / 自动标题 / 无 preset 组合的冷恢复 |
| DSH 重启后续聊 / 线程关闭后追问 | `ctx.agents.resume`（persisted preset 组合） |
| 线程无已完成回合 | 保存禁用 + 提示 |
| 线程末条追问未完成 | 保存前提示不包含 |
| 与 dsh-sidechain 并存 | 各自独立；双方线程都有 descriptor（目录健康行），SubagentView 按 `Side: ` 前缀过滤均不可见；双方共享 `Side: ` 标签约定，线程互见 |

## 8. 测试与自验

- 单测：`sidechat-core.spec.ts`（种子全分支：turn 外 / 空 / 仅 pending user / open turn 无工具 / 成对工具 / 悬挂回退 / 多 step 闭合 / seq 连续性；转储保真；线程过滤；保存资格；preset 解析；boundaryDelivered）、`sidechat-seed-validation.spec.ts`（真实 `Session.create` 校验器接受种子产物）、`sidechat-transcript.spec.ts`（种子截断、boundary 丢弃、chunk 流式、工具配对、孤儿失败工具）、`sidechat-routes.spec.ts`（start 带问/空问立即创建、首条 prompt 包裹边界+快照并改名、prompt live+cold、cancel、dispose、info live/cold/未知）、`builtins.spec.ts` 7 tab + sidechat 每线程一 Tab 铸造/去重。
- e2e 挂载冒烟：+ 菜单深扫含 Side Chat；**host 路由级自验**（真实 keyless dsh web 中 sidechat.start/prompt/cancel/dispose/info 全链路 + 空问题立即创建流程，种子会话为父）。
- 真实环境手测（实施后勾选）：新建线程 → 追问往返 → 流式渲染 → 工具行 → 主会话流式中新建（冻结继承）→ 工具执行中途新建（回退转储）→ 重启后续聊 → 保存为新会话 → 刷新持久。

## 9. 复用门记录

搜索面：DSH checkout `docs/` + `packages/`（关键词 side conversation / sidetrack / thread / promote）+ dsh-external hub catalog（`search-org.mjs`，323 repos）。命中：`dsh-external/dsh-sidechain`（Codex 风格侧会话，/side & /btw，临时 fork + 侧栏面板），但**无 better-sidebar Tab、无保存为新会话**；用户拍板独立实现（「我们做独立实现」），sidechain 保持不动。本文档与 PR 记录该结论。

## 10. 实施偏差记录

- 路由键命名：`buildSidechatApi` 返回对象的键必须是**完整 wire 方法名**（`'sidechat.start'` 等，/sidebar/api 分发器按 `api[method]` 查找），而非短名 `start/prompt/…`。首次实现用了短名，单测直接调对象方法未暴露，真实挂载冒烟以 404 抓出（该冒烟因此新增了路由级自验，见 §8）。
- 种子函数入参类型：sidechat-core 使用宽松结构类型 `SidechatLogEvent {type, seq, time, data: unknown}`（同时接受 host 真实 `SessionEvent` 与 client 的 `SidebarSessionEvent` 镜像），避免两半的类型图互相污染。
- keyless 挂载冒烟无法验证 boundary 消息落盘：`agent.followup` 的消息先入 inbox，被 turn claim 后才写入 session 日志——keyless（无模型路由）下 turn 不会 claim。挂载冒烟的深度断言因此改为 **session.list 成员校验**（证明子会话真实创建，provider 无关）；boundary 落盘与流式/回答在真实 provider 环境手测（§8 清单）。
- **UI 两轮返工（用户实测驱动）**：
  1. 种子事件信封字段丢失（用户实测报 `invalid seed event … requires a surfaceOp marker`）：`copyEvents` 重建事件时只保留 `{type,seq,time,data}`，剥掉了 `surfaceOp`/`sourceEventSeqs`/`ignorable`，而种子校验器要求 surface-eligible 事件必带 `surfaceOp`。修复 = 信封字段原样透传 + 新增 `sidechat-seed-validation.spec.ts`（用真实 `@deepseek-ai/dsh-session` 的 `Session.create` 校验器跑种子产物，回归守护）。
  2. 交互模型从「单 Tab + 内嵌线程列表 + 首问表单」改为 **Codex app 对齐的「每线程一 Tab」**：`createTab` 铸造 `sidechat:new-<uuid>`（meta `autoCreate`，视图挂载即调 `sidechat.start` 空问题立即建线程）或消费 `parkSidechatReopen` 停泊的 `sidechat:<threadId>` 重连 Tab；`dedupeKey = meta.threadId` 保证同线程聚焦不重复；`onClose` 释放 live agent（历史保留，头部菜单可重开）。配套后端变化：`sidechat.start` 的 `question` 变为可选（空 = 仅建线程，快照停泊在 `pendingSnapshots`）；`sidechat.prompt` 检测边界未送达时（`boundaryDelivered` 扫日志）自动包裹边界 + 停泊快照并用首条消息改名；新增 `sidechat.info` 路由（live 状态 + provider/model/preset 身份，供头部 Agent 徽标）。UI 对齐主对话区：用户右对齐气泡（`--dsw-specific-bubble`）、assistant 通栏 markdown、胶囊 composer（`--dsw-specific-input-major` + 圆形 accent 发送/停止钮 + 自动增高 textarea）、运行扫光状态行与工具行（`StateDot` + shimmer），动效全部 ≤200ms 交叉淡化并受 `prefers-reduced-motion` 收敛。
- （预留）实施过程中如有与本文档的其他偏差，在此记录。
- **第三轮实测修复（4 bug）**：
  1. 「保存为新会话」报 `Cannot read properties of undefined (reading 'list')`：`handleSave` 把 `ctx.sessions.fork` 解构成自由函数再调用，丢失 `this`——client-runtime 的 `service.fork` 内部读 `this.list.getSnapshot()`（标题递增）。修复 = 保持方法调用形态（`ctx.sessions.fork({...})`）。
  2. 图标语义：线程切换菜单改自绘 `IconHistoryOutline16`（逆时针时钟）、保存按钮改自绘 `IconSaveOutline16`（软盘），沿用 1.5px 描边规范（primitives 无现成 history/save 图标）。
  3. 重开线程 Tab 丢工具行：根因**不在宿主**（`session.history` cold 路径原样返回 `tool/call`，见 `api-proxy.ts:749` 与 `chunk-rows.ts` 的无损 chunk 压缩）而在首挂回源窗口——旧实现 8 事件/页 × 32 页 = 256 事件上限，而 cold 读会把 chunk-rows 展开回每个流式 delta 一条事件，一轮回答动辄数百事件，较早的 `tool/call` 掉出窗口（settled 文本靠最终 `assistant/message` 幸存）。修复 = 抽出 `collectOwnEvents`（200 事件/页 × 40 页帽、日志穷尽/无标记时落定 `seedBoundary:0` 停止每轮重走），单测覆盖四分支。
  4. Subagent 页「目录损坏」行：见 §5 修正——种子追加 descriptor + SubagentView/subagent-detect 按前缀过滤（`isSideThreadSummary` 同时修好 autoOpenSubagent 误触发与计数膨胀）。旧版创建的线程仍是 corrupt 诊断行，由 SubagentView 的标题前缀过滤兜底隐藏。
