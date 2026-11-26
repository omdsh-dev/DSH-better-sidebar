# Handoff：PR CI 列表化与紧凑预览（2026-11-10）

> 面向接手的新会话。只记录客观状态、证据路径与未完成项；设计规范、规则与历史见 `AGENTS.md`、`docs/host-contracts.md`、`docs/external-plugin-guide.md`、`docs/plans/2026-11-01-clues-uiux-foundation.md`，不在此复述。本文覆盖并取代 `docs/plans/2026-10-30-clues-rebase-and-feishu-auth-handoff.md`（那份是 rebase 前状态，已过期）。

## 1. 仓库、分支与提交

- 仓库：`/Users/menghuan/Code/DSH-better-sidebar`，分支 `feat/clues-uiux-refresh`。
- HEAD：`0cfac461`（`feat(clue): show the PR CI rollup in list rows`）。
- 相对 `origin/dev`（`275ee766`）**领先 12 个本地提交**；本地 `dev` 仍为 `d3bfcf62`，未被移动。
- 工作区**干净**（2026-11-10 实测 0 个已跟踪修改/未跟踪条目；本文写入后会多一个未提交的 docs 文件）。
- 版本：`0.31.0-alpha.6`（package.json / dsh.plugin.json / `SIDEBAR_SERVICE_VERSION` 三处一致）。
- **未 push、未开 PR、未合 dev/main、未发版**。3384 的插件产物与官方 DSH checkout 本任务未修改。
- 本任务产生的本地提交（由近到远）：
  - `0cfac461` PR 列表行显示 CI（列表查询带 `statusCheckRollup`）
  - `25a2a19a` 预览头部改为两行紧凑布局
  - `28b83b50` 修复 `normalizeClueResourceInfo` 丢弃 review/mergeable/checks
  - `242ecfd8` share export e2e 等待
  - `cdc72423` 来源状态按连接能力门禁
  - `29e3c3e2` 设置行/控件尺寸 + 首版 PR 状态
- 前一份 `2026-10-30` handoff 里的“未提交飞书修复”“170 提交 rebase”等状态已全部变化，不要按其执行。

## 2. 这轮完成的实质工作

### 2.1 列表与详情都能看到 CI

- `src/clues/sources/github/gh.ts`：`PULL_LIST_QUERY` 增加 `reviewDecision mergeable statusCheckRollup{state}`；`GithubListItem` 类型与 `listItemOf` 映射同步增加 `review/mergeable/checks`。列表项 `info` 现在直接带 CI 状态，**没有新增请求**。
- `src/clues/resource-info.ts`：宿主白名单保留 `review/mergeable/checks` 并做枚举校验。这是“详情一直看不到 CI”的根因——适配器早已返回，白名单静默丢弃。
- `src/client/clues/resource-summary.tsx`：详情头部改为两行：
  - 第一行：状态点 + 状态、短仓库#号、作者、`head → base`、`+/−`；
  - 第二行：一行 `CI 通过 · 已批准 · 可合并`（失败/冲突用 ink tone）。
  - 删掉状态胶囊、`检查/合并` 全宽行、`仓库/发起人/分支` 标签、assignee/follower/label/时间 chips、`详细信息` 折叠。
- `ResourceInlineMeta`（列表行）：一行显示 `状态点 + CI + #号 + 作者 + 分支`；PR 有 checks 才显示 CI，空 `statusCheckRollup` 不编造。
- 真实数据验证：`omdsh-dev/DSH-better-sidebar#1130` 有 3 个 check，显示 `CI 通过`；`#1147`、`#1115` 的 `statusCheckRollup` 为空，列表不显示 CI（符合预期）。

### 2.2 设置与飞书（前一轮，已在本分支）

