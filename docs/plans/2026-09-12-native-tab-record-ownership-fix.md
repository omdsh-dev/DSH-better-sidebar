# 原生 tab 记录归属：切换对话后文件浏览器不再失效

日期：2026-09-12　分支：`fix/native-tab-record-ownership`

## 背景

用户报告（真机复现，稳定）：**切换对话后，之前打开过的侧栏文件浏览器点文件夹 / 文件都没反应**，把该 tab 关掉重开才恢复；更关键的一步是——**切回原来那个会话，原本正常的文件浏览器也一起失效了**。合并模式（`editorExplorer: true`，用户本机设置）下，文件夹点击不展开、文件点击不原地切换；Network 面板里**一个请求都不发**（不是 403 / 路径围栏那类问题）。

## 根因

两方契约叠加出的一个「跨会话同 id 误删」：

| 侧 | 事实 | 出处 |
|---|---|---|
| DSH 宿主 | 原生 tab id 由**每会话各自**的计数器铸造（`counting(0)`），前缀 `tab` → 每个会话里第一个 tab 都叫 `tab1`、第二个 `tab2`…… | `dsh-client-ui-sidebar-right/lib/client.js`（`createSurface()` → `counting(0)`）+ dockkit `planOpenContent` 的 `mint("tab")` |
| DSH 宿主 | 右侧栏的会话级 seat 以 **sessionId 作 React key**（`StrictSessionEntry` 以 `}, binding.key)` 收尾）→ 切换对话 = **同一次 commit** 里「进入会话的子树 render + 离开会话的子树 unmount」 | `dsh-client-ui-renderer/lib/client.js` |
| 本插件 | 合成记录表 `views` 只按**原生 tab id** 存；tab 体 unmount 时 `records.drop(id)` **不校验归属**；`versionOf(缺失) = 0` | `src/client/native/tab-adapter.tsx` |

于是每次切换：

1. 进入会话的 tab 体在 **render 阶段** `ensure('tabN')` —— 同号 → 直接**接管**离开会话那条记录；
2. 同一次 commit 的 passive 清理里，离开会话的 tab 体执行 `drop('tabN')` → **把进入会话正在用的记录删掉**；
3. 记录没了、而它当初是 v0（`versionOf` 0 → 0 快照不变）→ `useSyncExternalStore` 不重渲染 → `ensure` 不会重新铸记录；
4. 此后所有经过注册表的点击都是**静默 no-op**：
   - 文件夹：`onToggleDir` → `records.toggleExpanded(id, path)` → `views.get(id)` 为 undefined → 直接 return（不会发 `fs.tree`）；
   - 文件（合并模式）：`EditorHost.openFile` → `updateTab(tab.id, …)` → `surface.update` 因 `records.has(tabId) === false` 返回 false → 回落插件底部面板 `patchTab`（该 id 不存在，同引用返回、连 notify 都没有，不会发 `fs.read`）。

**自我维持**：第一次之后，每次切换都是「进入方 render 时新铸一条 v0 → 离开方 unmount 又把它删掉」，所以此后**每次切换进入的会话都是死的**——这正是用户看到的「切回来原来好的也没反应」。若离开会话的记录刚好被用过（version > 0），`N → 0` 是快照变化，会触发一次重渲染并自愈（只是展开状态被清空），这解释了「偶尔看起来是好的」。

## 决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 记录携带 **owner token**（每个 tab 体实例一个，`useRef` 持有） | 同 id 的两条记录必须能区分归属，否则任何一方都可能读/删对方的 |
| 2 | `ensure` 遇到**别人的记录不接管、直接重建**（留在 `views` 里的是新 owner 的记录） | 会话切换时进入方 render 早于离开方清理；接管就等于把自己绑在一条马上会被删的记录上。顺带修掉「进入会话静默继承上一会话展开状态」 |
| 3 | `drop(id, owner)` 只删自己那条；另开 `remove(id)` 表示「不看归属地强制删」 | 语义分开：body 生命周期 vs 宿主关闭 tab |
| 4 | `surface.close(sessionId, tabId)` 先按 `record.scope.sessionId === sessionId` 判定再删 | 同一 id 也命名着别的会话的活 tab，无条件删会复现同一类故障 |
| 5 | **不**改成 `sessionId + tabId` 复合键 | `SidebarSurface` 的 `update/close/has/activate` 公开签名都以 tabId 为参数，复合键要连带改一圈接入 API；而宿主同一时刻只挂载在屏会话的面板，单键 + 归属校验已足够（记录在案：若宿主将来同时挂载多会话面板，需要把 session 带进这些签名） |

