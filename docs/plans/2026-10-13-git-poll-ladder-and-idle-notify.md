# git 状态轮询收敛：30 s 基线 + 空闲不通知 + 降频阶梯（v0.26.0）

> 分支 `fix/git-poll-ladder`（基于 `dev`，DSH 0.2.0-rc.2 线）。
> 触发：维护者反馈「有嵌套 node_modules 的仓库里整个界面发卡、风扇转，编辑文件时尤其明显」。

## 问题与实测

一次性成本远大于预期。本机 `~/Code/deepseek-harness-desktop`（未忽略的 `.pnpm-store`
与「嵌套 node_modules 未被 `/node_modules` 锚定规则覆盖」是同一形态）实测：

| 命令 | 条目 | stdout | 耗时 |
|---|---|---|---|
| `status --porcelain=v1 -z --untracked-files=all` | **59,631** | **9.24 MB** | 0.131 s |
| 同上 `-unormal` | 1 | 0.00 MB | 0.032 s |

`GIT_STATUS_LIMIT = 2000` 是在整份 9.24 MB 已经产出、拼进 Node 字符串、`split('\0')`
成 59,631 个对象**之后**才截断的。而它每 2.5 s 跑一次（外加两条无 pathspec 的
`diff --numstat` 与一条建仓查询，共 4 个进程）。

两个放大器让这件事从「后台开销」变成「看得见的卡」：

1. **编辑器 gutter 持有轮询**（[2026-10-05-editor-git-gutter.md](2026-10-05-editor-git-gutter.md)
   的「实施偏差」收尾条）：`useGitStatus(scope, { visible: enabled })` 把功能开关当
   可见性，而 `visible` 就是启动定时器的开关；原生页签 `keepMounted` 让编辑器切走
   也不卸载。于是打开过任何一个 `code` / `jsonl` 文件之后，**整页生命周期**都在跑。
2. **空闲轮询触发全量重渲染**：`fetchSlot` 的 `.finally()` 无条件 `notify()` 自增
   `slot.version`，而它就是 `useSyncExternalStore` 的 snapshot。`sameStatus` 已经保住
   了 snapshot 身份（注释写明是为了让下游 memo 跨 tick 保持），版本号却在订阅层把
   这份努力作废——文件树在**父层**逐行算 `dirHasChanges`/`statusOf`，每 tick 照付。

## 落地内容

### 1. 空闲不通知（`src/client/ui/git-status.ts`）

只有可观测状态真的变了才 `notify`：起手仅当 `loading` false→true；`.then` 仅在快照
被替换或 `error` 解除时；`.catch` 仅在 `error` 置位时；`.finally` 仅当「变了」或
「loading 落回 false」。`release()` 丢弃快照仍通知。数据未变时消费者**一次都不重渲染**。

### 2. 降频阶梯

```ts
const POLL_BASE_MS = 30_000
const SLOW_TIERS_MS = [750, 2_000, 5_000]
const TIER_FACTORS  = [1, 2, 6, null]   // 30s / 60s / 180s / 停止自动轮询
```

tier 是**最近一次往返耗时的纯函数**（`tier = SLOW_TIERS_MS.filter(t => d >= t).length`），
所以快响应立刻回到基线，没有连续计数、不会卡在某一档。tier 变化即重建定时器
（间隔烘在 handle 里）。停在最高档后，挂载 / 保存 / 暂存 / 提交 / 丢弃 / 手动刷新
这些**事件驱动**的刷新照常工作，而且它们就是恢复通道。

选客户端往返耗时而不是服务端上报：它同时覆盖 git 的工作量与传输，且不需要新协议。

**阈值取位的说明**：上面实测的那个仓库（0.131 s）**不会**触发降档——它落在 tier 0，
靠的是基线本身从 2.5 s 抬到 30 s（同一份扫描的工作量降到 1/12，占空比从约 5% 降到
约 0.4%）。750 ms 那一档是给真正慢的形态兜底：更大的 monorepo、冷缓存、网络盘 /
WSL 挂载、Windows 上的进程 spawn 开销。把第一个阈值压到能命中 0.131 s 没有必要，
那会让正常的仓库也频繁退档。

### 3. 两种消费者（`poll`）

`useGitStatus` 新增 `poll?: boolean`（默认 `true`）。`Slot` 把「要数据」（`visible`）
与「要定时器」（`pollers`）分开计数：

- `visible 0→1` 时抓一次（**与 poll 无关**，非轮询消费者也要一次读数）；
- `pollers 0→1` 起表、`1→0` 停表；
- 只有 `poll: true` 的消费者会写 `slot.pollMs`，不会覆盖别人正在跑的节奏；
- `visible → 0` 时停表 + 清快照。

文件树（`FileTree.tsx`）与文件变动页（`changes/GitLens.tsx`）走默认值，**行为逐字不变**，
只是节奏从 2.5 s 变 30 s 起。

