# 文件树性能核查与两处收敛：折叠链预加载上限 + 请求级探测预算

日期：2026-10-13　分支：`fix/file-tree-perf`（从 `dev` 切出）

## 1. 背景与核查结论

用户带着六条断言要求核查「文件 Tab」与「深层级文件」的性能问题。逐条落到代码后的结论（每条都有实测/直读证据，未采纳的项见 §4）：

| 断言 | 结论 | 证据 |
|---|---|---|
| 文件 Tab「无 memo 边界」 | **不成立** | `FileRow`/`DirRow`/`RootRow` 三个 `memo` 组件（`src/client/FileTree.tsx:249/331/413`），`actions` 经 `useMemo` 稳定（`:1252`），props 刻意只传原始值/稳定引用（git 状态以 `gitTone`/`gitLetter` 原始值传入，`:237-247`） |
| 文件 Tab「无虚拟化」 | 成立（本轮不处理） | 递归直出（`:2025-2127`），全客户端无 windowing/`contain`/`content-visibility`；每层受 `listLimit`（默认 1000）与 `truncated` 提示约束 |
| 宿主每列一层、每个子目录一次探测 | **成立** | `fs-tree.ts` 的 `readDirectory` → `probeCompactRows` → `hasSingletonChild`（`src/fs-tree.ts:263-291`）：每个目录行一次 `opendir` + ≤2 次 dirent 读；缓解是 1.5s TTL 层缓存 + 单层并发 32 |
| ↳ 并发放大（核查中新增） | **成立** | `fs.trees` 对 ≤64 路径 `Promise.all`（`src/index.ts:712-727`）× 每层 32 路 → 冷挂载宽目录树时单请求理论上同开约 2048 个 `opendir` |
| 折叠链「一节一次往返」 | **成立且严格串行** | 下一节名字只能从上一节 listing 得到（`src/client/file-tree-compact.ts:48-53`），预加载 effect 依赖 `data`（`src/client/FileTree.tsx:1004-1012`）→ N 节 = N 个串行 POST（每波跨链合批上限 64）。`tests/file-tree-compact-fold.spec.tsx` 钉的是**被请求路径集合**，不锁 POST 次数 |
| 「超 32 节静默截断」 | **成立**（折叠链维度，非路径截断） | `MAX_COMPACT_DEPTH = 32` 只在渲染侧生效（`file-tree-compact.ts:27/40`），而 `compactLoadTargets` 旧实现**无深度上限**——渲染在 32 停手、预加载继续往下；注释里「健康缓存永不触及」也不准确，合法的深单子目录链真会触及 |
| watch 64 上限「静默击穿」 | 单连接**未**击穿；「静默」与进程级无全局上限成立 | 上限 64、超限 `add()` 返回 false（`src/fs-watch.ts:31/104`），测试钉住前 64 接受且不驱逐（`tests/fs-watch.spec.ts:119-132`）；拒绝只回 `{dir, ok:false}` 而客户端不处理该分支（`src/client/use-dir-watch.ts:116-125`）；cap 是 per-WebSocket，`keepMounted` 下多会话同时挂载时进程总句柄可达 64×N |

核查中另行记录（未入选本轮）：`DirRow` 的 `chain` 数组来自 `useMemo(…, [data])`（`FileTree.tsx:1842-1851`），层级缓存一变整份重建 → 每次 watch 通知/展开/改名都让**所有目录行**重渲染（`FileRow` 仍能 bail）；git 状态每 2.5s 在请求开始与结束各 `notify` 一次（`src/client/ui/git-status.ts:211/236`），导致整树每 2.5s 重建一次 element 树（快照 identity 保留机制见 `:216-224`）。

## 2. 改动一：折叠链预加载与渲染共用同一深度口径（client）

`compactLoadTargets` 从「扫描所有已加载层」改为「从**渲染根**沿折叠链下行」，上限由同一个 `compactChain` 天然继承（它本就按 `MAX_COMPACT_DEPTH` 截断）：

```ts
compactLoadTargets(levels, roots)      // roots = [cwd, ...expanded]
  work list（非递归，深树不压栈）+ visited 去重
  对每个已加载层的每个目录行：
    chain = compactChain(entry, levelOf)        // ≤ 32 链接，停在首个未加载链接
    tail  = chain.at(-1)
    tail 仍 compact 且该层未加载 → 收集为 frontier（唯一需要加载的一节）
    否则链尾已加载：chain.length < 32 才下行扫下一节（收敛点）
```

- **为什么这样就能封顶**：链长到 32 时 `compactChain` 不再延伸，于是永远拿不出第 33 节作为目标——不需要额外的深度计数。
- **语义等价性**：非 compact 目录的 `compactChain` 立即返回单元素链，只在下行时探查其（已展开才存在的）已加载层，与旧全局扫描覆盖相同；折叠行未展开也继续长齐标签的行为保留（逐波补链）。
- **调用点**：`FileTree.tsx:1015` 传 `[cwd, ...propsRef.current.expanded]`，effect 依赖保持 `[cwd, data, loadLevels]`（`data` 是真到达信号，展开总会伴随可见集 effect 的加载，故不需要把 `expanded` 放进依赖）。
- **注释订正**：`MAX_COMPACT_DEPTH` 上方原先「健康缓存下永不触及」的表述改为准确口径（合法深链会触及；循环守卫是 `compactChain` 的 `visited`，不是这个常量）。

