# dsh-better-sidebar 仓库规则（AGENTS）

> 本文只含**每次都要遵守的规则**。深度参考不放在这里：接入 API → [docs/external-plugin-guide.md](docs/external-plugin-guide.md)；宿主契约（原 §3.4 第 1–12 条）与历史线沿用至今的约束 → [docs/host-contracts.md](docs/host-contracts.md)；逐特性设计史与历次 DSH 适配记录 → [docs/plans/](docs/plans/)；用户可见变更 → [CHANGELOG.md](CHANGELOG.md)。

---

## 0. 分支模型：`dev` 集成 / `main` 只收发版

- 功能与修复先进 `dev`：主题分支（`feat|fix|chore|docs|test/*`）从 `dev` 切出、合回 `dev`；`main` 只在发版时从 `dev` 合入。回填贡献者 PR 沿用对方分支名。
- **不要用 `dev/` 前缀命名分支**：本地已有 `refs/heads/dev`，`dev/x` 会撞 ref 冲突（`cannot lock ref`）。
- 发版：`dev` → `main` 后从 `main` 打 tag `vX.Y.Z`，[release.yml](.github/workflows/release.yml) 自动发 npm（版本号含 `-` → `alpha` dist-tag，否则 `latest`）。
- **仅纯文档改动**（README / AGENTS.md / docs/）允许不切分支直接提交（`main` 或 `dev` 均可）。
- CI 的 push 触发覆盖 `main` 与 `dev`；`pull_request` 与 base 无关，合进 `dev` 的每一批都有门禁。
- 并行开发用 `.worktrees/`（每槽独立 `node_modules`），**集成只在单一 worktree 串行做**。

---

## 1. 仓库硬约束

- **禁止修改 DSH 源码**（官方 checkout `~/.dsh/source/current` 零写入）。
- **非文档改动必须走分支并合入 `dev`**：外部贡献者走 `gh pr create` + review；维护者本地的批量整合可以直接 `git merge --no-ff` 进 `dev`，但每批都要跑门禁。
- **挂载只走 `cordis.patch.yml` + profile 机制**，插件作为独立包被 profile 引用，不反向侵入 DSH。
- **市场受管安装约束**：`dependencies` / `peerDependencies` / `optionalDependencies` 一律不得出现 `cordis`；`scripts` 不得含 `preinstall` / `install` / `postinstall` / `prepare`（`tests/market-manifest.spec.ts` 守护）。
- **缺能力时**用 DSH 现成只读/公开 API 或插件自有路由（后台任务已有宿主客户端 `ctx.jobs`，别再自建回放路由）；做不到先向用户说明取舍，不改 DSH。

---

## 2. CI 门禁：挂载冒烟（`plugin-mount` / `pnpm test:mount`）

`pnpm build && pnpm pack` → `scripts/e2e-mount.sh` 装进全新 scratch profile、起真实 `dsh web`（keyless，`--port 0`）→ Playwright 断言。它钉住的几条：插件挂载且无 pageerror / console 错误；原生右侧栏 guide 里**宿主自己的终端条目必须恰好 1 条**（多于 1 条 = 插件又在遮蔽宿主）；`browser` 条目**显式断言缺席**（web profile 不该有）；文件树经 `files` 接管能打开 seed 文件并加载 editor chunk；`native-reload.e2e.ts` 触发**页面内条目替换**，断言替换前后都无 `native register … error`（唯一能在部署层复现「id 被孤儿化」的用例，机制见 host-contracts 第 9 条）。同 lane 还有搜索引擎门禁（`pnpm check:engines`）。

本地：`pnpm build && pnpm pack && pnpm exec playwright install chromium && pnpm test:mount`。

- **钉版写精确版本号，绝不写 dist-tag**（`alpha` / `latest` / `next` 的指向与候选版经常不一致）；默认与 CI 同为 `@deepseek-ai/dsh@0.2.1-rc.1`。
- 该步骤需要 `NODE_OPTIONS=--max-old-space-size=4096`（浮动的传递依赖会组出混合 peer 图 → ERESOLVE 后 OOM）；**不要加 `--legacy-peer-deps`**（会跳掉 boot 必需的 peer，CLI 直接 `ERR_MODULE_NOT_FOUND`）。
- 本机 npm registry 是 npmmirror、对新预发布滞后：装不到时 `pnpm install --registry https://registry.npmjs.org`。
- Windows lane 跑 `pnpm test:windows`（`--maxWorkers=1`），`vitest.config.ts` 的 `testTimeout: 30_000` 与它配套。e2e spec 命名 `*.e2e.ts` + vitest `exclude` 双保险；**改 `exclude` 必须保留默认排除项**。

---

## 3. DSH 版本适配

