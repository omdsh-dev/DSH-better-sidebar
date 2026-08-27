# 固定终端（Pinned Terminals）设计

> 2026-08-26 · 状态：设计已评审，待实施
> 需求：现所有 Tab 跟随会话，切换会话后终端仍留在原会话（不可见但 PTY 保活）。
> 希望右键终端 Tab 可「固定」→ 二级菜单「固定到工作区 / 固定到全局」，固定后切换会话不消失。

## 0. 决策记录（已确认）

| 决策点 | 结论 |
|---|---|
| 可 pin 的终端类型 | **UI 终端 + Agent 终端均可**（Agent 终端被 reconcile 移除时保留为「已断开」tab） |
| 跨会话呈现形态 | **独立「固定区」列表**（PinnedRail，面板顶部紧凑条），不投影进目标会话 tab 条 |
| Menu 二级菜单 | `ui-primitives` 的 `Menu` **原生支持 `submenu`**（`MenuItem.submenu`，hover/focus 展开右侧子卡），零改动可用 |

## 1. 现状关键事实（实施依据）

- **状态模型**（`src/client/state.ts`）：`SidebarStore.bySession: Map<sessionId, SidebarState>`；`setSession()` 整体换快照。`SidebarTab = { id, type, title, path?, diff?, meta? }`。终端 tab：`type: 'terminal'`。
- **终端两类**（id 前缀判别，无需新字段）：
  - `terminal:<uuid>` —— UI 终端（用户 + 菜单开，`createTab` 铸造）
  - `agent:<uuid>` —— Agent 终端（模型 `terminal_create` 工具，`reconcileAgentTerminals()` 跟宿主 WS 列表同步；`isAgentTabId()` / `agentUuidOf()` / `agentTabId()` 已存在）
- **PTY 保活**（`src/client/TerminalView.tsx` 卸载三分支）：tab 关闭 → `{type:'close'}` 杀 PTY；**切会话 → `{type:'park'}` 宿主机无限保活**；同会话重挂载 → bare drop（30s 重连宽限）。Agent 终端 bare drop 已无限保活，无需 park。
- **关闭路径**（`src/client/Sidebar.tsx` `actions.closeTab`）：service `closeTab` + 终端额外 `api.ptyClose({sessionId,cwd},tabId)` / `api.agentPtyClose(uuid)`。
- **持久化**：`localStorage` `dsh-sidebar:v1:<sessionId>`，`sanitizeState` 白名单校验；`sanitizePersistedTab` 逐 tab 校验（未知 type → OrphanedTab 占位）。
- **TabBar 右键菜单**（`src/client/TabBar.tsx`）：flat `items`，`onSelect(id)` 分发。Menu `MenuEntry = MenuItem | MenuSeparator | MenuLabel`。
- **宿主会话切换**：Sidebar 只读 `ctx.sessions.list` 的 `current`（`store.setSession(current)` 跟随）；「跳转到子代理会话」先例 = `subagentJumpRef` 记录目标 + 宿主列表侧点击导航，effect 在 `sessionId === pending` 时执行后续动作（PinnedRail 点击沿用此模式）。
- **cwd 来源**：`sessionList.byId[sessionId]?.cwd`（`Sidebar.tsx:303` 先例）。

## 2. 数据模型

```ts
// state.ts — SidebarTab 新增可选字段
interface SidebarTab {
  // ...现有字段
  /** 固定标记（v0.x+）。scope=工作区|全局；homeCwd=pin 时刻会话 cwd（workspace 可见性判据）。 */
  pin?: { scope: 'workspace' | 'global'; homeCwd?: string }
}
```

- `sanitizePersistedTab` 白名单校验 `pin`（`scope` 枚举值校验，`homeCwd` string 可选；非法值降级为无 pin，不丢 tab）。缺字段 = 未 pin，旧持久化状态向后兼容。
- pin 元数据**随宿主会话 state 持久化**，无独立 localStorage 注册表（YAGNI）。
- **权威副本唯一**：pinned tab 只存在于宿主会话（home session）的 state 里，其他会话仅跨会话渲染——现有 park/保活语义零改动。

