# 自动激活落点修复：任务页回到 DSH 原生右侧栏

日期：2026-09-10　分支：`fix/auto-activation-native-landing`

## 背景

用户报告：**自动打开的侧边栏是底栏，而不是右侧边栏**。两个自动激活开关（`autoOpenSubagent` / `autoOpenJobs`）与子代理拓扑跳回在 v0.19.0 上把任务页（`subagent` tab）开进了插件自绘的**底部工作台**，底栏随之展开；而产品文案描述的是侧边栏落点——README 特性表「新子代理 / 新任务可自动激活任务页，**宽屏同时展开侧边栏**，窄屏不强制展开全屏抽屉」，`settingsSubagentDesc` / `settingsJobsDesc` 及全部 20 份词典同样措辞，README 的 #314 条目也写着「宽屏展开侧边栏，窄屏只准备 Tab」。

## 根因

`223b254`（v0.19.0-alpha.0「退役插件自绘右侧面板与自由窗口」）改写了 `src/client/sidebar/use-host-feeds.ts` 的三处触发：

| | 改动前（v0.18.x） | 改动后（v0.19.0） |
|---|---|---|
| 展开 | `store.reduce(s => s.panelOpen ? s : togglePanel(s))`（宽屏才展开） | 无（由落点决定） |
| 落点 | `activePane = firstLeaf(s.splits).id` + `openTab({ type:'subagent', title })` —— **无 `target`** | `openTab({ type:'subagent', title, target:'bottom' })` |

`service.ts:683` 的判据是「装了原生面 + 非 `bottom` → 落 DSH 原生右侧栏」，`target: 'bottom'` 直接绕过它走 `land = openTabInBottomPane`（`service.ts:744` → `state.ts:453`，置 `bottomOpen: true`）。也就是说：退役右侧面板时，`splits`（插件自己的右面板）消失，落点被改成了插件自己的**底**面板，而正解是当时同文件其它打开早已默认落上的新宿主——DSH 原生右侧栏。

## 决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 三处触发改回默认落点（`'right'`） | 宿主 `openContent` 内部 `planSetExpanded(state, true)`（`dsh-client-ui-sidebar-right`），打开即在同一步展开原生栏；这才是文案里的「侧边栏」 |
| 2 | 后台活动（子代理 / 新任务）在窄屏**停放**，不展开 | 宿主 `RightbarSeat` 有 `autoFullscreen = viewportWidth < 768`，该宽度下原生栏以 `position: fixed; inset: 0` 全屏绘制——展开即整屏抢占，正是 #373 修掉的行为。宿主没有「只放 tab、不展开」的公开选项，故开前读 `ctx.sidebarRight.isExpanded()`、开后 `toggleExpanded()` 收回；两次提交落在同一 React 批内，中间态不会渲染 |
| 3 | 停放仅在目标会话在屏时执行 | `isExpanded` / `toggleExpanded` 作用于**已挂载会话**（`mounted()` = `binding.surfaces[binding.sessionId]`）；目标不在屏时执行会误动用户当前那一栏 |
| 4 | 拓扑跳回（用户点击）一律展开 | 它是显式手势，不是后台活动；对齐 v0.18.x 跳回无窄屏门禁的语义 |
| 5 | 底部工作台自有流程保持 `target: 'bottom'` | 底栏 `+` 菜单（`Sidebar.tsx:628`）与首次展开自动终端（`:336`）本就该落底栏；`OpenTabSeed.target` API 不变 |

阈值一致性：插件既有 `NARROW_MAX_WIDTH = 768`（`width < 768`，`src/client/breakpoints.ts`）与宿主 `viewportWidth < 768` 的全屏规则逐字对齐，不引入第二个断点。

窄屏语义与 v0.18.x 等价：**tab 已就位、抽屉不展开**（用户点开会话头右侧的展开控件即可看到任务页）。

## 改动清单（子系统级）

| 子系统 | 文件 | 变更 |
|---|---|---|
| 触发 | `src/client/sidebar/use-host-feeds.ts` | 新增模块内 `activateTasksPage(ctx, sessionId, { background })`（落点 + 停放判定集中在此）；三处调用改为它（子代理 / 后台任务 `background: true`，跳回 `false`）；重新引入 `isNarrowWidth`；三段 docblock 与文件头同步 |
| 测试 | `tests/sidebar-auto-activation.spec.tsx` | 断言原生面收到 `openTab { kind:'subagent', revealIfOpened:true }`、底部工作台保持原状（未展开、未新增 tab）、窄屏停放次数（1 / 0）、宽屏与已展开栏不停放、去抖触发时读视口、跳回不停放 |

无 API / 持久化 / i18n / README 行为文案改动：文案本就在描述修复后的行为。

## 验证

- **回归守护（确定性）**：新 spec 10 passed；把 `src/client/sidebar/use-host-feeds.ts` 回退到 `HEAD` 后同 10 条**全红**（10 failed），证明它测的正是这次修复。
- **门槛**：`pnpm typecheck` / `pnpm lint` / `pnpm check:consumer-types` 干净；`pnpm test` = **124 files / 1299 passed / 9 skipped**（较基线 +3 条，即本 spec 的净增）。
- **打包挂载**：`pnpm build && pnpm pack && pnpm test:mount` = **7 passed**（真实 DSH 0.1.5-rc.1，scratch profile，不触碰用户 `~/.dsh`）。
- **环境事实（踩过一次）**：本机 PATH 上的 `dsh` 是 **0.1.2-rc.1**，用它跑挂载车道会在 `dsh plugin add` 后报 `dsh-better-sidebar 未出现在 dsh.profile.bundles 中——挂载未注册`（该版本不会把 `file:` tarball 注册进 profile bundles，且插件 peer 要求 `^0.1.5-rc.1`）。CI 装的是钉版 0.1.5-rc.1；本地需用同版本的 shim / `DSH_CMD` 才能复现车道结果。
- **真机**：见 PR 描述（3080 实例，web profile 换装新 tarball 后人工触发子代理 / 后台任务确认）。

## 未覆盖（诚实记录）

- 挂载车道是 keyless 的（无模型），无法真派生子代理或后台任务，因此**该行为只有单测是确定性证据**；宿主 `session/create` 的请求体不接受 `origin` / `parentId`，也无法用 RPC 造出 `origin: 'subagent'` 的子会话，所以真机断言只能依赖人工触发或非确定性的 prompt。
- 宿主若在窄屏自行折叠（`shown && !fullscreen && !canShow` 的 room rule），停放不会与之冲突（两者都指向「不展开」）。

## 不做

- 不新增设置项、不改变 `OpenTabSeed.target` 的语义、不把任务页改到别处承载。
- 不动底栏 `+` 菜单 / 首次展开自动终端（它们是底部工作台自己的流程）。
- 不改 DSH 源码（仓库硬约束 §1）。
