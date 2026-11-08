# 稳态开销治理：0.25 引入的常驻轮询、每 tab 成本与 keepMounted 的无界复利

**日期**：2026-10-15
**状态**：已实施（分支 `fix/perf-steady-state`，门禁全绿，合 `dev`）
**触发**：社区反馈「0.24 没问题，之后就会卡」——`sidebar` 在前台开太久就卡；装上 BSB 后 DSH 多轮对话会卡，卸载即恢复，重装 + 重启 DSH 又暂时不卡。
**结论**：分界线落在 **v0.25.0**。v0.26.0 只修了 git 轮询那一族（见 [2026-10-13-git-poll-ladder-and-idle-notify.md](2026-10-13-git-poll-ladder-and-idle-notify.md)），本文覆盖的四条 0.25 机制原样保留至今。

---

## 1. 取证：产物级 A/B（`lib/client.js` 标记计数）

| 标记 | v0.24.1 | v0.25.0 | v0.26.0 |
|---|---|---|---|
| `keepMounted` | **0** | 7 | 7 |
| `data-sidebar-right-toggle` / `data-dsh-dock-fallback` | 0 / 0 | 6 / 5 | 6 / 5 |
| `elementsFromPoint`（无条件命中测试走查） | **0** | 3 | 3 |
| `setInterval` 站点总数 / `session.cwd` 引用 | 4 / 6 | 9 / 16 | 9 / 16 |
| 500 ms 周期表 | **无** | 有 | 有 |

产物取自仓库根的历史 tarball（0.24.1 / 0.25.0）与已安装的 0.26.0；计数命令是 `grep -o <标记> lib/client.js | wc -l`。**v0.26.0 与 v0.25.0 在这些标记上逐项相同**——即 0.26 的修复没有触及本节任何一条。

## 2. 取证：数字（本机实测，方法可复现）

### 2.1 两个 500 ms 轮询（`right-panel-open.ts` + `dock-fallback.tsx`）

合成 DSH 形态页面（长转录 + 拥挤的右侧栏头部）在无头 Chromium 里跑**逐字复制**的两个轮询体：

| 场景 | 单 tick | 6 s 内 `getBoundingClientRect` / `getComputedStyle` / 命中测试 |
|---|---|---|
| 安静（52 节点） | 0.10 ms | 21 / 3 / 5 |
| 常驻（812 节点 + 头部入口，流式） | 1.70 ms | 81 / 21 / 26 |
| 拥挤（12 个页签芯片，流式） | 2.70 ms | 168 / 95 / 114 |
| 大 DOM（3101 节点，拥挤 + 流式） | **9.70 ms** | 168 / 95 / 114 |

按 2 Hz 计，最坏一档是 **~3,500 次强制布局读取/秒**。同一基准下帧间隔 p95 未恶化——**单独看它是贡献项而非唯一主因**；它的危害在「无论是否可见都在跑」（`dock-fallback` 的 interval 注册在 early return 之前，渲染 `null` 时照跑）与「随 DOM/页签数增长」。

### 2.2 `src/active-worktree.ts`（0.24.1 中不存在，0.25 引入）

用 rolldown 打包真实模块后实测（session base 指向真实 git 仓库，统计真实 `git` spawn 次数）：

| 用例 | 4 000 事件 | 8 000 事件 | git spawn |
|---|---|---|---|
| 少量固定绝对路径（典型 read/edit 流） | 42.2 ms | 44.7 ms | 4 |
| 全 free-form 文本（无绝对路径，走满 4 000 事件窗） | 16.0 ms | 16.4 ms | 1 |
| 每次不同且不存在的绝对路径 | 13.7 ms | 12.8 ms | 1 |

即**单次缓存未命中 ≈ 10–45 ms，其中 `git rev-parse --show-toplevel` 约 10 ms/次**，而该解析器被塞进 **12 个 `/sidebar/*` 路由共用的 `cwdOf()`**；`ACTIVE_ROOT_TTL_MS = 3 s` 与客户端新增的 **每 5 s** 轮询错配 → **每次轮询必然未命中**。三个模块级缓存（`activeWorktreeRootCache` / `pathTopCache` / `linkedWorktreeCache`）都只有写、没有删，且 base 探针**没有在飞去重**（对照 `git.ts` 的 `repoRootsInFlight`）。

### 2.3 keepMounted 的复利