- 来源设置行单行、开关/配置/下拉统一 28px；`SelectMenu` 根节点/触发器全宽。
- 飞书 docs 请求并集加入 `space:document:retrieve`；来源状态按 `connectionCapability` 门禁，缺能力时显示未授权而不是“就绪”。
- **注意**：`sidebar-test` profile 的 `cordis.patch.yml` 里当前 `clueSourcesEnabled.builtin.feishu.docs/tasks = false`，所以 3080 线索页只有 3 个来源标签。这是配置状态，不是注册丢失；要用飞书必须先在设置里打开两个开关，再点“开始授权”。不要未经用户同意改这个配置。

### 2.3 测试同步

- `tests/clues-resource-summary.spec.tsx` 重写为紧凑头部 + 一行事实 strip + 列表 CI。
- `tests/clues-resource-info.spec.ts` 新增白名单保留/拒绝。
- `tests/clues-github-gh.spec.ts` + `tests/fixtures/clues-github/pull-list.json` 断言列表查询/映射的 review/mergeable/checks。
- `tests/e2e/clues-resource-ux.e2e.ts`：pull fixture 带 checks/review/mergeable，断言列表 CI 与详情 CI；remove assignee/Comments 旧断言。
- `tests/e2e/clues-uiux.e2e.ts`：去掉“详细信息”展开；share export 先等列表加载；设置断点 560→420。

## 3. 验证证据（均已实际执行）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 全量单测 | **5106 passed / 18 skipped** | `.local/migrate-022-20261108/full-ci.log` |
| typecheck / lint | 通过 | `tc-a6.log`、`lint-ci.log` |
| build / pack | 通过 | `build-a6.log`、`pack-a6.log`；tarball `.local/migrate-022-20261108/candidate/dsh-better-sidebar-0.31.0-alpha.6.tgz` |
| 真实宿主 + Chromium 挂载 lane | **34 passed / 6 skipped** | `.local/migrate-022-20261108/mount-a14.log` |
| 3080 浏览器验证 | 挂载、5 个设置分组、4 个 chunk SHA 匹配、`pageErrors=[]`；sourceTabs=3（因飞书开关关闭） | `.local/migrate-022-20261108/browser-a11.log` |
| 3080 实例 | profile `sidebar-test`，安装 **0.31.0-alpha.6**；PM2 `dsh-sidebar-preview-3080` online，uptime 36h；HTTP 401（需登录） | `~/.dsh/profiles/sidebar-test/package.json`、`pm2 describe dsh-sidebar-preview-3080` |
| 3384 | 未被本任务修改；HTTP 401（桌面壳托管） | 当前 runtime context + curl |
| 截图 | 设置：`.local/migrate-022-20261108/settings-3080-zh.png`；PR 列表：`pr-list-repo-3080.png`；PR 详情：`pr-detail-repo-3080.png`；320 紧凑：`test-results/clues-resource-ux.e2e.ts-c-477ac-nches-in-one-compact-detail/pull-compact.png` | 直接查看 |

复跑命令（在仓库根目录）：

```bash
export PATH=/Users/menghuan/.nvm/versions/node/v24.16.0/bin:$PATH
pnpm typecheck && pnpm lint && pnpm build && pnpm pack --pack-destination .local/migrate-022-20261108/candidate
NODE_OPTIONS=--max-old-space-size=4096 pnpm exec vitest run --reporter=dot
TARBALL=.local/migrate-022-20261108/candidate/dsh-better-sidebar-0.31.0-alpha.6.tgz \
  DSH_CMD='npx -y --package @deepseek-ai/dsh@0.2.2-rc.1 dsh' pnpm test:mount
# 单条 e2e（脚本参数，不是 GREP_FILTER 环境变量）：
TARBALL=... DSH_CMD=... pnpm test:mount --grep "clues workbench stays usable"
# 3080 浏览器验证（需要 auth-state.json，可能已过期）：
node .local/migrate-022-20261108/verify-browser-3080-022.cjs
```

已知 flake：`clues-uiux` 的 append 探针在满载全量 lane 下偶发 `sentinelTop` 超界；隔离跑通过。不要在没有复现的情况下改代码；若复现，先重新 `scrollTop = scrollHeight` 并等一帧再加断言。

