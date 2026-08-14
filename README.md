# dsh-better-sidebar

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">一个服务化的侧边栏框架，一套开箱即用的完整工作台</b><br /><br />
  <code>文件管理</code> <code>编辑预览</code> <code>内嵌浏览器</code> <code>真实终端</code> <code>Git 面板</code> <code>后台任务</code> <code>插件接入</code><br /><br />
  <b>右侧栏 + 底部面板双工作台</b>，并把 <code>ctx.betterSidebar</code> 服务开放给所有插件——<br />
  通过 <code>registerTab</code> / <code>registerFileViewer</code> 注册新的侧边栏页面与文件预览器。
</div>

<div align="center">
  🌏 <a href="./README.md"><b>中文</b></a> · <a href="./README_EN.md">English</a>
</div>

<div align="center">
  <video src="https://github.com/user-attachments/assets/23187822-047e-45cc-b480-fe997bd55b86" muted autoplay loop playsinline controls width="100%"></video>
  <img alt="dsh-better-sidebar 工作台截图" src="https://github.com/user-attachments/assets/dfdb875e-a1a8-4d4b-8340-353736b1708f" />
</div>

## ✨ 功能一览

- **🗂️ 文件工作台**：资源管理器（懒加载目录树）+ CodeMirror 编辑器；图片 / Markdown / HTML / PDF / Office 内联预览
- **🌐 内嵌浏览器**：多开网页 tab，后退 / 前进 / 刷新；内容运行在沙箱 iframe，外链默认在侧边栏打开
- **💻 真实终端**：xterm.js + node-pty 真实 shell，断线重连回放；可选为模型注入 `terminal_*` 工具
- **🌿 Git 面板**：真 diff + VSCode 式 diff tab、历史、右键暂存 / 提交 / 还原
- **🧩 后台任务页**：subagent 拓扑 + 后台任务（退出码 / 实时输出 / 强制终止）
- **🪟 双工作台**：右侧栏 + 底部面板；拖 Tab 拆分 / 合并分栏（可跨面板），移动端自动合并全宽抽屉
- **🔁 会话隔离**：布局 / Tab / 面板按会话持久化，陈旧状态自动净化
- **⚙️ 声明式设置**：设置页「侧边卡片」逐项独立开关，二级设置经齿轮弹窗
- **⚡ 按需加载**：启动只拉 ~325KB 核心，终端 / 编辑器等重依赖用到才按需拉取（[设计文档](docs/plans/2026-08-12-lazy-chunks-design.md)）
- **🌏 多语言**：界面文案跟随 DSH 语言（zh / en）实时切换

> 🔌 **核心理念**：服务优先——内置的 7 tab + 6 viewer 与第三方插件通过同一套 `ctx.betterSidebar` API 注册，能力完全对等；官方不再内置、可由生态提供的功能，交由生态插件实现。接入文档见下方「🔌 服务化」与 [外部插件接入指南](./docs/external-plugin-guide.md)。

## 🆕 最近更新

<small>v0.12.1</small>

