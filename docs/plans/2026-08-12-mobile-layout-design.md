# 移动端（窄视口 <768px）侧边栏布局设计

**日期**：2026-08-12
**状态**：已实施（本文档含实施偏差记录）
**目标版本**：v0.7.0

## 1. 目标

按**视口宽度**（<768px——"真正的移动端宽度"，刻意不对齐宿主 1024 断点）切换移动端侧边栏体验：

1. 移动端**不提供底部面板按钮**（右上角按钮簇只剩一枚右侧面板开关）。
2. **合并显示 = 只显示右侧栏**：进入窄屏时底部面板的标签页**直接并入右侧栏**（一次性状态迁移），右侧栏成为全宽抽屉，底部面板浮层整体不存在。
3. 附带移动端优化：新会话默认收起抽屉、文件/外链打开自动展开、宽度拖动条禁用、布局不挤压（抽屉悬浮）、窄屏标签收窄。

## 2. 非目标

- 不改持久化 schema：`bottomOpen` / `bottomHeight` / `bottomSplits` 字段原样保留。
- 不改桌面行为：≥768px 时双面板布局与之前完全一致（含布局挤压、拐角、底部首展自动终端）。
- 不改公开服务 API、PrefsSchema、host 半。
- 不处理 DSH 详情栏（宿主让步链在 <~996px 自动关闭详情栏，与本改动无交互）。

## 3. 现状回顾

- `Sidebar.tsx` 渲染两个独立浮层：右侧面板（全高、宽度可拖、布局挤压 `--dsh-sidebar-width`）与底部面板（只挤中间列、高度可拖、右上角按钮簇双按钮、共享拐角）。
- 底部面板状态字段：`bottomOpen` / `bottomHeight`（钳制 `[BOTTOM_MIN, innerHeight-PANEL_MIN]`）/ `bottomOpenedOnce` / `bottomSplits`（独立 split 树，pane/tab id 全局唯一）。
- 首次展开底部面板自动开终端（`bottomPanelAutoTerminal` pref）。

## 4. 设计

### 4.1 断点模块（新 `src/client/breakpoints.ts`）

- `NARROW_MAX_WIDTH = 768`；`isNarrowWidth(width)` 纯函数；`useNarrowViewport()` hook（初始读 `window.innerWidth`，resize + rAF 节流，`typeof window` 守卫；不用 matchMedia——jsdom 未实现）。
- CSS 侧配对 `@media (max-width: 767px)`（767 ≡ <768），两端注释互指。
- 刻意**不对齐**宿主 `SIDEBAR_AUTO_COLLAPSE = 1024`：1024px 窗口（小笔记本、分屏）保留桌面双面板；只有手机/竖屏平板才进移动布局。

### 4.2 合并 = 底部标签并入右侧栏（状态迁移）

- **新 reducer `migrateBottomTabs(state)`**（`state.ts`）：
  - 底部树所有标签按深度优先序**追加到右侧树第一个 leaf**（`firstLeaf(splits)`）的标签条；
  - 底部树清空（结构保留——桌面端回显欢迎卡片）、`bottomOpen=false`、`activePane` 指向右侧树第一个 leaf（保证迁移后新开的标签落在可见面板）；
  - 幂等：底部无标签且面板已关且 activePane 不在底部树时返回同一引用。
- **Sidebar 触发 effect**：`narrow && sessionId 已定义` 时执行（覆盖：窄屏挂载、会话切换、桌面→窄屏过渡）；幂等性保证其自然收敛，不循环。
- 迁移是**永久**的（符合"直接丢到右侧栏中"）：回桌面后标签仍留在右侧树，底部面板为空（欢迎卡片）；用户可在桌面重新往底部面板开标签，再进窄屏会再次迁移。
- 迁移后右侧栏用**现有 `Workbench` 原样渲染**——零视图层特判、零 action 路由修补（标签真实住在右侧树，close/activate/drag 全部走原路径）。

### 4.3 窄屏渲染（`Sidebar.tsx`）

- 面板宽度 `100vw`（全宽抽屉）；`--dsh-sidebar-*` 布局变量恒 0（抽屉悬浮，不挤压 AppFrame）；宽度拖动条、底部浮层、`bottomClose`、拐角、底部面板按钮全部不渲染。
- `visible` 语义回到原始：底部树只在桌面底部面板场景（`bottomOpen && active`）——窄屏下底部树为空且不渲染。
- 底部首展自动终端 effect 加 `narrow` 守卫。

### 4.4 行为修正

- `state.ts` `loadState`：窄屏加载一律以 `panelOpen=false` 开始（包括持久化布局恢复）；仅覆盖抽屉可见性，右侧/底部 pane、tab 与自由窗口状态原样恢复。宽屏仍按持久化值或新会话偏好决定展开状态。
- `service.ts` `openTab`：窄屏且 seed 带 `path`/`url` 且面板收起 → 自动展开抽屉（dedupe-focus 分支同样生效）；纯类型打开不展开；宽屏行为不变。

### 4.5 样式（`sidebar.module.css`）

- `@media (max-width: 767px)`：开放面板标签条预留宽度 72px → 40px（按钮簇只剩一枚）；`.tab` min/max 宽收窄（48/128px）。

### 4.6 测试

- `tests/breakpoints.spec.ts`：断点边界（767 窄 / 768 宽；1024 明确为宽）。
- `tests/unit.spec.ts`：`migrateBottomTabs` 4 例（并入第一 leaf 且底部清空/面板关/activePane 重指、右树为 split 时并入最左 leaf、幂等性、空底部树但 activePane 在底部树时重指）+ 窄屏新会话默认收起；`tests/state.spec.ts` 守护窄屏恢复强制收起且 pane / free-window 状态不丢，768px 宽屏仍恢复持久化展开值。
- `tests/service.spec.ts`：窄屏 auto-expand 5 例（390 < 768 仍窄）。

## 5. 边界情况

- 迁移触发：窄屏挂载 / 会话切换 / 桌面→窄屏过渡，均由同一 effect 覆盖；幂等保证收敛。
- 迁移后新开标签：`activePane` 已重指右侧树第一 leaf，`openTabInActivePane` 必落在可见面板（含"空底部树但 activePane 指向它"的陈旧指针场景）。
- 跨断点往返：迁移永久；桌面底部面板空显欢迎卡片；`bottomHeight` 不受影响。
- jsdom 兼容：hook 不用 matchMedia；既有测试 stub `innerWidth=1024` 自动走桌面路径，零行为变化。

## 6. 实施偏差记录

- **v1（已提交 b391ebf，用户反馈推翻）**：合并 = 单面板内上下堆叠两个工作台（`MobileWorkbench` + 可拖分隔条，高度复用 `bottomHeight`），断点 1024（对齐宿主）。用户明确：合并 = 只显示右侧栏、底部标签直接丢进右侧栏；窄屏 = 真窄屏、不对齐 1024。
- **v2（本文档，最终形态）**：删除 `MobileWorkbench`（组件 + CSS + spec），改为 `migrateBottomTabs` 状态迁移 + 现有 `Workbench` 渲染；断点 768。`bottomHeight` 不再参与移动端布局（仅桌面底部面板使用）。
