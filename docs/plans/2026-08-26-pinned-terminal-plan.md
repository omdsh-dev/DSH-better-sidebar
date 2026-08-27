# 固定终端（Pinned Terminals）实施计划

> 2026-08-26 · 设计文档：[2026-08-26-pinned-terminal-design.md](2026-08-26-pinned-terminal-design.md)
> 仓库：dsh-better-sidebar · 分支策略：`feat/pinned-terminal`（仓库硬约束：代码改动必须走 PR）

## 里程碑总览

| # | 里程碑 | 产出 | 验证 |
|---|---|---|---|
| M1 | 数据模型 + 解析层 | `SidebarTab.pin`、`setTabPin` reducer、`sanitizePersistedTab` 校验、`src/client/pinned.ts`、`SidebarStore.getSessionStates()` | `tests/state.spec.ts` + `tests/pinned.spec.ts` 绿 |
| M2 | TabBar 右键菜单 | 「固定 ▸」二级菜单（UI/Agent 文案区分）、「取消固定」、`onPinTab` prop 接线 | `tests/tab-bar-context-menu.spec.tsx` 绿 |
| M3 | reconcile 豁免 + 断开标注 | pinned agent tab 豁免移除 + 渲染期「已断开」后缀 | `tests/agent-terminal-reconcile.spec.ts` 追加用例绿 |
| M4 | PinnedRail 组件 | rail 渲染、类型图标、tooltip、点击切回 home 会话、右键取消固定/关闭 | `tests/pinned-rail.spec.tsx` 绿 |
| M5 | i18n + 文档 + 收尾 | 19 语言 key、README/AGENTS.md、全量回归 | `pnpm typecheck && pnpm test` 全绿 |

## M1：数据模型 + 解析层

**改动文件**：
- `src/client/state.ts`：`SidebarTab.pin?: { scope: 'workspace' | 'global'; homeCwd?: string }`；`sanitizePersistedTab` 白名单校验 pin（非法 scope → 降级无 pin，不丢 tab）；新 reducer `setTabPin(state, tabId, pin | null)`（walk splits + bottomSplits + floats，同构 `patchTab`；未知 tabId 严格同引用 no-op）
- `src/client/pinned.ts`（新）：`pinnedVisibleTo(tab, viewer)` + `collectPinnedTabs(bySession, viewer)`（排除 viewer 自身会话、按收集顺序稳定）
- `src/client/state.ts` `SidebarStore`：新增 `getSessionStates(): ReadonlyMap<string, SidebarState>`（暴露 `bySession` 只读视图）

**测试**：
- `tests/state.spec.ts`：pin 字段 sanitize（合法/非法 scope/缺字段）、`setTabPin`（设置/取消/未知 id/浮动窗口 tab/同引用 no-op）
- `tests/pinned.spec.ts`（新）：`pinnedVisibleTo` 矩阵（global × 任意 cwd；workspace × cwd 匹配/不匹配/双方 undefined/仅 viewer undefined）；`collectPinnedTabs`（多会话收集、排除自身、空 map）

**提交**：`feat: pin data model + cross-session resolver`

## M2：TabBar 右键菜单

**改动文件**：
- `src/client/TabBar.tsx`：新增 prop `onPinTab?: (tabId: string, scope: 'workspace' | 'global' | null) => void`；终端 tab（`tab.type === 'terminal'`）菜单插入 pin 行——未 pin 用 `MenuItem.submenu`（`固定到工作区` / `固定到全局`），已 pin 用单行「取消固定」；label 经 t() 且按 `isAgentTabId` 区分文案
- `src/client/Sidebar.tsx`：实现 `onPinTab` —— `store.reduce(s => setTabPin(s, tabId, scope === null ? null : { scope, homeCwd: cwd }))`（cwd 取当前会话 summaryCwd）；传入 WorkbenchActions → 各 TabBar 实例
- 检查 `FreeWindow.tsx` 头部右键菜单是否也需 pin 项（与 TabBar 保持一致；若 FreeWindow 菜单独立实现则同步加）

**测试**（`tests/tab-bar-context-menu.spec.tsx` 追加）：
- 终端 tab 菜单含「固定 ▸」且 hover 展开两项；点击回调 `(tabId, 'workspace' | 'global')`
- 已 pin tab 显示「取消固定」，回调 `(tabId, null)`
- 非终端 tab 无 pin 行；Agent 终端 label 为「固定 Agent 终端」

**提交**：`feat: tab context menu pin submenu`

## M3：reconcile 豁免 + 断开标注

**改动文件**：
- `src/client/state.ts` `reconcileAgentTerminals`：`toRemove` 过滤掉 `tab.pin !== undefined` 的 tab（豁免移除）
- 渲染期「已断开」：pinned agent tab 的标题后缀在**读取侧**追加——`TabBar`/rail 渲染处无法知道宿主列表，故在 `reconcileAgentTerminals` 豁免时给 tab meta 打标？**否**（改 meta 会写持久化）。方案：rail/tab 标题渲染保持原 title；「已断开」状态由 TerminalView 现有重连失败 banner 承担（WS 连接 1011/超时已有 fatal UI）。**收敛**：M3 只做豁免，断开的用户可见信号 = xterm banner，不加标题后缀（避免渲染期需要宿主列表的耦合）。设计文档 §6 表相应行实施时修正为「banner 承担断开信号」。

