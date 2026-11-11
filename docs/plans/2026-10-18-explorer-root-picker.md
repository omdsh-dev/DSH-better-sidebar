# 文件树根目录可选（#1003）

> 设计文档：为什么加一个显式根、它管什么、刻意不管什么。实现三块：宿主侧的会话级固定
> （`src/session-root.ts`）、一条读写路由（`session.root`）、根行上的下拉
> （`src/client/FileTree.tsx` 的 `RootRow`）。

## 1. 问题

0.25.0（#802）起，文件树的根不再是会话 header cwd，而是**推断**出来的：宿主提交的
`working_directory`（`sessionCwdOf`）之上再叠加「最新 `tool/call` 里出现过的 linked
worktree」（`active-worktree.ts`）。推断本身有它的道理（agent 常常在 `.worktrees/<x>`
里干活，而 header 是冻结的），但它有两条难以接受的后果：

1. **判据弱、后果面大**：一次 fs 工具调用的绝对路径就足以换根，而换根同时改变 explorer
   列出什么、`fs-watch` 订阅谁、`/sidebar/file` 与 `/sidebar/html` 的基准——用户看到
   视图跳走、选择与行内编辑态清空，却不知道是谁改的。
2. **没有出口**：界面上没有切换入口，唯一的纠正是重启宿主并设置进程级
   `DSH_SIDEBAR_WORKTREE_ROOT`——它对所有会话生效，并且会打断当前对话。

真实报告：#952（容器工作区里嵌套仓库的 linked worktree 抢根，工作区兄弟目录全消失）、
#960（根被钉在已删除的 checkout 上，文件树报「文件夹不存在」且永不自愈）、#982（Windows
上非活跃会话回退 `C:\`）。#947 / #950 是同一段基准链上的地址侧后果，由 #956 处理。

## 2. 决策

**给一个显式根，但把它限定为「视图根」。**

- **只有用户动作能写**：下拉里的选择。推断继续存在，默认值零变化。
- **保存在宿主、按会话生效**：`/sidebar/file` 与 `/sidebar/html` 把路径编码进 URL、
  fs-watch 的帧里也只有路径，二者都无法携带客户端参数；放客户端则它们跟随不到，而且
  5 秒一次的 `session.cwd` 轮询会把选择覆盖回去。
- **不持久化**：宿主重启回到自动根（内存 Map，LRU 上界 256）。持久化会把「视图选择」
  抬成配置面，本批不做。
- **写基不动**：相对路径与写路径仍按会话 cwd 解析（#956 / #963 的口径）。这是在 issue
  里就写死的边界——否则本功能会变成第二个 #950（同一相对路径静默落到另一检出）。
- **消失即作废**：命中固定值时先 `stat`（不 spawn 进程），目录没了就丢弃固定并返回自动
  根。这正是 #960 的形状，固定不能自己制造同一个死路。

## 3. 实现

### 3.1 宿主

- `src/session-root.ts`：`pinnedRootOf` / `pinSessionRoot` / `unpinSessionRoot` 三个
  纯函数 + `livePinnedRootOf`（带存活校验），模块级 Map 用删除再插入维持 LRU 顺序，
  超过 `PINNED_SESSIONS_MAX`（256）淘汰最久未读的一条。
- `src/active-worktree.ts` 的 `activeWorktreeRootOf` 顶部加两件事：`ignorePin` 选项
  之外先看固定值。固定值优先于**环境变量覆盖**——后者正是「一个会话要回到主检出」时
  用错工具的那一个。12 条 `cwdOf()` 消费方与 3 条直连路由因此零改动地跟随。
- `src/index.ts` 新增 `session.root`：无 `root` 字段时读（返回 `root` / `automatic` /
  `base` / `pinned`），带 `root` 时写（`null` 或 `''` 清除）。写入走
  `git.resolveWorktree(base, requested)`，与 Git 面板自己的 `worktree` 参数同一把门：
  只接受该会话仓库 checkout 列表里的路径，非法值由既有的 `GitCommandError` 通道报
  400 `git-error`。`session.cwd` 顺带多返回一个 `pinned` 布尔（免费，不新增 spawn）。

### 3.2 客户端

- 根行的目录名就是触发器（`RootRow`），不再是一段死文本：右侧一个小尖角，固定时换成
  图钉。菜单**打开时才**取数据：`session.root` + `git.worktrees`（已挂载的 tab body
  是永久的，挂载期请求会乘以访问过的页签数）。选中项由 `session.root` 的 `pinned` 决定。
- `use-session-root.ts` 新增 `applyPinnedRoot(sessionId, root)`：宿主已接受写入，store
  立刻采用该值（并推进 generation，丢掉为旧根在飞的轮询答案），树因此在同一 tick 换根，
  不必等下一次 5 秒轮询。
- 词典 21 份新增三个键：`treeRoot` / `treeRootAuto` / `treeRootHint`（「不是仓库」复用
  既有 `notRepo`）。第三语言与 zh 的键集必须相等，`tests/locales.spec.ts` 与 locale chunk
  的类型检查同时守着。

## 4. 刻意不做

- **不与 Git 页共用 checkout 选择**：Git 页的 `worktree` 参数是**读**的窗口（diff /
  历史 / 状态），文件树的根是**视图**窗口，两者语义不同；共用会让「看一眼别的检出」
  意外换掉整棵树。两处各自显式，代价是切两次，收益是不会误改。
- **不做建议条**（「agent 正在 `<wt>` 工作 · 切换」）：那是推断降级为提示的第二步，
  与固定值互不依赖，可单独来。
- **不动 `sidebar_open` 的相对路径解析**（仍是 header cwd，见 #802 的合并讨论）：
  它属于 #956 那条基准链，与本功能混在一起会同时改两个语义。

## 5. 回归

- `tests/session-root.spec.ts`：固定的读写与撤销、LRU 上界（读一条会刷新其新近度）、
  目录消失即作废（含「路径变成文件」）。
- `tests/active-worktree.spec.ts`：固定优先于推断与环境变量覆盖；`ignorePin` 仍返回
  推断；清除后立刻回到推断；目录被删后回落到推断。
- `tests/smoke.spec.ts`：真实仓库 + linked worktree 上跑路由——固定后 `session.cwd` 与
  `fs.tree` 都跟着走，别家仓库的路径被拒且固定不变，`null` 清除后回到自动根。
- `tests/file-tree-root-picker.spec.tsx`：下拉列出 checkout（含变更数）、选择后写入宿主
  并经共享 store 立刻换根（树的根行改名 + 新根被列目录）、“自动”清除、被拒时进既有
  错误条、非仓库目录给出 `notRepo` 而不是空列表。
