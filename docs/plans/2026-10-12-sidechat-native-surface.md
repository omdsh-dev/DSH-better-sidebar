# Side Chat 原生能力补齐：精确幽灵清扫 + 实时推送 + per-thread 模型选择 + 队列可见

日期：2026-10-12　分支：`fix/sidechat-native-surface`（本 worktree 内实施；见 §7 交付说明）

## 1. 背景与真机证据

用户报告四个痛点：① 侧边对话把父会话排队信息弄进来 / 发出去像没反应 / 旧消息先被回答；② 「实时 fork 主对话」；③ 模型选不了；④ 消息不及时、缺 spinner。

本轮在**用户正在运行的宿主**上做了端到端复现（`http://127.0.0.1:3384`，profile `web`，插件 v0.25.0，DSH 0.2.0-rc.2）：用「正在 `sleep 150` 的子代理」当父会话，mid-turn 时先塞一条未领取的排队消息，再建侧边对话，然后读真实 session 日志（`~/.dsh/sessions/...`）。

```
child seed  = 父事件 0..3 + sidechat descriptor + session/end-seed(seq5)
  种子折叠后：next-turn = 1 条幽灵（父会话自己本轮开头领取过的那条输入）
  own seq6  = agent/inbox/spliced next-turn rm=1 outcome=canceled   ← inbox.clear() 围栏
  own seq7/8= 注入 boundary / 追加问题 → claim → request 只有 [boundary, 问题] → 回答 OK
```

结论有三条，都写进了实现：

1. **围栏有效，但只有 create 路径有**。`sidechat.start` 的 `handle.agent.inbox.clear()` 确实清掉了幽灵；**冷恢复路径（`sidechat.prompt` → `agents.resume`）没有围栏**，这是 2026-09-13 计划里"用户确认接受"的残留 → 修复 = 把围栏换成**精确清扫**并覆盖 resume。
2. **幽灵的真正来源比文档写的更宽**：父会话 mid-turn 且工具有未返回调用时，`buildSidechatInheritance` 把种子截断在 `turn/start` 之前，而 inbox 的"领取" splice 发生在 `turn/start` **之后** → 父会话本轮开头领取过的输入在种子折叠里仍是 pending。这与"模型先去干主对话旧任务"的形状一致。
3. **宿主没有任何 live fork 原语**（三条 fork 路径都是冻结前缀副本，`inheritedEventCount` 是 readonly）。「实时」唯一可实现的两件事：fork 时刻前移（本轮未采纳，用户选择保持 Codex 式"点开即建空线程"）与**显示实时**（本轮采纳：WS 推送）。

同时确认：宿主对 `origin:'subagent'` 会话**显式禁用**原生模型选择器（`assertAvailable`："model selection is unavailable for addressed subagent sessions"），`sessionController.selectModel` 也被 subagent fence 挡住；归档虽能隐藏但 `ArchivedSessionGate` 会 reject 该会话的 `agent/pre-step`。**隐藏与"完整普通会话"在宿主层面互斥**，所以本轮保持隐藏会话，把插件自己的表面补到接近原生。

## 2. 围栏改造（host）

- `src/sidechat-core.ts` 新增纯函数：
  - `foldPendingInput(events)`：按 `agent/inbox/spliced` 语义折叠出当前 pending 的消息（claim 顺序：next-step 全部在前，next-turn 在后）。
  - `inheritedPendingIds(events, inheritedEventCount)`：只折叠**继承前缀**，返回仍然 pending 的 message id 集合——即"幽灵 id"。
- `src/sidechat-routes.ts` 新增 `dropInheritedGhosts(agent)`：对每个幽灵 id 调 `agent.inbox.remove(id)`（宿主公开 `Inbox.remove`），返回移除数。
  - **create**：先精确清扫；若清扫后仍有 pending（理论上不该有），再退回 `agent.inbox.clear()`。create 时本线程自己还没有任何输入，退路是零成本的硬保证。
  - **resume**：只做精确清扫——**绝不**用 `clear()`，否则会误杀"用户在线程里排队、宿主重启后尚未领取"的合法输入（这是 2026-09-13 计划里否决 resume-clear 的理由，精确清扫同时满足两边）。
- `sidechat.events` 响应新增 `pending`，就是线程 live inbox 的当前内容（`id`/`target`/`text`/`time`），供 UI 渲染"排队中"与撤销。read 顺序：**先取 pending 快照，再取日志**，把 claim 竞态挤压成"只出现在日志里"（不会重复渲染）。

## 3. 实时推送（host + client）

新增 `/sidebar/ws/sidechat` 升级通道（沿用 `/sidebar/ws/fs-watch` 的 fence/生命周期写法）：

```
client → host : { op: 'watch', threadIds: string[] }     // 整份替换该 socket 的订阅集
host → client : { threadId: string, running?: boolean }  // 失效通知：请带 afterSeq 重拉 sidechat.events
```

host 侧三个来源（都按 threadId 过滤，逐线程合并/去抖）：

