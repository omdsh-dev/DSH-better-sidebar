# 开发规范

> [AGENTS.md](../AGENTS.md) 的红线在这里展开成可执行细则。按子系统运行时该跑哪些测试、跨平台要注意什么，也都在本文。

## 1. 总则

- **KISS / YAGNI**：用最简单的可行方案。不为投机需求加抽象、配置项或兼容层；单次使用的 helper 不要抽成独立概念。
- **修根因**：把坏值追到被违反的假设上，不打只盖住症状的补丁。
- **边界校验一次**：输入在拥有它的那一层校验一遍，进到内层就当已成立，不要层层重查。
- **测试钉行为**：新用例要在去掉修复后变红；不要复刻实现逻辑当断言，也不要为了让测试过而放宽到失去意义。
- **提交前自查**：git status 干净无多余文件；改动有对应的 spec；用户可见变更进 CHANGELOG。

## 2. 构建与打包

### 构建纯度

client bundle 禁止 **value-import** `@dsh-external/*` 或非白名单的 `@deepseek-ai/*`（tsdown.config.ts 拦截）。`import type {}` 会被擦除，不触发。跨插件交互一律走 `ctx.betterSidebar`。

### 懒加载 chunk

重依赖只在 `lib/client-<name>.js`（editor / mermaid / locale / terminal），由 `/sidebar/bundle` 按需下发；**核心 bundle 禁止静态 import `src/client/chunks/*`**。

chunk 名的真源是 `CHUNK_NAMES`（src/bundle-route.ts），另有 5 处镜像必须同步：

1. tsdown.config.ts
2. src/client/chunk-loader.ts
3. package.json 的 files
4. scripts/package-registry.mjs
5. tests/bundle-route.spec.ts / tests/chunk-artifact.spec.ts

## 3. 客户端

### i18n

- 词典在 betterSidebar 命名空间；**新增 zh key 必须同步 src/client/locales-ja.ts**（否则 ja 下回退 en），其余词典的 key 集由 tests/locales.spec.ts 守护。
- 渲染 MarkdownText 一律经 `markdownTextProps()`（src/client/markdown-labels.tsx），它负责必填的 labels 嵌套结构；漏传会回退硬编码中文。

### 皮肤契约

- 视觉值只用 `--dsw-alias-*` / `--dsw-font-*` / `--ds-*` 令牌，**零硬编码颜色**；插件没有任何豁免面（含每个 tab glyph 与设置页图标）。tests/theme.spec.ts 与[指南 §12](external-plugin-guide.md) 共同守护。
- 改样式要同步更新指南里对应的接口说明。

### 图标

- 宿主 `Icon<Name>Regular` / `Icon<Name>Medium` 的默认 size 是 **16**；要 14px 必须显式 `size={14}`（漏传是静默变大 2px，typecheck 拦不住）。导入面由 tests/primitives-exports.spec.ts 守护。
- **设置页导航图标走宿主的 settings.section.icon 插槽**：注册时 id 必须等于 settings.section 的 id；宿主按 owner props 的 size 要一个正方形图标并用 currentColor 着色，未注册时保留自己的默认图标。**不要**再用「按文字标记导航行 + CSS 遮罩盖住默认图标」的做法——宿主给图标加了外层容器后遮盖会失效，表现为一行两个图标（v0.30.1 修的就是这个）。

### 文件 / 文件夹图标

回退链：具体 names/exts → catch-all（`exts: []`）→ 宿主 `FileTypeIcon`。`exts: []` 会接管**所有未命中行**，只想补几个类型就用 names/exts 精确声明。

### 接入 API 即文档

src/client/service.ts 与 src/client/builtins/ 的行为变更必须同步 [docs/external-plugin-guide.md](external-plugin-guide.md)。

## 4. 服务端与稳态开销

### 保存语义（fs.write）

写盘**前**按磁盘现状还原文件格式：`fileFormatOf` 一趟 64 KiB sniff 得出 {encoding, eol}，落盘走 `encodeText(restoreEol(...))`；**客户端只发送 LF**，行尾由服务端还原；新文件 UTF-8 + LF，不推断项目级约定。改这条路径 tests/text-encoding.spec.ts 与 tests/fs-write-route.spec.ts 必须跟着红。

