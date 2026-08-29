# 自由窗口（Free Window）设计文档

- 日期：2026-08-23
- 版本：v0.16.0
- 分支：`feat/free-window`
- 状态：已实现（本文含实施偏差记录）

## 1. 背景与目标

侧边栏的 tab 只能活在右面板 / 底面板的 pane 里。用户在主会话区域工作的同时想盯一个终端、一个文件或一个插件页面时，只能挤压面板宽度或来回切换 tab。

**目标**：把任一 tab 拖到主会话区域（conversation 列）上松开，它变成一个可自由移动/缩放的**自由窗口**，悬浮在会话区之上；随时可拖回侧边栏停靠或一键返回。

**非目标（KISS 排除项）**：

- 无四边/四角缩放（只有 SE 角）、无双击最大化；
- 浮窗单 tab（无内嵌迷你标签栏）；
- 停靠不支持 edge split（只 center 合并进目标 pane）；
- 无窗口数量上限、无磁吸/网格对齐；
- 窄视口（合并抽屉）禁用拖出手势（抽屉覆盖会话区，无处可放）；右键菜单入口仍可用。

## 2. 交互设计（用户视角）

| 手势/入口 | 行为 |
|---|---|
| 按住 tab 拖到主会话区域 | 会话列出现虚线提示浮层「松开以在自由窗口中打开」；松开 → tab **移动**（pane 中移除）为浮窗，默认 390×780（手机竖屏比例；创建时按视口钳制）居中于松点、钳入视口 |
| tab 右键菜单「移动到自由窗口」 | 同上，落点为会话列中心（右面板与底面板的 TabBar 共用组件，一处生效） |
| 浮窗头部按住拖动 | 移动窗口（pointer capture + rAF 直写 DOM + 松手提交 store）；拖到侧边栏 pane 上方时该 pane 高亮，松开即停靠（center 合并） |
| 浮窗头部右键 | 菜单：「回到侧边栏」（停靠到激活 pane）/「关闭」 |
| 浮窗右下角拖动 | SE 角缩放（≥320×200，锚定左上角，钳入视口） |
| 点击浮窗任意处 | 置顶（层叠顺序 = `floats` 数组序，末位最上） |
| 浮窗头部 X | 关闭该 tab（走 `closeTab` 正常流程：触发 `onClose`、释放终端 pty） |

刷新页面：浮窗随会话状态从 localStorage 原样恢复（tab + 几何）。

## 3. 状态模型（`src/client/state.ts`）

```ts
interface FloatWindow {
  id: string            // uid('float')，与 pane/tab/split 共享计数器
  tab: SidebarTab       // 移动语义：浮窗拥有 tab，pane 不再持有
  x: number; y: number  // 视口坐标（左上角）
  w: number; h: number
}
// SidebarState.floats: FloatWindow[]（数组序 = 层叠序）
```

新增纯 reducer：`floatTab`（两棵树定位 + 移除 + 清空折叠 + activePane 回落）、`moveFloat` / `resizeFloat`（钳制，no-op 返回原引用避免持久化搅动）、`raiseFloat`（移末尾，幂等）、`dockFloat`（目标 pane 缺省 activePane，stale 回落右树首叶）、`closeFloatByTab`、查找助手 `floatWithTab` / `floatById`。

**既有查找路径全部扩展到 floats**（一致性关键）：`tabOpenIn`、`patchTab`（updateTab，浏览器浮窗导航持久化 URL）、`openTabInActivePane` 的 id 安全网（命中 → raise）、`reconcileAgentTerminals`（浮窗 agent 终端随宿主列表消失则整窗移除）、`maxCounterId`（`float:N` 前缀参与 uid 播种，防 reload 碰撞）。

**sanitize**：`floats` 缺省 → `[]`；逐条宽容校验（id/tab 复用与叶子共享的 `sanitizePersistedTab`；几何非有限数或重复 id → 丢弃该条，不动整体布局）；几何钳入当前视口；diff/ephemeral tab 不持久化；`explorer` 旧类型在浮窗内同样迁移为 editor home。

## 4. 实现要点

