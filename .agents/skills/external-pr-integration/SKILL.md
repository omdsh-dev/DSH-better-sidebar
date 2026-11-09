---
name: external-pr-integration
description: 把外部贡献者的 PR 合入 dsh-better-sidebar：优先 rebase/ff 或 GitHub rebase-merge 以保留作者身份与 first-parent 历史，按仓库门禁验证，安全审查依赖与脚本，处理冲突 / force-push / base-main / 已关闭 PR，并更新贡献者清单。触发词：合入外部 PR、回填贡献者 PR、rebase/ff、保留作者、PR 冲突、PR force-push、PR 基于 main、贡献者署名、外部 PR review。
---

# 外部 PR 合入

目标：把贡献者的工作**安全、可维护、可追溯**地合进 `dev`，同时让 `git log` 和 GitHub 都能看出是谁写的。

**核心原则：不默认 `--no-ff`。** merge commit 的作者是整合者，贡献者的提交会退到第二父；如果只看 `git log --first-parent`，历史会变成「全是维护者」。优先让贡献者提交进入 first-parent：

1. **首选**：PR 已基于最新 `dev` → 本地跑门禁 → `gh pr merge --rebase`（GitHub 保留作者、标记 MERGED，first-parent 是贡献者提交）。
2. **次选**：PR 需要 rebase → 在本地 `integ/<n>` 分支 rebase 到 `dev` 跑门禁；能更新贡献者分支时用 `--force-with-lease` 推回，再走第 1 条。
3. **无法更新贡献者分支**：本地 `git merge --ff-only integ/<n>` 后关闭 PR，评论说明「已按 <commit> 合入」；作者仍在提交里，但 GitHub 可能显示 CLOSED 而非 MERGED。
4. **只有必须保留合并关系 / 无法 rebase** 时才用 `--no-ff`：merge commit 作者是维护者，必须在 merge message 和 `CONTRIBUTORS.md` / 发布 note 里写明贡献者。

**绝不** squash、`--reset-author`、改写贡献者已推送的分支（除非贡献者明确同意）。维护者的修改做成**独立后续提交**，不要 amend 进贡献者的提交。

## 0. 先读

- 仓库硬约束与门禁：[AGENTS.md](../../../AGENTS.md) §1–§2。
- 贡献者清单：[CONTRIBUTORS.md](../../../CONTRIBUTORS.md)；发版 note 模板：[docs/release.md](../../../docs/release.md)。
- 分诊结论（PR 优先级/是否该接）：[issue-triage](../issue-triage/SKILL.md)。

## 1. 取 PR 与证据

```bash
gh pr view <n> --json number,title,state,isDraft,mergeable,mergeStateStatus,baseRefName,headRefOid,author,files
git fetch origin pull/<n>/head:pr/<n>
git log --format='%h | %an <%ae> | %s' dev..pr/<n>
git diff --stat dev...pr/<n>
git diff --name-only dev...pr/<n> | grep -E 'package.json|pnpm-lock|pnpm-workspace|scripts/'
```

先回答四个问题：

- 作者是谁？PR 头提交的作者与 PR 作者是否一致（不一致就记为协作/机器人，不要猜）？
- 是否 force-push 过？`gh pr view --json headRefOid` 与本地 `pr/<n>` 不一致时，以远端为准重新 fetch。
- 是否基于 `main` / 很旧的 `dev`？这决定用 cherry-pick 还是 rebase。
- 是否 draft / 已被别人合过 / 已被取代？先看状态，不要重复合。

## 2. 安全与范围审查

外部 PR 默认不可信，先看**改变了什么**，再看代码风格。

