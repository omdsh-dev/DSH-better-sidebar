# dsh-better-sidebar

<!-- 头部介绍区（HTML 排版） -->
<div align="center">
  <b style="font-size: 1.15em;">一个插件，一套完整工作台</b><br /><br />
  <code>文件管理</code> <code>编辑预览</code> <code>内嵌浏览器</code> <code>真实终端</code> <code>Git 面板</code> <code>后台任务页</code><br /><br />
  <b>右侧栏 + 底部面板双工作台</b>，一个插件全部搞定。<br />
  <small>支持 Tab 窗口随意拖拽，支持三方拓展注册新 Tab 页面和文件预览</small>
</div>

<div align="center">
  🌏 <a href="./README.md"><b>中文</b></a> · <a href="./README_EN.md">English</a>
</div>

https://github.com/user-attachments/assets/23187822-047e-45cc-b480-fe997bd55b86

<img width="2630" height="1794" alt="6c4293e1bec2e935031bf0e986d6ec65" src="https://github.com/user-attachments/assets/dfdb875e-a1a8-4d4b-8340-353736b1708f" />

## 🆕 最近更新

- **终端自定义字体**：设置页终端卡片新增字体族 + 9–32px 字号设置，实时生效
- **侧边卡片设置页重构**：分组容器卡片、计数徽标、自定义开关、加宽设置弹窗
- **修复**：WKWebView 下底部面板展开后终端空白（xterm 零尺寸容器初始化崩溃，[#25](https://github.com/omdsh-dev/DSH-better-sidebar/issues/25)）

## ✨ 功能一览

- **🗂️ 资源管理器**：懒加载目录树（根 = 会话 cwd），点击打开、`@文件` 引用、右键复制路径
- **📝 编辑与预览**：CodeMirror 6 编辑（Ctrl/Cmd+S 原子保存，切 Tab 不丢草稿）；图片 / Markdown / HTML / PDF / Word / Excel / PPT 内联预览（HTML 走沙箱 iframe）
- **⚡ 客户端懒加载**：启动只拉 ~325KB 核心，Office / 终端 / 编辑器等重依赖用到才按需拉取（详见 `docs/plans/2026-08-12-lazy-chunks-design.md`）
- **🌐 浏览器**：多开内嵌网页 tab，后退/前进/刷新；内容运行在沙箱 iframe（无法访问界面数据与本地文件，拒绝本机地址），可临时解锁（红色警示）；被站点拒绝嵌入时显示原因；外链默认在侧边栏打开
- **💻 终端**：xterm.js + node-pty 真实 shell、断线重连回放；可选为模型注入 `terminal_*` 工具；支持自定义字体（字体族 + 9–32px 字号，实时生效）
- **🌿 Git 面板**：真 diff + VSCode 式 diff tab、历史、右键暂存/提交/还原等
- **🧩 后台任务页**：主会话 agent 拓扑、点击直达执行记录；同页显示后台任务（类型徽标 + 退出码、实时输出 peek、可强制终止）
- **🪟 底部面板**：第二个独立工作台，只挤占中间输出区；首次展开自动开终端（可关）
- **📱 移动端**：窄屏（<768px）自动合并为全宽抽屉，底部面板标签页并入右侧栏；点文件/外链自动展开
- **🔧 分栏工作台**：拖 Tab 拆分/合并（可跨面板）、分隔线调比例；右上角按钮一键折叠/展开面板
- **🔁 会话隔离**：布局 / Tab / 面板状态按会话持久化，陈旧状态自动净化；「产出文件」在侧边栏打开
- **⚙️ 声明式设置**：设置页「侧边卡片」按注册表渲染开关网格，逐项独立开/关；二级设置（自动展开、终端工具、沙箱等）经齿轮弹窗编辑
- **🔌 服务化**：暴露 `ctx.betterSidebar`，其他插件可注册 tab 与文件预览器（内置 7 tab + 9 viewer 同走一服务，见 [AGENTS.md](./AGENTS.md)）
- **🌏 多语言**：界面文案跟随 DSH 语言（zh/en）实时切换，无需刷新

## 🚀 安装

**前置**：已装好 DSH（`dsh web` 能正常运行），Node.js ≥ 20、pnpm ≥ 10。

**macOS / Linux**（Windows 装了 Git Bash 或 WSL 也可）：

```sh
curl -fsSL https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.sh | bash
```

**Windows（PowerShell 5.1+ / pwsh）**：

```powershell
$script = (
  irm 'https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.ps1'
).TrimStart([char]0xFEFF)
& ([scriptblock]::Create($script))
```

装完**硬刷新浏览器**（Cmd/Ctrl+Shift+R）即可看到侧边栏（DSH 对 client 改动热加载，无需重启；仅 host 半更新时需要重启）。

<details>
<summary><b>指定版本 / 装完自动重启（可选）</b></summary>

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.sh | bash -s 0.10.3 --restart

# Windows PowerShell
$script = (
  irm 'https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.ps1'
).TrimStart([char]0xFEFF)
& ([scriptblock]::Create($script)) -Version 0.10.3 -Restart
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

# ③ 安装并自动挂载（不带 @版本 = npm 的 latest；固定版本写 dsh-better-sidebar@0.10.3）
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

上述一键命令会下载并执行远程代码——脚本已随仓库开源（`scripts/install.sh` / `scripts/install.ps1`），可先下载审阅。PowerShell 入口会先移除 UTF-8 BOM，再创建 ScriptBlock，以确保参数在 PowerShell 5.1 和 pwsh 中都能正确绑定。插件以 npm 包 `dsh-better-sidebar@0.10.3` 发布，通过 `dsh.bundle.patch`（随包的 `cordis.patch.yml`）由官方 CLI 自动挂载，**不修改 DSH 源码**。

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

更新：`git pull && pnpm install && pnpm build` → 硬刷新浏览器即可（client 改动热加载生效，无需重启 DSH；host 半改动才需重启）。切回 npm 通道时，把依赖改回 `"dsh-better-sidebar": "^0.10.3"` 再 `pnpm install`。

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

从 v0.4.0 起暴露 `ctx.betterSidebar` 服务，其他插件可注册侧边栏页面与文件预览器（内置 7 tab + 9 viewer 也走同一服务，吃自己的狗粮）：

```ts
import type {} from 'dsh-better-sidebar'  // 触发 ctx.betterSidebar 类型合并
export const inject = ['betterSidebar']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'my-plugin:db', title: 'Database', component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  }))
}
```

完整接入文档（`TabDescriptor` / `FileViewerDescriptor` 全字段、匹配算法、HMR 陷阱、声明式设置）：见 [`AGENTS.md`](./AGENTS.md)。

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
- `.xlsx` 预览不保留单元格样式（SheetJS 社区版限制）；Office/PPTX 预览内联进 client bundle（约 23MB），首次加载较慢
- 浏览器沙箱无登录态/第三方 Cookie 受限，部分站点登录需走弹窗；被 `X-Frame-Options`/`frame-ancestors` 拒绝嵌入的站点（如 arxiv.org）显示原因面板（含「在浏览器中打开」）；iframe 内部跳转不进后退栈
- HTML 预览渲染的是已保存文件（不反映未保存草稿）
- 移动端（<768px）无底部面板：进入窄屏时其标签页一次性并入右侧栏（迁移后回桌面仍保留在右侧栏），桌面端的底部面板只在宽视口下可用；移动端底部首展自动开终端不触发

## 🖥️ 平台支持

Windows / Linux / macOS 三平台适配（macOS 日常验证；其余经单元测试覆盖）；`node-pty` 优先预编译二进制，失败需编译工具链（Windows VS Build Tools / Linux make+g+++python3 / macOS Xcode CLT）。

## 🔗 友情链接

- [dsh-tianshu-tui](https://github.com/huiliyi37/dsh-tianshu-tui)：DeepSeek Harness 交互式终端 UI 插件（渲染核心由自研 harness agent Tianshu-Tui 演进而来），在官方基础上增加 TDD 与证据门等工作流
- [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)：Claude Code 风格全屏交互终端插件——像素鲸鱼顶栏、实时工作状态行、思考流式展开、双击 Esc 回滚、上下文进度条 + TPS 仪表，npm 一键安装
- [dshfind 插件超市](https://dshfind.com/zh/plugins)：三方插件市场——GitHub topic `dsh-plugin` 下的公开仓库清单，每日同步 star、贡献者与增长数据