- **拖出检测**（`Sidebar.tsx`，document 捕获层）：`dragover`/`drop`/`dragend` 捕获监听，以 `body[data-dsh-tab-dragging']`（TabBar 维护的 tab 拖拽标记）门控；目标在 `[data-dsh-panel-host]` 内则无视（pane 的 split/merge 自治）；在 conversation 列（`#root [data-slot="conversation"]` 父列实时 `getBoundingClientRect()`）内 `preventDefault()`（武装 drop）+ 显示提示浮层（同值 rect 跳过 setState，避免 60Hz 重渲染）；`drop` 读 `application/x-dsh-tab` payload 调 `floatTab(tabId, clientX, clientY)`。
- **FreeWindow**（新文件 `FreeWindow.tsx`）：头部/SE 角 pointer capture 拖拽——照抄面板拖拽的「rAF 直写 `style.left/top/width/height` + 松手提交 store + pointercancel/lostpointercapture 取 last-applied 兜底」模式；拖动中每帧对 `[data-dsh-pane]` 矩形命中检测，命中 pane 直接 DOM 打 `data-dsh-float-dock-over` 高亮（不经 React state，避免拖拽期全树重渲染）；松手命中 → `dockFloat(paneId)`，未命中 → `moveFloat`。jsdom 无 pointer capture API，取 `setPointerCapture?.()` 容忍模式（与 `EditorHost.tsx` 同款）。
- **服务层**（`service.ts`）：`closeTab`/`activateTab` 的浮窗分支；`openTab` 的 dedupeKey/id 匹配与生命周期分类纳入 floats——**聚焦浮动 tab = 置顶窗口**，且内容型打开不触发面板自动展开（浮窗与面板开合无关，恒可见）；`features` 追加 `'floatWindows'`。
- **渲染**：浮窗渲染在 `[data-dsh-panel-host]` 内（视口坐标、免疫壳层 transform 劫持），z-index 42（面板 40 之上、开关簇 45 与 DSH 浮层之下）；内容复用 `renderTab`/`TabContent`（每 tab RenderBoundary、memo），`visible` 恒 true。
- **样式**（`sidebar.module.css`）：全令牌驱动（`--dsw-alias-bg-layer-1` 表面、`--dsw-alias-border-l2` 边、`--dsw-shadow-lv3` 阴影、accent 虚线提示）；窗口盒无 transition（拖拽逐帧直写）；头部 `-webkit-app-region: no-drag`。
- **i18n**：`moveToFreeWindow` / `floatDropHint` / `dockToSidebar` 三键，19 语言词典全量同步（zh/en/ja 一致性由 `tests/locales.spec.ts` 守护）。

## 5. 测试

- `tests/state.spec.ts`（free windows 块）：reducer 语义（移动/清空折叠/钳制/幂等/停靠回退/未知 id 严格 no-op）、查找路径扩展、agent 终端浮窗移除、sanitize（缺省/逐条丢弃/几何钳制/uid 播种/round-trip）。
- `tests/service.spec.ts`（free windows 块）：dedupe 聚焦浮窗 = 置顶不展开面板、closeTab 关窗 + onClose、activateTab 置顶 + onActivate。
- `tests/free-window.spec.tsx`（新，jsdom 全 Sidebar 挂载）：拖出检测（提示出现/消失、drop 落位、无武装 drop 不浮动）、右键菜单浮动落点、头部拖动（rAF 直写 + 提交）、SE 缩放、拖到 pane 停靠（高亮断言）、X 关闭、reload 恢复。
- `tests/e2e/float-window.e2e.ts`（新，Playwright 真实 `dsh web`）：右键浮动 → 拖动移动 → reload 恢复 → 右键停靠回归；HTML5 拖出（提示浮层中拖断言）→ 终端浮窗 + 标签栏移除；全程无 crash 标记。

## 6. 已知取舍

- 浮窗头部同时承担「移动」与「拖回停靠」——统一为一种 pointer 手势（落点命中 pane 即停靠，否则移动），未用 HTML5 DnD（浏览器接管后 pointer 流中断，与顺滑移动冲突）。
- 停靠只支持 center 合并：从浮窗拖回不提供 edge split（KISS；pane 内拖拽仍支持全部分区操作）。
- 浮窗内 tab 被 `openTab` 再次打开时聚焦的是**浮窗**（置顶），不会把 tab 拉回 pane——窗口就是 tab 的「pane」。
- 窄视口下拖出手势禁用，但右键菜单入口保留（窗口钳入小视口仍可用）。

## 7. 实施偏差记录

- **portal 事件劫持拖拽（e2e 发现，jsdom 不复现）**：浮窗头部内嵌 `Menu`（portal 渲染到 `document.body`），但其 React 合成事件仍沿 React 树冒泡进头部的 `onPointerDown`——右键菜单行的**左键点击**会被误判为头部拖拽：`preventDefault` 吞掉行的兼容 mousedown，`setPointerCapture` 把后续 pointer 事件重定向到头部，行的 click 永不触发（「回到侧边栏」与 X 关闭在真实浏览器中双双失效）。修复：头部/缩放把手的 `onPointerDown` 加**同源守卫**——`event.currentTarget.contains(event.target)` 为假（portal 后代）或目标在按钮内（X）时直接返回。回归测试：`tests/free-window.spec.tsx`「a pointerdown on the portaled header menu must not start a header drag」。教训：任何承载 pointer 拖拽的表面，若其 React 子树里有 portal 覆盖层（菜单/弹窗），必须做 DOM 包含守卫——jsdom 合成事件不走这条路径，只有真实浏览器 e2e 能抓到。
- **e2e tarball 选择修复**（`scripts/e2e-mount.sh`）：缺省 tarball 解析原为 `ls | head -1`（字典序），仓库根残留旧版本号 tarball 时会把冒烟挂到**过期产物**上（本次 0.15.0 劫持了 0.16.0 的 lane，菜单项整体消失）。改为 `ls -t` 取 mtime 最新并在多候选时告警。
- e2e 细节修正：conversation 列须取 `[data-slot="conversation"]` 的**父列**（slot 包裹器零尺寸，`boundingBox()` 返回 null）；reload 后需重跑 DSH 首启 takeover 清场（takeover 在 settings join 后才挂载，须先有界等待再清）；提示浮层断言按 2 计（`[class*="floatDropHint"]` 子串命中浮层与其文案 label 两个节点）；拖拽后 reload 前留 500ms 让 store 的 200ms 防抖持久化落盘。
- 其余与本文一致。
