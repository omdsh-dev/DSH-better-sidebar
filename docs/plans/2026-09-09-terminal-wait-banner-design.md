# 终端等待 banner（wait banner + 跳过）设计

> 2026-09-09 · 目标 v0.18.2

## 背景

`terminal_wait_for`（v0.18.1，PR #595 起 needle 支持 regex）会阻塞 agent 的工具调用直到
needle 出现 / 超时 / 终端退出。等待期间用户在侧边栏看不到任何"agent 正在等什么"的信号，
也无法干预——只能等 agent 自己超时（默认 10s，长等待可设到分钟级）。

需求：

1. agent 开始 `wait for needle` 时，在对应终端的顶部显示 banner：
   **「Agent 正在等待 {needle}」**，右侧「跳过等待」按钮；
2. 点击跳过后，`terminal_wait_for` 立即返回，agent 明确知道是用户跳过（而非超时）；
3. 终端 tab 未激活时也能感知等待 → tab 标题加 ⏳ 徽章。

## 方案对比

| 方案 | 思路 | 取舍 |
|---|---|---|
| **A. 搭现有推送车（采纳）** | 等待状态并入 `AgentTerminalSnapshot`，经现有 `/sidebar/ws/agent-terminals` 推送；跳过走新 `/sidebar/api` 方法 | 改动集中；零新 WS 生命周期；推送时机由 registry `notify()` 天然覆盖 |
| B. 独立 waits 推送 WS | 新开 `/sidebar/ws/agent-waits` | 重连/订阅/teardown 全套翻倍，YAGNI |
| C. 客户端轮询 | 定时拉 terminal 列表 | 延迟与开销差，违背现有推送架构 |

已确认的两个决策：

- **skip 语义 = 新增第四种返回 `kind:'skipped'`**（不复用 timeout、不走 abort——abort
  语义属于工具调用取消，用户语义只是"不等了"）；
- **banner 主体在终端卡片顶部 + tab 标题 ⏳ 徽章**（复用 v0.12+ 的 `TabDescriptor.badge`
  通道，git tab 有先例）。

## 设计

### 1. Host：`AgentPtyRegistry`（src/agent-pty.ts）

- `AgentTerminalHandle` 增活动等待记录数组 `waits: Array<{ needle, since, skipped }>`；
  并发 `wait_for` 同 uuid 时各登记一条。
- `waitFor()`：快速路径（已 exited / needle 已在 transcript）不登记、不推 banner；
  进入轮询前登记记录并 `notify()`（banner 出现），`finally` 移除记录并 `notify()`（banner
  消失——found/timeout/exited/skipped/工具 abort 五条出路统一走 finally）。
- 轮询每圈检查本记录的 `skipped` → 返回 `{ kind:'skipped', needle }`；50ms 轮询
  天然承载跳过延迟，无需事件唤醒。与终端退出在同一 tick 竞争时**退出优先**（见实施
  偏差记录）。
- 新方法 `skipWait(uuid): number`：标记该 uuid 全部活动记录并返回条数；uuid 未知 →
  `not-found` 404（与 `expect` 一致）。
- `AgentTerminalSnapshot` 增 `waiting?: { needle: string; since: number }`（取最新登记
  的一条；并发等待显示最新 needle，跳过跳过全部）。
- `AgentTerminalWaitResult` 增 `skipped` 变体。

### 2. 工具层：`terminal_wait_for`（src/tools.ts）

- output schema `oneOf` 增 `{ kind: 'skipped', needle }` 分支；
- render：`Skipped by user while waiting for "<needle>" — the wait ended early; call terminal_read to inspect the transcript if needed.`；
- 工具描述补一句：用户可从侧栏 banner 跳过等待（返回 `skipped`）。

### 3. API：`buildApi`（src/index.ts）

- 新方法 `'agent-pty.skip-wait'`（命名对齐现有 `'agent-pty.close'`）：
  `requireString uuid` → `registry.skipWait(uuid)`；degraded 模式（registry 为 null）
  幂等返回 `{ ok: true, skipped: 0 }`。

### 4. 推送零改动

`attachAgentList` 发的就是 `registry.list(sessionId)`，snapshot 新增的 `waiting` 字段
自动随车；等待开始/结束由 `notify()` 触发推送。兼容性：

- 旧客户端 + 新 host：多余字段被忽略；
- 新客户端 + 旧 host：永远收不到 `waiting` → 无 banner，安全降级。

### 5. 客户端状态（src/client/state.ts）

- `SidebarState` 增 `agentWaits: Record<uuid, { needle: string; since: number }>`（默认
  `{}`；等待结束即删除键）；
- `reconcileAgentTerminals` 从同一推送同步该映射——需解除"无 tab 增删即早退"的短路
  （仅 waiting 变化也要产出新状态）；