## 3. 跨会话解析层（新模块 `src/client/pinned.ts`，纯函数）

```ts
/** 该 pinned tab 对 viewer 会话是否可见。cwd 未知（undefined）时保守可见，避免水合期闪烁消失。 */
export function pinnedVisibleTo(
  tab: SidebarTab,
  viewer: { sessionId: string; cwd: string | undefined },
): boolean

/** 从所有缓存会话的 state 收集对 viewer 可见的 pinned 终端 tab。
 *  返回 { tab, homeSessionId }[]，按 pin 先后稳定排序；排除 viewer 自己会话的
 *  （那些本就在 tab 条上，避免双渲染）。 */
export function collectPinnedTabs(
  bySession: ReadonlyMap<string, SidebarState>,
  viewer: { sessionId: string; cwd: string | undefined },
): { tab: SidebarTab; homeSessionId: string }[]
```

可见性规则：

| pin.scope | 可见条件 |
|---|---|
| `global` | 任意会话（不同 cwd 也可见） |
| `workspace` | `viewer.cwd === tab.pin.homeCwd`（两者皆 undefined 视为匹配；仅 viewer.cwd 未知时保守可见） |

`SidebarStore` 新增只读方法：

```ts
/** 当前所有会话 state 的只读视图（供 collectPinnedTabs）。 */
getSessionStates(): ReadonlyMap<string, SidebarState>
```

渲染期解析，不写跨会话投影——每会话 state 保持纯净，reduce/reduceFor 语义不变。store 任意会话更新已全局 notify，rail 随 uSES 自动重渲染。

## 4. UI：PinnedRail（新组件 `src/client/PinnedRail.tsx`）

- **挂载**：`Sidebar.tsx` 内、右面板 tab 区之上（右/底面板共享一条，pinned tab 不归属任何树）。仅当可见 pinned ≥ 1 时渲染。稳定寻址面 `[data-dsh-pinned-rail]`、`[data-dsh-pinned-tab="<tabId>"]`。样式走 CSS Modules + `--dsw-alias-*` 令牌（§8 皮肤契约），hairline 分隔。
- **条目**：pin 图标（📌 风格 SVG，icons.tsx 新增 `IconPinOutline16`）+ 终端类型图标（Agent 终端用机器人/思考图标，UI 终端用终端图标）+ 标题 + tooltip（`类型 + 范围 + 来源 cwd`，如「Agent 终端 · 固定到工作区 · D:\proj\x」）。
- **交互**：
  - **点击**：当前会话含该 tab id → `activateTab`；否则记录 `pinnedJumpRef`（沿用 subagentJumpRef 模式）→ 触发宿主导航到 home 会话 → effect 命中后 `reduceFor` 激活 tab（面板折叠则展开）。
  - **右键菜单**（复用 Menu portal）：`取消固定` / `关闭终端`。
  - **中键**：关闭（同右键关闭）。
- **关闭语义**：走 home 会话路径——`reduceFor(homeSessionId, closeTab)` + `api.ptyClose({sessionId: homeSessionId, cwd: homeCwd}, tabId)` / `api.agentPtyClose(uuid)`。正处 home 会话时退化为现有 closeTab 路径。关闭同时清 pin（tab 消失即 pin 消失，无需单独解 pin 步骤）。

## 5. TabBar 右键菜单扩展（`src/client/TabBar.tsx`）

终端类型 tab（`tab.type === 'terminal'`，含 UI 与 Agent）菜单项变为：

```
移动到自由窗口
固定 ▸                ← 未 pin；MenuItem.submenu
  ├ 固定到工作区
  └ 固定到全局
取消固定             ← 已 pin（替换「固定 ▸」行）
─────────────
关闭 / 关闭其他页签 / 关闭左侧 / 关闭右侧
```

