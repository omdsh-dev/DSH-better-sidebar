# 底部工作台终端：复用宿主 `webTerminals` 的一层视图（issue #774）

> 状态：已实现（本轮改动）。相关：issue #774、v0.21.1 的「终端交还宿主」变更（README / CHANGELOG v0.21.1）、
> 宿主的公开客户端终端服务 `@deepseek-ai/dsh-api-terminal-controller/client`（`ctx.webTerminals`）。

## 背景

v0.21.1 把自研终端整体交还 DSH：删掉了 `src/agent-pty.ts`、`src/client/TerminalView.tsx`、8 个
`terminal_*` 工具与 `node-pty` 依赖，终端从此只活在宿主的**原生右侧栏**
（`@deepseek-ai/dsh-client-ui-sidebar-terminal`，kind = `terminal`）。插件的**底部工作台**是自绘的，
于是一个真实缺口出现了：习惯「底部跑命令、右侧看文件」的用户在底部没有终端入口（issue #774）。

约束（决定方案形状的三条）：

1. **不许遮蔽宿主**：仓库的挂载 e2e 断言宿主的 guide 里 `terminal` **恰好 1 条**（多于 1 条即插件又在遮蔽宿主）。
   所以新类型不能注册成 native tab 类型，只能进插件自己的注册表。
2. **不复活自带 PTY**：维护者的方向是「终端归宿主」。方案必须复用宿主能力，而不是把 `node-pty` 加回来。
3. **host 半区与 client 半区改动代价不同**：client 改动刷新页面即生效；host 改动（路由、schema）必须重启 app。
   设计上尽量把新增能力放在 client 侧。

## 宿主提供了什么、没提供什么（0.1.7-rc.2 实读）

`ctx.webTerminals`（客户端服务，`super(ctx, 'webTerminals')`）提供：

- `view(sessionId, key, contentId, terminalId?, shellPath?)` → `TerminalView`：`state` 快照（`phase` / `writable` /
  `info` / `environment` / `render:{revision, frame}`）、`mount()`（返回只解 DOM 的 detach）、`write` / `resize` /
  `acknowledge` / `close`；
- `launchShells` / `selectShell`（外壳发现与记忆）、`recover(sessionId)`（列已存在终端）、`retainTabs`（窗口保留）。

它**不提供**任何外观概念（字体/主题/行高）；宿主的终端**视图组件也没有对外复用面**——
`@deepseek-ai/dsh-client-ui-sidebar-terminal` 的 `exports` 只有 `.` 与 `./client`（都是插件模块），
渲染器在它内部的懒加载 chunk 里，且它的正文只注册在 `sidebar.right.pane.tab` 这个**只有宿主右侧栏会渲染**的槽位上。

→ 结论：引擎能复用，像素必须自己画。于是 xterm 只能回到依赖里（纯 JS、无构建脚本，符合市场受管安装约束），
放进 `client-terminal` 懒加载 chunk，不进启动路径。

## 设计

### 1. `bottomOnly` 描述符语义（service.ts + native/index.ts）

`TabDescriptor` 新增 `bottomOnly?: boolean`：该类型**不镜像到原生右侧栏**——不注册 native 类型、不产生 guide 条目，
只能从插件的 `+` 菜单/服务打开。`native/index.ts` 的 `sync()` 在 `service.getTabs()` 循环里直接跳过它；
若它此前注册过，既有的对账循环会正常释放（`live` 里不在 `wanted` 的条目一律 dispose）。

这条语义同时是仓库 e2e 守卫（「宿主 terminal 恰好 1 条」）的实现基础：插件贡献的 `terminal` 类型与宿主的
`terminal` kind **同名但不冲突**，因为前者从未进入宿主注册表。

### 2. 终端 tab（描述符 + 懒加载视图）

