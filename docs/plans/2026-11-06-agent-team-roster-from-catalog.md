# 2026-11-06 团队名册改读 subagentCatalog（`agentTeam.members` 移除适配）

> 目标：让「任务管理」在 `agentTeam` 投影去掉 `members` 之后继续可用——不是补一把空值兜底，而是把名册搬到它现在的真源上。

## 1. 结论

| 项 | 改动前 | 改动后 |
| --- | --- | --- |
| 名册来源 | `agentTeam.members`（0.1.7 形状） | **Lead 的 `subagentCatalog`**：Lead 行 + catalog 行 |
| 成员名字 | 投影的 `name` | `name ?? label ?? id`（v3 载荷起 catalog 行带 `name`） |
| 成员状态 | `running / idle / provisioning / failed` | **`running / idle`**（durable phase 随投影消失） |
| 团队板显隐 | 投影存在即显示 | 投影存在且 `enabled !== false`（旧宿主没有该字段 → 仍显示） |
| 每成员错误 | `member.error` → `diagnostics[]` | 无（只剩板级 `failure`） |
| 任务归属匹配 | `member.name` | `member.name`，另加空串路径（Lead 自身的 agent path） |

## 2. 上游变化与证据

`agentTeam` 是 Session projection，浏览器从 `SessionListState.projectionsBySession[leadId].values.agentTeam`
读它。它的 wire schema 决定这个插件能读到什么：

| 版本 | wire schema | 成员在哪 |
| --- | --- | --- |
| DSH 0.1.7 ~ 0.2.1 | `{ members, tasks, failure? }`（`experimental/agent-team`） | 投影自带 `members` |
| DSH 0.2.2-rc.1（npm `latest` tag） | 同上 | 同上 |
| master（Team 包迁移之后） | `{ enabled, tasks, failure? }`，`.strict()` | **不在投影里**，改由 `subagentCatalog` 提供 |

证据链：

- 迁移 commit `122dc3af42`（`refactor(team): isolate package group`）把 Team 从
  `packages/experimental/agent-team` 移到 `packages/team/agent-team`，同一批改掉了 wire schema：
  `teamProjectionSchema = z.object({ enabled, tasks, failure? }).strict()`。
- 该 commit **不在任何 release tag 里**（`git tag --contains 122dc3af42` 为空），所以 0.2.2-rc.1 的
  发布产物仍是带 `members` 的旧形状——这就是为什么这个崩溃只在跑 master / 后续版本的宿主上出现。
- 升级说明 `docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.md` 写下了同一结论：
  "The wire `agentTeam.members` field and `TeamMemberProjection` are removed"，并指明成员浏览改由
  subagent 导航承担。
- `TeamProjectionState`（fold 状态）也不再保留 roster：只剩 `id / enabled / tasks / nextTaskNumber / failure`，
  所以这不是"投影裁剪了字段"，而是名册这个概念整体离开了 Team。

## 3. 修复

| 文件 | 改动 |
| --- | --- |
| [src/client/team-projection.ts](../src/client/team-projection.ts) | `teamMembersOf` 改为 `(team, rootId, entries, live, byId)`：Lead 行 + catalog 行；`teamProjectionOf` 增加 `enabled === false → undefined` |
| [src/context-types.ts](../src/context-types.ts) | `SidebarTeamProjection` 去掉 `members`、加 `enabled?`；删掉 `SidebarTeamMemberProjection`；`SidebarSubagentCatalogEntry` 补 `name?` |
| [src/client/SubagentView.tsx](../src/client/SubagentView.tsx) | 调用点把 Lead 的 catalog entries 传进名册（和拓扑用的是同一份 `catalogs[rootId]`） |
| [src/client/tasks-model.ts](../src/client/tasks-model.ts) | 节点上的 `team` 去掉 `phase` / `diagnostics`；`teamState` 只剩两态；归属映射补空串路径 → Lead |
| [src/client/tasks-shared.tsx](../src/client/tasks-shared.tsx) | 删掉 `provisioning` / `failed` 两个文案分支 |
| [src/client/TeamBoard.tsx](../src/client/TeamBoard.tsx) | 状态点只剩 `ongoing` / `idle` |

关键是**不伪造字段**：`phase` 与 per-member `error` 的值域在 0.2.2 已不存在，
保留一个恒为 `active` 的空壳只会让下一个人以为它在工作——这个仓库上一次就是这样被
"字段漂移没人看见"坑到的（见 `team-projection.ts` 原注释里那句 warning）。

## 4. 影响面与降级

- **受影响**：DSH 0.2.2 线上带 Team 包迁移的宿主（master 及之后），且该会话启用 Team 模式。
  现象是「任务管理」面板整页被错误边界接住，只剩一行 `Cannot read properties of undefined (reading 'map')`。
- **不受影响**：0.1.7 / 0.2.1 线。它们的 `agentTeam` 仍带 `members`，而新实现读 `subagentCatalog`
  （那些宿主同样有），`enabled` 缺失按启用处理。
- **降级**（上游不再提供，无法恢复）：名册上没有 `provisioning` / `failed` 状态；一次失败的 spawn
  不产生 catalog 行，因此没有行可画。
- **行为变化**：团队模式下所有直接子 agent 都是成员，不再有"部分成员"。所以「已完成」折叠组
  只在无团队的树里出现，同一父节点下不会同时存在 done / idle 两个组。

## 5. 验证

- `pnpm typecheck`：通过。
- `pnpm test`：全量 3042 例，3022 passed / 17 skipped；2 个失败是本地 pnpm 版本门禁
  （`packageManager: pnpm@11.8.0` vs 本机 11.28.5 的 corepack 检查），把版本临时对齐后 12/12 通过。
- 真机：在 DSH master（`node --import tsx/esm apps/cli/src/bin.ts web`）+ 本插件构建上打开「任务管理」，
  面板正常渲染，团队板显示 Lead 与各子 agent，任务按 owner 落到对应节点。