# DSH 版本适配

> 插件与 DSH 宿主的版本绑定关系、抬基线时要改哪里、以及历次适配里仍然生效的结论。
> 日常写代码时的红线见 [AGENTS.md](../AGENTS.md)，开发细则见 [development.md](development.md)。

## 1. 当前基线

| 项 | 值 |
| --- | --- |
| 基线宿主 | **DSH 0.2.2-rc.1**（v0.30.0 起） |
| DSH peer 数量 | **14 条** `@deepseek-ai/dsh-*`，下限全部 `^0.2.2-rc.1` |
| devDependencies | 每条 DSH 包精确钉 `0.2.2-rc.1`（只有 devDeps 精确钉，peer 绝不钉精确版本） |
| `engines.dsh` | **不声明**（package.json 里没有该字段，走 peer 兼容性检查；`dsh.plugin.json#engines.dsh` 不参与判定） |
| 守护测试 | tests/market-manifest.spec.ts（peer 形状）+ tests/dsh-baseline.spec.ts（CI / 脚本 / 文档同版） |

14 条 peer 里包含 `dsh-client-ui-input-trigger`（划选引用 chip 的 `ctx.inputTriggers` 服务）；新增 peer 必须同批更新 AGENTS、本文件、指南与 README 的计数。

## 2. 支持线（用户侧）

| 用户的 DSH | 应安装的插件 |
| --- | --- |
| **0.2.2-rc.1+** | **v0.30.x**（当前线） |
| 0.2.1-rc.1 ~ 0.2.1-rc.5（含 npm latest） | **v0.28.2** |
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

这一版**不是纯版本同步**，上游有三处真实变化：

| 变化 | 影响 | 处理 |
| --- | --- | --- |
| `dsh-agent`：可安装的 `ModelSelectionRef` + `installModelSelection(ctx, ref)` 改为 agent 自有的 `AgentModel`（`agent.model`，`select()` 同时落盘并作用于下一步） | 侧边对话的模型切换 | `ensureModelSelection` 只认领 `agent.model`，首次 seed 一次；**不要再额外 append `model/selection`**，`select()` 已经写了 |
| `dsh-tools` 移除 PTC（`tool/ptc-dispatch*`）的事件**类型声明**（运行期仍记录、旧会话仍可读） | 测试无法再用 store append 造事件 | 读取路径保留；产生事件的那条 store 级用例删除，改由 `tests/changes-ops.spec.ts` 的合成事件覆盖 |
| 宿主图标由内联 `<path>` 改为 sprite `<use href="#dsw-icon-…">` | 按图元的断言 | 断言改到 sprite id；设置页导航图标改用 `settings.section.icon` 插槽 |

逐项证据：[0.2.2 适配记录](plans/2026-11-04-dsh-0.2.2-rc.1-adaptation.md)。

## 7. 适配记录索引

- [0.2.2-rc.1](plans/2026-11-04-dsh-0.2.2-rc.1-adaptation.md)
- [0.2.1-rc.1](plans/2026-10-17-dsh-0.2.1-rc.1-adaptation.md)
- 更早（0.1.5 / 0.1.6 / 0.1.7）见 [docs/plans/](plans/) 对应文件。
