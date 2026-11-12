# DSH 版本适配

> 插件与 DSH 宿主的版本绑定关系、抬基线时要改哪里、以及历次适配里仍然生效的结论。
> 日常写代码时的红线见 [AGENTS.md](../AGENTS.md)，开发细则见 [development.md](development.md)。

## 1. 当前基线

| 项 | 值 |
| --- | --- |
| 基线宿主 | **DSH 0.2.2-rc.2**（v0.32.1 起） |
| DSH peer 数量 | **14 条** `@deepseek-ai/dsh-*`，下限全部 `^0.2.2-rc.2` |
| devDependencies | 每条 DSH 包精确钉 `0.2.2-rc.2`（**30 条**：0.2.2-rc.2 新增的传递 peer `@deepseek-ai/dsh-error` 已提升进 devDependencies） |
| 伴随依赖 | Cordis peer `^4.1.0` / dev `4.1.0`、group `~1.1.0`、schemastery `~3.19.0` 解析、include `1.1.0` |
| `engines.dsh` | **不声明**（package.json 里没有该字段，走 peer 兼容性检查；`dsh.plugin.json#engines.dsh` 不参与判定） |
| 守护测试 | tests/market-manifest.spec.ts（peer 形状）+ tests/dsh-baseline.spec.ts（CI / 脚本 / 文档同版） |

14 条 peer 里包含 `dsh-client-ui-input-trigger`（划选引用 chip 的 `ctx.inputTriggers` 服务）；新增 peer 必须同批更新 AGENTS、本文件、指南与 README 的计数。

## 2. 支持线（用户侧）

| 用户的 DSH | 应安装的插件 |
| --- | --- |
| **0.2.2-rc.2+** | **v0.32.1**（当前线） |
| 0.2.2-rc.1 | **v0.32.0** |
| 0.2.1-rc.1 ~ 0.2.1-rc.5 | **v0.28.2** |
| 0.2.1-alpha.5 | v0.28.0-alpha.0 |
| 0.2.0-rc.2 | v0.26.1 |
| 0.2.0-rc.1 | v0.24.1 |
| 0.1.7-rc.1 ~ 0.1.7 | v0.22.1 |

## 3. 为什么「一个构建只服务一条宿主线」

- 宿主预检对每个 `@deepseek-ai/dsh*` peer 做 `semver.satisfies(宿主版本, range, { includePrerelease: true })`，不满足就**整行静默禁用**（只有一行日志）。
- **0.x 的 caret 不跨 minor**：`^0.2.1-rc.1` 展开为 `>=0.2.1-rc.1 <0.2.2-0`，因此 0.2.2 宿主会被判 false；反过来 `^0.2.2-rc.1` 也不接受 0.2.1 宿主。
- 结论：**抬基线必须同批抬 peer 下限**，并接受旧宿主停在旧插件版本。按仓库先例**不写运行时兼容层**，也不把范围放宽成「同时覆盖两条线」。

## 4. 抬基线动作清单

1. `pnpm peers check`：把失配的**传递** peer 提升进 devDependencies（例：0.2.2 线需要 `@deepseek-ai/cordis-plugin-group@~1.1.0`）。
2. 扫宿主包产物的**裸 import 差集**——`pnpm peers check` 看不到这类失败（0.1.7 线是 `zustand` / `immer`）。
3. 对消费的宿主包做**类型面 diff**（重点 ui-primitives / dsh-session / sidebar-right），确认导出只增不减。
4. 复查**会话格式版本**、`SUBAGENT_DESCRIPTOR_VERSION`、web profile 的 inject 列表。
5. 同批同步：CI 钉版（.github/workflows/ci.yml）、scripts/e2e-common.sh、**scripts/install.sh / install.ps1**（随包发布、直接给用户 npx 命令）、README / README_ZH / 指南 / 本文件 / AGENTS 的版本行；tests/dsh-baseline.spec.ts 与 tests/market-manifest.spec.ts 跟着改。

