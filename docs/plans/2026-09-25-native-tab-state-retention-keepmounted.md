# 原生 tab 的状态保留：宿主 `keepMounted` + 按会话记账（PR #712 的重做）

日期：2026-09-25　分支：`fix/712-keepmounted-native-state`

> 本文取代 `2026-09-17-native-tab-state-retention.md`（PR #712 的 park/归档方案）。
> 目标不变（#636 跨会话失灵 / #661 切 tab 丢状态 / 切回会话清零），
> 但 DSH 0.1.7 的 `SidebarRightTabDefinition.keepMounted` 让宿主承担了「保活」，
> 插件只剩两件事：**按会话区分身份**、**记录活过 body 的卸载**。

## 背景

#712 收录的三组症状：**#636** 切会话后文件浏览器点不动；**#661** 同会话切 tab
丢状态（树展开集、就地打开的文件、chip 标题）；**切回会话清零**。

## 事实（DSH 0.1.7-rc.1；源码 + 真机实测）

| 事实 | 出处 / 证据 |
|---|---|
| `keepMounted` 是 tab **类型**上的可选字段：被标记的 body 首次显示后**跨隐藏、切 tab 保持挂载** | `ui-sidebar-right/src/client/tab-registry.ts`；真机日志：同会话切 tab 全程无 `drop`/`mint` |
| 切 tab 后展开集、滚动位置、chip 标题全在 → **组件态也不需要插件自保** | `tests/e2e/tree-scroll.e2e.ts` 的 tab-switch 三条断言（真机通过） |
| 切换会话时 body 曾被重挂（`drop A::tab3` 紧跟 `mint A::tab3`）——**根因是插件自己**（见下），修掉后同一会话/跨会话都只隐藏不卸载 | 插件侧 `console.debug` 痕迹 + 页面阶段标记交错（见 §验证） |
| 原生 tab id **每会话各自计数**（`tab1`…）→ 保留的多会话同号并存 | `dsh-client-ui-sidebar-right` 的 `createSurface()` 计数器；`keepMounted` 之后常驻 |
| 非活动体用 `display: none` 隐藏；Chromium 恢复显示后 `scrollTop` 回原值 | `ui-dockkit` 的 `.tabCell[hidden]`；本地探针 320 → 0 → 320 |
| `ISidebarRight.mounted` 是「哪个会话在屏」的唯一诚实来源 | 0.1.7 新增；main 已在 `surface.ts` 接线（§3.3 第 9 条） |

**根因二：插件自己的接管类型抖动**（本次一并修掉，也是「状态为什么过不去会话」的真答案）

`src/client/native/index.ts` 的 `sync()` 用「描述符清单」比对 live 注册表，而 `files`
接管不是描述符（键是 `FILES_KIND`）——于是**每一次 store/service 通知**（会话切换、
改设置、任何 state 变更）都会把它注销再重建：

```
[mark] switching-to-B  48675
[native] DISPOSE type dsh-better-sidebar:files  48736   ← 插件自己注销
[native] register type dsh-better-sidebar:files 48736   ← 立刻重建
```

注销即意味着该 kind 的 body 被卸载，于是**只有记录活下来、组件态（树滚动、草稿所在的
视图）必然重建**。修法：清理循环跳过 `FILES_KIND`，它的寿命只由「编辑器类型被关闭」
决定。修掉之后，同一次真机 lane 里跨会话的 `scrollTop` 从 0 变回 320（e2e 已固化为断言）。

> **归属更正（rebase 到 #777 之后）**：清理循环里那句
> `if (descriptorId === FILES_KIND || wanted.has(descriptorId)) continue` 是 **#777**
> （`4099700`）落进 `main` 的行——它同时修掉同一个循环的另一个后果（teardown 期间重建
> 把该 id 孤儿化，见 `2026-09-28-native-files-takeover-reload-leak.md`），所以本 PR
> rebase 后不再带那行代码，只保留上面这条设计与锁住它的回归 spec
> （`tests/native-surface.spec.ts` 的「keeps the files takeover registered across a
> Session switch pulse」：撤掉该守卫即红）。