### git 状态轮询只有一条

src/client/ui/git-status.ts，一次抓取 4 个进程：基线 30 s、慢往返依次退档到停表；**空闲不 notify**；`poll: false` 的消费者永不持有定时器。不要自建第二个轮询器。

### 稳态开销

原生 tab 一律 `keepMounted`，挂载过的 body 永久存在（宿主没有 LRU）。因此：

- 轮询器 / socket / 观察者按**可见性门控**（隐藏即停表；重新可见立刻补刷一次，但**不停**事件驱动刷新）。
- 「每会话 / 每资源」的东西全插件**单例**（引用计数或 leader），绝不按 body 复制。
- 模块级 Map 一律有**上限与淘汰**（在用项与有在飞请求的键不淘汰）。
- 新增周期性调用 `cwdOf()` 之前先估最坏成本（冷会话读 header 也要钱）。

tests/steady-state.spec.tsx 与 perf lane 守护这些约束。

## 5. 测试

### 改哪个子系统跑哪些 spec

契约写在每个 spec 的**头注释**里。常用映射：

| 子系统 | 代表 spec |
| --- | --- |
| 注册表 / 服务 | service · builtins · market-manifest |
| 原生承载面 | native-surface · native-registration · native-surface-cross-session |
| 文件树 | fs-tree-* · file-tree-* · fs-watch |
| 编辑器与文件路由 | file-stream-route · fs-read-page · text-encoding · fs-write-route |
| Git | git-status-poll · git-scm · git-graph* |
| 侧边对话 | sidechat-* |
| 皮肤 / 词典 / 图标 | theme · locales · primitives-exports |

### 跨平台（ubuntu + windows 双 runner）三条硬规则

1. 测试不得依赖 rg / fd / jq 这类非普适二进制——缺了是**收集阶段整文件失败**。
2. fixture 文件名两平台都要合法：`* ? : " < > |` 在 Windows 非法；要验证元字符就用 `a[b]` 这种良构的，不要用未闭合的 `a[b`。
3. 按「入参平台」推导路径的函数必须用同方言的 `node:path`（posix / win32），否则本地永远绿、runner 上永远红。

### e2e

- spec 命名 `*.e2e.ts`，与 vitest 的 exclude 双保险；**改 exclude 必须保留默认排除项**。
- Windows lane 用 `pnpm test:windows`（`--maxWorkers=1`），vitest.config.ts 的 `testTimeout: 30_000` 与它配套。
- 已知 flake：tests/fs-watch.spec.ts 在满载下偶发超时（#868），隔离运行稳定——不要为它改代码，也不要把它当成本批次回归。

### 挂载冒烟（部署层唯一信号）

`pnpm test:mount`：`pnpm build && pnpm pack` → scripts/e2e-mount.sh 装进全新 scratch profile → 起真实 `dsh web`（keyless、`--port 0`）→ Playwright。它断言：插件挂载且无 pageerror / console 错误；原生 guide 里**宿主自己的终端条目恰好 1 条**；browser 条目**显式缺席**；文件树经 files 接管能打开 seed 文件并加载 editor chunk；native-reload.e2e.ts 的页面内条目替换前后都无 `native register … error`。

环境注意：`NODE_OPTIONS=--max-old-space-size=4096`；**不要加 `--legacy-peer-deps`**（会跳掉 boot 必需的 peer）；本机 registry 是 npmmirror，装不到新预发布时加 `--registry https://registry.npmjs.org`。

## 6. 常用命令

| 目的 | 命令 |
| --- | --- |
| 类型检查 | pnpm typecheck |
| Lint | pnpm lint |
| 全量单测 | pnpm test |
| 单文件 / 单用例 | pnpm exec vitest run tests/<name>.spec.ts |
| Windows 串行单测 | pnpm test:windows |
| 构建 | pnpm build |
| 打包 | pnpm pack |
| 消费方类型面 | pnpm check:consumer-types |
| 搜索引擎输出形状 | pnpm check:engines |
| 挂载冒烟 | pnpm test:mount |
| 双挂载回归 | pnpm test:mount:aggregate |
| 依赖 peer 体检 | pnpm peers check |