- 菜单 label 按终端类型区分：`固定终端`（UI）/ `固定 Agent 终端`（Agent）。
- TabBar 新增 props：`onPinTab(tabId: string, scope: 'workspace' | 'global' | null): void`（null = 取消）。`isPinned` 从 tab 对象自身读（`tab.pin !== undefined`），无需新 prop。
- pin 实现（Sidebar 层）：`store.reduce(s => patchTab(s, tabId, { meta: ... }))` 不够——`patchTab` 只 patch title/path/meta。**新增 reducer `setTabPin(state, tabId, pin | null)`**（纯函数，walk 两树 + floats，与 patchTab 同构），pin 时从当前会话 cwd 快照 homeCwd。

## 6. 生命周期与安全

| 场景 | 行为 |
|---|---|
| 关闭 pinned tab（tab 条 X 或 rail 关闭） | 清 pin + 正常关闭 + 杀 PTY（home 路径） |
| Agent 终端被 reconcile 移除（宿主 uuid 消失） | `reconcileAgentTerminals` **豁免 pinned tab**：保留 tab，标题渲染时追加 `（已断开）`（不改持久化 title，reconcile uuid 匹配不受影响）。xterm 重连失败走现有 fatal banner |
| UI 终端 PTY 死亡 | 现有行为（xterm 显示退出输出）；pinned 不改变重连/重开语义 |
| 取消固定 | 仅清 `tab.pin`；tab 留在 home 会话 tab 条，切走恢复旧行为 |
| 刷新/重载 | pin 随会话 state 持久化恢复；rail 从各会话缓存 state 重建 |
| 底部面板/窄屏迁移 | pinned tab 若在 bottomSplits，`migrateBottomTabs` 照常迁移（pin 语义不受影响） |
| 自由窗口中的 pinned tab | 允许；rail 点击切回 home 会话后 `raiseFloat`（floatWithTab 命中走置顶，openTabInActivePane 已有此分支） |

## 12. 实施偏差记录

### M3：断开信号收敛

设计 §6 原表「Agent 终端被 reconcile 移除」行提到「标题渲染时追加 `（已断开）`」。实施时收敛为：**M3 只做豁免，断开的用户可见信号由 xterm 现有重连失败 banner 承担**。原因：rail/tab 标题渲染处无法知道宿主列表（`reconcileAgentTerminals` 的 uuid 匹配是 state 级的，渲染层不持有该信息），改 meta 会写持久化（违反「reconcile uuid 匹配不受影响」）。xterm 的 WS 连接 1011/超时已有 fatal UI，足以承担断开信号。设计 §6 表相应行实施时修正为「banner 承担断开信号」。

### M4：内联虚拟 Tab（取代 PinnedRail）

设计 §3 原描述「PinnedRail 组件——面板顶部的紧凑条，渲染其他会话的 pinned tab」。实施时改为**内联虚拟 Tab**：pinned tab 作为虚拟 `SidebarTab` 注入到当前会话 split tree 的第一个 leaf 的 `tabs` 数组尾部，与普通 tab 并排在 TabBar 中渲染。

**变更原因**：用户反馈「固定的终端是永远显示在 Tabs 栏处，而不是单独有一个地方让我点击后回到那个会话」。PinnedRail 是面板顶部的独立条，点击跳回宿主会话——这两个设计点都被否定。

**新设计**：
- **虚拟 Tab 注入**：`injectPinnedIntoTree(state.splits, pinnedVirtualTabs, activePinnedTabId)` 将虚拟 tab 追加到第一个 leaf，并在 `activePinnedTabId` 设置时覆盖 leaf 的 `active`
- **就地激活**：点击虚拟 tab 设 `activePinnedTabId`（本地 state），TerminalView 用 home session 的 scope（sessionId + cwd）连接宿主 PTY 的 WS（`/sidebar/ws/terminal?sessionId=<home>&tab=<originalId>`），不跳转会话
- **effectiveTabId**：`TabContent` 新增 `effectiveTabId` prop，将虚拟 tab 的原始 id 传给 descriptor component（TerminalView 的 `tabId` 参数），虚拟 id 仅作 React key
- **不可拖拽**：TabBar 检测 `isPinnedVirtualTab(tab)` → `draggable={false}`，跳过 drop handler
- **右键菜单精简**：pinned 虚拟 tab 右键只有 Unpin / Close（无 float / close-others / close-left / close-right）
- **reduceFor 不 notify**：`pinnedRevision` state bump 替代 `railRevision`，force `pinnedEntries` useMemo 重算

