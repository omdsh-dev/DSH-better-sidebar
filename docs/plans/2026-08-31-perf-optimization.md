# 侧边栏性能优化 + 底栏拖拽布局突变修复

**日期**：2026-08-31（2026-09-01 rebase 到 main c199212 并在 alpha.3 上复测）
**状态**：已实施（分支 `feat/sidebar-perf`，单 PR 多 commit）
**目标宿主**：DSH v0.1.2-alpha.2 起开发，宿主参考 `/Users/menghuan/Code/deepseek-harness`（只读）；main 已切 alpha.3（v0.18.1-alpha.0），rebase 后在 alpha.3 真机全量复测（§3.1）
**测量环境**：macOS arm64 本机，真实 `dsh web`（npx 钉版）+ scratch profile 挂载 tarball，Playwright Chromium 无头，每指标 3 次取中位数（`tests/e2e/perf.e2e.ts` 输出 `PERF_JSON`）。

## 1. 修复的 bug：底栏拖拽引发原生左侧边栏突变

**症状**：右侧面板关闭时拖动底栏 resizer，DSH 原生左侧边栏突然折叠/跳动；松手后弹回。插件自己的右侧边栏不受影响。

**根因**（源码级定位，`Sidebar.tsx`）：底栏拖拽的 `applyDrag` 把「持久化的右栏宽度偏好」（如 400px）无条件写进 `--dsh-sidebar-width`，不看 `panelOpen`；而静止时的 push effect 走 `layoutPushSize` 门控（面板关闭 → 0）。于是拖拽首帧该变量 0 → ~400px：

1. `layout.css` 的 `#root { margin-right; width: calc(100% - …) }` 瞬间挤掉宿主 400px（拖拽期间 transition 被 `body[data-dsh-sidebar-dragging]` 关闭——瞬跳而非动画）；
2. 宿主 `AppFrame` 的 ResizeObserver → `setViewport` → viewport 跌破 1024px 断点 → `computeColumns` 把原生左栏折叠成 56px rail（0.3s grid 轨道动画）；
3. 松手 `commitDrag` → store 提交 → push effect 又写回 0 → `#root` 弹回 → 左栏再展开。

插件右栏在 `#root` 之外的 `document.body` fixed 层（`[data-dsh-panel-host]`），几何上碰不到——这正是「左栏突变、右栏无恙」的不对称来源。底栏是**唯一**在 `panelOpen === false` 时可达的拖拽（宽度/角点拖拽都要求面板开着），所以只有它触发。`abortDrag` 路径此前已修过（走 `layoutPushSize` 门控），move/up 路径漏网。

**修复**：`applyDrag` 里 `writeGeometry` 的 width 实参加上与 push effect 一致的门控（`!narrow && panelOpen ? min(width, vw) : 0`）；面板 DOM 写入（`panelRef`/`bottomRef`/`lastDragSize`）保持原始 width（底栏 `right` 定位派生自它）。

**验证**：e2e 回归（`drag-layout.e2e.ts`）——右面板关闭 + 底栏打开拖 strip，逐帧断言 pushed width 恒 0、宿主 grid 模板 / 左栏渲染宽度 / `#root` 右边缘全程不变。旧代码上实测泄漏 504px（红），修复后通过（绿）。

## 2. 性能改动清单