- **依赖**：`dependencies` / `peerDependencies` / `optionalDependencies` 是否新增包？lockfile 是否跟着变？新包是否真实、必要、无 postinstall？本仓库禁止在依赖里出现 `cordis`，`scripts` 禁止 `preinstall` / `install` / `postinstall` / `prepare`。
- **执行面**：新增/修改的 `spawn`、`exec`、shell、网络请求、`eval` / `new Function`、动态 `import()`、路径拼接、归档/删除/覆盖操作。所有外部输入是否在边界校验？是否 argv-only、无 shell 插值？
- **数据面**：是否读取/上传用户文件？是否新增路由、放宽 CSP/沙箱、改变路径基准？有没有越界、竞态、symlink、zip-slip、命令注入？
- **构建面**：是否新增构建脚本、生成物、二进制、压缩/混淆代码？生成物是否可复现、是否被 `files` 带进包？
- **范围**：是否夹带无关重构、格式化、版本号/peer 改动、文档营销？能拆就要求拆；不能拆就在合并说明里写清。
- **许可**：新增文件/资源是否带兼容许可证；不确定就问，不要默认可以。

有恶意/可疑代码、来源不明的二进制、混淆脚本、无必要的新依赖：**不合**，在 PR 里说明具体文件和风险。

## 3. 集成

### A. 干净的 PR（首选）

```bash
git fetch origin pull/<n>/head:pr/<n>
git checkout -B integ/<n> dev
git merge --ff-only pr/<n>   # 只有 PR 已包含 dev 时才会成功
# 若不成功，走 B
```

跑门禁（见 §4）。通过后优先在 GitHub 上 **Rebase and merge**：

```bash
gh pr merge <n> --rebase --delete-branch
```

这会保留作者、标记 MERGED，贡献者提交进入 first-parent。注意：`gh pr merge --rebase` 只适用于 GitHub 判定可 rebase 的 PR；冲突时它会失败，转 B。

### B. 需要 rebase / 冲突

```bash
git checkout -B integ/<n> pr/<n>
git rebase dev
# 解决冲突，git add，git rebase --continue
```

- rebase 会保留 `author`，改变 `committer`；这是正常的。
- 冲突解决只做**让语义成立的最小改动**。如果冲突解决实际上引入了维护者设计，另起一个独立 commit（见 C），不要把大段维护者代码塞进贡献者提交。
- rebase 后先在 `integ/<n>` 跑门禁。

接下来二选一：

- **能更新贡献者分支**（维护者有权限 / 贡献者同意）：`git push --force-with-lease origin integ/<n>:<pr-branch>`，然后走 A 的 `gh pr merge --rebase`。
- **不能更新**：`git checkout dev && git merge --ff-only integ/<n> && git push origin dev`，再 `gh pr close <n>`，评论写「已按 `<commit>` 合入 dev；作者保留，GitHub 因分支未更新显示为 closed」。不要为了 MERGED 徽章去 force-push 别人的分支。

### C. 维护者修改

维护者需要补测试、修边界、改文档时：

```bash
# 在 integ/<n> 上，贡献者提交之后
git add ...
git commit -m "fix(scope): <what> (#<n>)"
```

- 这个 commit 的作者是维护者，这是正确的；**不要**把它 amend 进贡献者提交。
- 如果修改的是贡献者提交里的同一段代码，仍保持两个 commit：贡献者的原提交 + 维护者 fixup，评审时能看出谁改了什么。
- 提交信息带上 PR 号；需要时在 PR 里说明「我补了 X，原因 Y」。

### D. PR 基于 `main` / 需要 cherry-pick

```bash
git cherry-pick -x <sha>...
```

- `-x` 记录来源 commit；`cherry-pick` 默认保留作者。
- 不要用 `--reset-author`。
- 合入后手动关闭 PR（GitHub 不会把 base 不同的 PR 自动标记 MERGED），评论写「cherry-picked as <sha>，作者保留」。

### E. 必须 merge commit 的例外

只有无法 rebase、或合并关系本身有语义时才用：

```bash
git merge --no-ff pr/<n> -m "merge #<n>: <title>"
```

merge commit 作者是维护者；贡献者提交在第二父。此时必须：

- 在 merge message 写明 PR 号与贡献者；
- 在 `CONTRIBUTORS.md` 加一行；
- 发布 note 的贡献者表不能漏。

## 4. 门禁

按 [AGENTS.md](../../../AGENTS.md) §2 的矩阵跑；最低集：

```bash
DSH_PNPM=/Users/menghuan/Library/pnpm/pnpm \
NODE_OPTIONS=--max-old-space-size=4096 \
pnpm install --frozen-lockfile
pnpm typecheck
pnpm exec eslint .
pnpm exec vitest run --maxWorkers=2 --exclude '**/.agents/worktrees/**'
```