## 4. 当前环境与运行中实例

- 3080：`http://127.0.0.1:3080`，profile `sidebar-test`，PM2 `dsh-sidebar-preview-3080`，启动脚本 `.local/3080-preview/launch.sh`；已装 alpha.6。浏览器的登录态在 `.local/migrate-022-20261108/auth-state.json`（可能过期，不要提交）。
- 3384：`http://127.0.0.1:3384`（用户日常 GUI），本任务未改；如需安装新包/重启，先获得用户明确同意。
- 当前 DSH 实现 checkout 已变为 asar 包路径（runtime context），不要把它当成可改源码；挂载测试继续用 `npx @deepseek-ai/dsh@0.2.2-rc.1`。
- 3080 的线索工作区切换：会话默认在 `/Users/menghuan/Code/dsh-better-dsh`（无开放 PR）；要看本仓库 PR，点线索页顶部 workspace 选择器切到 `/Users/menghuan/Code/DSH-better-sidebar`，范围会变成 `omdsh-dev/DSH-better-sidebar`。
- 旧列表/详情缓存可能不带新字段：刷新页面，再点 PR 源范围栏的刷新；或重新打开详情。

## 5. 未验证 / 风险 / 待决策

- **飞书真实 OAuth 未闭环**：`space:document:retrieve` 已加入请求并集与能力组，但现有 token 仍缺它；3080 上飞书来源还是关闭状态。需要用户打开开关并完成一次设备码授权，才能验证 docs 列表/读取。不要自动化或伪造这一步。
- **PR 列表只显示 CI**：review/mergeable 只在详情显示；列表行没有 review/冲突标记。若用户要求列表也显示全部 PR 事实，再扩展（同一列表查询已经带字段，只改 UI）。
- **空 checks 的 PR 不显示 CI**（如 #1147）；如果用户想要“无 CI”占位，需要新增文案/状态，当前未做。
- **紧凑头部有意省略** assignees/followers/labels/created/updated；文件保留 path/size，任务保留 due。若用户要求恢复某个字段，按“只加回最有用的一项”处理。
- 3080 的 `auth-state.json` 可能过期；验证脚本失败时先重新登录，不要改测试绕过。
- 尚未获得 **push / 开 PR / 合 dev / 发版** 授权；当前 12 个本地提交只在 feature 分支。

## 6. 建议下一步

1. 等用户对 alpha.6 的视觉/CI 结果给反馈；**不要自行扩大范围**。
2. 若继续 UI：先用 `uiux-design`，对照 `pr-list-repo-3080.png`、`pr-detail-repo-3080.png`、`pull-compact.png` 检查两行契约、320 换行、深浅主题。
3. 若继续飞书：让用户打开两个来源开关 → 点“开始授权” → 确认 docs 列表和读取；只记录真实结果。
4. 若准备合并：先 `code-review`（Standards + Spec，范围 `origin/dev..HEAD`），跑完整门禁，再按仓库分支模型合入 `dev`；push/合并前确认用户授权。

## 7. 建议技能

- `uiux-design`：继续打磨紧凑头部/列表和深浅主题时先读。
- `diagnosing-bugs`：飞书 OAuth/scope、列表缓存类问题按红绿循环定位。
- `code-review`：决定合并/开 PR 前做双轴审查。
- `tdd`：若给列表补 review/merge 或“无 CI”占位，先写失败用例。

## 8. 本轮后续（2026-11-11，alpha.7）：GitHub 手机版式收敛 + CI 徽章

用户对 alpha.6 的反馈（附 GitHub 手机版截图）："PR 信息（CI 等）与整个预览卡片很繁杂很丑，和 DSH 原生 UIUX 一点也不贴合"，并要求"CI 也要更为可视化地显示"。本轮据此重做，决策与实现如下。

### 已确认的决策

