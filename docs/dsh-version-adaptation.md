# DSH 版本适配

> 插件与 DSH 宿主的版本绑定关系、抬基线时要改哪里、以及历次适配里仍然生效的结论。
> 日常写代码时的红线见 [AGENTS.md](../AGENTS.md)，开发细则见 [development.md](development.md)。

## 1. 当前基线

| 项 | 值 |
| --- | --- |
| 基线宿主 | **DSH 0.2.3-alpha.3**（下一版 alpha 起；安装下限与 peer 同批抬到 alpha 线） |
| DSH peer 数量 | **14 条** `@deepseek-ai/dsh-*`，下限全部 `^0.2.3-alpha.3` |
| devDependencies | 每条 DSH 包精确钉 `0.2.3-alpha.3`（**30 条**：传递 peer `@deepseek-ai/dsh-error` 在 0.2.2 线已提升进 devDependencies） |
| 伴随依赖 | Cordis peer `^4.2.0-alpha.2` / dev `4.2.0-alpha.2`、group `~1.2.0-alpha.2`、schemastery `~3.20.0-alpha.2` 解析、include `1.2.0-alpha.2` |
| `engines.dsh` | **`>=0.2.3-alpha.3 <0.3.0`**（package.json 与 `dsh.plugin.json` 同值；字段存在时宿主只按它判定，peer 不再参与） |
| 守护测试 | tests/market-manifest.spec.ts（peer 形状）+ tests/dsh-baseline.spec.ts（CI / 脚本 / 文档同版） |

14 条 peer 里包含 `dsh-client-ui-input-trigger`（划选引用 chip 的 `ctx.inputTriggers` 服务）；新增 peer 必须同批更新 AGENTS、本文件、指南与 README 的计数。

## 2. 支持线（用户侧）

| 用户的 DSH | 应安装的插件 |
| --- | --- |
| **0.2.3-alpha.3+** | 下一版 alpha（待发布） |
| 0.2.3-alpha.2 | **v0.34.0-alpha.1**（alpha 线） |
| **0.2.2-rc.3+** | **v0.33.0**（稳定线） |
| 0.2.2-rc.2 | **v0.32.1** |
| 0.2.2-rc.1 | **v0.32.0** |
| 0.2.1-rc.1 ~ 0.2.1-rc.5 | **v0.28.2** |
| 0.2.1-alpha.5 | v0.28.0-alpha.0 |
| 0.2.0-rc.2 | v0.26.1 |
| 0.2.0-rc.1 | v0.24.1 |
| 0.1.7-rc.1 ~ 0.1.7 | v0.22.1 |

下一版起 `package.json#engines.dsh` 为 `>=0.2.3-alpha.3 <0.3.0`；0.2.3-alpha.2 宿主固定 v0.34.0-alpha.1，0.2.2-rc.3+ 宿主固定 v0.33.0，v0.32.1 仍接受 0.2.2-rc.2。

## 3. 为什么「一个构建只服务一条宿主线」

- 宿主预检先读 `package.json#engines.dsh`，字段存在时只按它判定（本插件已声明，见 §1）；缺席才回退到逐个 `@deepseek-ai/dsh*` peer 的 `semver.satisfies(宿主版本, range, { includePrerelease: true })`，不满足就**整行静默禁用**（只有一行日志）。
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
- HTTP/WS 准入只调 `ctx.connection.admit(req)`，读返回对象上的 `rejection` 字段。`admit` 把凭据校验委托给嵌套服务 `connection.authentication`，cordis 只允许**显式注入**该服务的调用方读取它，所以这一段放在 `ctx.inject(['connection.authentication'])` 子 fiber 里执行；服务缺席时准入直接抛错（v0.34.0-alpha.0 起删除 `requestRejection` 回退）。不恢复 `webRuntime`，不自建信任例外。

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

## 8. 0.2.2-rc.2 → 0.2.2-rc.3：已验证，无代码变化

- rc.3 与本插件消费面的源码差异只有 `@deepseek-ai/dsh-client-ui-primitives` 的 `src/icons/artwork.ts`（+1）与 `src/icons/index.tsx`（+6）；其余是各包 `package.json` 版本、CI、桌面更新重启状态和无关的 DeepSeek 会话导入功能。`Menu` / `ui-sidebar-right` / `dsh-session` / `dsh-tools` / `dsh-agent` / `dsh-client-ui-*` 的 API 没有变化。
- 因此 `peerDependencies` 的 `^0.2.2-rc.2` 同时接受 rc.2 与 rc.3；实际安装下限由 `package.json#engines.dsh`（`>=0.2.2-rc.3 <0.3.0`）独立裁决，即 rc.3 起；**不新增任何运行时兼容代码**。
- 验证结果（2026-11-16）：临时 worktree 把 devDependencies 的 30 条 DSH 包升到 `0.2.2-rc.3`（不提交）后，`typecheck` / `build` / `check:consumer-types` 通过；全量单测 302/303 文件、3,517 例通过——唯一失败是 `tests/dsh-baseline.spec.ts` 仍断言 dev 钉版为 rc.2（临时升版导致，属于验证环境而非代码）；rc.3 宿主真实挂载 26 通过 / 6 跳过。rc.2 宿主同样 26 通过 / 6 跳过。
- 结论：当前构建服务 **0.2.2-rc.2 与 rc.3 两条 RC**；dev 钉版与 CI 仍保持 rc.2 基线；安装下限由 `engines.dsh` 裁决为 rc.3 起（见 §1）。