### 用户 profile 侧

- 用户 profile 若自己写了 `overrides: '@deepseek-ai/dsh-*'`，**必须同批抬高**：旧副本会遮蔽 bundle → 预检禁用 `config-editor` → `settings` 行永久 `pending`。
- 症状排查：宿主日志里的 `disabling profile plugin row` 与 `pending (waiting for service: …)`。
- 混合版本对的检测已内置：安装脚本装完会跑 `scripts/check-profile-host-tree.mjs`，发现 profile 自带的宿主包与 `dsh-subagent` 声明的兄弟版本不一致就失败并打印修复命令。

## 5. 仍然生效的删除契约（alpha.5 起）

- 不再依赖 `dsh-invariants`、`ctx.invariants` 或上游 `/invariant` 子路径；不发布 invariant companion。
- HTTP/WS 准入统一调用 `ctx.connection.requestRejection(req)`，**只有 `undefined` 放行**；不恢复 `webRuntime`，不自建信任例外。

## 6. 0.2.1 → 0.2.2 的代码级差异（v0.30.0）

上一版不是纯版本同步：`dsh-agent` 的模型选择改为 agent 自有的 `AgentModel`，`dsh-tools` 移除了 PTC 事件类型声明（读取路径保留），宿主图标改为 sprite。证据见 [0.2.2-rc.1 适配记录](plans/2026-11-04-dsh-0.2.2-rc.1-adaptation.md)。

## 7. 0.2.2-rc.1 → 0.2.2-rc.2 的代码级差异（v0.32.1）

| 变化 | 影响 | 处理 |
| --- | --- | --- |
| `ui-primitives` 的 `Menu` 删除 `getAnchorRect`，改为 `anchorRef` / `anchorPoint`；portal 菜单使用 CSS Anchor Positioning；子菜单改为 portal 到 `document.body`，按空间选 side / single-page | 4 处光标锚定的右键菜单；原先改写子菜单几何的本地 workaround 全部失效 | `getAnchorRect({x,y})` → `anchorPoint({x,y})`；删除 `menu-flip.ts`、`layout.css` 的 flip/tether 规则和对应测试，子菜单放置交给宿主 |
| `dsh-agent-team`（base composition）取代 `dsh-experimental-agent-team`；`TeamService` 删除 `tryMembership`，改提供 `isEnabled` | 团队任务写路由的准入探测 | `SidebarAgentTeamsService` 镜像改用 `isEnabled`；读路径（`agentTeam` 投影 + `subagentCatalog` 名册）不变 |
| 所有宿主包把 Cordis peer 收紧到 `~4.1.0`；`cordis-plugin-include` 1.1.0；新增 `dsh-error` 传递 peer | dev 依赖树 | dev 钉 Cordis 4.1.0、include 1.1.0，并提升 `dsh-error`；插件代码只用到稳定的 `ctx.fiber` / `ctx.loader.entries()` / `Service` |

**不变**：`SESSION_FORMAT_VERSION` = 4、`SUBAGENT_DESCRIPTOR_VERSION` = 3、`agentTeam` 投影 `{enabled,tasks,failure?}`、`session/event` 逐条发布（批量 append 仍有逐条通知）、`jobs` 客户端服务与 `sessionController` 面。

逐项证据：[0.2.2-rc.2 适配记录](plans/2026-11-12-dsh-0.2.2-rc.2-adaptation.md)。

## 8. 适配记录索引

- [0.2.2-rc.2](plans/2026-11-12-dsh-0.2.2-rc.2-adaptation.md)
- [0.2.2-rc.1](plans/2026-11-04-dsh-0.2.2-rc.1-adaptation.md)
- [0.2.1-rc.1](plans/2026-10-17-dsh-0.2.1-rc.1-adaptation.md)
- 更早（0.1.5 / 0.1.6 / 0.1.7）见 [docs/plans/](plans/) 对应文件。
