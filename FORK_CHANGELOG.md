# FORK_CHANGELOG — 本仓库相对上游的本地主动改动

本分支（misutime/DSH-better-sidebar）从上游 `omdsh-dev/DSH-better-sidebar` fork，并做了一系列**本地决策性改动**。这些改动以我们的修改为准，同步上游时需以本节为准逐一保留/重放，避免被上游覆盖。

> 最新基线：本地 `0.12.2` + 下列三项本地功能；上游 `upstream/main` 当前 `0.13.0`（含编辑器-资源管理器合并、mermaid 预览、皮肤兼容、路径处理等上游更新）。

---

## 1. 侧边栏面板几何全局统一（PR #1）

**目标**：面板宽度与开/合状态跨会话全局一致（不再每个 session 各自记一份宽度）。

**改动**：
- `src/client/state.ts`：把 `SidebarState` 拆为「全局几何层」（`dsh-sidebar:v1:global`：`panelOpen/width/bottomOpen/bottomHeight/bottomOpenedOnce`）与「会话内容层」（`dsh-sidebar:v1:<sessionId>`）。
  - 全局几何为单一事实源；`store.reduce/reduceFor/update/setSession` 合成「全局几何 + 会话内容」。
  - `reduceFor`（定向 open 到非活跃会话）只写内容、不碰全局几何。
  - `sanitizeLayout` / `sanitizeContent` 分开校验；旧逐会话几何**不迁移**。
  - `setPrefs` 在 prefs 异步到位后重建尚未持久化的默认全局几何（修 prefs 竞态）。
- 结构：`GlobalSidebarLayout` + `SidebarContent`、`splitState`/`synthState`、store 的 `globalLayout` / `commitActive` / `commitTarget`。

**决策**：不迁移旧几何数据；宽度/开关按「全局 + 首次以 prefs 默认」处理。

---

## 2. 右侧主面板固定栏：`git` / `subagent`（PR #2 + 上游 0.13 调和）

**目标**：所有 session 右侧主面板固定两个稳定单面板 **Git + Subagent**，不可删除、不可拖出其固定位置、自动归置补齐；其余（editor 文件窗口 / 终端 / 浏览器 / 外部插件 / 多实例 editor）保持 per-session 浮动。

> ⚠️ **上游 0.13 调和（重要）**：
> - 上游 0.13 删除了 `explorer` tab、改为 `editor` 文件窗口（editor home，含内嵌文件树）。
> - 经探明并拍板：**editor 不固定**——它是按 path 的多文件窗口 + 原地/分栏切换的富类型，无法当简单固定栏；固定栏收敛为 **git + subagent**（两个干净的单栏类型）。
> - 因此 PR #2 原来的「固定前三 Explorer/Git/Subagent」→ 0.13 后为「固定 git + subagent」。

**改动**：
- `src/client/state.ts`：
  - `PINNED_TYPES`（0.13 合并后 = `['git','subagent']`）、`isPinnedType`。
  - `ensurePinnedTabs(state, tabsEnabled)`：跨右侧整棵树收集/去重固定实例，归置到承载固定组的 home pane 并重排到首位；剔除被掏空的重复 pane；尊重 `tabsEnabled` 禁用；已归置时返回原引用（幂等）。
  - `rotateHomeFirst`/`leafWithId`/`containsLeaf`：树重排 + 递归清理非 home 分支的空 pane；单 child 提升、杜绝零子节点 split。
  - store 的 `commitActive`/`commitTarget`/`setSession`/`setPrefs` 套用 `ensurePinnedTabs`。
- `src/client/service.ts`：`closeTab` 对右侧固定实例严格 no-op（底部同类型仍可关）。
- `src/client/Sidebar.tsx`：右面板 `Workbench` 传 `pinned`；+ 菜单不再列出固定类；`tabTitleOf` 只对固定类型回本地化 descriptor 标题（其余保留实例标题）。
- `src/client/TabBar.tsx` / `src/client/split-pane.tsx`：固定前三隐藏关闭按钮、禁用拖动；`getTabTitle`/`pinned` 透传。
- 测试：`tests/unit.spec.ts` 新增 pinned 相关 6 个用例（幂等/禁用/边缘分栏/嵌套清理/activePane 回退/sanitize round-trip）；`tests/e2e/mount.e2e.ts` 的 + 菜单扫荡改为只扫浮动类型。

**决策**：所有会话强制补齐前三 + 尊重「某类型禁用则跳过该栏」；不迁移旧面板结构。

---

## 3. Git（源代码管理）面板可见时自动刷新（PR #3）

**目标**：Git 面板在外部修改工作区时无需手动刷新即可近实时更新（解决"无法信任看到的源码状态"）。

