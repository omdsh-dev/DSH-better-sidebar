# 原生 tab 的跨切换状态保留（#636 / #661 + 状态归档）

日期：2026-09-17　分支：`fix/tree-scroll-memory`

> 本文接替 `2026-09-12-native-tab-record-ownership-fix.md`（PR #637 那套方案的记录）。
> 同一根因，另一套解法：**归档取回** 取代 **按会话重建**，并补齐 #637 未做的
> 「切回会话时状态清零」、归档驱逐与各组件状态。

## 背景

用户报告两组症状，同一个根因：

1. **#636（跨会话失灵）**：切换对话后，之前打开过的侧栏「文件」浏览器**点文件夹不展开、点文件不打开**，Network 面板里一个请求都不发；再切回原来那个会话，**原本正常的也一起失灵**。关掉该 tab 重开、或折叠再展开右侧栏即恢复。
2. **#661（同会话切 tab 丢状态）**：同一会话内切换右侧栏 tab，会把该 tab 的插件侧状态清空——文件树已展开的目录全部收起、终端选中态丢失；merged（`editorExplorer=true`）下就地打开的文件，切走再切回退回空白资源管理器、chip 标题也退回「文件」。

第三个症状是本方案在实现过程中**用探针实测**发现的，#637 未覆盖：

3. **切回会话时状态清零**：即使 #636 修好（点击有反应），切回 A 会话时树展开集/就地打开的文件仍是空的。

```
A after use   : {"scope":"A","expanded":["/work/src"],"path":"/work/notes.md"}
during B      : {"scope":"B","expanded":[]}
A after return: {"scope":"A","expanded":[]}      ← #637 的重建路径在这里是空的
```

## 根因

三方事实叠加（前两条是宿主契约，第三条是本插件的实现）：

| 侧 | 事实 | 出处 |
|---|---|---|
| DSH 宿主 | 原生 tab id 由**每会话各自**的计数器铸造，前缀 `tab` → 每个会话里第一个 tab 都叫 `tab1`、第二个 `tab2`……**跨会话必然重名** | `dsh-client-ui-sidebar-right/lib/client.js` 的 `createSurface()` → `const counter = counting(0)`，交给 dockkit 的 `createInitialState({ next: counter.mint })` |
| DSH 宿主 | 右侧栏的会话级 seat 以 **sessionId 作 React key** → 切换对话 = **同一次 commit** 里「进入会话的 body render + 离开会话的 body unmount」；且 **同一 pane 内只挂载当前 tab 的 body** | `dsh-client-ui-renderer` 的 `StrictSessionEntry`；dockkit 的 `bodiesFor(panel)` → `.paneBody` 内只渲染 `i.renderTab(p)`（当前 tab） |
| 本插件（修复前） | 合成记录表 `views` 只按**原生 tab id** 存；tab 体 unmount 时 `records.drop(id)` **不校验归属**；`versionOf(缺失) = 0` | `src/client/native/tab-adapter.tsx` |

由此产生三个失败链：

**① #636（跨会话失灵，静默 no-op）**

1. 进入会话的 tab 体在 **render 阶段** `ensure('tabN')` —— 同号 → 直接**接管**离开会话那条记录；
2. 同一次 commit 的 passive 清理里，离开会话的 tab 体 `drop('tabN')` → **把进入会话正在用的记录删掉**；
3. 记录没了、而它当初是 v0（`versionOf` 0 → 0 快照不变）→ `useSyncExternalStore` 不重渲染 → `ensure` 不会重新铸记录；
4. 此后所有经过注册表的点击都是**静默 no-op**：
   - 文件夹：`onToggleDir` → `records.toggleExpanded(id, path)` → `views.get(id)` 为 undefined → 直接 return（不发 `fs.tree`）；
   - 文件（合并模式）：`EditorHost.openFile` → `updateTab(tab.id, …)` → `surface.update` 因 `records.has(tabId) === false` 返回 false → 回落插件底部面板 `patchTab`（该 id 不存在，同引用返回、连 notify 都没有，不发 `fs.read`）。

**自我维持**：此后每次切换都在重复「进入方 render 新铸 v0 → 离开方 unmount 删掉」，所以**每次切进去的会话都是死的**——这正是「切回来原来好的也没反应」。

**② #661（同会话切 tab 丢状态）**

宿主只挂当前 tab 的 body → 切 tab = 卸载/重挂组件 → 卸载清理删掉记录 → 该 tab 的插件态（树展开集、终端选中态、merged 就地打开的 path/title）全丢。切回来只能从原生 tab 重新铸，而 merged 的 path **只存在于记录里**、原生 tab 的地址不带它。

**③ 切回会话状态清零**

即使把记录寿命改成「活到 tab 关闭」，跨会话时**同一条单键记录只能装一个会话的状态**。切回时若沿用「按原生种子重建」的写法，状态必然是空的。