## 7. 测试计划（Unit + 组件，vitest）

| 文件 | 覆盖 |
|---|---|
| `tests/pinned.spec.ts`（新） | `pinnedVisibleTo` 全组合（global/workspace × cwd 匹配/不匹配/双方 undefined/单方 undefined）；`collectPinnedTabs` 跨会话收集、排除 viewer 自身会话、稳定排序、home 会话 id 携带 |
| `tests/state.spec.ts`（追加） | `sanitizePersistedTab` 接受合法 pin / 拒绝非法 scope 降级 / 缺字段兼容；`setTabPin` reducer（设置/取消/未知 tabId no-op/浮动窗口 tab）；`reconcileAgentTerminals` 豁免 pinned agent tab（uuid 消失仍保留）+ 未 pin 的照旧移除 |
| `tests/tab-bar-context-menu.spec.tsx`（追加） | 终端 tab 出现「固定 ▸」子菜单（UI 与 Agent 文案区分）；非终端 tab 不出现；已 pin 显示「取消固定」；onPinTab 回调参数正确 |
| `tests/pinned-rail.spec.tsx`（新） | rail 渲染条件（0 个不渲染）；类型图标与 tooltip；点击切回 home 会话（reduceFor 激活）；右键取消固定/关闭；「已断开」后缀渲染 |

回归：`pnpm typecheck && pnpm test`；终端相关改动加跑 `tests/agent-terminal-reconcile.spec.ts`、`tests/terminal-*.spec.ts`、`tests/bottom-auto-terminal.spec.tsx`。

## 8. i18n（19 语言词典同步，遵循 locales-*.ts 模式）

新增 key：`pinTerminal` / `pinAgentTerminal` / `pinToWorkspace` / `pinToGlobal` / `unpinTerminal` / `pinnedTerminalTooltip`（类型/范围/cwd 插值）/ `terminalDisconnected`。
zh-CN 基准 + en；ja 必须同步（better-locale 契约：缺 ja key 回退 en）。其余语言沿用现有词典文件的同步方式。

## 9. 文档同步

- `README.md` / `README_EN.md`：功能清单加「固定终端」
- `AGENTS.md` §3.4 内置 tab 表：terminal 行补充 pin 能力说明；§7 陷阱表视情况加「pinned tab 跨会话解析在渲染期，勿在 reducer 里投影」
- 实施偏差记录在本文档追加

## 10. YAGNI（明确不做）

- ❌ 独立 localStorage pin 注册表
- ❌ pinned tab 投影进目标会话 tab 条（独立固定区已选定）
- ❌ pin 非终端 tab
- ❌ 宿主机（host 半）改动——PTY 保活现有逻辑完备（park + agent 无限保活）
- ❌ pin 数量上限（终端本身有 `TERMINAL_LIMIT` 配额兜底）

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| rail 点击需触发**宿主**会话切换（非 sidebar store） | 沿用 subagentJumpRef 模式；PinnedRail 点击项渲染为宿主会话列表可识别的导航（或经 `ctx.sessions` 可用 API），effect 在 sessionId 命中后激活 tab。实施时先验证该链路（PoC 先行） |
| 「已断开」标题与后续 reconcile push 兼容性 | 后缀在**渲染期**追加，不改持久化 title；reconcile 按 uuid 匹配不受影响 |
| bySession 未缓存的会话（从未加载）其 pinned tab 不可见 | 接受：会话 state 在首次切换时 loadState 进缓存；rail 只覆盖本次运行内访问过的会话 + 当前会话。如需全覆盖需扫 localStorage 全量 key（复杂且慢），YAGNI |
