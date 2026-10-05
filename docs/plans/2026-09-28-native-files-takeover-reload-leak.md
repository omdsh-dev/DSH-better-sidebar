# `files` 接管 id 泄漏：客户端条目替换后报错刷屏 + 文件树空态

日期：2026-09-28　分支：`fix/native-registration-leak-v2`（PR #777，已合并）→ 后续 `fix/native-leak-guard-tests`

关联 issue：[#771](https://github.com/omdsh-dev/DSH-better-sidebar/issues/771)（同串报错的独立复现与定位）、[#770](https://github.com/omdsh-dev/DSH-better-sidebar/issues/770)（同串报错，另一条 inject re-prove 猜测）、[#766](https://github.com/omdsh-dev/DSH-better-sidebar/pull/766)（「吸收」方案，已按本文结论关闭）

## 现象

```
[dsh-better-sidebar] native register files error: sidebarRight: tab type id "dsh-better-sidebar:files" is already registered
```

红色诊断条钉在页面左下角、触发时**同一毫秒刷出多条**；不致命，但 `files`（文件树）接管会**静默缺位**——原生右侧栏的「文件」入口渲染成宿主的空态，直到**刷新页面**才恢复。0.21.1 与 0.22.0（npm `latest`）都带此缺陷。

## 根因（真机日志 + 代码双向验证）

官方桌面壳日志 `~/Library/Application Support/dsh-tauri/logs/desktop.frontdesk.log:2370`（2026-09-27 15:51:39.338）第一条就是完整栈：

```
native register files error: Error: cannot create effect on inactive context
  assertActive ← effect ← inject(slots) ← registerSlots ← registerFilesKind ← sync ← notify
```

随后同一毫秒（.339–.340）**7 条** `already registered`（栈：`register ← registerFilesKind ← sync ← notify`），13 秒后新激活的 `_reload` 路径又报 2 条（该 burst 合计 9 条，与「7 个内置描述符注销 → 7 次 notify」一一对应）。链条：

1. `service.notify()` 是同步内联（`src/client/service.ts:696`），而 `registerNativeSurface` 把 `sync()` 订阅到它和 store 上（`src/client/native/index.ts:353`；本文行号按 v0.22.0，main 因 #777 的插入而顺移）。
2. `sync()` 的清理循环把 `live` 里**两类归属不同的条目**一视同仁：描述符类型（键 = descriptor id）与 `files` 接管（键 = `FILES_KIND`，**永远不在 `wanted` 里**）。于是**每次**通知都会释放接管、并在同一轮里重建它。
3. 插件 teardown 时，内置描述符逐个注销 → 每次注销 notify → `sync()` 在**已经 inactive** 的插件 ctx 上运行。此时 `tabs.register` 建在**宿主** ctx 上（宿主 ctx 仍活着）→ id 被取走且返回了 disposer；紧随的 `ctx.slots.inject` 建在**插件** ctx 上 → cordis `assertActive()` 抛 `INACTIVE_EFFECT`（`@deepseek-ai/cordis@4.0.4` `effect()` 首行）→ `live.set(FILES_KIND, …)` 永不执行 → **该 id 在本页生命周期内再也不能注册**。
4. 之后每次 notify（同一 burst 里还有 6 次）都重试同一个被占用的 id → `already registered` 刷屏；新一次激活同样注册不上 → 文件树空态。

**两条一般化的不变量**（已写进 [AGENTS.md](../../AGENTS.md) §3.4 第 9 条）：

- 清理循环必须**跳过 `FILES_KIND`**；接管只由编辑器类型的 `wantsFiles/hasFiles` 分支与 seat disposer 管理。
- 「注册成功一半」是**可达状态**（宿主 ctx 与插件 ctx 的寿命不同），因此任何在宿主取走 id **之后**失败的注册必须**回滚释放该 type**（并释放已建槽位），插件侧只留一个下次通知可重试的失败。

## 修复

PR #777（贡献者 @yanzhaohui1999）落地上面两条：`sync()` 的清理循环跳过 `FILES_KIND`；`registerSlots` 失败时释放已建槽位；`registerDescriptor` / `registerFilesKind` 在槽位注册失败后回滚已占用的 type；teardown / 清理循环逐个安全释放（一个释放抛错不再中断其余）。

**否决备选方案**（PR #766 的「吸收」）：把宿主抛出的 `already registered` 当作「宿主已持有该行」继续注册槽位。它能让日志安静，但会在 `live` 里记下一份**不拥有**的注册（空 disposer）——旧持有者随后释放该 id 时无人补注册，`files` 接管可能永久缺位；而且在 `tabs.register` 抛错（id 守卫，原子，未取走任何东西）与「取走后才失败」两种情形之间不做区分，掩盖了真正的账本错误。

## 验证

- **单测红→绿（实测）**：`tests/native-registration.spec.ts` 在 v0.22.0 源码上 4/4 红，在修复分支上 4/4 绿；`pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿（修复分支的 base 早于 #781，故为 114 files / 1136 passed；合入 main 后为 122 files / 1293 passed / 9 skipped）。
- **部署级红→绿（实测）**：`tests/e2e/native-reload.e2e.ts` 在 scratch profile 里对 npm 上的 `dsh-better-sidebar@0.22.0` 触发页面内条目替换（`utimesSync` 已安装的 `lib/client.js`），连续 3 次运行**全红**且每次都是本文那两条栈；换成本地打包的修复版连续 3 次**全绿**（该用例只有 1 个 test，重复跑三次）。该用例已随本 PR 进入挂载 lane（CI `plugin-mount` 绿），触发方式依赖钉住的宿主 0.1.7-rc.1 的 rev 规则（`mtime/ctime/size` 的 sha1）——pin 上调时需同步复核。
- 首版用例的两处断言（「失败后还能重新注册」）写在**活着的 id 集合**上，在未修复代码上会**同样通过**（泄漏的 id 恰好构成同一个集合）。跟进 PR 把它们改写到注册表的**事件日志**上，并把槽位失败判据从 `key` 改成 `name::key` —— 两个槽位共用一个 `key`，按 `key` 失败时**第一个**槽就抛，回收循环虽然进了、但手里的 disposer 列表永远是空的（即 `registerSlots` 的部分回滚**释放动作**从未被执行）；改后可以让某个描述符的**第二个**槽失败，回收列表非空、释放路径真正被覆盖，且 4 例在 v0.22.0 上仍全部红。

## 已知限制 / 未做

- **跨激活的瞬时重复**仍未消除：页面内条目替换时，新激活可能先于旧激活释放 id 而撞上 `already registered`（一次日志噪音，随后自愈）。要消掉它需要「吸收 + 旧持有者释放后补注册」的机制，与上面否决的方案同源，暂不做。
- `disposeSafely` 的释放失败只写 `console.error`、**不弹诊断条**（teardown 阶段弹条是噪音；真被占住的 id 会在下一次注册尝试里经 `reportFailure` 显式报出）。理由写在源码注释里。
