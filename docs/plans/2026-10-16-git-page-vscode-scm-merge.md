# Git 页面合并车：以 #944 为基底、融合 #969 图谱（11 个 PR）

> 批次：2026-10-16，`dev` 分支。贡献者：@hairyf（#939 / #940 / #944）、@vlln（#968 / #969）、
> @wang-kaopu（#885 / #886 / #921）、@UNscientific-9（#909）、@iasiv5（#607）、
> @yanzhaohui1999（#827）。**维护者本地 `--no-ff` 合并**，每批解冲突后跑门禁再推 `dev`。

## 决策

1. **基底 = #944**（VS Code Source Control 结构替换「Git 视角」内容区），**融合 #969 的特性**。
2. **只保留一套图谱**：图谱落在 Git 镜头内的「提交图」区，引擎用 #969 的专用有界路由
   （`git.graph`）；**不新增第三个镜头**，`changesGraphLens` 键从未上线。
   理由：两块地都画同一份历史＝重复 IA；#969 的引擎有界、有 135 + 282 + 509 行测试与一条 e2e。
3. **剔除 #944 的夹带**：`.agents/skills/handle/SKILL.md`（个人 skill）、`eslint.config.js` /
   `vitest.config.ts` 的 `sorce/vscode` 忽略项、以及 `webRuntime → connection.requestRejection`
   的栅栏改写与 `ownEntryId` 放宽——栅栏归属留给 DSH 0.2.1 兼容批（#970 / #932 / #905 / #943）。
   本批 `src/index.ts`、`src/context-types.ts` 一行未动。

## 融合后的结构

| 面 | 来源 | 说明 |
|---|---|---|
| Git 镜头（Changes / Graph 两组 + 底栏） | #944 | 组内动作、Message + Generate、Pull/Push、分支与 worktree 选择 |
| 提交图区（`GitGraphSection`） | #969（改名自 `GitGraphLens`） | 有界 `git.graph` 分页、分支筛选、泳道与引用徽章、hover 卡片、行右键接回 #944 的提交菜单 |
| 底部面板三签 `提交详情 / 内容 / 差异` | #969 | 面板是**一个共享区域**：镜头切换不清空它 |
| 镜片切换器（官方下划线 Tabs） | #939 | Git / 本轮文件两个镜头 |
| 本轮文件平铺行 | #940 | 一行一条、按时间倒序 |
| 状态读数（porcelain v2 + 分侧计数） | #944 + #909 | 一次读回 branch/upstream/ahead-behind/detached/operation |

## 与两个 PR 原始实现的有意偏差

- **第三个镜头未上线**（见决策 2）：`GitGraphLens` → `GitGraphSection`，由 Git 镜头挂在
  Graph 区；它不再自持仓库 / worktree 选择器，目标读镜头自己的选择。
- **#944 的内联图退场**：`src/client/changes/GitGraph.tsx` 删除，随之无消费者的
  `changes.module.css` 日志行样式与 `historyLoadError` / `changesNoHistory` 词典键一并删除；
  `git.log` 路由保留（见「未做」）。
- **#944 的 `log(--all --topo-order %P)` 与 `GitLogEntry.parents` 保留**：`git.log` 仍是
  可用且有测试的历史路由（本批不动 wire 契约），图谱自己走 `git.graph`。
- **两条镜头常驻**：切镜头只切 `hidden`，不卸载——Graph 的滚动与选中、Changes 的展开与草稿
  切走不丢（与宿主 `keepMounted` 同策）。配套两件事：`hidden` 的槽位仍**保留**（不轮询，
  槽位不被回收，切回不闪 loading），以及**非静默刷新**（手动刷新 / checkout / 暂存提交）
  会同步抬图谱的 tick。

## 守住的不变量（AGENTS §5）

- **只有一个 git 状态轮询器**（`src/client/ui/git-status.ts`）：本批没有新增第二个；
  Graph 区不持有定时器（可见性 / 筛选 / 刷新 / 翻页才是请求触发点）。
- **可见性门控**：镜头在屏才跑轮询；隐藏时只保留槽位与最后一次答案。
- **有界缓存**：图谱分页有显式上限（每页 200 / 偏移 10 000 / 分支 1 000），超限报错不静默截断。
- **皮肤契约**：图谱五种色槽全部走状态色令牌（`tests/theme.spec.ts` 守护）。