**改动**：
- `src/client/GitView.tsx`：
  - 新增 `AUTO_REFRESH_MS = 5_000` 可见性感知轮询：仅当 git tab 为当前激活且面板打开（`visible`）且有会话时运行；不可见/切会话/卸载时清理并 abort 在途请求。
  - 轮询只刷 `gitStatus` + `gitBranch`（`history` 保持懒加载分页），`busy/loading` 时跳过。
  - **串行 setTimeout 链**：上一个 poll settle 后才调度下一个，同一时刻至多一个在途请求；慢 `git.status` 不会被周期性 abort 重发，不浪费 host 进程。
- `src/client/builtins/tabs.tsx`：git component 透传 `visible`。
- 保留 mount / 手动刷新 / 面板内操作后的 `refresh()`。

**决策**：采用方案 A（可见性感知的间隔轮询，5s）+ 串行调度；暂不做事件驱动（host 文件 watcher）方案。

---

## 4. 其它 / 说明

- 排序：自上游 `ecebc97` fork，提交顺序见 `git log upstream/main..origin/main`。
- 本地改动涉及的重叠文件（同步上游时需重点关注）：`package.json`、`src/client/state.ts`、`Sidebar.tsx`、`GitView.tsx`、`builtins/tabs.tsx`、`service.ts`、`TabBar.tsx`、`split-pane.tsx`，以及 `tests/unit.spec.ts` / `tests/service.spec.ts` / `tests/e2e/mount.e2e.ts`。

### 4.1 本次 0.13 合并附带的修复 / 边界决定

- **`src/client/EditorHost.tsx`「在侧边打开」**：修复跨树放置（原用 `treeOf(tab.id)` 会误落右栏，改为用 `leafWithTab` 分别扫两树定位 tab 所属 pane）、补 `isTabEnabled('editor')` 禁用门、移除多余 `treeOf` 导入。这是对上游新代码的**修正**，已保留。
- **mermaid（`src/client/mermaid.tsx`）**：恢复为**上游原版，不修**。上游 mermaid 用「DOM 手术替换 React 管理的 CodeBlock 子节点」实现，属上游新功能的**设计缺陷**（同一 root 下编辑源码会闪回/无法真降级）；按 fork 边界决策，本 fork **不为上游修 bug**，留待上游处理。若日后需要，可重写 mermaid.tsx 为 React 原生渲染。
- **测试改写**：为适配本 fork「固定注入 git+subagent」于 seed，改写 upstream 的 `prefs.spec` / `state.spec` / `editor-host.spec` / `service.spec` 中假定「仅 editor」的断言。

### 4.2 editor 文件窗口：树在左、编辑在右 + 分栏宽度全局共享

- **方向**：`EditorHost.tsx` 把 `editorTreeDock`（文件树）移到 `editorMain`（编辑/预览）**之前**（树在左、编辑在右）；CSS `.editorTreeDock` 改 `border-right`、resize 手柄置 `right:0`；拖拽方向反转为「向右拖变宽」。
- **宽度全局共享**：新增 `GlobalSidebarLayout.treeWidth`（存 `dsh-sidebar:v1:global`，与面板宽度同层），`splitState`/`synthState`/`sanitizeLayout`/`makeDefaultLayout` 一并携带；`EditorHost` 从 `store.state.treeWidth` 读、通过 `setTreeWidth` reducer 写全局。原 `tab.meta.treeWidth` 每 tab 记录废弃（仅 `treeOpen` 仍按 tab）。
- 常量 `TREE_WIDTH_MIN/MAX/DEFAULT` 及 `clampTreeWidth`/`setTreeWidth` 收敛到 `state.ts`。测试 `editor-host.spec` 改为断言全局 `state.treeWidth` + 新方向。

---

## 5. 同步上游的注意事项（给后续 AI / 团队成员）

同步 `upstream/main`（当前 0.13.0）是**大版本合并**，不是简单 pull：
- 上游对 `state.ts`/`Sidebar.tsx`/`GitView.tsx`/`tabs.tsx`/`service.ts` 做了大量改动（editor-explorer 合并、mermaid 预览、皮肤兼容、路径处理、新增 `dsh.plugin.json`、拆分 `unit.spec.ts` 等）。
- **合并时务必保留以上 1-3 节的本地方案**；上游同文件的更新需在其上「重放/调和」，而非用上游覆盖。
- 上游删/拆了 `tests/unit.spec.ts` 等测试；本地的 pinned/git 用例需迁移到上游对应测试文件。
- 合并建议在独立分支上做，逐冲突手工裁决，经本地 `pnpm install` + `pnpm test` + `test:mount` 全绿后再合入 main。
