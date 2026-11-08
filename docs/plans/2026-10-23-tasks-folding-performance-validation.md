# 任务页展开、性能与自动折叠设置验证（2026-10-23）

## 范围与行为

基点 `0fab0afdbb2eff6294caa49b4b6aab8ffbc01f0b`，修复分支 `fix/tasks-folding-performance`。本批只改插件，不修改 DSH 源码、用户 profile 或发布版本。用户最终选择通过 PR 合入 `dev`，不直接本地集成。

- 图模式的背景平移会留下上一手势的移动量；下一次节点 pointerdown 先清零，避免聚合展开和 Agent 详情点击被吞。回归使用完整 pointerdown → pointerup → click，不用孤立 click 代替真实手势。
- Agent 卡内容有独立 memo 边界，语言签名进入 key；布局用 id 索引、显式栈和单次宽度适配内的列数复用，不新增全局缓存、轮询、路由或存储。
- 自动聚合只吞整条已结束且目录已知的分支；当前查看路径、运行后代和未知目录保持可达。聚合成员覆盖所有隐藏 Agent 后代，不把 workflow 本身计为 Agent。
- 现有设置齿轮增加四个默认 `true` 的独立偏好：`tasksAutoFoldSettled`（已结束叶子）、`tasksAutoFoldBranches`（整条已结束分支）、`tasksAutoFoldIdle`（空闲队友）、`jobsAutoCollapse`（Agent 总数至少 8 时收起后台任务抽屉）。普通空闲队友阈值仍为同父级 3 个；workflow 内保留原有不设数量阈值的规则，也受空闲开关控制。
- 偏好走现有 volatile Config，未手动操作时实时生效；手动展开/收起优先。叶子与分支开关独立，不新增总开关。

## 审查闭环

Standards 与 Spec 两轴独立审查。Standards 没有确认的硬规则违反或值得额外抽象的坏味道。Spec 发现的两项已先红后绿修复并复审：

1. 从 workflow 成员合成的**真实会话**缺目录时，原实现误用纯占位成员的已知叶子豁免。现在只有没有真实 child address 的占位成员才可豁免，done/idle 均保护未知目录。
2. 用户展开后代聚合组后，祖先稍后结束会再次自动吞掉后代。现在在已有反向预序中将展开保护传至所有祖先，显式手动折叠祖先仍优先。

`tests/tasks-model.spec.ts` 从 43 项增加为 54 项，覆盖两种状态、目录就绪后恢复聚合、多层祖先、workflow 穿透、手动收回、兄弟隔离及 12000 层深链。两个原 workflow fixture 补充了已知空目录，不再把未知目录自动折叠当作正常前提。独立模型测试 54/54 通过，`pnpm typecheck` 通过。

## 真实浏览器

宿主精确钉 `@deepseek-ai/dsh@0.2.1-rc.1`；本机用已缓存 CLI，并核验 `--version`。全部通过 `scripts/e2e-context.sh --variant no-context --grep 'tasks graph'` 在全新 scratch profile 上挂载真实 tarball；没有调用模型，Agent 会话由仅测试用宿主 fixture 通过公开服务播种。

两个 tarball 都叫 0.28.0，必须按路径区分，不能按版本名或浮动 dist-tag 区分：

| 包 | 相对仓库路径 | SHA-256 |
|---|---|---|
| 修复包 | `dsh-better-sidebar-0.28.0.tgz` | `6a36a4854d291cb6aae7a56adaf37fb8a296f56d19a53ab093cd43e623ff39ac` |
| 基线包 | `.worktrees/tasks-baseline/dsh-better-sidebar-0.28.0.tgz` | `d40bd48d9b64fc7b546937e411fb1afc5f7d8b43bae0be4fcd5a98f2d7bdd668` |

### 完整交互回归

| 包 / Agent 数（不含根） | 结果 | 点击至完整节点数后两帧 | Long Task |
|---|---|---:|---:|
| 初始修复包 / 10（校准） | 通过 | 8.4 ms | 0 |
| 最终修复包 / 200 | 通过，201 节点 | 21.8 ms | 0 |
| 最终修复包 / 500 | 通过，501 节点 | 44.5 ms | 0 |
| 基线包 / 200 | **预期失败，复现原问题** | 平移后点击 60 秒仍为 2 节点，预期 201 | 未计时完成 |

通过内容包括：聚合卡完整计数 → 真鼠标背景平移 → 点击聚合展开 → 再平移 → 点击 Agent 打开详情 → Escape 关闭 → 手动折回聚合；pageerror 和 console error 均为空。10-Agent 校准包早于 Spec 边界修复，最终验收以 200/500 为准。

### 同口径纯展开测量

为避免旧包已知的拖后点击问题阻止性能采样，设置 `DSH_E2E_TASKS_MEASURE_ONLY=1`，只省略初次平移与测量后的交互，真实点击、完整节点数断言、两帧采样和错误断言仍为共同路径。这些结果**不能代替完整交互回归**。

| Agent 数（不含根） | 修复包 | 基线包 | Long Task（两版） |
|---|---:|---:|---:|
| 200 | 26.0 ms | 22.1 ms | 0 |
| 500 | 65.9 ms | 62.2 ms | 0 |

每格为一次真浏览器采样，不是统计中位；包含 React、布局、DOM、绘制和帧等待。两版数量级相近，**没有据此证明整页展开更快**。性能收益的明确证据是下节纯布局对照，不能把布局加速倍数外推到整页。

复跑示例（先 `pnpm build && pnpm pack`；`DSH_CMD` 指向已核验 rc.1 的可执行 CLI）：