- **不持久化**：`sanitizeState` 逐字段重建、不恢复该字段 → 刷新后自然清空；WS attach
  即发首条推送，立刻纠正。

### 6. Banner（src/client/TerminalView.tsx）

- 仅 `agent:` tab 渲染；位置在终端区顶部（现有 fatal/deps banner 之上）；
- 内容：`t('terminalWaitBanner', { needle })`（zh「Agent 正在等待 {needle}」）+ 右侧
  `t('terminalSkipWait')`（zh「跳过等待」）按钮 → `api.agentSkipWait(uuid)`；
- needle 超 ~80 字符截断显示，`title` 悬浮显全文；
- banner 消失完全由推送驱动（skipped/exited/abort 均经 `notify`），点击不做乐观更新。

### 7. Tab ⏳ 徽章（src/client/builtins/tabs.tsx）

- terminal 描述符增 `badge: (_ctx, scope, state) => ...`：`agent:` tab 且
  `state.agentWaits[uuid]` 存在时返回 `'⏳'`，否则 null——复用 v0.12+ 徽章通道
  （git changes tab 先例），不碰 `TabBar`。

### 8. i18n / 样式

- 词典键：`terminalWaitBanner`、`terminalSkipWait`；zh/en 同步，**ja 翻译必须同步
  `src/client/locales-ja.ts`**（仓库规则）；
- `.terminalWaitBanner` 全部消费 `--dsw-alias-*` / `--ds-*` 令牌，无硬编码颜色
  （皮肤契约，`tests/theme.spec.ts` 守护）。

### 9. 测试

- `tests/agent-pty.spec.ts`：跳过返回 `skipped`；活动等待期间 snapshot 含 `waiting`、
  结束后消失；`skipWait` 未知 uuid → 404、无活动等待 → 0；等待开始/结束触发 `notify`；
- `tests/tools.spec.ts`：FakeRegistry 增 skipped 形状；schema/render 断言；
- `tests/agent-terminal-reconcile.spec.ts`：`agentWaits` 设置/清除、仅 waiting 变化也
  触发状态更新；
- badge / banner 组件测试视现有 jsdom 基建可行性补齐。

## 边缘情况

- **并发多个 `wait_for` 同一 uuid**：banner/⏳ 显示最新登记的 needle；跳过一次跳过全部；
- **工具调用取消（abort）**：`finally` 移除记录 → banner 消失并推送；
- **终端退出 / 用户关 tab（close frame 杀 pty）**：轮询下一圈返回 `exited`，记录移除；
- **UI-tab 终端**：无等待概念，`agentWaits` 永不含有其条目。

## 不做的事

- 不新增独立 waits WebSocket（方案 B 否决）；
- 不改 `ctx.betterSidebar` 服务面（`external-plugin-guide.md` 无需同步）；
- 不做乐观 UI（banner 消失以服务端推送为准）。

## 实施偏差记录

- **⏳ tab 徽章不走 `TabDescriptor.badge`**：实现时核实该 API 是 type-keyed
  （`badge(ctx, scope, state)`，无 tab 参数、external 插件共享），无法定位单个
  tab。改为 Sidebar 壳层 `tabBadgeOf` 的 sidebar-internal 特例（agent: 前缀判断
  + `state.agentWaits` 查表），`service.ts` 与 external-plugin-guide.md 零改动。
- **banner 抽为独立组件 `TerminalWaitBanner.tsx`**：设计原文写在 TerminalView
  内；抽出后无 xterm 依赖，jsdom 单测可直接渲染（TerminalView 仍负责订阅 store
  并把 onSkip 接到 `api.agentSkipWait`）。
- **词典同步扩到全部 21 个语言文件**：设计只写了 zh/en/ja，但
  `tests/locales.spec.ts` 断言每个第三方词典与 zh 键集相等——只同步三语会让该
  守护测试挂掉。按仓库惯例（全语言同步，如 e8761ee）补齐其余 18 语言同两键。
- **banner 配色**：仓库 CSS 无 state-info 令牌，沿用 `.terminalBanner` 的 warn
  对（`--dsw-alias-state-warn-label/-tertiary`），符合皮肤契约。
- **设计文档与计划随 feat 分支进 PR**：main 受分支保护，纯文档直推被 hook 拒绝
  （`4a6a77a` / `2448068` 随本分支合并）。
- **测试断言以文本计数取代 CSS 类名**：CSS module 类名在测试变换下不稳定，
  ⏳ 数量断言改从 `textContent` 计数；长 needle 截断断言改为计量 needle 自身
  贡献字符数（本地化句子包裹 needle，整体长度断言与语言相关，原计划内部矛盾）。
