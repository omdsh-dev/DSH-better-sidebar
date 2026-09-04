# dsh-better-sidebar 仓库规则（AGENTS）

> 本文只含**项目全局开发规则**（面向贡献者与 agent）。
> 消费插件接入 API 全参考（`ctx.betterSidebar` 服务、TabDescriptor / FileViewerDescriptor 全字段、声明式设置、自由窗口、皮肤契约等）→ [docs/external-plugin-guide.md](docs/external-plugin-guide.md)；逐特性设计史（含实施偏差记录）→ [docs/plans/](docs/plans/)。

---

## 1. 仓库硬约束（必须遵守）

- **禁止修改 DSH 源码**：对官方 checkout（`~/.dsh/source/current`）零写入。
- **代码改动必须走 PR**：非文档改动在 `feat/*` / `fix/*` 分支开发，`gh pr create` 发起，review 合并后进 main；**仅纯文档改动**（README / AGENTS.md / docs/）允许直推 main。
- **挂载只走 `cordis.patch.yml` + profile 机制**（`~/.dsh/profiles/<profile>/`），插件作为独立包被 profile 引用，不反向侵入 DSH。
- **市场受管安装约束**：`dependencies` / `peerDependencies` / `optionalDependencies` **一律不得出现 `cordis`**（按名硬拒，optional 无效），`scripts` 不得含 `preinstall` / `install` / `postinstall` / `prepare`。由 `tests/market-manifest.spec.ts` 守护。
- 缺能力时用 DSH 现成只读/公开 API 或插件自有路由（如 `jobs.output` 事件回放：读会话事件日志而非动注册表）；做不到先向用户说明取舍，不改 DSH。

---

## 2. CI 挂载冒烟（`plugin-mount` job / `pnpm test:mount`）

「npm 打包 → 真实挂载 → 无头渲染」门禁（证明打包产物在真实 DSH 挂载后不 crash）：`pnpm build && pnpm pack` 产 tarball → `scripts/e2e-mount.sh` 装进全新 scratch profile（`dsh plugin --profile web add file:<tarball>`）并启动真实 `dsh web`（keyless，`--port 0`）→ `tests/e2e/mount.e2e.ts`（Playwright）断言 `[data-dsh-better-sidebar]` 挂载、无错误条/pageerror/console 错误，经「+ 菜单」逐个打开内置 tab（含终端懒加载 chunk），再经文件树打开 seed 文件强制加载 editor chunk（`client-editor.js`）。

本地：`pnpm build && pnpm pack && pnpm exec playwright install chromium && pnpm test:mount`。CI 钉 `@deepseek-ai/dsh@0.1.2-rc.1`（`next` dist-tag；peer 下限 `^0.1.2-rc.1`）。e2e spec 命名 `*.e2e.ts` + vitest `exclude` 双保险；**改 `exclude` 必须保留默认排除项**（exclude 整体替换默认值）。

---

## 3. DSH 0.1.2 适配要点（0.1.2-rc.1+ 基线）

**v0.18.0 起插件毕业正式版（npm `latest`），仅支持 DSH 0.1.2-rc.1+**（peer 下限 `^0.1.2-rc.1`，CI 钉 `@deepseek-ai/dsh@0.1.2-rc.1`，DSH rc.x 发在 `next` dist-tag）。v0.18.0-alpha.0 进入 alpha 通道时已删除对 0.1.0-rc.8 ~ 0.1.1-rc.2 的兼容层——双方言 RPC（点分回退）、MarkdownText 双形状 labels、`dsh-client-runtime` externals/inject 残留行；stable DSH 用户请固定装 v0.17.1（npm 上的旧 latest，0.1.2-alpha.x 宿主继续用 npm `alpha` 的 v0.18.0-alpha.0）。发版：release.yml 按版本号是否含 `-` 自动选 `alpha`/`latest` dist-tag。

宿主契约（均经真机挂载冒烟 14/14 验证）：

