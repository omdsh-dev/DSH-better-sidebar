# 底部工作台终端 tab（#774）

> 状态：已实现（`feat/774-terminal-tab`）。范围刻意收窄为「**底部能开一个终端 + 刷新后按 terminalId 恢复**」，
> 不含「首次展开自动开终端」（`bottomPanelAutoTerminal`）一类的联动。

## 1. 问题

DSH 0.1.6 起宿主自带右列终端（`ui-sidebar-terminal`，kind `terminal`），插件在 0.20 线把自带的终端栈与
`terminal_*` 工具**整体删除**交还宿主。结果是：**插件自己的底部工作台没有任何终端**——底部 `+` 菜单里
开不出 shell，用户要开终端必须离开底部工作台去右列。

诉求不是「再造一个终端」，而是「底部工作台里也能有一个 shell，且它与右列那条**互不干扰**」。

## 2. 五条已定决策（实现不得偏离）

1. **新内置 tab id = `terminal-bottom`**（不是 `terminal`）。它**只**出现在插件自己的底部工作台，
   **绝不能变成宿主右列里的第二个终端入口**——挂载 lane 断言宿主 `terminal` guide 条目**恰好 1 条**，
   多一条即「插件又在遮蔽宿主」。
2. **范围**：只做「底部可以开终端 + 刷新后按 terminalId 恢复」。底部终端与右列终端**相互独立**。
   **不做** `bottomPanelAutoTerminal` / 首次展开自动开终端。
3. **允许 `@xterm/xterm`**（必要时 `@xterm/addon-fit`）。已核实两者安装期无脚本（`scripts` 只有
   `prepublishOnly` / `postpackage-headless` / `start`，都不在市场拒绝名单 `preinstall|install|postinstall|prepare` 里）。
4. **xterm 必须打进新 chunk**（不 external、不进核心包）：chunk 名 `client-terminal.js`，全部镜像点同步；
   **核心 bundle 禁止静态 import `src/client/chunks/*`**。
5. **PTY 走宿主能力 `ctx.webTerminals`**（`@deepseek-ai/dsh-api-terminal-controller` 的 client 半边）。
   **不得**把 `webTerminals` 写进 `package.json#dsh.client.inject`——注入一个不存在的服务会让整行 `pending`
   （插件在无终端控制器的部署上会整体不加载）。按本仓库既有约定做**结构化探测**，缺服务时明确降级。

## 3. 宿主契约（从装好的钉版包里读出来，不凭记忆）

`@deepseek-ai/dsh-api-terminal-controller@0.2.0-rc.1` 的 `lib/client.js`：

- 服务名 `webTerminals`（`super(ctx, "webTerminals")`），`inject = ["remote", "remote.terminal"]`。
- `view(sessionId, key, contentId, terminalId?, shellPath?)`：按 `(sessionId, key)` **记忆化**一个视图；
  身份解析是
  ```js
  const saved = terminalId ?? this.bindings.get(sessionId, contentId)
  const id = saved ?? randomUUID()
  this.bindings.set(sessionId, contentId, id)
  view = new TerminalView(sessionId, this.remote, this.ctx.remote, id, saved === undefined, shellPath, …)
  ```
  → **显式传 `terminalId` 会把 `createWhenMissing` 置 false**（缺了就只报 `missingTerminal`，不新建）。
- `close(sessionId, key, contentId, terminalId?)`：记一条持久的关闭请求，删绑定与视图，再异步收尾。
- `recover(sessionId): Promise<WebTerminalInfo[]>`：列出没被视图持有、也没在关闭的宿主终端。
- `TerminalView`：`state` 是 `SnapshotStore`（`getSnapshot()` / `subscribe()`）；`mount()` 返回**detach**
  回调（进程存活）；`refresh()` / `connect()` / `acknowledge(revision)` / `write(data)` / `resize(cols, rows)` /
  `rename(title)` / `close()`。
- 帧：`{type:'snapshot', sequence, screen, info}` / `{type:'output', sequence, data}` / `{type:'state', info}`；
  `state.render = { revision, frame }` 只承载 `snapshot|output`，**解析完必须 `acknowledge(revision)`**
  （不 ack 就再也不发下一帧）。
- `phase`: `idle|loading|creating|connecting|connected|disconnected|closing|closed|failed`；
  `issue`: `missingTerminal|inputFull|attachmentEnded|invalidOutput|terminalLimit`。

宿主自己的参考实现是 `dsh-client-ui-sidebar-terminal@0.2.0-rc.1`：核心 `lib/client.js` 19,899 字节、
只有一处 "xterm" 提及（注释），懒 chunk `lib/client.terminal.js` 685,961 字节打包了 xterm——
**本插件的构建形态照抄这一点**。它的 `TerminalBody` 也是这里页面逻辑的模板：
`useEffect(() => model.mount(), [model])`、snapshot 走 `reset()` + `resize()`、`xterm.write(data, cb → acknowledge)`、
`onData → model.write`、`ResizeObserver → fit.proposeDimensions()` 用 `environment.maxCols/maxRows` 夹紧、
`xterm.options.disableStdin = !writable`、主题取 `getComputedStyle(el).backgroundColor/.color`。