| # | 改动 | 类别 | commit |
|---|---|---|---|
| 1 | boot 路径 `loadPrefs` + `loadExternalDisable` 合并为一次 `settingsGet`（原来同文档串行拉两次，第二个无超时——settings RPC 挂起则侧边栏永不出现） | 启动 | perf: cut the boot and poll overhead |
| 2 | GitLens 2s silent 轮询不再每 tick 重列 worktrees（每 tick 少 spawn 1 个 git 进程；每 15 tick ≈30s 才重列+自动选择一次） | 运行时开销 | 同上 |
| 3 | ChangesTab 的 `extractFileOps` fold 从「每 poll 两遍（badge 一遍 + render 一遍）」改为每 poll 一遍、结果进 ref 共享（4000 条事件 × 每条 JSON.parse） | CPU | 同上 |
| 4 | SideChat 转录行引用复用：`transcriptRows` 接受上次结果，位置对齐内容相同的行复用旧对象——2s 轮询只重渲染变化的尾部（原来全部行连同 markdown 重解析每轮重渲染） | 渲染 | perf: stabilize renders |
| 5 | FileTree `expanded`/`revealed` 数组 → Set（原来每行 `includes()` 线性扫描，整树 O(rows×expanded)） | 渲染 | 同上 |
| 6 | `buildNewTabOptions` 从两处 JSX 内联调用改为共享 memo（原来每次 render 两个新数组，击穿 LeafView 的 props 比较） | 渲染 | 同上 |
| 7 | DiffPane 高度拖拽、TerminalView ResizeObserver 走每帧批处理（原来每 pointer/resize 事件一次 setState / 一次含字形度量的 fit()）；SessionLens 的 `new Blob().size`（整段编辑内容的 UTF-8 编码）从每行每 render 移到每变化一次的 memo | 渲染 | 同上 |
| 8 | 19 个非 zh/en 字典移入 lazy `locale` chunk（`lib/client-locale.js`，仅安装 better-locale 时按需拉取；核心包只留 zh/en——`t()` 本来也只查 zh/en + override store） | 启动体积 | perf: move the 19 dictionaries |
| 9 | 底栏推挤锚点从 `:has(> [data-slot=conversation])` 换成 shell 定位器打的 `[data-dsh-center-col]` 标注（`:has()` 匹配缓存随流式聊天的 #root 子树变动不断失效，每次布局推挤帧全文档重估） | 拖拽帧成本 | perf: tag the center column |
| 10 | TextEditor 不再每键 `doc.toString()` 全文字符串化进 React state（O(docLength)/键）；listener 只翻 dirty，进预览/换文件时从 live view 快照一次；保存本就现读 | 编辑 | 同上 |

## 3. Before / After 对比

测量说明：`mount-sweep` = 冷导航 → 插件挂载 → 展开面板 → 依次打开全部 6 个内置 tab；`bottom-drag` = 面板关闭 + 底栏打开时拖 12 步的 rAF 帧间隔。同机同夜连续跑，数字用于相对比较而非绝对承诺。

| 指标 | before（main d70db8f） | after（本分支） | 变化 |
|---|---|---|---|
| 挂载时延（navigationStart → host attach，中位） | 376.9 ms | 272.9 ms | **-28%** |
| 挂载+扫 tab 期间 longtask 数 / 总时长 / 最长 | 2 / 161 ms / 96 ms | 2 / 146 ms / 84 ms | 总时长 -9%，最长 -13% |
| 核心 client.js 体积（未压缩） | 1.46 MB | 0.80 MB | **-45%** |
| 宿主聚合 client bundle 传输量（含全部插件，gzip） | 1,436,478 B | 1,233,778 B | **-203 KB / -14%** |
| 宿主聚合 client bundle 解码体积 | 5,136,894 B | 4,497,363 B | -640 KB（即字典总量，吻合） |
| 侧栏 shape 的资源请求数 / 其中 settings.get | 20 / ×4 | 18 / ×2 | boot 合并生效 |
| 底栏拖拽帧间隔 p50 / p95 / max | 8 / 10 / 11 ms | 8 / 10 / 11 ms | 持平（本就不掉帧；修复的是布局突变） |
| 底栏拖拽 pushed width 泄漏（右面板关闭时） | **504 px**（bug） | **0 px** | 修复 |

### 结构性收益（不随单次测量波动）