## 决策

把「身份」和「寿命」放到正确的载体上，并给被顶掉的会话留一份**归档**：

| 维度 | #637（被本方案取代） | 本方案 |
|---|---|---|
| 身份 | 单键 `tabId` + 会话判据 | 同（**公开 API 签名以 tabId 为参，不动**） |
| 跨会话 | 同号且异会话 → **按原生种子重建**（状态清零） | 离开会话的记录 **停进 `parked` 归档**（键 `sessionId::tabId`），切回时**取回** |
| 寿命 | 活到宿主关 tab | 同：**卸载不删记录**，唯一出口是 `surface.close` → `drop(id, sessionId)` |
| 归档回收 | —（不适用） | `retain(sessionIds)`：会话被删除后释放其归档 |
| 组件态 | 只保记录里的 `expanded` / path / meta | 另外保：编辑器未保存编辑、未提交 commit message、git worktree、文件树滚动 |

**为什么 map 仍是单键（tab id）而不是复合键**：`SidebarSurface` 的
`update / close / has / activate` 公开签名都以 tabId 为参数，改复合键要连带
改一圈**对外契约**（扩展插件直接依赖它）。而宿主同一时刻只挂载在屏会话的
body，所以「单键 live 槽 + 按会话归档」已足够表达全部状态。复合键是更彻底
的方案，但代价是破坏性 API 变更——记录在案，留给宿主支持多会话同屏的那天。

**为什么归档而不是重建**：重建的信息源只有「原生 tab 的种子」（kind/title/
导航 params），而读者在会话里积累的状态（展开了哪些目录、就地打开了哪个文件）
**只存在于记录里**。重建等于承认这些信息丢失；归档是唯一能取回它们的做法。

**为什么 chip 也按会话读**：tab strip 渲染在 pane body **之前**，所以切会话的
那一帧 live 槽里可能还是上一个会话的记录。`NativeTabTitle` 因此改用
`records.peek(sessionId, id)`，由 title 槽注入 `sessionId`（body 槽原本就有）。

## 改动清单（子系统级）

| 子系统 | 文件 | 变更 |
|---|---|---|
| 记录表 | `src/client/native/tab-adapter.tsx` | 新增 `parked` 归档（键 `sessionId::tabId`）；`ensure` 改为「异会话先归档并清 live 槽 → 有归档则取回 → 否则铸新」；新增 `peek(sessionId, id)`；`drop(id, sessionId?)` 支持按会话删；新增 `retain(sessionIds)` 驱逐；**删除 body 卸载清理** |
| 写入面 | `src/client/native/surface.ts` | `close` 改走 `peek` + `drop(id, sessionId)`；会话列表订阅（原有 `flushPending`）顺带跑 `evictDeadSessions`，绑定时跑一次 |
| chip | `src/client/native/index.ts` | title 槽注入 `sessionId`（chip 渲染早于 body） |
| 编辑器 | `src/client/TextEditor.tsx` | module-level `editorDrafts`（键 `sessionId::path`）归档未保存文档 + 预览/编辑模式；恢复时用它做 `EditorState` 的初始 doc；**保存成功即清归档**；干净文档不归档 |
| 文件树 | `src/client/FileTree.tsx` | module-level `treeScrollMemory`（键 `sessionId::cwd`）；懒加载到位后按 `useLayoutEffect` 恢复，**只恢复一次**、读者先滚动则让位、reveal 在场时让位 |
| git | `src/client/changes/GitLens.tsx` | module-level `commitMessageMemory`（按会话）与 `worktreeMemory`（按会话 + cwd）；提交成功/清空即清归档 |

## 验证

**门槛**：`pnpm typecheck` / `pnpm lint` 干净；`pnpm test` = **1332 passed** / 9 skipped / 33 failed——33 条全在 `tests/agent-pty.spec.ts` 与 `tests/smoke.spec.ts`（`posix_spawnp failed`，本机沙箱不允许 node-pty 起进程）；**在零改动的 `origin/main` 上跑同样文件同样 33 条红**，与本次改动无关。

**红/绿证据**（每一项都做过「回退实现必红」）：