| 项 | 结论 |
| --- | --- |
| 详情栏带 | 压到 3 条：标题栏 / 一行身份+事实+动作 / 预览·编辑页签（原来缓存戳独占一行，整行删除） |
| 详情身份字段 | 状态点 · #号 · 作者 · +N −M；**分支移到第二行末尾**（等宽小字，悬停看全量） |
| 列表行 | 状态点（词进 aria-label/tooltip）· #号 · 作者 · CI 徽章；**不显示分支、不显示仓库名** |
| CI 视觉 | 宿主 `Tag` 胶囊：勾/叉/转圈图标 + 短词 + state-* 浅底；一屏仍只有这一个实心色块 |
| 检查条数 | **不做**。GraphQL 只归一化 rollup 聚合态，要"3/3 通过"必须扩 `contexts` 查询、白名单、类型与 fixture，本次按 KISS 放弃 |
| 范围 | 所有来源统一改（文件 / 飞书任务·文档 / GitHub issue·PR 共用组件） |

### 实现要点

- `src/client/clues/resource-summary.tsx`：新增 `ChecksBadge`（唯一的 CI 视觉，详情与列表共用）、`inkFacts()`（review/mergeable 纯墨色文字）、`changeCounts()`；`ResourceSummary` 新增 `actions` 动作位并允许"无元数据也渲染动作位"；`ResourceInlineMeta` 去掉分支、状态词改 `aria-label`。`numberLabel` 不再拼 `repo#n`。
- `src/client/clues/resource-summary.module.css`：新增 `.checksBadge`/`.checksTag`/`.actions`/`.branch`；删 `.factLabel`/`.factText`/`.fact`/`.inlineBranch`。
- `src/client/clues/windows/detail.tsx`：`toolbar()` → `headerActions()`，缓存时间进刷新按钮 `title`，`data-clue-detail-cached` 仍在按钮上；`handle.update()` 不再传 `actions`，窗口因此不再渲染 `[data-window-toolbar]` 行。
- `detail.module.css`：删 `.toolbar`/`.cacheStamp` 及其 `@container` 规则，新增 `.headerActions`/`.sourceLink`。
- 测试同步：`clues-resource-summary`（重写）、`clues-pack-windows`（只读用例改从头部动作位取链接）、`clues-resource-ux`、`clues-uiux`（断言无 toolbar 行、cached 在刷新按钮 title 上、徽章 aria-label）。
- 版本：0.31.0-alpha.6 → **alpha.7**（三处齐）。

### 证据

- 全量单测：911 文件 / 5111 passed（18 skipped）。
- 线索挂载 lane：9 passed（含 `clues-resource-ux`、`clues-uiux`）。
- 真实数据截图（3080，装 alpha.7 后，`auth-state.json` 登录态）：`.local/ui-badge-20261111/` 下 `list-light.png`、`list-dark.png`、`detail-light.png`、`detail-dark.png`、`detail-ci-light.png`、`detail-ci-dark.png`、`detail-narrow.png`（320×420），验证脚本 `verify.cjs`，结果 `verify.json`。
  - `#1176`（无 CI）：头部 50px / 两行；文本 `进行中 | #1176 | 王面 | +353 −2 | 可合并 | feat/close-window-button → dev | 打开原始来源`。
  - `#1130`（CI 通过）：`进行中 | #1130 | iasi | ✓通过 | 可合并 | feat/repo-repository-dropdown → dev`，header 53px。
  - `pageErrors=[]`。
- 3080 已装 alpha.7（PM2 `dsh-sidebar-preview-3080` 重启 1 次）；3384 未动。

### 仍未做 / 下一步

- "3/3 检查通过"这类条数需要扩数据面（`PULL_LIST_QUERY`/`PULL_READ_QUERY` 的 `statusCheckRollup{contexts{...}}` + `checksOf` + 白名单 + 类型 + fixture），已明确本次不做。
- 列表行不显示分支是刻意取舍；若要恢复，改 `ResourceInlineMeta` 一处即可。
- 尚未 push / 开 PR / 合 dev；当前分支 `feat/clues-uiux-refresh`。


