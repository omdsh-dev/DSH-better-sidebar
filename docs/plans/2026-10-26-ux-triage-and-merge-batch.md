# UX 分诊与 dev 合并批次（2026-10-26）

> **范围**：161 个 open issue + 88 个 open PR 全量过一遍（取数 2026-10-26 14:50，基线 `dev` `abfe133` / 最新发布 `v0.28.0`）。
> **落点**：13 个贡献者 PR + 3 个本地修复合入 `dev`；23 条 issue 关闭；4 个被取代 PR 关闭；3 个高影响 PR 留开并给出 review 结论。
> **一句话**：真正影响 UX 的是「宿主被 git 输出打崩、worktree/改名后静默写错文件、安装版本线错配、侧边栏入口/滚动在桌面壳与多插件下失效」四类；前三类已修，第四类确认根因在宿主。

---

## 一、扫描口径

| 维度 | 结果 |
| --- | --- |
| issue | 161（bug 32 · enhancement 59 · 文档/杂项 7 · 未打标签 63；66 条是最近 14 天新报告） |
| PR | 88（CLEAN 19 · UNSTABLE 17 · BLOCKED 8 · DIRTY 44） |
| 关联 | 41 条 issue 已有 open PR 引用 |
| 方法 | 全量结构分诊（标题/标签/正文/CI）+ 高影响条目代码与提交级核验；长尾旧 P3 未逐条复现 |

严重度口径沿用 [2026-10-11 分诊](2026-10-11-issue-triage.md)：S1 阻断 · S2 严重 · S3 明显 · S4 次要。

## 二、合入 `dev` 的 16 笔

### 2.1 贡献者 PR（13）

| PR | 主题 | merge |
| --- | --- | --- |
| #999 | `runGit` 输出上限加固（闩锁 / killTree / stderr 预算），病态工作区不再打崩宿主 | `c45cea1` |
| #1018 | >1000 分支时继续显示提交历史（#1013） | `2856662` |
| #929 | 改名/删除的页签调解覆盖后台会话；标题仅在派生自文件名时跟随（#915 后续） | `22eb6eb` |
| #956 | worktree 会话的根选择与地址基准（#947 / #950 / #952） | `8c08758` |
| #1020 | 导出 `dsh-better-sidebar/icon` 子路径（#1016） | `01f126e` |
| #1012 | 浮窗缩放手柄不再被 tab 内容压住 | `042ae22` |
| #965 | 编辑器刷新后保留阅读位置 | `ad078e4` |
| #1002 | 草稿插入不再整份重写、chip 不被展平（#1000） | `f74369d` |
| #1052 | 选区「添加到对话」改引用 chip（与 #1002 同一插入面，#1052 为准） | `25fd296` |
| #1057 | 页签 scope 按内容稳定，消除无关重渲染导致的整文件重读 | `01a6fa5` |
| #981 | 关闭侧聊页签时归档其会话（#942） | `5311467` |
| #1055 | Markdown 本地链接的 Windows 反斜杠归一（#1037 根因） | `6b4f965` |
| #1053 | 右栏展开时保留底部工作台入口（#989 / #992 / #290） | `1eeec0c` |

裁决记录：

- **#1002 vs #1052**：两者都改 `conversation-draft.ts` 的插入路。以 #1052（较新、直连宿主 `insertReference` facade）为准；#1002 的文档与 CHANGELOG 保留。合并后 5 个直接相关 spec 79 例通过。
- **#1002 的 mount e2e 与 #1052 语义冲突**：第一次 push 后 `plugin-mount` 在真实 DSH 上红——#1002 的 e2e 仍按「多行选区是 plain-text 围栏」断言 3 chips，而 #1052 把选区改成第 4 枚引用 chip（正文只在发送时展开）。已按 #1052 语义更新该 e2e（第 4 枚 chip 落地、label 带来源文件、不产生 plain-text reference；围栏载荷由 `tests/selection-payload.spec.ts` 钉住），并用真实 DSH `0.2.1-rc.1` 跑 `scripts/e2e-mount.sh --grep` 验证 1 passed。
- **#1053 vs #1019**：#1019 的方向（去掉 500ms 采样）与稳态目标一致，但当前 CI 在 `tests/steady-state.spec.tsx` 红（入口改经宿主 slot 挂载后 500ms 表计数需重锚），且隐藏时拆观察者与「不停事件驱动刷新」冲突、observer 未合帧。UX 部分由 #1053 覆盖；#1019 建议拆成纯 perf PR。
- **#1055 vs #1048**：#1055 在渲染前修根因；#1048 的候选路径探测是 ENOENT 后补救，另加错误视图与 21 份 i18n。已合 #1055；#1048 建议 rebase 后拆成精简错误 UX PR。

### 2.2 本地修复（3）