> **合并最新 main 之后的分工（v0.24.1 / DSH 0.2.0-rc.1，2026-10-01）**：展开集这条线
> `main` 已经用**另一条路**实现了——`5c95002` 把展开集搬进插件 store 的会话状态
> （`attachStore` / `syncExpanded` / `getSessionStates().expanded`，由 `native/index.ts`
> 绑定），于是本 PR 与它重叠的那半（「记录自己持有展开集」）**整体让给 store**；本 PR 只留
> **身份**：`views` 键为 `sessionId::tabId`，`get/has/update/drop/versionOf/retain` 收 seat
> 会话，`toggleExpanded(sessionId, id, path)` 用 seat 定位记录、写入 **scope 会话**的状态
> （沿用 main 的 active-`reduce` / background-`reduceFor` 分流）。body 卸载不再
> `records.drop`、两个 `tabs.register` 带 `keepMounted: true`，仍由本 PR 负责。两套持久化
> 并存会互相打架，所以只留一条权威。

**两条推论**（都经真机验证）：
1. `keepMounted` 一旦打开，插件原先的前提「宿主同一时刻只挂载在屏会话的 body」
   不成立——A 与 B 的同号 tab 同时活着，所以键必须是 `sessionId::tabId`。
2. 记录的寿命**不能绑在 body 上**：body 仍可能被宿主重挂（类型注销、会话销毁路径）；
   记录只由「原生 tab 关闭」与「会话消失」回收。

## 决策

| 维度 | #712（park/归档，被取代） | 本方案 |
|---|---|---|
| 同会话切 tab 的保活 | 插件自建 `parked` 归档 + 停/取回 | **宿主 `keepMounted`**：body 不卸载 |
| 身份 | 裸 `tabId` 单键（前提：同时只有一个会话在挂载） | **`sessionId::tabId` 复合键** |
| 记录寿命 | 活到宿主关 tab（卸载不删）——方向正确 | 同：活到 `surface.close` / 会话消失；**卸载不删** |
| 跨会话取回 | 归档 + 显式取回（`ensure` 里判会话） | 不需要：复合键的 `ensure` 天然命中自己的记录 |
| 组件态（滚动/草稿/commit/worktree） | module-level 记忆（4 处 + 3 个 spec） | **不需要**：body 一直挂着（切 tab 与切会话都是，真机已验证滚动） |
| 会话消失 | `retain(liveSessions)` 驱逐归档 | 同：驱逐复合键记录 |
| 公开写面 | 不动签名 | `update/has/activate` **新增可选 `sessionId`**；缺省按在屏会话解析，歧义时拒绝而不是猜 |

**被推翻的 #712 教条**：它的 §不做第 3 条写「不做 keep-alive 式的隐藏而不卸载——
宿主『一 pane 一 body』的挂载模型在宿主侧，插件无法单方面改变」。0.1.7 把这个开关
（`keepMounted`）交到了 tab 类型手里，于是这一半由宿主实现，插件只留身份与寿命。

## 改动清单

| 文件 | 变更 |
|---|---|
| `src/client/native/index.ts` | 两个 `tabs.register` 加 `keepMounted: true`；title 槽 `inject` 带 seat `sessionId`（chip 渲染早于 body，且各会话同号并存）；**`sync()` 清理循环跳过 `FILES_KIND`**（否则每次会话切换/通知都重建接管，body 被重挂） |
| `src/client/native/tab-adapter.tsx` | `viewKey(sessionId, id)`；`ensure` 收 `sessionId`（seat）并与 `scope.sessionId`（内容命名空间）分开；`get/has/update/drop/toggleExpanded/versionOf` 收会话；新增 `retain(sessions)`；**删除 body 卸载清理** |
| `src/client/native/surface.ts` | `close` 按会话读写；`update/has/activate` 支持显式会话（缺省按在屏/唯一命中，歧义 → false）；会话列表变化与会话绑定时驱逐消失会话的记录 |
| `src/client/service.ts` | `updateTab(tabId, patch, sessionId?)`；`activateTab` 传 `scope.sessionId`；`SidebarSurface` 三个方法新增可选 `sessionId` |
| `src/client/{EditorHost,SideChatView,tree-mutations}.tsx/ts`、`changes/ChangesTab.tsx` | 6 个 `updateTab` 调用点带上自己的会话 |
| **不采用** | #712 的 `parked` 归档、`FileTree` 滚动记忆、`TextEditor` 草稿归档、`GitLens` commit/worktree 记忆（约 200 行 + 3 个 spec） |