- 描述符（`builtins/tabs.tsx`）：`id: 'terminal'`、`order: 40`（恢复旧版 `+` 菜单里终端的位置）、
  `bottomOnly: true`、`component: TerminalTabView`，以及一行声明式设置（字体，见 §4）。
- `terminal/terminal-tab.tsx`（核心 bundle）：`hasHostTerminals(ctx)` 结构探测（`ctx.get` 本身也可能缺席）+
  `lazyChunkComponent('terminal', …)`；服务不存在时描述符根本不注册（老宿主不多一个点不开的类型）。
- `terminal/TerminalView.tsx`（chunk 内，唯一 import xterm 的地方）：
  - 帧契约：`frame.type === 'snapshot'` → `reset()` + 对齐 `frame.info` 尺寸 + `write(frame.screen)`；否则
    `write(frame.data)`；两者都在 xterm 的 write 回调里 `acknowledge(revision)`（宿主靠它放行下一帧）；
  - 输入/尺寸：`onData → view.write`、`ResizeObserver → fit.fit() → view.resize(cols, rows)`；
    未连接时 `term.options.disableStdin = true`；
  - 生命周期：`mount()` 启动/恢复进程，卸载只 `detach()`（进程留在宿主）；**只有** `store.tabOpen(sessionId, tabId)`
    为假（tab 真被关掉）时才 `webTerminals.close(...)`——区分「会话切换/面板重挂载」与「用户关掉 tab」；
  - 恢复：首次挂载把宿主分配的终端 id 写进 `tab.meta`（随布局持久化），刷新后作为 `terminalId` 传回 → 宿主重连同一进程；
    失败态给「重试」，重试会先 `close()` 再换一个新的 `contentId` 重新分配；
  - 字体/主题：字体族见 §4；背景/前景优先读 DSH 令牌（`effectiveTokenValue`，玻璃皮肤下退回不透明兜底色），
    并订阅 `subscribeColorScheme` 就地换肤。

### 3. 窗口保留：并集 + 一帧后重放（terminal/retention*.ts）

宿主侧 `holders` 是**引用计数**，空闲回收只在 `holders.size === 0` 且静默超过 `unattendedTimeoutMs` 时触发；
但 `retainTabs` 的登记表是**最后写入者胜**，而宿主的终端 UI 插件会按它自己的 tab 列表反复登记（dispose 时还登记空列表）。
两个 dock 共存时，插件必须把「宿主右侧栏终端 + 本插件底部终端」作为**并集**登记，并保证**晚于**宿主那一轮写入：

- `retention.ts`：纯函数 `mergeRetainedTerminals(host, own)` + 注入式协调器 `createTerminalRetention`，
  调度默认 `queueMicrotask`（宿主的订阅回调是同步的，于是本插件的重放总在同一轮之内、其后执行）；
- `retention-host.ts`：从 `ctx.sidebarRight.openTabs` 取宿主终端 tab（结构探测 + 字段校验）、从
  `store.getSessionStates()` 遍历底部树取本插件终端 tab（`meta.contentId`，未挂载的 tab 用 tab id 占位，
  宿主反查不到绑定会跳过），并同时订阅两侧。

这是现有公开 API 下最稳的解法，但仍**依赖宿主的写入时机**：若宿主改成异步登记或引入多 owner 保留，
需要同步复核（PR 描述里已写明）。

### 4. 字体（唯一的观感设置）

xterm 用 canvas 量字宽，`font-family: var(--ds-font-family-code), fallback` 这类 CSS 链在它那里不生效——
必须拿到**具体字体族名**。因此：

- `SidebarPrefs.terminalFontFamily`（`''` = 跟随 DSH 代码字体）：`prefs-shared.ts`（类型 + 默认值）、
  `config.ts`（PrefsSchema；所有偏好统一走既有的 volatile 收集循环）、`client/prefs.ts`（解析校验）各一处；