| issue | 修复 | merge |
| --- | --- | --- |
| #983 | 提交图显示 tag：独立 `refs/tags/` 库存、annotated peel、5,000 条 / 8 MiB 预算、tag 清单入分页指纹 | `a1dd6b0` |
| #1059 | 「仅 mtime 变化」不再死锁 `fs-conflict`：基线跟随 mtime；文本未变时 Reload 就地更新基线并保留草稿 | `73fed16` |
| #992 | 桌面壳兜底入口避开标题栏左侧系统按钮（darwin 88px 下限；无空位时接受内容重叠、不隐藏唯一入口） | `fd8a09d` |

## 三、关闭与回复

### 3.1 已随 `v0.26.0` / `v0.28.0` 发布（5 条，`completed`）

`#826` `#898` `#899` `#900` `#914` —— #901 / #912 / #916 均确认在 `v0.26.0` 内，评论带文件与测试证据。

### 3.2 版本矩阵 / 安装渠道 / 第三方（16 条，`not planned`）

- 版本拒绝 5 条：`#1046` `#1017` `#1005` `#998` `#1034`（宿主低于 `^0.2.1-rc.1`；给出「升级宿主或固定 0.26.1」矩阵）。
- 无日志安装失败 3 条：`#1028` `#1022` `#1021`（同时提示版本矩阵，邀请带 `pnpm.log` 重开）。
- git+https 渠道 3 条：`#1049` `#1047` `#996`（本仓库按市场约束不提供安装期构建脚本，git 源结构性不可用）。
- `#980`（插件 0.26.1 + 宿主 0.2.1 → 405，版本错配）、`#906` `#931`（v0.28.0 已改用 `ctx.connection.requestRejection`）、`#987`（桌面壳 `dsh-app://` 丢 POST，上游问题）、`#1060`（无关通知）。
- 留开：#1007（宿主 v0.2.1-rc.2 与插件兼容，属真安装失败，等日志）、#994（桌面版起不来，缺插件版本/日志）。

### 3.3 根因在宿主（2 条，`not planned`）

`#1056` `#978`：宿主包 `@deepseek-ai/dsh-client-ui-sidebar-right` 的 guide 容器没有 `overflow-y:auto`，外层 panel `overflow:clip`；插件只注册条目、不拥有容器几何。已附证据并指向上游。

### 3.4 被取代的 PR（4 条，`not planned`）

`#970` `#971` `#979` `#905`：dev 的 v0.28.0 适配已落地（`inject` 不再要求 `webRuntime`，准入走 `ctx.connection.requestRejection`），这些 CONFLICTING 分支不再需要。

### 3.5 留开的 review 结论

- **#1040（needs-changes）**：① 普通语法错误也触发全局 `frameUnavailable` 熔断；② 双向消息未绑定 `event.source` / schema。修好前不合入。
- **#1019**：拆纯 perf PR（回退 fallback/CSS，补 steady-state 重锚与 rAF 合帧）。
- **#1048**：rebase 后拆精简错误 UX PR。

## 四、验证证据

| 门禁 | 结果 |
| --- | --- |
| `pnpm typecheck` | 每批与最终均通过 |
| `pnpm lint` | 通过 |
| `pnpm test` | 最后一次全量：231 文件 / 2 831 用例通过（17 skipped）。此前两次全量分别出现 1 个未定位失败与 `tests/archive.spec.ts` 的 4 个 FileHandle-GC unhandled error（本机 Node 26 全量并发；该 spec 单跑 29/29 通过）；D 批新 spec 连续 5 轮 55/55 稳定。CI 为 Node 22，以 push 后的 `ci` 为准 |
| `pnpm build` + `pnpm check:consumer-types` | 通过 |
| 定向 spec | D 批修复：`git-graph*` / `text-editor-save-baseline` / `editor-conflict-reload` / `dock-fallback` 等 86 例通过 |
| push 后 CI | 第二次 push（dev `6e29d91`，run [40287155113](https://github.com/omdsh-dev/DSH-better-sidebar/actions/runs/40287155113)）：**`ci` / `ci-windows` / `plugin-mount` 全绿**。第一次 push（`c7d0e12`）`plugin-mount` 因 #1002/#1052 的 e2e 语义冲突红，修复后复跑通过 |
| 未在本地跑 | `test:windows`；`test:mount` 只跑了定向 `--grep` lane（真实 DSH `0.2.1-rc.1`，1 passed），全量 mount 与 Windows lane 由 push 后的 CI 覆盖 |

## 五、未做 / 后续

- 看板（Projects v2）未同步：本轮不动排期，只执行已批准的 A–E 批次；`fixed-pending-release.json` 已更新为 `[915, 983, 992, 1059]`。
- README 兼容警告已更新为「截至 2026-10-26，DSH npm `latest` = 0.2.1-rc.2」并保留旧宿主固定 `0.26.1` 的指引。
- 长尾旧 P3 与 30+ 个 DIRTY 老 PR 仍按 backlog 处理；需要时再逐簇开子代理。