旧实现下 `tests/file-tree-compact.spec.ts` 与 `tests/file-tree-compact-fold.spec.tsx` 的新用例实测变红（`expected 40 to be 32`、`['/elsewhere/x']`、第 33 节被请求），证明用例有判别力。

## 3. 改动二：请求级探测预算（host）

- `src/fs-tree.ts` 新增 `PROBE_BUDGET = 32`、`ProbeGate`、`createProbeGate(limit)`（FIFO 信号量，`limit < 1` 夹到 1；`run` 用 `try/finally` 释放；释放时把槽位直接交给队首）。
- `listDirectory(path, maxEntries, exclude?, gate?)` → `listDirectoryCached` → `readDirectory`（**仅缓存未命中**路径），两个 probe（symlink stat / compact opendir）都经 `runProbe(gate, …)`。缓存命中不占额度。
- `src/index.ts` 的 `fs.trees`（`:711`）在 `Promise.all` 之前建**一个** gate 并传给每个 `listDirectory`；`fs.tree` 单路径路由传 `undefined`，行为逐字不变。
- 值取 32 = 现有单层常量：单层/单路径行为与改前完全一致，只是「层数 × 32」变成了「每请求 ≤32」。
- 实现偏差记录：第一版把 gate 取槽放在 `forEachRow` 的**行访问**上，于是 symlink probe 对非链接行、compact probe 对文件行也各取一次空转槽位——计数单测立刻暴露（期望 9 实际 18）。改为只在真实 fs 调用外层取槽（`runProbe`）。
- `forEachRow` 因此保持原三参签名不变，per-level 的 `SYMLINK_PROBE_CONCURRENCY` / `COMPACT_PROBE_CONCURRENCY = 32` 继续作为单层 worker 池。

## 4. 明确不做（用户已定，记录以免重复争论）

1. **不引入虚拟化**，也不为此加压力测试/文档：memo 边界 + 每层 1000 行上限 + `truncated` 提示已够用（用户判断「目前性能看起来都没问题」）。
2. **watch 上限不加任何用户提示、不加全局（跨连接）句柄上限**：有的机器本来就无法 watch，VS Code 自动刷新失败同样不提示（保留 per-连接语义与既有日志行为）。
3. **不改 `DirRow` 的 chain identity**（每层级变动全目录行重渲染）。
4. **不处理 git 每 2.5s 导致的整树 element 重建**。

## 5. 测试与验证

- `tests/file-tree-compact.spec.ts`：`compactLoadTargets` 两条既有用例改新签名 + roots；新增「只从渲染根走」（不可达层不再贡献目标）与「到渲染上限即停」（fixture 是 MAX_COMPACT_DEPTH+1 条已加载链接、第 33 节存在但未加载，旧实现会收它）。
- `tests/file-tree-compact-fold.spec.tsx`：既有「折叠成一行 + 预加载整条链」断言保持；新增一条 40 节链的用例——预加载最深恰为 `MAX_COMPACT_DEPTH`、绝不请求第 33 节。
- `tests/fs-tree-probe-gate.spec.ts`（新，真实临时目录，不 mock `node:fs`）：`createProbeGate` 的在飞上界 / 排队任务抛错后槽位释放且保持 FIFO / `limit<1` 夹紧；`listDirectory` 每个目录探测恰好花一个槽位、缓存命中花零个；三个层共享一个 gate 时合计 9 次（3 层 × 3 个目录行）。
- `tests/smoke.spec.ts`：新增路由级断言——一次 `fs.trees` 请求只调一次 `createProbeGate`（用 `vi.mock(…, importOriginal)` 包一层计数，其余导出保持真实），即「批次共享一个预算」；`fs.tree` 单路径与其余路由行为回归由既有用例覆盖。
- 既有 `tests/fs-tree*.spec.ts` / `tests/fs-watch.spec.ts` 全绿（`gate` 是可选参数，既有调用逐字不变）。
- **与本轮无关的既有 flaky**：`tests/fs-watch.spec.ts` 的「treats a repeat add as already-watched」是 `fs.watch` + 真实写入的 15s 等待，在多副本并行跑时会在任意副本上偶发红；把全部改动 stash 掉后同样复现，故不是本轮引入。

## 6. 交付说明

门禁：`pnpm typecheck`、`pnpm lint`、`pnpm test`（本轮不涉及 e2e/挂载 lane）。改动仅 4 个源文件 + 3 个测试文件 + 本文件；`fs.tree` 单路径路由与 `fs-watch` 行为未触碰，未新增 UI 文案或 locale key。
