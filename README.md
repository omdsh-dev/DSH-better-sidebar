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
  <img alt="dsh-better-sidebar 工作台截图" src="https://github.com/user-attachments/assets/991c4b70-d45a-461f-a8c8-0a28b4218e60" />
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
- [💬 社区](#-社区) · [🤝 参与贡献](#-参与贡献) · [⭐ Star History](#-star-history) · [🔗 友情链接](#-友情链接)

## ✨ 功能一览

- **🗂️ 文件工作台**：资源管理器（懒加载目录树；软链接按目标类型展示——目录软链接可展开、失效链接标红）+ CodeMirror 编辑器；图片 / Markdown（含 Mermaid 图表，strict 安全渲染 + 点击放大；README 级内嵌 HTML——徽章墙 / `<details>` 折叠 / 表格内联标签经 DOMPurify 消毒真实渲染；浮动目录大纲一键跳转）/ HTML / PDF
- **🌐 内嵌浏览器**：多开网页 tab，后退 / 前进 / 刷新；内容运行在沙箱 iframe；外链默认按协议分流——HTTP 在侧边栏打开、HTTPS 走系统浏览器（设置页可分别调整）
- **💻 真实终端**：xterm.js + node-pty 真实 shell，断线重连回放；可选为模型注入 `terminal_*` 工具
- **📂 模型侧边栏打开（可选）**：全局设置开启后注入 `sidebar_open` 工具——模型可主动在侧边栏打开文件 / 文件夹（树以该目录为根）/ HTTP(S) 网页
- **🌿 Git 面板**：真 diff + VSCode 式 diff tab、历史、右键暂存 / 提交 / 还原；工作区容器下自动发现子仓库并显示**仓库选择器**，支持 linked worktree 变更发现
- **🧩 后台任务页**：subagent 拓扑 + 后台任务（退出码 / 实时输出 / 强制终止）
- **💬 侧边对话(beta)**：Codex 风格的侧边线程——继承主会话完整上下文（含进行中的回合与工具调用）独立运行，不进入主会话；线程内可持续追问，一键「保存为新会话」提升为顶层会话
- **🪟 双工作台**：右侧栏 + 底部面板；拖 Tab 拆分 / 合并分栏（可跨面板），移动端自动合并全宽抽屉
- **🪟 自由窗口**：把标签栏的任一 tab 拖到主会话区域——成为可移动 / 缩放 / 置顶的悬浮窗口（默认 390×780），拖回侧边栏 pane 即停靠，随会话持久化；`features` 含 `'floatWindows'`，插件 tab 无差别支持
- **📌 固定终端**：右键终端 Tab 可「固定到工作区 / 固定到全局」——固定后切换会话不消失，在 TabBar 内联呈现（跨会话虚拟 Tab，点击就地激活，PTY 按 home 会话 id+tab 直连宿主 PTY，无需切回宿主会话）；Agent 终端被 reconcile 移除时豁免保留
- **🔁 会话隔离**：布局 / Tab / 面板按会话持久化，陈旧状态自动净化
- **⚙️ 声明式设置**：设置页「侧边卡片」逐项独立开关，二级设置经齿轮弹窗
- **⚡ 按需加载**：启动只拉 ~325KB 核心，终端 / 编辑器 / Mermaid 图表等重依赖用到才按需拉取（[设计文档](docs/plans/2026-08-12-lazy-chunks-design.md)）
- **🌏 多语言**：界面文案跟随 DSH 语言（zh / en）实时切换；安装 `@huanlin/dsh-plugin-better-locale` 后支持日语（ja）等第三语言覆盖（见下方「🌏 第三语言覆盖」）

> 🔌 **核心理念**：服务优先——内置的 7 tab + 6 viewer 与第三方插件通过同一套 `ctx.betterSidebar` API 注册，能力完全对等；官方不再内置、可由生态提供的功能，交由生态插件实现（已有 **28+ 生态插件**，见下方「🌐 插件生态」）。接入文档见「🔌 服务化扩展」与 [外部插件接入指南](./docs/external-plugin-guide.md)。

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

更新：`git pull && pnpm install && pnpm build` → 硬刷新浏览器即可（client 改动热加载生效，无需重启 DSH；host 半改动才需重启）。切回 npm 通道时，把依赖改回 `"dsh-better-sidebar": "^0.16.1"` 再 `pnpm install`。

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
| **🗂️ 文件工作台：资源管理器**<br/><sub>支持两种格式的资源管理器：内嵌在文件预览中 / 独立显示文件树。懒加载目录树、软链接按目标类型展示（目录软链接可展开、失效链接标红）、全局文件名搜索、上传文件/文件夹与拖放上传、右键菜单（在新 Tab 打开 / 在侧边打开 / 复制路径）、悬浮 `@文件` 一键引用进输入框。</sub><br/><div align="center"><img width="420" alt="文件资源管理器" src="https://github.com/user-attachments/assets/a410bfd2-a8ba-43e6-873e-22417756e94d" /></div> | **📝 Markdown · 图片 · PDF 内联预览**<br/><sub>Markdown 预览支持 **Mermaid 图表**（`securityLevel: 'strict'` 安全渲染 + 二次清洗；点击图表弹窗放大、滚轮缩放、拖拽平移）、**README 级内嵌 HTML**（徽章墙 `<div align=center>`、`<details>` 折叠块内嵌 markdown、表格单元格内联标签——DOMPurify 白名单消毒真实渲染，`<script>` 等活性内容剥除，本地图片经会话媒体路由重写）与**浮动目录大纲**（≥3 标题出现，点击平滑跳转、自动展开折叠块）；图片 / PDF 走媒体路由内联展示；Office 三件套由生态插件补齐。</sub><br/><div align="center"><img width="420" alt="Markdown + Mermaid 预览" src="https://github.com/user-attachments/assets/fe0e5182-55bb-45cc-b98b-a2877c2bdd38" /></div> |
| **🖥️ CodeMirror 代码编辑器**<br/><div align="center"><img width="420" alt="CodeMirror 代码编辑器" src="https://github.com/user-attachments/assets/b44b488e-568c-4ee0-b96c-e9c906598a77" /></div> | **🖼️ 图片内联预览**<br/><div align="center"><img width="420" alt="图片内联预览" src="https://github.com/user-attachments/assets/f9a58c30-5b7a-48b5-9e22-37d7e071f593" /></div> |
| **💻 真实终端**<br/><sub>xterm.js + node-pty 真实 shell（不是模拟器）：断线重连 transcript 回放、shell / shellArgs 可配置（设置页或 `cordis.patch.yml`）、可选为模型注入 `terminal_*` 工具（agent 可直接开终端跑命令）。</sub><br/><div align="center"><img width="420" alt="真实终端" src="https://github.com/user-attachments/assets/0dad6ad3-ff3f-4b5a-86d2-f832ce65323e" /></div> | **🌿 Git 面板**<br/><sub>暂存 / 取消暂存 / 提交（`Ctrl+Enter`）/ 还原，历史列表；点击改动文件打开 **VSCode 式 diff tab**（红绿行级对比）。</sub><br/><div align="center"><img width="420" alt="Git 面板" src="https://github.com/user-attachments/assets/e7fc1220-305f-4bca-8583-e77ab4f4fa78" /></div> |
| **🌐 内嵌浏览器**<br/><sub>多开网页 tab：后退 / 前进 / 刷新 / 地址栏；内容运行在**不透明源沙箱 iframe**（界面实时显示沙箱状态，可按页面临时解锁）；聊天里的外链点击可被接管到侧边栏打开（按协议分流，可配）。</sub><br/><div align="center"><img width="420" alt="内嵌浏览器" src="https://github.com/user-attachments/assets/9bc6b65a-64fc-4942-a685-76e391e55606" /></div> | **🧩 任务页：子代理拓扑 + 后台任务**<br/><sub>子代理树实时拓扑（运行状态、批量实时预览）+ 后台任务清单（退出码 / 实时输出 / 强制终止）；新子代理 / 新任务可自动展开侧边栏（可关）。</sub><br/><div align="center"><img width="420" alt="任务页：子代理拓扑" src="https://github.com/user-attachments/assets/dcd8ed2f-59fa-405b-937b-2d250f5034dd" /></div> |
| **💬 侧边对话(beta)**<br/><sub>Codex 风格侧边线程：**每个对话一个独立 Tab**；线程继承主会话完整上下文（含进行中回合，以 interrupted 诚实冻结）独立运行，不污染主会话；可持续追问、重启冷恢复；一键「保存为新会话」提升为顶层会话。</sub><br/><div align="center"><img width="420" alt="侧边对话(beta)" src="https://github.com/user-attachments/assets/3a338c36-f5de-4000-95f3-4b1cd04f60fc" /></div> | **🪟 双工作台：右侧栏 + 底部面板 + 分栏**<br/><sub>右侧栏与底部面板可同时展开；拖 Tab 到分栏边缘**拆分**、拖到中间**合并**（可跨面板）；面板宽高左缘/上缘拖拽调节；移动端自动合并为全宽抽屉；把 tab 拖到主会话区域可变为**自由窗口**（悬浮 / 缩放 / 置顶，拖回 pane 停靠）。</sub><br/><div align="center"><img width="420" alt="双工作台（右侧栏 + 底部面板）" src="https://github.com/user-attachments/assets/dfdb875e-a1a8-4d4b-8340-353736b1708f" /></div> |
| **⚙️ 声明式设置**<br/><sub>设置页「侧边卡片」分区：每个 tab / 预览器一张小卡片，独立开关（高亮启用态 + 品牌开关滑块）；二级设置经卡片底部「功能设置」条弹窗（开关 / 文本 / 数字 / 下拉）；插件自有设置持久化在 `pluginSettings`。</sub><br/><div align="center"><img width="420" alt="声明式设置：侧边卡片" src="https://github.com/user-attachments/assets/0800ca64-621e-48da-b7df-aecfddc3ec29" /></div> | **📱 移动端**<br/><sub>窄屏（<768px）自动切换为全宽抽屉：底栏 tab 一次性并入右侧栏，触屏拖拽可调。</sub><br/><div align="center"><img width="360" alt="移动端全宽抽屉" src="https://github.com/user-attachments/assets/a82ba78a-f4cf-4d85-80e8-050a05beb144" /></div> |

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

GitHub topic [`dsh-better-sidebar`](https://github.com/topics/dsh-better-sidebar) 下已有 **28+ 生态插件**（持续增长中）：

<div align="center">
  <a href="https://github.com/user-attachments/assets/d4385b7e-aab4-425d-a5c4-2da5da81a34e"><img width="66%" alt="设置页「添加插件」弹窗：推荐插件目录 + 一键复制安装命令" src="https://github.com/user-attachments/assets/d4385b7e-aab4-425d-a5c4-2da5da81a34e" /></a><br />
  <i>设置页「侧边卡片」内置「添加插件」弹窗：推荐目录 + 一键复制安装命令 + 直达 GitHub topic</i>
</div>

### 📑 Tab 插件（注册侧边栏页面）

<details>
<summary><b>24 个插件（点击展开）</b></summary>

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
| [dong-victor/dsh-better-sidebar-starter](https://github.com/dong-victor/dsh-better-sidebar-starter) | <img alt="stars" src="https://img.shields.io/github/stars/dong-victor/dsh-better-sidebar-starter?style=flat&color=4d6bfe" /> | 运行配置页：IDEA 式 Run/Debug 配置（npm / springboot / python / custom）——一键启动、历史保存、WebSocket 实时日志（ANSI 彩色）、多实例并行、进程树跨平台杀死 |
| [baosfeng/my-dsh-plugins](https://github.com/baosfeng/my-dsh-plugins) | <img alt="stars" src="https://img.shields.io/github/stars/baosfeng/my-dsh-plugins?style=flat&color=4d6bfe" /> | 个人多插件合集（`dsh-file-activity`）：侧边栏文件活动页——记录文件读取 / 新增 / 修改历史与统计，按文件夹平铺，点击用原生预览打开 |

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
<summary><b>2 个插件（点击展开）</b></summary>

| 插件 | ⭐ | 简介 |
|---|---|---|
| [dong-victor/dsh-better-sidebar-terminal-plus](https://github.com/dong-victor/dsh-better-sidebar-terminal-plus) | <img alt="stars" src="https://img.shields.io/github/stars/dong-victor/dsh-better-sidebar-terminal-plus?style=flat&color=4d6bfe" /> | 终端增强：内嵌 Nerd Font 图标字体、修复 xterm 图标渲染、稳定终端 cwd |
| [Max-Null/dsh-sidebar-preview-select](https://github.com/Max-Null/dsh-sidebar-preview-select) | <img alt="stars" src="https://img.shields.io/github/stars/Max-Null/dsh-sidebar-preview-select?style=flat&color=4d6bfe" /> | 预览划选增强：侧边栏预览里划选文本 → 浮动「发送到会话」 |

</details>

> 📣 **上架你的插件**：给仓库打上 `dsh-better-sidebar` topic 即出现在 [topic 页](https://github.com/topics/dsh-better-sidebar)；再向 [`src/client/plugins-tabs.ts`](./src/client/plugins-tabs.ts) / [`src/client/plugins-viewers.ts`](./src/client/plugins-viewers.ts) 提一条 `PluginEntry` PR，即可进入设置页内置推荐目录（数据完整性由 `tests/plugin-list.spec.ts` 守护）。

## 🆕 最近更新

**支持的 DSH 版本**：<a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="支持的 DSH 版本：0.1.0-rc.8 · 0.1.1-rc.1 · 0.1.1-rc.2" src="https://img.shields.io/badge/DSH-0.1.0--rc.8_%C2%B7_0.1.1--rc.1_%C2%B7_0.1.1--rc.2-4d6bfe" /></a> · 完整发布历史见 [Releases](https://github.com/omdsh-dev/DSH-better-sidebar/releases)

### v0.16.1

自 v0.16.0 以来的全部更改：

**🐛 修复**

- 🧊 **Git 面板卡死 + 重启死循环**（[#376](https://github.com/omdsh-dev/DSH-better-sidebar/pull/376)，修复 [#369](https://github.com/omdsh-dev/DSH-better-sidebar/issues/369)）：开启「源代码管理」面板可能整页冻结、重启后自动恢复冻结状态且无法退出——三层无上限操作叠加所致，现已全部设界：**① status 截断**——`git status --untracked-files=all` 响应上限 2000 条（超限置 `truncated`，面板显示截断提示，对齐 `fs.read` 截断语义；worktree 变更计数同步有界），海量未跟踪文件不再冻结浏览器主线程；**② 仓库发现限界**——cwd 非 Git 仓库（如家目录）时不再对每个可见子目录串行无界探测：探测超时 30s→5s、子目录探测上限 200 个、并发请求共享同一次扫描并按 60s TTL 缓存，家目录不再引发 `git rev-parse` 进程风暴；**③ 重置逃生通道**——带 `?dsh-sidebar-reset` 打开页面即丢弃持久化布局（含共享宽度）从默认布局启动，即使原页面已卡死也能自救，移除参数后恢复持久化；`statusTruncated` 文案同步全部 19 个词典

### v0.16.0

自 v0.15.2 以来的全部更改：

**✨ 新功能**

- 🪟 **自由窗口**（[#354](https://github.com/omdsh-dev/DSH-better-sidebar/pull/354)）：把标签栏的任意 tab（内置或插件注册）**拖到主会话区域**——会话列出现虚线提示浮层，松开即成为悬浮窗口（默认 390×780，手机竖屏比例，创建时按视口钳制后居中于松点）；窗口支持头部拖动移动、右下角 SE 缩放（≥320×200）、点击任意处置顶、头部右键「回到侧边栏 / 关闭」、X 走 `closeTab` 正常关闭生命周期（释放终端等）；拖到侧边栏 pane 上时该 pane 高亮、松开即**停靠**合并回该 pane；`floats` 随会话持久化（刷新原样恢复，宽容 sanitize + 几何钳入视口）；服务语义：`features` 新增 `'floatWindows'`——`openTab` 的 dedupe/id 聚焦命中浮动 tab = **置顶窗口**（不重复开、不展开面板），`closeTab` / `activateTab` 对浮窗正常关窗 / 置顶并照常触发回调，浮窗内 tab `visible` 恒 true，agent 终端 reconcile 覆盖浮窗；tab 内容复用常规渲染、插件 tab 与 pane 完全同契约；附带文件二级页面 8px 网格间距规整（[设计文档](docs/plans/2026-08-23-free-window-design.md)）
- 📂 **模型主动打开（`sidebar_open` 工具）**（[#353](https://github.com/omdsh-dev/DSH-better-sidebar/pull/353)）：侧边栏新增全局设置 `agentOpenTools`（**默认关闭**），开启后向模型注入**一个**工具——模型可在调用方会话的侧边栏打开本地**文件**（editor tab，按 path 去重）、**文件夹**（全窗树窗口，以该目录为根，`meta.dir`）与 **HTTP(S) 网页**（browser tab，URL 预填）；关闭设置即注销工具并清空未投递队列，已打开 tab 保留；非激活会话的打开排队、下次可见时重放（`/sidebar/ws/agent-opens` 推送，同一 trust fence）；无新增公共 API、不改变 `BetterSidebarService`（[设计文档](docs/plans/2026-08-23-agent-open-tools-design.md)）
- 📝 **Markdown README 级内嵌 HTML + 目录大纲（TOC）**（[#360](https://github.com/omdsh-dev/DSH-better-sidebar/pull/360)）：Markdown 预览现在真实渲染**块级内嵌 HTML**——徽章墙 `<div align=center>`、`<details>` 折叠块内嵌 markdown、表格单元格 `<br/>`/`<sub>`/`<img>`、`<video>`/`<picture>` 全部经 DOMPurify 白名单消毒（`<script>` 等活性内容剥除、`<a>` 强制 `_blank rel=noopener`），本地媒体 src 重写为会话媒体路由；≥3 标题出现浮动**目录大纲**按钮，点击平滑滚动并自动展开折叠 `<details>`，HTML 段内标题同样收录；渲染器仍是宿主 `MarkdownText`（shiki / KaTeX / GFM 保留），纯 markdown（零 HTML）文档走原路径零回归（[设计文档](docs/plans/2026-08-24-markdown-html-toc-design.md)）
- 🌏 **第三语言覆盖（19 语言）**（[#339](https://github.com/omdsh-dev/DSH-better-sidebar/pull/339)）：接入可选 peer `@huanlin/dsh-plugin-better-locale`——ja / de / fr / pt / ko / ar / hi / id / tr / vi / th / ru / it / nl / sv / pl / zh-HK / zh-TW / zh-MO 全量词典（每种约 340 keys）；覆盖**借用 DSH 英文槽位**（DSH active=en 时生效，zh 下完全惰性、界面不混语言）；19 语言词典同时注册进 better-locale，外部 `ctx.locale.lookup('betterSidebar', key)` 调用者同样可拿覆盖文本；未安装时 `ctx.get('betterLocale')` 为 undefined、整段 no-op，zh/en 行为不变
- 🌿 **Git 多仓库选择 + linked worktree 变更发现**（[#326](https://github.com/omdsh-dev/DSH-better-sidebar/pull/326) [#285](https://github.com/omdsh-dev/DSH-better-sidebar/pull/285)）：会话 cwd 是工作区容器（非 Git 仓库）时自动发现直接子仓库并显示**仓库选择器**——status / 分支 / 历史 / diff / 暂存 / 提交 / 还原 / cherry-pick / 文件打开全部按所选仓库线程化；linked worktree 的变更发现与按工作树操作（含延迟分页响应的事务一致性），并拒绝过期 / 可修剪的 worktree 命令目标、对单库存取失败降级
- 🖥️ **浏览器本地回环允许清单**（[#365](https://github.com/omdsh-dev/DSH-better-sidebar/pull/365)）：新增侧边卡设置 `browserAllowedLoopback`（逗号分隔 host 或 host:port；裸 host 匹配任意端口、带有端口精确匹配）——显式信任的本地开发服务器（如 Vite）可导航，并额外获得 iframe `allow-same-origin` 令牌（模块 / HMR / fetch 管线需要真实 origin，否则白屏）；页面相对 GUI 与其他站点仍是跨源；服务端 `browser.probe` 镜像同一允许清单，本地服务器不再被误拒
- 📝 **编辑器 Vue + 28 种 legacy 语言语法高亮**（[#202](https://github.com/omdsh-dev/DSH-better-sidebar/pull/202)）：`.vue` 映射 `@codemirror/lang-vue`（template / script / style 按 `lang` 属性分派、`<style lang="scss">` 预处理器）；零新依赖用 legacy-modes 补齐 scss/sass/less/stylus/ruby/lua/perl/r/dart/scala/groovy/powershell/diff/protobuf/cmake/pug/tcl/haskell/clojure/erlang/julia/pascal/vb/vhdl/stex/objectivecpp；语言工厂抛错降级纯文本（console.warn），不再炸编辑器；`.v` / `.m` 跨语言歧义故意不映射
- 🔄 **编辑器预览刷新三件套**（[#215](https://github.com/omdsh-dev/DSH-better-sidebar/pull/215) [#228](https://github.com/omdsh-dev/DSH-better-sidebar/pull/228)，修复 [#167](https://github.com/omdsh-dev/DSH-better-sidebar/issues/167)）：文本预览新增**手动刷新**按钮；编辑保存后切回预览自动重载（dirty 时抑制，草稿不丢）；预览模式下保存成功边沿自动重载；移除自动轮询与 `fs.stat` 版本端点（后台 API 零流量）
- 🖼️ **Markdown 本地 / 相对图片**（[#292](https://github.com/omdsh-dev/DSH-better-sidebar/pull/292)）：`![alt](./img.png)`、`/cwd/img.png` 与引用式 `[id]: url` 目标重写为 `/sidebar/file` 媒体 URL（会话 cwd 边界不变）——预览不再只显示 alt 文本
- ➕ **推荐插件目录新增 ego-browser**（[#340](https://github.com/omdsh-dev/DSH-better-sidebar/pull/340)）：`@dsh-external/ego-browser` Agent 浏览器 Tab（会话侧边栏自动注册本机浏览器页，无 better-sidebar 时回退浮动浮窗）；描述词典 19 语言补全（[#371](https://github.com/omdsh-dev/DSH-better-sidebar/pull/371)）

**🐛 修复**

- 🛒 **DSH 市场受管安装兼容**（[#338](https://github.com/omdsh-dev/DSH-better-sidebar/pull/338)）：移除 `peerDependencies` 里的公开版 `cordis`（市场预览硬拒依赖字段出现 `cordis`，optional 无效）——npm 包满足 [dsh-community-market 安装规范](https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/dsh-community-market/docs/install-and-uninstall.zh.md)，dshfind / 1024Store 目录里的条目重新获得 `repository_backlink` 验证目标，可直接从 Desktop 市场受管安装
- 🔤 **类型基底迁移到 `@deepseek-ai/cordis`**（[#338](https://github.com/omdsh-dev/DSH-better-sidebar/pull/338)）：`Context` = 真实 vendored cordis Context 与结构化服务面的**交集**，`ctx.betterSidebar` 类型合并改挂 `@deepseek-ai/cordis`，公开版 cordis 不再被依赖。**消费者迁移**：`import type { Context } from 'cordis'` 改为 `import type { Context } from '@deepseek-ai/cordis'`（`import type {} from 'dsh-better-sidebar'` 的类型合并方式不变）；未使用该导入的插件无影响
- 🧩 **插件树内 `ctx.betterSidebar` 读取全面修复**（[#357](https://github.com/omdsh-dev/DSH-better-sidebar/pull/357)，修复 [#356](https://github.com/omdsh-dev/DSH-better-sidebar/issues/356)）：npm 安装的 DSH 0.1.1-rc.x（web bundle）下侧边栏页面每次加载即崩（`cannot get property "betterSidebar" without inject`）——26 处内部直读 `ctx.betterSidebar` 改走 `ctx.get('betterSidebar')`（root reflect store 解析，不受 fiber 链影响）；外部消费者 `inject: ['betterSidebar'] + ctx.betterSidebar` 契约不变
- 🔐 **文件 API 会话工作区边界**（[#345](https://github.com/omdsh-dev/DSH-better-sidebar/pull/345)，修复 [#328](https://github.com/omdsh-dev/DSH-better-sidebar/issues/328)）：`fs.tree / fs.read / fs.write` 的 workspace 越界访问修复；媒体、HTML 预览与上传统一 real-path 符号链接校验；新增绝对路径 / 符号链接 / 上传 / 嵌套 Git 会话回归测试
- 🪟 **面板宿主层级与视口裁剪**（[#330](https://github.com/omdsh-dev/DSH-better-sidebar/pull/330) [#278](https://github.com/omdsh-dev/DSH-better-sidebar/pull/278)，修复 [#277](https://github.com/omdsh-dev/DSH-better-sidebar/issues/277)）：面板宿主层 z-index 40→25——低于 DSH cordis 动态插件面板 30，工作台不再遮挡 cordis 清单 / 审批面（AppFrame 20 之上、100+ 浮层之下）；宿主 `overflow: hidden` 裁剪视口边缘，收起的面板不再把文档撑出双向滚动（实测 `scrollWidth` 2289→1672 / `scrollHeight` 1280→1032，任意皮肤）
- 📐 **布局推挤加固**（[#310](https://github.com/omdsh-dev/DSH-better-sidebar/pull/310) [#130](https://github.com/omdsh-dev/DSH-better-sidebar/pull/130) [#180](https://github.com/omdsh-dev/DSH-better-sidebar/pull/180)）：对话列补 `min-height: 0` + `overflow: hidden` + `overflow-wrap: anywhere`（长不可断 URL / OAuth 链接不再把 composer 与左侧设置按钮挤出视口）；layout-push effect 拆「仅设置 + 仅卸载移除」并按 `panelOpen` 门控宽度 push——右栏关闭时拖底部高度不再挤压对话区、松手瞬间不再整页右铺再回弹；`useLayoutEffect` 消除跨 paint 全宽闪帧；松手 flush 最终帧 + `centerRect.right` 同步提交；底部高度按 `viewportHeight - PANEL_MIN` 封顶；拖拽手柄拖动中不再高亮
- 📱 **移动端无会话状态说明 + 1px 溢出修复**（[#254](https://github.com/omdsh-dev/DSH-better-sidebar/pull/254)）：无会话时开关改用 `aria-disabled` 保持不可执行语义、同时允许触摸 / 键盘聚焦显示「选择一个会话以使用侧边栏」提示；panel 改 `border-box`——移动端 `100vw` 含左边框，不再产生 1px 横向溢出
- 📏 **侧边栏宽度跨会话共享**（[#36](https://github.com/omdsh-dev/DSH-better-sidebar/pull/36)）：面板宽度是布局偏好而非会话内容——「最后一次拖拽胜出」写入全局 `dsh-sidebar:v1:width`，缓存会话切换与新建会话即时跟随；无全局键（首次运行 / 旧会话）时行为逐字节不变
- 🧹 **会话删除立即关闭该会话终端**（[#130](https://github.com/omdsh-dev/DSH-better-sidebar/pull/130)）：新增 `PtyManager.closeSession()` + 订阅 DSH `session/disposed`——删除会话不再等 30s 重连宽限到期（agent 终端由 agent 生命周期管理，不受影响）
- 🔍 **文件名搜索跳过噪声目录**（[#342](https://github.com/omdsh-dev/DSH-better-sidebar/pull/342)）：`node_modules` / `.pnpm-store` / `.yarn` / `.turbo` / `.next` / `dist` / `build` / `coverage` 等黑名单（小写不敏感，`.git` 仍跳）——超大依赖树不再耗尽 10 万访问预算提前 `truncated`，`docs/` 等后序目录里的真实文件能搜到；不引入 `.gitignore` 语义，保持「文件名查找」
- 📝 **mermaid 全局错误渲染抑制**（[#341](https://github.com/omdsh-dev/DSH-better-sidebar/pull/341)）：开启 `suppressErrorRendering`——非法图表不再把大错误 SVG 注入 `document.body`；组件级错误回退与源码展示保留
- 🖥️ **终端 Nerd Font 图标字体回退**（[#190](https://github.com/omdsh-dev/DSH-better-sidebar/pull/190)）：starship / powerlevel10k 提示符的补充平面 PUA 图标（Nerd Fonts v3 Material 图标集）不再显示豆腐块——`withIconFontFallbacks()` 为胜出的基础字体追加 Nerd Font 图标族（插入首个通用族之前、按族名去重、过滤 CSS 全局关键字、不列彩色 emoji 字体）
- 🌐 **HTML 预览 UTF-8 声明**（[#193](https://github.com/omdsh-dev/DSH-better-sidebar/pull/193)，修复 [#170](https://github.com/omdsh-dev/DSH-better-sidebar/issues/170)）：`/sidebar/html` 响应带 `charset=utf-8`（无 `<meta charset>` 的中文片段不再乱码），保留原始文件字节
- 🧪 **trust-fence Origin 改按 hostname 比较**（[#182](https://github.com/omdsh-dev/DSH-better-sidebar/pull/182)）：Edge 151 把非默认端口 loopback 页面的 Origin 序列化为无端口形式——`http://127.0.0.1` 对 `Host: 127.0.0.1:3080` 不再 403（对齐 DSH 官方网关栅栏）；不同 hostname / opaque null origin 仍拒绝
- 🪟 **「在文件夹中显示」改为资源管理器揭示**（[#94](https://github.com/omdsh-dev/DSH-better-sidebar/pull/94)）：不再把目录当文件开进编辑器（`"..." is a directory`）——`revealInExplorer` 切到资源管理器 tab、面板折叠时自动展开、展开父目录并高亮滚动到本轮产出文件；产物行数据改读引擎 Turn deliverable（与 ui-deliverables 同源）
- 🖱️ **面板拖动布局闪烁**（[#180](https://github.com/omdsh-dev/DSH-better-sidebar/pull/180)）：右侧栏关闭时拖底部高度不再左移挤压对话区；松手瞬间不再整体右铺再回弹
- 🖥️ **PowerShell 安装脚本修复**（[#47](https://github.com/omdsh-dev/DSH-better-sidebar/pull/47)）：远程入口统一为「下载脚本 → 移除 UTF-8 BOM → 内存执行」，`-Version` / `-DryRun` 参数在 Windows PowerShell 5.1 下恢复生效（BOM 解析不再吃掉首行 `param(...)`）；安装前校验 `pnpm --version`（主版本 <10 时明确报错并以退出码 1 结束，不再写一半 profile）
- 🔄 **浏览器嵌入探测 GET 兜底**（[#69](https://github.com/omdsh-dev/DSH-better-sidebar/pull/69)）：HEAD 响应同时缺 CSP 与 X-Frame-Options 时回退 GET 重试一次——阿里云百炼等只在 GET 回头发嵌入策略的站点不再显示误导性「拒绝连接请求」，而是正确显示「该站点拒绝嵌入」面板 + 「在浏览器中打开」
- 🔧 **git 源安装修复 `unrun` devDependency**（[#336](https://github.com/omdsh-dev/DSH-better-sidebar/pull/336)）：tsdown 0.22 经 `unrun` 加载配置而 pnpm 11 不自动装 peer——git-hosted 安装的 `prepare` 不再报 `Failed to import module "unrun"`（npm tarball 不受影响）
- 🍃 **`ctx.effect` 严格化顺手修了 4 处**：拦截注册失败时 effect 体返回 `undefined` 改为 no-op disposer（vendored cordis 的 effect 契约要求返回 disposer，返回 `undefined` 属非法形状）

<details>
<summary><b>历史版本（v0.12.0 – v0.15.2）</b></summary>

### v0.15.2

自 v0.15.1 以来的全部更改：

**✨ 新功能**

- 🗂️ **文件树「在应用中打开」子菜单**（[#334](https://github.com/omdsh-dev/DSH-better-sidebar/pull/334)）：文件树右键菜单新增「在应用中打开 >」子菜单——内置打开方式（资源管理器显示/选中、VS Code、Cursor、Zed），每行右侧图钉可固定为右键菜单顶层直达项（再点取消）；配置可选 SSH host 后 VSCode 系条目改用 `vscode-remote/ssh-remote+<host>/<path>` 协议打开，本地专用条目自动隐藏；支持自定义编辑器（名称 + URL 模板 `{path}` + 是否 VSCode 系，配置入口在 Files 卡片齿轮弹窗）。打开动作经新宿主路由 `POST /sidebar/api/open.external`（argv 数组 spawn，无 shell 注入）（[设计文档](docs/plans/2026-08-22-open-with-menu-design.md)）
- 📑 **Tab 右键菜单**（[#331](https://github.com/omdsh-dev/DSH-better-sidebar/pull/331)）：页签右键提供「关闭 / 关闭其他页签 / 关闭左侧页签 / 关闭右侧页签」，作用范围为当前 pane（标签组），无可关对象时置灰；仅打开菜单、不切换激活页签；批量关闭逐条走既有 `onClose` 路径，生命周期完整
- 📄 **Diff 文件默认折叠**（[#270](https://github.com/omdsh-dev/DSH-better-sidebar/pull/270)）：改动文件头部改为可访问的展开/折叠控件；识别出的源文件默认展开，测试 / 文档 / 生成文件 / lockfile 与未知类型默认折叠；保留现有 500 行上限
- 📖 **README 更新**：特性巡礼改为表格展示（每行两张图，节省空间）；社区补全微信群 / QQ 群二维码（[#325](https://github.com/omdsh-dev/DSH-better-sidebar/pull/325)，QQ 群 577011007）

**🐛 修复**

- 🪟 **空分栏清理**（[#268](https://github.com/omdsh-dev/DSH-better-sidebar/pull/268)）：持久化的 split pane 在临时 diff tab 被清理后遗留全尺寸空分栏——`sanitizeState` 现在同时修剪空的 split leaf，并修复修剪后的失效激活 pane 指针；整个工作台为空时保留唯一空 pane
- 🖥️ **Windows 下隐藏 Git 子进程窗口**（[#301](https://github.com/omdsh-dev/DSH-better-sidebar/pull/301)，关闭 [#124](https://github.com/omdsh-dev/DSH-better-sidebar/issues/124)）：`runGit()` 统一加 `windowsHide: true`，仓库状态轮询与操作不再闪现控制台窗口（其他平台行为不变）
- 📁 **未跟踪文件夹内文件差异**（[#242](https://github.com/omdsh-dev/DSH-better-sidebar/pull/242)）：`git status` 从 `--untracked-files=normal` 切换为 `--untracked-files=all`——新文件夹内每个文件独立成行、可正常加载差异（修正 `fs.read` 报 "is a directory"，与 VSCode 默认行为一致）
- ⚡ **开关/拖拽每帧 React 重渲染消除**（关闭 [#315](https://github.com/omdsh-dev/DSH-better-sidebar/issues/315)）：centerRect 改 ref + 底栏 DOM 直写（零 React 渲染）；TabContent memo（显式比较器）；新增 frame-batcher 对 Divider/dock 拖拽按帧合并；拖拽期跳过无意义 locate。4x CPU 节流 A/B：开关 >17ms 帧 collapse 19→6 / expand 24→4~6，p95 21ms→15ms；拖拽不变（非回归）

### v0.15.1

自 v0.15.0 以来的全部更改：

**✨ 新功能**

- 💬 **侧边对话 Codex 风格转录重构**（[#314](https://github.com/omdsh-dev/DSH-better-sidebar/pull/314)）：转录改为**折叠行**——工具调用 / 思考 / 上下文注入统一为安静的单行 chrome（chevron + 标签 + 单行参数摘要，展开为 hairline 缩进正文，无卡片无填充），流式标签与创建 shimmer（shimmer = 生成中）、失败工具 danger、`prefers-reduced-motion` 停帧；**首条问题不再被边界提示吞掉**——上下文注入与首问拆分交付（边界 + 快照经 `agent.inject` 排队、问题唤醒驱动），转录把注入映射为可折叠注入行、真实用户消息（**含首问**）渲染为用户气泡，旧线程的首问同样拆分为独立气泡
- 📖 **README 重写**：功能导览（逐特性实机截图）、用户视角 DSH 兼容徽章、简化安装流程（`add` → `approve-builds` → `add`、node-pty 安全构建、粘贴到 DSH 安装提示）、插件生态 28+ 与分类折叠展示

**🐛 修复**

- 🖥️ **终端跨会话切换保活**（[#323](https://github.com/omdsh-dev/DSH-better-sidebar/pull/323)）：切到其他会话不再被当作瞬时掉线——客户端卸载时发送 `park` 控制帧，主机跳过 30s 重连宽限倒计时；切回会话（`open()` 取消 parked）或显式关闭恢复正常生命周期；agent 终端保持无限期存活
- 📂 **文件树上传遮罩不再拦截 Tab 拖拽**（[#317](https://github.com/omdsh-dev/DSH-better-sidebar/pull/317)）：拖拽 Tab（重排 / 跨 pane split）经过资源管理器时不再弹上传遮罩、不吞事件——统一按 `dataTransfer.types` 含 `Files` 门控（与面板宿主 shield 一致），Tab 正常落下；OS 文件拖拽行为不变
- 💬 **子代理自动展开去抖**（[#314](https://github.com/omdsh-dev/DSH-better-sidebar/pull/314)）：Side Chat 线程创建不再误弹任务页——0→N 触发 500ms 重臂并对实时快照按原基线重评估，标题过滤器识别线程后才放行；真实子代理依然自动展开

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
- 🔐 **文件 API workspace 边界加固**（[#328](https://github.com/omdsh-dev/DSH-better-sidebar/issues/328)）：`fs.tree/read/write`、媒体、HTML 预览和上传统一按真实路径限制在会话 workspace 内，拒绝越界绝对路径与外链符号链接

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
- 🖼️ **Markdown 预览支持本地/相对路径图片**：预览 `.md` 时把指向本地文件的图片目标（相对/绝对路径、引用式 `[id]: url`）重写为 `/sidebar/file` 媒体 URL 并显示（此前仅绝对 http(s) 图片能渲染，相对路径只显示 alt 文本）
- 🐛 **node-pty 加载失败不再拖垮 server**（[#140](https://github.com/omdsh-dev/DSH-better-sidebar/issues/140)）：宿主半改为懒加载 node-pty，缺失时插件照常挂载，终端以修复提示横幅（可复制命令 + 重试按钮）呈现，agent 终端工具自动跳过
- 🧪 测试工程：单元测试拆分（#141）+ smoke 偶发失败修复

</details>

## 💬 社区

推荐添加QQ群(577011007)

<div align="center">
  <img width="220" alt="微信群二维码" src="https://github.com/user-attachments/assets/39caafc7-9629-4b13-bb2b-eac17eab5b6a" />
  <img width="220" alt="QQ群二维码" src="https://github.com/user-attachments/assets/9be34629-26ef-4537-aad4-1393c147f81c" />
</div>

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

- Git 无 push/pull/fetch；Markdown 预览提供手动刷新按钮，刷新未保存编辑前会确认是否丢弃草稿；无文件 watcher/自动轮询；工具行内文件打开按钮不可拦截
- 终端 Tab 拖到另一分栏会重挂载（shell 重开）
- Office 三件套预览（.docx/.xlsx/.pptx）已移至「推荐插件」（Office 预览插件，见设置页「添加插件」弹窗）；未安装时此类文件走代码/下载查看兜底
- 浏览器沙箱无登录态/第三方 Cookie 受限，部分站点登录需走弹窗；被 `X-Frame-Options`/`frame-ancestors` 拒绝嵌入的站点（如 arxiv.org）显示原因面板（含「在浏览器中打开」）；iframe 内部跳转不进后退栈
- HTML 预览渲染的是已保存文件（不反映未保存草稿）
- 移动端（<768px）无底部面板：进入窄屏时其标签页一次性并入右侧栏（迁移后回桌面仍保留在右侧栏），桌面端的底部面板只在宽视口下可用；移动端底部首展自动开终端不触发。未选中会话时，点按弱化开关会显示选择会话提示；选中会话后开关打开全宽抽屉

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
