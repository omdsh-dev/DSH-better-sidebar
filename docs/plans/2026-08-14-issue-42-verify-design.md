# Issue #42 诊断与收尾记录（底部面板首展自动终端 → 整面板空白）

**日期**：2026-08-14
**状态**：已诊断、已收尾（无新代码修复；回归测试 + 文档交付）
**关联**：issue #42、issue #25（同根因）、issue #31（放大器）、PR #27 / commit 37d91be、commit 9aeb046
**目标版本**：v0.11.0（根因修复已发布）

## 1. 问题报告

[issue #42](https://github.com/omdsh-dev/DSH-better-sidebar/issues/42)（Windows 11 / QQBrowser / dsh-launcher 宿主 / 插件 0.10.3）：

1. 全新安装后重启 + 硬刷新，首次展开底部面板（`bottomPanelAutoTerminal` 默认开）→ **整个底部面板空白，连标签栏都没有**；
2. 控制台两条关键报错：
   - `Uncaught TypeError: Cannot read properties of undefined (reading 'dimensions')`（`Viewport._innerRefresh`）
   - `Uncaught TypeError: Cannot read properties of undefined (reading 'handleResize')`（`IdleTaskQueue._process`）
3. 关闭「底部面板首次展开自动开终端」后一切正常；右侧栏终端一直正常；
4. 附带问题：Windows 无控制台宿主下每次关闭终端，服务器日志出现 `Error: AttachConsole failed`（node-pty `conpty_console_list_agent.js`）。

## 2. 诊断结论

### 2.1 根因 = issue #25 的同一 bug

与 [issue #25](https://github.com/omdsh-dev/DSH-better-sidebar/issues/25)（WKWebView 底部面板终端空白）完全同源，证据链：

- **触发路径一致**：`Sidebar.tsx` 的「底部面板首次展开自动开终端」effect（`bottomOpenedOnce` 过渡）在面板 slide-in transition 的**同一次 commit** 挂载 `TerminalView`。`docs/plans/2026-08-14-terminal-open-when-sized-design.md` §3 在设计 #25 修复时已明确把该路径列为零尺寸挂载路径之一。
- **崩溃签名逐字一致**：0.10.3 的 `TerminalView` 挂载 effect 同步执行 `term.open(host); fit.fit()`（无尺寸守卫）。xterm 5.3.0 在零尺寸容器 open 时渲染器创建失败，`RenderService._renderer` 保持 undefined → `Viewport._innerRefresh` 读 `_renderService.dimensions`（getter 即 `_renderer.value.dimensions`）、idle 任务读 `handleResize` 全部抛 "Cannot read properties of undefined"——与 #42 两条报错逐字对应。
- **平台差异只是时序**：#25 设计文档注明「Chrome（Blink）对零尺寸布局更宽容所以不崩；WKWebView 稳定复现」。QQBrowser（Chromium fork）在 Windows + launcher 启动的组合下命中同一零尺寸窗口期，属边界时序，不是新缺陷。
- **版本差**：#42 报告针对 **0.10.3**（2026-08-13 发布）；根因修复 37d91be（PR #27）于 2026-08-14 合并并随 **v0.11.0** 发布（早于 #42 提交约 1 小时，晚于 reporter 安装的版本）。

### 2.2 修复覆盖路径（无需新代码）

| 层 | 机制 | 位置 | 状态 |
|---|---|---|---|
| 根因（零尺寸 open） | `openWhenSized`：`term.open + fit + sendResize` 推迟到容器有尺寸后恰好执行一次；RO/字体订阅的 `fit()` 全部 try/catch 加固 | `src/client/open-when-sized.ts` + `TerminalView.tsx`（37d91be，v0.11.0） | 已发布 |
| 根因单测 | 手动步进 rAF 的 6 个用例（延迟/一次性/单维缺失/cancel/脱离文档/异常传播） | `tests/open-when-sized.spec.ts` | 已提交 |
| 「整面板空白」放大器 | per-tab `RenderBoundary` 崩溃隔离（单 tab 崩溃只显示该 pane 内条带，toggle 簇/其他 tab/面板存活）+ 根 boundary 兜底 + layout-push CSS 变量卸载清理 | `src/client/RenderBoundary.tsx`、`Sidebar.tsx`、`index.tsx`（9aeb046，#31） | 已提交 |
| 隔离测试 | 崩溃条带/重试恢复/布局变量清理 | `tests/sidebar-crash.spec.tsx` | 已提交 |
| **#42 触发链回归** | 底部面板首展自动开终端：恰好一个 terminal tab 落在底部工作树、`bottomOpenedOnce` 原子置位、pref / 类型禁用双门控、面板完整存活 | `tests/bottom-auto-terminal.spec.tsx`（本次新增，4 例） | 本次提交 |

三者合起来构成 #42 全链回归保护：触发链（本测试）→ 零尺寸延迟（openWhenSized 单测）→ 崩溃隔离（containment 测试）。

## 3. 附带问题：AttachConsole 报错（仅文档化）

`Error: AttachConsole failed`（node-pty `conpty_console_list_agent.js`）是 **node-pty 上游行为**：`kill()` 清理路径 fork 的 console-list 辅助进程在无控制台宿主（launcher/服务方式启动的 `dsh`）下 `AttachConsole(shellPid)` 失败。终端功能本身不受影响（spawn/输入输出正常），仅刷服务器日志。

- 插件侧不可消除：不改 DSH 源码、不 patch node-pty 依赖是仓库硬约束（见 AGENTS.md §0），且 `IPty.kill()` 是 node-pty 的唯一 kill 通道；
- 建议：保持现状（无功能影响），上游如提供无控制台规避选项再跟进；reporter 若在意日志噪音，可反馈 microsoft/node-pty。

> 交叉引用（issue #140）：与本文档「仅刷日志」不同，**依赖缺失/损坏**（node-pty 安装不完整导致模块加载失败）已有插件侧降级处理——宿主半懒加载 node-pty，失败时终端 tab 显示可复制的修复命令（`scripts/install.sh --repair` / `install.ps1 -Repair`），详见 `src/pty-deps.ts` 与 `tests/pty-deps.spec.ts`。

## 4. 验证

- 全量测试：`pnpm test` → 34 文件 / 430 例全部通过（基线 425 + 同期 PR #43 的 html 盘符修复 1 例 + 本次新增 4 例）；
- `pnpm typecheck`（`tsc --noEmit`）通过；
- `pnpm build`（`tsc -p tsconfig.build.json && tsdown`）通过。

## 5. Issue #42 回复草稿（供 maintainer 发布/关闭用）

> 感谢复现与详细报告。诊断结论：**这是 issue #25 同一根因在不同平台的复现**——底部面板首次展开自动开终端时，终端在容器尚为零尺寸（面板 slide-in 窗口期）就执行了 xterm `Terminal.open()`，渲染器创建失败导致后续 `Viewport._innerRefresh` / 空闲任务读取 `.dimensions` / `.handleResize` 崩溃（与 #25 的控制台报错逐字一致）。
>
> 该根因已在 **v0.11.0** 修复（终端延迟到容器有尺寸后再 open，PR #27）；「整个面板空白」的放大器也已在最新 main 消除（单 tab 崩溃隔离 + 布局变量清理，issue #31）。**请升级到 v0.11.0 验证**：预期首次展开自动开终端不再空白；若仍复现，请提供 v0.11.0 下的控制台报错。
>
> 附带问题（`AttachConsole failed` 日志噪音）确认为 node-pty 在无控制台宿主（launcher 启动）下的上游行为，无功能影响，插件侧无法在不改动 node-pty/DSH 的前提下消除；已文档化（`docs/plans/2026-08-14-issue-42-verify-design.md`），并已补 #42 触发链回归测试。