## 9. 0.2.2-rc.5 → 0.2.3-alpha.2（v0.34.0-alpha.0）

| 变化 | 影响 | 处理 |
| --- | --- | --- |
| `@deepseek-ai/dsh-llm` 的 `exports` 删除 `./brand` 子路径（文件仍在 `lib/types/brand.d.ts`，`./types` 与根入口重新导出） | `src/sidechat-routes.ts` 的 `MessageId` 类型解析回退到旧副本，报两处 `[BRAND]` 不匹配 | 改从 `@deepseek-ai/dsh-llm/types` 引入 |
| Cordis 抬到 `4.2.0-alpha.1`（宿主 peer `~4.2.0-alpha.1`）；`cordis-plugin-group` / `include` 抬到 `1.2.0-alpha.1`；`schemastery` 解析到 `~3.20.0-alpha.1` | dev 依赖树 | dev 钉 4.2.0-alpha.1 / group ~1.2.0-alpha.1 / include 1.2.0-alpha.1；schemastery peer 抬到 `>=3.20.0-alpha.1 <4` |
| 宿主包集合：移除 `dsh-client-ui-settings-plugin-inventory` / `-settings-plugins`；`dsh-experimental-cua-macos` 改名 `dsh-cua-macos`；新增 session-panel / session-status / connector-account / timeline | 本插件未引用被移除的包 | 无需改动 |
| 删除 `rankByName`、`ApiKeyCheck` / `assertUsableApiKey`、`SettingsPluginsTabOwnerProps` | 本插件 0 引用 | 无需改动 |
| 会话格式版本仍是 4、`SUBAGENT_DESCRIPTOR_VERSION` 仍是 3 | — | 不变 |

同一批删除的旧宿主兼容路径（不写运行时兼容层，旧宿主固定旧插件版本）：

- `src/index.ts` 的 `requestRejection` 分支与直连 `admit` 回退——只剩注入 provider 一条路，服务缺席即抛 `TypeError`；
- `src/active-worktree.ts` 的 `working-directory/change` 旧目录事件——只认 `workspace-root/change`；
- `src/client/center-column.ts` 的 `[data-slot="conversation"]` 旧锚点——只认 `[data-slot="main.conversation"]`；
- `src/clues/context/injection.ts` 对 `webServer.getOrigin` 的存在性探测——直接调用。

验证（2026-11-24）：`pnpm peers check` / `typecheck` / `lint` / `test` 全绿——真实破损只有 `dsh-llm/brand` 一处。


## 10. 0.2.3-alpha.2 → 0.2.3-alpha.3（下一版 alpha）

| 变化 | 影响 | 处理 |
| --- | --- | --- |
| 所有 Client 包（`dsh-client-ui-primitives` / `-slots` / `-locale` / `-conversation` / `-sidebar-right` 等）拆成「根 = 宿主侧空 `apply`」与 `/client` = 浏览器 bundle | 源码里从包**根** import 组件在运行期变成 `undefined`（React 报 `Element type is invalid`），类型面仍通过 | 80 个文件的组件 import 全部改为 `/client`；构建的 `CLIENT_EXTERNALS`、chunk 外部表与两份产物守护测试同步为 `/client` |
| `/client` 产物是 `window.__ModuleLoader__.load(...)` 的模块表 chunk，不是 ESM | 单元测试无法直接 import；`vi.mock` 的模块 id 也要跟着换 | vitest 只对 `dsh-client-ui-primitives/client`、`dsh-client-ui-slots/client` 加 alias 指到包内 `src/client/index.ts`（源码由 Vite 转换；生产构建仍走 external） |
| `ContinuableSubagentDescriptorInput` 收窄为 `Pick<Data, 'mode'／'provider'／'label'>`：模型选择改由子会话自己的 `model/selection` 事件承载 | `snapshotSubagentDescriptor()` 再传 `agentProvider` / `agentModel` 会类型报错 | `sidechat.start` 的 descriptor 只写身份字段；路由仍走 `agentOptions`，创建后的 model-selection seam 负责持久化 |
| Cordis 抬到 `4.2.0-alpha.2`；group / include 抬到 `1.2.0-alpha.2`；schemastery 解析到 `~3.20.0-alpha.2` | dev 依赖树 | dev 钉 4.2.0-alpha.2 / group ~1.2.0-alpha.2 / include 1.2.0-alpha.2；schemastery peer 抬到 `>=3.20.0-alpha.2 <4` |

验证（2026-11-28）：`pnpm typecheck` / `lint` / `test` 全绿（366 文件、4632 通过、18 skipped）；`pnpm peers check` 无失配。真实宿主挂载见下一批 commit 的验证记录。

## 11. 适配记录索引

- [0.2.2-rc.2](plans/2026-11-12-dsh-0.2.2-rc.2-adaptation.md)
- [0.2.2-rc.1](plans/2026-11-04-dsh-0.2.2-rc.1-adaptation.md)
- [0.2.1-rc.1](plans/2026-10-17-dsh-0.2.1-rc.1-adaptation.md)
- 更早（0.1.5 / 0.1.6 / 0.1.7）见 [docs/plans/](plans/) 对应文件。
