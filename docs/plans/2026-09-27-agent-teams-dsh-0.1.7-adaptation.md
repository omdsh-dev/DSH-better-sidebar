# Agent Teams 适配 DSH 0.1.7：数据源改 projection、写路由对接真实服务、任务窗复用 FloatingWindow

日期：2026-09-27　分支：`feat/tasks-graph-polish`（承接 PR #680 的打磨线）

## 背景（用户原话）

> 目前是不是没有适配智能体团队功能？包括其任务等功能。注意之前我们另一个分支是有适配的，注意复用我们之前的那个弹窗组件
> 保持 KISS 原则，如有任意不清楚的地方，都向我详细确认

用户确认的三个决策：

| # | 问题 | 结论 |
|---|---|---|
| 1 | 团队数据源 | 改读宿主 **Session projection `agentTeam`**，读路径只剩 1 条路由（写） |
| 2 | 任务弹窗 | 复用上一轮的 **`FloatingWindow`**（可拖拽 + 可拉伸，只在关闭/Esc 时消失） |
| 3 | 验证深度 | **真机跑到有团队为止**：临时 DSH 环境里造真团队会话，看板/任务 CRUD 全验 |

## 诊断：为什么「没有适配」

不是没做，是**按 0.1.6 的服务 API 接的，而 0.1.7 把那套 API 删了**。真机（3080）curl 打我们自己的路由：

```
POST /sidebar/api/teams.view {"rootSessionId":"212f7157-…"}   → 200 {"available":true,"team":null}   无团队，正常降级
POST /sidebar/api/teams.view {"rootSessionId":"session-b98c…"} → 400 team-error "membership.svc.remoteView is not a function"
```

`src/team-routes.ts` 当初镜像的是 0.1.6 的 **Remote 词汇**（`npm pack @deepseek-ai/dsh-experimental-agent-team@0.1.6-alpha.2` 解包核对过：`remoteView` / `remoteCreateTask` / `remoteUpdateTask` 三个方法都在，README 明说它们服务于 `./remote` 导出）：

| | 0.1.6-alpha.2 | 0.1.7-rc.1（实际安装的包） |
|---|---|---|
| 读 | `remoteView(agent): TeamView` | `listMembers(agent)` / `listTasks(caller)`；官方 Web UI 改读 **Session projection `agentTeam`** |
| 写 | `remoteCreateTask` / `remoteUpdateTask` → 返回 `TeamTaskMutationResult` 联合 | `createTask` / `updateTask` → 返回已提交的 `TeamTaskView`，**拒绝改为抛 `TeamError`** |
| 冲突 | `{ok:false, error:{code:'team-task-conflict'}}` | 抛 `TeamError`，`code = 'TEAM_TASK_STALE_REVISION'` |

官方 README（0.1.7）原文：

> The Web UI reads the shared Session projections and overlays activity from Session status. Task creation and updates belong to Team agents through the service and model tools.

**后果**：`TeamBoard` 整条团队条从不渲染（`useTeamView` 落进错误分支，页面静默无提示），团队节点富化、任务行、任务弹窗全部连带失效；客户端判的冲突码也是 0.1.6 的 `team-task-conflict`，所以「别人改过、已刷新」永远不会出现。

## 架构（改后）

