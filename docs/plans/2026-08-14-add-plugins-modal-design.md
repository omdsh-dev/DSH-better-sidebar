# 「添加插件」弹窗 + 推荐插件列表 + 复制安装命令 设计

**日期**：2026-08-14
**状态**：已批准，已实施
**作者**：opencode + 用户
**当前版本**：v0.12.0（分支 `feat/plugin-api-v012`，已合入 main 后 rebase）
**目标版本**：v0.12.0（不 bump）

## 1. 目标

1. 为「侧边栏内容（Tab）」与「文件预览（viewer）」两类扩展点分别增加**添加入口**：DSH 设置页「Side card」分区的两个响应式网格（侧边栏内容 / 文件预览）末尾各新增一个与其他卡片同尺寸的**虚线边框**添加卡片（「添加 Tab 插件」/「添加预览插件」）。
2. 点击后弹出对应 kind 的原生 Modal：声明该类扩展点可由插件扩展（`ctx.betterSidebar` 服务），提供「在 GitHub 上浏览更多插件」**按钮**（打开 `https://github.com/topics/dsh-better-sidebar`，新标签页），并展示仓库**推荐**的同 kind 插件列表（名字 / url / 简介 / 安装脚本）。
3. 每个条目两个动作：**「跳转」按钮**（`window.open` 新标签页直达插件仓库，绕过链接接管）与**「复制」按钮**——点击只把安装脚本写入剪贴板（`writeClipboard`，按钮闪现「已复制」反馈），用户自行粘贴到 DSH 所在环境的终端执行。
4. **不关闭任何窗口、不打开终端、无失败路径**：复制是纯 client 动作，不依赖会话/终端/配额，弹窗保持打开可连续复制多个插件。
5. 推荐列表为仓库静态数据、**分为两个文件**（`plugins-tabs.ts` Tab 注册目录 / `plugins-viewers.ts` 文件预览注册目录），初始在 viewer 目录收录唯一真实三方插件 `@huanlin/dsh-plugin-better-sidebar-plugin-office`（简介不注版本前提）；后续插件只加一条数据。
6. 内置 Office 预览（docx/xlsx/pptx）**从本体移除**——已迁至上述推荐插件（见偏差记录），`docx/xlsx/pptx` 文件在未装插件时落 code/下载兜底。

## 2. 非目标（Out of Scope）

- **不打开终端**：不做终端预填安装流（曾实现的 `OpenTabSeed.expand`、`TerminalSeedMeta` 预填/提示条、service meta 透传等已全部删除回滚）。
- 不加 + 菜单入口、不加编辑器空态入口（入口只在设置页）。
- 不做插件在线拉取 / 动态发现（列表为仓库推荐静态数据）。
- 不改 host 半的服务契约（`service.ts` 相对 v0.12.0 无 API 变化；host 半仅在 office 移除时缩减了 chunk 白名单）。

## 3. 实施要点

### 3.1 数据层：两个目录文件 + 共享词汇

- `src/client/plugins-shared.ts`：`PluginEntry { id, name, url, description, install }` + `PLUGIN_TOPIC_URL`。
- `src/client/plugins-tabs.ts`：`builtinTabPlugins`（收录 dsh-sentinel——条件驱动的 agent 唤醒系统，注册 `dsh-sentinel:watches` Tab；install 用官方 github: 源一键命令）。
- `src/client/plugins-viewers.ts`：`builtinViewerPlugins`（种子：office 插件，install = `cd ~/.dsh && dsh plugin --profile web add @huanlin/dsh-plugin-better-sidebar-plugin-office`）。

### 3.2 UI 层：`src/client/add-plugin-modal.tsx` + `SideCardSection`

- 两个网格末尾各一个虚线卡片（复用 `.card` 配方 + `IconPlusOutline16`），`addPluginsOpen: PluginKind | null` 状态；Modal 仅在打开时条件挂载（Modal 原语无条件跑 hooks，SSR 规则同 settingsFor）。
- `PluginListBody`（提取组件，直接可测）：topic 按钮（`window.open`）+「推荐插件」分组（`groupHeading` + count）+ 条目（名字链接 / 简介 / mono 安装命令 / 跳转按钮 / 复制按钮）+ 空态。
- **复制**：`void writeClipboard(entry.install)` + `copiedId` 状态闪现 `t('copied')`（1.5s 后还原）。不关闭、不打开、不抛错。

### 3.3 i18n

