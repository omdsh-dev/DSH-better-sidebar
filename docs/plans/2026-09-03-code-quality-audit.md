# 2026-09-03 全方位代码防腐 / 质量优化审查报告

> 三路探索子代理对 src / tests / scripts / CI / 文档做全方位摸底后，经用户批准按「P0 速修 + P1 行为不变去重 + P2 深度项全做」执行，共 10 个变更流、11 个 PR，全部走分支 + PR + 三 job CI 门禁合入。本文记录审查结论、落地清单、过程中的重要发现与遗留 backlog。

## 1. 审查结论总览

底子健康，无大面积腐化：

- 类型纪律严格：全仓 0 `as any`、0 `@ts-ignore`、0 TODO/FIXME。
- 模块边界零违规：懒加载 chunk 隔离、client externals 白名单、tsdown purity gate 全部干净。
- 错误 envelope 一致：宿主侧 `wire.ts` / 客户端侧 `api.ts` 双层归一。
- 测试规模：118 个 vitest spec（约 3300 断言）+ 6 条 Playwright e2e lane。

压力点集中在：少数巨型组件、若干字面重复、脚本间复制粘贴、以及缺 lint / task-runner 基础设施。

## 2. 已落地的变更流

| PR | 主题 | 要点 |
|---|---|---|
| #524 | feat/test-utils | 共享 `tests/test-utils.ts`（`setupReactAct` + `renderRoot`），迁移 28 个 spec 的重复样板；`chunk-artifact` / `manifest-consistency` 加 lib 缺失 skipIf 守卫 |
| #525 | feat/dedup-core | api envelope 解析、`extOf` 双实现、lineage-walk 四份、GitLens 错误归一化六处收敛；删零引用死代码 `sidechatSeed`；console 分级统一。测试零改动 |
| #526 | feat/dev-commands | Makefile（11 目标薄封装，`check` 聚合对齐 CI）；package.json 补 `test:mount:aggregate` / `clean` / `packageManager: pnpm@11.8.0`；release.yml 补 consumer-types 并统一步骤序；.editorconfig；双语 README 补文档 |
| #527 | fix/scripts-hardening | aggregate 脚本 tarball 改 mtime 选取（修真 bug）；DSH_CMD 默认值统一；package-registry.mjs 补 mermaid chunk；抽 `scripts/e2e-common.sh` 消除两 e2e 脚本约 40% 重复（函数级等价性探针 + 双 lane 真机验证） |
| #534 | feat/palette-single-source | One Dark/Light 语法色板单源化（`one-dark-palette.ts`），迁移前后映射机器证明逐字节相等 |
| #535 | feat/i18n-catalog-names | 目录项 name / shell 预设 desc 词典化（20 key × 21 词典文件，`string | (() => string)` 镜像 desc 模式）；兜底错误条改 `var(--dsw-alias-*, 原hex)` 皮肤令牌链 |
| #536 | feat/eslint | ESLint 10 flat config（typescript-eslint recommended + 经典 react-hooks 规则），存量 141 错误/21 警告清零（含 24 处真实死代码删除、`_` 前缀 mock 约定入 config）；`pnpm lint` / `make lint` / CI 三 job 全部接入；`make check` 同步含 lint |
| #540 | feat/drop-rc7-fallback | 删 rc.7 宿主 `window.__DSH_MODULES__` 回退（peer 基线 rc.1 下不可达）；测试 fixture 切换到与生产同路径；附带修复 main 上 #535/#536 语义合并冲突导致的 add-plugin-modal spec 断裂 |
| #541 | feat/unify-polling | `use-polling.ts` 原语（83 行）统一四处轮询习语（SubagentView 自排程 3s / SideChatView fixed 2s / GitLens fixed 2s / ChangesTab fixed 2.5s），守护 spec 断言零改动 |
| #542 | feat/split-sidebar | Sidebar.tsx 1831 → 1176 行，抽 `src/client/sidebar/` 五模块（TabContent 74 / use-center-column 171 / use-host-feeds 269 / use-pinned-tabs 153 / free-windows 167）；面板拖拽机约 330 行因 `sidebar-layout-push.spec` 的源码文本计数断言钉住而有意保留主文件 |

过程中同步发生的外部事件：DSH 0.1.2-rc.1 适配（PR #537）合入后，Wave 2 三个 PR 全部 rebase 到新 main 并重跑门禁再合并。

## 3. 过程中的重要发现（记录在案）

### 3.1 Windows agent-pty PTY 超时 flaky（既有，非本轮引入）

