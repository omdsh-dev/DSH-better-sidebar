# worktree 根选择与地址基准（#947 / #950 / #952）

> 一次修掉三条同源 issue：都在「会话 header cwd 是主检出、agent 在 linked git worktree 里干活」时出现，
> 由同一段代码的两个方向造成——**根选择判定过宽**（#952），以及**地址基准与读取基准不一致**（#947 / #950）。
> 分支 `fix/worktree-root-address-base`，两条 commit：判定（#952）、基准（#947 #950）。

## 1. 三个症状

| # | 触发 | 症状 | 失败模式 |
|---|---|---|---|
| #947 | 聊天链接/改动页打开 worktree 内文件 | 路径被二次拼接 → `cannot read "…/wt/frontend/.worktrees/wt/CLAUDE.md": ENOENT` | 响亮 |
| #950 | 同一相对路径经不同入口 | 两个检出的同名文件，两次都成功、无提示 | **静默**，且可保存写回 |
| #952 | 工作区**内部**嵌套仓库的 linked worktree | explorer 被静默重定根到那个子目录，兄弟目录全消失（报告者离线重放 27 个真实会话，20 个中招） | **静默** |

三者的共同前提：`git worktree add <repo>/frontend/.worktrees/wt` 这类**工作区内部**的 linked worktree 是常态（DSH 自己的约定就是 `.worktrees/`），而容器工作区里还有「bare 仓库 + 它的 main/local 检出」这种普通内容。

## 2. 根因

**2.1 地址的基准是会话 header cwd，宿主两端一致。** 宿主构造端 `ui-chat` 的 `openFile` 用
`fileAddressFor(sessionId, ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd, path)`，解析端 `api-workspace-files` 的
`resolve()` 用 `sessions.get(sessionId).header.cwd`——同一个值，所以宿主自洽。地址里的相对路径**只在那个基准下成立**。

**2.2 插件读的一端换成了活动 worktree 根。** #802 让插件的 fs 路由（`activeWorktreeRootOf`）与原生 tab 体
（`useSessionRoot`）跟随活动 worktree，于是同一会话有两个基准。地址里 header 相对的拼写（`frontend/.worktrees/wt/a.md`）
被活动根**再拼一次**：

```
/repo                                        ← header cwd（宿主构造地址用）
/repo/frontend/.worktrees/wt                 ← 活动根（插件读文件用）
地址 path: frontend/.worktrees/wt/a.md       ← 被 header cwd 剥过前缀
插件解析:  /repo/frontend/.worktrees/wt/frontend/.worktrees/wt/a.md  → ENOENT
```

只在「worktree 嵌在 header cwd 之下」时翻倍；**工作区外**的 worktree 其地址保留绝对路径，所以不翻倍——这正是 #802 的跨仓库场景没暴露问题的原因。

**2.3 同一插件里还有第三、第四个基准。** `openSidebarFile` 用冻结的 `summary?.cwd`（header），
`service.openTab` → `surface.fileAddress` 用调用方手上的 `scope?.cwd`（多数是活动根）；于是同一个文件可能拿到**两个地址**
（页签不合并），同一相对路径在不同入口落到不同检出。**相对路径不携带基准信息，跨边界时必须还原成绝对路径。**

**2.4 根选择判定只看拓扑。** `activeRootFromEvents` 判据是「`top ≠ base` 且 `--absolute-git-dir ≠ --git-common-dir`（linked worktree）」，
不区分「会话搬到别的检出」与「工作区里本来就有另一个仓库的 worktree」。裸仓库的 `main`/`local`、容器工作区里的子项目 worktree
都会被采纳，explorer 随即被重定根到一个子目录。

## 3. 口径决策（A / B）

| 口径 | 含义 | #952 | #947/#950 | #802（工作区内 `.worktrees/` 跟随） |
|---|---|---|---|---|
| A | 工作区内的 linked worktree 一律不采纳 | 修好 | **顺带消失**（in-workspace 两基准合一） | **失效** |
| **B（采纳）** | 工作区**外** 或与 base **同一 `--git-common-dir`** 才采纳 | 修好 | 仍需修基准 | 保留 |

选 B：`.worktrees/<branch>` 是 DSH 自己的约定，#947 报告者的三个建议修法里有两个假设它继续跟随；
而「嵌套仓库的 worktree」是工作区普通内容，不该抢根。判据用 `--git-common-dir` 相等 —— 同一个仓库的所有检出共享它，
submodule（`gitDir == commonDir`）本来就被排除，与插件既有判据同源。

**实测真值表**（`tests/active-worktree.spec.ts`，真 `git worktree`）：