0.25 起所有 native tab 类型声明 `keepMounted: true`（宿主契约：访问过的 body 在切页签、**切会话**与停靠时都不卸载，宿主没有 LRU 上界）。于是：`useSessionRoot` 的 5 s 轮询（`native/tab-adapter.tsx:485`，每个 body 一份）× 2.2 的 miss 成本 = **每访问一个页签，就永久多一条「每 5 s 一次 git spawn + 一次日志扫描」**；`useDirectoryWatch` 的每树一条 `/sidebar/ws/fs-watch`（宿主按连接给到 64 个 `fs.watch` 句柄）同理；每个编辑器页签的 CodeMirror 视图（~7 个全局订阅）与 4 个 document 级监听也随访问过的页签线性累加。

### 2.4 与版本无关但同属该症状的无界/无条件项

- `settings-nav-icon.ts`：`MutationObserver(document.body, {childList, subtree, characterData})` **未合帧**，流式 token 改动文本节点即按微任务触发，回调做全文档 `querySelectorAll('[role="dialog"] nav button')`。
- `use-center-column.ts`：1.5 s interval 与 `CENTER_COLUMN_REVALIDATE_MS = 1500` 等长 → 注释声称的「缓存命中即 query-free」永不生效。
- `session-phase.ts`：1 s 轮询每次 `setPhase(新对象)`，blank 会话常开 = 每秒一次重渲染，且不看页面可见性。
- `JobsDrawer.tsx`：`liveCount > 0` 时 1 s `setNow(Date.now())`（新值，必然重渲染整份行列表），parked 的任务页照跑，无可见性门控。
- `SubagentView.tsx`：3 s / 5 s 两个轮询都用新对象 `setLive`/`setRuns`，每 tick 重算整棵代理树与图布局。
- `GitLens.tsx`：号称 silent 的 30 s 盘点 tick 在早退**之前**就 `setWorktrees(新数组)`。
- 模块级 Map 只增不减：`ui/git-status.ts` 的 `slots`（`release` 只清快照）、`ops-stream.ts` 的 `streams`（注释写明 "alive for the page"）、`state.ts` 的 `bySession`（无删除路径，且 `getSessionStates()` 每次整份复制，被 `syncExpanded` 在每次 store notify 上调用）、`TextEditor.previewScrollMemory`、`GitLens.commitDrafts`、`markdown-navigation.pendingAnchors`（TTL 只在消费时检查）。
- `agent-opens.ts` 的 `pending` 无上限；`src/index.ts` teardown 只 `close()` 三个 `noServer` `WebSocketServer`——ws@8 不会终止已在连的 socket，于是 fs-watch 的 `fs.watch` 句柄与 agent-opens 的订阅者活到浏览器断开。

## 3. 已核实干净（避免重复排查）

三个推送 socket 的逐连接释放（无 per-connection `ctx.on`/`ctx.effect`，计时器与句柄都随 socket 关闭释放）、`use-polling` 的自调度与 teardown、`jobs-client` 的引用计数、终端（插件不持 PTY，宿主逐帧 ack 天然背压）、归档/上传/下载/分页读取（并发上限 + TTL + 临时文件清理 + `pipeline` 常量内存）、`frame-batcher` 与两个有界 rAF tween、`ui/git-status.ts` 的 30 s 阶梯与空闲静默、`ops-stream` 的 per-session leader 选举。

## 4. 决策（用户确认）

1. **范围**：0.25 回归 + #935 遗留项一起修。
2. **keepMounted**：保留「切走不卸载」的语义（保住滚动、草稿、展开态），但**加上界与释放**——把每个驻留 body 的周期工作按可见性门控、把插件侧记账与缓存加上界。宿主对 mounted DOM 本身没有 LRU，插件无法单方面设界，这一条记为已知代价。
3. **反馈版本**：以 0.26.0 为主（含 0.25.0）→ git 轮询节奏族已排除，嫌疑集中在本节四条 0.25 项 + keepMounted。
4. **门禁**：加轻量门禁——断言「不可见时不得存在周期定时器 / 不得读布局 / 不得发请求」「同一会话至多一个轮询器」，不做脆弱的耗时阈值。

## 5. 实施清单