| 功能 | 说明 | 截图 |
|---|---|---|
| 🔌 服务化基座 | 完整类型导出 + `version`/`features` 能力探测、状态订阅（`getSnapshot`/`subscribeState`）、tab 角标、`onOpen`/`onActivate`/`onClose` 生命周期回调、`updateTab`/`activateTab`/`openFile`、定向打开、`meta` 跨刷新持久化、插件自有设置（`pluginToggles`/`render`） | <a href="https://github.com/user-attachments/assets/946f7028-4967-461e-a750-d1b5056b62d0"><img width="800" alt="服务化基座截图" src="https://github.com/user-attachments/assets/946f7028-4967-461e-a750-d1b5056b62d0" /></a> |
| ➕ 添加插件 | 设置页「推荐插件目录」+ 一键复制安装命令；内置 Office 预览迁至推荐插件 | <a href="https://github.com/user-attachments/assets/d4385b7e-aab4-425d-a5c4-2da5da81a34e"><img width="800" alt="添加插件截图" src="https://github.com/user-attachments/assets/d4385b7e-aab4-425d-a5c4-2da5da81a34e" /></a> |
| 🖱️ 标签页滚轮 | 标签页栏支持鼠标滚轮横向滚动 | |
| 🐛 修复 | 远程访问 403（信任栅栏改用 `trustedHosts`）、侧边栏崩溃 [#31](https://github.com/omdsh-dev/DSH-better-sidebar/issues/31)、Windows 下 HTML 预览盘符路径 | |

## 🚀 安装

**前置**：已装好 DSH（`dsh web` 能正常运行），Node.js ≥ 20、pnpm ≥ 10。

**macOS / Linux**（Windows 装了 Git Bash 或 WSL 也可）：

```sh
curl -fsSL https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.sh | bash
```

**Windows（PowerShell 5.1+ / pwsh）**：

```powershell
irm https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.ps1 | iex
```

装完**硬刷新浏览器**（Cmd/Ctrl+Shift+R）即可看到侧边栏（DSH 对 client 改动热加载，无需重启；仅 host 半更新时需要重启）。

<details>
<summary><b>指定版本 / 装完自动重启（可选）</b></summary>

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.sh | bash -s 0.12.1 --restart

# Windows PowerShell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.ps1'))) -Version 0.12.1 -Restart
```

不确定的话，可先加 `--dry-run`（PowerShell 用 `-DryRun`）预览步骤再执行。

</details>

<details>
<summary><b>手动安装（逐步命令，想看清每一步）</b></summary>

与一键脚本等价。**第 ③ 步可重复执行；①② 只需做一次。**

**macOS / Linux（bash）**：

```sh
cd ~/.dsh/profiles/web

# ① 放行 node-pty / protobufjs 的构建脚本（pnpm 11 默认拦截；pnpm 10 可跳过）
pnpm approve-builds --all

# ② 放行「发布不足 24h」的新版本（装老版本可跳过；若已有该键，把下面那行并入其下即可）
cat >> pnpm-workspace.yaml <<'EOF'
minimumReleaseAgeExclude:
  - dsh-better-sidebar
EOF

# ③ 安装并自动挂载（不带 @版本 = npm 的 latest；固定版本写 dsh-better-sidebar@0.12.1）
npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-better-sidebar
```

**Windows（PowerShell）**：

```powershell
cd ~\.dsh\profiles\web

# ① 放行构建脚本
pnpm approve-builds --all

# ② 放行新版本（一次性；若已有该键，把 - dsh-better-sidebar 并入其下即可）
Add-Content -Path pnpm-workspace.yaml -Value "`nminimumReleaseAgeExclude:`n  - dsh-better-sidebar"

# ③ 安装并自动挂载
npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-better-sidebar
```

</details>

<details>
<summary><b>脚本内部做了什么（技术细节）</b></summary>

一键脚本自动完成 4 件事（全部幂等，可安全重复执行）：

1. 预写 `allowBuilds`（node-pty / protobufjs），规避 pnpm 11 的构建脚本拦截；
2. 预写 `minimumReleaseAgeExclude`，放行「发布不足 24 小时」的新版本；
3. 执行 `dsh plugin --profile web add dsh-better-sidebar`：登记依赖 → 识别包内 `dsh.bundle.patch` → 自动注册进 `dsh.profile.bundles` 挂载；
4. 清理旧版残留的手动挂载行，避免「双挂载」（页面出现两个侧边栏）。

`curl | bash` / `irm | iex` 会执行远程代码——脚本已随仓库开源（`scripts/install.sh` / `scripts/install.ps1`），可先下载审阅。插件以 npm 包 `dsh-better-sidebar@0.12.1` 发布，通过 `dsh.bundle.patch`（随包的 `cordis.patch.yml`）由官方 CLI 自动挂载，**不修改 DSH 源码**。

</details>

<details>
<summary><b>更新</b></summary>

```sh
dsh plugin --profile web add dsh-better-sidebar
```

或重跑一次一键脚本；也可把 `~/.dsh/profiles/web/package.json` 里的版本号改高后 `pnpm install`。改完**硬刷新浏览器**（Cmd/Ctrl+Shift+R）即可（client 改动无需重启 DSH）。

</details>

<details>
<summary><b>常见问题</b></summary>

| 现象 | 原因与解决 |
|---|---|
| 报 `Ignored build scripts` | pnpm 11 拦截构建脚本。跑 `pnpm approve-builds --all`（一键脚本已自动处理）。 |
| 报 `minimum release age` / 版本不足 24h | 装的版本发布不足 24 小时。等 24h 或重跑一次（pnpm 会自动补 `minimumReleaseAgeExclude`）；一键脚本已自动处理。 |
| 报「找不到 profile 目录」 | 先跑一次 `dsh web`，让它初始化 `~/.dsh/profiles/web`。 |
| 页面出现**两个侧边栏** | 双挂载：`~/.dsh/profiles/web/cordis.patch.yml` 还留着旧的手动挂载行，删掉那段 `- insert: ... better-sidebar ...`（一键脚本会自动清）。 |
| Windows 下终端无法使用 | `node-pty` 依赖预编译二进制；若当前 Node 版本没有对应产物，需装编译工具链（VS Build Tools）。主流 Node 版本一般已有预编译。 |
| Windows 没有 bash / curl | 直接用 PowerShell 一键命令；或安装 Git Bash / WSL 再跑 bash 命令。 |

</details>

<details>
<summary><b>从源码安装 / 开发（可选，替代 npm 方式）</b></summary>

调试本地改动或跟随开发分支时，把依赖指向本地克隆并自行构建：

```text
1. git clone https://github.com/omdsh-dev/DSH-better-sidebar.git ~/Code/DSH-better-sidebar
   cd ~/Code/DSH-better-sidebar && pnpm install && pnpm build
2. ~/.dsh/profiles/web/package.json 的 dependencies 写 "dsh-better-sidebar": "link:<克隆目录绝对路径>"
3. ~/.dsh/profiles/web/cordis.patch.yml 追加挂载行：
   - insert:
       - id: better-sidebar
         name: 'dsh-better-sidebar'
4. 在 ~/.dsh/profiles/web 执行 pnpm install
5. 硬刷新浏览器（Cmd/Ctrl+Shift+R）即可看到效果（client 改动无需重启 DSH；host 半改动才需重启）
```

更新：`git pull && pnpm install && pnpm build` → 硬刷新浏览器即可（client 改动热加载生效，无需重启 DSH；host 半改动才需重启）。切回 npm 通道时，把依赖改回 `"dsh-better-sidebar": "^0.12.1"` 再 `pnpm install`。

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

## ⌨️ 快捷键

| 操作 | 按键 |
|---|---|
| 保存编辑 | `Ctrl/Cmd + S` |
| Git 提交 | `Ctrl + Enter` |
| 关闭 Tab | 鼠标中键 |
| 拆分/合并分栏 | 拖 Tab 到分栏边缘 / 中间 |
| 引用文件到输入框 | 悬浮行尾 `@文件` 按钮 |
| 复制文件路径 | 右键行 → 复制相对/绝对地址 |

## 🔌 服务化：注册 tab 与文件预览器

从 v0.4.0 起暴露 `ctx.betterSidebar` 服务，其他插件可注册侧边栏页面与文件预览器（内置 7 tab + 6 viewer 亦通过同一服务注册）：

```ts
import type {} from 'dsh-better-sidebar'  // 触发 ctx.betterSidebar 类型合并
export const inject = ['betterSidebar']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'my-plugin:db', title: 'Database', component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  }))
}
```

v0.12.1 补齐基座能力（完整类型导出、能力探测、状态订阅、tab 角标、生命周期回调、定向打开、插件自有设置等），详见下方接入文档。

完整接入文档：
- **[`AGENTS.md`](./AGENTS.md)**——仓库内维护的接入文档（全字段、匹配算法、HMR 陷阱、声明式设置、版本探测）；
- **[`docs/external-plugin-guide.md`](./docs/external-plugin-guide.md)**——面向外部插件开发者的接入指南（含完整最小示例）。

### ➕ 添加插件（推荐插件目录）

设置页「侧边卡片」两个网格末尾的**虚线卡片**分别打开 Tab / 预览插件弹窗：声明扩展点、「**在 GitHub 上浏览更多插件**」按钮（[GitHub topic `dsh-better-sidebar`](https://github.com/topics/dsh-better-sidebar)）、推荐插件目录（名字 / 仓库 / 简介 / 安装脚本），每个条目「**跳转**」直达仓库、「**复制**」把安装命令写入剪贴板。

**收录新插件**：向 [`src/client/plugins-tabs.ts`](./src/client/plugins-tabs.ts)（Tab 注册）或 [`src/client/plugins-viewers.ts`](./src/client/plugins-viewers.ts)（文件预览注册）追加一条 `PluginEntry`，并把仓库打上 `dsh-better-sidebar` topic；数据完整性由 `tests/plugin-list.spec.ts` 守护。

## 🛠️ 开发与构建

```sh
pnpm install      # @deepseek-ai/* 已发布到 npm（^0.1.0-rc.6），直接解析、无需令牌
pnpm typecheck    # tsc --noEmit
pnpm build        # → lib/index.js + lib/invariant.js + lib/client.js + lib/client-registry.js + lib/types
pnpm test         # vitest（含 manifest 一致性守卫，需先 build）
pnpm watch        # tsdown --watch
```

**架构**：单 npm 包、host/client 双半结构——host（`src/index.ts`）：`/sidebar/api/*` JSON API、`/sidebar/file` 媒体路由、`/sidebar/html` 预览路由、`/sidebar/ws/terminal` WebSocket（fs / git / pty / 预览，全部会话级 + 信任围栏）；client（`src/client/index.tsx`）：portal 侧边栏 + 各视图 + 拦截；状态按会话持久化 localStorage。插件按 DSH 官方规范组织（无 default 导出、双 client bundle），运行期不依赖 npm / checkout（`@deepseek-ai/*` 由 web profile 提供）。

## 🔐 安全

- 路由受 Host 头信任围栏保护（与 `/api` 一致）；`fs.write` 原子写入；媒体/预览路由仅限会话 cwd 内文件；git 只调 CLI、绝不设置身份
- HTML 预览与浏览器 tab 的内容在**不透明源沙箱 iframe** 中渲染（无 `allow-same-origin`/`allow-top-navigation`、`no-referrer`、权限策略全禁）；`/sidebar/html` 路由带 CSP `sandbox` + 大小/路径边界；地址栏拒绝 `javascript:`/`data:`/`file:` 与 localhost 等本机地址
- 界面实时显示沙箱状态（关闭时红色警示），可临时解锁当前页面；设置页可按功能关闭沙箱（默认关闭该设置，带警告文案）——关闭后内容与界面同源，仅建议对完全可信内容使用

## ⚠️ 已知限制

- Git 无 push/pull/fetch；无文件 watcher（手动刷新）；工具行内文件打开按钮不可拦截
- 终端 Tab 拖到另一分栏会重挂载（shell 重开）
- Office 三件套预览（.docx/.xlsx/.pptx）已移至「推荐插件」（Office 预览插件，见设置页「添加插件」弹窗）；未安装时此类文件走代码/下载查看兜底
- 浏览器沙箱无登录态/第三方 Cookie 受限，部分站点登录需走弹窗；被 `X-Frame-Options`/`frame-ancestors` 拒绝嵌入的站点（如 arxiv.org）显示原因面板（含「在浏览器中打开」）；iframe 内部跳转不进后退栈
- HTML 预览渲染的是已保存文件（不反映未保存草稿）
- 移动端（<768px）无底部面板：进入窄屏时其标签页一次性并入右侧栏（迁移后回桌面仍保留在右侧栏），桌面端的底部面板只在宽视口下可用；移动端底部首展自动开终端不触发

## 🖥️ 平台支持

Windows / Linux / macOS 三平台适配（macOS 日常验证；其余经单元测试覆盖）；`node-pty` 优先预编译二进制，失败需编译工具链（Windows VS Build Tools / Linux make+g+++python3 / macOS Xcode CLT）。

## 🔗 友情链接

- [dsh-tianshu-tui](https://github.com/huiliyi37/dsh-tianshu-tui)：DeepSeek Harness 交互式终端 UI 插件（渲染核心由自研 harness agent Tianshu-Tui 演进而来），在官方基础上增加 TDD 与证据门等工作流
- [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)：Claude Code 风格全屏交互终端插件——像素鲸鱼顶栏、实时工作状态行、思考流式展开、双击 Esc 回滚、上下文进度条 + TPS 仪表，npm 一键安装
- [dshfind 插件超市](https://dshfind.com/zh/plugins)：三方插件市场——GitHub topic `dsh-plugin` 下的公开仓库清单，每日同步 star、贡献者与增长数据