## 改动清单（子系统级）

| 子系统 | 文件 | 变更 |
|---|---|---|
| 记录表 | `src/client/native/tab-adapter.tsx` | `View.owner`（body token）；`ensure` 收 `owner` 且**不接管**别人的记录（重建，静默——它跑在 render 里）；`drop(id, owner)` 归属校验 + 新增 `remove(id)`；`NativeTabBody` 用 `useRef` 造 token 并传入 `ensure` / 卸载清理；接口 docblock 记下「原生 id 每会话重名 + 会话级 seat 按 sessionId 换 key」这条宿主契约 |
| 写入面 | `src/client/native/surface.ts` | `close()` 只在记录属于该会话时删（改用 `remove`） |
| 测试 | `tests/native-surface.spec.ts` | 既有 19 条适配 `owner` 参数；**净增 6 条**：注册表级 3 条（不接管他人记录 / 只删自己的 / `remove` 强制删）、组件级 3 条（离开会话卸载不得删进入会话的记录 + 切回仍可用；进入会话不继承上一会话树状态；连续三次切换每次都可用） |

## 验证

- **回归守护（确定性）**：`tests/native-surface.spec.ts` 修复后 **25 passed**；把 `src/client/native/tab-adapter.tsx` + `surface.ts` 回退到 `origin/main` 后 **5 条红**，其中组件级那条的断言正是用户症状——`the entered session keeps a record of its own: expected false to be true`，另有 `the entering body does not inherit the leaving one's tree state`、`the live record survives the other body's teardown`。组件级用例刻意照抄宿主形状：外层 `div` 以 sessionId 作 key、内层 body 以同一 tab id 渲染，一次 `act` 完成「进入会话 render + 离开会话 unmount」。
- **门槛**：`pnpm typecheck` / `pnpm lint` 干净。`pnpm test` = 127 files / **1319 passed** / 9 skipped / 33 failed——**这 33 条失败全部在 `tests/agent-pty.spec.ts` 与 `tests/smoke.spec.ts`，报 `posix_spawnp failed`（本机沙箱不允许 node-pty 起进程）**；把本次改动 stash 掉跑同样两个文件仍是同样 33 条红，与本次改动无关。
- **真机（用户执行）**：把 web profile 以 `link:` 指向本分支后，用户在本机 3080（Windows 浏览器经 LAN 隧道 `http://127.0.0.2:3080`）实测——**切换对话后文件浏览器照常响应，原先必现的「切进去失灵、切回来原来好的也一起失灵」未再出现**。该次链接只改了 profile 的依赖声明（`dsh-better-sidebar: link:/Users/y/workspace/dsh-better-sidebar`；pnpm 顺带移除了旧 npm 副本自带的 164 个依赖），其余插件与 `dsh.profile.bundles` 清单不变；实测完已按用户要求换回 npm `latest`（0.19.1，不含本修复）。

## 未覆盖（诚实记录）

- 单测锁定的是宿主契约的**形状**（每会话计数 + 会话级 seat 按 sessionId 换 key，读的是 `0.1.5-rc.1` / `rc.2` 两个版本的产物，行为一致）。**浏览器里的端到端复现由用户先于本次修复完成**（复现步骤：两个新会话各开「文件」→ 确认两边 `data-dockkit-tab` 同号 → 连续切两次 → 点文件夹无反应 → 折叠/展开右侧栏即自愈），本次修复后的真机确认亦由用户执行；插件作者侧（我）没有独立跑过那条浏览器复现，确定性证据是上面的单测红/绿。
- 记录表仍按 tab id 解析 `update/close/has`，语义是「当前存在的那条记录」；同上，宿主挂载模型是单会话面板，故无歧义。
- 「离开会话记录被用过（version > 0）时那一次切换会自愈」是既有行为，本次不动：修复后不再有记录被误删，该分支不再产生失效，只是展开状态在会话间本就应当各自独立。

## 不做

- 不改 DSH 源码（仓库硬约束 §1）。
- 不改插件自绘底部工作台的记录语义（它按会话隔离持久化，不共享本记录表）。
- 不新增设置项、不动 `TabDescriptor` / `ctx.betterSidebar` 的任何公开签名。
