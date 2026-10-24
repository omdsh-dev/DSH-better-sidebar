# Sidechat 长对话「排队信息漏入」：投影层根因与 create 后 inbox.clear() 围栏

日期：2026-09-13　分支：`fix/sidechat-inbox-projection-leak`

## 现象

长对话（父会话 mid-turn）中创建 sidechat 线程后，第一条提问发出时，模型会先收到父会话切割时刻**未领取的排队输入**（next-step 里的工具结果上下文/steering，或 next-turn 里排队的用户消息），然后才是 boundary + 问题——即 v0.18.1 修复过的「排队信息漏入」在 0.1.5-rc.2 宿主上复发。

## 兼容复查结论（本任务的另一半）

- 最新 DSH = `0.1.5-rc.2`（npm `next`；桌面 App 内置；CI 钉版；peer `^0.1.5-rc.1` 容纳）。v0.19.1 与 rc.2 的 API 面兼容（挂载冒烟 14/14），**唯一的语义不兼容即本缺陷**。
- 用户环境事实（2026-09-13）：当前桌面 GUI（`--profile r`，:3384）运行 GitHub main 的插件 0.19.1（含 v0.18.1 的标记对修复）；`web` profile 运行本地 `0.19.1-icons3` tarball；`desktop` profile 仍钉 0.17.1（其 sidechat 调用 rc.2 已移除的 `Session.events`，`sidechat.start` 会直接失败——该 profile 当前无进程使用，待清理/升级，不在本次范围）。

## 根因（真实 rc.2 包静态读码 + 可执行实验双重证明）

1. `sidechat.start`（`src/sidechat-routes.ts`）用 `buildSidechatInheritance` 逐字复制父日志为种子，**含父会话未领取的 `agent/inbox/spliced` 事件**，并带 fork 标记对（`meta.isSeeded: true` + `inheritedEventCount = seed.length`，v0.18.1 引入）。
2. 标记对只切割 `Session.ownEvents()`（`snapshotEvents(inheritedEventCount)`）。但运行时子线程 inbox 的真实路径是：
   `ReactLoopInbox.current()`（`@deepseek-ai/dsh-agent-loop`）→ `ctx.sessionProjections.stateOf(session, 'inbox')` → `SessionProjectionRegistry.cellFor`（`@deepseek-ai/dsh-session-projection`）→ `buildCell(def, header, inheritedEventCount, session.snapshotEvents())` —— 折的是**全量日志（含继承种子前缀）**。
3. 两处上游事实使标记对在投影层失效：标准 inbox 投影（`inboxProjectionDefinition`）的 `init(header, inheritedEventCount)` **忽略第二个参数**；注册表的 `session/created` 急切初始化对 `seq !== 0` 的会话跳过（种子会话创建时 seq 已 = seed.length + 1，恒被跳过）。
4. 于是幽灵消息留在子会话 live inbox；sidechat 首问经 `agent.followup` 唤醒 driver 开 turn，`Inbox.claim('next-turn')` 先排空 next-step → 幽灵消息先于 boundary + 问题进入模型请求。
5. 实验证据（node 脚本，真实 rc.2 类 + 真实 cordis `Context`）：带标记种子 → 注册表状态 `{"nextTurn":1,"nextStep":1}`；追加 `clear()` 等价补偿 splice 后 → `{"nextTurn":0,"nextStep":0}`。
6. v0.18.1 的回归测试为什么没拦住：`tests/sidechat-seed-validation.spec.ts` 折的是 `ownEvents()`——**错误的事件集**。标记对该切割真实有效（测试绿），但运行时不走这条路。

## 决策

- **方案 B（已选定）**：`agents.create` 成功后立即 `handle.agent.inbox.clear()`（`Agent.inbox: Inbox` 是 `@deepseek-ai/dsh-agent` 公开接口）。
  - 无竞态：driver 只在 wake（`send(wakeup=true)` / maintenance）后 claim；清空前本线程无人 send 过（`agents.create` 解析时 loop 已启动但 phase = idle，源码核实）。
  - durable：补偿 splice 是子会话 own 事件（end-seed 之后），随会话持久化——冷恢复 `agents.resume` 后注册表折存储日志同样归零。
  - 转录无噪：`src/client/sidechat-transcript.ts` 的事件 switch 对 `agent/inbox/spliced` 不产出行。
  - 空线程分支（Codex-style 立即创建）同样受益：插入点在两分支之前，幻影不会潜伏到首条 composer 消息才被 claim。
- **否决 D'（种子内追加补偿 splice）**：需在 `sidechat-core` 复刻上游折叠算法 ~20 行；方案 B 一行公开 API 达成同一不变量，KISS 胜出。
- **标记对保留**：`ownEvents()` 切割仍真实且必要（转录自有事件边界双保险之一、持久化谱系、宿主 catalog）。
- **已知限制（用户确认接受）**：修复前创建的旧线程冷恢复后仍可能漏（种子里带幽灵消息且无补偿事件）。不在 resume 路径清 inbox——会误杀「用户在 sidechat 排队了合法消息且宿主重启未领取」场景的真实输入。

## 验证

- `tests/sidechat-routes.spec.ts`：fake agent 增 `inbox.clear` spy；断言带问题与空线程两条路径各 clear 恰一次，且 invocationCallOrder 在 `inject`/`followup` 之前（先红后绿）。
- `tests/sidechat-seed-validation.spec.ts`：新增「真实投影注册表」describe——Test A 钉住上游洞（带标记种子 → `stateOf` 仍 1/1；上游若修根因，此断言随钉版升级变红，即提示移除插件侧围栏）；Test B 证明 `clear()` 的补偿 splice 使注册表归零且 ownEvents 为 `[end-seed, splice, splice]`。共享日志 helpers 提升到模块作用域。
- `pnpm typecheck` / `pnpm build` / 全量 `pnpm test`（127 文件 1348 用例）全绿。
- 真机生效时机：profile `r`（GitHub main 安装）需本 PR 合入 main 后重装；`web` profile 换新包。本次**不发版**（用户决定），故 npm 侧无变化。

## 影响

| 文件 | 变更 |
|---|---|
| `src/sidechat-routes.ts` | `sidechat.start` 在 create 后、两分支之前调用 `handle.agent.inbox.clear()`（+ 根因注释） |
| `tests/sidechat-routes.spec.ts` | fake agent 增 inbox spy；两条 clear 时序断言 |
| `tests/sidechat-seed-validation.spec.ts` | helpers 提至模块作用域；新增真实注册表 describe（洞 + 围栏两测） |
| `AGENTS.md` | §3 第 11 条补「标记对必要但不充分；运行时围栏 = create 后 clear()」 |
