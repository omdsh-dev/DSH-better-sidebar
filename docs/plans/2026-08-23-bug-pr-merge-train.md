# Bug PR 一次性合并方案（merge train + 并行 subagent）

> 仓库：`omdsh-dev/DSH-better-sidebar`（本地 clone：`D:\Projects\deepseek-harness\DSH-better-sidebar`）
> 基准：main `d6d8db0` (= 0.15.2 + #339 locale ja)
> 目标：把 12 个 bug PR 一次性合入 main，**保留每个原作者的贡献归属**
> 输入：`bug-pr-review.md` 中 12 个 NOT_FIXED PR
> 日期：2026-08-23

---

## 0. 设计原则

| 原则 | 说明 |
|---|---|
| 保留作者归属 | 用 `git merge --no-ff`（**不 squash**），每个 PR 的原始 commits 全部进 main 历史；GitHub 通过 commit author email 匹配到 12 位作者 |
| 跨平台 commit trailer | #285 作者邮箱 `fix@local.invalid` 不匹配 GitHub → 在 merge commit message 加 `Co-authored-by: xxxg0001 <xxxg0001@users.noreply.github.com>` |
| 零源码 patch | train 分支所有改动都来自 PR 本身或冲突解决；**不修改任何 PR 的 commits** |
| 并行加速 | 4 个 subagent 各自 worktree 独立合并簇内 PR；跨簇冲突由主 agent 串行解决 |
| 每步验证 | 每个 subagent 完成簇内合并后跑 `pnpm typecheck`；主 agent 跨簇合并后跑 `pnpm typecheck && pnpm test` |

---

## 1. PR 清单与作者

| PR | 标题 | 作者 | author email |
|---|---|---|---|
| #345 | 限制文件 API 访问会话工作区 | wang-kaopu | 1970138194@qq.com |
| #342 | 搜索跳过 node_modules 等噪声目录 | sunrain520 | sunrain520@users.noreply.github.com |
| #341 | mermaid 抑制全局错误渲染 | duyiliu | 278950578@qq.com |
| #338 | 移除公开版 cordis peer，迁移类型基底 | Menghuan1918 | menghuan2003@outlook.com |
| #336 | tsdown 配置加载缺 unrun devDependency | MilchstraBe-Endless10 | milchstrasse.endless10@users.noreply.github.com |
| #330 | panel host 降到 DSH dynamic-plugin 层下 | ZgblKylin | 13114351+ZgblKylin@users.noreply.github.com |
| #326 | 支持选择子 git 仓库 | loeanxi | 2012065136@qq.com |
| #310 | layout push 下保 composer 在视口内 | Zzy-min | zzy19812007@gmail.com |
| #292 | markdown 预览本地/相对路径图片 | huzilin | huzilinha@gmail.com |
| #285 | linked worktrees 移植到 RC8 | xxxg0001 | fix@local.invalid ⚠ |
| #278 | 面板宿主裁剪视口、收起面板不再撑出双向滚动 | ch3n4y | ch3n4y@gmail.com |
| #254 | mobile 说明不可用侧边栏并防溢出 | SparkElf | laoyh@chinatelecom.cn |

⚠ #285 author email 不匹配 GitHub 账号，需在 merge commit 加 `Co-authored-by` trailer 补 credit。

---

## 2. 文件冲突矩阵（跨簇）

> 仅列出被 ≥2 个 PR 修改、且**跨簇**的文件。簇内冲突由 subagent 解决。

| 文件 | 涉及 PR（按簇） |
|---|---|
| `README.md` / `README_EN.md` | A: #338 #345；B: #292；C: #254 |
| `AGENTS.md` | A: #338；B: #342；C: #330 |
| `docs/external-plugin-guide.md` | A: #338 #345（簇内解决） |
| `package.json` | A: #338 #336；C: #254；D: #326 |
| `dsh.plugin.json` | A: #338；C: #254 |
| `src/index.ts` | A: #338 #345；D: #285 #326 |
| `src/client/sidebar.module.css` | C: #330 #278 #254（簇内解决）；D: #285 |
| `src/client/Sidebar.tsx` | B: #310；C: #254 |
| `src/client/service.ts` | A: #338；C: #254 |
| `src/client/DiffTab.tsx` / `GitView.tsx` / `api.ts` / `state.ts` / `src/git.ts` | D: #285 #326（簇内解决） |

---

## 3. 分簇（簇内串行，跨簇并行）

### Cluster A — 基础设施（package.json / cordis / path security）

**分支**：`train/base`
**worktree**：`D:\Projects\deepseek-harness\dsb-train-base`
**合并顺序**：
1. `#338` (cordis peer 迁移) — 改 package.json/dsh.plugin.json/src/index.ts/service.ts/AGENTS.md/README/docs
2. `#336` (unrun devDep) — 只改 package.json
3. `#345` (path security) — 改 README/docs/src/index.ts/fs-operations/html-route/path-security 新增

**簇内冲突点**：
- #336 vs #338：package.json（#338 移除 cordis peer，#336 加 unrun devDep，行不冲突但邻近）
- #345 vs #338：README.md / README_EN.md / docs/external-plugin-guide.md / src/index.ts（#338 迁移基底，#345 加 path-security 引用，可能 src/index.ts 注册新路由撞）

### Cluster B — 独立修复

**分支**：`train/misc`
**worktree**：`D:\Projects\deepseek-harness\dsb-train-misc`
**合并顺序**：
1. `#341` (mermaid suppressErrorRendering) — 改 src/client/mermaid.tsx + 测试
2. `#310` (layout-push composer clip) — 改 Sidebar.tsx + layout-push.ts + breakpoints.ts + layout.css + 测试
3. `#342` (fs-search skip dirs) — 改 fs-search.ts + AGENTS.md + 测试
4. `#292` (markdown images) — 改 TextEditor.tsx + markdown-images.ts + README + 测试

**簇内冲突点**：基本无（彼此文件不重叠）。#342 的 AGENTS.md 和 #292 的 README 是跨簇冲突，本 worktree 内基于 main，无冲突。

### Cluster C — CSS 簇（sidebar.module.css）

**分支**：`train/css`
**worktree**：`D:\Projects\deepseek-harness\dsb-train-css`
**合并顺序**：
1. `#330` (z-index drop) — 改 sidebar.module.css:35 + AGENTS.md + docs/plans + e2e 测试
2. `#278` (overflow hidden + panelHidden transform) — 改 sidebar.module.css + e2e 测试
3. `#254` (mobile no-session feedback + overflow) — 改 Sidebar.tsx + sidebar.module.css + README + dsh.plugin.json + package.json + service.ts

**簇内冲突点**：
- #278 vs #330：sidebar.module.css（#330 改 z-index 行，#278 改 overflow/transform 行，可能行邻近但不直接冲突）
- #254 vs #330/#278：sidebar.module.css（mobile media query 区域，可能撞 e2e 测试）

### Cluster D — git 簇

**分支**：`train/git`
**worktree**：`D:\Projects\deepseek-harness\dsb-train-git`
**合并顺序**：
1. `#285` (worktree RC8 forward-port) — 改 DiffTab/GitView/api/state/git.ts/index.ts/builtins/tabs.tsx/locales.ts/sidebar.module.css + 测试
2. `#326` (multi-repo selector) — 改 DiffTab/GitView/api/state/git.ts/index.ts/package.json + 截图 + 测试

**簇内冲突点**（严重）：
- #326 vs #285：5 个核心文件全撞（DiffTab/GitView/api/state/git.ts）+ src/index.ts
- #326 应建立在 #285 的 worktree 支持基础上（多仓选择是 worktree list 的扩展）
- 合并 #326 时需要手工缝合：保留 #285 的 worktree list 逻辑 + #326 的子仓选择 UI

---

## 4. 执行流程

### Phase 0 — 准备（主 agent，串行）

```powershell
$repo = "D:\Projects\deepseek-harness\DSH-better-sidebar"

# 0.1 拉所有 PR 分支到本地 ref（避免 subagent 重复 fetch）
$prs = 345,342,341,338,336,330,326,310,292,285,278,254
foreach ($n in $prs) {
  git -C $repo fetch origin "pull/$n/head:pr-$n"
}

# 0.2 创建 4 个 worktree（每个独立目录，独立分支基于 origin/main）
git -C $repo worktree add "D:\Projects\deepseek-harness\dsb-train-base" -b train/base origin/main
git -C $repo worktree add "D:\Projects\deepseek-harness\dsb-train-misc" -b train/misc origin/main
git -C $repo worktree add "D:\Projects\deepseek-harness\dsb-train-css" -b train/css origin/main
git -C $repo worktree add "D:\Projects\deepseek-harness\dsb-train-git" -b train/git origin/main

# 0.3 每个 worktree 都 pnpm install（独立 node_modules，避免锁文件竞争）
foreach ($wt in @("dsb-train-base","dsb-train-misc","dsb-train-css","dsb-train-git")) {
  Push-Location "D:\Projects\deepseek-harness\$wt"
  pnpm install --prefer-offline
  Pop-Location
}
```

### Phase 1 — 簇内并行合并（4 个 subagent 同时跑）

每个 subagent 接收：
- 自己的 worktree 路径
- 簇内 PR 编号和合并顺序
- PR 的预期改动文件清单（见 §3）
- 验证命令：`pnpm typecheck`（必跑）+ `pnpm test`（如簇内有相互依赖的测试）

#### Subagent A（base）

```
worktree: D:\Projects\deepseek-harness\dsb-train-base
合并顺序: #338 → #336 → #345
命令:
  git merge --no-ff pr-338 -m "merge #338: 移除公开版 cordis peer，迁移类型基底到 @deepseek-ai/cordis"
  # 解决冲突（README/docs/package.json/src/index.ts）
  pnpm typecheck
  
  git merge --no-ff pr-336 -m "merge #336: add unrun devDependency for tsdown config loading"
  # 解决 package.json 冲突
  pnpm typecheck
  
  git merge --no-ff pr-345 -m "merge #345: 限制文件 API 访问会话工作区"
  # 解决 README/docs/src/index.ts 冲突
  pnpm typecheck

完成后输出:
  - train/base 的 HEAD SHA
  - 解决的冲突文件清单
  - 跨簇预期冲突点（README.md / package.json / src/index.ts / docs/external-plugin-guide.md / AGENTS.md / dsh.plugin.json / src/client/service.ts）
```

#### Subagent B（misc）

```
worktree: D:\Projects\deepseek-harness\dsb-train-misc
合并顺序: #341 → #310 → #342 → #292
命令:
  git merge --no-ff pr-341 -m "merge #341: fix(mermaid): suppress global error rendering"
  pnpm typecheck
  
  git merge --no-ff pr-310 -m "merge #310: keep conversation composer in viewport under layout push"
  pnpm typecheck
  
  git merge --no-ff pr-342 -m "merge #342: fs-search skip node_modules and other noise dirs"
  # AGENTS.md 可能无冲突（基于 main，A 簇的 AGENTS.md 改动在另一个 worktree）
  pnpm typecheck
  
  git merge --no-ff pr-292 -m "merge #292: markdown preview local/relative images"
  pnpm typecheck

完成后输出:
  - train/misc 的 HEAD SHA
  - 跨簇预期冲突点（AGENTS.md 来自 #342；README.md 来自 #292；Sidebar.tsx 来自 #310）
```

#### Subagent C（css）

```
worktree: D:\Projects\deepseek-harness\dsb-train-css
合并顺序: #330 → #278 → #254
命令:
  git merge --no-ff pr-330 -m "merge #330: drop panel host below DSH cordis dynamic-plugin layer"
  pnpm typecheck
  
  git merge --no-ff pr-278 -m "merge #278: panel host clip viewport, hidden panel no longer causes双向 overflow"
  # sidebar.module.css 可能冲突
  pnpm typecheck
  
  git merge --no-ff pr-254 -m "merge #254: mobile explain unavailable sidebar and prevent overflow"
  # sidebar.module.css 可能冲突；其他文件基于 main 无冲突
  pnpm typecheck

完成后输出:
  - train/css 的 HEAD SHA
  - 跨簇预期冲突点（sidebar.module.css 来自 #285；README/package.json/dsh.plugin.json/Sidebar.tsx/service.ts 来自 #254）
```

#### Subagent D（git）

```
worktree: D:\Projects\deepseek-harness\dsb-train-git
合并顺序: #285 → #326
命令:
  git merge --no-ff pr-285 -m "merge #285: forward-port linked worktrees to RC8

Co-authored-by: xxxg0001 <xxxg0001@users.noreply.github.com>"
  # 注意：#285 author email = fix@local.invalid，必须加 Co-authored-by trailer
  pnpm typecheck
  
  git merge --no-ff pr-326 -m "merge #326: support selecting child git repositories"
  # 严重冲突：DiffTab/GitView/api/state/git.ts/src/index.ts
  # 缝合策略：保留 #285 的 worktree list 逻辑 + #326 的子仓选择 UI
  pnpm typecheck

完成后输出:
  - train/git 的 HEAD SHA
  - 跨簇预期冲突点（sidebar.module.css 来自 #285；src/index.ts 与 base 簇撞；package.json 与 base 簇撞）
  - #326 缝合的关键决策（哪些函数来自 #285，哪些来自 #326）
```

### Phase 2 — 跨簇串行合并（主 agent）

```powershell
$repo = "D:\Projects\deepseek-harness\DSH-better-sidebar"

# 切回主 worktree
# 2.1 创建 mega-train 分支
git -C $repo checkout -b merge/bug-pr-train origin/main

# 2.2 merge train/base（应该 ff，因为 base 直接基于 main）
git -C $repo merge --no-ff train/base -m "integrate train/base: cordis peer migration + unrun devDep + path security"

# 2.3 merge train/css
git -C $repo merge --no-ff train/css -m "integrate train/css: panel z-index + overflow clip + mobile sidebar"
# 解决冲突：
#   - sidebar.module.css（train/base 没改，应该无冲突）
#   - README.md（train/base 改了，train/css 的 #254 也改了 → 冲突）
#   - package.json（train/base 加了 unrun devDep，train/css 的 #254 可能加 mobile deps → 冲突）
#   - dsh.plugin.json（train/base 改了，train/css 的 #254 也改了 → 冲突）
#   - src/client/service.ts（train/base 迁移了 cordis，train/css 的 #254 可能改了 mobile 检测 → 冲突）
pnpm install  # 合并 package.json 后必须重装
pnpm typecheck

# 2.4 merge train/git
git -C $repo merge --no-ff train/git -m "integrate train/git: worktree RC8 forward-port + multi-repo selector"
# 解决冲突：
#   - src/index.ts（train/base 改了 cordis 迁移，train/git 改了 worktree 注册 → 冲突）
#   - src/client/sidebar.module.css（train/css 改了 z-index/overflow/mobile，train/git 的 #285 可能改了 git 面板样式 → 冲突）
#   - package.json（train/git 的 #326 可能加了依赖 → 冲突）
pnpm install
pnpm typecheck

# 2.5 merge train/misc
git -C $repo merge --no-ff train/misc -m "integrate train/misc: mermaid + layout-push + fs-search + markdown-images"
# 解决冲突：
#   - AGENTS.md（train/base 改了，train/misc 的 #342 也改了 → 冲突）
#   - README.md（train/base + train/css 都改了，train/misc 的 #292 又改 → 三方合并冲突）
#   - src/client/Sidebar.tsx（train/misc 的 #310 改了 layout，train/css 的 #254 改了 mobile → 冲突）
pnpm typecheck

# 2.6 全量验证
pnpm typecheck
pnpm test
```

### Phase 3 — 推送与开 PR（主 agent）

```powershell
# 3.1 推 mega-train 到 fork（不是 origin，因为 origin 是 omdsh-dev 上游）
git -C $repo push fork merge/bug-pr-train

# 3.2 开 mega-PR（base = main，head = HuanLinOTO:merge/bug-pr-train）
gh pr create `
  --repo omdsh-dev/DSH-better-sidebar `
  --base main `
  --head HuanLinOTO:merge/bug-pr-train `
  --title "merge: bug PR train (12 PRs, --no-ff to preserve authors)" `
  --body "Closes #345, #342, #341, #338, #336, #330, #326, #310, #292, #285, #278, #254

一次性合并 12 个 bug PR，使用 --no-ff 保留每个 PR 的原始 commits 和作者归属。

合并顺序与分簇：
- Cluster A (base): #338 → #336 → #345
- Cluster B (misc): #341 → #310 → #342 → #292
- Cluster C (css): #330 → #278 → #254
- Cluster D (git): #285 → #326

并行 subagent 在 4 个独立 worktree 中合并簇内 PR，主 agent 串行合并 4 个 train 子分支。

#285 author email 不匹配 GitHub，merge commit 加了 Co-authored-by: xxxg0001 trailer。

详细方案：docs/plans/2026-08-23-bug-pr-merge-train.md"

# 3.3 PR 创建后，13 个 PR（12 个原始 + 1 个 mega）会显示在 PR 列表
# 等 CI 通过后用 --merge 合并（不要 squash）：
gh pr merge <mega-PR-number> --repo omdsh-dev/DSH-better-sidebar --merge
# 合并后 12 个原始 PR 因 Closes 关键字自动 close
```

---

## 5. 验证清单

### Phase 1 完成后（每个 subagent 自查）

- [ ] 簇内所有 PR 已 `--no-ff` 合并
- [ ] `pnpm typecheck` 通过
- [ ] git log 显示每个 PR 的原始 commits 保留
- [ ] 输出 train 子分支的 HEAD SHA 给主 agent
- [ ] 输出解决的冲突文件清单
- [ ] 输出跨簇预期冲突点

### Phase 2 完成后（主 agent 自查）

- [ ] 4 个 train 子分支全部并入 `merge/bug-pr-train`
- [ ] `pnpm install` 成功
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过（win32 平台已知失败项可记录，不算回归）
- [ ] `git log --oneline d6d8db0..HEAD` 显示 12 个 merge commit + 各 PR 的原始 commits

### Phase 3 完成后

- [ ] mega-PR 在 omdsh-dev/DSH-better-sidebar 创建成功
- [ ] PR body 包含 12 个 `Closes #N`
- [ ] CI 通过（或失败项是已知非回归）
- [ ] 用 `--merge` 合并（**不是 squash**）
- [ ] 合并后 12 个原始 PR 全部 close
- [ ] main 上 `git log --author=<每位作者>` 都能查到 commits

---

## 6. 风险点与应对

| 风险 | 概率 | 应对 |
|---|---|---|
| Phase 1 某个 subagent 簇内冲突解决失败 | 中 | 主 agent 介入协助；最坏退回该簇重做 |
| Phase 2 跨簇冲突比预期复杂（特别是 README 三方合并） | 高 | 手工缝合；以 #338 的 cordis 迁移为基底，叠加其他 PR 的章节 |
| Phase 2 #326 缝合 #285 后逻辑不一致（worktree list + 子仓选择） | 中 | 优先保 #285 的 RC8 forward-port 完整性；#326 的 UI 适配其 API |
| `pnpm test` 在 win32 平台已知失败 | 中 | 记录为已知非回归，不阻塞合并（参考 AGENTS.md "上游测试可能有 win32 平台假设失败"） |
| GitHub SSL 抖动（fetch 失败） | 低 | 重试 / 用 `gh pr diff` 替代 fetch / 走 fork remote |
| `--merge` 合并 mega-PR 后 contributors 列表未立即更新 | 低 | GitHub 异步计算 contributors，等 24h；只要 commit author email 匹配即可 |
| #285 的 `fix@local.invalid` 邮箱即使加 Co-authored-by 也不被 GitHub 识别 | 中 | 已用 noreply 邮箱作为 Co-authored-by，GitHub 会识别；最坏在 PR body 注明 |

---

## 7. 时间预估

| 阶段 | 串行耗时 | 并行耗时 |
|---|---|---|
| Phase 0 准备 | 5 min | 5 min |
| Phase 1 簇内合并 | 60 min | **20 min**（4 个 subagent 并行，取最慢的 git 簇） |
| Phase 2 跨簇合并 | 30 min | 30 min（必须串行） |
| Phase 3 推送 + PR | 5 min | 5 min |
| **总计** | 100 min | **60 min** |

并行加速比 ≈ 1.7×（受 Phase 2 串行合并限制）。

---

## 8. 回滚

```powershell
# 任意阶段失败，回滚到 main
git -C $repo checkout main
git -C $repo branch -D merge/bug-pr-train train/base train/misc train/css train/git

# 清理 worktree
git -C $repo worktree remove "D:\Projects\deepseek-harness\dsb-train-base" --force
git -C $repo worktree remove "D:\Projects\deepseek-harness\dsb-train-misc" --force
git -C $repo worktree remove "D:\Projects\deepseek-harness\dsb-train-css" --force
git -C $repo worktree remove "D:\Projects\deepseek-harness\dsb-train-git" --force

# 删除本地 PR ref
$prs = 345,342,341,338,336,330,326,310,292,285,278,254
foreach ($n in $prs) { git -C $repo branch -D "pr-$n" }
```

如果 mega-PR 已合并到 main 但发现严重回归：

```powershell
# Revert mega-PR 的 merge commit（保留历史，不删除 PR 记录）
gh pr merge <mega-PR-number> --repo omdsh-dev/DSH-better-sidebar --revert
```