| 用例 | 文件 | 回退后的红 |
|---|---|---|
| #636 组件级复现（照抄宿主形状：外层 `div` 以 sessionId 作 key、内层同一原生 tab id、一次 `act` 完成进入 render + 离开 unmount） | `tests/native-surface.spec.ts` | `session-B: the entered session keeps a live record: expected false to be true` |
| A → B → A 往返（树展开集 + 就地打开文件 + chip 标题） | 同上 | `A's tree expansion survives the round trip` 等 3 条 |
| `peek` / 按会话 `drop` / `retain` 驱逐 + 接线 | 同上 | `a deleted session's archive is dropped`、`the deletion reached the registry` |
| 编辑器未保存编辑跨重挂载 | `tests/editor-draft-memory.spec.tsx` | `the unsaved edit survives the remount: expected 'const a = 1\n'` |
| commit message 跨重挂载 | `tests/changes-tab.spec.tsx` | `the unsaved commit message survives the remount: expected ''` |
| 树滚动（8 条：恢复 / 不继承 / 短树不夹到 0 / 每会话独立 / 只恢复一次 / 读者优先 / 不可滚时不覆盖 / reveal 让位） | `tests/tree-scroll-memory.spec.tsx` | 回退实现 5 条红 |
| **真机**状态向量（滚动 + 展开目录 + chip 标题）跨 tab 切换与 A→B→A 会话往返 | `tests/e2e/tree-scroll.e2e.ts` | 在**纯 `origin/main`** 上跑同一条 lane，红在 `tree-scroll.e2e.ts:192`（同会话切 tab 后展开集丢失） |

真机 lane 走 `scripts/e2e-mount.sh`：npm 打包 → 全新 scratch profile（`/tmp` 下的
独立 home，绝不触碰真实 `~/.dsh`）→ 真实 `dsh web --port 0`（keyless）→
headless Chromium。**保留 e2e 的理由**：单测用 stub 几何，测不到真实懒加载时序
与宿主挂载模型；真机 lane 把它变成 CI 每次回归都跑的守护。

**与 #637 的关系**：两套解法在 `ensure` 主体上**互斥**（重建 vs 归档取回），
merge 实测 **4 文件 / 10 冲突块**（`tab-adapter.tsx` 6、`surface.ts` 1、
`index.ts` 1、`native-surface.spec.ts` 2），属**语义冲突**，必须二选一。
本方案是 #637 的超集：#636/#661 都修，并额外修「切回清零」、加驱逐与组件态保留。

#637 还有一条**必须一并承接**的改动：它把 `tests/e2e/mount.e2e.ts` 里
「按 chip 名匹配 Side Chat」改成「经指南条目打开」。原因与本方案直接相关——
**修复本身让那条断言失效**：sidechat 的 chip 标题跟随线程名被
`SideChatView` 重写（`updateTab(tab.id, { title })`），而旧写法只在「切 tab
丢记录 → chip 回退到打开时的标题」时才匹配得上。记录不再丢之后，chip 显示
线程名，`getByRole('tab', { name: /Side Chat/ })` 匹配不到。本方案已把该改动
移植过来（`mount.e2e.ts`），否则 CI 的 mount lane 会挂。

## 未覆盖（诚实记录）

- **编辑器撤销历史 / 光标 / 编辑模式滚动**：现在只归档文档正文与模式。撤销历史
  是 `EditorState` 内的一个 `StateField`（`@codemirror/commands` 的 `historyField_`），
  卸载 `view.destroy()` 即随 state 被 GC，而 `EditorState` **不可序列化**。要保住
  得整体持有 `EditorState` 引用。实测单份保留开销：100 行文档 73 KB、400 行 109 KB、
  1600 行 257 KB（相对只存正文的 9.9 / 40.7 / 165 KB，约 1.6–7.4×；`minDepth: 100`
  使历史有上界）。**暂缓**：收益只体现在「未保存编辑」的文件上，而隐含复杂度
  （主题 compartment 跨挂载复用、磁盘内容变更失效判定、state 驱逐）不低。
- **浏览器 tab 的 URL / 前进后退历史**：`BrowserView` 只读 `tab.path`，URL 与
  history/cursor 全在 `useState`，切走即丢。**本方案不修**——已有 issue #669 与
  三个在飞 PR（#625 / #658 / #659）在做同一件事，避免撞车。
- **文件树搜索框内容**：有意不保。切回来「框里有字、结果空白」比清空更像故障。
- **`revealed`（Show in folder 高亮）**：`state.ts` 注释写明 transient，本方案跟随。
- **原生栏布局（展开状态 / 宽度 / tab 列表）**：宿主自有
  （`createSidebarRightStore` 的 `init: () => ({ bySession: {} })`，按 sessionId 分槽），
  **跨会话本就各自保留**；但宿主**零落盘**，刷新即回默认。本方案不动。
- **其他在飞 PR 的冲突**：实测与 #625 干净；与 #662 / #674 为**机械冲突**
  （相邻行 / 只碰测试文件），可解；陈旧分支（behind 50~463）的冲突在 rebase 后重算。

## 不做

- 不改 DSH 源码（仓库硬约束 §1）。
- 不改 `SidebarSurface` / `TabDescriptor` 的公开签名（扩展无需适配）。
- 不做 keep-alive 式的「隐藏而不卸载」：宿主「一 pane 一 body」的挂载模型在宿主侧，
  插件无法单方面改变。