| 组 | 内容 |
|---|---|
| A | `dock-fallback` 的 500 ms 表改为「真的渲染了才建表」+ `document.hidden` 停表 + 走查上限 400→100 步；`right-panel-open` 改模块级共享 poller（引用计数）+ 隐藏停表 + 恢复即读；`settings-nav-icon` 的观察者改 rAF 合帧并去掉 `characterData`；`use-center-column` 让「缓存命中即 query-free」成立；`session-phase` 加可见性门控且值未变不 setState |
| B | `use-session-root` 改「按会话引用计数的共享 store」+ `visible` 入参，消费点（`tab-adapter` 的每个 body、shell）传真实可见性；`FileTree`/`use-dir-watch` 把已有的 `visible` 接进目录 watch（parked 时不建 socket、不重列）；`use-sidechat-push`/`SideChatView` 的订阅按可见性门控；`state.bySession` 加 LRU 上界并让 `getSessionStates()` 不再每次整份复制 |
| C | `active-worktree` 加在飞去重、TTL 3 s→15 s、三个缓存加上界；`git.ts` 的 numstat 加 pathspec 且 `runGit` 输出加字节上限；单层 `fs.tree` 路由补 gate + compact 探测封顶；`sidechat-routes` 冷线程加 memo；`agent-opens.pending` 封顶；teardown 主动关闭三个 WSS 的已接受连接 |
| D | `ui/git-status.ts` 的 `slots` 参与淘汰；`ops-stream.streams` 加上界/释放且保持「首拉即基线」；`TextEditor.previewScrollMemory` / `GitLens.commitDrafts` / `markdown-navigation.pendingAnchors` 有界；`JobsDrawer` 的 1 s 时钟抽成自持 state 的 memo 组件并按可见性门控；`SubagentView` 同值保持引用 + 派生 memo；`GitLens` 的 silent tick 真的 silent |
| E（门禁） | `tests/steady-state.spec.tsx`（结构性：不可见时不建表 / 不读布局 / 不发请求；同一会话单例）+ `tests/e2e/perf.e2e.ts` 的 `steady-state` 指标与两条硬断言（`elementsFromPoint` 预算、`session.cwd` 按会话而非按页签） |

## 6. 明确不做

- 关闭 `keepMounted`（用户已选保留语义 + 加上界）；
- 文件树 / 侧聊列表虚拟化；
- CSS 回潮 `:has`；
- 任何宿主侧改动；
- 给 perf lane 加耗时阈值（只记录数字 + 结构性断言）；
- `numstat` 改成按需请求（本轮只加 pathspec 与字节上限）。

## 7. 复现与测量方法（含一个本机坑）

**不要用 PATH 上的 `dsh` 跑隔离测量**：本机的 `~/.local/bin/dsh` 是 DSH Desktop 生成的 shim，里面**硬写** `export DSH_HOME=/Users/menghuan/.dsh`，会覆盖调用方传入的 `DSH_HOME`——用它做 scratch profile 安装会把插件写进真实 profile（本次实测把 live profile 的 BSB 降级到 0.25.0，随后用 `dsh plugin --profile web add dsh-better-sidebar@0.26.0` 复原）。CI 走 `npx -y --package @deepseek-ai/dsh@0.2.0-rc.2` 不受影响。本地隔离请显式指向 bundled CLI（`DSH_CMD='node "<...>/dsh/lib/bin.js"'`）或走 npx 钉版。

```bash
# 改前 / 改后各跑一次：稳态指标 + 硬断言
TARBALL=/tmp/bsb-audit/artifacts/dsh-better-sidebar-0.26.0.tgz \
DSH_CMD='node "/Users/menghuan/Library/Application Support/dsh-tauri/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"' \
  bash scripts/e2e-mount.sh --grep 'steady-state'
```

报告里要看的数字：`PERF_SUMMARY steady-state 15s: live500=… hitTest=… session.cwd=…`。

## 8. 实测 before / after（真机挂载 lane，同一台机、同宿主 0.2.0-rc.2、同端口 0、同一脚本）

场景：`perf.e2e.ts` 的 `steady-state` 用例——真实 `dsh web` + 真实挂载，经宿主 guide 打开 4 个插件 tab 型（files / git / subagent / sidechat，**全部访问过因而全部挂载**），收起宿主右侧栏后进入 15 s 空闲窗。

