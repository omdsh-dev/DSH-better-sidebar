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

本地：`pnpm build && pnpm pack && pnpm exec playwright install chromium && pnpm test:mount`。CI 钉 `@deepseek-ai/dsh@0.1.1-rc.2`（peer 下限 `^0.1.0-rc.8`，双向兼容）。e2e spec 命名 `*.e2e.ts` + vitest `exclude` 双保险；**改 `exclude` 必须保留默认排除项**（exclude 整体替换默认值）。

---

## 3. DSH 0.1.2-alpha.1 适配要点（双协议 e2e）

tag `dsh-v0.1.2-alpha.1`，**尚未发布 npm**（CI 钉版暂不动）。破坏性变更：

1. **一次性 token 鉴权**：就绪行变为 `dsh web: http://127.0.0.1:<port>/?token=<43字符>`（导航换签名 cookie，干净 URL 401）。`e2e-mount.sh` 的 URL grep 必须延伸到空白（`[^ ]*`，在 `/` 截断丢 token）；e2e 统一走 `tests/e2e/host.ts`：`PAGE_URL`/`pageUrl({...})` goto（合并 query 与 token），`createHostApi()` 先 token 换 `Set-Cookie`（`redirect: 'manual'`）。token 换 cookie 的 303 会**丢弃同 URL 其它 query 参数**——带 stamps 导航走 `host.ts` 的 `gotoPage()`（先 addCookies 再直达）。插件 `/sidebar/*` 路由不受影响，同源 fetch 照旧。
2. **Remote gateway 取代 ApiProxy**：点分 `POST /api/workspace.create`（裸参数）→ 斜杠 `POST /api/workspace/create`，payload 恰为 `{args: {...}}`，**args 按控制器 TS 参数名包装**（`workspace/create`、`session/create` → `{args:{request:{...}}}`；`session/list` 参数名 `_request` **不可省略**——`{}` 也被拒 `args fields do not match the descriptor`）；envelope `method` 与路径一致，点分 404。`hostRpc(api, 'workspace.create', args)` 点分优先、404 回退斜杠并缓存；`SLASH_ARGS_KEY` 由 `tests/e2e-host-protocol.spec.ts` 锁定。
3. **`@deepseek-ai/dsh-client-runtime` 已移除**（继任 seed 是裸名 `@deepseek-ai/dsh-client-store`，无 `/client` 子路径）。插件源码零引用（externals 白名单解析失败被 `buildExternalsRequire` 宽容跳过，见 `src/client/chunk-loader.ts` 头注释），已从 peerDependencies 移除；`dsh.client.inject` 保留该条目无害。
4. **`MarkdownText` labels 契约（真机验证的破坏）**：labels prop 从扁平可选 `codeLabels` 改为**必填嵌套** `labels: { code: { copyLabel, copiedLabel }, footnotes }`——只传旧 prop 时 fence 渲染抛 `Cannot read properties of undefined (reading 'code')`。四个渲染点（mermaid.tsx / MarkdownHtml.tsx / TextEditor.tsx / SideChatView.tsx）统一走 `src/client/markdown-labels.tsx` 的 `markdownTextProps()`（双形状 + 双 prop 名两版通吃；漏传回退硬编码中文）。

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
- **i18n**：词典在 `betterSidebar` 命名空间，跟随 DSH `ctx.locale`；**新增 zh key 必须同步 `src/client/locales-ja.ts` 的 ja 翻译**（否则 ja 下回退 en）。渲染 `MarkdownText` 必须经 `markdownTextProps()`（§3 第 4 条）。
- **皮肤契约**：视觉值只消费 `--dsw-alias-*` / `--dsw-font-*` / `--ds-*` 令牌，无硬编码颜色；契约全文与 titleBar 四方案模型见[指南 §12](docs/external-plugin-guide.md)，改动必须同步该节与 `tests/theme.spec.ts`。
- **契约反向引用**：皮肤契约被 `src/client/shell-presets.ts`、`tests/e2e/mount.e2e.ts` 的注释以「指南 §12」引用——调整指南章节结构时同步检查这两处。
- **接入 API 即文档**：`src/client/service.ts` 与 `src/client/builtins/` 的任何行为变更，必须同步 [docs/external-plugin-guide.md](docs/external-plugin-guide.md)（唯一权威接入文档，不再双份维护）。

---

## 6. 文档与测试地图

- **接入 API 全参考**：[docs/external-plugin-guide.md](docs/external-plugin-guide.md)（消费插件开发者向；§4 Tab API / §5 FileViewer API / §7 服务方法 / §10 平台陷阱 / §11 自由窗口 / §12 皮肤契约 / §15 真实案例）。
- **设计文档**：[docs/plans/](docs/plans/)（30+ 份逐特性设计，含实施偏差记录）。
- **关键测试守护**：`tests/service.spec.ts` / `builtins.spec.ts`（注册表与内置清单：7 tab + 6 viewer）/ `market-manifest.spec.ts`（市场约束）/ `e2e-host-protocol.spec.ts`（RPC 双协议）/ `free-window.spec.tsx`（自由窗口）/ `theme.spec.ts`（皮肤契约）/ `plugin-list.spec.ts`（推荐插件目录）/ `fs-search.spec.ts`（host 文件名搜索）。