## 4. 实现

### 4.1 新增文件

| 文件 | 职责 |
|---|---|
| `src/client/terminal-client.ts` | **核心 bundle 安全**的宿主服务探针与身份助手：`webTerminals(ctx)` 结构化探测（`view`/`close`/`recover` 三个函数都在才算数）、`bottomTerminalKey(run)` / `bottomTerminalContentId(run)`、`terminalRunOf(tab)`、`nextTerminalMeta(tab)`、`closeBottomTerminal(ctx, tab, sessionId)`，以及那份**手工声明**的宿主类型面（不 import 宿主包，纯度门会拦 value-import，插件也不需要它的运行时） |
| `src/client/TerminalView.tsx` | chunk 载荷：`TerminalBottomView`（状态机 + 状态行/降级面板 + `TerminalScreen`） |
| `src/client/terminal.module.css` | 容器与状态面板样式，`color` 一律 `var(--dsw-*)` |
| `src/client/chunks/terminal.tsx` | chunk 入口（`export { TerminalBottomView }`），**只**被 chunk 构建引用 |
| `src/client/terminal-lazy.tsx` | `LazyTerminalBottom = lazyChunkComponent('terminal', …)`，核心 bundle 侧唯一的引用点 |
| `tests/terminal-tab.spec.tsx` | 15 条单元用例（承载面 / 宿主契约 / 降级与恢复 / 身份助手 / 关闭钩子） |

### 4.2 修改文件

- `src/client/service.ts`：新增 `TabDescriptor.bottomOnly?: boolean`；`openTab` 的原生分支条件加
  `&& descriptor.bottomOnly !== true`（落点强制 `'bottom'`）。
- `src/client/native/index.ts`：`sync()` 里 `if (descriptor.bottomOnly === true) continue`——
  既不注册原生 tab 类型，也不占 guide 条目。**这行的单元守护在 `tests/native-registration.spec.ts`**
  （「a bottomOnly descriptor never reaches the native surface」：断言注册表的**事件日志**里没有该 id、
  也没有它的 slot，且 guide 条目只有 `files` 与 `git`；删掉这行即红）。
- `src/client/builtins/tabs.tsx`：第 6 个描述符 `terminal-bottom`；`builtinTabs()` 改为收 `ctx`
  （`onClose` 要探测 `ctx.webTerminals` 才能结束进程）。`src/client/builtins/index.ts` 透传。
- chunk 名镜像：`tsdown.config.ts` / `src/bundle-route.ts` / `src/client/chunk-loader.ts` /
  `package.json#files` / `scripts/package-registry.mjs` / `tests/bundle-route.spec.ts`（`chunk-artifact` 与
  `manifest-consistency` 两个 spec 从 `CHUNK_NAMES` 派生，无需字面量改动）。
- 词典：`terminalNew` / `terminalUnavailable` / `terminalGone` 进 `locales.ts` 的 zh/en + 19 份第三语言词典。
- `package.json` + `pnpm-lock.yaml`：`@xterm/xterm@^6.0.0`、`@xterm/addon-fit@^0.11.0`
  （与宿主自用版本一致；lockfile 只手工拼接这 2 个包的 4 个块，避免 `pnpm add` 顺手重解析无关 caret 范围）。

### 4.3 恢复语义（三条决策的由来）

**为什么 contentId 恒定、不把 terminalId 写进 `tab.meta`**：`view()` 显式传 terminalId 会关掉
`createWhenMissing`。宿主的 durable 绑定本来就是按 `(sessionId, contentId)` 记的，页面只要**重复同一份
`(sessionId, key, contentId)`**，刷新后就能认回同一个 PTY——插件不需要（也不应该）自己存 terminalId，
存了反而会拿一个过期 id 把页面钉死在 `missingTerminal`。

**为什么「新建终端」要换代号**：DSH 重启后 PTY 全没了，而 localStorage 里的绑定还在 → 恒定 contentId
会永远认领一个死绑定，页面**永久卡住**。所以 `tab.meta.terminalRun`（默认 0）是身份代号位：
`bottomTerminalContentId(run)` 对 0 返回 `dsh-better-sidebar:terminal-bottom`，否则返回
`…#<run>`。「新建终端」写 `{terminalRun: run + 1}`，宿主因此另铸一个进程。**key 与 contentId 一起换**
——宿主的 `views` 是按 `(sessionId, key)` 记忆化的，只换 contentId 会命中旧视图。

**为什么关页签才结束进程**：宿主的契约是「视图跨 DOM 卸载存活」（这正是刷新能认回同一个 shell 的原因），
所以 `component` 卸载**不**调 `close()`。但这样每个关掉的底部终端都会永久占住宿主的一个 per-session
终端槽位（`terminalLimit` 是真实存在的 issue），因此描述符的 `onClose` → `webTerminals.close()` 是
**唯一**且必须存在的回收路径。

### 4.4 降级