```
host（src/）
  team-routes.ts       只留两条写路由：taskCreate / taskUpdate
                       ├ ctx.get('agentTeams') 缺席        → 503 team-error
                       ├ ctx.agents.get(root) 未命中        → 404 team-error（团队按定义是 live-led）
                       ├ tryMembership 未命中               → 404 team-error
                       ├ TEAM_TASK_STALE_REVISION          → 409 team-conflict
                       └ 其余 TeamError                    → 400 team-error
  wire.ts              SidebarErrorCode += 'team-conflict'
  context-types.ts     agentTeams 只镜像写半边；新增 SidebarTeamProjection /
                       SidebarTeamMemberProjection 镜像；projection snapshot 加 agentTeam

client（src/client/）
  team-projection.ts   新：读 projectionsBySession[root].values.agentTeam + 派生成员运行状态
  SubagentView.tsx     删 useTeamView 及其 5s 轮询；team/teamMembers 改为 useMemo 派生
  tasks-model.ts       节点富化改吃 roster 行（role/name/phase/status/diagnostics）
  TeamBoard.tsx        成员点、任务 Tag 走 tasks-shared 的统一状态规则；根加 data-team-board
  TaskWindow.tsx       外壳换 FloatingWindow；动作行下沉到 footer；状态机跟随宿主
  tasks-shared.tsx     taskBlocked / taskStatusLabel / taskTone / taskDotState（任务状态唯一规则）
  api.ts               删 teamsView；写路由经 writeTask 把失败信封还原成 {ok:false, code, message}
```

### 为什么删掉 `teams.view` 而不是修它

官方 0.1.7 把「读团队」明确交给 projection，而插件**已经在读同一个快照**（`subagentCatalog` 就是同一个 `projectionsBySession`）。再留一条轮询路由等于把同一份数据读两遍、并继续维护两套降级语义（`{available:false}` / `{team:null}`）。改为一次查表后：

- `available:false` 与 `team:null` 合并成**一个**状态（projection 缺席 = 这里没有团队），页面行为不变（团队条不渲染、无横幅、无 console error）；
- 团队数据**跟着 snapshot 推送自动更新**，不需要手动刷新（刷新按钮上的 `team.refresh()` 一并删除）；
- `subagents.live` 本来就在给每个 child 报 `running`，成员运行状态直接复用，不新增任何请求。

## 真机验证（可复现）

### 造一个真团队会话

host 侧的 Agent Teams 实验层是 profile 层的（`dsh-experimental-agent-team-profile`），headless 通道默认不挂，用 `--patch` 注入同一份 patch 即可，不动 profile：

```bash
DSH_HOME=/Users/menghuan/.dsh-web npx -y --package @deepseek-ai/dsh@0.1.7-rc.1 \
  dsh headless --patch /tmp/dsh-selfcheck/agent-team-layer.yml --json "<spawn 一个 teammate + 建一条共享任务>"
```

`/tmp/dsh-selfcheck/agent-team-layer.yml` 是 `@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml` 的逐字复制（三条 insert + 四条 disable）。

### 证据链（本轮真实产出）

1. **写路由直连真实服务**（3080，新建构建）：
   - 未 live 的 root → `404 team-error "the tree root is not live in this process"`（**不再是 `remoteView is not a function`**）
   - `teams.view` → `404 not-found`（路由已删）
2. **看板从 projection 渲染**（Playwright，真实浏览器）：`[data-team-board]` 出现，文本 `团队任务板团队 2 成员 · 1 任务全部leadprobe-writerlive board probe待办新建任务`。
3. **任务窗 = FloatingWindow**：`aria-label=任务详情`、`[data-window-footer]` = `编辑 完成 删除`、**外部点击不关**、Escape 关。
4. **claim → complete 全链路**（浏览器点击 → 宿主路由 → 真实 `TeamService`）：
   - 队列中任务点「认领」→ 窗口与看板同时变 `负责人 lead` / `进行中`（Tag 不再是 阻塞）
   - 再点「完成」→ `已完成`，动作行变 `编辑 重开 删除`
   - 截图：`/tmp/dsh-selfcheck/22-live-turn.png`、`23-team-board.png`、`24-task-window.png`、`25-after-write.png`
5. **单元/集成**：`pnpm typecheck` / `lint` 通过；`pnpm test` **1276 passed / 9 skipped**（131 个 spec，新增 9 例：team-routes 重写 12 例、team-projection 9 例、任务窗状态机 2 例、状态规则 4 例）。