### 第二轮（2026-11-12，alpha.8–alpha.11）：配色与原生对齐

用户反馈"配色和 UIUX 看起来非常不协调"，并允许大规模重构。根因不是颜色数量，而是三件事：

1. **填色胶囊**：用了 `Tag` 的 success/danger/warning tone（10–12% 浅底 + 彩色文字）。DSH 原生**从不**给状态填色底；语义色只出现在 6px 状态点或标签文字上。
2. **层级倒置**：第一行身份是灰字，第二行却是绿胶囊 + 绿字，次要信息比主要信息更响。
3. **永久转圈**：`open`/`active` 映射到宿主 `StateDot ongoing`（1.5s 无限旋转），列表里每行都在转。原生只对真实进行中的操作转圈。

改法（`src/client/clues/resource-summary.tsx` 与 `.module.css` 重写）：

- CI 用 `StateDot`（10px：done/error/ongoing/idle），文字保持墨色档位，**零填色**；
- 只有**会挡下一步**的事实把文字转 error 墨色（CI 失败、changes-requested、冲突）；健康的 PR 完全无彩色；
- **默认态静默**：`进行中`、`可合并`、`待评审`、GitHub 的瞬时 `未知` 一律不渲染；
- **静止状态不转圈**：只有真正在跑的 CI rollup 用 ongoing；
- **列表行**：状态点只在偏离常态时出现；CI 通过只留绿点、不写"通过"二字（实测 25 行里 17 行无 CI，这个点是区分"通过/无 CI"的唯一标记），失败与待定才补文字。

实测数据（`/tmp/dist.cjs`，真实仓库 PR 列表 25 行）：`none:17, success:8`，无 failure/pending。

真实截图（3080，装 alpha.11）：`.local/ui-badge-20261111/` 下 `list-light.png`、`list-dark.png`、`detail-ci-light.png`、`detail-ci-dark.png`、`detail-narrow.png`。头部文本示例：`#1176 | 王面 | +353 −2 | 冲突 | feat/close-window-button → dev`（51px）、`#1130 | iasi | 通过 | 冲突 | feat/repo-repository-dropdown → dev`（52px）。

**踩到的坑（重要）**：`pnpm install` 在版本号未变时命中缓存，不会重装同版本 tarball，导致 3080 长时间显示旧 UI 而误判为"改动没生效"。以后每次 pack 后**必须升版本号**再 install；或删 `node_modules/.pnpm/*dsh-better-sidebar*` 后重装。

新增稳定定位点：pack 成员行 `data-clue-pack-member="<clueId>"`（`pack.tsx`），因为 `active`/进行中 不再渲染状态词，测试不能借状态定位行。


## 9. 与最新 dev 的整合（2026-11-13，v0.33.0）

用户要求把这条分支 rebase 到最新 dev。实际执行时发现三件事，记录如下。

### 事实：本地 dev 不是"最新 dev"

- 本地 `dev` 停在 2026-10-18（`d3bfcf62`），有 183 个提交不在 `origin/dev`（旧的本地整合提交，已被上游以别的形式吸收）。
- 真正的"最新 dev"是 `origin/dev`（2026-11-13，已发到 **v0.32.1**，含 DSH 0.2.2-rc.2 适配）。
- 这条分支相对 `origin/dev` 只有 **14 个提交**（用 `git rev-list --count origin/dev..HEAD` 判断，不要用本地 dev）。

### 采用的方式：压缩为单个提交落到 origin/dev（未 push）

- 备份：`backup/clues-uiux-refresh-pre-rebase` = 整合前的 `bbc97354`；原分支 `feat/clues-uiux-refresh` 未改动。
- 工作分支：`rebase/clues-uiux`（基于 `origin/dev`）。
- 方法：`git switch -c rebase/clues-uiux origin/dev && git merge --squash backup/clues-uiux-refresh-pre-rebase`，一次解决全部冲突。
- **为什么不用逐提交 rebase**：14 个提交每个都与上游重叠 5–56 个文件（版本号、19 个词典、CHANGELOG 会重复冲突十几次），且中间提交在 rc.2 的菜单 API 下必然编译不过（`getAnchorRect` 已换成 `anchorPoint`）。逐条重放会得到一串坏提交。
- 若要保留 14 个提交的粒度，可用备份 ref 重来（rerere 已开启，重复冲突会自动复用解法）。