### 4. gutter 只读不轮询

`useEditorGitGutter` 新增 `visible`，订阅改为 `{ visible: active, poll: false }`
（`active = enabled && visible`），并只在**换文件或保存**时各 `refresh()` 一次；
`TextEditor` 把 `props.visible !== false` 传下去（`FileViewerProps.visible` 早已由
`EditorHost` 下发，无需新增管道）。挂载时**不**额外请求——没有别的承载面时
`retain` 已经抓了一次，同一提交里再要一次只是重复扫描。

### 5. `worktrees()` 的计数不再跑完整 status

`worktrees()` 对**每个 linked checkout** 调完整 `status()`（4 个进程，含 `-uall` 与两条
全仓库 numstat）只为读 `.entries.length`，而变动页每 30 s 轮询它一次。改为单命令
`git status --porcelain=v1 -z --untracked-files=normal` 并数条目：N×4 → N×1 轻量进程。

**语义有一处刻意的变化**：未跟踪**目录**计 1 而不是展开计入每个文件——「这个 checkout
有没有改动」本来就该这么读，而且旧数字还被 `GIT_STATUS_LIMIT` 悄悄截断过。文件树与
变动页的逐文件行不受影响（它们读的是完整 `status()`）。

## 验收

- `tests/git-status-poll.spec.tsx`（7 例）：`poll:false` 不起表 / `poll:true` 走 30 s 基线 /
  非轮询先到不阻塞后来的轮询者、轮询者离开即停表 / **空闲同结果不通知**（snapshot 恒等）/
  慢往返退到 60 s 且快响应回到基线 / 极慢往返停止自动轮询且事件刷新可恢复 / 不可见不订阅。
- `tests/editor-git-gutter.spec.tsx` +3：在屏编辑器不持有轮询（推进 120 s 仍 1 次）/
  不可见时完全不订阅 / 换文件与保存各只重读一次、纯重渲染不重读。
- `tests/git-worktree.spec.ts` +1：未跟踪目录在清单里计 1，而完整 `status()` 仍展开 50 条。
- 判别性：分别回退「空闲守卫」「poll 归属」「gutter 的 `poll:false`」，对应用例当场红
  （已逐条实测）。

## 后续项（本次普查发现，未纳入本批）

三条只读普查线（客户端周期任务 / 宿主命令成本 / 长驻流式资源）共 30+ 项，按
「收益 ÷ 改动量」排序，本批只收 git 这一族：

| # | 位置 | 问题 | 量级 |
|---|---|---|---|
| 1 | `src/git.ts` 的 `status()` | 两条**无 pathspec** 的 `diff --numstat`，每轮成本 = 全部已改文件字节 | 21 MB 已改文件 = 0.17 s/轮 |
| 2 | `src/git.ts` 的 `runGit` | stdout 全量拼成 JS 字符串，**无字节上限** | 9.24 MB → ≥18 MB 串 + rope |
| 3 | `src/fs-tree.ts` compact 探测 / `src/index.ts` 单层 `fs.tree` 路由 | 每个目录行一次 `opendir`（1000 行 = 21.1 ms）；`ProbeGate` 只在飞并发 32、不限总量；单层路由**不传 gate** | 单批最坏 6.4 万次 `opendir` |
| 4 | `src/client/sidebar/right-panel-open.ts` + `dock-fallback.tsx` | 两个常驻 500 ms 定时器做强制同步布局；`dock-fallback` 最坏每 tick 400 步 `elementsFromPoint`；都无视 `document.hidden` | 4 次/秒强制布局（估低 git 那条 1–2 个数量级） |
| 5 | `src/sidechat-routes.ts` | cold 线程每次轮询**全量重读**持久化日志后 `slice(8000)` | O(线程历史) |
| 6 | `src/client/JobsDrawer.tsx`、`SubagentView.tsx` | 每秒 / 每 3 s **无条件**写新对象 → 整表重渲染 | 行数决定 |
| 7 | `git-status.ts:slots`、`git.ts:repoRootsCache`、`active-worktree.ts`、`ops-stream.ts` | 模块级 Map **无容量上限** | 内存增长（非本次症状） |

已核实有界、不需要动的：三条推送 socket（纯失效帧 + 去抖 + 指数退避 + 空闲零帧）、
终端（插件不持 PTY，宿主逐帧 ack = 天然背压）、归档/流式（并发 4 + TTL + 全错误路径删
临时文件 + `pipeline` 常量内存）、`ops-stream` 的 leader 选举与空闲裁剪、`frame-batcher`、
有界 rAF 动效、`use-polling` 的 self-scheduling，以及除 `git-status.ts` 之外所有
`useSyncExternalStore` 快照的稳定性（逐个查过，那条计数器是孤例）。