### 真机抓到的两个单测抓不到的问题（已修）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 队列中任务点「完成」→ 窗口报 `only an in-progress task can complete` | 宿主的任务是状态机（`pending → claim → in_progress → complete → completed → reopen`，`release`/`reassign` 回退为 pending），而窗口只提供「完成」 | 动作行跟随状态：pending 出「认领」（`ready:false` 时禁用，理由是标签已写`阻塞`）、in_progress 出「完成」、completed 出「重开」；新增 `teamTaskClaim` 词条 ×20 |
| 2 | 认领之后 Tag 变「阻塞」 | `ready` 的语义只是「pending 且所有 blocker 已完成 → 可以认领」，**对所有非 pending 任务都是 false**，用 `!ready` 判「阻塞」把正在做的任务标成了阻塞 | 抽出唯一规则 `taskBlocked(status, ready) = status === 'pending' && !ready`，`taskStatusLabel` / `taskTone` / `taskDotState` 共用；四处展示点（看板行、任务窗、节点任务行、图卡片）全部改走它 |

第 2 条是「修源头」而不是补丁：三处各自写了一遍 `ready ? … : 'teamTaskBlocked'`，所以把规则收敛成一个函数，未来只有一个地方会错。

## 实施偏差记录

1. **成员 `model` 与 `diagnostics` 从此缺失**：`agentTeam` projection 只带 `{id,name,role,phase,error?}`（已核对 `lib/types/types.d.ts`），0.1.6 的 `listMembers` 才带 `status/model/description/provider/context`。不做额外 host 路由去补（官方面板同样不显示模型）：节点详情的「模型」行删除；卡片 meta 行在成员没有 catalog mode 时回退到 `成员` / `部署中` / `出错`。
2. **运行状态改为派生**：projection 的 `phase` 是**持久生命周期**（`provisioning | active | failed`），turn 活动由 `subagents.live` 的 `running` 覆盖（官方 README 的 “overlays activity from Session status” 就是这个意思），Lead 行回退到 session list 的 `running`。规则写在 `teamMembersOf` 一处。
3. **不做 0.1.6 回退**：不保留 `remote*` 探测。插件这一版本来就要求 0.1.7+，且 0.1.6 的 Web UI 自己在这台机器上已经是重复插入（`ui-agent-team` 被 `-profile` 与 `-web-profile` 两个 bundle 各插一次，见 `dsh --profile web --dump-config` 第 1779/1782 行）——这是既有 profile 事实，本轮不动。
4. **`api.teamsTaskUpdate` 返回结果联合而不是抛异常**：`readEnvelope` 对失败信封是**抛** `SidebarApiError`，所以任务窗原本永远走不到 `{ok:false}` 分支（这是本轮唯一一个先写错、被真机证据纠正的地方）。现在 `writeTask()` 只在这一处把失败信封还原成 `{ok:false, code, message}`，让窗口能对 `team-conflict` 说自己的话。
5. **动作行从窗口体内挪到 shell 的 footer**：FloatingWindow 的 body 是滚动容器，长描述会把动作推出视野；footer 是固定行。`jobPopActions` 因此去掉自己的上边框（footer 已经画了分隔）。
6. **看板开关未改**：团队条的折叠箭头仍是旋转的 chevron（上一轮「折叠/展开分向」的结论只应用于图卡片簇），本轮不动以免扩大改动面。

## 已知限制

- **写路由需要 live 的 lead**：冷会话 / 另一个进程持有的会话 → 404。团队按定义是 live-led 的（服务要求把 live Agent 当权限凭证），这是结构性事实而非缺陷；页面在这种情况下仍能显示看板（projection 是持久的），只是动作会被拒。
- projection 对「本客户端从未加载过的会话」是否可用：真机上验证过**新会话 + 重启后**两条路径都可用（浏览器是从 `projectionsBySession` 读的，与 `subagentCatalog` 同源）；但如果将来宿主改成按需加载 projection，这块会退化成空看板而不是报错。
- 每个成员一行、每个任务一行都在 DOM 里（上限 8 成员 / 256 任务），未做虚拟化。