- **当前基线 DSH 0.2.1-rc.1（v0.28.0 正式版起）**。13 条 `@deepseek-ai/dsh-*` peer 下限均为 `^0.2.1-rc.1` 浮动 caret 范围、**绝不钉精确版本**（只有 devDependencies 精确钉）；本包不声明 `package.json#engines.dsh`，因此走 peer 兼容性检查；宿主对声明了该字段的包优先且仅按它判定，不读 peer。`dsh.plugin.json#engines.dsh` 不参与这一规则。`tests/market-manifest.spec.ts` 钉住这条形状。
- **0.x caret 不跨 minor，但可跨 patch**：`^0.1.7-rc.1` 对 `0.2.0-rc.1` 判定为 false → 整行 `disabled`、插件静默不加载。**抬基线必须同批抬 peer 下限。**
- 支持线（用户侧）：DSH **0.2.1-rc.1+** 使用插件 **v0.28.0**；0.2.1-alpha.5 用户固定 **v0.28.0-alpha.0**；0.2.0-rc.2 用户固定 **v0.26.1**（v0.27.0 尚未发布）；0.2.0-rc.1 用户固定 v0.24.1；0.1.7 线的最后支持版是 **v0.22.1**（v0.23.0 从未发布到 npm）。按本仓库先例**不写运行时兼容层**。
- **抬基线动作清单**：① `pnpm peers check`，把失配的传递 peer 提升进 devDependencies；② 扫宿主包产物的**裸 import 差集**（`pnpm peers check` 看不到这类失败，0.1.7 线是 `zustand` / `immer`）；③ 对消费的宿主包做类型面 diff（重点 `ui-primitives` / `dsh-session` / `sidebar-right`），确认导出只增不减；④ 复查会话格式版本、`SUBAGENT_DESCRIPTOR_VERSION`、web profile 的 inject 列表；⑤ 同批同步 CI 钉版、`scripts/e2e-common.sh`、**`scripts/install.sh` / `scripts/install.ps1`（随包发布、会直接给用户 npx 命令）** 与 README / 指南的版本行。
- **用户 profile 自己的 `overrides: '@deepseek-ai/dsh-*'` 要同批抬**，否则旧包遮蔽 bundle → 预检禁用 `config-editor` → `settings` 行永久 `pending`；先看宿主日志的 `disabling profile plugin row` 与 `pending (waiting for service: …)`。
- **沿用 alpha.5 的删除契约**：不再依赖 `@deepseek-ai/dsh-invariants`、`ctx.invariants` 或上游 `/invariant` 子路径，也不发布本插件的 invariant companion；HTTP/WS 准入统一调用 `ctx.connection.requestRejection(req)`，仅 `undefined` 放行，不恢复 `webRuntime` / 自建信任例外。
- **v0.28.0 正式版接管 npm `latest`**：宿主 npm `latest` 此时仍指向 `0.2.0-rc.2`，不满足本插件 RC 基线；用户已明确接受这一分离，所有安装文档必须显著提醒旧宿主固定 `v0.26.1`，不要用浮动 `latest`。发布 workflow 沿用现有版本号规则，无需改动。
- **本次 RC 适配不改功能实现**：alpha.5 → rc.1 上游完整树差异共 355 项，全部为 `package.json`，源码零变化；同步版本、peer、伴随依赖与文档，重新获取 RC 验证证据，不沿用 alpha 测试数字。
- 动设置面 / sidechat / 原生 tab 之前，先读 [docs/host-contracts.md](docs/host-contracts.md)（原 §3.4 的 1–12 条按原编号都在那里）。

---

## 4. 发版

v0.28.0 正式版沿用现有发布规则进入 npm `latest`，无需修改 workflow；这不代表宿主的 `latest` 已升级到本插件所需 RC。

[release.yml](.github/workflows/release.yml) 在 GitHub Release（tag `vX.Y.Z`）触发：版本 bump → `build` / `typecheck` / `test` → 校验 tag 与版本一致 → `pnpm publish --provenance --access public`。认证走 npm **Trusted Publishing（OIDC）**，不配 `NPM_TOKEN`。调试用 `workflow_dispatch` + `dry_run=true` 只打包不发版。

---

## 5. 开发规则