- 宿主没挂终端控制器（`ctx.get('webTerminals')` 不是那个形状）：`available()` 为 false → `+` 菜单该行置灰；
  组件渲染 `data-terminal-state="unavailable"` 的说明面板，不 throw、不建 xterm。
- 绑定指向的进程已不存在（`issue === 'missingTerminal'`）或进程已退出：状态面板给「新建终端」按钮。
- `disconnected`：给「重试」按钮，`info` 在时走 `model.connect()`（重新接管），否则 `model.refresh()`。

## 5. 证据

- `tests/terminal-tab.spec.tsx`：15 条。xterm 与 addon-fit 都被 `vi.mock`（jsdom 里真 xterm 需要 canvas
  `getContext`，开不起来），所以断言的是**管道**：`view()` 的调用形状（含 contentId 恒定性）、
  `mount()`/detach、`write`/`resize` 转发、snapshot 重放 + `acknowledge`、降级面板、`onClose` → `close()`，
  以及「新建终端」走**真实** `service.updateTab`（先试 `surface.update`，无原生记录时落
  `store.reduce(patchTab)`——`bottomOnly` 类型永远没有原生记录，所以这是它唯一的真实路径）。
  真实 emulator 只由挂载 lane 的浏览器运行覆盖。
- `tests/native-registration.spec.ts` 新增一条：`bottomOnly` 描述符**不产生任何原生注册**（tab 类型 / slot /
  guide 条目），断言写在注册表的事件日志上。**补这条的原因**：验证节点实测把 `sync()` 里那行
  `if (descriptor.bottomOnly === true) continue` 删掉后，14 个相关 spec、158 条断言**全绿**——
  「不得进入原生承载面」这半边原先只有挂载 lane 抓得住（现在删掉即红，见第 6 节）。
- `tests/chunk-artifact.spec.ts` 新增一条：`lib/client-terminal.js` 里必须有 xterm 的
  `xterm-char-measure-element` 与 `@xterm/xterm/lib/xterm.js` 区域标记，而 `lib/client.js` /
  `lib/client-registry.js` 里**一个都不能有**（回退任一半即红）。
- `tests/builtins.spec.ts`：内置清单从 5 变 6，并新增「`terminal-bottom` 是 `bottomOnly`、可见、有图标与组件，
  而其余每个内置类型都不是 `bottomOnly`」。
- `tests/e2e/mount.e2e.ts` 新增第三条（真实浏览器）：展开底部工作台 → **点空面板里的类型卡片
  「Terminal」**（`PaneEmptyCards`，与 `+` 菜单共用同一份 `buildNewTabOptions`；用卡片而不是 `+` 是因为
  卡片不受 tab 条滚动视口影响）→ 断言 `[data-dsh-bottom-terminal]` 挂载、`.xterm` 出现、chunk 请求
  `/sidebar/bundle/terminal.js` 有响应、状态不停在 `unavailable`/`loading`、无 pageerror、**且宿主
  `[data-sidebar-right-guide-entry="terminal"]` 仍然恰好 1 条**（`terminal-bottom` 的 guide 条目必须是 0）。
  **`+` 菜单那条点击路径在 lane 里没有覆盖**。

## 6. 实施偏差与未验证项

- **`builtinTabs()` 加了 `ctx` 参数**：`onClose` 需要探测 `ctx.webTerminals`，而描述符工厂原先不收 ctx。
  两处调用点（`registerBuiltins`、`tests/lazy-chunk.spec.tsx`）同步更新。这是「关页签必须结束进程」的
  直接代价，不是顺手重构。
- **未验证：真 Windows**。本实现只在 macOS 上开发与验证。`@xterm/xterm` 是纯 JS，无原生依赖
  （`node-pty` 那条老路已经不在了），构建面没有任何平台分支；但 Windows 上的实际观感与 shell 行为
  （`cmd` / PowerShell 的 PTY 尺寸、字体回退）**没有在真 Windows 上跑过**。
- **未验证：真浏览器观感**。`tests/e2e/mount.e2e.ts` 的新用例断言的是结构、状态与错误面，
  **不**断言渲染像素、字符宽度、配色可读性。配色走 `--dsw-*` 令牌（`tests/theme.spec.ts` 守护
  「无硬编码颜色字面量」），但令牌解析出来的实际对比度没有截图核对过。
- **真实挂载 lane：已跑过**（实现节点与独立验证节点都在本分支上跑过 `pnpm test:mount`；第三条用例在真实
  `dsh web` 里通过，宿主 `terminal` guide 条目恰好 1 条、`terminal-bottom` 的条目为 0）。**口径**：完整
  lane 曾因**无关** spec `tests/e2e/zz-expand-refresh.e2e.ts` 抖动失败过一次（v0.24.1 修的「展开刷新」
  那条时序敏感用例，与本分支无关），**单独重跑即过**——不是本分支的回归，但「完整 lane 一次通过」
  这句话因此不能当证据用。
- **刻意不做**：宿主 `ui-sidebar-terminal` 的 `TerminalTheme`（OSC 4/10-12 拦截）没有照搬——xterm 自己
  处理 OSC，需要时再补。