1. **一次性 token 鉴权**：就绪行 `dsh web: http://127.0.0.1:<port>/?token=<43字符>`（导航换签名 cookie，干净 URL 401）。`e2e-mount.sh` 的 URL grep 必须延伸到空白（`[^ ]*`，在 `/` 截断丢 token）；e2e 统一走 `tests/e2e/host.ts`（token 必选：`parseLaunchUrl` 对裸 origin 直接抛错），带 stamps 导航走 `gotoPage()`（先 addCookies 再直达——token 换 cookie 的 303 会丢弃同 URL 其它 query 参数）。插件 `/sidebar/*` 路由不受影响，同源 fetch 照旧。
2. **Remote gateway 斜杠 RPC（唯一方言）**：`POST /api/workspace/create`，payload 恰为 `{args: {...}}`，**args 按控制器 TS 参数名包装**（`workspace/create`、`session/create` → `{args:{request:{...}}}`；`session/list` 参数名 `_request` **不可省略**——`{}` 也被拒 `args fields do not match the descriptor`）；envelope `method` 与路径一致，点分路径 404。请求由 `tests/e2e/host-protocol.ts` 的 `rpcAttempt` 构造、`tests/e2e-host-protocol.spec.ts` 锁定；要调新方法先在真机验参数名再进 `RPC_ARGS_KEY`。
3. **`MarkdownText` labels 嵌套契约**：必填 `labels: { code: { copyLabel, copiedLabel }, footnotes }`（漏传回退硬编码中文）。四个渲染点（mermaid.tsx / MarkdownHtml.tsx / TextEditor.tsx / SideChatView.tsx）统一走 `src/client/markdown-labels.tsx` 的 `markdownTextProps()`。
4. **侧边对话转录走自有路由，不碰客户端宿主 RPC**：`ctx.connection.api`（含 `sessions.history`）在 alpha.1 整体移除，继任 `session/follow|page` 又对 `origin:'subagent'` 会话强制 subagent 地址（普通 `{kind:'session'}` 被 `agent-busy` 拒）且分页 `throughSeq` 不得超当前游标。转录因此由 **`sidechat.events`** 插件路由供给（`src/sidechat-routes.ts`：live 读 `agent.session.snapshotEvents()`（0.1.2-alpha.4 起的按需读 API，前身 `Session.events` 属性已删）、冷读 `sessionPersistence.inspect`，服务端 `session/end-seed` 切割 + `afterSeq` 增量）；`ctx.connection` 镜像与 inject 已删。设计见 [docs/plans/2026-08-20-sidechat-tab-design.md](docs/plans/2026-08-20-sidechat-tab-design.md) §10。
5. **`dsh-settings` 无运行时 `settingsNamespace`**：命名空间合法性校验转为编译期模板字面量 `SettingsNamespaceInput`（小写字母开头 + `[a-z0-9-]` 尾部），`'dsh-better-sidebar'` 字面量直接过——宿主侧直接传常量（`src/index.ts` 的 settings inject）。
6. **`dsh-subagent` 的 `SUBAGENT_DESCRIPTOR_VERSION` 2 → 3**：sidechat 种子的 `subagent/descriptor` 版本由宿主包盖章，插件不硬编码；测试断言跟随常量（`tests/sidechat-routes.spec.ts`），勿钉字面量。
7. **`@deepseek-ai/dsh-client-runtime` 包已消亡**（继任 seed 是裸名 `dsh-client-store`，无 `/client` 子路径）：peerDependencies、devDependencies、`dsh.client.inject`、chunk externals 白名单（`src/client/chunk-loader.ts` / `tsdown.config.ts` / `tests/chunk-loader.spec.ts` / `tests/manifest-consistency.spec.ts` 四处同步）均已无该条目。
8. **e2e scratch profile 的 `minimumReleaseAgeExclude` 含 `'@deepseek-ai/*'`**（`scripts/e2e-mount.sh` / `e2e-aggregate-mount.sh`，与仓库根 `pnpm-workspace.yaml` 同策）：alpha 版本常在发布后 24h 内跑 lane，pnpm 11 的 `minimumReleaseAge` 默认会拒装新鲜包。
9. **插件开发树的 dsh-* 传递 peer 需提升为 devDependencies**（alpha.3 首见）：`dsh-subagent` 等 npm 包把 `dsh-attachment` 等 dsh-* 姊妹包全部声明为 peerDependencies（由宿主 bundle 树统一提供，宿主侧无此问题），插件仓库若只直接依赖其中一部分，其余 peer 在 pnpm 下会解析到树上残留的旧版——如 `dsh-attachment@0.1.1-rc.1` 缺 `admitPromptContent` 导出、`dsh-subagent` 产物 import 它时测试加载即崩。因此 devDependencies 需涵盖 dev 树实际触达的全部 peer（attachment / code-runtime / scope / session-projection / system-prompt / user-approval / util-time 七个即为此提升，与直接依赖同款精确钉版）；`@deepseek-ai/cordis` peer 自 alpha.3 起要求 `^4.0.2`（上游全线 peer 已升）。适配新 alpha 版本时先跑 `pnpm peers check`，把新失配的传递 peer 一并提升进 devDependencies。例外：**`dsh-client-locale` 的 peer/devDep 允许落后于基线**（alpha.5 时上游停在 0.1.2-alpha.3 未发新版）——peer 下限 `^0.1.2-alpha.3` 天然容纳同 tuple 的 alpha.5 运行时，此时保持旧钉版并在 `pnpm-workspace.yaml` 注明，待上游发版再追平；rc.1 起上游恢复发版，peer/devDep 已与基线一并钉 `0.1.2-rc.1`，该例外消除。
10. **聊天文件打开漏斗是 `remote.session.openWorkspacePath`**（`ctx.workspaces.openPath` 已随 alpha 删除，`IWorkspaces` 无此方法）：「聊天区文件在侧边栏打开」拦截在 `ctx.inject(['remote.session'], …)` 内以 **defineProperty 数据属性遮蔽**该命名空间方法（gateway client 的方法是 accessor 属性、异步挂载、contribution 重挂载时服务重建——inject 回调重跑即自愈）；实现见 `src/client/openpath-intercept.ts`，设计见 [docs/plans/2026-08-31-openpath-intercept-alpha-design.md](docs/plans/2026-08-31-openpath-intercept-alpha-design.md)。

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

- **接入 API 全参考**：[docs/external-plugin-guide.md](docs/external-plugin-guide.md)（消费插件开发者向；§4 Tab API / §5 FileViewer API / §7 服务方法 / §10 平台陷阱 / §11 自由窗口 / §12 皮肤契约 / §15 真实案例）。
- **设计文档**：[docs/plans/](docs/plans/)（30+ 份逐特性设计，含实施偏差记录）。
- **关键测试守护**：`tests/service.spec.ts` / `builtins.spec.ts`（注册表与内置清单：7 tab + 6 viewer）/ `market-manifest.spec.ts`（市场约束）/ `e2e-host-protocol.spec.ts`（RPC 双协议）/ `free-window.spec.tsx`（自由窗口）/ `theme.spec.ts`（皮肤契约）/ `plugin-list.spec.ts`（推荐插件目录）/ `fs-search.spec.ts`（host 文件名搜索）。