### 冲突处理规则（下次同样适用）

- **19 个词典 + `locales.ts`**：上游新增 guide 键、本分支新增 clue 键，两边都保留。用 `git merge-file --union ours base mine` 一次性合并，再用脚本校验「zh 与 en 键集相同、19 个词典与 zh 完全一致、无重复键」（本次：各 1211 键，全通过）。本分支唯一删除的 `settingsTabsTitle` 上游仍在使用，union 会保留它，这是对的。
- **`SideCardSection.tsx`**：真正的结构性冲突——上游新增「开始页接管」设置组（`guideCatalog`/`GuideOrderList`/`GuideRowsInput`），本分支把设置区重构成分组导航并新增「线索来源」组。以本分支结构为底、把开始页功能移植进去（由子代理完成，人工复核）。新增第六个组 `startPage`，顺序为 常规 / 标签页 / 开始页 / 文件预览 / 线索来源 / 外观。
- **其余共享文件优先取上游**（`dock-fallback`、`DiffRows`、`SideChatView`、`TerminalView`、`SideCardSection.module.css` 等），但**必须把本分支自己测试依赖的改动并回去**，否则会出现「代码取上游、测试还是本分支」的断裂。本次实际踩到 4 处：
  - `DiffRows` 的 token key 偏移（重复 React key 修复）；
  - `dock-fallback` 的 32px 按钮 + 触控 44px 目标（叠加在上游的零矩形修复之上）；
  - `SideChatView` / `TerminalView` 的 `data-sidebar-surface` 标记（`global-uiux` e2e 依赖）；
  - `SelectMenu`（本分支新建的文件，上游没有）迁移到 `anchorPoint`，并改成**仅在打开时挂载宿主菜单**——rc.2 的 `Menu` 在渲染期访问 `document`，常驻挂载会让 SSR 的设置页渲染直接抛 `document is not defined`。

### rc.2 API 迁移

- 三处线索菜单（`tab/packs.tsx`、`tab/browser.tsx`、`windows/pack.tsx`）与 `ui/SelectMenu.tsx` 从 `getAnchorRect` 改为 `anchorPoint={{x,y}}`。
- 子菜单翻转的 workaround 由上游删除（宿主自己定位），`tests/layout-css.spec.ts` 的旧用例改成守护「不再自己放置子菜单」。

### 版本与 changelog

- 版本：0.31.0-alpha.11 → **0.33.0**（三处齐）。dev 已发 0.32.1，不能沿用 0.31 的 alpha 号。
- CHANGELOG 顶部新增 `### 未发布`（中英各一段），描述整条线索功能线 + 本轮 PR 头部/状态词汇改造。**没有**直接搬运分支旧的 `未发布` 段落——那段里混着上游已发布（v0.30/0.31/0.32）的条目，搬过来会重复。
- `package.json` 补回上游没有的三样：`exports["./clues"]`、`files` 里的 `lib/clues.js`、依赖 `uqr 0.1.3`。

### 环境注意

- `node_modules` 需要按新 lockfile 重装（rc.1 → **rc.2**），否则 `anchorPoint` 不存在、类型检查会误导。装完 `@deepseek-ai/dsh-client-ui-primitives` 应为 0.2.2-rc.2。
- `test:mount` 的 `DSH_CMD` 基线已随上游抬到 `@deepseek-ai/dsh@0.2.2-rc.2`。
- 本次遇到 npm 的 npx 缓存目录损坏（`~/.npm/_npx/<hash>/package.json` 缺失，`mount=254`）：删掉那一个 hash 目录后重跑即可。

