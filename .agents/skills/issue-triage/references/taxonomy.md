# 口径与常量（本仓库）

## 看板身份

| 项 | 值 |
| --- | --- |
| 归属 | 组织 `omdsh-dev`（项目归组织，不归个人） |
| 项目标题 | `DSH-better-sidebar · 排期看板` |
| 地址 | https://github.com/orgs/omdsh-dev/projects/1 |
| 字段 | `优先级`（P0–P3）· `批次`（R0–R3）· `Status`（Todo / 等待审核 / 等待开发 / Done） |

脚本按**标题**解析项目、按**名字**解析字段与选项，所以编号或 option id 变了不用改代码；但**名字改了要同步本文件**。

## 标签

- 类型：`bug` · `enhancement` · `question` · `documentation` · `refactor` · `chore`
- 领域：`area/sidebar` · `area/explorer` · `area/editor` · `area/tabs` · `area/git` · `area/terminal` · `area/security` · `area/build` · `area/i18n`
- 优先级：`P0` · `P1` · `P2` · `P3`（标签描述里也写着口径，改口径要连标签描述一起改）
- 生态标记：`Plugin candidate`（本应作为外部插件提供）· `upstream`（上游/宿主侧）· `duplicate`（重复）

## 批次与 Status

| 批次 | 含义 | 默认规则 |
| --- | --- | --- |
| `R1 · 立即` | 下一版本窗口 | 标签含 `P0` 或 `P1`，或在本文件的**提升名单**里 |
| `R2 · 下一窗口` | 下一窗口，按簇开工 | 其余 `P2` |
| `R3 · 待排期` | backlog | 其余 `P3` |
| `R0 · 等 PR review` | 修复已在 open PR 里，不需开发 | 被 open PR 引用的 issue，以及 PR 本身 |

| Status | 含义 |
| --- | --- |
| `Todo` | 新进来、还没分诊 |
| `等待审核` | 修复已在 PR 里（含所有 open PR） |
| `等待开发` | 已排期、等开发 |
| `Done` | 已完成 |

**注意**：批次由规则算出，不是发布承诺；`R1` 里除 P0/P1 之外被人工提上来的条目记在下面的提升名单里，别让脚本下次把它们的 `批次` 冲回 `R2`。

### 提升名单（人工提入 R1 的 P2）

机器可读的唯一来源：`references/promoted.json`（脚本按它算批次）。改这里 = 改排期；**不要**同时把 issue 标签从 P2 抬到 P1 来表达同一件事，否则两套真相。

## 落档位置

- 分诊文档：`docs/plans/<YYYY-MM-DD>-issue-triage.md`（分组清单 / 关闭理由 / 优先级调整记录 / 排期表 / 看板地址）
- 看板 README：项目页的 README（公开面，**中英双语**）
- 历史先例（可作写法参考）：`docs/plans/2026-10-04-issue-triage.md`