## 验证

**单测**（`tests/native-surface.spec.ts`，+9）：会话隔离 3（同号会话互不继承 / 按会话
patch 与 drop / `retain` 驱逐并通知）、表面解析 4（显式会话 / 缺省按在屏 / 歧义拒绝 /
close 只清一个会话 + 死会话驱逐）、同屏双 seat 组件级 1（互不继承、互不覆盖、
**卸载不忘状态**、重挂载取回自己的展开集、只有 `drop` 才忘）、接管寿命 1 条
（**会话切换的脉冲不得重建 `files` 接管**；回退该修复该用例即红：`expected 2 to be 1`
——`2` 就是被重建的注册次数）。

**真机**（`tests/e2e/tree-scroll.e2e.ts` → `scripts/e2e-mount.sh`：npm 打包 → 全新
scratch profile → 真实 `dsh web` 钉 0.1.7-rc.1 → headless Chromium）：同会话切 tab
保住展开集/滚动/chip；**新建一个会话**后 B 不继承 A 的展开集与滚动；回到 A 时
展开集、**滚动位置**与 chip 复原。**1 passed (1.1m)**。

**同一根因下的 mount lane 适配**：`tests/e2e/mount.e2e.ts` 原先用
`getByRole('tab', { name: /Side Chat/ })` 重新激活侧边对话 tab——那条断言只在
「切 tab 丢记录 → chip 回退到打开时的标题」时才成立。记录不再丢之后 chip 显示
线程名，改经指南条目（`[data-sidebar-right-guide-entry="sidechat"]`）打开。
（#712 已记录过同一处改动。）

**顺带修掉的 e2e 缺陷**（#712 的 lane 一直没真的切过会话）：原写法按行号点「第二个
会话」，而会话树的 treeitem 里**第一行是 workspace 行**，且**没有消息的种子会话根本
不占行**——那次「A → B → A」实际是重选同一个会话，三条断言天然为真。现在按
`data-row-key="session:<id>"` 认会话、用 rail 自己的 New session 建出真正的第二个
会话，并断言「确实离开了 A」。

## 未覆盖（诚实记录）

- **编辑器未保存草稿跨会话**：接管抖动已修，但 lane 里只驱动了 `files` 接管，
  `editor` 资源 tab（草稿所在）没有被跨会话实测；若宿主在该 kind 上仍重挂 body，
  草稿仍会丢。要钉死得在 lane 里加「打开文件 → 键入 → 切会话 → 回来看内容」。
  #712 的 `editorDrafts` module 记忆是等价兜底（本轮未采用）。
- 编辑器撤销历史/光标、浏览器前进后退历史：本来就不做（#712 §未覆盖）。
- **内存上界**：`keepMounted` 的 body 与其记录活到 tab 关闭/会话消失，宿主没有
  LRU 上限；访问过的会话越多、`keepMounted` 类型越多，常驻越高。属宿主策略，
  插件无法单方面设界——记为已知代价。

## 不做

- 不改 DSH 源码（仓库硬约束 §1）。
- 不删既有签名：`update/has/activate` 只**新增**可选 `sessionId`（在屏会话下与旧行为
  完全一致，外部插件不传照旧）。
