# dsh-better-sidebar

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">一个服务化的侧边栏框架，一套开箱即用的完整工作台</b><br /><br />
  <a href="https://www.npmjs.com/package/dsh-better-sidebar"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-better-sidebar" /></a>
  <a href="https://www.npmjs.com/package/dsh-better-sidebar"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-better-sidebar" /></a>
  <a href="https://github.com/omdsh-dev/DSH-better-sidebar/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/omdsh-dev/DSH-better-sidebar/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/omdsh-dev/DSH-better-sidebar/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/omdsh-dev/DSH-better-sidebar" /></a>
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://dshfind.com/zh/plugins/omdsh-dev/DSH-better-sidebar?ref=badge"><img alt="dshfind" src="https://dshfind.com/api/badge/omdsh-dev/DSH-better-sidebar?lang=zh" /></a><br /><br />
  <a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="支持的 DSH 版本：0.1.0-rc.8 · 0.1.1-rc.1 · 0.1.1-rc.2" src="https://img.shields.io/badge/DSH-0.1.0--rc.8_%C2%B7_0.1.1--rc.1_%C2%B7_0.1.1--rc.2-4d6bfe" /></a>
  <a href="https://github.com/topics/dsh-better-sidebar"><img alt="插件生态：GitHub topic dsh-better-sidebar" src="https://img.shields.io/badge/%E6%8F%92%E4%BB%B6%E7%94%9F%E6%80%81-topic%20dsh--better--sidebar-4d6bfe" /></a><br /><br />
  <img alt="文件管理" src="https://img.shields.io/badge/-文件管理-4d6bfe" /> <img alt="编辑预览" src="https://img.shields.io/badge/-编辑预览-4d6bfe" /> <img alt="内嵌浏览器" src="https://img.shields.io/badge/-内嵌浏览器-4d6bfe" /> <img alt="真实终端" src="https://img.shields.io/badge/-真实终端-4d6bfe" /> <img alt="Git 面板" src="https://img.shields.io/badge/-Git%20面板-4d6bfe" /> <img alt="后台任务" src="https://img.shields.io/badge/-后台任务-4d6bfe" /> <img alt="侧边对话" src="https://img.shields.io/badge/-侧边对话-4d6bfe" /> <img alt="插件接入" src="https://img.shields.io/badge/-插件接入-4d6bfe" /><br /><br />
  <b>右侧栏 + 底部面板双工作台</b>，并把 <code>ctx.betterSidebar</code> 服务开放给所有插件——<br />
  通过 <code>registerTab</code> / <code>registerFileViewer</code> 注册新的侧边栏页面与文件预览器。
</div>

<div align="center">
  🌏 <a href="./README.md"><b>中文</b></a> · <a href="./README_EN.md">English</a>
</div>

<div align="center">
  <img alt="dsh-better-sidebar 工作台截图" src="https://github.com/user-attachments/assets/dfdb875e-a1a8-4d4b-8340-353736b1708f" />
  <video src="https://github.com/user-attachments/assets/23187822-047e-45cc-b480-fe997bd55b86" muted autoplay loop playsinline controls width="100%"></video>
</div>

## 📑 目录