| 来源 | 触发 | 去抖 |
|---|---|---|
| `ctx.on('session/event')` | 线程日志追加（claim、assistant/message、tool/result、turn/end…） | 60ms |
| `ctx.on('agent/assistant-stream')` | 流式增量（进程内帧，不入日志） | 120ms |
| `ctx.on('agent/status')` | running/idle 翻转 | 立即 |

帧只带失效信号，不复制事件体：客户端继续走既有 `sidechat.events`（afterSeq 增量 + 尾部帽），协议面最小、断线后可自愈。客户端 `use-sidechat-push.ts` 复用 `hostWebSocketUrl` + 退避重连；**轮询降级为兜底**（可见且 running 时 15s，另在绑定/可见性/连接恢复时各拉一次）。

## 4. per-thread 模型选择（host + client）

宿主对 subagent 会话禁用自带选择器，插件自建：

- `sidechat.models` `{}` → 宿主模型目录直通：`ctx.get('sessionController')?.modelCatalog()`（`{default, routableProviders, groups:[{id,name,models:[{id,name,description?,reasoning?:{efforts,defaultEffort?}}]}], failures?}`）。服务缺失（headless/旧宿主）→ `{available:false, groups:[]}`，UI 只显示"继承主对话"。
- `sidechat.model` `{childId, provider, model, reasoningEffort?}` → 先按 `ctx.get('llm')?.resolveCallConfig(...)` 归一化（宿主同一套校验；缺失则原样接受），再对 live agent（冷则 resume）：
  - `agent.session.append('model/selection', selection)` —— 与宿主 `SessionController.selectForNextRequest` 同一落盘形状；
  - `installModelSelection(agent.ctx, selection对象)` —— `@deepseek-ai/dsh-agent` 公开导出，让**下一个**请求立刻走新模型（否则宿主缓存的选择对象不会回读投影）。
- `sidechat.info` 的 `provider/model/reasoningEffort` 改为读**线程日志的有效选择**（`parentModelSelection`：pending ?? lastUsed），不再读冻结的 `agent.options`（后者是创建期部署默认值，正是 #368 的坑）。

## 5. 队列可见 / 撤销、本地回显、spinner、错误行（client）

- **顶栏取消，所有线程功能下放到底栏**（用户反馈：「注意力全在底栏，根本看不到上栏还有保存为新会话」）：原来的 `.sidechatDetailHeader`（运行点 · agent 徽标 · 模型胶囊 · 线程菜单 · 保存 · 归档）整条删除，线程动作与模型选择器移入**输入框底栏**，并**与主会话底栏对齐**：`[＋ 新建][线程菜单][保存][归档] ……… [模型选择器][发送/停止]`（图标靠左、选择器靠右**完整显示**，不再截到 40%；agent 徽标 `preset · model` 不再显示，preset 只留在选择器气泡里）。**新建按钮（2026-10-12 追加）**：最左侧独立的 `＋`，走与线程菜单 `$new` 行同一条 `openNewThread()` 路径。**每个控件的悬停气泡**改用宿主 `Tooltip`（`side="top"` + `portal` + `delayMs=120` + `maxWidth=220`），替代原生 `title`：气泡锚在**一层 ENABLED 的 `span` 包装**上，因为禁用按钮不派发 pointer 事件——而"为什么保存/归档不可点"恰恰是禁用态才需要解释的（保存=「至少完成一轮对话后才能保存」，归档=「该线程正在运行，停止后才能归档」）；`aria-label` 全部补齐，`title` 全部移除。保存/归档的提示行与错误横幅一并移到**输入框正上方**，与它们解释的按钮同一视线带。`tests/sidechat-view.spec.tsx` 用「控件必须位于输入框所在容器内 + 顺序（新建→线程→保存→归档→模型→发送）+ 每个控件有 span 锚且无 `title` + 新建按钮真的发出 `sidechat.start`」钉住这条要求（不依赖 CSS 类名）。
- **模型菜单不嵌套**（用户反馈：「推理强度等弹窗你得往左来，不然会挡住」）：宿主 `ui-primitives` 的 `Menu` 把 `submenu` 渲染成**开在父项右侧**的嵌套卡片（`side` 只作用于顶层列表，没有翻转开关），而本选择器钉在侧栏右缘 → 嵌套卡片直接跑出窗口；更糟的是宿主在**任何条目带 submenu 时把整个面板设为不可滚动**（`scrollable = !items.some(entry => entry.submenu …)`），长目录连滚都滚不了。因此推理强度改成**同一列的平铺行**（`type:'label'` 分组 + 每行 check），配合 `align="end"` 顶层列表向右展开——单列结构天然不会被裁，且面板恢复可滚动。选中态用 `selectedIds` 同时标记当前路由与当前 effort（两组独立勾选）。`tests/sidechat-view.spec.tsx` 断言「模型菜单里不得出现 `[aria-haspopup="menu"]`」，把「不许再退回嵌套」钉住。**同类隐患**：`src/client/TeamBoard.tsx` 的 owner 子菜单也是 `align="end"` + submenu，同一窗口会被裁（本轮未改，见 §7 待办）。
- `sidechat.dequeue` `{childId, messageId?}`：带 id 撤一条（`inbox.remove`），不带 id 清空（`inbox.clear`）；冷线程无 live agent → `removed: 0`。
- 转录尾部渲染 pending 气泡（带 spinner + ✕），与 `sidechat.events.pending` 同步；已 claim 的 id 与持久 `user/message` 去重。- 发送即本地回显（`sending` → 与 pending/持久行按文本+id 收敛后移除），消除"发了没反应"。
- thinking 行：`running` 期间保留（长工具调用期间仍有进行中指示），本地回显尚未落成任何 assistant/reasoning 行时也立即显示。
- `turn/end{reason:{kind:'error'}}` / `assistant/attempt` 失败渲染为可见错误行（不再静默）。