新增键：`addPluginsTabCard/TabCardDesc/ViewerCard/ViewerCardDesc/TabDesc/ViewerDesc`、`addPluginsBrowseMore`、`addPluginsRecommended`（推荐插件）、`addPluginsEmpty`、`openPlugin`（跳转）、`copyInstall`（复制安装命令，按钮 aria-label）；复用 `copy`/`copied`/`close`/`settingsDone`。已删除废弃键：`install`、`installNotice`、`installError*`、office 相关键（`viewerDocx/Xlsx/Pptx`、`officeTooLarge/Corrupt/Encrypted/LoadFailed`、`previousSlide/nextSlide/zoom/zoomHint`）。

### 3.4 内置 Office 预览移除（与推荐插件衔接）

删除 3 个 viewer 描述符 + 10 个源文件（docx-view/xlsx-view/PptxView/office-view/office-shared/office-types/xlsx-to-univer + chunks/docx|xlsx|pptx）+ 3 个图标 + office CSS + office locale 键；chunk 白名单 5→2（terminal/editor，同步 `bundle-route.ts` / `chunk-loader.ts` / `tsdown.config.ts` / `scripts/package-registry.mjs`）；`tests/builtins.spec.ts` 断言 6 个 viewer 且不含 office id。`.docx`（zip、无 NUL）未装插件时落 code 兜底。

## 4. 边界情况与失败模式

- **复制失败**：`writeClipboard` 尽力而为（navigator.clipboard → execCommand 兜底），失败静默；按钮反馈照常闪现。无会话/无终端/配额等一切前置条件均不涉及——复制与它们无关。
- **空目录**：目录可为空（弹窗渲染空态 + topic 按钮）；当前 Tab/Viewer 目录各有 1 条。
- **版本号**：v0.12.0（`package.json` / `dsh.plugin.json` / `service.ts` 的 `SIDEBAR_SERVICE_VERSION` 三处一致，manifest-consistency 测试守护）。

## 5. 实施偏差记录

- **评审修改（第一批）**：入口由 + 菜单/编辑器空态改为**仅设置页虚线卡片**；安装命令并入「安装按钮」单一交互。
- **评审修改（第二批）**：① topic 链接改为**按钮**（`window.open` 新标签页）；② 添加按钮拆为**两个**（Tab 注册 / 文件预览注册），列表数据拆为**两个文件**；③ 安装错误只内联显示在设置内（预检 + try/catch）；④ 终端提示条用品牌高亮色。
- **评审修改（第三批）**：内置 Office 预览整体移除（迁至推荐插件）；「内置插件」全部改名**「推荐插件」**。
- **评审修改（第四批，最终形态）**：设置窗口关闭问题无法根治（openTab 的 store 涟漪会复活弹窗），且用户实测弹窗关闭不可靠——**放弃终端安装流**：安装按钮改为**只复制安装脚本**（`writeClipboard` + 「已复制」反馈），弹窗保持打开；随之删除整个终端预填流：`terminal-meta.ts`、`TerminalView` 的 meta/预填/提示条、`tabs.tsx` 的 meta 透传与 `uiTerminalCount` 导出、`service.ts` 的 `OpenTabSeed.expand` 与 createTab meta 透传（全部回滚到 v0.12.0 原始 API 面）、`.terminalNotice` CSS、相关测试与文档；`install`/`installNotice`/`installError*` 文案键删除，新增 `copyInstall`。
- 测试中 `AddPluginModal` 不能 renderToString（React 18 server renderer 拒绝 portal），改为 createRoot + act 挂载后断言 `document.body`（portal 落点）。

## 6. 验收清单

- [x] 设置页两个网格末尾各出现虚线边框添加卡片，尺寸与既有卡片一致
- [x] 两个弹窗（kind 区分）：声明文案 + GitHub topic **按钮** + 对应推荐插件条目（名字/url/简介/安装命令/跳转按钮/复制按钮）
- [x] 点「复制」：安装脚本写入剪贴板，按钮闪现「已复制」，弹窗不关闭、不打开终端、无失败路径
- [x] 点「跳转」：`window.open` 新标签页直达插件仓库
- [x] 内置 Office 预览已移除；chunk 白名单 2 个；无「内置插件」残留文案
- [x] 版本号 v0.12.0 三处一致；`pnpm typecheck` / `pnpm test` / `pnpm build` 全绿
- [x] README/README_EN/AGENTS.md 更新到位