按改动追加：

- 构建产物 / 公开导出面：`pnpm build` + `pnpm check:consumer-types`
- 客户端承载面 / tab / 原生侧栏 / 编辑器 / 文件 Git 终端路由：`pnpm build && pnpm pack && pnpm test:mount`
- win32 分支 / 安装脚本：`pnpm test:windows`
- 搜索引擎：`pnpm check:engines`

真实本地挂载：

```bash
DSH_CMD='npx -y --package @deepseek-ai/dsh@0.2.2-rc.1 dsh' pnpm test:mount
```

**禁止**只凭 CI 绿就宣称本地跑过；报告里区分「本地实跑」「只在 CI」「未验证」。全量套件首次失败、重跑通过时，要记录为 flake，不要静默改代码或直接放过。

## 5. PR 状态与收尾

合入后核对：

```bash
gh pr view <n> --json state,mergedAt,mergeCommit
git merge-base --is-ancestor pr/<n> dev && echo ancestor
gh run list --branch dev --limit 1
```

- GitHub 自动 MERGED：head 提交确实是 `dev` 祖先（本地 ff / GitHub rebase-merge）。
- GitHub 仍 OPEN：可能 head 被 force-push 过、base 不是 `dev`、或你 rebase 后本地合入。**先验证祖先关系**；确认已合入再手动 close，评论写清 commit。
- PR 被 force-push 到你没合过的 head：不要合旧 ref；以远端最新 head 为准重新 review。若旧 head 已合入而新 head 会回退已合内容，保留已合版本，关闭 PR 并说明。
- 关闭/合并评论用贡献者的语言（CJK 正文用中文），致谢，写清维护者改了什么、为什么。

## 6. 署名

- 每个贡献者 PR 在 [CONTRIBUTORS.md](../../../CONTRIBUTORS.md) 有一行（`@handle` + 贡献 + PR）。
- 发版时按 [docs/release.md](../../../docs/release.md) §5 的贡献者表再列一次；**漏署名等同于吞掉别人的工作**。
- 可用证据：
  ```bash
  git log --graph --format='%h %an <%ae> %s' -20
  git log --first-parent --format='%h %an %s' -20
  git show -s --format='%an <%ae>' <sha>
  ```
  `--graph` 看到贡献者提交，`--first-parent` 只看到整合提交；后者全是维护者并不代表作者丢失，但说明整合方式需要改。

## 7. 常见坑

- **default no-ff**：first-parent 看不到贡献者；不要作为默认。
- **squash**：会丢掉贡献者提交边界和作者；本仓库不用。
- **cherry-pick 不带 `-x`**：丢失来源记录；带上。
- **rebase 后直接 close 说 merged**：先确认 head 是否祖先；rebase 会改 hash，GitHub 不会自动 MERGED。
- **force-push 贡献者分支**：没有明确同意不要做；用 `--force-with-lease`，并在 PR 里说明。
- **merge commit 里塞维护者大改**：贡献者提交 + 维护者 fixup 分开；merge commit 只做整合。
- **只跑定向测试**：外部 PR 很容易碰共享契约；至少全量 vitest + 对应门禁。
- **忽略 package/lock**：新依赖、postinstall、peer 改动是最高风险面。
- **把 CI 当本地验证**：报告里必须写清证据来源。

## 交付前检查表

- [ ] PR 作者 / 提交作者已核对；没有 squash / reset-author。
- [ ] 依赖、脚本、spawn、网络、路径、CSP 已审查；无来源不明二进制/混淆代码。
- [ ] 优先 rebase/ff 或 GitHub rebase-merge；没有默认 `--no-ff`。
- [ ] 维护者修改是独立 commit，贡献者提交保留。
- [ ] 门禁按矩阵跑完；全量测试 + 需要的 build / consumer-types / mount / windows / engines。
- [ ] `git merge-base --is-ancestor` / GitHub 状态已核对；PR 已 MERGED 或带证据关闭。
- [ ] `CONTRIBUTORS.md` 有行；发布 note 的表能对应上。
- [ ] 报告区分本地实跑 / CI / 未验证。
