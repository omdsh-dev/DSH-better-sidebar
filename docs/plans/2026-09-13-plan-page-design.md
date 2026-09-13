# 侧边栏「计划」页（plan tab）

日期：2026-09-13　分支：`feat/plan-tab`

## 背景

计划模式下模型提交的计划全文只出现在聊天流的工具卡片里。计划通常很长，通读要在聊天区里滚；`Keep planning` 改过几版之后，旧版本更难翻回来。宿主自己的 `dsh-client-ui-plan` 只是输入框旁的**模式控件**，不展示计划正文。

这一页把「本会话提交过的每一版计划」变成侧边栏里的一个常驻页面：提交的瞬间自动切过去，逐版留档、可下拉回看，每版带评审状态。**零磁盘写入** —— 计划只存在于会话事件日志与页面上。

## 上游契约（实读 `dsh-plan-mode` / `dsh-agent-loop` 源码，非推断）

| 事实 | 结论 |
|---|---|
| 工具与参数 | `exit_plan_mode`，`parameters: { plan: { type: 'string', required: true } }`；`execute` 内校验 `/^#\s+\S/`（必须以 `# ` 开头） |
| 批准路径 | 用户点 Approve → 返回 `{ approved: true }` → `tool/result` 成功 |
| 未采纳路径 | 用户点 Keep planning **或**关掉评审弹窗 → 工具 `throw` → `tool/result` 的 `isError === true` |
| 日志时机 | `tool/call` 在 **dispatch 之前**追加 —— 事件到达时用户**还没看到**评审卡 |
| 是否截断 | **不截断**。`appendToolCall` 把 `block.arguments` 原样写入（类型注释：`the raw 'arguments' JSON string exactly as the model produced it`）；压缩器只重写 `tool/result` |
| 其他文本源 | **没有**。`plan/mode` 事件与 `plan` 投影只有布尔值；`userQuestions` 的 `plan-review.detail` 虽带全文，但那是纯内存的服务接缝，**不落会话日志** |

因此 `tool/call` 的 `arguments.plan` 是唯一可用的计划文本源。

**一个反直觉的边界**：宿主在 `execute` 里校验 `/^#\s+\S/` 并抛错，但**抛错前 `tool/call` 已经落日志**。日志里因此存在「用户从未看见过评审卡」的坏计划 —— 提取端必须镜像宿主自己的判据，否则页面上会出现幻影计划。

## 决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | **宿主事件驱动**，不用会话列表派生 | `exit_plan_mode` 在 turn 内 `await` 用户回答，期间会话一直是 running —— 「回合结束」不是提交信号，本页是全插件唯一一个无法由列表签名驱动的自动打开 |
| 2 | **独立 WS 端点** `/sidebar/ws/plans`，不复用 `/sidebar/ws/agent-opens` | ① 后者的 `AgentOpenKind` 是封闭三值，表达不了「打开计划页」；② 它的客户端 socket 上有 `agentOpenTools` 闸门，塞进去会被连带掐死；③ 它的 consume-on-send + attach replay 语义对通知型推送是错的 |
| 3 | **无队列、无重放** | 通知丢了的代价趋近于零（计划永在日志里，一点即开）；而 replay 会造成**错误行为** —— 刷新页面时把右列突然弹到计划页 |
| 4 | 只挂 **`tool/call`** 推送 | 提交瞬间即到达（比评审卡更早，正是该摊开全文的时刻）；状态翻转（待评审 → 已批准/未采纳）由页面自身轮询兜底，feed 因此**无需记住**任何 callId |
| 5 | 宿主**按工具名预筛**，折叠放客户端 | 复用 `changes.ops` 不行：那条路由只回最近 4000 条 tool 事件，长会话会把最早的几版计划挤出窗口，而「逐版留档」不允许丢。预筛后套 `afterSeq`，增量只传新行 |
| 6 | 状态判定用 `isError`，枚举 **`unadopted`** 而非 `rejected` | 契约上 `isError ⇔ 未批准` 是精确的；但 Keep planning 是**用户自己选择先不改**，叫 rejected 会诱导后来者把文案写成「驳回」 |
| 7 | 排序**时间正序**（最旧在前） | 有意偏离 `extractFileOps` 的 newest-first：那是活动流，这是文档版本史，v1..vN 天然按时间编号，选择器下标与版本号 1:1，默认选中即 `plans.at(-1)` |
| 8 | `order: 25`，图标 `VscNote` | 与「文件变动」(20) 同属「本会话产出/打算产出什么」，排在活动流区块（任务 30 起）之前；**刻意避开 `VscChecklist`** —— `builtins.spec` 已用注释否决过「待办清单」语义，再引入同族 glyph 会让那条注释自相矛盾 |
| 9 | 正文媒体基准 = **`${cwd}/plan.md`**（合成路径） | `resolveLocalMediaDest` 取路径的**目录**部分，传 cwd 本身会让计划里的 `./src/x.ts` 解析到工作区的上一级；传空串更糟（解析到文件系统根 `/`） |
| 10 | **不做「发回聊天框」** | 它要的小气泡来自 `feat/selection-chip`（选区引用胶囊），那条分支尚未合入；本期先做不依赖它的主体 |
| 11 | 页面走**惰性 chunk**（`lib/client-plan.js`） | 它的 markdown 栈（DOMPurify + HTML 分析）只服务这一页。静态导入会把它们拉进启动包，让每个用户为从不打开的页面买单（实测：核心包 DOMPurify 出现次数 41 → 0，只剩注释里的两处提及） |
| 12 | 推送同时**镜像**它观察到的计划行 | store 会话的内存日志会在 rehydrate 边界冻结（`jobs-routes` 记录过同一风险），只读快照会让重启后的新计划永远不出现 |
| 13 | 推送与路由都套用**宿主的接受判据**（`/^#\s+\S/`） | 校验发生在 `execute` 内、call 已落日志之后 —— 只匹配工具名会把用户从未见过评审卡的提交推到页面上 |
| 14 | 跨 bundle 的刷新信号走 **window 事件**（`dsh-sidebar:plan-changed`，同文件树刷新中继） | 页面在 chunk、推送在核心包，模块级订阅会各持一份状态，信号传不过去 |
| 15 | 窗口上限**按对截断**（首行孤立 result 丢弃） | 折叠按 callId 配对，被劈开的 result 会连同整版计划一起消失，与「逐版留档」直接冲突 |