## 6. 测试与门禁

- host：`tests/sidechat-core.spec.ts`（折叠/幽灵 id）、`tests/sidechat-routes.spec.ts`（create 清扫 + 退路 clear、resume 只清扫、events.pending、dequeue、model/models/info）、新增 `tests/sidechat-push.spec.ts`（订阅集、三类来源、去抖、fence 拒绝）。
- client：`tests/sidechat-view.spec.tsx`（pending 行 + 撤销 + 本地回显 + 模型菜单）、`tests/sidechat-transcript.spec.ts`（错误行）、新增 `tests/use-sidechat-push.spec.ts`。
- 全量：`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build`。`tests/smoke.spec.ts` 的 upgrade 路由清单同步（`/sidebar/ws/sidechat`）。

## 7. 实施记录与偏差

- **围栏取舍（最终形态）**：create 保留 `inbox.clear()`（本线程自己不可能有排队输入，一次清干净、最省心），resume 用 `dropInheritedGhosts` 精确清扫——两条路径不对称是刻意的，注释与 AGENTS §3.4 第 10 条都写明了理由。`inheritedPendingIds` 依赖 `agent.session.inheritedEventCount`，因此 create 路径没有改成"先扫后兜底"（那会多一层永真的分支）。
- **新增 `boundaryPending`**：`boundaryDelivered` 只看持久 `user/message`，首问未 claim 时连发第二条会注入第二对 boundary+question。现在 `boundaryDelivered(log) || boundaryPending(inbox)` 才算已送达（真机日志里首问的 `agent/inbox/spliced` 在 claim 前就存在，这正是那个窗口）。
- **`sidechat.events.pending` 的实现**读 `agent.inbox.nextStep/nextTurn`（宿主 `Inbox` 公开 getter），不折日志：读失败（无 inbox 投影的宿主）退化为空数组而不是让转录轮询失败。客户端按"持久 `user/message` 的 `data.id`"去重，避免 claim 竞态下同一消息渲染两次；**真机日志验证**：`user/message` 的 `id` 与 splice `inserted[].id` 同值（探针线程 `session-0509f3c2` 实测）。
- **`sidechat.model` 的安装时机**：`ensureModelSelection` 在 create 与 resume 后各调一次（同一 thread 只装一次，ref 存在模块级 Map，dispose 清理）；`sidechat.models` 直通宿主目录、缺服务即 `available:false`；`sidechat.model` 先用 `ctx.get('llm').resolveCallConfig` 归一化（宿主同一套校验），失败是 400 `bad-request` 且**不产生副作用**（校验在 resume 之前）。
- **推送去抖**：durable 60ms / stream 250ms，同一线程"先到者的窗口胜出"（突发不会推迟已排定的通知）；客户端 80ms 合并后再拉。帧里不带事件体。
- **客户端行为变化（已复核保留）**：thinking 行在 `running`（或本地回显尚无输出）时显示——running 期间始终保留，避免长工具调用期间"没有任何进行中指示"；本地回显在宿主把它记入 inbox 或落成更新的持久行之前一直显示。
- **交付**：worktree 的 `.git` 指向父仓库，沙箱拒绝在 workspace 外写 git 目录 → 本会话**无法建分支/提交**，改动全部落在工作区并另附 `git diff` 补丁。
- **未验证项（如实记录）**：① 挂载冒烟 lane（`tests/e2e/mount.e2e.ts` 已补 `/sidebar/ws/sidechat`、`pending`/`dequeue`/`models`/`model` 断言，但本机沙箱跑不了该 lane：它需要装 pin 版宿主 + Playwright）；② 真机侧边对话交互（需要把新包装进 profile，属 workspace 外写入）；③ 推送通道在桌面壳 `dsh-app://` 源下的表现（沿用既有 `hostWebSocketUrl`，与 fs-watch 同一条路径，后者有 issue #834/#902 的修复背书）。

## 8. 交付说明（worktree 限制）

本 worktree 的 `.git` 指向父仓库 `/Users/menghuan/Code/DSH-better-sidebar/.git`，沙箱拒绝在 workspace 之外的 git 目录写入，因此**本次无法在会话内建分支/提交**（`git checkout -b` 报 `Operation not permitted`）。改动全部落在 worktree 工作区，随附 `git diff` + 新增文件的补丁，由维护者按 §0 的分支模型落地（`fix/sidechat-native-surface` → `dev`）。
