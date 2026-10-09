# Git 面板：Push / Pull — 移植记录（PR #434）

> 分支 `port/pr-434`（基于 `dev`，DSH 0.2.0-rc.1 线）。上游 PR `Feat/git commit message ai`
> 三个 commit：`6b98216` AI 建议 + 提交框置顶、`3ec82f2` Push/Pull、`80e64bc` 文件树 rename。
>
> **集成分支 `integ/ports` 的两条取舍（2026-10-05）**：
>
> 1. **「建议提交信息」整块以 PR #642 的移植为准**（`port/pr-642`：`src/commit-message.ts` +
>    宿主路由 `git.suggest-message` / `git.commit-model` / `git.models` + `CommitModelSettings.tsx`
>    + 多行 textarea / Ctrl+G / ✨ 按钮）。本 PR 那份重复实现连同它的接线一并删除：
>    `src/context-types.ts` 的 `requestHeader()` / `SidebarSessionRoute`（#642 走
>    `agents.options` → `request/header` 事件反扫 → `agentDefaultModel` 三级回退）、
>    `src/index.ts` 的 `SUGGEST_DIFF_LIMIT` 与 `sessionModelRoute`、它那份 `git.suggest-message`
>    路由体、客户端的 `suggestSpinner` CSS/keyframes 与 4 个重复键。下面「设计要点」里
>    依赖这些接线的一条（模型路由取 `requestHeader()`）因此只是历史记录，**已不成立**。
> 2. **文件树 rename（第三个 commit）整块丢弃**：`dev` 已有等价实现（commit `e39ea92` /
>    PR #550，`src/fs-operations.ts` + `FileTree.tsx` 内联改名 + 21 份词典的 rename 键），
>    且 PR 的同名 `fs.rename` 路由读 `newName`、`dev` 读 `name`，机械合并会改成坏的；
>    PR 那版还会在每个词典里重复插入 rename 键（TS1117，`pnpm typecheck` 必红）。

## 落地内容

「文件变动」页 Git 视角的提交栏新增 **Push / Pull** 两个按钮：`git push` 与
`git pull --ff-only`，提交后不必离开面板。

## 设计要点

- **路由**：`git.push` / `git.pull` 两条，与其余 git 路由同样经 `gitCwdOf` + `selectedRepoOf`
  解析目标检出，git 自己的 stderr 原样上报（无 upstream、认证失败、分支分叉都是用户去终端
  解决的问题）。`--ff-only` 是刻意的：无头面板里打开合并编辑器等于把用户困住，分叉就必须
  响亮失败——由 `tests/git-remote-actions.spec.ts` 钉住「HEAD 不动、工作区干净、
  没有 `MERGE_HEAD`」。
- **提交栏只有一个状态行**：Push/Pull 的失败与 commit/stage/discard 共用既有那条 `actionError`
  （文案前缀区分是哪个动作），没有照搬 PR 的第二条 `remoteError`——这个文件的既有约定就是
  「UI 两个错误通道，各司其职」，提交栏只拥有自己那一条。
- **按钮并进既有提交行**（集成时的偏差）：PR 版在状态行下面另起一行 `.commitRemoteRow`；
  `integ/ports` 以 #642 重写后的提交栏布局为基，把两个按钮放进同一条 `commitRow`
  （textarea → ✨ → 提交 → 推送 → 拉取），并删掉 `.commitRemoteRow`——不再新增第二行，
  也仍然共用同一条状态行。
- **提交框不置顶**：PR 把提交行搬到面板顶部，动机是当时它被夹在暂存/未暂存列表中间、要滚动才够得着；
  `dev` 的提交栏已经是 `position: sticky; bottom: 0` 的常驻底栏（`changes.module.css` 的
  `.commitBar` 注释写明了这个取舍），那个问题不存在了。

## i18n

Push/Pull 的 4 个键（`push` / `pull` / `pushError` / `pullError`）沿用上游 PR 的译文，
按 `commit` 键为锚点插入 zh、en 与 19 份第三语言词典。PR 同期插入的
`generateCommitMessage` / `generatingCommitMessage` / `suggestCommitError` / `suggestCommitEmpty`
以 #642 的译文为准（同名键只有一份）。

## 测试

- `tests/git-remote-actions.spec.ts`（4 例，宿主半区，真 git）：push 真把远端 main 推到本地
  commit；无 upstream 报 `git-error`；pull 快进；分叉拒绝且不留合并现场。原 PR 那份
  `git.suggest-message` 路由用例随被删的实现一并移除（它们钉的是 `requestHeader()` 与
  200 token 预算，属已不存在的契约）；#642 的实现由它自己的 `tests/commit-message.spec.ts`
  （纯逻辑）、`tests/git-suggest.spec.tsx`（UI）、`tests/commit-model-settings.spec.tsx` 覆盖。
- `tests/git-suggest-route.spec.ts`（16 例，宿主半区，真 git + 假 `ctx.llm` / 假会话 / 假设置）：
  补上被上面那条删除留下的**路由层**缺口——三级模型回退链（固定 → 会话自身 → `agentDefaultModel`）
  与「全都拿不到」的可辨识 503、提示词组装与 `truncateDiff` 截断标记、512 token / 最低
  reasoningEffort / 30s 超时确实进了 `llm.stream` 入参、`{message, provider, model}` 返回形状与
  trim、llm 失败与「无可用模型」可区分的错误映射，以及「除读 diff 外零 git 调用」的安全不变式
  （在 `spawn` 进程边界上断言，并在仓库状态上复核索引未被动过）。
- `tests/git-remote-actions-ui.spec.tsx`（1 例，jsdom）：Push/Pull 的调用参数（选中的检出）
  与失败落在提交栏那一条状态行上。

## 未做

- 上游 PR 的提交框置顶（理由见上）。
- 未做真机 `dsh web` 挂载验证：本节点的门禁是 typecheck + 全量 vitest + eslint。
