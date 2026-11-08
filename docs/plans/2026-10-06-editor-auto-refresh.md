# 编辑器预览自动刷新（#855）

> 状态：已实现（`feat/855-editor-auto-refresh`）。来源：已关闭的 PR [#216](https://github.com/omdsh-dev/DSH-better-sidebar/pull/216)
> 拆出的需求（原 PR 的信号源 `intercept.tsx` + `produced-files.ts` 已被 `58ba17d` 整体删除，剩下的只有消费端）。
> 本实现从 `dev` 重做，信号源改用**插件自有的 `changes.ops` 增量流**。

## 1. 问题

模型在会话里 `write` / `edit` 一个你正开着的文件后，侧栏里显示的仍是旧内容：加载 effect 的依赖是
`[scope.sessionId, scope.cwd, path, ctx, showEmpty, isDir, reloadSeq]`，写盘本身不改变其中任何一项，
`keepMounted` 又让切走再切回**不重挂**。用户的唯一出路是手点页头刷新按钮或把文件关掉重开。

## 2. 已核实的信号源（不自建轮询机制）

`src/index.ts` 的 **`changes.ops`** 路由：按 `seq > afterSeq` 增量下发该会话事件日志里的 `tool/call`
与 `tool/result` 两类行（`changes/ops.ts` 的 `extractFileOps` 把它们折成带 `path` / `kind` / `running` /
`isError` 的文件操作）。这是文件变动页会话透镜已经在用的流，**插件自有、无需新宿主 API、无自写回环**
（插件自己的保存走 `/sidebar/file`，不产生会话事件）。

被否掉的备选：

| 备选 | 否掉的原因 |
|---|---|
| `src/fs-watch.ts`（既有的按目录 watch） | 自述只报**目录条目表**变化，「文件夹内文件内容改写观测不到」（`fs-watch.ts:59-61`） |
| 定时 `fsRead` 指纹轮询 | `docs/plans/2026-08-19-editor-preview-refresh.md:21` 明确记为范围外；且每个编辑器 tab 都要读整文件 |
| 宿主 `ui-deliverables` / 轮尾产物行 | 不在本插件 peer 与客户端共享白名单里，会破构建纯度门；且 list 槽契约已淘汰该接管 |

## 3. 设计（`src/client/ops-stream.ts` + `EditorHost.tsx`）

**每会话一条流、成员选举一个 leader。** 编辑器 tab（成员）加入会话的流，只有 leader 跑
`usePolling`（`mode: 'self-scheduling'`，两次响应之间间隔 2.5s；`use-polling.ts` 是侧栏唯一的轮询循环）。
首次请求立即取得基线；后续请求在空窗时等待宿主的 `session/event` 通知，最长 25s。收到 tool 事件即返回增量。
所以「一个会话开 N 个编辑器 tab」同时只有 **1 个** `changes.ops` 请求；成员全部离开即停。
**没有 `fs.watch`，没有任何周期性 `fsRead`。**

**只认结算成功的写入。** `kind ∈ {write, edit}` 且 `running === false && !isError` 才发布 ——
半写内容不会进预览，失败的调用不会白发一次重载。

**第一帧是基线。** 新流的第一帧把所有**已经结算**的操作标记为已见、不发布任何东西：打开文件时那次
`fsRead` 就是它的新鲜读数，历史写入不该再触发一次重读。只有**开始看之后**才结算的操作会刷新。

**会话作用域。** 流按 `sessionId` 分账，命中判定用 `fileOpKey(cwd, path)`（`resolveSidebarPath` 归一相对
路径 + `.`/`..` 词法折叠 + 反斜杠统一 + Windows 盘符/UNC 大小写折叠）。别的会话写同一个路径不会串台。

**消费端（`EditorHost.tsx`）**：命中本页文件且**非 dirty、非编辑态**时 `setReloadSeq(+1)` ——
即复用页头刷新按钮那条完全相同的加载路径（`AbortController` 中止旧加载、重挂 viewer）。

## 4. 实施偏差（与 PR #216 计划的差异，均有意）

1. **不做「每 tick 至多 1 次请求」的跨页合并**：文件变动页的会话透镜保留**自己的**轮询器（它的启停条件是
   「tab 可见 **且** 会话透镜在屏」，与编辑器的「页签在屏」是两条不同的可见性）。因此一个会话同时开着
   文件变动页（会话透镜）与编辑器时，该会话最多同时有 2 个 `changes.ops` 请求；空窗时各自等待通知或 25s 期限。
   把两者合并到同一条流会改动一个已被 591 行 spec 钉住的既有特性（含「只在会话透镜在屏时轮询」这条断言），
   超出本 issue 的范围。**已如实记录为后续可选项。**
2. **不给 dirty 态加「有新版本」提示**：改为静默跳过。理由是加提示需要新词典 key（20 份），而
   dirty 时用户正在编辑器里，现成的出口是页头刷新按钮与「保存 → `fs-conflict` 横幅的 reload」
   两条（`dirty` 点只是状态显示，既有的「编辑 → 预览」边沿**自身也带 dirty 守卫**，dirty 时不成立）；
   「可见且不打扰」的提示方式没有不引入新 UI 与词条的现成载体。
3. **不做「每 op 一次精读 diff」**：只做重载，不把模型写的正文直接注入预览（PR #216 也没有）。
4. **流的记录**在最后一个成员离开后**保留**（只停轮询，并把事件窗口从 400 收窄到 32）：回来时从持久化的
   `seq` 游标续拉，把离开期间错过的增量补折并发布——否则「页面停在被写过的文件上、切走再切回」会看到旧内容。
   实测由 `tests/editor-auto-refresh.spec.tsx` 的 park/resume 用例钉住。

## 5. 已知边界（如实记录）

- **`code` 文件（编辑器就是唯一视图）保留不了光标/滚动**：这类文件 `toolbar.mode` 恒为 `preview`
  （模式开关不渲染），重挂会回到文档开头——**内容不会丢**（dirty 时根本不刷新）。markdown / html
  **预览态**的滚动位置由 `TextEditor` 既有的模块级 per-file 滚动记忆恢复（`previewScrollMemory` +
  布局 effect），但 **jsdom 量不出 `scrollHeight`，这层是读源码得出、未在真机浏览器验证**。
- **真实浏览器未验证**：本批只在 jsdom 里验证了行为（14 条用例 + 逐条变异证伪）。挂载 lane 证明的是
  「打包产物在真机挂载后不 crash」，它没有模型回合，无法在 lane 里造出真实的 `tool/call`。
- 相对路径命中需要会话 `cwd` 已知：`scope.cwd` 缺失时（极少数降级路径）模型写的相对路径无法归一，
  那一类改动不会触发刷新（绝对路径不受影响）。

## 6. 验证

- `pnpm typecheck` / `pnpm lint` / `pnpm exec vitest run --maxWorkers=3`：184 文件 2152 通过 / 13 跳过 / 0 失败。
- `tests/editor-auto-refresh.spec.tsx`（14 例，jsdom + 假计时器），逐条做了「还原源码即红」的变异验证：
  重载调用、路径命中、dirty 判定、编辑态判定、结算判定、基线、会话分账、成员选举、park/resume 记录、
  放行 `kind === 'read'`（→「模型 read 本文件零重读」红）、放松 `EditorHost` 的 `opBaseline` 守卫
  （只留 `null` 判断、不再按路径比对基线 →「重新定向到刚被 touch 的路径不重复读」红，既有 12 例仍全绿）、
  「无事件不轮询 fsRead」（变异方式：塞进一个周期性 `fsRead`）。
- `tests/editor-refresh.spec.tsx`（#167 的既有 4 条）未改动、仍绿。
- 真实挂载 lane：`DSH_CMD='npx -y --package @deepseek-ai/dsh@0.2.0-rc.1 dsh' pnpm test:mount`。