- **构建纯度门**：client bundle 禁止 value-import `@dsh-external/*` 或非白名单 `@deepseek-ai/*`（`tsdown.config.ts` 拦截）；`import type {}` 被擦除不触发；跨插件交互走 `ctx.betterSidebar`。
- **懒加载 chunk**：重依赖在 `lib/client-<name>.js`（`editor` / `mermaid` / `locale` / `terminal`），经 `/sidebar/bundle` 按需下发；**核心 bundle 禁止静态 import `src/client/chunks/*`**。真源是 `CHUNK_NAMES`（`src/bundle-route.ts`），另有 5 处镜像必须同步：`tsdown.config.ts`、`src/client/chunk-loader.ts`、`package.json.files`、`scripts/package-registry.mjs`、`tests/{bundle-route,chunk-artifact}.spec.ts`。
- **i18n**：词典在 `betterSidebar` 命名空间；**新增 zh key 必须同步 `src/client/locales-ja.ts`**（否则 ja 下回退 en）。渲染 `MarkdownText` 必须经 `markdownTextProps()`。
- **保存语义**：`fs.write` 在写盘**前**按磁盘现状还原文件格式（`fileFormatOf` 一趟 64 KiB sniff 给出 `{encoding, eol}`，落盘 `encodeText(restoreEol(...))`）；**客户端只发送 LF**，行尾由服务端还原；新文件 UTF-8 + LF，不推断项目级约定。改这条路径 `tests/{text-encoding,fs-write-route}.spec.ts` 必须跟着红。
- **皮肤契约**：视觉值只用 `--dsw-alias-*` / `--dsw-font-*` / `--ds-*` 令牌，零硬编码颜色，**插件没有任何豁免面**（含每个 tab glyph）。改样式同步[指南 §12](docs/external-plugin-guide.md) 与 `tests/theme.spec.ts`。
- **宿主 icon 默认 16px**：`Icon<Name>Regular` / `Medium` 默认 `size = 16`，想要 14px 必须显式传 `size={14}`（漏传是静默变大 2px，`typecheck` 拦不住）；导入面由 `tests/primitives-exports.spec.ts` 守护。
- **接入 API 即文档**：`src/client/service.ts` 与 `src/client/builtins/` 的行为变更必须同步 [docs/external-plugin-guide.md](docs/external-plugin-guide.md)。
- **文件/文件夹图标**：回退链是「具体 `names`/`exts` → catch-all（`exts: []`）→ 宿主 `FileTypeIcon`」；`exts: []` 会接管所有未命中行，只想补几个类型就用 `exts`/`names`。
- **git 状态轮询只有一条**（`src/client/ui/git-status.ts`，一次抓取 4 个进程）：基线 30 s、慢往返依次退档到停表；**空闲不 `notify`**；`poll: false` 的消费者永不持有定时器。**不要自建第二个轮询器**（细节见该文件头注释）。
- **稳态开销**：原生 tab 一律 `keepMounted`，挂载过的 body 永久存在（宿主无 LRU）。因此：轮询器 / socket / 观察者按可见性门控（隐藏即停表，重新可见立刻补刷一次，但**不停**事件驱动刷新）；「每会话 / 每资源」的东西全插件单例（引用计数或 leader），绝不按 body 复制；模块级 Map 一律有上限与淘汰（在用项与有在飞请求的键不淘汰）；新增周期调用 `cwdOf()` 前先估最坏成本。`tests/steady-state.spec.tsx` 与 perf lane 守护。

---

## 6. 去哪找什么

- **接入 API 全参考**：[docs/external-plugin-guide.md](docs/external-plugin-guide.md)（§0 承载面 / §4 Tab / §5 FileViewer / §7 服务 / §10 平台陷阱 / §12 皮肤契约 / §15 案例）。
- **宿主契约与沿用至今的适配约束**：[docs/host-contracts.md](docs/host-contracts.md)（编号与旧 §3.4 第 1–12 条一致）。
- **设计史 / 历次版本适配**：[docs/plans/](docs/plans/)；**用户可见变更**：[CHANGELOG.md](CHANGELOG.md)。
- **Issue / PR 分诊**：[.agents/skills/issue-triage/SKILL.md](.agents/skills/issue-triage/SKILL.md)（脚本在同目录 `scripts/`）。
- **测试**：契约写在每个 spec 的**头注释**里——改哪个子系统就跑对应 spec（注册表 `service` / `builtins` / `market-manifest`；原生承载面 `native-surface` / `native-registration`；文件树 `fs-tree-*` / `file-tree-*` / `fs-watch`；编辑器与文件路由 `file-stream-route` / `fs-read-page` / `text-encoding` / `fs-write-route`；Git `git-status-poll` / `git-scm` / `git-graph*`）。
- **跨平台（ubuntu + windows 双 runner）三条硬规则**：测试不得依赖 `rg` / `fd` / `jq` 这类非普适二进制（缺了是收集阶段整文件失败）；fixture 文件名两平台都要合法（`* ? : " < > |` 在 Windows 非法，要验证元字符就用 `a[b]` 这种良构的，**不要**用未闭合的 `a[b`）；按「入参平台」推导路径的函数必须用同方言的 `node:path`（`posix` / `win32`），否则本地永远绿、runner 上永远红。
