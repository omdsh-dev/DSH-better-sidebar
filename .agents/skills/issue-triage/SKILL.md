---
name: issue-triage
description: 对本仓库的 issue 与 PR 做分类/判别（类型 · 领域 · 优先级），给出「关闭 / 追信息 / 留待办 / 等 review」的结论，并把结果同步到 Projects v2 排期看板与分诊文档。触发词：分诊 issue、整理/清理 issue、打优先级标签、判 issue 还是 PR、PR 排队、把 PR 丢队列、更新排期看板、issue 看板同步、这个该不该关。
---

# Issue / PR 分诊与排队

把仓库里的 issue 与 PR 变成一组**可执行的结论**：每条要么有优先级与批次、要么有明确的关闭理由。判断必须带证据，写回必须可复核。

**边界**：本 skill 只动 issue / PR / Projects 看板与 `docs/plans/` 下的分诊文档，不碰 `src/`、`tests/`、DSH 源码，也不改 issue 正文。仓库硬约束见 [AGENTS.md](../../../AGENTS.md) §1（代码改动走 PR、禁止写 DSH 源码）。

## 一次性准备

- 看板读写需要 `project` scope：`gh auth refresh -s project`（**只能人点浏览器**，不要自己起流程干等）。
- 看板身份、标签口径、批次定义、默认规则：`references/taxonomy.md`。
- GitHub API / gh CLI 的坑（视图分组不可写、字段选项替换会清值、非 ASCII 键乱码等）：`references/gh-gotchas.md`。**动手前先读一遍**，能省掉一整轮返工。

## 阶段 1 · 取快照

```bash
node .agents/skills/issue-triage/scripts/snapshot.mjs --out /tmp/triage
```

产出 `snapshot.json`（结构化）与 `digest.md`（人读：标题 + 标签 + 年龄 + 评论摘要 + 代码/提交里的修复引用）。**先读 digest 再做判断**，不要靠标题猜。

`snapshot.mjs` 会额外扫描 main / 任意 merge-train 分支的提交与 CHANGELOG、docs、src、tests 里对本 issue 号的引用，这是「已经修好了吗」最便宜的证据来源。

## 阶段 2 · 分类（每条都要落三个坐标）

1. **类型**：`bug` / `enhancement` / `question` / `documentation` / `refactor` / `chore`。
2. **领域**：`area/sidebar`（承载面/布局/面板/交互）· `area/explorer` · `area/editor` · `area/tabs` · `area/git` · `area/terminal` · `area/security` · `area/build` · `area/i18n`；跨领域或纯流程类**不挂**，不要硬塞。
3. **优先级**：`P0` 崩溃/阻塞**或核心能力缺失（基本需求）** · `P1` 影响日常使用/数据丢失/门禁红 · `P2` 功能性缺陷（有 workaround）或广泛需要的功能 · `P3` 体验与建议、窄场景，**以及已修好/已不再适用的条目**。

铁律：

- **已有优先级标签默认保留**（维护者此前打过的是判断，不是噪声）。只有「主题已从产品中消失」才下调，且要在文档里记一笔。
- 只降不升：真觉得该升级，先说给人听，别默默改。
- **一条 issue 只能有一个 P 标签**：`gh issue edit --add-label` 不会移除旧标签，批量改完必须回读自查（见阶段 4）。
- 对 PR 不判类型/领域，只判优先级：从它引用的**仍开着**的 issue 继承（取最高档）；引用不到就留空，不要编。

## 阶段 3 · 判动作（决定「要不要关、要不要追」）

按证据把每条归到一组，**证据不足就留在待办**：

| 组 | 判据 | 动作 |
| --- | --- | --- |
| 已修（train/分支） | merge train PR 正文的 `Fixes #N`，或提交里明确 `Fixes/Closes #N` | 不手动关：等合并自动关；没被 `Fixes` 覆盖的自己复核后关 |
| 已修（已发布） | 代码里能指出守卫它的文件/测试，或 CHANGELOG 记录 | `completed` 关闭，评论里写**具体位置** |
| 已不再适用 | 该功能已从产品移除（如终端交还宿主、围栏删除）或宿主版本线已不支持 | `not planned` 关闭，写清「已经没有这块代码」 |
| 重复 / 第三方 | 同题 issue（含已 NOT_PLANNED 的）、根因在宿主 bundle 或别的插件 | `not planned` + 指回/指向对方仓库 |
| 已答复 | 问题已有答案（含你自己答的） | `completed` + 一句话结论 + 逃生路线 |
| 缺信息 | 现象无法定位且报告者没给环境/日志/复现 | 追问一次，**写明要什么**并声明「14 天无新证据按无法复现关闭」 |
| PR 在飞 | 有 open PR 引用它 | 不动，进 `R0` 等 review |
| 留待办 | 其余 | 按优先级进 R1/R2/R3 |

关闭时：

- 用 `gh issue close <n> --reason completed|not planned --comment "<说明>"`。**评论用 issue 自己的语言**（正文有 CJK 就中文，否则英文）——公开仓库里这是基本礼貌。
- 评论必须是「为什么可以关」的证据：文件路径 / 测试名 / 提交号 / 别人的复现根因。**没有证据就不要关**。
- 一次清理 = 一个可复核的批次，做完在文档里留逐条清单。

## 阶段 4 · 同步队列（看板）

```bash
node .agents/skills/issue-triage/scripts/board-sync.mjs --dry-run   # 先看计划
node .agents/skills/issue-triage/scripts/board-sync.mjs             # 执行（幂等）
```

脚本按 `references/taxonomy.md` 的默认规则算 `批次` 与 `Status`，按 issue 标签算 `优先级`，把 **issue 与 open PR** 都纳入看板；重复运行不会产生重复条目。

写回后**必须回读验证**（脚本会做，但汇报前自己再确认一次）：

```bash
node .agents/skills/issue-triage/scripts/board-sync.mjs --verify
```

验证内容：条目总数、`Status` / `批次` / `优先级` 的分布、**零缺失**、以及每条 issue 只有一个 P 标签。命令退出码为 0 才算通过。

## 阶段 5 · 落档

- 分诊结论写进 `docs/plans/<date>-issue-triage.md`（分组清单、关闭理由、优先级调整记录、排期表、看板地址）。
- 看板项目 README（公开面）保持中英双语，口径与文档一致。
- **三处必须一致**：issue 标签 ⇄ 看板字段 ⇄ 文档。改了一处就顺手把另两处对齐——「issue 是 P0、板上写 P2、文档写 P2」是最容易出现的隐性债务。

## 交付前检查表

- [ ] 每条都能说出「为什么是这个优先级 / 为什么能关」，且证据在评论或文档里。
- [ ] 没有 issue 同时挂两个 P 标签；没有被静默降级的维护者判断。
- [ ] 关闭理由用了正确的 `reason`（修好 = completed；不再适用/重复/第三方 = not planned）。
- [ ] 看板条目数 = open issue 数 + open PR 数；字段零缺失；回读校验通过。
- [ ] 文档、看板 README、标签三处口径一致。
- [ ] 报告里区分「我做的」与「需要人点一下的」（授权、视图分组、组织设置）。
