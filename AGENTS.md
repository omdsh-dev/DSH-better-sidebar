# dsh-better-sidebar 仓库规则（AGENTS）

> 本文只含**项目全局开发规则**（面向贡献者与 agent）。
> 消费插件接入 API 全参考（`ctx.betterSidebar` 服务、TabDescriptor / FileViewerDescriptor 全字段、声明式设置、原生右侧栏承载面、皮肤契约等）→ [docs/external-plugin-guide.md](docs/external-plugin-guide.md)；逐特性设计史（含实施偏差记录）→ [docs/plans/](docs/plans/)。

---

## 1. 仓库硬约束（必须遵守）

- **禁止修改 DSH 源码**：对官方 checkout（`~/.dsh/source/current`）零写入。
- **代码改动必须走 PR**：非文档改动在 `feat/*` / `fix/*` 分支开发，`gh pr create` 发起，review 合并后进 main；**仅纯文档改动**（README / AGENTS.md / docs/）允许直推 main。
- **挂载只走 `cordis.patch.yml` + profile 机制**（`~/.dsh/profiles/<profile>/`），插件作为独立包被 profile 引用，不反向侵入 DSH。
- **市场受管安装约束**：`dependencies` / `peerDependencies` / `optionalDependencies` **一律不得出现 `cordis`**（按名硬拒，optional 无效），`scripts` 不得含 `preinstall` / `install` / `postinstall` / `prepare`。由 `tests/market-manifest.spec.ts` 守护。
- 缺能力时用 DSH 现成只读/公开 API 或插件自有路由（如 `jobs.output` 事件回放：读会话事件日志而非动注册表）；做不到先向用户说明取舍，不改 DSH。

---

## 2. CI 挂载冒烟（`plugin-mount` job / `pnpm test:mount`）

「npm 打包 → 真实挂载 → 无头渲染」门禁（证明打包产物在真实 DSH 挂载后不 crash）：`pnpm build && pnpm pack` 产 tarball → `scripts/e2e-mount.sh` 装进全新 scratch profile（`dsh plugin --profile web add <tarball>`）并启动真实 `dsh web`（keyless，`--port 0`）→ `tests/e2e/mount.e2e.ts`（Playwright）断言 `[data-dsh-better-sidebar]` 挂载、无错误条/pageerror/console 错误，展开 DSH 原生右侧栏后经其 guide 页逐个打开插件 tab 类型（含终端懒加载 chunk），再经插件文件树（原生 `files` kind 接管）打开 seed 文件强制加载 editor chunk（`client-editor.js`），并跑 mermaid / README 预览与 sidechat 宿主路由烟测。

本地：`pnpm build && pnpm pack && pnpm exec playwright install chromium && pnpm test:mount`。CI 钉 `@deepseek-ai/dsh@0.1.5-alpha.2`（`alpha` dist-tag；peer 下限 `^0.1.5-alpha.2`）。e2e spec 命名 `*.e2e.ts` + vitest `exclude` 双保险；**改 `exclude` 必须保留默认排除项**（exclude 整体替换默认值）。

---

## 3. DSH 0.1.5 适配要点（0.1.5-alpha.2+ 基线）

**v0.19.0-alpha.1 起仅支持 DSH 0.1.5-alpha.2+**（peer 下限 `^0.1.5-alpha.2`，CI 钉 `@deepseek-ai/dsh@0.1.5-alpha.2`，DSH alpha 线发在 `alpha` dist-tag）。alpha.1 用户停留在 v0.19.0-alpha.0——alpha.2 删除了指南条目的 `description` 字段并改了文件地址语法，插件不再对 alpha.1 做运行时兼容。0.1.2-rc.1 稳定线用户继续用 v0.18.x（npm `latest`）——0.1.5 的会话事件模型与文件打开漏斗都变了，插件不再对 0.1.2 做运行时兼容。发版：release.yml 按版本号是否含 `-` 自动选 `alpha`/`latest` dist-tag。