## 未做（后续候选）

- **`git.log` 路由与 `api.gitLog` 已无生产消费者**（唯一消费者是内联图，随本批删除）：
  保留是为了不动 wire 契约与它的既有测试；下次清理窗口可以连同 `GitLogEntry.parents` 一起删。
- 图谱不显示 tag 标签、不含任何修改历史的操作（checkout / fetch / rebase），分页是「对钉住
  tip 的偏移重走」而非 keyset 分页（#969 的原始取舍，未改）。
- DSH 0.2.1 栅栏兼容（#970 / #932 / #905 / #943）与本批正交，`context-types.ts` 保持 dev 现状。

## 门禁与验证

- 本地：`pnpm typecheck` / `pnpm lint` / `pnpm test`（唯一红是文件沙箱拒绝 `$HOME` 写入的
  `smoke` 用例）/ `pnpm build && pnpm pack` / `pnpm check:consumer-types`。
- CI：每一批推送都等 `ci` / `ci-windows` / `plugin-mount` 三绿；`plugin-mount` 跑真实挂载
  （含本批新增的 `tests/e2e/git-graph.e2e.ts`：真机建带合并的仓库、渲染历史、点开提交详情、
  按分支筛选，并断言读图前后 HEAD / refs / status 逐字不变）。
- **本地挂载入口**：桌面 `dsh` shim 会覆盖 `DSH_HOME`，导致 scratch 测试误用真实 profile；
  测试改用不覆盖 `DSH_HOME` 的 CLI wrapper 后可以在独立 scratch profile 运行。
  本机完整 lane 的终端测试仍受 PTY 沙箱限制（`posix_openpt: Operation not permitted`），
  不削弱该断言，完整通过结果以 CI 的 `plugin-mount` 为准。

## 过程中发现并修掉的三处 CI 红

1. **#607 的发现根拼法**（`ci-windows` 上 5 条 `git.spec.ts` 红）：BFS 用 dirent 名 join，而
   `rev-parse --show-toplevel` 报的是 realpath + 正斜杠——同一个检出出现两种拼法。发现根现在
   走 `realpath` +（仅 Windows）分隔符折叠。
2. **#909 落地后暴露的夹具口径**：`tests/unbounded-caches.spec.ts` 以 `afterSeq === 0` 认基线，
   而 #885 之后基线是「不传游标」（0 会丢掉 seq 0 的真实事件）；断言改为 `undefined`，并补
   `wait` 参数契约。
3. **`tests/e2e-aggregate-auth.spec.ts` 的过宽正则**（Windows 上偶发红）：`/-[^-\s]*L/` 在整行里
   匹配到了 mkdtemp 后缀（`dsh-aggregate-auth-6mLM51`）。改为只查 **flag token**。

## 选中行错位回归

- **触发条件**：在 Git 更改组中点击文件打开差异。只检查未选中的初始截图不能发现此问题。
- **根因**：整合 #969 时删除 `.logRow` 规则，连同它与 `.row` / `.opRow` 共用的声明块一起删掉，
  留下逗号结尾的选择器。CSS 将这些选择器与后面的 `.guide` 合并，选中文件行因此收到
  `position: absolute; top: 0; bottom: 0; width: 0; border-left: ...`，脱离分组并绘制异常长边框。
  此问题来自维护者整合提交 `88ded478`，不是贡献者原 PR 的行为。
- **证据**：真实挂载复现中，未暂存行点击前高 28px、位于 y=351..379；点击后高 862px、
  位于 y=38..900，超出分组 y=239..353。恢复声明后，同一点击前后行高和坐标保持一致。
- **修复**：只恢复两类现役行的选中背景与 `::before` 标记声明，不改变图谱尺寸、滚动结构或数据逻辑。
- **回归门禁**：`tests/theme.spec.ts` 解析真实 CSS 规则，覆盖 `.row` 与 `.opRow`，最小复现先红后绿；
  真实挂载测试覆盖冲突、暂存、未暂存、未跟踪文件及选中后的分组边界。临时几何探针不随代码提交。