| 指标（15 s 空闲窗） | before（v0.26.0 产物） | after（本分支） |
|---|---|---|
| 活着的 500 ms 表 | **3** | **1**（共享的展开态表） |
| 活着的 5 000 ms 表 | **5**（4 个 tab body + 壳） | **0** |
| 活着的周期表总数 | 9 | **1** |
| 空闲窗内 `session.cwd` 请求 | **15**（= 5 个轮询器 × 3） | **0** |
| 强制布局 `getBoundingClientRect` / `getComputedStyle` | 5 190 / 586 | **30 / 30** |
| 命中测试 `elementsFromPoint` | **1 620** | **0** |
| 整场 `session.cwd` 请求（含扫 tab 阶段） | 25 | 4 |

before 那一次**用例失败**（命中测试断言：1620 > 40），after 通过——门禁的判别力由此在真机上被证明，不是「在修复后的代码上恰好绿」。5 000 ms 表在 after 里仍有 4 次**创建**（扫 tab 时每个页签各自可见，各起一次），但空闲窗内**一条都不活着**——这正是「按会话 + 可见性」的预期形态。

## 9. 落地记录与偏差

- **`use-session-root` 的可见性来源**（各消费点不同，逐个交代）：native tab body 用宿主的 `nativeTab.visible`；插件自己的壳用 `state.bottomOpen === true`（底部工作台开合，与 `renderTab` 已有的门控同源）；文件树用已有的 `visible` prop；侧边聊用已有的 `visible` prop。**未做**：两个 socket hook（`use-dir-watch` / `use-sidechat-push`）没有接 `document.hidden`——仓库里没有共享的页面可见性 helper，本轮只按各自已有的 `visible` 门控，隐藏标签页仍持有 socket。
- **`ACTIVE_ROOT_TTL_MS` 3 s → 15 s** 的语义代价：会话切入 linked worktree 的跟随延迟从 ≤3 s 变成 ≤15 s；事件驱动的重问（文件树刷新、保存、focus、watcher 帧）不受影响。
- **numstat 的 pathspec** 取自 `status()` 已读到的 porcelain（非 `??` 路径 + R/C 的 origin，必须带 `--literal-pathspecs`，否则 `:name` 这类会被当 pathspec magic）；路径字节超 8 000 时**回退整仓库 diff**（旧行为，正确只是慢）；未跟踪路径不参与，所以「未忽略的大目录」那种仓库从两条全仓库 diff 变成**零条**。
- **`runGit` 输出上限 8 MiB**：单个超限答案（例如超大 patch）从「累积成 ≥18 MiB 的 JS 串」变成走普通 git 失败路径（既有 `GitCommandError` 形状），按失败降级；状态行上限改在**产出侧**生效（2 000 行 × 2 字段的预算，rename 记录占两个字段）。
- **`JobsDrawer` 的 1 s 时钟**改成每行一个自持 state 的 memo 组件（开着的抽屉里通常 1–3 条），而不是整抽屉一个表 + 每 tick 重建整份行列表；行的 `aria-label` 因此不再逐秒变化（无障碍名稳定）。
- **`GitLens` 的 silent tick** 用「同值保持引用」而不是把 `setWorktrees` 挪到早退之后：`pollInventory` 的存在意义是「中途新建的 linked checkout 也能自己冒出来」，挪到早退之后会让它在 silent tick 上永远冻结；两者都能达成「未变化不重渲染」，选了不牺牲功能的那条。
- **`SubagentView`** 仅靠 `setState(prev => same ? prev : next)` 不够——实测 React 在相同结果上仍会提交一次，所以补了一个 `published` ref 在 dispatch 之前拦掉；两者都留作双重围栏。
- **`ops-stream.streams`** 选 LRU 上限而不是「最后一个成员离开即删」：记录里的 `seq`/`primed` 是「parked 页签回来仍能折到错过的那次写操作」的载体，删了就会在回join 时重新基线、静默吞掉变更；只有被 32 个更新的会话挤出去才会重新基线（与刷新页面同代价）。两条都进了用例。
- **`settings-nav-icon`** 去掉 `characterData`：标记身份是「挂载的按钮 + 其文本」，对话框重挂/子节点变化已覆盖；保留它等于让主对话每个流式 token 都触发一次观察者。
- **测试期新增的两处 seam**（无行为面可观测，故导出）：`previewScrollMemory` / `commitDrafts` 的读写 helper，`sweepPendingAnchors()`。