- 描述符声明 `settings.toggles` 的 `type: 'text'` 行 →「设置 → 侧边卡片 → 终端 → 齿轮」里的「终端字体」，
  placeholder 给 `MesloLGS NF` 作例子；文案只说空值语义，不承诺字形覆盖（那是字体自身能力）；
- 视图订阅 store 的偏好变化，**就地换字体并重新测量**（不重建模拟器：内容/回滚缓冲/远端进程全部保留）。

宿主的右侧栏终端自带字体是写死的 monospace 栈且无设置项，因此本设置只覆盖底部工作台终端。

## 取舍与已知边界

- **xterm 回到依赖里**：这是「宿主导出视图组件」缺席下的必要代价。若上游愿意导出终端视图（或提供可被别的 dock 渲染的
  seat），本实现（xterm 依赖、字体设置、保留协调）可以整体删除——PR 描述里作为替代方案列出。
- **保留协调的时序依赖**：见 §3，属「用公开 API 能做到的最稳」，不是宿主保证的契约。
- **不做**：`+` 菜单里的「在右侧/底部打开」位置偏好（宿主 guide 已有 terminal 条目 + `Ctrl+`` 快捷键）；
  外壳选择 UI（`view()` 省略 `shellPath` 时宿主用记忆的外壳）；模型侧跨调用持久终端（旧 `terminal_*` 工具，另议）。
- 帧契约、`retainTabs` 语义、`bottomOnly` 与 guide 计数守卫都由单测/挂载 lane 钉住（见下）。

## 测试

- `tests/terminal-retention.spec.ts`：并集去重、同键以本插件为准、单次变更只写一次、**并集晚于宿主同步写入**、
  dispose 后不再写。
- `tests/builtins.spec.ts`：有宿主服务时注册 6 个类型（含 `bottomOnly` 的 terminal，`order: 40`）；**没有服务时仍是 5 个**
  （支持面不因这个特性收窄）；`bottomOnly` 类型不参与「每个可见类型都要有 guide 描述」的断言（它不进 guide）。
- `tests/bundle-route.spec.ts` / `tests/manifest-consistency.spec.ts`：chunk 清单的四处镜像
  （`src/bundle-route.ts`、`src/client/chunk-loader.ts`、`tsdown.config.ts`、`package.json.files` 与
  registry 打包脚本）同步包含 `terminal`。
- 挂载 lane（`pnpm test:mount`）：本插件不改它的既有断言；它继续钉「host terminal 恰好 1 条」这条守卫
  （即本实现绝不遮蔽宿主）。真机（桌面壳 + 真实 oh-my-zsh 会话）验证了创建/输入/尺寸/刷新恢复/关闭清理与字体。

## 附：字体偏好也作用于宿主自己的终端

宿主的 `ui-sidebar-terminal` 把 `fontFamily` **写死**成 `monospace` / `ui-monospace, …`，没有任何
字体设置项（0.2.0-rc.1 实读其 client bundle）——于是同一个 p10k / Powerline 提示符在底部工作台
终端里正常、在右侧栏终端里是 tofu。宿主终端用的是 xterm 的 **DOM 渲染器**（`DomRenderer`，无
webgl / canvas addon），字体经 CSS 生效，因此插件的「终端字体」偏好同时以一条 CSS 变量 +
`!important` 规则透传过去（`src/client/terminal-font.ts`）：

- 偏好为空 ⇒ 不设置变量 ⇒ 整条声明失效，完全回落到宿主自己的字体（零副作用）；
- 偏好非空 ⇒ `.xterm-rows` / `.xterm-screen` 一起换字体，底部终端与右侧栏终端观感一致。
- 取舍：xterm 仍按**初始化时的 `options.fontFamily`** 量字宽，只改绘制字体；所选字体与
  `monospace` 的 ASCII 字宽不一致时可能出现列位轻微漂移（Nerd Font 的 mono 变体通常与
  Menlo/Monaco 同宽，实测无感）。彻底的做法是宿主把字体做成设置项。