- **新测试的 localStorage 兜底**：Node 26 + jsdom 29 组合下测试环境可能无全局
  `localStorage`（上游 `bottom-auto-terminal.spec.tsx` 在同环境即失败，属已知
  win32/环境非回归类）；新 spec 的 afterEach 加守卫 + try/catch（jsdom opaque
  origin 下 localStorage 可以是 throwing accessor，裸 typeof 也会炸），
  上游测试一律未动。
- **已知限制：跨会话 pinned 虚拟 tab 收不到实时 banner/⏳**（Copilot review
  指出）：等待状态 feed 按 viewer 会话订阅（`/sidebar/ws/agent-terminals` 按
  当前 sessionId 连接），钉到其他会话的 pinned 虚拟 agent tab
  （`pinned:<homeSessionId>:agent:<uuid>`）在其 home 会话非当前会话时收不到
  实时等待状态。修复需跨会话 wait feed 多路复用（连 home 会话推送或聚合
  推送），超出本特性范围，留待后续设计；跳过 API 按 uuid 全局寻址，跨会话
  跳过本身可达。
- **Copilot review 第三轮修复（合并 rc.1 后扫描）**：
  1. `truncateNeedle` 改按 Unicode 码点截断（`Array.from`），原 UTF-16 码元
     截断会在截断点劈开代理对（emoji 渲染为替换字符）；
  2. banner 消息加 `role="status"` + `aria-live="polite"`，完整未截断的
     本地化消息经 `aria-label` 提供给读屏器（不新增词典键）；
  3. `terminal` tab 类型禁用时推送处理从整体跳过改为 `mirrorAgentWaits`
     ——仍镜像权威 `waiting` map（等在禁用窗口内 resolve 也清 banner 状态），
     只跳过 tab 增删 reconcile，否则重启用后已开终端残留 stale banner/⏳
     直到无关推送到达；
  4. badge 测试跟踪挂载的 root 并在 `afterEach` 里先 unmount 再清 DOM
     （裸 `innerHTML = ''` 不触发 React effect 清理，store 订阅/host-feed
     effect 会泄漏进后续测试）；
  5. 补并发双 `waitFor` 同 uuid 测试：快照显示最新 needle（`waits.at(-1)`）、
     `skipWait` 返回 2、两个 promise 都以各自 needle `skipped` 收敛、快照
     清空且 skipWait 幂等归零。
- **轮询优先级：终端退出优先于用户跳过**（v0.19.0 发版前 review 发现）：设计原文
  写「每圈优先检查 `skipped`」，实现是 `aborted → handle.exited → record.skipped`，
  即 pty 退出与用户点跳过落进同一个 50ms tick 时返回 `exited`。**维持实现现状**，
  设计原文已同步为「退出优先」：两种顺序下用户可见结果完全相同（banner 消失、
  `skipWait` 返回 0、等待结束），只有工具结果的 `kind` 文案不同；而进程已死是
  客观事实，报 `exited` 不撒谎，工具结果本身也引导 agent 用 `terminal_read` 复核。
  若日后要让「用户意图优先」，改动点是循环内两行先后 + 一条同 tick 竞态测试。
- **两个已知限制的补充记录**（同一次 review）：
  1. **pinned tab 的 banner 与 ⏳ 不对称**：pinned 虚拟 id 是
     `pinned:<homeSessionId>:agent:<uuid>`，`isAgentTabId` 只认 `agent:` 前缀，因此
     钉住的 agent tab **不会误挂 ⏳**（比"收不到"更强的保证）；但 Workbench 渲染
     pinned tab 时给 TerminalView 传的是**原 tab id + home 作用域**，所以 home 会话
     正在等待时该视图**会**显示 banner，而它的 strip 徽章仍不出现。两个信号数据源
     不同（banner 读 home store，徽章读 viewer 的 `agentWaits`）。
  2. **⏳ 到不了 DSH 原生右侧栏**：徽章经 `getTabBadge` 渲染，唯一消费点是插件
     自绘的 `TabBar`；原生栏的 `NativeTabTitle` 契约只带 title，不带 badge。agent
     终端标签页走 `openTabInBottomPane`（底部工作台），故 agent 流程可见；这是原生
     承载面契约决定的上限，非本特性缺陷。
- **注释随实现同步**（v0.19.0 发版前 review）：`use-host-feeds.ts` effect 头部原写
  「terminal tab 类型禁用时 pushes are ignored」，与上面第 3 项的 `mirrorAgentWaits`
  改法矛盾，已改为「不增删 tab，但仍镜像权威 wait map」；`src/index.ts` 的
  `agent-pty.skip-wait` 注释原文把「无活动等待 → 0」泛化成了「幂等」，已收窄为
  「无活动等待返回 `{skipped:0}`；未知 uuid 走 `expect` → 404（已退出的终端即属此
  列），客户端 `.catch` 容忍并等下一次推送收敛」。