- [✨ 功能一览](#-功能一览)
- [🚀 安装](#-安装)
- [🖼️ 特性巡礼](#-特性巡礼)
- [🌐 插件生态](#-插件生态)
- [🆕 最近更新](#-最近更新)
- [⌨️ 快捷键](#-快捷键)
- [🔌 服务化扩展](#-服务化扩展)
- [🛠️ 开发与构建](#-开发与构建)
- [🔐 安全](#-安全) · [⚠️ 已知限制](#-已知限制) · [🖥️ 平台支持](#-平台支持)
- [🤝 参与贡献](#-参与贡献) · [⭐ Star History](#-star-history) · [🔗 友情链接](#-友情链接)

## ✨ 功能一览

- **🗂️ 文件工作台**：资源管理器（懒加载目录树；软链接按目标类型展示——目录软链接可展开、失效链接标红）+ CodeMirror 编辑器；图片 / Markdown（含 Mermaid 图表，strict 安全渲染 + 点击放大）/ HTML / PDF
- **🌐 内嵌浏览器**：多开网页 tab，后退 / 前进 / 刷新；内容运行在沙箱 iframe；外链默认按协议分流——HTTP 在侧边栏打开、HTTPS 走系统浏览器（设置页可分别调整）
- **💻 真实终端**：xterm.js + node-pty 真实 shell，断线重连回放；可选为模型注入 `terminal_*` 工具
- **🌿 Git 面板**：真 diff + VSCode 式 diff tab、历史、右键暂存 / 提交 / 还原
- **🧩 后台任务页**：subagent 拓扑 + 后台任务（退出码 / 实时输出 / 强制终止）
- **💬 侧边对话(beta)**：Codex 风格的侧边线程——继承主会话完整上下文（含进行中的回合与工具调用）独立运行，不进入主会话；线程内可持续追问，一键「保存为新会话」提升为顶层会话
- **🪟 双工作台**：右侧栏 + 底部面板；拖 Tab 拆分 / 合并分栏（可跨面板），移动端自动合并全宽抽屉
- **🔁 会话隔离**：布局 / Tab / 面板按会话持久化，陈旧状态自动净化
- **⚙️ 声明式设置**：设置页「侧边卡片」逐项独立开关，二级设置经齿轮弹窗
- **⚡ 按需加载**：启动只拉 ~325KB 核心，终端 / 编辑器 / Mermaid 图表等重依赖用到才按需拉取（[设计文档](docs/plans/2026-08-12-lazy-chunks-design.md)）
- **🌏 多语言**：界面文案跟随 DSH 语言（zh / en）实时切换

> 🔌 **核心理念**：服务优先——内置的 7 tab + 6 viewer 与第三方插件通过同一套 `ctx.betterSidebar` API 注册，能力完全对等；官方不再内置、可由生态提供的功能，交由生态插件实现（已有 **26+ 生态插件**，见下方「🌐 插件生态」）。接入文档见「🔌 服务化扩展」与 [外部插件接入指南](./docs/external-plugin-guide.md)。

## 🚀 安装

**前置**：已装好 DSH（`dsh web` 能正常运行），Node.js ≥ 20、pnpm ≥ 10。

**支持的 DSH 版本**：
<a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="支持的 DSH 版本：0.1.0-rc.8 · 0.1.1-rc.1 · 0.1.1-rc.2" src="https://img.shields.io/badge/DSH-0.1.0--rc.8_%C2%B7_0.1.1--rc.1_%C2%B7_0.1.1--rc.2-4d6bfe" /></a>

```sh
dsh plugin --profile web add dsh-better-sidebar@latest   # 首次会因 pnpm 11 拦截 node-pty 构建脚本而失败（依赖已写入）
cd ~/.dsh/profiles/web && pnpm approve-builds --all      # 放行构建脚本（自动重跑安装）
dsh plugin --profile web add dsh-better-sidebar@latest   # 重跑即成功
```

装完**硬刷新浏览器**（Cmd/Ctrl+Shift+R）即可看到侧边栏（DSH 对 client 改动热加载，无需重启；仅 host 半更新时需要重启）。

**方式二：让 DSH 自己装**——把下面这段提示词发给任意一个 DSH 会话：

```text
帮我安装 dsh-better-sidebar 插件（DSH 侧边栏工作台），步骤：
1. 执行 dsh plugin --profile web add dsh-better-sidebar@latest（首次会被 pnpm 11 拦截 node-pty 构建脚本而失败，属正常）
2. 在 ~/.dsh/profiles/web 下执行 pnpm approve-builds --all（放行构建脚本，会自动重跑安装）
3. 再次执行 dsh plugin --profile web add dsh-better-sidebar@latest
4. 完成后提醒我硬刷新浏览器（Cmd/Ctrl+Shift+R）
遇到报错先查 https://github.com/omdsh-dev/DSH-better-sidebar README 的常见问题表。
```

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
| 报 `Ignored build scripts` | pnpm 11 拦截构建脚本。在 profile 目录（`~/.dsh/profiles/web`）跑 `pnpm approve-builds --all`。 |
| 报 `minimum release age` / 版本不足 24h | 装的版本发布不足 24 小时。等 24h 或重跑一次（pnpm 会自动补 `minimumReleaseAgeExclude`）。 |
| 报「找不到 profile 目录」 | 先跑一次 `dsh web`，让它初始化 `~/.dsh/profiles/web`。 |
| 页面出现**两个侧边栏** | 双挂载。旧的手动挂载行：`~/.dsh/profiles/web/cordis.patch.yml` 还留着 `- insert: ... better-sidebar ...`，删掉那段（同 id 重复挂载 loader 会直接报 `duplicate loader entry id`）。聚合包（如 `@linxin666/dsh-web-ui-all`）以**不同 id** 挂载本包时，0.13.x 起插件自身 bundle patch 会自动退让（检测到已有启用中的同包名挂载就不挂自己），无需手动处理；若仍双挂载，先确认聚合包的 bundle 顺序在 `dsh-better-sidebar` 之前。 |
| Windows 下终端无法使用 | `node-pty` 依赖预编译二进制；若当前 Node 版本没有对应产物，需装编译工具链（VS Build Tools）。主流 Node 版本一般已有预编译。 |
| 终端提示「node-pty 加载失败」 | `node-pty` 安装缺失/损坏（如 pnpm 拦截了构建脚本）。终端横幅会给出修复命令：复制到 DSH 所在环境的终端/cmd 执行（在 `~/.dsh/profiles/web` 下 `pnpm approve-builds --all && pnpm rebuild node-pty`），完成后重启 DSH 并点重试。插件与 DSH 核心使用同一 `node-pty@^1.1.0`，修复后两者同步恢复。 |
| 提示 `dsh: command not found` | 先安装 DSH；或直接用 `npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-better-sidebar@latest`。 |

</details>

<details>
<summary><b>从源码安装 / 开发（可选，替代 npm 方式）</b></summary>

调试本地改动或跟随开发分支时，把依赖指向本地克隆并自行构建：

```text
1. git clone https://github.com/omdsh-dev/DSH-better-sidebar.git ~/Code/DSH-better-sidebar
   cd ~/Code/DSH-better-sidebar && pnpm install && pnpm build
2. ~/.dsh/profiles/web/package.json 的 dependencies 写 "dsh-better-sidebar": "link:<克隆目录绝对路径>"
3. ~/.dsh/profiles/web/cordis.patch.yml 追加挂载行（需要指定终端 shell 时，在行内加 `config.shell`；`config.shellArgs` 可带参启动，非空时替换默认的 `-l`。不填则自动解析 `$SHELL` / 登录 shell / powershell.exe）：
   - insert:
       - id: better-sidebar
         name: 'dsh-better-sidebar'
         config:
           shell: /bin/zsh
           shellArgs:
             - --noprofile
             - --no-rc
4. 在 ~/.dsh/profiles/web 执行 pnpm install
5. 硬刷新浏览器（Cmd/Ctrl+Shift+R）即可看到效果（client 改动无需重启 DSH；host 半改动才需重启）
```

更新：`git pull && pnpm install && pnpm build` → 硬刷新浏览器即可（client 改动热加载生效，无需重启 DSH；host 半改动才需重启）。切回 npm 通道时，把依赖改回 `"dsh-better-sidebar": "^0.15.0"` 再 `pnpm install`。

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

> 以下均为真实界面实拍。

### 🗂️ 文件工作台：资源管理器

支持两种格式的资源管理器：内嵌在文件预览中 / 独立显示文件树。懒加载目录树、软链接按目标类型展示（目录软链接可展开、失效链接标红）、全局文件名搜索、上传文件/文件夹与拖放上传、右键菜单（在新 Tab 打开 / 在侧边打开 / 复制路径）、悬浮 `@文件` 一键引用进输入框。

<div align="center"><img width="880" alt="文件资源管理器" src="https://github.com/user-attachments/assets/a410bfd2-a8ba-43e6-873e-22417756e94d" /></div>
<div align="center"><img width="880" alt="CodeMirror 代码编辑器" src="https://github.com/user-attachments/assets/b44b488e-568c-4ee0-b96c-e9c906598a77" /></div>

### 📝 Markdown · 图片 · PDF 内联预览

Markdown 预览支持 **Mermaid 图表**（`securityLevel: 'strict'` 安全渲染 + 二次清洗；点击图表弹窗放大、滚轮缩放、拖拽平移）；图片 / PDF 走媒体路由内联展示；Office 三件套由生态插件补齐。

<div align="center"><img width="880" alt="Markdown + Mermaid 预览" src="https://github.com/user-attachments/assets/fe0e5182-55bb-45cc-b98b-a2877c2bdd38" /></div>
<div align="center"><img width="880" alt="图片内联预览" src="https://github.com/user-attachments/assets/f9a58c30-5b7a-48b5-9e22-37d7e071f593" /></div>

### 💻 真实终端

xterm.js + node-pty 真实 shell（不是模拟器）：断线重连 transcript 回放、shell / shellArgs 可配置（设置页或 `cordis.patch.yml`）、可选为模型注入 `terminal_*` 工具（agent 可直接开终端跑命令）。

<div align="center"><img width="880" alt="真实终端" src="https://github.com/user-attachments/assets/0dad6ad3-ff3f-4b5a-86d2-f832ce65323e" /></div>

### 🌿 Git 面板

暂存 / 取消暂存 / 提交（`Ctrl+Enter`）/ 还原，历史列表；点击改动文件打开 **VSCode 式 diff tab**（红绿行级对比）。

<div align="center"><img width="880" alt="Git 面板" src="https://github.com/user-attachments/assets/e7fc1220-305f-4bca-8583-e77ab4f4fa78" /></div>

### 🌐 内嵌浏览器

多开网页 tab：后退 / 前进 / 刷新 / 地址栏；内容运行在**不透明源沙箱 iframe**（界面实时显示沙箱状态，可按页面临时解锁）；聊天里的外链点击可被接管到侧边栏打开（按协议分流，可配）。

<div align="center"><img width="880" alt="内嵌浏览器" src="https://github.com/user-attachments/assets/9bc6b65a-64fc-4942-a685-76e391e55606" /></div>

### 🧩 任务页：子代理拓扑 + 后台任务

子代理树实时拓扑（运行状态、批量实时预览）+ 后台任务清单（退出码 / 实时输出 / 强制终止）；新子代理 / 新任务可自动展开侧边栏（可关）。

<div align="center"><img width="880" alt="任务页：子代理拓扑" src="https://github.com/user-attachments/assets/dcd8ed2f-59fa-405b-937b-2d250f5034dd" /></div>

### 💬 侧边对话(beta)

Codex 风格侧边线程：**每个对话一个独立 Tab**；线程继承主会话完整上下文（含进行中回合，以 interrupted 诚实冻结）独立运行，不污染主会话；可持续追问、重启冷恢复；一键「保存为新会话」提升为顶层会话。

<div align="center"><img width="880" alt="侧边对话(beta)" src="https://github.com/user-attachments/assets/3a338c36-f5de-4000-95f3-4b1cd04f60fc" /></div>

### 🪟 双工作台：右侧栏 + 底部面板 + 分栏

右侧栏与底部面板可同时展开；拖 Tab 到分栏边缘**拆分**、拖到中间**合并**（可跨面板）；面板宽高左缘/上缘拖拽调节；移动端自动合并为全宽抽屉。

<div align="center"><img width="880" alt="双工作台（右侧栏 + 底部面板）" src="https://github.com/user-attachments/assets/dfdb875e-a1a8-4d4b-8340-353736b1708f" /></div>

### ⚙️ 声明式设置

设置页「侧边卡片」分区：每个 tab / 预览器一张小卡片，独立开关（高亮启用态 + 品牌开关滑块）；二级设置经卡片底部「功能设置」条弹窗（开关 / 文本 / 数字 / 下拉）；插件自有设置持久化在 `pluginSettings`。

<div align="center"><img width="880" alt="声明式设置：侧边卡片" src="https://github.com/user-attachments/assets/0800ca64-621e-48da-b7df-aecfddc3ec29" /></div>

### 📱 移动端

窄屏（<768px）自动切换为全宽抽屉：底栏 tab 一次性并入右侧栏，触屏拖拽可调。

<div align="center"><img width="360" alt="移动端全宽抽屉" src="https://github.com/user-attachments/assets/a82ba78a-f4cf-4d85-80e8-050a05beb144" /></div>

## 🌐 插件生态

`ctx.betterSidebar` 服务向所有插件开放两个扩展点：**`registerTab`（注册侧边栏页面）** 与 **`registerFileViewer`（注册文件预览器）**。内置的 7 tab + 6 viewer 与第三方插件走同一套 API，能力完全对等。

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

GitHub topic [`dsh-better-sidebar`](https://github.com/topics/dsh-better-sidebar) 下已有 **26+ 生态插件**（持续增长中）：

<div align="center">
  <a href="https://github.com/user-attachments/assets/d4385b7e-aab4-425d-a5c4-2da5da81a34e"><img width="66%" alt="设置页「添加插件」弹窗：推荐插件目录 + 一键复制安装命令" src="https://github.com/user-attachments/assets/d4385b7e-aab4-425d-a5c4-2da5da81a34e" /></a><br />
  <i>设置页「侧边卡片」内置「添加插件」弹窗：推荐目录 + 一键复制安装命令 + 直达 GitHub topic</i>
</div>

### 📑 Tab 插件（注册侧边栏页面）

| 插件 | ⭐ | 简介 |
|---|---|---|
| [ChenRuoT/dsh-sidebar-qa](https://github.com/ChenRuoT/dsh-sidebar-qa) | <img alt="stars" src="https://img.shields.io/github/stars/ChenRuoT/dsh-sidebar-qa?style=flat&color=4d6bfe" /> | 划选追问侧边页：类 Codex 侧边提问 / Claude Code `/btw` |
| [fuhefei/dsh-sentinel](https://github.com/fuhefei/dsh-sentinel) | <img alt="stars" src="https://img.shields.io/github/stars/fuhefei/dsh-sentinel?style=flat&color=4d6bfe" /> | 条件驱动唤醒系统：文件 / 命令 / HTTP / 进程 / Webhook 监视，到点唤醒 agent；dock + 侧栏分支 + 全局仪表盘 |
| [jiuge2467/dsh-studio](https://github.com/jiuge2467/dsh-studio) | <img alt="stars" src="https://img.shields.io/github/stars/jiuge2467/dsh-studio?style=flat&color=4d6bfe" /> | 全栈增强工作台：多源 MCP 可视化调试中枢、视觉思考引擎 |
| [Iwctwbh/dsh-flowglass](https://github.com/Iwctwbh/dsh-flowglass) | <img alt="stars" src="https://img.shields.io/github/stars/Iwctwbh/dsh-flowglass?style=flat&color=4d6bfe" /> | 流镜 Flowglass：会话流程图实时可视化（消息 / 工具组 / 子代理分支） |
| [FeatherHunter/dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck) | <img alt="stars" src="https://img.shields.io/github/stars/FeatherHunter/dsh-mattpocock-skills-deck?style=flat&color=4d6bfe" /> | mattpocock/skills 游戏化任务系统：地图拨迷雾、任务栏推进 |
| [GULI-lab/DSH-element-source](https://github.com/GULI-lab/DSH-element-source) | <img alt="stars" src="https://img.shields.io/github/stars/GULI-lab/DSH-element-source?style=flat&color=4d6bfe" /> | 点击页面任意 UI 元素直达 Vue / React / Svelte / Angular 源码并送入会话 |
| [Lzh3070/dsh-file-review-tab](https://github.com/Lzh3070/dsh-file-review-tab) | <img alt="stars" src="https://img.shields.io/github/stars/Lzh3070/dsh-file-review-tab?style=flat&color=4d6bfe" /> | 文件改动审查页：行级红绿 diff + 撤销 + chat 行深链 |
| [yq04/dsh-git-remotes](https://github.com/yq04/dsh-git-remotes) | <img alt="stars" src="https://img.shields.io/github/stars/yq04/dsh-git-remotes?style=flat&color=4d6bfe" /> | Git 远程页：分支 / 上游 / ahead-behind，fetch 可 prune、ff-only pull、确认后 push |
| [ztyhehe/dsh-better-sidebar-svn](https://github.com/ztyhehe/dsh-better-sidebar-svn) | <img alt="stars" src="https://img.shields.io/github/stars/ztyhehe/dsh-better-sidebar-svn?style=flat&color=4d6bfe" /> | SVN 源码管理页：status / diff / log / commit / update / revert / 冲突解决，与内置 Git 面板对称 |
| [Melody-max114/dsh-excel-panel](https://github.com/Melody-max114/dsh-excel-panel) | <img alt="stars" src="https://img.shields.io/github/stars/Melody-max114/dsh-excel-panel?style=flat&color=4d6bfe" /> | Excel 编辑页：xlsx 预览 / 编辑、公式实时计算、合并单元格、保存回原文件 |
| [v587d/dsh-anysearch-refs](https://github.com/v587d/dsh-anysearch-refs) | <img alt="stars" src="https://img.shields.io/github/stars/v587d/dsh-anysearch-refs?style=flat&color=4d6bfe" /> | AnySearch 搜索结果引用卡片：搜索词、来源摘要、关键词高亮 |
| [mlosun/dsh-docs-panel](https://github.com/mlosun/dsh-docs-panel) | <img alt="stars" src="https://img.shields.io/github/stars/mlosun/dsh-docs-panel?style=flat&color=4d6bfe" /> | 全局文档面板：随身 Markdown 笔记，任何工作区随时可读 |
| [lnyuqian/dsh-skill-sidebar](https://github.com/lnyuqian/dsh-skill-sidebar) | <img alt="stars" src="https://img.shields.io/github/stars/lnyuqian/dsh-skill-sidebar?style=flat&color=4d6bfe" /> | 技能面板：扫描本机技能目录，4-6 字功能短语 + 一键复制调用 + 置顶 |
| [g-yixuan/dsh-sidechat](https://github.com/g-yixuan/dsh-sidechat) | <img alt="stars" src="https://img.shields.io/github/stars/g-yixuan/dsh-sidechat?style=flat&color=4d6bfe" /> | Codex 风格侧边对话 + 划选引用注释（轻量消费插件） |
| [thirsty5034/dsh-ssh-tunnel](https://github.com/thirsty5034/dsh-ssh-tunnel) | <img alt="stars" src="https://img.shields.io/github/stars/thirsty5034/dsh-ssh-tunnel?style=flat&color=4d6bfe" /> | 多主机 SSH 隧道 + SSH 管理器页 |
| [thirsty5034/dsh-git-forge](https://github.com/thirsty5034/dsh-git-forge) | <img alt="stars" src="https://img.shields.io/github/stars/thirsty5034/dsh-git-forge?style=flat&color=4d6bfe" /> | GitHub / Gitea 账号、项目授权与推送策略 |
| [YesSanSan/dsh-conversation-outline](https://github.com/YesSanSan/dsh-conversation-outline) | <img alt="stars" src="https://img.shields.io/github/stars/YesSanSan/dsh-conversation-outline?style=flat&color=4d6bfe" /> | 对话大纲页：按轮次结构化展示、一键跳转、LLM 一句话标题 |
| [Wulabalabo/dsh-sidebar-Explorer-Plus](https://github.com/Wulabalabo/dsh-sidebar-Explorer-Plus) | <img alt="stars" src="https://img.shields.io/github/stars/Wulabalabo/dsh-sidebar-Explorer-Plus?style=flat&color=4d6bfe" /> | 文件管理页：上传 / 移动 / 删除 / 重命名 / 新建文件夹（补全写操作） |
| [yq04/dsh-turn-review](https://github.com/yq04/dsh-turn-review) | <img alt="stars" src="https://img.shields.io/github/stars/yq04/dsh-turn-review?style=flat&color=4d6bfe" /> | 本轮审查：逐回合审查 agent 改动 |
| [Ghz114514/dsh-refpics](https://github.com/Ghz114514/dsh-refpics) | <img alt="stars" src="https://img.shields.io/github/stars/Ghz114514/dsh-refpics?style=flat&color=4d6bfe" /> | Pinterest 风格参考图搜索：瀑布流、侧栏画板、下载与 Eagle 收藏 |
| [yzlin499/dsh-yzlin499-easy-plugins](https://github.com/yzlin499/dsh-yzlin499-easy-plugins) | <img alt="stars" src="https://img.shields.io/github/stars/yzlin499/dsh-yzlin499-easy-plugins?style=flat&color=4d6bfe" /> | 实用小工具集（毛坯房 DSH 友好） |

### 🖼️ 预览插件（注册文件预览器）

| 插件 | ⭐ | 简介 |
|---|---|---|
| [HuanLinOTO/dsh-plugin-better-sidebar-plugin-office](https://github.com/HuanLinOTO/dsh-plugin-better-sidebar-plugin-office) | <img alt="stars" src="https://img.shields.io/github/stars/HuanLinOTO/dsh-plugin-better-sidebar-plugin-office?style=flat&color=4d6bfe" /> | Office 三件套预览（.docx / .xlsx / .pptx），独立 bundle 瘦身主体（官方推荐目录收录） |
| [zemul/dsh-video-preview](https://github.com/zemul/dsh-video-preview) | <img alt="stars" src="https://img.shields.io/github/stars/zemul/dsh-video-preview?style=flat&color=4d6bfe" /> | 视频内联预览：.mp4 / .webm / .mov / .mkv / .avi，自带 /video 路由支持 HTTP Range 拖进度条 |
| [dong-victor/dsh-better-sidebar-jupyter](https://github.com/dong-victor/dsh-better-sidebar-jupyter) | <img alt="stars" src="https://img.shields.io/github/stars/dong-victor/dsh-better-sidebar-jupyter?style=flat&color=4d6bfe" /> | `.ipynb` 可运行 Notebook 视图：懒启动 Python kernel、流式输出、保存回写 |

### 🧰 增强与工具

| 插件 | ⭐ | 简介 |
|---|---|---|
| [dong-victor/dsh-better-sidebar-terminal-plus](https://github.com/dong-victor/dsh-better-sidebar-terminal-plus) | <img alt="stars" src="https://img.shields.io/github/stars/dong-victor/dsh-better-sidebar-terminal-plus?style=flat&color=4d6bfe" /> | 终端增强：内嵌 Nerd Font 图标字体、修复 xterm 图标渲染、稳定终端 cwd |
| [Max-Null/dsh-sidebar-preview-select](https://github.com/Max-Null/dsh-sidebar-preview-select) | <img alt="stars" src="https://img.shields.io/github/stars/Max-Null/dsh-sidebar-preview-select?style=flat&color=4d6bfe" /> | 预览划选增强：侧边栏预览里划选文本 → 浮动「发送到会话」 |

> 📣 **上架你的插件**：给仓库打上 `dsh-better-sidebar` topic 即出现在 [topic 页](https://github.com/topics/dsh-better-sidebar)；再向 [`src/client/plugins-tabs.ts`](./src/client/plugins-tabs.ts) / [`src/client/plugins-viewers.ts`](./src/client/plugins-viewers.ts) 提一条 `PluginEntry` PR，即可进入设置页内置推荐目录（数据完整性由 `tests/plugin-list.spec.ts` 守护）。

## 🆕 最近更新

<div align="center">
  <a href="https://github.com/user-attachments/assets/d2aea86b-a776-4f01-a6b8-b26b27314336"><img width="33%" alt="侧边栏" src="https://github.com/user-attachments/assets/d2aea86b-a776-4f01-a6b8-b26b27314336" /></a>
  <a href="https://github.com/user-attachments/assets/946f7028-4967-461e-a750-d1b5056b62d0"><img width="33%" alt="服务化基座截图" src="https://github.com/user-attachments/assets/946f7028-4967-461e-a750-d1b5056b62d0" /></a>
</div>

**支持的 DSH 版本**：<a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="支持的 DSH 版本：0.1.0-rc.8 · 0.1.1-rc.1 · 0.1.1-rc.2" src="https://img.shields.io/badge/DSH-0.1.0--rc.8_%C2%B7_0.1.1--rc.1_%C2%B7_0.1.1--rc.2-4d6bfe" /></a> · 完整发布历史见 [Releases](https://github.com/omdsh-dev/DSH-better-sidebar/releases)

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

<details>
<summary><b>历史版本（v0.12.0 – v0.14.0）</b></summary>

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
- 🐛 **node-pty 加载失败不再拖垮 server**（[#140](https://github.com/omdsh-dev/DSH-better-sidebar/issues/140)）：宿主半改为懒加载 node-pty，缺失时插件照常挂载，终端以修复提示横幅（可复制命令 + 重试按钮）呈现，agent 终端工具自动跳过
- 🧪 测试工程：单元测试拆分（#141）+ smoke 偶发失败修复

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

## 🔌 服务化扩展

从 v0.4.0 起暴露 `ctx.betterSidebar` 服务，其他插件可注册侧边栏页面与文件预览器（内置 7 tab + 6 viewer 亦通过同一服务注册）。v0.12.1 补齐基座能力（完整类型导出、能力探测、状态订阅、tab 角标、生命周期回调、定向打开、插件自有设置等）。

完整接入文档：
- **[`AGENTS.md`](./AGENTS.md)**——仓库内维护的接入文档（全字段、匹配算法、HMR 陷阱、声明式设置、版本探测）；
- **[`docs/external-plugin-guide.md`](./docs/external-plugin-guide.md)**——面向外部插件开发者的接入指南（含完整最小示例）。

### ➕ 添加插件（推荐插件目录）

设置页「侧边卡片」两个网格末尾的**虚线卡片**分别打开 Tab / 预览插件弹窗：声明扩展点、「**在 GitHub 上浏览更多插件**」按钮（[GitHub topic `dsh-better-sidebar`](https://github.com/topics/dsh-better-sidebar)）、推荐插件目录（名字 / 仓库 / 简介 / 安装脚本），每个条目「**跳转**」直达仓库、「**复制**」把安装命令写入剪贴板。

**收录新插件**：向 [`src/client/plugins-tabs.ts`](./src/client/plugins-tabs.ts)（Tab 注册）或 [`src/client/plugins-viewers.ts`](./src/client/plugins-viewers.ts)（文件预览注册）追加一条 `PluginEntry`，并把仓库打上 `dsh-better-sidebar` topic；数据完整性由 `tests/plugin-list.spec.ts` 守护。

## 🛠️ 开发与构建

```sh
pnpm install      # @deepseek-ai/* devDependencies 已发布 0.1.1-rc.1，直接解析、无需令牌
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

## 🤝 参与贡献

- **代码改动走 PR**：`feat/*` / `fix/*` 分支开发 → `gh pr create`；纯文档改动可直接推 main
- **收录生态插件**：给仓库打 `dsh-better-sidebar` topic + 向 [`src/client/plugins-tabs.ts`](./src/client/plugins-tabs.ts) / [`plugins-viewers.ts`](./src/client/plugins-viewers.ts) 提 PR
- **提交前自检**：`pnpm typecheck && pnpm build && pnpm test`（CI 另有 npm 打包 → 真实挂载 → 无头渲染门禁 `pnpm test:mount`）
- 仓库工作规范见 [`AGENTS.md`](./AGENTS.md)（含仓库硬约束与 CI 说明）

## ⭐ Star History

<a href="https://star-history.com/#omdsh-dev/DSH-better-sidebar&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=omdsh-dev/DSH-better-sidebar&type=Date&theme=dark" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=omdsh-dev/DSH-better-sidebar&type=Date" />
  </picture>
</a>

## 👥 贡献者

感谢每一位贡献者：

<a href="https://github.com/omdsh-dev/DSH-better-sidebar/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=omdsh-dev/DSH-better-sidebar" alt="贡献者" />
</a>

## 🔗 友情链接

- [dsh-tianshu-tui](https://github.com/huiliyi37/dsh-tianshu-tui)：DeepSeek Harness 交互式终端 UI 插件（渲染核心由自研 harness agent Tianshu-Tui 演进而来），在官方基础上增加 TDD 与证据门等工作流
- [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)：Claude Code 风格全屏交互终端插件——像素鲸鱼顶栏、实时工作状态行、思考流式展开、双击 Esc 回滚、上下文进度条 + TPS 仪表，npm 一键安装
- [dshfind 插件超市](https://dshfind.com/zh/plugins)：三方插件市场——GitHub topic `dsh-plugin` 下的公开仓库清单，每日同步 star、贡献者与增长数据
- [DeepSeek Harness Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)：为 DeepSeek Harness 生态打造的现代化桌面端——无需配置 Node.js 或执行命令即可启动和管理本地 Harness 服务；[官网](https://www.dshdesktop.cn)

---

<div align="center">
  <sub>MIT License · Built for the <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> ecosystem · 在 <a href="https://github.com/topics/dsh-better-sidebar">topic dsh-better-sidebar</a> 发现更多生态插件</sub>
</div>