## 改动清单（子系统级）

| 子系统 | 文件 | 变更 |
|---|---|---|
| 宿主：路由与推送 | `src/plans-routes.ts`（新） | `buildPlansApi(ctx, limit)` 的 `events`（live → 冷读 → 空窗口）；`createPlanPushes(ctx)` 的 per-session 订阅者集合（无队列无重放、`ctx.on` 缺失时降级）；`PlanEventLike` 让匹配器同时吃宿主事件与插件镜像类型 |
| 宿主：接线 | `src/index.ts` | 路由表加 `plans.events`；`/sidebar/ws/plans` 的 `registerUpgrade` + `attachPlanPushes`（照 agent-opens 的 attach 模板）；teardown 加 `planPushes.dispose()` 与 `planWss.close()` |
| 客户端：折叠 | `src/client/plans/ops.ts`（新） | `extractPlans(events)` 纯函数：按 callId 配对、跳过全部畸形行（含 `/^#\s+\S/` 不过的幻影计划）、时间正序 |
| 客户端：页面 | `src/client/plans/PlanView.tsx` + `plan.module.css`（新） | `usePolling(visible, …, 5s, self-scheduling, immediate)` 累积 fold（空增量直接短路）；`<select>` 版本选择器 + 状态/性别标签 + 复制全文；`MarkdownDocument` 渲染，`media` memo 在原语上 |
| 客户端：chunk | `src/client/chunks/plan.tsx`（新）、`chunk-loader.ts`、`bundle-route.ts`、`tsdown.config.ts`、`package.json` | 页面走惰性 chunk（`lib/client-plan.js`）；跨 bundle 的刷新信号走 window 事件，因此没有 `plan-refresh.ts` 这样的模块级中继 |
| 客户端：自动打开 | `src/client/sidebar/use-host-feeds.ts` | `activateTasksPage` 泛化为 `activatePage(ctx, sessionId, type, options)`（三个既有调用点改传 `'subagent'`，行为逐字保持；标题改由 `service.openTab` 从 descriptor 兜底）；新增第三个 WS 订阅 effect，三道闸门后 `activatePage(…, 'plan', { background: true })` + `notifyPlanChanged()` |
| 客户端：数据面 | `src/client/api.ts` | `plansEvents(scope, afterSeq?, signal?)` |
| tab 描述符 | `src/client/builtins/tabs.tsx`、`tab-icons.tsx`、`tab-icons.module.css` | `id: 'plan'` / order 25 / `single: true` / `autoOpenPlan` 开关；`planTabIcon` = `VscNote` + `.plan` 令牌色 |
| 设置项 | `src/config.ts`、`src/prefs-shared.ts`、`src/client/prefs.ts` | `autoOpenPlan` 四处同步（默认 `true`） |
| i18n | `src/client/locales.ts` + 19 份 `locales-*.ts` | 11 个新词条 × 21 份（ja 与三份中文变体均为真翻译） |
| 文档 | README / README_EN / AGENTS / guide §4.4 | tab 计数口径 + 新表格行 |

## 已知边界