| 布局 | 现状（修前） | 口径 A | 口径 B（本实现） |
|---|---|---|---|
| `W/nested/wt`（嵌套仓库的 worktree） | 抢根 ❌ | 不抢 ✅ | 不抢 ✅ |
| `W/paper_downloader/main`（嵌套 bare 仓库的检出） | 抢根 ❌ | 不抢 ✅ | 不抢 ✅ |
| `<repo>/frontend/.worktrees/wt`（同仓库、工作区内） | 跟随 | **不跟随** ⚠️ | 跟随 ✅ |
| `<tmp>/outside-wt`（工作区外） | 跟随 ✅ | 跟随 ✅ | 跟随 ✅ |
| 跨仓库、工作区外（#802 的原始场景） | 跟随 ✅ | 跟随 ✅ | 跟随 ✅ |

## 4. 实施

### 4.1 判定（commit 1，`src/active-worktree.ts`）

- 新增 `gitIdentityOf(dir)`：`git rev-parse --absolute-git-dir --git-common-dir` → `{ gitDir, commonDir }`，进程级缓存；
  common dir 的相对拼写（主检出返回 `.git`）按**被探测目录**归一化。
- `isLinkedWorktree` 改走该身份（`gitDir ≠ commonDir`），`isAdoptableTop(top, base)` 在其上加仓库身份比较：
  工作区外一律采纳；工作区内只有 `commonDir` 与 base 相等才采纳；`pathKeyOf(base) === ''`（文件系统根）时跳过该判定，
  免得整条跟随功能被关掉。
- `activeRootFromEvents` 的候选取舍从 `isLinkedWorktree` 换成 `isAdoptableTop`。

### 4.2 基准（commit 2）

- 新增 `src/client/address-base.ts` 的 `addressBaseOf(ctx, sessionId)`：会话列表里的 header cwd（宿主地址契约的基准），
  取不到就返回 `undefined` 让调用方回退。
- **消费边界**：`fileParamsOf(info, base?)` 在切 `path:line` 规格**之前**把地址路径解析成绝对路径；
  `native/index.ts` 的 editor 类型注入 `paramsOf: (info) => fileParamsOf(info, addressBaseOf(ctx, fileSessionIdOf(info)))`。
  下游（viewer 的 `fs.read`、编辑器、目录 watch）只见绝对路径，活动根再无法重定基。
- **构造边界**：`native/surface.ts` 的 `fileAddress` 与 `sidebar-file.ts` 的 `openClaimedNativeFile` 都用 `addressBaseOf` 优先，
  调用方给的 cwd 只作为回退 —— 同一文件因此只有一个地址（与宿主聊天路径的地址一致，页签照旧合并）。
- **意图侧**：`openSidebarFile(ctx, sessionId, path, { line?, cwd? })` 的 `cwd` 是调用方的**活**根
  （`EditorHost` / 改动页 / markdown 面板都传 `useSessionRoot` 的结果），相对路径按它解析，缺省才回退 header cwd。
  文件树、编辑器路径输入框本来就走活根，改后各处一致（#950）。

## 5. 实测与回归

复现（真 `git worktree` + 真函数，修前全绿复现、修后钉住）：

- `.scratch/repro-947.spec.ts`：宿主地址构造 → 插件解析 → 路由/原生 tab 体；含真实 `/sidebar/api/fs.read` 的
  `ENOENT … .worktrees/947-click-demo/.worktrees/947-click-demo/IN-WORKTREE.md`。
- `.scratch/repro-952.spec.ts`：三种布局 × 三种口径的真值表。
- 真机点击验证（本机 3080 + 真 worktree 会话）：绝对路径链接 → 翻倍 ENOENT；相对链接 → 打到 worktree 根；
  `[README.md](README.md)` → 静默打开 worktree 的副本（首行标记可辨）；文件树里的同名文件正常打开。

正式用例：

- `tests/active-worktree.spec.ts`：新增 4 例（嵌套普通仓库不采纳、嵌套 bare 仓库不采纳、同仓库工作区内仍采纳、工作区外仍采纳），
  既有 3 例（跨仓库采纳、无证据保持 cwd、真实路径探测）逐字未改。
- `tests/worktree-address.spec.ts`（新）：`addressBaseOf` 的三态；地址路径解析成绝对路径后任何基都不能重定基；
  地址构造/`surface.fileAddress` 一律用会话基准；相对路径按活根解析、缺省回退 header cwd。
- `tests/file-open-claim.spec.ts`：`openSidebarFile` 的 `line` 从位置参数改为 `{ line }`（唯一签名变更点）。

## 6. 残留与后续

- **裸相对路径的聊天链接**：worktree 会话里一条 `[x](docs/README.md)` 由宿主按 header cwd 构造并解析 → 打主检出的同名文件。
  宿主两端一致，插件无法在不猜的前提下区分「agent 指的是 worktree」。本版不做启发式（绝对路径修复后不再有 ENOENT 与
  静默重定基），若要可见性，后续可在页签标题/提示里显示解析后的绝对路径；根因属上游 worktree 无感的聊天漏斗。
- **`DSH_SIDEBAR_WORKTREE_ROOT`** 仍是全局硬覆盖（应急用），不受本次改动影响。
- 工作区是文件系统根、或 base 不在任何仓库里的会话：工作区内的候选一律不采纳（与 B 的「同一仓库才算搬家」一致），
  工作区外的照旧采纳。
