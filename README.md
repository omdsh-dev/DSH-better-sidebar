# dsh-better-sidebar

> [!IMPORTANT]
> **v0.19.0 起接入 DSH 原生侧边栏**：右列就是 DSH 自己的右侧栏，插件把每个 tab 类型注册为原生 tab（不再自绘右侧面板），只保留自绘的底部工作台与开放给所有插件的 `ctx.betterSidebar` 服务。
>
> **v0.24.1 起要求 DSH `0.2.0-rc.1+`**（peer 下限 `^0.2.0-rc.1`）。0.2.0 对本插件所用的全部宿主 API 是**纯增量**（零导出删除、会话格式仍 v4、CLI 与客户端运行时未变），所以这一版没有运行时兼容分支，只把支持线整体前移。**DSH 0.1.7 线的用户请固定 `dsh-better-sidebar@0.22.1`——caret 范围跨 minor 不成立，`^0.1.7-rc.1` 在 0.2.0 宿主上会被启动预检静默禁用**；按 DSH 版本选插件版本的对照表见[安装](#-安装)。

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">一个服务化的侧边栏框架，一套开箱即用的完整工作台</b><br /><br />
  <a href="https://www.npmjs.com/package/dsh-better-sidebar"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-better-sidebar" /></a>
  <a href="https://www.npmjs.com/package/dsh-better-sidebar"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-better-sidebar" /></a>
  <a href="https://github.com/omdsh-dev/DSH-better-sidebar/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/omdsh-dev/DSH-better-sidebar/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/omdsh-dev/DSH-better-sidebar/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/omdsh-dev/DSH-better-sidebar" /></a>
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://dshfind.com/zh/plugins/omdsh-dev/DSH-better-sidebar?ref=badge"><img alt="dshfind" src="https://dshfind.com/api/badge/omdsh-dev/DSH-better-sidebar?lang=zh" /></a><br /><br />
  <a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="支持的 DSH 版本（v0.24.1）：0.2.0-rc.1+" src="https://img.shields.io/badge/DSH-0.2.0--rc.1%2B-4d6bfe" /></a>
  <a href="https://github.com/topics/dsh-better-sidebar"><img alt="插件生态：GitHub topic dsh-better-sidebar" src="https://img.shields.io/badge/%E6%8F%92%E4%BB%B6%E7%94%9F%E6%80%81-topic%20dsh--better--sidebar-4d6bfe" /></a><br /><br />
  <img alt="文件管理" src="https://img.shields.io/badge/-文件管理-4d6bfe" /> <img alt="编辑预览" src="https://img.shields.io/badge/-编辑预览-4d6bfe" /> <img alt="底部工作台" src="https://img.shields.io/badge/-底部工作台-4d6bfe" /> <img alt="文件变动" src="https://img.shields.io/badge/-文件变动-4d6bfe" /> <img alt="后台任务" src="https://img.shields.io/badge/-后台任务-4d6bfe" /> <img alt="侧边对话" src="https://img.shields.io/badge/-侧边对话-4d6bfe" /> <img alt="插件接入" src="https://img.shields.io/badge/-插件接入-4d6bfe" /><br /><br />
  <b>右侧栏 + 底部面板双工作台</b>，并把 <code>ctx.betterSidebar</code> 服务开放给所有插件——<br />
  通过 <code>registerTab</code> / <code>registerFileViewer</code> 注册新的侧边栏页面与文件预览器。
</div>

<div align="center">
  🌏 <a href="./README.md"><b>中文</b></a> · <a href="./README_EN.md">English</a>
</div>

<div align="center">
  <img alt="dsh-better-sidebar 工作台截图" src="https://github.com/user-attachments/assets/991c4b70-d45a-461f-a8c8-0a28b4218e60" />
  <video src="https://github.com/user-attachments/assets/23187822-047e-45cc-b480-fe997bd55b86" muted autoplay loop playsinline controls width="100%"></video>
</div>

## 📑 目录

- [✨ 功能一览](#-功能一览)
- [🚀 安装](#-安装)
- [🖼️ 特性巡礼](#-特性巡礼)
- [💬 社区](#-社区)
- [🆕 最近更新](#-最近更新)
- [⌨️ 快捷键](#-快捷键)
- [🔌 服务化扩展](#-服务化扩展)
- [🛠️ 开发与构建](#-开发与构建)
- [🔐 安全](#-安全) · [⚠️ 已知限制](#-已知限制) · [🖥️ 平台支持](#-平台支持)
- [🌐 插件生态](#-插件生态) · [🤝 参与贡献](#-参与贡献) · [👥 贡献者](#-贡献者) · [🔗 友情链接](#-友情链接)

## ✨ 功能一览

相比 DSH 官方侧边栏，本插件补上的关键能力：

- **🖥️ 可编辑的代码编辑器**：官方文档预览是**只读**的 → 插件保留**可编辑**的 CodeMirror 编辑器（保存、语法高亮、预览切换）；Markdown / HTML 也走插件自有渲染（Mermaid 图表安全渲染 + 点击放大、README 级内嵌 HTML、浮动目录大纲、HTML 沙箱预览）
- **🗂️ 增强文件树**：接管内置「文件」页——懒加载目录树、**展开的目录实时 watch 自动刷新**、软链接识别、全局文件名搜索、拖拽上传、悬浮 `@文件` 一键引用进输入框；**Ctrl/Cmd 多选 + Shift 连选**（批量复制路径 / 批量删除）、**Git 变更着色 + 状态字母**（VS Code 同款）、**新建文件夹**、**多选右键「压缩并打包下载」**（服务端流式打 ZIP，无第三方依赖）；右键「打开方式」= **DSH 自带 open-in-app**（宿主探测到的本机关联应用 + 文件管理器显示）**+ 插件自研打开方式**（资源管理器 / VS Code / Cursor / Zed / 自定义编辑器 URL 模板、SSH 远端、固定到菜单）两者并存
- **🌿 文件变动**（官方侧栏没有 Git 面板）：Git 视角（暂存 / 提交 / 历史 / 工作树与子仓库）+ 本轮 AI 改动视角双合一，统一 diff 渲染（行内字符级高亮、语法着色、敏感内容脱敏）；两视角共用一套 28px 行、单一空态/错误通道与吸底提交条
- **🧩 任务管理**（官方没有）：子代理拓扑实时预览 + 后台任务清单（退出码 / 实时输出 / 强制终止）
- **💬 侧边对话**（官方没有，beta）：Codex 风格侧边线程——继承主会话完整上下文独立运行，可持续追问，一键提升为顶层会话
- **🖥️ 底部工作台**（官方没有）：右列交给 DSH 原生右侧栏，插件另加自绘底部工作台（拖拽分栏 / 按会话持久化），可与原生栏同时展开
- **📂 模型打开侧边栏（可选）**：`sidebar_open` 工具让模型主动在侧边栏打开文件 / 文件夹 / 网页
- **🔌 服务化扩展**：`ctx.betterSidebar` 向所有插件开放（`registerTab` / `registerFileViewer`），内置 5 tab + 3 viewer 走同一套 API，已有 **28+ 生态插件**（见「🌐 插件生态」）
- **⚡ 按需加载**：启动只拉 ~325KB 核心，编辑器 / Mermaid / 第三语言词典按需加载 · **🌏 多语言**跟随 DSH · **🔁 会话隔离**按会话持久化布局

## 🚀 安装

**前置**：已装好 DSH（`dsh web` 能正常运行），Node.js ≥ 20、pnpm ≥ 10。

**支持的 DSH 版本**：
<a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="支持的 DSH 版本（v0.24.0）：0.2.0-rc.1+" src="https://img.shields.io/badge/DSH-0.2.0--rc.1%2B-4d6bfe" /></a>

> 📌 **通道与支持线**：`v0.24.1` 适配 DSH **0.2.0-rc.1+**（0.2.0 首个候选版走 npm `next` 通道，`latest` 仍是 0.1.7-rc.2）。**装 DSH 请写精确版本号**：`npm i -g @deepseek-ai/dsh@0.2.0-rc.1`。**0.1.7 线的用户请固定 `dsh-better-sidebar@0.22.1`**：0.2.0 是宿主 minor 变更，`^0.1.7-rc.1` 这类 caret 范围在 0.2.0 上会被宿主的启动兼容性预检判定失败、整行静默禁用。

> 🧭 **按你的 DSH 版本选插件版本**：
>
> | 你的 DSH 版本 | 安装命令 | 版本 / peer 声明 |
> | --- | --- | --- |
> | **0.2.0-rc.1+**（含之后的 0.2.0 正式版） | `dsh plugin --profile web add dsh-better-sidebar@latest` | **0.24.1**，`^0.2.0-rc.1` |
> | **0.1.7-rc.1 ~ 0.1.7-rc.2**（含 0.1.7 正式版；npm `latest` 目前仍是 0.1.7-rc.2） | `dsh plugin --profile web add dsh-better-sidebar@0.22.1` | **0.22.1**，`^0.1.7-rc.1` |
> | 0.1.7-alpha.1 / 0.1.7-alpha.2 | **没有可装版本**——先把 DSH 升到 rc.1，再跑上一行：<br>`npm i -g @deepseek-ai/dsh@0.1.7-rc.1` | — |
> | 0.1.6-alpha.2 及更早、`0.1.5-rc.*`（含 npm `latest` 的 0.1.5-rc.3） | `dsh plugin --profile web add dsh-better-sidebar@0.19.1` | **0.19.1**，`^0.1.5-rc.1` |
> | `0.1.5-alpha.2` | `dsh plugin --profile web add dsh-better-sidebar@0.19.0-alpha.1` | `^0.1.5-alpha.2` |
> | `0.1.2-rc.*` | `dsh plugin --profile web add dsh-better-sidebar@0.18.1` | `^0.1.2-rc.1` |
> | `0.1.2-alpha.2` | `dsh plugin --profile web add dsh-better-sidebar@0.18.0-alpha.0` | `^0.1.2-alpha.2` |
> | `0.1.0-rc.8` / `0.1.1` | `dsh plugin --profile web add dsh-better-sidebar@0.17.1` | `^0.1.0-rc.8` |
>
> 命令里的 `web` 换成你自己的 profile 名即可。**旧版本一律写精确版本号**（`@0.19.1` 而不是 `@latest`），因为 `latest` 会随新正式版前移；反过来也**不要**在 0.1.7 的 alpha 上装 0.19.1，装上只会坏。

```sh
dsh plugin --profile web add dsh-better-sidebar@latest
```

> 本版不依赖任何需要构建脚本的包（终端连同 `node-pty` 已整体交还 DSH），安装**一步到位**；装完后可在 DSH 自带的 **Plugins 页面**直接启停。

装完**硬刷新浏览器**（Cmd/Ctrl+Shift+R）即可看到侧边栏（DSH 对 client 改动热加载，无需重启；仅 host 半更新时需要重启）。

**方式二：让 DSH 自己装**——把下面这段提示词发给任意一个 DSH 会话：

```text
帮我安装 dsh-better-sidebar 插件（DSH 侧边栏工作台），步骤：
1. 执行 dsh plugin --profile web add dsh-better-sidebar@latest（latest 即当前正式版）
2. 完成后提醒我硬刷新浏览器（Cmd/Ctrl+Shift+R）
遇到报错先查 https://github.com/omdsh-dev/DSH-better-sidebar README 的常见问题表。
```

**方式三：一键脚本**——克隆本仓库后执行 `bash scripts/install.sh`（macOS / Linux / Windows Git Bash；Windows 原生环境用 `install.ps1`；`-h` 查看参数），自动完成安装 + bundle 注册（含幂等清理旧的手动挂载行）。

<details>
<summary><b>更新</b></summary>

```sh
dsh plugin --profile web add dsh-better-sidebar@latest
```

也可把 `~/.dsh/profiles/web/package.json` 里的版本号改高后 `pnpm install`。改完**硬刷新浏览器**（Cmd/Ctrl+Shift+R）即可（client 改动无需重启 DSH）。

</details>

<details>
<summary><b>常见问题</b></summary>

| 现象 | 原因与解决 |
|---|---|
| 报 `Ignored build scripts` | pnpm 11 拦截了某个传递依赖的构建脚本。在 profile 目录（`~/.dsh/profiles/web`）跑 `pnpm approve-builds` 按提示放行——本插件自身已无构建脚本依赖（终端删除后 `node-pty` 不在依赖里）。 |
| 报 `minimum release age` / 版本不足 24h | 装的版本发布不足 24 小时。等 24h 或重跑一次（pnpm 会自动补 `minimumReleaseAgeExclude`）。 |
| 报「找不到 profile 目录」 | 先跑一次 `dsh web`，让它初始化 `~/.dsh/profiles/web`。 |
| 页面出现**两个侧边栏** | 双挂载。旧的手动挂载行：`~/.dsh/profiles/web/cordis.patch.yml` 还留着 `- insert: ... better-sidebar ...`，删掉那段（同 id 重复挂载 loader 会直接报 `duplicate loader entry id`）。聚合包（如 `@linxin666/dsh-web-ui-all`）以**不同 id** 挂载本包时，0.13.x 起插件自身 bundle patch 会自动退让（检测到已有启用中的同包名挂载就不挂自己），无需手动处理；若仍双挂载，先确认聚合包的 bundle 顺序在 `dsh-better-sidebar` 之前。 |
| 升级后设置页的值去哪了 | DSH 0.1.7 删除了插件可注册的设置命名空间：偏好现在写在 profile 里本插件的**挂载行**上（默认 entry id `better-sidebar`），不再是 `~/.dsh/settings.yaml`。插件会在首次启动时把旧 `settings.yaml`（已被宿主改名为 `settings.yaml.imported`）里 `dsh-better-sidebar` 段一次性回迁，只迁移当前 schema 仍声明的字段、且只在该行还没有用户值时执行，不会覆盖升级后新设的值。 |
| 终端无法使用 / 提示 shell 启动失败 | 终端由 **DSH 自身的 `ui-sidebar-terminal`** 提供（本插件不再自带终端与 `node-pty`，也没有终端相关设置项）。遇到问题请查 DSH 侧文档；若报错提到构建脚本，见上一行。 |
| 提示 `dsh: command not found` | 先安装 DSH；或直接用 `npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-better-sidebar@latest`。 |

</details>

<details>
<summary><b>从源码安装 / 开发（可选，替代 npm 方式）</b></summary>

调试本地改动或跟随开发分支时，把依赖指向本地克隆并自行构建：

```text
1. git clone https://github.com/omdsh-dev/DSH-better-sidebar.git ~/Code/DSH-better-sidebar
   cd ~/Code/DSH-better-sidebar && pnpm install && pnpm build
2. ~/.dsh/profiles/web/package.json 的 dependencies 写 "dsh-better-sidebar": "link:<克隆目录绝对路径>"
3. ~/.dsh/profiles/web/cordis.patch.yml 追加挂载行（这一行的 `config` 就是本插件的设置表单：部署限额 `readLimit` / `mediaLimit` / `uploadLimit` / `listLimit` 加用户偏好字段，设置页写的就是它；不写则全部用 schema 默认值）：
   - insert:
       - id: better-sidebar
         name: 'dsh-better-sidebar'
         config:
           readLimit: 524288
4. 在 ~/.dsh/profiles/web 执行 pnpm install
5. 硬刷新浏览器（Cmd/Ctrl+Shift+R）即可看到效果（client 改动无需重启 DSH；host 半改动才需重启）
```

更新：`git pull && pnpm install && pnpm build` → 硬刷新浏览器即可（client 改动热加载生效，无需重启 DSH；host 半改动才需重启）。切回 npm 通道时，把依赖改回 npm 上的对应版本（稳定线 `"^0.19.1"`；本线 `"^0.22.1"`）再 `pnpm install`。

</details>

<details>
<summary><b>通过 plugin-registry 安装（可选，与上述二选一）</b></summary>

前置：DSH 已集成 [plugin-registry](https://github.com/dsh-external/plugin-registry)（`dsh registry` 可用）。**同时启用两个通道会双挂载**（Node 半挂两次、页面两个侧边栏）。

```sh
git clone https://github.com/omdsh-dev/DSH-better-sidebar.git && cd DSH-better-sidebar
pnpm install && pnpm build
node scripts/package-registry.mjs   # 组装 registry/ 暂存（含清单 + 产物 + README，不入库）
dsh registry install ./registry     # 安装（默认禁用）
dsh registry enable dsh-external/dsh-better-sidebar
```

更新：`git pull && pnpm install && pnpm build` → `node scripts/package-registry.mjs` → `dsh registry uninstall/install/enable`。切换通道前先移除另一通道的挂载。

</details>

## 🖼️ 特性巡礼

> 以下均为真实界面实拍（每行两张，点击可放大）。

| | |
|---|---|
| **🗂️ 文件工作台：资源管理器**<br/><sub>支持两种格式的资源管理器：内嵌在文件预览中 / 独立显示文件树。懒加载目录树、**展开的目录由宿主按目录 watch、改动后自动重列**、软链接按目标类型展示（目录软链接可展开、失效链接标红）、全局文件名搜索、上传文件/文件夹与拖放上传、右键菜单（在新 Tab 打开 / 在侧边打开 / 新建文件夹 / 打开方式：**宿主探测到的系统关联应用**（open-in-app）+ **插件自研目标**（资源管理器 / VS Code / Cursor / Zed / 自定义编辑器，支持 SSH 远端与固定到菜单）/ 复制路径 / 重命名 / 删除）、**Ctrl/Cmd 多选与 Shift 连选**（批量复制路径 / 批量删除 / **压缩并下载**）、**Git 变更按状态着色并带 M/A/D/U 字母**、悬浮 `@文件` 一键引用进输入框。</sub><br/><div align="center"><img width="420" alt="文件资源管理器" src="https://github.com/user-attachments/assets/a410bfd2-a8ba-43e6-873e-22417756e94d" /></div> | **📝 Markdown · HTML 内联预览**<br/><sub>Markdown 预览支持 **Mermaid 图表**（`securityLevel: 'strict'` 安全渲染 + 二次清洗；点击图表弹窗放大、滚轮缩放、拖拽平移）、**README 级内嵌 HTML**（徽章墙 `<div align=center>`、`<details>` 折叠块内嵌 markdown、表格单元格内联标签——DOMPurify 白名单消毒真实渲染，`<script>` 等活性内容剥除，本地图片经会话媒体路由重写）与**浮动目录大纲**（≥3 标题出现，点击平滑跳转、自动展开折叠块）；HTML 走插件自带的**沙箱预览**，并带 `htmlViewerNoSandbox` / `htmlViewerDefaultUnsafe` 两个宿主没有的逃生门开关。**图片 / PDF / 表格 / Office 不再是插件能力**——那些格式由 DSH 自己的文档预览渲染。</sub><br/><div align="center"><img width="420" alt="Markdown + Mermaid 预览" src="https://github.com/user-attachments/assets/fe0e5182-55bb-45cc-b98b-a2877c2bdd38" /></div> |
| **🖥️ CodeMirror 代码编辑器**<br/><sub>**可编辑**的文本 / 代码编辑器（保存、语法高亮、预览切换）——宿主自己的文档预览是**只读**的，这是插件保留 catch-all viewer 的理由。</sub><br/><div align="center"><img width="420" alt="CodeMirror 代码编辑器" src="https://github.com/user-attachments/assets/b44b488e-568c-4ee0-b96c-e9c906598a77" /></div> | **🖼️ 图片 / PDF / 表格 / Office 预览（由 DSH 内置提供）**<br/><sub>这些只读格式由 DSH 自己的 `ui-sidebar-documentpreview` 渲染：宿主侧 Office→PDF 转换、电子表格 worker 表格、图片 / PDF 缩放视口，并**按目录自动刷新**。插件已删除自己的 image / pdf / 下载兜底 viewer，也不再认领这些扩展名。</sub><br/><div align="center"><img width="420" alt="图片内联预览" src="https://github.com/user-attachments/assets/f9a58c30-5b7a-48b5-9e22-37d7e071f593" /></div> |
| **💻 终端（由 DSH 内置提供）**<br/><sub>右侧栏终端由 DSH 自己的 `ui-sidebar-terminal` 提供：shell 选择、双击重命名、断线重连、刷新后恢复、主题与对比度跟随。插件不再自带终端实现。<br/><br/>⚠️ **模型侧提示**：插件原来自带的 8 个 `terminal_*` 工具（默认关）是模型唯一的**跨调用持久**终端；上游等价物 `@deepseek-ai/dsh-tool-terminal` 未被任何内置 bundle 默认挂载，若你需要该能力，请在 profile 的 `cordis.patch.yml` 里自行插入一行 `tool-terminal`。</sub><br/><div align="center"><img width="420" alt="真实终端" src="https://github.com/user-attachments/assets/0dad6ad3-ff3f-4b5a-86d2-f832ce65323e" /></div> | **🌿 文件变动：Git 视角 + 本轮文件**<br/><sub>双视角合一：**Git 视角**保留完整源代码管理（暂存 / 取消暂存 / 提交（`Ctrl+Enter`）/ 还原、历史、worktree 与子仓库选择）；**本轮文件视角**实时折叠会话事件日志，记录模型读 / 写 / 编辑的每个文件（按文件分组、按类型筛选、操作数角标）。点击任意改动在底部**可拖拽预览面板**查看统一 diff——删红 / 增绿 / 改蓝配对 + 行内字符级高亮 + 语法着色 + 上下文折叠——也可一键展开为 VSCode 式独立 diff tab（同一渲染栈）。两个视角共用 36px 头（宿主 SegmentedControl 切换）、28px 行、单一空态与吸底提交条；**Git 视角按目录层级（树）展示变更**——单子目录链压缩成一行、目录行可折叠并带下级变更数、文件行带状态字母与文件图标；git 状态与文件树共享同一份快照，暂存/提交后文件树着色同步刷新。</sub><br/><div align="center"><img width="420" alt="文件变动" src="https://github.com/user-attachments/assets/e7fc1220-305f-4bca-8583-e77ab4f4fa78" /></div> |
| **🌐 外链接管（浏览器视图由 DSH 提供）**<br/><sub>网页 tab 是 DSH 自己的 `ui-sidebar-browser`（多开 / 后退前进刷新 / 地址栏 / 沙箱 iframe），**0.1.7 起只在 desktop profile 挂载**——Web profile 里没有这个 kind。插件保留宿主没有的那一半：**只认领有 tab 类型通过 `urlTarget` 明确声明的链接**（Ctrl/Cmd 点击始终放行），**其余一律放行给宿主**（正文链接的去向由宿主的用户设置 `linkOpening` 决定）；按协议分流的三个外链接管设置项已删除，认领成功但目标类型此刻不可用时兜底到 `window.open`。</sub><br/><div align="center"><img width="420" alt="内嵌浏览器" src="https://github.com/user-attachments/assets/9bc6b65a-64fc-4942-a685-76e391e55606" /></div> | **🧩 任务页：子代理拓扑 + 后台任务**<br/><sub>子代理树实时拓扑（运行状态、批量实时预览）+ 后台任务清单（退出码 / 实时输出 / 强制终止）；新子代理 / 新任务可自动激活任务页，宽屏同时展开侧边栏，窄屏不强制展开全屏抽屉（可关）。</sub><br/><div align="center"><img width="420" alt="任务页：子代理拓扑" src="https://github.com/user-attachments/assets/dcd8ed2f-59fa-405b-937b-2d250f5034dd" /></div> |
| **💬 侧边对话(beta)**<br/><sub>Codex 风格侧边线程：**每个对话一个独立 Tab**；线程继承主会话完整上下文（含进行中回合，以 interrupted 诚实冻结）独立运行，不污染主会话；可持续追问、重启冷恢复；一键「保存为新会话」提升为顶层会话。</sub><br/><div align="center"><img width="420" alt="侧边对话(beta)" src="https://github.com/user-attachments/assets/3a338c36-f5de-4000-95f3-4b1cd04f60fc" /></div> | **🖥️ DSH 原生右侧栏 + 插件底部工作台**<br/><sub>右列是 DSH 自己的右侧栏：插件把每个 tab 类型注册成原生 tab（含接管内置「文件」页），聊天里的文件点击直接落到原生栏——**宿主自己的文档预览已覆盖的格式由宿主渲染**，插件只认领 Markdown / HTML / 可编辑代码；插件自有底部面板可与其同时展开，拖 Tab 到分栏边缘**拆分**、拖到中间**合并**，高度拖上缘调节；开合按钮在会话头右侧。</sub><br/><div align="center"><img width="420" alt="双工作台（右侧栏 + 底部面板）" src="https://github.com/user-attachments/assets/dfdb875e-a1a8-4d4b-8340-353736b1708f" /></div> |
| **⚙️ 声明式设置**<br/><sub>设置页「侧边卡片」分区：每个 tab / 预览器一张小卡片，独立开关（高亮启用态 + 品牌开关滑块）；二级设置经卡片底部「功能设置」条弹窗（开关 / 文本 / 数字 / 下拉）；插件自有设置持久化在 `pluginSettings`，整份偏好则写在 profile 里本插件的**挂载行**上（DSH 0.1.7 起设置按 Loader entry id 寻址）。</sub><br/><div align="center"><img width="420" alt="声明式设置：侧边卡片" src="https://github.com/user-attachments/assets/0800ca64-621e-48da-b7df-aecfddc3ec29" /></div> | **📱 移动端**<br/><sub>窄屏（<768px）自动切换为全宽抽屉：底栏 tab 一次性并入右侧栏，触屏拖拽可调。</sub><br/><div align="center"><img width="360" alt="移动端全宽抽屉" src="https://github.com/user-attachments/assets/a82ba78a-f4cf-4d85-80e8-050a05beb144" /></div> |

## 💬 社区

推荐添加QQ群(577011007)

<div align="center">
  <img width="220" alt="微信群二维码" src="https://github.com/user-attachments/assets/5d727d52-7fff-4526-8b36-fb7203fb1dce" />
  <img width="220" alt="QQ群二维码" src="https://github.com/user-attachments/assets/9be34629-26ef-4537-aad4-1393c147f81c" />
</div>


## 🆕 最近更新

**支持的 DSH 版本**：<a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="支持的 DSH 版本（v0.24.0）：0.2.0-rc.1+" src="https://img.shields.io/badge/DSH-0.2.0--rc.1%2B-4d6bfe" /></a> · 完整发布历史见 [Releases](https://github.com/omdsh-dev/DSH-better-sidebar/releases)

### v0.24.1

> 🐞 **修复版**：修掉两处会让文件树「一操作就整体刷新」的缺陷——① 原生承载面在**每次会话状态写入**时都会重建 `files` 接管项的 slot 注册，宿主因此换掉 slot entry、把整个 tab body 卸载重挂（展开/收起、切 tab、拖底部工作台都会触发）→ 文件树丢失层缓存、滚动位置与目录 watcher 并重列整棵可见树；② 目录实时刷新的重列**先把该层缓存删掉**再请求，导致行被「Loading…」占位替换后重建（构建/格式化/模型跑 bash 时整层闪空）。现在展开只请求被展开那一层、tab body 不再重建、变更只增量更新行。

### v0.23.0

> 🧭 **开发线版本（从未发布到 npm，内容随 v0.24.1 一并发布）**：文件页与文件变动页的整体 UI/UX 重构。文件页新增 **Ctrl/Cmd 与 Shift 多选**、批量条、**Git 变更着色**、**新建文件夹**、拖拽上传重做，**多选可右键「压缩并下载」**（宿主侧带进度的打包任务）；「打开方式」改为宿主本机关联应用与插件自研目标**双源并存**（可用设置 `openWithPluginTargets` 强制并存），右键菜单收敛层级；文件变动页**重构为层级树**（Git 视角 + Agent 视角，目录可暂存）。性能：`fs.tree` 实测 **22.8ms → 3.8ms**（10k 条目），新增批量路由 `fs.trees`（挂载/刷新从 N+1 请求变 1 个），菜单打开不再重列目录。⚠️ **行为变更（安全相关）**：**删除工作区路径检测**，插件 fs 路由可读写宿主用户能访问的任意路径（仅受 OS 权限约束）。详见 [CHANGELOG](./CHANGELOG.md#v0230)。

### v0.24.0

> 📦 **支持线前移**：仅适配 DSH **0.2.0-rc.1+**（peer 下限 `^0.2.0-rc.1`，CI 钉 `@deepseek-ai/dsh@0.2.0-rc.1`）。**0.1.7 线（含 npm `latest` 的 0.1.7-rc.2）请固定 v0.22.1（0.1.7 线最后发布的版本）**：caret 范围跨 minor 不成立，`^0.1.7-rc.1` 在 0.2.0 宿主上会被启动兼容性预检整行禁用（实测 `semver.satisfies('0.2.0-rc.1','^0.1.7-rc.1',{includePrerelease:true}) === false`）。

- 📦 **基线整体抬到 `0.2.0-rc.1`**：14 条 DSH peer 与 27 个 `@deepseek-ai/*` devDependencies 同步；`dsh.plugin.json` 的 `engines.dsh` 随之前移。
- 🔍 **实测确认是纯增量**：本插件用到的 19 个宿主包里**零个值导出被删除**；类型面只有 `ui-primitives`（`DisclosureRow` / `TextShimmer` / `Tooltip` 新增可选 prop、overlay 顶部内距）、`dsh-session`（新增 `ToolCallRecovery`）与 `dsh-api-remotes`（新增 product-analytics remote）变化；会话格式仍 v4、`SUBAGENT_DESCRIPTOR_VERSION` 仍 3、`dsh/lib/bin.js` 与 `dsh-client-modules` 运行时逐字未变。因此**没有为 0.1.7 保留任何兼容分支**。
- 🧪 **挂载 lane 与 CI 钉版同步到 `0.2.0-rc.1`**；`tests/market-manifest.spec.ts` 的 peer 形状规则改为钉当前基线 tuple，并记下「caret 跨 minor 必失效」这条教训。
- ⚠️ **生态连带**：`@huanlin/dsh-plugin-better-locale`（可选集成，非本插件依赖面）的 peer 钉在 `^0.1.x` 线上，在 0.2.0 上无法加载，其 5 条 unmet peer 是本次 `pnpm peers check` 唯一残留（上游未适配，与本插件的 14 条 peer 无关）。
**支持的 DSH 版本**：<a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="支持的 DSH 版本（v0.22.1）：0.1.7-rc.1+" src="https://img.shields.io/badge/DSH-0.1.7--rc.1%2B-4d6bfe" /></a> · 完整发布历史见 [Releases](https://github.com/omdsh-dev/DSH-better-sidebar/releases)

### v0.22.1

> 📦 **正式版**（npm `latest`）：支持线**不变**——仍仅支持 **DSH 0.1.7-rc.1+**（peer 下限 `^0.1.7-rc.1`，CI 钉 `@deepseek-ai/dsh@0.1.7-rc.1`），0.21.1 / 0.22.0 的用户直接升级即可。修掉两个**真机可复现、单测却全绿**的缺陷；**DSH 0.1.6-alpha.2 及更早请继续固定 v0.19.1**。

- 🐛 **`files` 接管被孤儿化 → 报错刷屏 + 文件树空态**（社区 #770 / #771，官方桌面壳日志实证）：客户端条目替换（插件市场更新 / Plugins 页禁用→启用 / HMR 重打）时，`sync()` 的清理循环会把**不属于描述符**的 `files` 接管释放掉、又在同一轮里重建——而重建发生在**已经 inactive** 的插件上下文上：`tabs.register` 建在宿主上下文上照样取走了 id，紧随的 `ctx.slots.inject` 却抛 `cannot create effect on inactive context`，于是 disposer 丢失、该 id 在**整个页面生命周期内不可再注册**（表现就是 `native register files error: … already registered` 刷屏 + 文件树落到宿主空态，只有刷新页面才恢复）。现在清理循环**跳过 `FILES_KIND`**（接管的寿命只由编辑器类型开关与 seat disposer 决定），并且**任何在宿主取走 id 之后失败的注册都会回滚释放**（含已建好的槽位），失败只留一个「下次通知可重试」的状态。修复取自社区 PR #777（@yanzhaohui1999）。
- 🖥️ **macOS 桌面版窗口拖拽 / 双击标题栏缩放失效**（#772）：插件宿主是直挂 `body` 的子元素，宿主的 `html[data-platform=darwin] body > :not(#root) { -webkit-app-region: no-drag }` 命中它，而 app-region **无视 `pointer-events`**——铺满视口的面板层把下面每条拖拽带一起抵消（拖第一次还行、之后全失效）。现在 `[data-dsh-better-sidebar]` / `[data-dsh-panel-host]` / 放大视图 `.mermaidModal` 都用中性值 `initial !important` 退出计算，层内的面板与控件保持 `no-drag`（点击不被吞）；合并社区 PR #773 并补齐放大视图这最后一个铺满视口的 body 直挂层。
- ✅ **守住它们**：新增单元用例把「接管不得被通知拆建」「注册失败必须回滚已占用 id 与已建槽位」钉在注册表**事件日志**上（未修复代码上 4/4 红），并新增**部署级回归门** `tests/e2e/native-reload.e2e.ts`（在 npm 0.22.0 上连续 3 次运行全红、修复版连续 3 次全绿（1 个用例重复跑三次））；拖拽契约由单元用例 + 挂载 lane 的**真实级联探针**（按宿主规则读计算值）守护。验证：`pnpm test` 122 files / 1293 passed / 9 skipped，`pnpm test:mount` 与 `test:mount:aggregate` 绿。事故记录见 [docs/plans/2026-09-28-native-files-takeover-reload-leak.md](./docs/plans/2026-09-28-native-files-takeover-reload-leak.md)。

### v0.22.0

> 📦 **正式版**（npm `latest`）：支持线**不变**——仍仅支持 **DSH 0.1.7-rc.1+**（peer 下限 `^0.1.7-rc.1`，CI 钉 `@deepseek-ai/dsh@0.1.7-rc.1`），0.21.1 的用户直接升级即可。**DSH 0.1.6-alpha.2 及更早请继续固定 v0.19.1**。

- 🧩 **任务管理页重做成工作流图**（主显示模式）：会话树渲染为分层节点 + 贝塞尔连线——拖拽平移、滚轮缩放到光标、内容包围盒居中适配、右下角控制条（图/树切换 + 折叠开关 + 缩放 + 适配）；**经典缩进树保留**（键盘可导航），两种模式共享同一个视图模型，折叠状态与团队富化不会视觉漂移。
- 🃏 **双段式节点卡**：上段是类型徽章（主代理 / 子代理 / 成员 / 工作流 / 已完成聚合）+ 相位徽标 + 名称 + 元信息；下段小条是状态点 + 状态词 + **主 Agent 同款合并活动行**（并发工具按类别归并 + 计数 + 在跑那条的细节，措辞取宿主 `chat` 词条）+ 已完成节点的折叠按钮；运行中小条从左到右**完整扫过**（`prefers-reduced-motion` 下关闭）。8px 圆角、层级只用上段极淡底色表达、当前会话加粗 accent 描边。
- 🔀 **工作流 run 入图**：从 `tool-workflow/*` 事件折叠出 run（与官方面板同一批），run 挂在发起代理下、成员 agent 重挂到 run 下并按相位分框、同色相位徽标；catalog 里没有的成员用 run 数据合成占位节点，跑完的 run 仍能看到成员。
- 🗂 **折叠分两组、各自说清是什么**：`✓ N 已完成`（含出错，失败单独报 `出错 N`）与 `N 个待命`（跑完一轮、随时可被叫起来的 teammate）是**两行**；手动折叠按钮永远有效，自动聚合只在待命成员 ≥3 时收空闲成员；聚合卡名字行写「前两个名字 + `+N`」，点聚合全部展开。
- 🪟 **两个常驻浮动窗**（抽出可复用的 `FloatingWindow`）：后台任务输出与共享任务详情/编辑——可拖拽、可四边拉伸、内容区自滚动，只靠关闭按钮或 Escape 结束（外部点击 / 失焦 / 锚点离屏都不关）；任务窗把余量交给描述区，拉大是给内容更多空间而不是留白，动作行固定在底部。
- 👥 **Agent Teams 任务板（实验层）**：成员富化到对应节点、常驻任务条列出成员与共享任务；状态机跟随宿主（待办 → 认领 → 进行中 → 完成 → 重开）+ 改派 / 编辑 / 两击删除，CAS 过期修订单独提示；成员活动由 `subagents.live` 的 running 叠加。
- 🔄 **后台任务改读宿主客户端 `ctx.jobs`**（推送 roster + 非消费输出流 + kill）：删掉自建的 `jobs.list` / `jobs.output` / `jobs.kill` 三条路由与事件回放镜像，彻底不碰模型 `job_output` 游标；输出在常驻浮动窗里流式显示并尾随，代理数 ≥8 时抽屉自动折叠。
- 🛠 **DSH 0.1.7 数据面重写**：上游删掉了 `agentTeams.remoteView` 三个 Remote 方法 → 团队改为读 Lead Session 的 **`agentTeam` Session projection**（推送式，删掉 `teams.view` 路由与 5 秒轮询）；写路径两条路由保留，拒绝从「返回联合」变为「抛 `TeamError`」，过期修订映射 409 `team-conflict`。**修掉的真实故障**：0.1.7 上团队条从来不渲染（路由报 `remoteView is not a function`，页面静默无提示）。
- 🐛 **真机抓到、单测全绿的四个缺陷**：逐节点折叠按钮点了没反应（被自动折叠的守卫卡住）；「待命」卡片从不画折叠按钮；认领后标签错显「阻塞」；队列任务上「完成」必失败（需先认领）。
- 🎨 **窄屏与手机设置**：按原生右侧栏窄宽重新定档卡片与行距；设置页新增**手机**分组——窄屏（≤768px）不自动弹出新任务页、任务页默认树状图。

> 📜 **更早版本**：完整发布历史见 [CHANGELOG.md](./CHANGELOG.md)（v0.21.1 → v0.12.3）与 [GitHub Releases](https://github.com/omdsh-dev/DSH-better-sidebar/releases)。

## ⌨️ 快捷键

| 操作 | 按键 |
|---|---|
| 保存编辑 | `Ctrl/Cmd + S` |
| Git 提交 | `Ctrl + Enter` |
| 关闭 Tab | 鼠标中键 |
| Tab 右键菜单 | 关闭 / 关闭其他页签 / 关闭左侧页签 / 关闭右侧页签（当前标签组） |
| 拆分/合并分栏 | 拖 Tab 到分栏边缘 / 中间 |
| 引用文件到输入框 | 悬浮行尾 `@文件` 按钮 |
| 复制文件路径 | 右键行 → 复制相对/绝对地址 |

## 🔌 服务化扩展

从 v0.4.0 起暴露 `ctx.betterSidebar` 服务，其他插件可注册侧边栏页面与文件预览器（内置 5 tab + 3 viewer 亦通过同一服务注册）。v0.12.1 补齐基座能力（完整类型导出、能力探测、状态订阅、tab 角标、生命周期回调、定向打开、插件自有设置等）。v0.19.0 起新增文件图标注册：`registerFileIcon` 按扩展名（或保留的 `'folder'` / `'folder-open'` 目录扩展名、`exts: []` 全局默认）替换文件树与文件 tab 的图标，彩色 ReactNode 亦可——内置消费、注册即生效，无需自己接线。

完整接入文档（全字段、匹配算法、HMR 陷阱、声明式设置、版本探测、原生栏承载面与皮肤契约）：**[`docs/external-plugin-guide.md`](./docs/external-plugin-guide.md)**；仓库开发规则（硬约束 / CI / 发版）见 [`AGENTS.md`](./AGENTS.md)。

### ➕ 添加插件（推荐插件目录）

设置页「侧边卡片」两个网格末尾的**虚线卡片**分别打开 Tab / 预览插件弹窗：声明扩展点、「**在 GitHub 上浏览更多插件**」按钮（[GitHub topic `dsh-better-sidebar`](https://github.com/topics/dsh-better-sidebar)）、推荐插件目录（名字 / 仓库 / 简介 / 安装脚本），每个条目「**跳转**」直达仓库、「**复制**」把安装命令写入剪贴板。

**收录新插件**：向 [`src/client/plugins-tabs.ts`](./src/client/plugins-tabs.ts)（Tab 注册）或 [`src/client/plugins-viewers.ts`](./src/client/plugins-viewers.ts)（文件预览注册）追加一条 `PluginEntry`，并把仓库打上 `dsh-better-sidebar` topic；数据完整性由 `tests/plugin-list.spec.ts` 守护。

## 🛠️ 开发与构建

```sh
pnpm install      # @deepseek-ai/* devDependencies 已发布（基线 0.2.0-rc.1，走 npm `next` 通道），直接解析、无需令牌
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint .（flat config：js + typescript-eslint + react-hooks recommended）
pnpm build        # → lib/index.js + lib/invariant.js + lib/client.js + lib/client-registry.js + lib/types
pnpm test         # vitest（含 manifest 一致性守卫，需先 build）
pnpm watch        # tsdown --watch
```

**Make 薄封装**（`make help` 查看全部目标；package.json 仍是唯一事实源）：

```sh
make check          # 聚合校验门禁：typecheck → build → test → check:consumer-types（对齐 CI）
make mount          # 真机挂载冒烟：build + pack → 安装 Chromium → pnpm test:mount
make clean          # 清理 lib/、*.tgz、playwright-report/、test-results/
```

`pnpm check:consumer-types`：对外类型声明面守卫——以浏览器-only 消费者（无 `@types/node`、`skipLibCheck: false`）的视角对构建出的 `lib/types` 做类型检查，需先 `pnpm build`。

**架构**：单 npm 包、host/client 双半结构——host（`src/index.ts`）：`/sidebar/api/*` JSON API、`/sidebar/file` 媒体路由、`/sidebar/html` 预览路由、`/sidebar/upload` 上传路由，以及两条 WebSocket（`/sidebar/ws/agent-opens` 模型打开推送、`/sidebar/ws/fs-watch` 文件树目录 watch；fs / git / 预览全部会话级 + 信任围栏）；client（`src/client/index.tsx`）：portal 侧边栏 + 各视图 + 链接接管；状态按会话持久化 localStorage。插件按 DSH 官方规范组织（无 default 导出、双 client bundle），运行期不依赖 npm / checkout（`@deepseek-ai/*` 由 web profile 提供）。

## 🔐 安全

- 路由受 Host 头信任围栏保护（与 `/api` 一致）；`fs.write` 原子写入；git 只调 CLI、绝不设置身份
- ⚠️ **v0.23.0 起文件系统路由不再做工作区包含检查**：`fs.tree` / `fs.trees` / `fs.read` / `fs.write` / `fs.rename` / `fs.remove` / `fs.mkdir` / 媒体 / HTML 预览 / `/sidebar/upload` / `archive.build` 能读写**宿主用户可访问的任意路径**（只受 OS 权限约束，`workspaceFence` 开关与 403 分支已删除）——调用方不能再把这些路由当作被围栏保护的接口
- HTML 预览的内容在**不透明源沙箱 iframe** 中渲染（无 `allow-same-origin`/`allow-top-navigation`、`no-referrer`、权限策略全禁）；`/sidebar/html` 路由带 CSP `sandbox` + 大小/路径边界
- 设置页可按功能关闭 HTML 预览的沙箱（`htmlViewerNoSandbox` / `htmlViewerDefaultUnsafe`，默认关闭，带警告文案）——关闭后内容与界面同源，仅建议对完全可信内容使用。**网页 tab 的沙箱不再是插件的面**：浏览器视图由宿主提供（desktop profile），其沙箱与导航策略见 DSH 侧文档

## ⚠️ 已知限制

- Git 无 push/pull/fetch；Markdown 预览提供手动刷新按钮，刷新未保存编辑前会确认是否丢弃草稿；文件树只对**已展开**的目录做 watch（折叠的目录不订阅，也不做全工作区递归扫描）；工具行内文件打开按钮不可拦截
- **只读预览的格式由宿主决定**：表格 / PDF / 图片 / Office 走 DSH 自己的 `ui-sidebar-documentpreview`，插件只渲染 Markdown / HTML 与可编辑的文本代码；宿主的实现（渲染细节、缩放、刷新时机）随 DSH 版本走
- **浏览器视图只在 desktop profile 存在**：Web profile 没有宿主 `browser` kind，插件也不再自带浏览器 tab，因此网页 tab 只在 desktop profile 可用；登录态 / 第三方 Cookie / `X-Frame-Options` 等限制随宿主实现
- HTML 预览渲染的是已保存文件（不反映未保存草稿）
- 移动端（<768px）无底部面板：进入窄屏时其标签页一次性并入右侧栏（迁移后回桌面仍保留在右侧栏），桌面端的底部面板只在宽视口下可用。未选中会话时，点按弱化开关会显示选择会话提示；选中会话后开关打开全宽抽屉

## 🖥️ 平台支持

Windows / Linux / macOS 三平台适配（macOS 日常验证；其余经单元测试覆盖）。插件不再包含原生依赖（终端与 `node-pty` 已整体交还 DSH 自身），构建只需 Node + pnpm，无需编译工具链。

## 🌐 插件生态

`ctx.betterSidebar` 服务向所有插件开放两个扩展点：**`registerTab`（注册侧边栏页面）** 与 **`registerFileViewer`（注册文件预览器）**。内置的 5 tab + 3 viewer 与第三方插件走同一套 API，能力完全对等。

```ts
import type {} from 'dsh-better-sidebar'  // 触发 ctx.betterSidebar 类型合并
export const inject = ['betterSidebar']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'my-plugin:db', title: 'Database', component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  }))
  ctx.effect(() => ctx.betterSidebar.registerFileViewer({
    id: 'my-plugin:csv', exts: ['csv'], fetchStrategy: 'custom',
    load: async (path, scope) => parseCsv(await fetchText(scope, path)),
    component: ({ customData }) => <CsvGrid rows={customData} />,
  }))
}
```

GitHub topic [`dsh-better-sidebar`](https://github.com/topics/dsh-better-sidebar) 下已有 **28+ 生态插件**（持续增长中）：

<div align="center">
  <a href="https://github.com/user-attachments/assets/d4385b7e-aab4-425d-a5c4-2da5da81a34e"><img width="66%" alt="设置页「添加插件」弹窗：推荐插件目录 + 一键复制安装命令" src="https://github.com/user-attachments/assets/d4385b7e-aab4-425d-a5c4-2da5da81a34e" /></a><br />
  <i>设置页「侧边卡片」内置「添加插件」弹窗：推荐目录 + 一键复制安装命令 + 直达 GitHub topic</i>
</div>

### 📑 Tab 插件（注册侧边栏页面）

<details>
<summary><b>26 个插件（点击展开）</b></summary>
<summary><b>25 个插件（点击展开）</b></summary>

| 插件 | ⭐ | 简介 |
|---|---|---|
| [ChenRuoT/dsh-sidebar-qa](https://github.com/ChenRuoT/dsh-sidebar-qa) | <img alt="stars" src="https://img.shields.io/github/stars/ChenRuoT/dsh-sidebar-qa?style=flat&color=4d6bfe" /> | 划选追问侧边页：类 Codex 侧边提问 / Claude Code `/btw` |
| [fuhefei/dsh-sentinel](https://github.com/fuhefei/dsh-sentinel) | <img alt="stars" src="https://img.shields.io/github/stars/fuhefei/dsh-sentinel?style=flat&color=4d6bfe" /> | 条件驱动唤醒系统：文件 / 命令 / HTTP / 进程 / Webhook 监视，到点唤醒 agent；dock + 侧栏分支 + 全局仪表盘 |
| [Fisfzy/ego-browser](https://github.com/Fisfzy/ego-browser) | <img alt="stars" src="https://img.shields.io/github/stars/Fisfzy/ego-browser?style=flat&color=4d6bfe" /> | Agent 浏览器：i18n 感知的本机浏览器 Tab（`@dsh-external/ego-browser`，装了 better-sidebar 自动注册侧边栏页，未装回退浮动浮窗观察） |
| [jiuge2467/dsh-studio](https://github.com/jiuge2467/dsh-studio) | <img alt="stars" src="https://img.shields.io/github/stars/jiuge2467/dsh-studio?style=flat&color=4d6bfe" /> | 全栈增强工作台：多源 MCP 可视化调试中枢、视觉思考引擎 |
| [Iwctwbh/dsh-flowglass](https://github.com/Iwctwbh/dsh-flowglass) | <img alt="stars" src="https://img.shields.io/github/stars/Iwctwbh/dsh-flowglass?style=flat&color=4d6bfe" /> | 流镜 Flowglass：会话流程图实时可视化（消息 / 工具组 / 子代理分支） |
| [FeatherHunter/dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck) | <img alt="stars" src="https://img.shields.io/github/stars/FeatherHunter/dsh-mattpocock-skills-deck?style=flat&color=4d6bfe" /> | mattpocock/skills 游戏化任务系统：地图拨迷雾、任务栏推进 |
| [GULI-lab/DSH-element-source](https://github.com/GULI-lab/DSH-element-source) | <img alt="stars" src="https://img.shields.io/github/stars/GULI-lab/DSH-element-source?style=flat&color=4d6bfe" /> | 点击页面任意 UI 元素直达 Vue / React / Svelte / Angular 源码并送入会话 |
| [Lzh3070/dsh-file-review-tab](https://github.com/Lzh3070/dsh-file-review-tab) | <img alt="stars" src="https://img.shields.io/github/stars/Lzh3070/dsh-file-review-tab?style=flat&color=4d6bfe" /> | 文件改动审查页：行级红绿 diff + 撤销 + chat 行深链 |
| [yq04/dsh-git-remotes](https://github.com/yq04/dsh-git-remotes) | <img alt="stars" src="https://img.shields.io/github/stars/yq04/dsh-git-remotes?style=flat&color=4d6bfe" /> | Git 远程页：分支 / 上游 / ahead-behind，fetch 可 prune、ff-only pull、确认后 push |
| [ztyhehe/dsh-better-sidebar-svn](https://github.com/ztyhehe/dsh-better-sidebar-svn) | <img alt="stars" src="https://img.shields.io/github/stars/ztyhehe/dsh-better-sidebar-svn?style=flat&color=4d6bfe" /> | SVN 源码管理页：status / diff / log / commit / update / revert / 冲突解决，与内置 Git 面板对称 |
| [Melody-max114/dsh-excel-panel](https://github.com/Melody-max114/dsh-excel-panel) | <img alt="stars" src="https://img.shields.io/github/stars/Melody-max114/dsh-excel-panel?style=flat&color=4d6bfe" /> | Excel 编辑页：xlsx 预览 / 编辑、公式实时计算、合并单元格、保存回原文件 |
| [v587d/dsh-anysearch-refs](https://github.com/v587d/dsh-anysearch-refs) | <img alt="stars" src="https://img.shields.io/github/stars/v587d/dsh-anysearch-refs?style=flat&color=4d6bfe" /> | AnySearch 搜索结果引用卡片：搜索词、来源摘要、关键词高亮 |
| [Lukeknow0/dsh-markdown-link-preview](https://github.com/Lukeknow0/dsh-markdown-link-preview) | <img alt="stars" src="https://img.shields.io/github/stars/Lukeknow0/dsh-markdown-link-preview?style=flat&color=4d6bfe" /> | Markdown 产物链接预览：点击聊天中的同源 `.md` 输出文件，直接在侧边栏阅读，不再唤起外部 App |
| [mlosun/dsh-docs-panel](https://github.com/mlosun/dsh-docs-panel) | <img alt="stars" src="https://img.shields.io/github/stars/mlosun/dsh-docs-panel?style=flat&color=4d6bfe" /> | 全局文档面板：随身 Markdown 笔记，任何工作区随时可读 |
| [tylina/dsh-tylina](https://github.com/tylina/dsh-tylina) | <img alt="stars" src="https://img.shields.io/github/stars/tylina/dsh-tylina?style=flat&color=4d6bfe" /> | Typst 文档编辑工具：与当前会话共用工作区，WYSIWYG 编辑排版 Typst 文档，可用于编写和排版论文、报告、试卷、简历、图表、海报、乐谱和 PPTX 格式导出的 Slides |
| [lnyuqian/dsh-skill-sidebar](https://github.com/lnyuqian/dsh-skill-sidebar) | <img alt="stars" src="https://img.shields.io/github/stars/lnyuqian/dsh-skill-sidebar?style=flat&color=4d6bfe" /> | 技能面板：扫描本机技能目录，4-6 字功能短语 + 一键复制调用 + 置顶 |
| [g-yixuan/dsh-sidenote](https://github.com/g-yixuan/dsh-sidenote) | <img alt="stars" src="https://img.shields.io/github/stars/g-yixuan/dsh-sidenote?style=flat&color=4d6bfe" /> | Codex 风格侧边对话 + 划选引用注释（轻量消费插件） |
| [OMSociety/dsh-ssh-tunnel](https://github.com/OMSociety/dsh-ssh-tunnel) | <img alt="stars" src="https://img.shields.io/github/stars/OMSociety/dsh-ssh-tunnel?style=flat&color=4d6bfe" /> | 多主机 SSH 隧道 + SSH 管理器页 |
| [OMSociety/dsh-git-forge](https://github.com/OMSociety/dsh-git-forge) | <img alt="stars" src="https://img.shields.io/github/stars/OMSociety/dsh-git-forge?style=flat&color=4d6bfe" /> | GitHub / Gitea 账号、项目授权与推送策略 |
| [YesSanSan/dsh-conversation-outline](https://github.com/YesSanSan/dsh-conversation-outline) | <img alt="stars" src="https://img.shields.io/github/stars/YesSanSan/dsh-conversation-outline?style=flat&color=4d6bfe" /> | 对话大纲页：按轮次结构化展示、一键跳转、LLM 一句话标题 |
| [Wulabalabo/dsh-sidebar-Explorer-Plus](https://github.com/Wulabalabo/dsh-sidebar-Explorer-Plus) | <img alt="stars" src="https://img.shields.io/github/stars/Wulabalabo/dsh-sidebar-Explorer-Plus?style=flat&color=4d6bfe" /> | 文件管理页：上传 / 移动 / 删除 / 重命名 / 新建文件夹（补全写操作） |
| [yq04/dsh-turn-review](https://github.com/yq04/dsh-turn-review) | <img alt="stars" src="https://img.shields.io/github/stars/yq04/dsh-turn-review?style=flat&color=4d6bfe" /> | 本轮审查：逐回合审查 agent 改动 |
| [Ghz114514/dsh-refpics](https://github.com/Ghz114514/dsh-refpics) | <img alt="stars" src="https://img.shields.io/github/stars/Ghz114514/dsh-refpics?style=flat&color=4d6bfe" /> | Pinterest 风格参考图搜索：瀑布流、侧栏画板、下载与 Eagle 收藏 |
| [yzlin499/dsh-yzlin499-easy-plugins](https://github.com/yzlin499/dsh-yzlin499-easy-plugins) | <img alt="stars" src="https://img.shields.io/github/stars/yzlin499/dsh-yzlin499-easy-plugins?style=flat&color=4d6bfe" /> | 实用小工具集（毛坯房 DSH 友好） |
| [dong-victor/dsh-better-sidebar-starter](https://github.com/dong-victor/dsh-better-sidebar-starter) | <img alt="stars" src="https://img.shields.io/github/stars/dong-victor/dsh-better-sidebar-starter?style=flat&color=4d6bfe" /> | 运行配置页：IDEA 式 Run/Debug 配置（npm / springboot / python / custom）——一键启动、历史保存、WebSocket 实时日志（ANSI 彩色）、多实例并行、进程树跨平台杀死 |
| [baosfeng/my-dsh-plugins](https://github.com/baosfeng/my-dsh-plugins) | <img alt="stars" src="https://img.shields.io/github/stars/baosfeng/my-dsh-plugins?style=flat&color=4d6bfe" /> | 个人多插件合集（`dsh-file-activity`）：侧边栏文件活动页——记录文件读取 / 新增 / 修改历史与统计，按文件夹平铺，点击用原生预览打开 |
| [Hoemr/dsh-better-overleaf](https://github.com/Hoemr/dsh-better-overleaf) | <img alt="stars" src="https://img.shields.io/github/stars/Hoemr/dsh-better-overleaf?style=flat&color=4d6bfe" /> | Overleaf 标签页：直连 CDP 浏览器登录（支持第三方 Chromium）、项目切换、工作区下 overleaf/ 目录本地 git 镜像与双向同步 |
| [Andor-Z/dsh-turn-outline](https://github.com/Andor-Z/dsh-turn-outline) | <img alt="stars" src="https://img.shields.io/github/stars/Andor-Z/dsh-turn-outline?style=flat&color=4d6bfe" /> | 轮次轨迹页：按用户轮次折叠会话（输入 + 工具步骤 + 输出），点击任意步骤一键跳回对话原位；零 LLM、只读 |

</details>

### 🖼️ 预览插件（注册文件预览器）

<details>
<summary><b>3 个插件（点击展开）</b></summary>

| 插件 | ⭐ | 简介 |
|---|---|---|
| [HuanLinOTO/dsh-plugin-better-sidebar-plugin-office](https://github.com/HuanLinOTO/dsh-plugin-better-sidebar-plugin-office) | <img alt="stars" src="https://img.shields.io/github/stars/HuanLinOTO/dsh-plugin-better-sidebar-plugin-office?style=flat&color=4d6bfe" /> | Office 三件套预览（.docx / .xlsx / .pptx），独立 bundle 瘦身主体（官方推荐目录收录） |
| [zemul/dsh-video-preview](https://github.com/zemul/dsh-video-preview) | <img alt="stars" src="https://img.shields.io/github/stars/zemul/dsh-video-preview?style=flat&color=4d6bfe" /> | 视频内联预览：.mp4 / .webm / .mov / .mkv / .avi，自带 /video 路由支持 HTTP Range 拖进度条 |
| [dong-victor/dsh-better-sidebar-jupyter](https://github.com/dong-victor/dsh-better-sidebar-jupyter) | <img alt="stars" src="https://img.shields.io/github/stars/dong-victor/dsh-better-sidebar-jupyter?style=flat&color=4d6bfe" /> | `.ipynb` 可运行 Notebook 视图：懒启动 Python kernel、流式输出、保存回写 |

</details>

### 🧰 增强与工具

<details>
<summary><b>3 个插件（点击展开）</b></summary>

| 插件 | ⭐ | 简介 |
|---|---|---|
| [eg-bole/dsh-better-sidebar-icons](https://github.com/eg-bole/dsh-better-sidebar-icons) | <img alt="stars" src="https://img.shields.io/github/stars/eg-bole/dsh-better-sidebar-icons?style=flat&color=4d6bfe" /> | VSCode 风格文件 / 文件夹图标主题：文件树与编辑器 Tab 换上熟悉的开发环境图标（vscode-icons 移植，纯 DOM 覆盖零侵入，安装 / 卸载零残留） |
| [dong-victor/dsh-better-sidebar-terminal-plus](https://github.com/dong-victor/dsh-better-sidebar-terminal-plus) | <img alt="stars" src="https://img.shields.io/github/stars/dong-victor/dsh-better-sidebar-terminal-plus?style=flat&color=4d6bfe" /> | 终端增强：内嵌 Nerd Font 图标字体、修复 xterm 图标渲染、稳定终端 cwd |
| [Max-Null/dsh-sidebar-preview-select](https://github.com/Max-Null/dsh-sidebar-preview-select) | <img alt="stars" src="https://img.shields.io/github/stars/Max-Null/dsh-sidebar-preview-select?style=flat&color=4d6bfe" /> | 预览划选增强：侧边栏预览里划选文本 → 浮动「发送到会话」 |
| [Hoemr/dsh-quicklook](https://github.com/Hoemr/dsh-quicklook) | <img alt="stars" src="https://img.shields.io/github/stars/Hoemr/dsh-quicklook?style=flat&color=4d6bfe" /> | QuickLook 式空格预览：活动文件标签页按 Space 全尺寸查看图片 / PDF / 文本，Space 或 Esc 关闭 |

</details>

> 📣 **上架你的插件**：给仓库打上 `dsh-better-sidebar` topic 即出现在 [topic 页](https://github.com/topics/dsh-better-sidebar)；再向 [`src/client/plugins-tabs.ts`](./src/client/plugins-tabs.ts) / [`src/client/plugins-viewers.ts`](./src/client/plugins-viewers.ts) 提一条 `PluginEntry` PR，即可进入设置页内置推荐目录（数据完整性由 `tests/plugin-list.spec.ts` 守护）。

## 🤝 参与贡献

- **代码改动走 PR**：`feat/*` / `fix/*` 分支开发 → `gh pr create`；纯文档改动可直接推 main
- **收录生态插件**：给仓库打 `dsh-better-sidebar` topic + 向 [`src/client/plugins-tabs.ts`](./src/client/plugins-tabs.ts) / [`plugins-viewers.ts`](./src/client/plugins-viewers.ts) 提 PR
- **提交前自检**：`pnpm typecheck && pnpm build && pnpm test`（或 `make check` 一键聚合；CI 另有 npm 打包 → 真实挂载 → 无头渲染门禁 `pnpm test:mount`，及聚合双挂载回归 `pnpm test:mount:aggregate`）
- 仓库工作规范见 [`AGENTS.md`](./AGENTS.md)（含仓库硬约束与 CI 说明）

## 👥 贡献者

感谢每一位贡献者：

<a href="https://github.com/omdsh-dev/DSH-better-sidebar/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=omdsh-dev/DSH-better-sidebar" alt="贡献者" />
</a>

## 🔗 友情链接

- [dsh-tianshu-tui](https://github.com/huiliyi37/dsh-tianshu-tui)：DeepSeek Harness 交互式终端 UI 插件（渲染核心由自研 harness agent Tianshu-Tui 演进而来），在官方基础上增加 TDD 与证据门等工作流
- [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)：Claude Code 风格全屏交互终端插件——像素鲸鱼顶栏、实时工作状态行、思考流式展开、双击 Esc 回滚、上下文进度条 + TPS 仪表，npm 一键安装
- [dshfind 插件超市](https://dshfind.com/zh/plugins)：三方插件市场——GitHub topic `dsh-plugin` 下的公开仓库清单，每日同步 star、贡献者与增长数据
- [DeepSeek Harness Desktop Tauri](https://github.com/hairyf/deepseek-harness-desktop)：DeepSeek Harness 的 Tauri 桌面版——仅 5MB 安装包、零环境配置、预置插件开箱即用，支持 Windows / macOS / Linux 三平台
- [DeepSeek Harness Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)：为 DeepSeek Harness 生态打造的现代化桌面端——无需配置 Node.js 或执行命令即可启动和管理本地 Harness 服务；[官网](https://www.dshdesktop.cn)

---

<div align="center">
  <sub>MIT License · Built for the <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> ecosystem · 在 <a href="https://github.com/topics/dsh-better-sidebar">topic dsh-better-sidebar</a> 发现更多生态插件</sub>
</div>