**测试**（`tests/agent-terminal-reconcile.spec.ts` 追加）：
- pinned agent tab 在 uuid 消失后保留；未 pin 的照旧移除；豁免不影响 toAdd 路径

**提交**：`feat: reconcile exempts pinned agent terminals`

## M4：PinnedRail 组件

**改动文件**：
- `src/client/PinnedRail.tsx`（新）：props `{ entries: { tab, homeSessionId }[], currentSessionId, onFocus(homeSessionId, tabId), onUnpin(tabId), onClose(homeSessionId, tabId) }`；`[data-dsh-pinned-rail]` 锚点；pin 图标 + 类型图标 + tooltip；右键 Menu（portal）；中键关闭（沿用 TabBar middlePressed 模式）
- `src/client/PinnedRail.module.css`（新）：紧凑条样式，`--dsw-alias-*` 令牌，hairline 分隔，面板折叠时隐藏
- `src/client/Sidebar.tsx`：
  - 渲染期 `collectPinnedTabs(store.getSessionStates(), { sessionId, cwd: summaryCwd })`（useMemo on snapshot + sessionList）
  - `pinnedJumpRef`（沿用 subagentJumpRef 模式）+ effect：`sessionId === pending` 时 `reduceFor` 激活 tab（`activateTab` 命中 float 则 raiseFloat）+ 面板折叠则 `togglePanel`
  - onClose：home 路径 `reduceFor(home, s => closeTab(...))` + `api.ptyClose({ sessionId: home, cwd: homeCwd }, tabId)` / `api.agentPtyClose(uuid)`；当前会话退化为现有 `actions.closeTab`
  - rail 挂载点：右面板内、第一个 TabBar 之上；窄视口（合并抽屉）同样渲染
- `src/client/icons.tsx`：`IconPinOutline16`（若图标库无现成 pin）

**宿主会话切换链路（关键风险，先 PoC）**：rail 点击 → 宿主会话列表导航。调研 `ctx.sessions` 客户端 API 是否有主动切换方法（参考 subagent 跳转实际触发方式）；若无公开 API，用 `location.hash` 导航（与宿主路由一致）。PoC 验证后再写组件。

**测试**（`tests/pinned-rail.spec.tsx` 新）：
- 0 条目不渲染；≥1 渲染条目（图标/tooltip/标题）
- 点击非当前会话条目 → 记录 jump + 导航调用（stub）；effect 命中后 reduceFor 激活
- 右键取消固定（onUnpin）、关闭（onClose 参数 home 路径）；中键关闭
- 浮动 pinned tab 点击 → raiseFloat 分支

**提交**：`feat: pinned rail component + cross-session focus`

## M5：i18n + 文档 + 收尾

**i18n**（`src/client/locales.ts` + 19 个 `locales-*.ts`）：
- 新 key：`pinTerminal` / `pinAgentTerminal` / `pinToWorkspace` / `pinToGlobal` / `unpinTerminal` / `pinnedTerminalTooltip`（插值：类型/范围/cwd）
- zh-CN 基准 + en 必写；ja 必同步（better-locale 契约）；其余语言沿用既有同步惯例
- `tests/locales.spec.ts` 守护同步性

**文档**：
- `README.md` / `README_EN.md` 功能清单加「固定终端」
- `AGENTS.md` §3.4 内置 tab 表 terminal 行补 pin 说明
- 设计文档追加「实施偏差」节（如 M3 的断开信号收敛）

**回归门禁**：
```powershell
pnpm typecheck; pnpm test
# 重点回归：agent-terminal-reconcile / terminal-* / bottom-auto-terminal / tab-bar-* / state / prefs
```

**版本**：`package.json` minor bump（新功能）；`src/client/service.ts` `features` 数组若对外暴露 pin 能力则加 `'pinnedTerminals'`（消费插件 gate 用）——本功能不开放服务 API，**不加**。

**提交**：`feat: pinned terminal i18n + docs` → PR `feat/pinned-terminal`

## 依赖与顺序

M1 →（M2 ∥ M3）→ M4 → M5。M2/M3 互不依赖可并行；M4 依赖 M1 的 pin 字段与 reducer；M5 最后。

## 风险登记

| 风险 | 缓解 | 状态 |
|---|---|---|
| 宿主会话切换无公开 API | M4 开工先做 PoC（读 subagent 跳转链路 + `ctx.sessions` 面）；实在不行用 hash 导航 | 待验证 |
| rail 在窄视口/底面板合并态的布局 | 复用现有面板 CSS 变量；`tests/breakpoints*.spec.*` 观察 | 实施期 |
| bySession 未缓存会话的 pin 不可见 | 设计已接受（YAGNI 全量扫 localStorage） | 已确认 |