```bash
DSH_E2E_CONTEXT_AGENTS=500 \
NODE_OPTIONS=--max-old-space-size=4096 \
DSH_CMD='/absolute/path/to/rc.1/dsh' \
TARBALL="$PWD/dsh-better-sidebar-0.28.0.tgz" \
bash scripts/e2e-context.sh --variant no-context --grep 'tasks graph'
```

测量模式另设 `DSH_E2E_TASKS_MEASURE_ONLY=1`；基线只换 `TARBALL` 为上表基线路径。Playwright 附件 `tasks-graph-paint.json` 保存原始 elapsed/cards/longTasks。最终浏览器原始附件保存在本机 `/tmp/tasks-browser-evidence.XPiy9D/`，日志为 `/tmp/tasks-final-*.log`；这些临时路径不是仓库发布产物。

## 纯布局基线对照

实际 UI 入口 `layoutTasksGraphForWidth(nodes, 360, 0.78)`，N **含根节点**。两版同一个 Node 进程导入，输入数组相同且运行前后 digest 不变；每 case/实现预热 8 次，11 个交错样本取中位，交替先运行修复版/基线版。平铺 parentId=root；深链每节点 parentId=前一节点。

| 节点数（含根） | 平铺基线 → 修复（ms） | 减少 | 深链基线 → 修复（ms） | 减少 |
|---|---:|---:|---:|---:|
| 501 | 1.916 → 0.271 | 85.86% | 11.196 → 0.358 | 96.80% |
| 1001 | 7.716 → 0.315 | 95.92% | 42.027 → 0.336 | 99.20% |
| 2001 | 14.549 → 0.590 | 95.95% | 174.334 → 0.770 | 99.56% |

单命令 `bash /tmp/tasks-layout-bench/run.sh`，exit 0。原始 11 样本、输入/source/bundle SHA-256 与运行环境在 `/tmp/tasks-final-layout-benchmark.json`。同机当时有浏览器验证，loadavg 约 12.5/10 核，绝对毫秒仅参考，结论基于同进程交错的相对中位。2000 个非根 Agent 的布局耗时至少减少 50% 的目标达成；布局坐标/顺序及深链安全由对应 spec 验证，不以计时 harness 代替行为测试。

## 拖拽渲染帧率（后续修复）

用户反馈任务页拖拽按鼠标回报率渲染。真机探针（Playwright + 真实 rc.1 预览，确定性 MutationObserver 统计画布 style 提交）在修复前测到：真实鼠标拖拽 **121 次 pointermove → 123 次画布提交**；用 MessageChannel 模拟高回报率鼠标（100 次移动全部落在两帧内）时 **约 98 次提交 / 4 帧**。图模式平移的 `pointermove` 每次都 `setTf`，没有合并，而同仓库的侧栏分隔条、浮窗 resize、编辑器 gutter 早已用 `createFrameBatcher` 合并到每帧。

修复沿用该既有模式：平移、浮窗标题拖动、锚定弹层拖动把最新位置写进 ref，每帧最多提交一次；`pointerup` / `pointercancel` 调用 `flushNow()`，最终位置不丢；点击抑制的 `travelRef` 仍在事件内同步更新。同探针复测：同一帧内 100 次移动的提交 **98 → 1 次**（2 帧窗口内 2 次提交）。新增 jsdom 回归 `tests/tasks-page.spec.tsx > coalesces background pans into one update per animation frame and flushes on release`，先红（帧前同步提交 72px）后绿；`tests/tasks-page.spec.tsx` 64/64、`tests/floating-window.spec.tsx` 与 `frame-batcher` 合计 76/76 通过。真实鼠标在无头 Chromium 中本就按帧派发，因此该场景前后提交数接近；判别性证据来自同帧突发。

## 既有 fs-watch 偶发失败

没有修改 watcher 或它的测试。首次全量失败后，独立复跑得到：工作树 18 轮，14 通过 / 4 失败；未改动的基点 worktree 12 轮，11 通过 / 1 失败。失败同为单次写入后 15 秒未收到 notice（spec 的断言行 50 或 111），基线也会复现，不能算本批引入的回归，也不能把这些失败记作通过。

依赖闭包的 diff 为空；纯 Node 的单次写最小探针 60/60 送达，仍不足以证明 vitest/macOS 组合下是事件丢失还是延迟。保留该风险，不为本任务修改无关生产逻辑或用重试掩盖失败。原始记录 `/tmp/tasks-resume-fs-watch*.log`。

## 最终门禁

- 已通过：`pnpm build && pnpm pack`、`pnpm check:consumer-types`、`pnpm check:engines`、`pnpm typecheck`、`pnpm lint`、`git diff --check`。
- 正常权限下默认并行 `pnpm test`：220 文件通过 / 1 文件失败，2718 passed / 1 failed / 17 skipped。唯一失败为上述既有 `fs-watch` 单次写入 notice 超时；未忽略或修改断言。
- `pnpm test --maxWorkers=1`：**221 文件全部通过，2719 passed / 17 skipped，exit 0**（110.89 秒）。包含 watcher 6/6、任务页 63/63、任务模型 54/54、布局 14/14。仅切换仓库已有单 worker 执行方式，没有跳过失败项、重写断言或更改测试预算；这次通过不代表既有 watcher flake 已修复。
- `pnpm test:mount`（精确 rc.1）：**13 passed / 4 skipped，exit 0**（2.7 分钟）。包含原生唯一终端条目、真实 xterm、tab sweep、页内重新注册、Git、文件树与稳态检查；4 个需要专门 Context profile/scale env 的用例按设计跳过，scale 完整回归已由上节专门 lane 独立验证。
- 初次受限沙箱运行的 npm cache/home-relative 临时文件 EPERM 不是产品失败；受限挂载的终端用例失败在正常权限下重跑通过，未修改终端代码。所有早期失败保留日志，不用后一次通过改写早期结果。
