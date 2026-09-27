# Changelog

> 本文档收录 dsh-better-sidebar 的完整发布历史（最新版摘要见 [README](README.md)；同步发布于 [GitHub Releases](https://github.com/omdsh-dev/DSH-better-sidebar/releases)）。

### v0.22.0

> 📦 **正式版**（npm `latest`）：仅支持 **DSH 0.1.7-rc.1+**（peer 下限 `^0.1.7-rc.1`，CI 钉 `@deepseek-ai/dsh@0.1.7-rc.1`）——本版没有动支持线，0.21.1 的用户直接升级即可。**DSH 0.1.6-alpha.2 及更早仍请固定 v0.19.1**。主内容是把任务管理页从「子代理拓扑」重做成**工作流图**，并在随后几轮里按真机反馈打磨；期间 DSH 0.1.7 删掉了 Agent Teams 的 Remote 方法，团队与后台任务两个数据面随之改写。

- 🧩 **任务管理页 = 工作流图（全新主显示模式）**：会话树渲染为分层节点 + 贝塞尔连线的画布——拖拽平移、滚轮缩放到光标、内容包围盒居中适配（双击背景重新适配）、右下角控制条（图/树切换 + 折叠开关 + 缩放 + 适配）。**经典缩进树保留**（键盘可导航），两种模式共享同一个视图模型，折叠状态与团队富化不会视觉漂移；默认视图走设置里的偏好。
- 🃏 **双段式节点卡**：上段 = 类型徽章（主代理 / 子代理 / 成员 / 工作流 / 已完成聚合）+ 相位徽标 + 名称 + 元信息；下段小条 = 状态点 + 状态词 + **主 Agent 同款合并活动行**（并发工具按类别归并 + 计数 + 最新在跑那条的细节，措辞直接取宿主 `chat` 命名空间的词条）+ 已完成节点的折叠 chevron。运行中小条从左到右**完整扫过**（1.5s，令牌渐变，`prefers-reduced-motion` 下关闭）。卡片 8px 圆角、只用上段极淡底色表达层级、当前会话用加粗 accent 描边。
- 🔀 **工作流 run 入图**：宿主侧从 `tool-workflow/*` 会话事件折叠出 run（与官方 workflow-run 面板同一批事件），run 挂在发起代理下、成员 agent 重新挂到 run 节点下并按相位分框、同色相位徽标；catalog 里没有的成员用 run 自身数据合成占位节点，所以跑完的 run 仍能看到它的成员。
- 🗂 **折叠分两组，各自说清自己是什么**：`✓ N 已完成`（已完成 + 出错，失败会单独报 `出错 N`）与 `N 个待命`（跑完一轮、随时可被叫起来的 teammate）是**两行**；**手动 chevron 永远有效**（不设阈值），**自动聚合**只在「待命成员 ≥3」时收空闲成员——1~2 个待命成员就是这个团队的工作集，而且它们的卡上会挂任务行。聚合卡名字行写「前两个名字 + `+N`」，点聚合全部展开。
- 🪟 **两个常驻浮动窗**（抽出可复用的 `FloatingWindow`）：后台任务输出与共享任务详情/编辑都在其中——可拖拽、可四边拉伸、内容区自滚动、只靠关闭按钮或 Escape 结束时消失（外部点击、失焦、锚点离屏都不关）。任务窗把窗口余量交给描述区（编辑态交给多行输入框），拉大窗口是给内容更多空间而不是留白；动作行固定在 footer，长描述不会把按钮推出视野。
- 👥 **Agent Teams 任务板（实验层）**：团队成员富化到对应节点上、常驻任务条列出成员与共享任务；任务状态机跟随宿主（待办 → 认领 → 进行中 → 完成 → 重开）+ 改派 / 编辑 / 两击删除，CAS 过期修订单独提示（别人改过 → 已刷新）。**成员活动由 `subagents.live` 的 running 叠加**，不是在客户端猜。
- 🔄 **后台任务改读宿主客户端服务**：0.1.7 的 web profile 挂载客户端 `ctx.jobs`（推送 roster + 非消费输出流 + kill），插件因此删掉自建的 `jobs.list` / `jobs.output` / `jobs.kill` 三条路由与事件回放镜像，也彻底不碰模型 `job_output` 游标（宿主把这层约束变成了能力）。输出改在常驻浮动窗里流式显示并尾随，代理数 ≥ 8 时抽屉自动折叠。
- 🛠 **DSH 0.1.7 的两处数据面重写**：① 团队读——0.1.6 的 `agentTeams.remoteView` 三个 Remote 方法被上游删除，插件改为读 Lead Session 的 **`agentTeam` Session projection**（与 `subagentCatalog` 同源、推送式），删掉 `teams.view` 路由与 5 秒轮询；写路径保留两条路由（`createTask` / `updateTask`），拒绝从「返回联合」变为「抛 `TeamError`」，`TEAM_TASK_STALE_REVISION` 映射成 409 `team-conflict`。② 后台任务——见上一条。**修掉的真实故障**：0.1.7 上团队条从来不渲染（路由报 `remoteView is not a function`，页面静默无提示）。
- 🐛 **真机抓到的四个缺陷**（单测都绿的）：
  - 逐节点折叠按钮点了没反应——它被**自动**折叠的守卫卡住了（`isAutoFoldable` 要求非成员且是叶子），而按钮是**手动**触发，现在两种触发各有各的守卫；
  - 「待命」的卡片**从来不画**折叠按钮（chevron 的渲染条件写死成「已完成/出错」），现在「不在执行」即提供；
  - 认领任务后标签变「阻塞」——`ready` 的语义只是「待办且无未完成 blocker 可认领」，对所有非 pending 任务都是 false，现在收敛成唯一规则 `taskBlocked/taskStatusLabel/taskTone/taskDotState`；
  - 任务窗「完成」在队列中的任务上必失败——宿主状态机要求先认领，动作行现在跟随状态。
- 🎨 **窄屏与手机设置**：卡片/行距/字号按原生右侧栏的窄宽重新定档（内容包围盒居中、缩放夹取、平移边界、相位框配色、连线 stub 加粗、卡片高度预算重算）；设置页新增**手机**分组——窄屏（≤768px）时新任务页不再自动弹出、任务管理页默认走树状图。
- 📐 **基线**：`@deepseek-ai/dsh-*` 钉版与支持线**不变**（0.1.7-rc.1，peer `^0.1.7-rc.1`）。新增词条若干（含 `teamTaskClaim` / `tasksFoldIdle` / `taskWindowCreate` / `tasksStateProvisioning` 等）×20 份词典；设计文档见 [docs/plans/2026-09-14-tasks-graph-workflow-teams-design.md](docs/plans/2026-09-14-tasks-graph-workflow-teams-design.md)、[2026-09-27-tasks-graph-polish.md](docs/plans/2026-09-27-tasks-graph-polish.md)、[2026-09-27-floating-window-mobile-settings.md](docs/plans/2026-09-27-floating-window-mobile-settings.md)、[2026-09-27-agent-teams-dsh-0.1.7-adaptation.md](docs/plans/2026-09-27-agent-teams-dsh-0.1.7-adaptation.md)（含实施偏差与已知限制）。

### v0.20.0（开发线，**从未发布**）

> 🚫 **这一版没有发布到 npm**（npm 上 `latest` 仍是 v0.19.1）：它原本是 0.1.6-alpha.2 线的正式版，开发完成后被 0.21 线直接取代，所以下面这些变更实际随 **v0.21.1** 一起发布。原本的定位：仅支持 **DSH 0.1.6-alpha.2+**（peer 下限 `^0.1.6-alpha.2`，CI 钉 `@deepseek-ai/dsh@0.1.6-alpha.2`）。**这是一次破坏性变更版**：0.1.5-rc.* 用户请固定 `dsh-better-sidebar@0.19.1`。适配记录见 [docs/plans/2026-09-21-dsh-0.1.6-alpha.2-adaptation.md](docs/plans/2026-09-21-dsh-0.1.6-alpha.2-adaptation.md)。

- 🖥️ **终端交给 DSH 内置**：DSH 0.1.6 自带右列终端（`ui-sidebar-terminal`），所以插件删掉了整套自研终端——`pty-manager` / `agent-pty` / `pty-deps` / 8 个 `terminal_*` 工具 / xterm 视图与字体链接 / 跨会话固定终端，以及 `node-pty` 依赖、它的 `allowBuilds` 放行与安装脚本的 `-Repair` 模式。**注意**：模型因而失去跨调用持久的终端（只剩一次性 `bash` / `pwsh`）；上游 `@deepseek-ai/dsh-tool-terminal` 未被内置 bundle 挂载，需要时请自行在 profile 里启用。
- 🌐 **浏览器视图让给内置**：插件删掉 `BrowserView` / 沙箱状态条 / 嵌入性探测（含宿主 `browser.probe` 路由）与两个只配置自家 iframe 的设置项；**保留**聊天与界面的外链接管（按协议分流是宿主没有的能力），目标改为 DSH 内置的 `browser` tab 类型。
- 🧩 **产物行交回宿主**：DSH 0.1.6 把 `conversation.chat.turnTail` 从 chain 改成 list（上游有意让多个插件**追加**而非互相替换），插件原来的接管只能与内置产物卡重复，因此整体删除；点击行为不变（内置走宿主 `openFile` → 本插件编辑器）。代价是失去轮尾那一个「在文件树中显示」入口（树内右键仍在）。
- 🐛 **修复两个静默破坏**：`SidebarRightGuideEntry.id` 变成必填后，缺 id 会让**整个原生承载面静默空掉**（抛在 `ctx.inject` 回调里被吞）；`turnTail` 改 list 后原注册直接抛错、产物行失效。两处都已修好并加测试守护，同时补了注册失败的上报口。
- 🎨 **空白面板卡片对齐内置卡风格**：`.paneCard` 改用 DSH 指南胶囊那套配方（0.5px l4 描边 / 24px 圆角 / layer-1 填充 / 56px 下限 / 14×20 内边距），并加测试守护其几何、令牌化配色，以及不复制上游那套**未定义**的 `--dsw-alias-bg-l1/-l2` 拼写。
- 📐 **基线**：`@deepseek-ai/dsh-*` 全部钉 `0.1.6-alpha.2`，`dsh-code-runtime` 整包消失已移除，`diff` / `simple-icons` 作为 primitives 的新裸 import 提升进 devDependencies；`ui-primitives` 本版三处破坏（`IconSendOutline16` 下线、`TerminalBlockLabels.noExitCode` 新增、`ConnectionIndicator.reconnectLabel` 移除）同步适配。

### v0.19.1

> 📌 **正式版**（npm `latest`，无 prerelease 后缀）：钉版推进到 **DSH 0.1.5-rc.2**（npm `next`），**peer 下限仍是 `^0.1.5-rc.1`**——rc.2 的上游 delta 里没有任何触及本插件的面（零 `packages/api|host|session|agent` 变更，真实代码改动只有消息反馈弹窗、产物卡片 CSS 与 `CodeFileIcon` 的 SVG 数据拆分），因此 rc.1 用户无需升级 DSH 即可用本版。DSH 0.1.5-alpha.2 用户继续用 **v0.19.0-alpha.1**；0.1.2-rc.1 稳定线继续用 **v0.18.1**。

- 🎯 **适配 DSH 0.1.5-rc.2**：devDependency 钉版、CI 挂载车道与 `SIDEBAR_SERVICE_VERSION` 同步到 rc.2；插件侧**零代码改动**（上游 delta 未触及本插件，逐文件核对见 [docs/plans/2026-09-10-dsh-0.1.5-rc.2-adaptation.md](docs/plans/2026-09-10-dsh-0.1.5-rc.2-adaptation.md)——300 个变更文件里绝大多数只是各包 `package.json` 的版本号单行）。
- 🎨 **文件图标（#611）与内置 Tab 图标改为彩色**（#531 + #594 合并，实现按 rc.2 重做）：
  - **文件/文件夹图标走 DSH 官方图形**：回退链末端是宿主 `ui-primitives` 的 `FileTypeIcon`（48 类官方全彩代码/配置图形 + markdown/图片/PDF/Office/视频/文件夹的类目色板），插件**不再自带扩展名表，也不再需要图标懒加载 chunk**——`#429` 那份 563 条彩色数据与 `lib/client-file-icons.js`（255 kB）连同 `fileIconTheme` 设置开关一并删除，彩色就是唯一形态（核心 bundle 因此只增 10 kB）。
  - **新增对外 `registerFileIcon` API**（能力 `'fileIcons'`）：按扩展名（`exts`）、精确文件名（`names`）、目录名（`folderNames`）注册自己的图标，优先级降序、同级按注册序；**注意**：宿主分类器覆盖任意路径，所以注册 `exts: []` 的 catch-all 会接管所有未具体命中的行。
  - **内置 tab 图标彩色**：文件 / 文件变动 / 任务管理 / 侧边对话 / 终端 / 浏览器 六个类型与 diff 视图的 glyph 换成彩色版本（颜色全部来自 `--dsw-alias-*` 令牌，皮肤照旧全覆盖）。
  - **原生右侧栏的 tab 芯片也带图标**：宿主的 tab 定义没有 icon 字段，但 `sidebar.right.pane.tab.title` 槽就是芯片内容——插件在该槽渲染「图标 + 标题」（编辑器 tab 带路径时显示该文件的图标），glyph 为 `aria-hidden`，芯片可访问名不变。
- 🛠 **CI 修复一：Windows lane 的真实超时**。`ci-windows` 在 2026-09-09/10 窗口内红了 8 次，其中 6 次是真起进程的用例撞上 vitest 默认 5000ms：`tests/agent-pty.spec.ts`（真起 PowerShell + ConPTY）与 `tests/install-powershell.spec.ts`（冷启 `powershell.exe` 实测 12.1s）现在各自声明 30s 预算，且 `vitest.config.ts` 的全局 `testTimeout` 从默认 5000ms 提到 **15s**（第一次真实 Windows 跑又在**第三个**文件上翻车：`tests/git.spec.ts:85` 耗时 9607ms——三个文件同一个根因，逐文件加超时是打地鼠）；`waitForTranscript` 的内层轮询预算从 5000ms 降到 15s，**内层预算必须小于外层**（原先是同一个 5000ms，结构性必然超时）。`ci-windows` 的 `Test` 改跑 `pnpm test:windows`（`--maxWorkers=2`），在 2 核 runner 上不再让真起进程的 spec 互相抢占。
- 🛠 **CI 修复二：挂载车道的 npm 安装**。`plugin-mount` 的 `npm install -g @deepseek-ai/dsh@<ver>` 曾 4 次失败（2 次 `ETARGET`、2 次 `JavaScript heap out of memory` exit 134）：钉版自身的传递依赖是浮动 `^` 范围，上游**分阶段发布**预发布版时（rc.2 于 09-10 的 14:43–14:57 逐包上线）npm 会组出 rc.1/rc.2 混合 peer 图（3062 条 ERESOLVE）。现在钉一个**已完整发布**的 rc.2（修 ETARGET）并加 `NODE_OPTIONS=--max-old-space-size=4096`（修 OOM）。中途试过 `--legacy-peer-deps`，被真实 CI 否掉：它跳过的正是全局安装必须提供的 peer，`dsh-app-boot` 在 boot 时 require 的 `@deepseek-ai/cordis-plugin-group` 是 peer 而非 dependency，加了它 CLI 直接 `ERR_MODULE_NOT_FOUND`。

### v0.19.0

> 📌 **正式版**（npm `latest`，无 prerelease 后缀）：本版仅支持 **DSH 0.1.5-rc.1+**（peer 下限 `^0.1.5-rc.1`，CI 钉 `@deepseek-ai/dsh@0.1.5-rc.1`）。DSH 0.1.5-alpha.2 用户请继续用 **v0.19.0-alpha.1**（npm `alpha` 标签仍指向它）；0.1.2-rc.1 稳定线继续用 **v0.18.1**。

**✨ 新功能**

- 📝 **新建标签页列表恢复可选说明**（#613）：DSH 0.1.5-rc.1 让 `SidebarRightGuideEntry.description` 回归（可选），插件随之恢复 `TabDescriptor.description`，六个内置类型各写回一条说明（原生指南的 文件 / 文件变动 / 任务管理 / 侧边对话 / 终端 / 浏览器 六行都带上它），`guideDesc*` 词条回到 20 份词典。**宿主的原生指南只在列出的条目 ≤ 4 条时渲染说明**（更长的列表是整列丢弃，不是截断），而插件默认贡献 6 个 guide 条目——因此默认组合下说明不渲染，只有在插件设置页关掉足够多的 tab 类型、把 guide 压到 ≤ 4 条时才会出现。未声明说明的条目仍是「图标 + 标题」单行（插件不补通用兜底句）。

**🐛 修复**

- 无。rc.1 相对 alpha.2 的 delta 很小（373 个变更文件，绝大多数是上游各包版本号、原生右侧栏预览 UI 打磨与测试快照），除上述说明字段回归（并附带上游 `files` 类型改用自己的彩色文件夹图标作指南字形）外，没有需要插件适配的变更。

**🧰 CI 与内部**

- 基线推进到 **DSH 0.1.5-rc.1+**（#613）：peer 下限、devDependency 钉版、CI 挂载车道与 `dsh.plugin.json` 的 `engines.dsh` 同步（rc.1 在 npm 上同时是 `latest` 与 `next`）。
- 明确未变、不必再核：全局主面板模型（`main` 槽 / `sidebar.panellist` / `ctx.layout` / 根级 `rightbar` + `rightbar.session`，插件仍不接入）、文件地址语法（`packages/util/workspace-path` 只动了版本号）、原生 tab 体宿主契约（`.paneBody` 仍是有确定高度的块级滚动容器）、core / agent / session / subagent 宿主 API 与 `ui-primitives` 导出面（仅 CodeBlock 渲染变化）。
- `@deepseek-ai/dsh-client-ui-primitives@0.1.5-rc.1` 仍不声明 `dependencies` 而 bundle 仍裸 import `anser` / `shiki` / `@shikijs/langs/*` / `mdast-util-*` / `micromark-*` / `katex`——上一版提升进 devDependencies 的那组包因此保留，不得回退。
- 真机验证（DSH 0.1.5-rc.1 + 插件 0.19.0）：门禁 `typecheck` / `lint` / `check:consumer-types` 全绿，单测 **124 files · 1296 passed · 9 skipped**，`pnpm peers check` 干净；挂载冒烟对真实 rc.1 **7 passed**（含 tab 体填充断言，以及新增的「指南 ≤4 条时说明才渲染」断言）；本地 3080 实测：guide 六行仍是「图标 + 标题」（6 > 4，说明按上游规则不渲染；上游把胶囊 `min-height` 从 48px 调到 56px），文件树点击 `AGENTS.md` 落到插件编辑器（CodeMirror 就绪），sidechat 输入框贴底（宿主盒 962px == 面板体 962px，composer 底边距 8px），底部工作台与中心列左右边完全重合，`pageerror` 0（控制台仅有第三方 `dsh-tauri-worktree` 的 `/api/dsh-worktree/attach` 500，与本次改动无关）。

### v0.19.0-alpha.1

> 🧪 **alpha 通道**（npm dist-tag `alpha`，安装 `dsh-better-sidebar@latest`）：本版仅支持 **DSH 0.1.5-alpha.2+**（peer 下限 `^0.1.5-alpha.2`，CI 钉 `@deepseek-ai/dsh@0.1.5-alpha.2`）。0.1.5-alpha.1 请继续用 **v0.19.0-alpha.0**；0.1.2-rc.1 稳定线用 **v0.18.1**（npm `latest`）。

**✨ 新功能**

- 🪟 **每个 tab 体都填满面板**（#609）：原生右侧栏的 tab 体宿主是「有确定高度的块级滚动容器」而非 flex 容器，此前插件各 tab 的根只写 `flex: 1`，在块容器里塌成内容高度——侧边对话的输入框因此贴不到面板底（转录一长就被推出可视区）。现在 native 适配层统一给每个 tab 体包一层 `height: 100%` 的列 flex 宿主，插件全部 tab（含第三方 `registerTab` 注册的 descriptor）恢复与底部工作台一致的填满语义。

**🐛 修复**

- 🧭 **跟随 DSH 0.1.5-alpha.2 的文件地址语法**：`fileAddressFor` 一律产出 session 作用域地址、绝对路径保留前导 `/`；`parseFileAddress` 改为前缀解析并忽略 `?`/`#` 后缀。
- 🪟 **底部工作台的中心列定位跟随 alpha.2 全局面板改动**：`conversation` 槽改为根级 `main` keyed 槽下的 `main.conversation`，定位器改认新 key 并跳过 `display: contents` 槽宿主（alpha.1 的旧 key 仍兼容）。

**🧰 CI 与内部**

- 基线推进到 DSH 0.1.5-alpha.2（#609）：peer 下限、22 个 devDependency 钉版、CI 挂载车道与 `dsh.plugin.json` engines 同步；`pnpm peers check` 干净（按 §3-9 补提 `dsh-session-persistence` 传递 peer）。
- **移除 `TabDescriptor.description`**：alpha.2 的原生指南条目不再渲染第二行（改为「图标+标题」胶囊），该字段与 6 个 `guideDesc*` 词条（20 份词典）一并下线；新建标签页的默认页改由注册表选（恰好 1 个指南条目则直接打开它）。

### v0.19.0-alpha.0

> 🧪 **alpha 通道**（npm dist-tag `alpha`，安装 `dsh-better-sidebar@latest`）：本版仅支持 **DSH 0.1.5-alpha.1+**（peer 下限 `^0.1.5-alpha.1`，CI 钉 `@deepseek-ai/dsh@0.1.5-alpha.1`）。0.1.2-rc.1 稳定线请继续用 **v0.18.1**（npm `latest`）。

**✨ 新功能**

- 🖥️ **接入 DSH 原生右侧栏**（#604）：右列改为 DSH 自己的右侧栏——插件的 7 个 tab 类型全部注册成原生 tab 类型 + 原生 tab 体；聊天里的文件打开统一走 `ctx.sidebarRight.openResource(dsh-resource://file/…)`；`editor` 类型以 `extension` 优先级认领文件资源（压过内置文本预览）并接管内置「文件」页 kind（注销即复位）；跨会话打开在目标会话未上屏时排队重放。
- 🧩 **退役插件自绘右侧面板与自由窗口**（#605）：右列归 DSH 后，插件只保留底部工作台（单分栏树、随会话持久化），开合按钮注册进 DSH 会话头 utilities 槽；浮窗 API（`floats` / `floatTab` / `dockFloat` / `raiseFloat` / 右键「移动到自由窗口」）、`features` 里的 `'floatWindows'`，以及 `openByDefault` / `defaultWidthPercent` / `changesDiffFloat` 三个设置项一并删除（旧持久化文档里的 `floats` 字段被忽略，不影响加载）。
- 🔗 **适配 DSH 0.1.5 宿主契约**（#603）：`assistant/chunk` 事件删除 → 实时增量改由 `agent/assistant-stream` 帧折叠（侧边对话转录的 `live` 字段）；`sessionPersistence.inspect` 删除 → 冷会话读取改走 `open(id,'read')`；会话头 `version` 用 `SESSION_FORMAT_VERSION`。

**🐛 修复**

- 侧边对话转录 / `jobs.output` 回放 / fork 继承等 8 处会话事件读取跟随 0.1.5 契约；自定义种子补齐 fork 标记对，避免继承父会话未领取的 inbox 输入。

**🧰 CI 与内部**

- 真机挂载冒烟门禁钉 0.1.5-alpha.1，e2e 增加「展开原生栏 → 经引导页逐个打开插件 tab 类型」的巡检；typecheck / lint / 单测 / 挂载车道全绿。

### v0.19.0（未发布）

- 🎨 **可选彩色图标主题**：设置页「文件 → 文件图标」可在**内置单色**与**彩色品牌图标**之间切换——彩色主题含 563 条规则（218 扩展名 + 197 精确文件名 + 148 目录名，如 `.tsx → React`、`package.json → npm`、`node_modules` 着色），数据在**懒加载 chunk**（`lib/client-file-icons.js`）里，只有选中时才下载，默认关闭时启动零开销。数据源自 [#429](https://github.com/omdsh-dev/DSH-better-sidebar/pull/429)（@fenter）。
- 🎨 **文件图标多样化 + 对外图标注册 API（[file-icons.tsx](./src/client/file-icons.tsx)）**：文件树与编辑器文件 tab 不再是单一 `VscFile`——markdown / 图片媒体 / PDF / JSON / 40+ 代码扩展 / 配置 / 数据库 / lock / 压缩包各有专属 glyph（VSCodicons 单色 `currentColor`，遵循皮肤契约），未知扩展回退通用图标。`ctx.betterSidebar` 新增 `registerFileIcon`（`features` 含 `'fileIcons'`）：按扩展名 / 精确文件名（`names`）/ 目录名（`folderNames`）注册自定义图标（彩色 ReactNode 亦可，颜色责任在注册方），`exts: []` 为全局默认（只兜内置 glyph 没认领的扩展，不吞掉内置多样性），保留扩展名 `'folder'` / `'folder-open'` 可换目录行图标；`fileIcon` / `folderIcon` 为权威解析器（完整回退链 + 逐工厂崩溃隔离），注册/注销即时生效。接入示例见[外部插件指南 §7](./docs/external-plugin-guide.md)。

### v0.18.1

> 📌 **正式版**（npm `latest`）：DSH 基线不变（**0.1.2-rc.1+**，peer 下限 `^0.1.2-rc.1`）——本版是 v0.18.0 之后的增量发布：变更面板预览能力增强、文件树可写，以及五项修复。

**✨ 新功能**

- 📄 **变更面板操作预览增强**（#499）：`.md` 阅读模式（含 mermaid 渲染）、`.html` 与 `.pdf` 内嵌渲染预览；diff 语法高亮扩展到 mjs/cjs/mts/cts、CSS/SCSS/Less、HTML/XML/SVG/Vue、GraphQL、JSONC/JSON5；新增**密钥脱敏**层（预览默认开启，面板头部可切换）
- 🗂️ **文件树重命名 / 删除**（#550）：行内重命名 + 确认式删除，右键菜单减重与子菜单视口钳制
- 🧩 **插件目录名与 shell 预设文案词典化**（#535）：跟随宿主语言

**🐛 修复**

- 🔀 **git diff 折叠上下文真实展开**（#576，修复 #577）：折叠行此前显示「n 行…点击展开」却点不动（`-U3` 裁剪使 gap 段没有行文本）；现按需经 `git.show` 拉取两侧完整内容切片填充，带加载 / 失败降级三态与请求去重；顺带修复该路由的 `rev:path` 寻址（此前恒返空）
- 💬 **侧边对话种子不再继承父会话未领取的 inbox 消息**（#562）：补 fork 标记对，消除「上下文很长时侧边对话先把之前的 User 消息发出去」的幽灵消息
- 🖼️ **Markdown 分栏渲染器内的本地图片**（#569）：改写为可访问 URL，不再 404

**🧰 CI 与内部**

- ESLint flat config 接入 CI 与 Makefile（#536）、Makefile 命令面规范化（#526）、e2e 脚本加固（#527）、共享组件测试工具收敛样板（#524）
- 重构：Sidebar.tsx 按关注点拆分（#542）、四处轮询习语收敛到 `use-polling`（#541）、删除 rc.7 宿主的 `__DSH_MODULES__` 回退路径（#540）、One Dark/Light 语法色板单源化（#534）、重复实现收敛与死代码清理（#525）

### v0.18.0

> 📌 **正式版**（npm `latest`）：本版仅支持 **DSH 0.1.2-rc.1+**（peer 下限 `^0.1.2-rc.1`）；不再支持 0.1.0-rc.8 ~ 0.1.1-rc.2——DSH stable 用户请固定安装 `dsh-better-sidebar@0.17.1`，停留在 0.1.2-alpha.x 的宿主继续用 `dsh-better-sidebar@latest`（v0.18.0-alpha.0）。

**✨ 新功能**

- 🌿 **「文件变动」统一 tab**（#475）：Git 视角（真 diff / 历史 / 暂存·提交·还原 / worktree·子仓库选择）与本轮文件视角（模型读/写/编辑实时追踪）双视角合一；统一 diff 渲染（改蓝配对 + 行内字符级高亮 + 语法着色 + 上下文折叠）、底部可拖拽预览面板、一键展开独立 diff tab
- 💬 **侧边对话渲染升级**（#486）：主对话级 Blocks 结构、turn 用量尾标、断线重连横幅
- ⚙️ **工作区路径围栏开关**（#458）：新增 `workspaceFence` 声明式设置键，工作区外路径 403 时错误面一键关闭并指引

**⚡ 性能**

- 🚀 **核心包 -45%**（#489）：19 个非中英词典 chunk 懒加载、渲染稳定化（转录行复用 / tree Sets / 批量 drag）、启动与轮询开销削减（单次 settings fetch、每 tick 单 git 进程）；新增 perf 测量 lane；顺带修复底栏拖拽把面板宽度泄漏进宿主布局、原生左栏突跳的 bug
- 📉 会话列重复 DOM 查询削减（#456）

**🐛 修复（节选）**

- ✏️ 编辑器 / Markdown：SSH 远程链接客户端打开（#522）、预览/编辑切换保持阅读位置（#467）、预览隐藏 YAML frontmatter（#394）、TOC 外点关闭与层级修复（#461）、@-引用保留 basename（#417）
- 💻 终端 / 平台：Windows 自定义 shell 解析（#503）、resize 失败容错（#428）、字体解析兜底等宽（#366）、WSL 会话 Linux 绝对路径（#455）、Windows Explorer reveal 保留选中（#508）
- 🗂️ 布局 / 状态 / 文件树 / 对话：桌面 shell 布局与侧卡片共存（#398）、窄屏自动激活不强制抽屉（#373）、自由窗口 id 恢复冲突（#385）、窗口聚焦自动刷新文件树（#469）、引用提示固定行尾（#509）、划选弹窗关闭与草稿插入锚定（#427）、折叠态开关组对齐（#361）、旧引擎滚动跳变兼容（#448）、旧版 Git worktree 列表（#454）

**🧰 CI 与内部**

- Windows CI 车道（#520）、Makefile 命令面规范化（#526）、e2e 脚本加固 + 聚合双挂载回归（#527）、共享组件测试工具收敛样板（#524）、重复实现收敛与死代码清理（#525）

**🌐 生态收录**

- 新收录 10+ 插件：dsh-better-sidebar-icons（#441）、dsh-sidenote（#451，原 dsh-sidechat #470）、dsh-github-workbench（#410）、dsh-bilingual-reader（#379）、dsh-server-deck（#413）、dsh-md-export（#405）、dsh-code-nav（#404）、dsh-suhuang-scroll（#392）、dsh-better-overleaf（#370）等（均含 18+ 语言 i18n 补齐）

<details>
<summary><b>历史版本（v0.12.0 – v0.15.2）</b></summary>

### v0.19.0-alpha.0（0.1.2-alpha.5 适配，未发布，内容并入 v0.18.0）

> 🧪 **alpha 通道**：本版仅支持 **DSH 0.1.2-alpha.x**（peer 下限 `^0.1.2-alpha.5`，npm dist-tag `alpha`）。该版本号当时未单独发布，内容已并入 **v0.18.0** 正式版；v0.19.0-alpha.0 这个号后来被 0.1.5 适配线复用（见上）。

- 🔗 **适配 DSH 0.1.2-alpha.5（npm 已发布，`alpha` dist-tag）**：CI 挂载门禁钉版、`dsh.plugin.json` engines 下限与 `@deepseek-ai/*` peer / devDependencies 基线升至 0.1.2-alpha.5（真机挂载冒烟 14/14 验证）。`dsh-client-locale` 上游停在 0.1.2-alpha.3 未发新版，其 peer 下限 / devDep 保持并天然兼容 alpha.5 运行时（`pnpm peers check` 零失配，无需新增提升传递 peer）。代码适配了 alpha.4 的兼容性标记改动——`Session.events` 属性移除，迁移到按需读 API `snapshotEvents()`（sidechat 转录 live 读、fork 继承、`jobs.output` 回放、subagent 活跃度共 8 处），新建线程 meta 中宿主已删的 `seedLength` 一并移除；alpha.4 其余变化（双向 `send_message`、自定义模型发现复用 Profile 请求头、`SessionSeq`/`SessionLogOffset` 强类型）与 alpha.5（升级启动修复）经核实不触及本插件其余表面。

### v0.18.1-alpha.0

> 🧪 **alpha 通道**：本版仅支持 **DSH 0.1.2-alpha.x**（peer 下限 `^0.1.2-alpha.3`，npm dist-tag `alpha`，安装 `dsh-better-sidebar@latest`）。该版本号未单独发布，内容已并入 **v0.18.0** 正式版。

- 🔗 **适配 DSH 0.1.2-alpha.3（npm 已发布，`alpha` dist-tag）**：CI 挂载门禁钉版、`dsh.plugin.json` engines 下限与 `@deepseek-ai/*` peer / devDependencies 基线升至 0.1.2-alpha.3（真机挂载冒烟 14/14 验证）。逐点核查了 alpha.2 → alpha.3 全部 117 个 commit：插件依赖的宿主契约（token 鉴权、斜杠 RPC、`MarkdownText` labels、`sidechat.events` 所依赖的事件流与持久化 API、`SettingsNamespaceInput`、`SUBAGENT_DESCRIPTOR_VERSION`（仍为 3）、`dsh-client-store`、profile 加载器、node-pty 钉版）均无变化，无需代码适配；alpha.3 的破坏性改动（`BeginSubmissionInput.mode` 必填、subagent 错误码改名 `attachment-invalid`、SQLite 持久化后端移除、投影 change feed 收紧为 identity-gated）经核实均不触及本插件。

### v0.18.0-alpha.0

> 🧪 **alpha 通道**：本版仅支持 **DSH 0.1.2-alpha.x**（peer 下限 `^0.1.2-alpha.2`，npm dist-tag `alpha`，安装 `dsh-better-sidebar@latest`）；不再支持 0.1.0-rc.8 ~ 0.1.1-rc.2——stable DSH 用户请用 v0.17.1（npm `latest`）。

- 🔗 **适配 DSH 0.1.2-alpha.2（npm 已发布，`alpha` dist-tag）**：CI 挂载门禁钉版与 `@deepseek-ai/*` devDependencies 基线升至 0.1.2-alpha.2（真机挂载冒烟 14/14 验证）。适配点：`dsh-settings` 移除运行时导出 `settingsNamespace`（命名空间改为编译期校验，宿主侧直接传常量）；`dsh-subagent` 描述符版本 2→3（由宿主包盖章，测试断言跟随 `SUBAGENT_DESCRIPTOR_VERSION` 常量）；`SessionEvent.ignorable` 恢复与 Remote 网关 `RemoteError` 封装经核实对本插件无破坏。
- 🐛 **修复 DSH 0.1.2-alpha.1+ 上侧边对话转录空白**：转录轮询此前仍走 alpha.1 已移除的 `ctx.connection.api`（错误被静默吞掉，tab 永远渲染空转录），现改由插件自有 `sidechat.events` 路由供给（活线程读内存事件日志、冷线程读会话持久化，`afterSeq` 增量拉取，[sidechat-routes.ts](./src/sidechat-routes.ts)）。
- 🧹 **删除对 0.1.1-rc.x 及更早的兼容层**：e2e 宿主 RPC 从点分/斜杠双方言收敛为斜杠单方言（token URL 必选，[host-protocol.ts](./tests/e2e/host-protocol.ts)）；`MarkdownText` labels 收敛为嵌套单形状（[markdown-labels.tsx](./src/client/markdown-labels.tsx)，不再双 prop 名）；peerDependencies / devDependencies / `dsh.client.inject` / chunk externals 白名单四处同步清除已消亡的 `@deepseek-ai/dsh-client-runtime`。

### v0.17.1

- 🔗 **DSH 0.1.2-alpha.1 适配（双版本兼容）**：DSH 0.1.2-alpha.1 的 Remote gateway、一次性 token 浏览器鉴权与 `MarkdownText` labels 契约变更已全量适配，插件在 0.1.0-rc.8 ~ 0.1.1-rc.2 与 0.1.2-alpha.1 上一致工作（后者经 GitHub tag 源码构建的真机挂载冒烟 14/14 验证；alpha.1 至今未发布 npm，CI 钉版已在 v0.18.0-alpha.0 升至 npm 发布的 0.1.2-alpha.2）。要点：`MarkdownText` 四个渲染点统一改走双形状 labels helper（[markdown-labels.tsx](./src/client/markdown-labels.tsx)），修复 alpha.1 上 markdown/mermaid 预览的 `reading 'code'` 崩溃；e2e 冒烟双协议化（token URL 换 cookie、`/api` 斜杠端点 + 按参数名包装 args，[tests/e2e/host-protocol.ts](./tests/e2e/host-protocol.ts)）；移除已在 0.1.2-alpha.1 消亡的 `@deepseek-ai/dsh-client-runtime` peer

### v0.16.1

自 v0.16.0 以来的全部更改：

**🐛 修复**

- 🧊 **Git 面板卡死 + 重启死循环**（[#376](https://github.com/omdsh-dev/DSH-better-sidebar/pull/376)，修复 [#369](https://github.com/omdsh-dev/DSH-better-sidebar/issues/369)）：开启「源代码管理」面板可能整页冻结、重启后自动恢复冻结状态且无法退出——三层无上限操作叠加所致，现已全部设界：**① status 截断**——`git status --untracked-files=all` 响应上限 2000 条（超限置 `truncated`，面板显示截断提示，对齐 `fs.read` 截断语义；worktree 变更计数同步有界），海量未跟踪文件不再冻结浏览器主线程；**② 仓库发现限界**——cwd 非 Git 仓库（如家目录）时不再对每个可见子目录串行无界探测：探测超时 30s→5s、子目录探测上限 200 个、并发请求共享同一次扫描并按 60s TTL 缓存，家目录不再引发 `git rev-parse` 进程风暴；**③ 重置逃生通道**——带 `?dsh-sidebar-reset` 打开页面即丢弃持久化布局（含共享宽度）从默认布局启动，即使原页面已卡死也能自救，移除参数后恢复持久化；`statusTruncated` 文案同步全部 19 个词典

### v0.16.0

自 v0.15.2 以来的全部更改：

**✨ 新功能**

- 🪟 **自由窗口**（[#354](https://github.com/omdsh-dev/DSH-better-sidebar/pull/354)）：把标签栏的任意 tab（内置或插件注册）**拖到主会话区域**——会话列出现虚线提示浮层，松开即成为悬浮窗口（默认 390×780，手机竖屏比例，创建时按视口钳制后居中于松点）；窗口支持头部拖动移动、右下角 SE 缩放（≥320×200）、点击任意处置顶、头部右键「回到侧边栏 / 关闭」、X 走 `closeTab` 正常关闭生命周期（释放终端等）；拖到侧边栏 pane 上时该 pane 高亮、松开即**停靠**合并回该 pane；`floats` 随会话持久化（刷新原样恢复，宽容 sanitize + 几何钳入视口）；服务语义：`features` 新增 `'floatWindows'`——`openTab` 的 dedupe/id 聚焦命中浮动 tab = **置顶窗口**（不重复开、不展开面板），`closeTab` / `activateTab` 对浮窗正常关窗 / 置顶并照常触发回调，浮窗内 tab `visible` 恒 true，agent 终端 reconcile 覆盖浮窗；tab 内容复用常规渲染、插件 tab 与 pane 完全同契约；附带文件二级页面 8px 网格间距规整（[设计文档](docs/plans/2026-08-23-free-window-design.md)）
- 📂 **模型主动打开（`sidebar_open` 工具）**（[#353](https://github.com/omdsh-dev/DSH-better-sidebar/pull/353)）：侧边栏新增全局设置 `agentOpenTools`（**默认关闭**），开启后向模型注入**一个**工具——模型可在调用方会话的侧边栏打开本地**文件**（editor tab，按 path 去重）、**文件夹**（全窗树窗口，以该目录为根，`meta.dir`）与 **HTTP(S) 网页**（browser tab，URL 预填）；关闭设置即注销工具并清空未投递队列，已打开 tab 保留；非激活会话的打开排队、下次可见时重放（`/sidebar/ws/agent-opens` 推送，同一 trust fence）；无新增公共 API、不改变 `BetterSidebarService`（[设计文档](docs/plans/2026-08-23-agent-open-tools-design.md)）
- 📝 **Markdown README 级内嵌 HTML + 目录大纲（TOC）**（[#360](https://github.com/omdsh-dev/DSH-better-sidebar/pull/360)）：Markdown 预览现在真实渲染**块级内嵌 HTML**——徽章墙 `<div align=center>`、`<details>` 折叠块内嵌 markdown、表格单元格 `<br/>`/`<sub>`/`<img>`、`<video>`/`<picture>` 全部经 DOMPurify 白名单消毒（`<script>` 等活性内容剥除、`<a>` 强制 `_blank rel=noopener`），本地媒体 src 重写为会话媒体路由；≥3 标题出现浮动**目录大纲**按钮，点击平滑滚动并自动展开折叠 `<details>`，HTML 段内标题同样收录；渲染器仍是宿主 `MarkdownText`（shiki / KaTeX / GFM 保留），纯 markdown（零 HTML）文档走原路径零回归（[设计文档](docs/plans/2026-08-24-markdown-html-toc-design.md)）
- 🌏 **第三语言覆盖（19 语言）**（[#339](https://github.com/omdsh-dev/DSH-better-sidebar/pull/339)）：接入可选 peer `@huanlin/dsh-plugin-better-locale`——ja / de / fr / pt / ko / ar / hi / id / tr / vi / th / ru / it / nl / sv / pl / zh-HK / zh-TW / zh-MO 全量词典（每种约 340 keys）；覆盖**借用 DSH 英文槽位**（DSH active=en 时生效，zh 下完全惰性、界面不混语言）；19 语言词典同时注册进 better-locale，外部 `ctx.locale.lookup('betterSidebar', key)` 调用者同样可拿覆盖文本；未安装时 `ctx.get('betterLocale')` 为 undefined、整段 no-op，zh/en 行为不变
- 🌿 **Git 多仓库选择 + linked worktree 变更发现**（[#326](https://github.com/omdsh-dev/DSH-better-sidebar/pull/326) [#285](https://github.com/omdsh-dev/DSH-better-sidebar/pull/285)）：会话 cwd 是工作区容器（非 Git 仓库）时自动发现直接子仓库并显示**仓库选择器**——status / 分支 / 历史 / diff / 暂存 / 提交 / 还原 / cherry-pick / 文件打开全部按所选仓库线程化；linked worktree 的变更发现与按工作树操作（含延迟分页响应的事务一致性），并拒绝过期 / 可修剪的 worktree 命令目标、对单库存取失败降级
- 🖥️ **浏览器本地回环允许清单**（[#365](https://github.com/omdsh-dev/DSH-better-sidebar/pull/365)）：新增侧边卡设置 `browserAllowedLoopback`（逗号分隔 host 或 host:port；裸 host 匹配任意端口、带有端口精确匹配）——显式信任的本地开发服务器（如 Vite）可导航，并额外获得 iframe `allow-same-origin` 令牌（模块 / HMR / fetch 管线需要真实 origin，否则白屏）；页面相对 GUI 与其他站点仍是跨源；服务端 `browser.probe` 镜像同一允许清单，本地服务器不再被误拒
- 📝 **编辑器 Vue + 28 种 legacy 语言语法高亮**（[#202](https://github.com/omdsh-dev/DSH-better-sidebar/pull/202)）：`.vue` 映射 `@codemirror/lang-vue`（template / script / style 按 `lang` 属性分派、`<style lang="scss">` 预处理器）；零新依赖用 legacy-modes 补齐 scss/sass/less/stylus/ruby/lua/perl/r/dart/scala/groovy/powershell/diff/protobuf/cmake/pug/tcl/haskell/clojure/erlang/julia/pascal/vb/vhdl/stex/objectivecpp；语言工厂抛错降级纯文本（console.warn），不再炸编辑器；`.v` / `.m` 跨语言歧义故意不映射
- 🔄 **编辑器预览刷新三件套**（[#215](https://github.com/omdsh-dev/DSH-better-sidebar/pull/215) [#228](https://github.com/omdsh-dev/DSH-better-sidebar/pull/228)，修复 [#167](https://github.com/omdsh-dev/DSH-better-sidebar/issues/167)）：文本预览新增**手动刷新**按钮；编辑保存后切回预览自动重载（dirty 时抑制，草稿不丢）；预览模式下保存成功边沿自动重载；移除自动轮询与 `fs.stat` 版本端点（后台 API 零流量）
- 🖼️ **Markdown 本地 / 相对图片**（[#292](https://github.com/omdsh-dev/DSH-better-sidebar/pull/292)）：`![alt](./img.png)`、`/cwd/img.png` 与引用式 `[id]: url` 目标重写为 `/sidebar/file` 媒体 URL（会话 cwd 边界不变）——预览不再只显示 alt 文本
- ➕ **推荐插件目录新增 ego-browser**（[#340](https://github.com/omdsh-dev/DSH-better-sidebar/pull/340)）：`@dsh-external/ego-browser` Agent 浏览器 Tab（会话侧边栏自动注册本机浏览器页，无 better-sidebar 时回退浮动浮窗）；描述词典 19 语言补全（[#371](https://github.com/omdsh-dev/DSH-better-sidebar/pull/371)）

**🐛 修复**

- 🛒 **DSH 市场受管安装兼容**（[#338](https://github.com/omdsh-dev/DSH-better-sidebar/pull/338)）：移除 `peerDependencies` 里的公开版 `cordis`（市场预览硬拒依赖字段出现 `cordis`，optional 无效）——npm 包满足 [dsh-community-market 安装规范](https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/dsh-community-market/docs/install-and-uninstall.zh.md)，dshfind / 1024Store 目录里的条目重新获得 `repository_backlink` 验证目标，可直接从 Desktop 市场受管安装
- 🔤 **类型基底迁移到 `@deepseek-ai/cordis`**（[#338](https://github.com/omdsh-dev/DSH-better-sidebar/pull/338)）：`Context` = 真实 vendored cordis Context 与结构化服务面的**交集**，`ctx.betterSidebar` 类型合并改挂 `@deepseek-ai/cordis`，公开版 cordis 不再被依赖。**消费者迁移**：`import type { Context } from 'cordis'` 改为 `import type { Context } from '@deepseek-ai/cordis'`（`import type {} from 'dsh-better-sidebar'` 的类型合并方式不变）；未使用该导入的插件无影响
- 🧩 **插件树内 `ctx.betterSidebar` 读取全面修复**（[#357](https://github.com/omdsh-dev/DSH-better-sidebar/pull/357)，修复 [#356](https://github.com/omdsh-dev/DSH-better-sidebar/issues/356)）：npm 安装的 DSH 0.1.1-rc.x（web bundle）下侧边栏页面每次加载即崩（`cannot get property "betterSidebar" without inject`）——26 处内部直读 `ctx.betterSidebar` 改走 `ctx.get('betterSidebar')`（root reflect store 解析，不受 fiber 链影响）；外部消费者 `inject: ['betterSidebar'] + ctx.betterSidebar` 契约不变
- 🔐 **文件 API 会话工作区边界**（[#345](https://github.com/omdsh-dev/DSH-better-sidebar/pull/345)，修复 [#328](https://github.com/omdsh-dev/DSH-better-sidebar/issues/328)）：`fs.tree / fs.read / fs.write` 的 workspace 越界访问修复；媒体、HTML 预览与上传统一 real-path 符号链接校验；新增绝对路径 / 符号链接 / 上传 / 嵌套 Git 会话回归测试
- 🪟 **面板宿主层级与视口裁剪**（[#330](https://github.com/omdsh-dev/DSH-better-sidebar/pull/330) [#278](https://github.com/omdsh-dev/DSH-better-sidebar/pull/278)，修复 [#277](https://github.com/omdsh-dev/DSH-better-sidebar/issues/277)）：面板宿主层 z-index 40→25——低于 DSH cordis 动态插件面板 30，工作台不再遮挡 cordis 清单 / 审批面（AppFrame 20 之上、100+ 浮层之下）；宿主 `overflow: hidden` 裁剪视口边缘，收起的面板不再把文档撑出双向滚动（实测 `scrollWidth` 2289→1672 / `scrollHeight` 1280→1032，任意皮肤）
- 📐 **布局推挤加固**（[#310](https://github.com/omdsh-dev/DSH-better-sidebar/pull/310) [#130](https://github.com/omdsh-dev/DSH-better-sidebar/pull/130) [#180](https://github.com/omdsh-dev/DSH-better-sidebar/pull/180)）：对话列补 `min-height: 0` + `overflow: hidden` + `overflow-wrap: anywhere`（长不可断 URL / OAuth 链接不再把 composer 与左侧设置按钮挤出视口）；layout-push effect 拆「仅设置 + 仅卸载移除」并按 `panelOpen` 门控宽度 push——右栏关闭时拖底部高度不再挤压对话区、松手瞬间不再整页右铺再回弹；`useLayoutEffect` 消除跨 paint 全宽闪帧；松手 flush 最终帧 + `centerRect.right` 同步提交；底部高度按 `viewportHeight - PANEL_MIN` 封顶；拖拽手柄拖动中不再高亮
- 📱 **移动端无会话状态说明 + 1px 溢出修复**（[#254](https://github.com/omdsh-dev/DSH-better-sidebar/pull/254)）：无会话时开关改用 `aria-disabled` 保持不可执行语义、同时允许触摸 / 键盘聚焦显示「选择一个会话以使用侧边栏」提示；panel 改 `border-box`——移动端 `100vw` 含左边框，不再产生 1px 横向溢出
- 📏 **侧边栏宽度跨会话共享**（[#36](https://github.com/omdsh-dev/DSH-better-sidebar/pull/36)）：面板宽度是布局偏好而非会话内容——「最后一次拖拽胜出」写入全局 `dsh-sidebar:v1:width`，缓存会话切换与新建会话即时跟随；无全局键（首次运行 / 旧会话）时行为逐字节不变
- 🧹 **会话删除立即关闭该会话终端**（[#130](https://github.com/omdsh-dev/DSH-better-sidebar/pull/130)）：新增 `PtyManager.closeSession()` + 订阅 DSH `session/disposed`——删除会话不再等 30s 重连宽限到期（agent 终端由 agent 生命周期管理，不受影响）
- 🔍 **文件名搜索跳过噪声目录**（[#342](https://github.com/omdsh-dev/DSH-better-sidebar/pull/342)）：`node_modules` / `.pnpm-store` / `.yarn` / `.turbo` / `.next` / `dist` / `build` / `coverage` 等黑名单（小写不敏感，`.git` 仍跳）——超大依赖树不再耗尽 10 万访问预算提前 `truncated`，`docs/` 等后序目录里的真实文件能搜到；不引入 `.gitignore` 语义，保持「文件名查找」
- 📝 **mermaid 全局错误渲染抑制**（[#341](https://github.com/omdsh-dev/DSH-better-sidebar/pull/341)）：开启 `suppressErrorRendering`——非法图表不再把大错误 SVG 注入 `document.body`；组件级错误回退与源码展示保留
- 🖥️ **终端 Nerd Font 图标字体回退**（[#190](https://github.com/omdsh-dev/DSH-better-sidebar/pull/190)）：starship / powerlevel10k 提示符的补充平面 PUA 图标（Nerd Fonts v3 Material 图标集）不再显示豆腐块——`withIconFontFallbacks()` 为胜出的基础字体追加 Nerd Font 图标族（插入首个通用族之前、按族名去重、过滤 CSS 全局关键字、不列彩色 emoji 字体）
- 🌐 **HTML 预览 UTF-8 声明**（[#193](https://github.com/omdsh-dev/DSH-better-sidebar/pull/193)，修复 [#170](https://github.com/omdsh-dev/DSH-better-sidebar/issues/170)）：`/sidebar/html` 响应带 `charset=utf-8`（无 `<meta charset>` 的中文片段不再乱码），保留原始文件字节
- 🧪 **trust-fence Origin 改按 hostname 比较**（[#182](https://github.com/omdsh-dev/DSH-better-sidebar/pull/182)）：Edge 151 把非默认端口 loopback 页面的 Origin 序列化为无端口形式——`http://127.0.0.1` 对 `Host: 127.0.0.1:3080` 不再 403（对齐 DSH 官方网关栅栏）；不同 hostname / opaque null origin 仍拒绝
- 🪟 **「在文件夹中显示」改为资源管理器揭示**（[#94](https://github.com/omdsh-dev/DSH-better-sidebar/pull/94)）：不再把目录当文件开进编辑器（`"..." is a directory`）——`revealInExplorer` 切到资源管理器 tab、面板折叠时自动展开、展开父目录并高亮滚动到本轮产出文件；产物行数据改读引擎 Turn deliverable（与 ui-deliverables 同源）
- 🖱️ **面板拖动布局闪烁**（[#180](https://github.com/omdsh-dev/DSH-better-sidebar/pull/180)）：右侧栏关闭时拖底部高度不再左移挤压对话区；松手瞬间不再整体右铺再回弹
- 🖥️ **PowerShell 安装脚本修复**（[#47](https://github.com/omdsh-dev/DSH-better-sidebar/pull/47)）：远程入口统一为「下载脚本 → 移除 UTF-8 BOM → 内存执行」，`-Version` / `-DryRun` 参数在 Windows PowerShell 5.1 下恢复生效（BOM 解析不再吃掉首行 `param(...)`）；安装前校验 `pnpm --version`（主版本 <10 时明确报错并以退出码 1 结束，不再写一半 profile）
- 🔄 **浏览器嵌入探测 GET 兜底**（[#69](https://github.com/omdsh-dev/DSH-better-sidebar/pull/69)）：HEAD 响应同时缺 CSP 与 X-Frame-Options 时回退 GET 重试一次——阿里云百炼等只在 GET 回头发嵌入策略的站点不再显示误导性「拒绝连接请求」，而是正确显示「该站点拒绝嵌入」面板 + 「在浏览器中打开」
- 🔧 **git 源安装修复 `unrun` devDependency**（[#336](https://github.com/omdsh-dev/DSH-better-sidebar/pull/336)）：tsdown 0.22 经 `unrun` 加载配置而 pnpm 11 不自动装 peer——git-hosted 安装的 `prepare` 不再报 `Failed to import module "unrun"`（npm tarball 不受影响）
- 🍃 **`ctx.effect` 严格化顺手修了 4 处**：拦截注册失败时 effect 体返回 `undefined` 改为 no-op disposer（vendored cordis 的 effect 契约要求返回 disposer，返回 `undefined` 属非法形状）

### v0.15.2

自 v0.15.1 以来的全部更改：

**✨ 新功能**

- 🗂️ **文件树「在应用中打开」子菜单**（[#334](https://github.com/omdsh-dev/DSH-better-sidebar/pull/334)）：文件树右键菜单新增「在应用中打开 >」子菜单——内置打开方式（资源管理器显示/选中、VS Code、Cursor、Zed），每行右侧图钉可固定为右键菜单顶层直达项（再点取消）；配置可选 SSH host 后 VSCode 系条目改用 `vscode-remote/ssh-remote+<host>/<path>` 协议打开，本地专用条目自动隐藏；支持自定义编辑器（名称 + URL 模板 `{path}` + 是否 VSCode 系，配置入口在 Files 卡片齿轮弹窗）。打开动作经新宿主路由 `POST /sidebar/api/open.external`（argv 数组 spawn，无 shell 注入）（[设计文档](docs/plans/2026-08-22-open-with-menu-design.md)）
- 📑 **Tab 右键菜单**（[#331](https://github.com/omdsh-dev/DSH-better-sidebar/pull/331)）：页签右键提供「关闭 / 关闭其他页签 / 关闭左侧页签 / 关闭右侧页签」，作用范围为当前 pane（标签组），无可关对象时置灰；仅打开菜单、不切换激活页签；批量关闭逐条走既有 `onClose` 路径，生命周期完整
- 📄 **Diff 文件默认折叠**（[#270](https://github.com/omdsh-dev/DSH-better-sidebar/pull/270)）：改动文件头部改为可访问的展开/折叠控件；识别出的源文件默认展开，测试 / 文档 / 生成文件 / lockfile 与未知类型默认折叠；保留现有 500 行上限
- 📖 **README 更新**：特性巡礼改为表格展示（每行两张图，节省空间）；社区补全微信群 / QQ 群二维码（[#325](https://github.com/omdsh-dev/DSH-better-sidebar/pull/325)，QQ 群 577011007）

**🐛 修复**

- 🪟 **空分栏清理**（[#268](https://github.com/omdsh-dev/DSH-better-sidebar/pull/268)）：持久化的 split pane 在临时 diff tab 被清理后遗留全尺寸空分栏——`sanitizeState` 现在同时修剪空的 split leaf，并修复修剪后的失效激活 pane 指针；整个工作台为空时保留唯一空 pane
- 🖥️ **Windows 下隐藏 Git 子进程窗口**（[#301](https://github.com/omdsh-dev/DSH-better-sidebar/pull/301)，关闭 [#124](https://github.com/omdsh-dev/DSH-better-sidebar/issues/124)）：`runGit()` 统一加 `windowsHide: true`，仓库状态轮询与操作不再闪现控制台窗口（其他平台行为不变）
- 📁 **未跟踪文件夹内文件差异**（[#242](https://github.com/omdsh-dev/DSH-better-sidebar/pull/242)）：`git status` 从 `--untracked-files=normal` 切换为 `--untracked-files=all`——新文件夹内每个文件独立成行、可正常加载差异（修正 `fs.read` 报 "is a directory"，与 VSCode 默认行为一致）
- ⚡ **开关/拖拽每帧 React 重渲染消除**（关闭 [#315](https://github.com/omdsh-dev/DSH-better-sidebar/issues/315)）：centerRect 改 ref + 底栏 DOM 直写（零 React 渲染）；TabContent memo（显式比较器）；新增 frame-batcher 对 Divider/dock 拖拽按帧合并；拖拽期跳过无意义 locate。4x CPU 节流 A/B：开关 >17ms 帧 collapse 19→6 / expand 24→4~6，p95 21ms→15ms；拖拽不变（非回归）

### v0.15.1

自 v0.15.0 以来的全部更改：

**✨ 新功能**

- 💬 **侧边对话 Codex 风格转录重构**（[#314](https://github.com/omdsh-dev/DSH-better-sidebar/pull/314)）：转录改为**折叠行**——工具调用 / 思考 / 上下文注入统一为安静的单行 chrome（chevron + 标签 + 单行参数摘要，展开为 hairline 缩进正文，无卡片无填充），流式标签与创建 shimmer（shimmer = 生成中）、失败工具 danger、`prefers-reduced-motion` 停帧；**首条问题不再被边界提示吞掉**——上下文注入与首问拆分交付（边界 + 快照经 `agent.inject` 排队、问题唤醒驱动），转录把注入映射为可折叠注入行、真实用户消息（**含首问**）渲染为用户气泡，旧线程的首问同样拆分为独立气泡
- 📖 **README 重写**：功能导览（逐特性实机截图）、用户视角 DSH 兼容徽章、简化安装流程（`add` → `approve-builds` → `add`、node-pty 安全构建、粘贴到 DSH 安装提示）、插件生态 28+ 与分类折叠展示

**🐛 修复**

- 🖥️ **终端跨会话切换保活**（[#323](https://github.com/omdsh-dev/DSH-better-sidebar/pull/323)）：切到其他会话不再被当作瞬时掉线——客户端卸载时发送 `park` 控制帧，主机跳过 30s 重连宽限倒计时；切回会话（`open()` 取消 parked）或显式关闭恢复正常生命周期；agent 终端保持无限期存活
- 📂 **文件树上传遮罩不再拦截 Tab 拖拽**（[#317](https://github.com/omdsh-dev/DSH-better-sidebar/pull/317)）：拖拽 Tab（重排 / 跨 pane split）经过资源管理器时不再弹上传遮罩、不吞事件——统一按 `dataTransfer.types` 含 `Files` 门控（与面板宿主 shield 一致），Tab 正常落下；OS 文件拖拽行为不变
- 💬 **子代理自动展开去抖**（[#314](https://github.com/omdsh-dev/DSH-better-sidebar/pull/314)）：Side Chat 线程创建不再误弹任务页——0→N 触发 500ms 重臂并对实时快照按原基线重评估，标题过滤器识别线程后才放行；真实子代理依然自动激活任务页（宽屏展开侧边栏，窄屏只准备 Tab、不强制展开抽屉）

### v0.15.0

自 v0.14.0 以来的全部更改：

**✨ 新功能**

- 💬 **侧边对话(beta) Tab**（[#286](https://github.com/omdsh-dev/DSH-better-sidebar/pull/286)）：Codex 风格的侧边线程，**每个对话一个独立 Tab**——子会话继承主会话完整上下文（已完成回合 + 未回答消息 + 进行中回合的 assistant 输出与工具调用，以「interrupted」冻结标记诚实继承）；同组合创建（同 preset / provider / model）复用前缀输入缓存；线程对主会话列表不可见、零子代理目录噪音；线程内可持续追问（重启后自动冷恢复）；一键「保存为新会话」提升为顶层会话（[设计文档](docs/plans/2026-08-20-sidechat-tab-design.md)）
- 📤 **文件窗口上传**（[#239](https://github.com/omdsh-dev/DSH-better-sidebar/pull/239)）：头部「上传文件 / 上传文件夹」按钮 + 拖放上传（拖到树区 = 工作区根，目录行 = 进该目录，文件行 = 进其所在目录，对齐 VSCode）；上传时全屏模糊进度弹层（文件级进度 + 取消 / Esc）；上传中按钮禁用、成功后文件树自动刷新
- 🧩 **桌面兼容四选项**（[#284](https://github.com/omdsh-dev/DSH-better-sidebar/pull/284)）：位置兼容模式改为**主行下拉**——**自动检测**（默认，保守：仅使用标准的 Window Controls Overlay 几何，32/36px 等各壳差异自动跟随、最大化/还原实时更新，网页环境零修改）/ **DSH官方Web**（显式零适配）/ **壳兼容方案**（内置预设，手动启用；只收录 issue/PR 中出现过且 100+ star 的壳，命中环境带「已检测」提示）/ **自定义方案**（自定义 CSS + 下移距离）。旧版本已有兼容配置的用户自动落到自定义方案；交互控件统一退出桌面拖拽区（`no-drag`）；底栏推挤锚点复合选择器双保险（`[data-pane]` 与 `:has(> [data-slot])`）
- 🎛️ **设置页 UI/UX 现代化**（[#300](https://github.com/omdsh-dev/DSH-better-sidebar/pull/300)）：侧边卡片二级设置入口改为卡片底部「功能设置」设置条（替代右下角隐形齿轮，可发现性提升）；协调双色启用态（brand 激活强调 + success 绿勾选徽标）；全部颜色仍为 `--dsw-alias-*` 令牌派生，皮肤体系自动跟随
- ➕ **推荐插件目录新增**：`dsh-docs-panel` 全局文档面板（[#230](https://github.com/omdsh-dev/DSH-better-sidebar/pull/230)）、`dsh-flowglass`（[#261](https://github.com/omdsh-dev/DSH-better-sidebar/pull/261)）、`dsh-git-forge` 与 `dsh-ssh-tunnel`（[#204](https://github.com/omdsh-dev/DSH-better-sidebar/pull/204)）、`dsh-turn-review`（[#102](https://github.com/omdsh-dev/DSH-better-sidebar/pull/102)）

**🐛 修复**

- ⚡ **子代理页实时预览批量接口**（[#298](https://github.com/omdsh-dev/DSH-better-sidebar/pull/298)）：旧实现每个 running 子代理独立轮询 `subagents.history`，host 侧每次触发全量子代理枚举形成 O(N²) 放大、多子代理并发时页面卡顿——改为单个批量接口 `subagents.live`（一次枚举整棵子代理树）+ 客户端单轮询、单在途请求；展示逻辑与文案不变
- 🖱️ **拖拽中断 / 快速释放不再回滚**（[#249](https://github.com/omdsh-dev/DSH-better-sidebar/pull/249)，关闭 [#247](https://github.com/omdsh-dev/DSH-better-sidebar/issues/247) [#248](https://github.com/omdsh-dev/DSH-better-sidebar/issues/248)）：中断 / 快速释放提交最后已知位置；HMR 后中心列重定位兜底（修复热更新后底栏空白）
- 📐 **推挤变量挂载期持续有效**（[#259](https://github.com/omdsh-dev/DSH-better-sidebar/pull/259)，修复 [#258](https://github.com/omdsh-dev/DSH-better-sidebar/issues/258)）：拖拽松手后底边栏不再闪全宽
- 🔧 **适配 DSH 0.1.1-rc.1 / rc.2（@next）**（[#297](https://github.com/omdsh-dev/DSH-better-sidebar/pull/297) [#305](https://github.com/omdsh-dev/DSH-better-sidebar/pull/305)）：无代码逻辑改动
- 🔒 **上传链路安全加固**（[#239](https://github.com/omdsh-dev/DSH-better-sidebar/pull/239)）：`relativePath` 空段 / 绝对路径显式拒绝；临时文件唯一命名（并发上传互不干扰、崩溃不阻塞）；写流错误监听（磁盘失败不崩溃进程）；客户端错误码与服务端统一、413 本地化
- 🔐 **文件 API workspace 边界加固**（[#328](https://github.com/omdsh-dev/DSH-better-sidebar/issues/328)）：`fs.tree/read/write`、媒体、HTML 预览和上传统一按真实路径限制在会话 workspace 内，拒绝越界绝对路径与外链符号链接

### v0.14.0

> ⚠️ 本版起需要 DSH ≥ 0.1.0-rc.8。自 v0.13.1 以来的全部更改：

**✨ 新功能**

- 🖼️ **统一面板宿主注入重构**（[#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)）：面板/开关簇迁入 `[data-dsh-panel-host]` 固定含块层（`fixed inset-0 z-40`），免疫桌面套壳中间层 transform 对 fixed 含块的劫持；挂载自检（页面级 transform → `data-dsh-panel-host-degraded` 降级同步，按未修正几何判定、祖先变换消失才退出）；推挤锚点改 `#root [data-dsh-frame] > [data-pane="conversation"]` + `#root` calc 宽度防桌面壳加性溢出；chunk 激活重验证（HEAD+ETag 保留未变 chunk，5s 超时兜底 fail-open）；`visualViewport` 键盘 inset + `env(safe-area-inset-*)` 移动端适配
- 📂 **文件打开方式默认独立**（[#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)）：`editorExplorer` 默认从「合并」改为「独立」——新会话树点击 / 打开文件按路径**新开**文件 tab，无路径窗口即纯资源管理器；合并模式保留为可选手动开启
- 🖥️ **终端 shell / shellArgs 设置页可配**（[#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)）：终端卡齿轮二级页面新增「Shell 路径」「Shell 参数」两行配置（此前只能通过 `cordis.patch.yml` 配置）——设置页写入后对**之后打开的** UI 终端与模型终端（`terminal_create`）即时生效；留空保持 yaml → `$SHELL` / 登录 shell / `powershell.exe` 的既有解析顺序
- 🏷️ **设置页版本徽标**（[#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)）：侧边卡片设置页顶部新增 `DSH-better-sidebar v0.14.0` 身份徽标（版本与服务实例同步，由测试守护）
- 🔍 **添加插件目录搜索 / 分组 / 独立滚动**（[#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)）：为插件生态增长做准备——目录列表顶部加实时搜索（按名称 / id / 描述过滤），条目支持可选 `category` 分组渲染，列表独立滚动（弹窗不再随条目数无限增长）

**🐛 修复**

- 🧩 **rc.8 模块系统迁移**（[#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)）：rc.8 不再暴露 `window.__DSH_MODULES__` 页面全局（改由 `ctx.modules` 服务提供），懒加载 chunk 的外部依赖解析全面失效——client 注入 `modules` 服务 + 插件自有全局共享给 chunk 副本（终端 / 编辑器 / Mermaid 恢复正常按需加载）
- 🧩 **chunk 重验证屏障健壮性**（[#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)）：HEAD 重验证加 5s 超时兜底（路由挂起时 fail-open 重取，屏障不再可能无限期阻塞懒加载）；`resetChunks` 清挂起的重验证屏障
- 🖱️ **拖拽健壮性**（[#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)）：快速释放（浏览器合并 / 丢失 pointermove 突发）时提交最后已知拖动位置而非回退；`pointercancel` / 捕获丢失中断同样保留拖动结果；提交后立即重测中心列（消除底栏宽度中间帧抖动）；HMR 重激活后中心列重定位兜底（`<html>` 样式观察 + 底栏打开重测），修复热更新后底栏空白 / 输入框位移

### v0.13.1

**✨ 新功能**

- 📊 **Markdown 预览安全渲染 Mermaid 图表**（[#164](https://github.com/omdsh-dev/DSH-better-sidebar/pull/164)）：预览的 md 含 mermaid fence 时按需下发 `client-mermaid.js` chunk（~7MB，无 mermaid 文件零加载）；纵深防御渲染——`securityLevel: 'strict'` + `htmlLabels: false`（节点文字走真实 SVG `<text>`）+ SVG 注入前二次清洗（删 `foreignObject`/`script`/外来 HTML 元素、剥 `@*`/`on*`/`href` 属性）；点击图表在弹窗中放大（滚轮以鼠标为中心缩放、拖拽平移、工具栏与快捷键），深浅色跟随重渲、解析失败回退原码
- 🖥️ **终端 shell 与 shellArgs 可配置**（[#125](https://github.com/omdsh-dev/DSH-better-sidebar/pull/125)）：`cordis.patch.yml` 的 `better-sidebar.config` 可指定 `shell` / `shellArgs`（`shellArgs` 非空时完全替换默认参数；未配置维持自动解析 `$SHELL` / 登录 shell / `powershell.exe` 原行为），UI 终端与 agent 终端（`terminal_create`）同时生效；终端 tab 标题改用 shell 名（bash / zsh / powershell），内部标识改 UUID，同 shell 可开多个终端

**🐛 修复**

- 🔗 **聚合双挂载自动退让**（[#200](https://github.com/omdsh-dev/DSH-better-sidebar/pull/200)）：聚合包（如 dsh-web-ui-all）以独立条目 id 挂载同包时，`cordis.patch.yml` 的守卫表达式自动禁用自身 `better-sidebar` 行，不再重复注册 `/sidebar/api` 导致 `duplicate prefix route` 整个插件树启动失败（`dsh web` 崩溃）；独立安装行为不变
- 🔧 **适配 DSH 0.1.0-rc.7**（[#207](https://github.com/omdsh-dev/DSH-better-sidebar/pull/207)，修复 [#206](https://github.com/omdsh-dev/DSH-better-sidebar/issues/206)）：修复 DSH 主框架升至 rc.7 后选模型 / 发消息报 `agent-presets: refusing to compose an unscoped context` 的问题

### v0.13.0

**✨ 新功能**

- 📁 **文件窗口与资源管理器二合一**（[#151](https://github.com/omdsh-dev/DSH-better-sidebar/pull/151)）：新 `editorExplorer` 设置（编辑器卡齿轮）——文件 tab 增加路径输入框头部 + 可开关的右侧停靠文件树（每 tab 记忆展开/宽度，左缘拖拽调宽 160~480px，全局文件名搜索走 host `fs.search` 路由，预算封顶并跳过 `.git` / 符号链接目录）；独立模式（默认）树点击 / 输入框 Enter **按路径新开**文件 tab，合并模式**原地切换**当前 tab；新会话默认 seed 空文件窗口（`Files`）替代 explorer tab，无路径窗口在独立模式为纯资源管理器、合并模式为带 chrome 的空文件窗口；树右键提供「在新 Tab 中打开」「在侧边打开」（split）
- 🎛️ **声明式设置 select 行**（[#151](https://github.com/omdsh-dev/DSH-better-sidebar/pull/151)）：设置项新增 `type: 'select'`（`options` 支持 value/title/desc/icon，`multi` 多选存数组）；带图标的选项渲染大图标选项卡、收起态同样显示图标；`editorExplorer` 改为图标化下拉（合并 / 独立）；能力清单新增 `settingSelect`
- 🔀 **与 dsh-web-ui 家族右侧面板互斥**（[#181](https://github.com/omdsh-dev/DSH-better-sidebar/pull/181)）：读取 `aionui-panel` 设置命名空间的提供方选择——当选择「使用 aionui-panel」时，整个 better-sidebar（右侧栏 / 底部面板 / 浮动入口 / 各类接管）不再挂载；选择 DSH-better-sidebar（或未安装 aionui）时正常。设置页保存后实时生效（settings-document 推送），无需刷新

### v0.12.3

**✨ 新功能**

- 🎨 **皮肤兼容（令牌驱动）**：全面消费 DSH 设计令牌，与 dsh-web-ui 皮肤中心 10 款皮肤兼容，换肤自动跟随；终端/编辑器表面在透明/半透明玻璃值下回退不透明底色，文字不叠在皮肤背景上（[#110](https://github.com/omdsh-dev/DSH-better-sidebar/pull/110)，修复 #106 #105 #90 #60，附带 #52 #57 #92）
- 🗂️ **统一路径处理**：UNC 路径 / 软链接分类（目录软链接可展开、失效链接标红）、HTML 路由平台守卫（[#134](https://github.com/omdsh-dev/DSH-better-sidebar/pull/134)，#65 #67 #43 #79 #115）
- 🖥️ **终端 shell 可配置**：设置项自定义 shell，Windows 自动探测 pwsh（[#95](https://github.com/omdsh-dev/DSH-better-sidebar/pull/95)）
- 📝 **编辑器新增语言**：C# / Kotlin / Swift 语法高亮（[#120](https://github.com/omdsh-dev/DSH-better-sidebar/pull/120)）
- 🧭 **设置页导航图标**：设置页导航图标与布局优化（[#114](https://github.com/omdsh-dev/DSH-better-sidebar/pull/114)）
- ➕ **推荐插件目录新增**：`dsh-git-remotes`——Git 远程 Tab（分支/上游/ahead-behind、fetch 可 prune、ff-only pull、确认后才 push，不替换内置暂存/提交）（[#91](https://github.com/omdsh-dev/DSH-better-sidebar/pull/91)）；`dsh-video-preview`——视频内联预览（.mp4/.webm/.mov/.mkv/.avi 等，自带 /video 宿主路由支持 HTTP Range 206 拖进度条，不受 20MB mediaLimit 限制）（[#126](https://github.com/omdsh-dev/DSH-better-sidebar/pull/126)）

**🐛 修复**

- 🔧 **xterm 依赖迁移**：弃用的 xterm 迁移至 `@xterm/xterm`（Closes [#122](https://github.com/omdsh-dev/DSH-better-sidebar/issues/122)，[#128](https://github.com/omdsh-dev/DSH-better-sidebar/pull/128)）
- 📝 **Markdown 编辑器**：选区转对话弹窗恢复可用（[#24](https://github.com/omdsh-dev/DSH-better-sidebar/pull/24)）
- 🖼️ **Markdown 预览支持本地/相对路径图片**：预览 `.md` 时把指向本地文件的图片目标（相对/绝对路径、引用式 `[id]: url`）重写为 `/sidebar/file` 媒体 URL 并显示（此前仅绝对 http(s) 图片能渲染，相对路径只显示 alt 文本）
- 🐛 **node-pty 加载失败不再拖垮 server**（[#140](https://github.com/omdsh-dev/DSH-better-sidebar/issues/140)）：宿主半改为懒加载 node-pty，缺失时插件照常挂载，终端以修复提示横幅（可复制命令 + 重试按钮）呈现，agent 终端工具自动跳过
- 🧪 测试工程：单元测试拆分（#141）+ smoke 偶发失败修复

</details>