`tests/agent-pty.spec.ts` 的真实 PTY spawn 用例在 ci-windows 上间歇性 5s 超时。证据链：main@`ceed6b2`（Wave 1 首个合并的 push run）挂 agent-pty ×4 + git.spec ×1；#535、#536、#541 的 ci-windows 各挂过 1-2 个同类用例，**重跑均绿**；失败组合在多次运行间漂移。建议后续对该 describe 块在 win32 上提升 testTimeout 或加有界重试。

### 3.2 desktop-layout.e2e.ts 间歇 flaky（上游时序敏感）

该用例测「右面板保持桌面 session 头部位置」，区域与上游适配提交 `ab6f960`（toggle cluster 重定位动画）重叠。本机（钉版 rc.1 CLI）稳定因宿主 onboarding 浮层 / workspace 选择对话框不可达而失败，且 main 原样产物 A/B 对照同样失败；CI 上 aa01140 的 push run 也挂过一次（同内容分支 run 与后续 main 验证 run 均绿）。属宿主时序敏感的既有 flaky，建议上游动画稳定后加等待收敛。

### 3.3 跨分支语义合并冲突的流程教训

#535 新增了 `builtinTabPlugins` 的使用（依赖既有 import），#536 的 eslint 清理在其各自基线上把当时未使用的同名 import 删除——两个各自全绿的 PR 文本合并成功但语义断裂（typecheck TS2304 + spec 加载即挂），且被并发 run 取消掩盖后带病合入 main，由 Wave 3 两个子代理独立发现并热修（#540 `8820efd`）。教训：**并行分支触碰同一文件时，每合入一个后其余分支需重验（rebase + typecheck/test），不能只信各自 PR 的绿勾**；unused-import 类清理与功能分支并行时尤其如此。

### 3.4 GitHub push run 丢触发一例

#541 合并产生的 main push run（`68839aa`）从未被创建（workflows 均 active，按 SHA 查询 0 runs），经 `workflow_dispatch` 手动补跑三 job 全绿。原因不明，遇到「merge 后 main 无 push run」时可按此法补验。

## 4. 基础设施变化速查

- **Makefile**：`help`（默认目标）/ `install` / `build` / `typecheck` / `lint` / `test` / `check`（typecheck+build+test+consumer-types+lint 聚合）/ `clean` / `pack` / `mount` / `mount-aggregate` / `registry`。package.json scripts 仍是唯一事实源，Makefile 只做薄封装与依赖链。
- **Lint**：`pnpm lint` = `eslint .`（flat config，`reportUnusedDisableDirectives: error`）；CI 三处（ci / ci-windows / release）在 Typecheck 后执行。
- **本地工具钉版**：`packageManager: pnpm@11.8.0`（CI workflow 的显式 `version:` 输入已移除，统一由该字段供版）。
- **e2e 本地跑法**：`make mount` / `make mount-aggregate`；本机无 rc.1 CLI 时 `npm install --prefix /tmp/dsh-rc1-bin @deepseek-ai/dsh@0.1.2-rc.1` 后置 PATH。

## 5. Backlog（本次仅记录）

1. mount.e2e 的固定 `waitForTimeout` 与英文文案选择器（`[title="Files"]` 等）——宿主文案/语言变更即碎。
2. CI 无 Playwright 浏览器缓存（每 run 重装 Chromium）。
3. `state.spec`（1498 行）/ `smoke.spec`（1208）/ `service.spec`（1124）三个千行 spec 拆分。
4. FreeWindow / TreePanel / split-pane / DiffPane / DiffRows 等组件缺直接渲染 spec（现靠 state 纯函数 spec + e2e 间接守护）。
5. coverage 工具引入评估（当前零覆盖率度量）。
6. CHANGELOG / CONTRIBUTING 文件（README「🆕 最近更新」小节手工充当 changelog）。
7. Sidebar.tsx 剩余拖拽机（~330 行）拆分——前置条件是先重构 `sidebar-layout-push.spec.tsx` 的源码文本计数断言为行为断言。
8. `JobOutputPane` 的 2s 轮询未迁移 `use-polling`（独立形状，见 #541 PR body）。
9. install.sh / install.ps1 / check-consumer-types.sh 内部的 say/warn/die 重复——install.sh 必须自包含随 npm 包分发，属有意设计，除非改分发方式否则不动。
10. §3.1 / §3.2 两个 flaky 的根治。

## 6. 验证基线（全部 PR 合并后于 main 复核）

- `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test`：119 files / 1243 passed / 9 skipped。
- `pnpm check:consumer-types` 通过。
- 真机挂载 lane：mount 5/5、drag-layout 7/7、float-window 2/2、toggle-layout 1/1、perf 2/2（desktop-layout 见 §3.2）。
- aggregate 双挂载回归 lane 通过。