宿主契约（均经真机挂载冒烟 14/14 验证）：

1. **一次性 token 鉴权**：就绪行 `dsh web: http://127.0.0.1:<port>/?token=<43字符>`（导航换签名 cookie，干净 URL 401）。`e2e-mount.sh` 的 URL grep 必须延伸到空白（`[^ ]*`，在 `/` 截断丢 token）；e2e 统一走 `tests/e2e/host.ts`（token 必选：`parseLaunchUrl` 对裸 origin 直接抛错），带 stamps 导航走 `gotoPage()`（先 addCookies 再直达——token 换 cookie 的 303 会丢弃同 URL 其它 query 参数）。插件 `/sidebar/*` 路由不受影响，同源 fetch 照旧。
2. **Remote gateway 斜杠 RPC（唯一方言）**：`POST /api/workspace/create`，payload 恰为 `{args: {...}}`，**args 按控制器 TS 参数名包装**（`workspace/create`、`session/create` → `{args:{request:{...}}}`；`session/list` 参数名 `_request` **不可省略**——`{}` 也被拒 `args fields do not match the descriptor`）；envelope `method` 与路径一致，点分路径 404。请求由 `tests/e2e/host-protocol.ts` 的 `rpcAttempt` 构造、`tests/e2e-host-protocol.spec.ts` 锁定；要调新方法先在真机验参数名再进 `RPC_ARGS_KEY`。
3. **`MarkdownText` labels 嵌套契约**：必填 `labels: { code: { copyLabel, copiedLabel }, footnotes }`（漏传回退硬编码中文）。四个渲染点（mermaid.tsx / MarkdownHtml.tsx / TextEditor.tsx / SideChatView.tsx）统一走 `src/client/markdown-labels.tsx` 的 `markdownTextProps()`。
4. **侧边对话转录走自有路由，不碰客户端宿主 RPC**：`ctx.connection.api`（含 `sessions.history`）在 alpha.1 整体移除，继任 `session/follow|page` 又对 `origin:'subagent'` 会话强制 subagent 地址（普通 `{kind:'session'}` 被 `agent-busy` 拒）且分页 `throughSeq` 不得超当前游标。转录因此由 **`sidechat.events`** 插件路由供给（`src/sidechat-routes.ts`：live 读 `agent.session.snapshotEvents()`、冷读 `sessionPersistence.inspect`，服务端 `session/end-seed` 切割 + `afterSeq` 增量）；`ctx.connection` 镜像与 inject 已删。**0.1.5 起实时增量不在日志里**：`assistant/chunk` 事件被删除，进行中的模型增量改由 `agent/assistant-stream` 瞬时帧发布（`start` / `chunk` / `end`，不入会话日志），结算时才落 `assistant/message`（内嵌 `stream`）或 `assistant/attempt`（失败尝试，内嵌 `stream`）。插件在宿主侧 `src/assistant-live.ts` 折叠这些帧成有界缓冲，`sidechat.events` 的 `live` 字段按「当前 attempt 全量、每次轮询替换」下发（不是增量），转录映射与继承快照都读它。设计见 [docs/plans/2026-08-20-sidechat-tab-design.md](docs/plans/2026-08-20-sidechat-tab-design.md) §10。
5. **`dsh-settings` 无运行时 `settingsNamespace`**：命名空间合法性校验转为编译期模板字面量 `SettingsNamespaceInput`（小写字母开头 + `[a-z0-9-]` 尾部），`'dsh-better-sidebar'` 字面量直接过——宿主侧直接传常量（`src/index.ts` 的 settings inject）。
6. **`dsh-subagent` 的 `SUBAGENT_DESCRIPTOR_VERSION` 2 → 3**：sidechat 种子的 `subagent/descriptor` 版本由宿主包盖章，插件不硬编码；测试断言跟随常量（`tests/sidechat-routes.spec.ts`），勿钉字面量。
7. **`@deepseek-ai/dsh-client-runtime` 包已消亡**（继任 seed 是裸名 `dsh-client-store`，无 `/client` 子路径）：peerDependencies、devDependencies、`dsh.client.inject`、chunk externals 白名单（`src/client/chunk-loader.ts` / `tsdown.config.ts` / `tests/chunk-loader.spec.ts` / `tests/manifest-consistency.spec.ts` 四处同步）均已无该条目。
8. **e2e scratch profile 的 `minimumReleaseAgeExclude` 含 `'@deepseek-ai/*'`**（`scripts/e2e-mount.sh` / `e2e-aggregate-mount.sh`，与仓库根 `pnpm-workspace.yaml` 同策）：alpha 版本常在发布后 24h 内跑 lane，pnpm 11 的 `minimumReleaseAge` 默认会拒装新鲜包。
9. **插件开发树的 dsh-* 传递 peer 需提升为 devDependencies**（alpha.3 首见）：`dsh-subagent` 等 npm 包把 `dsh-attachment` 等 dsh-* 姊妹包全部声明为 peerDependencies（由宿主 bundle 树统一提供，宿主侧无此问题），插件仓库若只直接依赖其中一部分，其余 peer 在 pnpm 下会解析到树上残留的旧版——如 `dsh-attachment@0.1.1-rc.1` 缺 `admitPromptContent` 导出、`dsh-subagent` 产物 import 它时测试加载即崩。因此 devDependencies 需涵盖 dev 树实际触达的全部 peer（attachment / code-runtime / scope / session-projection / system-prompt / user-approval / util-time 七个即为此提升，与直接依赖同款精确钉版）；`@deepseek-ai/cordis` peer 自 alpha.3 起要求 `^4.0.2`（上游全线 peer 已升）。适配新 alpha 版本时先跑 `pnpm peers check`，把新失配的传递 peer 一并提升进 devDependencies。例外：**`dsh-client-locale` 的 peer/devDep 允许落后于基线**（alpha.5 时上游停在 0.1.2-alpha.3 未发新版）——peer 下限 `^0.1.2-alpha.3` 天然容纳同 tuple 的 alpha.5 运行时，此时保持旧钉版并在 `pnpm-workspace.yaml` 注明，待上游发版再追平；rc.1 起上游恢复发版，peer/devDep 已与基线一并钉 `0.1.2-rc.1`，该例外消除。**alpha.2 起还有一类：上游包自身的 `dependencies` 丢失**——`@deepseek-ai/dsh-client-ui-primitives@0.1.5-alpha.2` 的 manifest 不再声明任何 `dependencies`（alpha.1 声明了 19 个），但 `lib/*.js` 仍裸 import `anser` / `shiki` / `@shikijs/langs/*` / `mdast-util-*` / `micromark-*` / `katex`。宿主由预构建前端 bundle 满足，独立安装的 dev/test 树不会——vitest 一碰 primitives 就 `Cannot find package 'anser'`。此时把 alpha.1 声明的同一组版本提升进 devDependencies（`clsx` 已在 dependencies 无需重复）。
10. **右侧栏是 DSH 原生栏，插件只提供 tab 类型**：聊天里一切文件打开（工具行 / 产物行 / 正文提及 / 行内代码路径）统一走 `ctx.sidebarRight.openResource(fileAddressFor(sessionId, cwd, path))`（`packages/client/ui-chat/src/client/apply.ts` 是唯一调用点），`remote.session.openWorkspacePath` 在 0.1.5 客户端已无调用者，插件的 openpath 拦截随之删除。插件的每个 `TabDescriptor` 注册成原生 tab 类型（`kind = descriptor.id`，`extension` 带）+ 原生 tab 体（`sidebar.right.pane.tab` keyed 槽，key = `dsh-better-sidebar:<id>`）；`editor` 类型同时认领 `dsh-resource://file/**`（压过内置 `text` 的 `fallback`），并接管内置 `files` 页面 kind（`openTab('files')` 打开插件文件树，注销即复位）。`ctx.sidebarRight.openTab/openResource/close` 只对**在屏会话**写入；跨会话用具体类上的 `openTabIn/openResourceIn/closeIn`（不在 `ISidebarRight` 接口里，需结构化探测），目标会话未挂载时排队到上屏重放（`src/client/native/surface.ts`）。原生 tab 的插件侧状态（合成 `SidebarTab`、树展开集合、实例编号）在 `src/client/native/tab-adapter.tsx`；原生布局只在内存，不做持久化。**注册必须等服务、不能等槽声明**：原生栏先声明 `sidebar.right.pane.tab` 再 `provide('sidebarRightTabs')`，真机 profile（web，0.1.5-alpha.1）上槽声明回调里 `ctx.get('sidebarRightTabs')` 仍是 undefined（实测 3 秒后才出现），按槽触发注册会静默什么都不注册且永不重试——用 `ctx.inject(['sidebarRightTabs'], cb)` 驱动类型注册（`tests/native-surface.spec.ts` 以「槽先触发、服务后到达」的顺序守护），槽声明只用来挂 tab 体。指南 §0 列了全部行为差异。**alpha.2 起（v0.19.0-alpha.1）**：指南条目删除 `description`（原生指南渲染成「图标+标题」胶囊），插件随之下线 `TabDescriptor.description` 与 6 个 `guideDesc*` 词条；新建标签页的默认页改为从注册表选（恰好 1 个指南条目 → 直接开它，0 或 ≥2 → 开指南），`revealIfOpened` 对「页面」在同一 pane 内强制去重。原生 tab 体宿主 `.paneBody` 是**有确定高度的块级滚动容器**（非 flex 容器），native 适配层因此给每个 tab 体包一层 `height:100%` 的列 flex 宿主（`sidebar.module.css` 的 `.nativeTabHost`），tab 组件根继续用 `flex:1`/`height:100%`——否则根盒塌成内容高度，sidechat 的输入框就贴不到面板底。全局面板（根级 `main` keyed 槽 + `sidebar.panellist` + `ctx.layout.selectPanel/beginNavigation`、`rightbar` 改根级并新增 `rightbar.session`）插件**不接入**，只做兼容。底部工作台的中心列锚点改认 `[data-slot="main.conversation"]`（并跳过 `display: contents` 祖先，同时保留 alpha.1 的 `[data-slot="conversation"]`）；文件地址语法跟随 alpha.2（`fileAddressFor` 一律 session 作用域、绝对路径保留前导 `/`、`parseFileAddress` 前缀解析并去 `?`/`#`）。
11. **自定义种子必须带 fork 标记对（`meta.isSeeded: true` + `inheritedEventCount`）**：dsh-session 契约「只给 seed 不标 isSeeded，种子算重放历史而非继承前缀」——缺标记时 `Session.ownEvents()` 含整个种子，子会话的 inbox 折（`inboxProjectionDefinition`，0.1.5 起 `@deepseek-ai/dsh-agent` 只导出 `Inbox` 接口，实现是该投影）重放种子里的 `agent/inbox/spliced`，**继承父会话切割时刻未领取的 inbox 输入**（排队用户消息 next-turn、长回合中工具结果上下文/steering next-step——后者即「上下文很长时侧边对话先把之前的 User msg 发出去」的根因，幽灵消息排在 boundary 之前最先发给模型）。宿主 `session.fork`（api-session-controller）的调用即规范形态；回归由 `tests/sidechat-seed-validation.spec.ts`（真实 `Session.create` + 对 `ownEvents()` 跑 inbox 折）守护。0.1.5 复评：无更优雅的 sidechat 宿主 API（`ContinuableStartSpec` 仍无 seed 字段），`AgentRegistry.create` 接缝补齐标记即为规范用法；`Session.create` 的 header `version` 必须用 `SESSION_FORMAT_VERSION`（0.1.5 是 `3` 字面量类型），勿钉 `0`。