- **计划没有自己的文件**：正文里的相对图片以**会话工作区根**为基准解析（合成 `plan.md`）。这是唯一有意义的基准，计划里若引用了工作区外的相对资源仍会解析失败。会话 cwd 尚未水合时基准退化为空串，相对图片会按文件系统根解析而裂开，待 cwd 就位自愈——客户端拿不到更好的基准，这一档无法在页面侧修。
- **WS 断开 3 次后停重连**（沿用另两条推送的语义）；**成功连接会清零这个预算**，所以它拦的是「端点持续被拒」，不是会话内的累计次数。计划页是这条 feed 唯一的触发源（另两条还有列表派生的兜底），所以预算一旦耗尽，本会话的自动切页就失效——页面内容仍由 5s 轮询保活。
- **非在屏会话不推送、不抢屏**：客户端只为当前会话开 socket。切回旧会话**不重弹**页面（无重放是刻意的），计划一直在页里。
- **两次「幻影计划」防护**：宿主拒绝了格式（正文不以 `# ` 开头）、或**派发前被打断**（stop 键落在工具调用与执行之间，harness 把模型的原始 arguments 写进 call 行再补一条带 `TOOL_ABORTED_BEFORE_DISPATCH` 的中断结果）的提交都不出现在页面上。后者的判据是那个错误码——正文本身与真实提交无法区分。
- **状态刷新有最多 5s 延迟**：评审结果（批准/未采纳）不推送，由轮询收敛。
- **冷会话的扫描成本**：会话不在 live store 时（刷新后恢复的布局、已关闭的会话），每次轮询都会整份重读并解析持久化日志。只有「用户正看着一个非 live 会话的计划页」时才会发生，代价与 `changes.ops` 的同类读取相当。

## 验证

- `pnpm typecheck` / `pnpm lint` / `pnpm test`（本机 3 例 `fs-operations` 符号链接 `EPERM` 为 Windows 环境差异，与本改动无关）。
- 新增 `tests/plans-ops.spec.ts`（纯 fold，含幻影计划与折叠幂等）、`tests/plans-routes.spec.ts`（假 ctx + 事件工厂，含判据、镜像合并、成对截断、seq-0 游标）、`tests/plan-view.spec.tsx`（mock `plans.events` 的页面行为）。
- `tests/sidebar-auto-activation.spec.tsx` 扩展：推送到达 + 开关 + 类型闸门 + 窄屏停放 + 跨会话忽略 + 重连预算的耗尽与清零。
- 同步的守护：`builtins.spec`（8 tab / glyph / settings keys）、`smoke.spec`（upgrade 清单 + `settings.get` 期望）、`prefs.spec`（三处 prefs 字面量）、`bundle-route.spec` 与 `manifest-consistency.spec`（chunk 白名单与打包产物）、e2e 的 `NATIVE_TABS` 与 `shrunken`。
- 真机挂载冒烟：`pnpm build && pnpm pack && pnpm test:mount`（scratch profile + 真实 `dsh web`）。`plan` 进入 guide 巡检清单、无 pageerror，且 mount lane 断言 `/sidebar/bundle/plan.js` 以 200 返回 —— chunk 缺失只会渲染错误占位，不是崩溃，`assertNoCrash` 单独看不出来。

## 未覆盖（诚实记录）

- **「提交瞬间切页」未在真机验证过**：本插件此前所有自动打开都由会话列表派生，本页是第一次把「收到宿主事件」直接用于 UI 触发。单测证明链路成立（`ctx.on('session/event')` 由 `jobs-routes` 的 mirror 长期使用），但真机时序（事件到达 → WS 推送 → 客户端切页）需要一次实际提交来确认。
- 冷会话路径（刷新后手动打开页面）走的是 `plans.events` 的持久化回退，与 `changes.ops` 同构，但这条新路由本身未在真机上走过。

## 二期：发回聊天框（依赖 `feat/selection-chip`）

沿用选区引用胶囊，但**不修改 `insertSelectionReference`**（那条分支的决策与测试建立在「草稿串与改动前逐字相同」上），而是新增通用导出 `insertReferenceChip(ctx, sessionId, { label, clipboardText, ref, appearance })`，让既有入口退化成三行包装。

计划页的三个取值：`label` = `clipboardText` = 「计划 · <标题>」（短串）、`ref` = 计划全文、`appearance: 'session'`。`clipboardText` 取短形态不是改语义 —— 宿主的 `ReferenceChipNode.getTextContent()` 返回的就是它，字段注释写着「Clipboard / persistence projection, e.g. /name (never the model form)」，模型侧走的是 `serializeReference(ref)`，与 `clipboardText` 无关。**降级方向必须是「更短」**：chip 被拒时回退一行短引导语，绝不能回退成全文。

## 不做

执行进度追踪、计划落盘/导出、已批准计划回填聊天、把计划页 hook 进 `ctx.betterSidebar` 公共 API（新页走内置注册路径，第三方插件零感知）。