- **核心 bundle**：19 个字典（源码 ~640KB）出核心包，`client.js` 1.46MB → 822KB（构建产物实测）。绝大多数会话（未装 better-locale）永远不拉 `client-locale.js`（gzip 171KB）；装了的用户按需拉一次（HTTP 缓存 + ETag 复用）。
- **boot RPC**：settings 文档从 2 次串行 → 1 次；`loadExternalDisable` 有了 2s 超时兜底。
- **GitLens 轮询的 git 进程 spawn**：每分钟 60 个（2 个/tick × 30 tick）→ ~34 个（1 个/tick + 每 15 tick 多 1 个），-43%。
- **ChangesTab fold**：每 2.5s poll 的 fold 次数 2 → 1（每次 fold 对至多 4000 条事件逐条处理、tool/call 还要 `JSON.parse`）。
- **SideChat 转录**：内容未变的行不再重建对象 → 下游 React reconcile + markdown 解析 + DOMPurify 全部跳过（引用稳定性由 `sidechat-transcript.spec.ts` 契约钉住）。
- **TextEditor**：每次按键的 O(文档长度) 字符串化 + shell 重渲染 → 0（仅 dirty 布尔）。

### 3.1 alpha.3 复测（rebase 到 main c199212 之后）

main 在本分支开发期间合入了 alpha.3 适配（peer `^0.1.2-alpha.3`，v0.18.1-alpha.0）与 sidechat 渲染升级（新增 `turnSummary` 行 kind 与 tool `card`——`rowsEqual` 已补齐两者，card 只在 tool/result 落地时变化、被 `executing`/`failed`/`resultText` 的比较覆盖，无需值比较）。rebase 后在 alpha.3 真机重测（同法 3 次中位，before 侧 = main c199212 代码 + 本分支的测量工具）：

| 指标 | before（main c199212） | after（本分支） | 变化 |
|---|---|---|---|
| 挂载时延（中位） | 372.3 ms | 316.5 ms | **-15%** |
| longtask 总时长 / 最长 | 170 / 100 ms | 165 / 96 ms | -3% / -4% |
| 宿主聚合 bundle 传输 | 1,456,668 B | 1,246,595 B | **-210 KB / -14%** |
| boot settings.get | ×4 | ×2 | 合并生效 |
| 底栏拖拽 pushed width 泄漏 | **504 px**（复现） | **0 px** | 修复 |

全部收益在新 main 基线上成立；完整 mount lane（17 测试）在 alpha.3 真机全绿。§3 主表为 alpha.2 上的原始测量记录（两端同宿主，对比自洽），保留作历史基线。

## 4. 守护

- e2e：`drag-layout.e2e.ts` 新增底栏回归（宿主布局全程静止）与 center-col 标注断言（恰一节点、为 conversation slot 的父级）；`perf.e2e.ts` 的 width-leak 断言在每次测量 lane 里复检。
- 单测：`prefs.spec.ts`（boot 决策单次 fetch）、`sidechat-transcript.spec.ts`（行引用复用契约）、`locales.spec.ts`（chunk 内全部字典 key-set 与 zh 一致）、`layout-css.spec.ts`（锚点选择器契约，禁 `:has` 回潮）、`bundle-route.spec.ts`（chunk 清单含 locale）。
- 完整 mount lane（17 测试）在本分支全绿（alpha.2 与 alpha.3 真机各跑一轮）。

## 5. 明确不做（取舍）

- `pinnedEntries` 的 store 版本号改造、连续 `store.reduce` 合并：侵入 store API，收益不明确，KISS 取舍。
- FileTree / SideChat 列表虚拟化：Set 化 + 引用复用后若真实负载仍不达标再立项。
- `e2e-mount.sh` 的 `command -v "$DSH_CMD"` 对带空格命令失效（回退未钉版本的 npx）是**宿主侧脚本的既有行为**，本地以 `DSH_CMD=/tmp/dsh-alpha2.sh` 包装脚本绕过，不改脚本（CI 全局安装钉版本，不受影响）。