---

## 4. npm 发版（GitHub Release → npm publish）

`.github/workflows/release.yml` 在 GitHub Release（tag `vX.Y.Z`）发布时自动发 npm：

1. **前置**：`package.json` 版本 bump 到 `X.Y.Z`，CI 全绿后打 tag；tag 与版本不匹配直接失败。
2. **流程**：`pnpm build` / `typecheck` / `test` → 校验 tag → `pnpm publish --provenance --access public`。
3. **认证**：npm **Trusted Publishing（OIDC）**，不配 `NPM_TOKEN`。一次性配置（npmjs.com package → Settings → Trusted Publishers）：Provider `GitHub Actions`、Org `omdsh-dev`、Repo `DSH-better-sidebar`、Workflow filename `release.yml`、Environment 留空。
4. **调试**：`workflow_dispatch` + `dry_run=true` 只打包不发版。

---

## 5. 开发规则速查

- **构建纯度门**：client bundle 禁止 value-import `@dsh-external/*` 或非白名单 `@deepseek-ai/*`（`tsdown.config.ts` 拦截）；`import type {}` 被擦除不触发——类型可共享，运行时符号不行；跨插件交互走 `ctx.betterSidebar` 方法调用。
- **懒加载 chunk**：重依赖（xterm/CodeMirror/mermaid）在独立 bundle（`lib/client-<name>.js`），经 `/sidebar/bundle` 按需下发、`globalThis.__dshChunks__` 物化（`src/client/chunk-loader.ts`），**核心 bundle 禁止静态 import `src/client/chunks/*`**。
- **i18n**：词典在 `betterSidebar` 命名空间，跟随 DSH `ctx.locale`；**新增 zh key 必须同步 `src/client/locales-ja.ts` 的 ja 翻译**（否则 ja 下回退 en）。渲染 `MarkdownText` 必须经 `markdownTextProps()`（§3 第 3 条）。
- **皮肤契约**：视觉值只消费 `--dsw-alias-*` / `--dsw-font-*` / `--ds-*` 令牌，无硬编码颜色；契约全文与 titleBar 四方案模型见[指南 §12](docs/external-plugin-guide.md)，改动必须同步该节与 `tests/theme.spec.ts`。
- **契约反向引用**：皮肤契约被 `src/client/shell-presets.ts`、`tests/e2e/mount.e2e.ts` 的注释以「指南 §12」引用——调整指南章节结构时同步检查这两处。
- **接入 API 即文档**：`src/client/service.ts` 与 `src/client/builtins/` 的任何行为变更，必须同步 [docs/external-plugin-guide.md](docs/external-plugin-guide.md)（唯一权威接入文档，不再双份维护）。

---

## 6. 文档与测试地图

- **接入 API 全参考**：[docs/external-plugin-guide.md](docs/external-plugin-guide.md)（消费插件开发者向；§0 原生栏承载面 / §4 Tab API / §5 FileViewer API / §7 服务方法 / §10 平台陷阱 / §11 已移除的自由窗口 / §12 皮肤契约 / §15 真实案例）。
- **设计文档**：[docs/plans/](docs/plans/)（30+ 份逐特性设计，含实施偏差记录）。
- **关键测试守护**：`tests/service.spec.ts` / `builtins.spec.ts`（注册表与内置清单：7 tab + 6 viewer）/ `market-manifest.spec.ts`（市场约束）/ `e2e-host-protocol.spec.ts`（RPC 双协议）/ `native-surface.spec.ts`（原生右侧栏承载面）/ `theme.spec.ts`（皮肤契约）/ `plugin-list.spec.ts`（推荐插件目录）/ `fs-search.spec.ts`（host 文件名搜索）。
