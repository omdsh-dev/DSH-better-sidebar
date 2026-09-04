# 文件树「打开方式」子菜单设计（2026-08-22）

> 状态：已实现（分支 `feat/open-with-menu`）。本文档记录功能设计、关键取舍与实施偏差。

## 目标

文件树（`FileTree`）右键菜单新增「在应用中打开 >」子菜单：

- 内置 **资源管理器（在文件管理器中显示）、VS Code、Cursor、Zed** 四个打开方式；每个子菜单行右侧有**图钉**，点击可把该方式固定为右键菜单的**顶层直达项**（再点取消固定）。
- **远端 SSH**：设置中配置可选 SSH host（`user@host` 或 `~/.ssh/config` 别名）。非空即整个工作区视为远端：VSCode 系条目（VS Code / Cursor / 自定义且勾选"VSCode 系"）改用 `<scheme>://vscode-remote/ssh-remote+<host>/<path>` 打开；本地专用条目（资源管理器 / Zed / 非 VSCode 系自定义）从菜单隐藏。
- **自定义编辑器**：名称 + URL 模板（`{path}` 占位符，如 `cursor://file/{path}`）+ 「是否 VSCode 系」开关；配置入口在**侧边栏设置 Files 卡片齿轮**（与既有 `editorExplorer` 下拉同一弹窗）。
- 打开动作经宿主新路由 `POST /sidebar/api/open.external` 执行（argv 数组 spawn，无 shell 注入），浏览器模式与 DSH Desktop 行为一致；**不经过** `ctx.workspaces.openPath`（该入口已被 `wrapOpenPath` 劫持到侧边栏编辑器，见 `src/client/openpath-intercept.ts`）。

## 调研结论（reuse gate）

- DSH checkout（`~/.dsh/source/current`）无"文件树 open-with"、无 SSH 远程会话、无 `vscode://` 开启器；`host.openPath` 只能"默认应用打开"，无法指定编辑器、无 reveal/select 语义 → 需要新增。
- dsh-external hub 无同类成品；`dsh-open-in-vscode` 是工作区行菜单、依赖外部 slot，不适用。
- primitives `Menu` 原生支持 `submenu?: readonly MenuItem[]`（子项点击走 `onSelect(child.id)`），`label: ReactNode` 可内嵌图钉；无现成图钉/品牌图标 → 引入 `react-icons`（`vsc` codicons 图钉 `VscPin`/`VscPinned` 与文件树 `VscFile`/`VscFolder(Opened)`、`si` 品牌剪影 Cursor/Zed、菜单父行 `VscLinkExternal`），VS Code 品牌剪影因 simple-icons 后期版本受微软商标政策下架而内嵌自 simple-icons@11.0.0（CC0，`IconVscode16`）；菜单行图标统一 16px 与 DSH 原生菜单一致，子菜单父行的 `>` chevron 由 label 内右对齐元素提供（基元不渲染）。⚠️ react-icons 的 exports 把 `require` 排在 `import` 前，tsdown 共享 conditionNames 会选中不可树摇的 CJS 入口（bundle +6.4MB）——`tsdown.config.ts` 用 `resolve.alias` 钉死 `si`/`vsc` 的 ESM 入口，树摇后仅 +12KB。

## 数据模型

持久化在 `pluginSettings['editor'].openWith`（宿主 schema 的开放 map，无需改 PrefsSchema）：

```json
{
  "openWith": {
    "sshHost": "",
    "customEditors": [
      { "id": "custom:<uuid>", "name": "Windsurf", "urlTemplate": "windsurf://file/{path}", "isVscodeFamily": false }
    ],
    "pinned": ["vscode", "custom:<uuid>"]
  }
}
```

- `parseOpenWithConfig`（`src/client/open-with.ts`）容错解析：坏行丢弃、未知 pinned 在解析目标时剪枝；**结构合法但未填完的行（空 name/模板）保留**——设置面板正在编辑的行必须能在弹窗往返中存活，由菜单侧的 `isValidCustomEditor` 过滤。
- 目标 id：内置 `explorer` / `vscode` / `cursor` / `zed`；自定义 `custom:<uuid>`。
- URL 构建：
  - 本地：模板原文替换 `{path}`（`vscode://file//home/u/f.ts`——POSIX 绝对路径自带前导 `/`，与 VS Code 官方文档 `vscode://file/c:/…` 的约定一致；反斜杠归一化为 `/`）。
  - SSH（VSCode 系）：`<scheme>://vscode-remote/ssh-remote+<host>/<path>`，路径保留前导 `/`（如 `…+dev/home/u/f.ts`，与社区约定一致）。
  - 模板无 `scheme://` 或无 `{path}` → 返回 undefined（不打开）。

## 菜单结构（文件行与目录行一致）

```
在新 Tab 中打开                    ← 既有
在侧边打开                        ← 既有
----------------------------
VS Code            (SSH)         ← pinned 直达项（按内置顺序 + 自定义追加）
Cursor             (SSH)
----------------------------
在应用中打开 >                    ← 子菜单父项（始终在 pinned 之后）
   资源管理器      📌
   VS Code         📌(激活)
   Cursor          📌(激活)
   Zed             📌
   Windsurf        📌
下载                             ← 既有（仅文件行）
复制相对地址 / 复制绝对地址         ← 既有
```

- 图钉是 `label` 内的 `<span role="button" tabIndex={-1}>`（Menu 行本身是 `<button>`，嵌套原生 button 不合法）；`stopPropagation` + `preventDefault` 使其**不关闭菜单、不触发行选择**，点击后经响应式 blob 重渲染立即翻转。
- 未接线（props 缺省）或 SSH 过滤后无目标 → 整个区块隐藏，旧行为/旧测试不变。

## 设置面板：`settings.render` seam 扩展

**实施偏差（与最初"render 独占"契约不同，需同步文档）**：`SettingsBody`（`src/client/SideCardSection.tsx`）原先"有 `render` 就整个替换行列表"。本功能需要**行列表（`editorExplorer` 下拉）与自定义面板共存**，因此把 seam 改为：

> `render` 给定时**追加**渲染在行列表（`toggles` / `pluginToggles`）之后；未声明行列表时与旧行为一致（单独渲染）。

- 仓库内无既有 render 使用者，`tests/side-card-section.spec.tsx` 无"render 独占"断言，风险可控；`AGENTS.md` §3.1/§5 与本文档同步更新。
- 面板组件 `OpenWithSettings`：SSH host 输入 + 自定义编辑器行（名称/模板/VSCode 系/删除）+「添加」；每次变更整体提交 `updatePluginSetting('openWith', next)`（含 pinned 原样保留）。
- 图钉写入走 `src/client/plugin-settings.ts` 的 `updatePluginSettings`：Promise 链串行化 + `api.settingsUpdate` 后 `store.setPrefs(parsePrefs(view.value))`，避免快速连点丢写。（设置弹窗内部有自己独立的串行 commit，二者极少重叠。）

## 宿主路由

`POST /sidebar/api/open.external`（`src/index.ts` `buildApi`，与其他方法同 fence + 错误包裹）：

```ts
{ action: 'reveal', path }  // 在文件管理器中显示/选中
{ action: 'url', url }      // 交给注册的协议处理器
```

- `src/open-external.ts`：纯函数 `revealCommand` / `urlCommand`（platform 可注入，单测覆盖三平台）+ `launchExternal`（`spawn(..., { detached: true, stdio: 'ignore' })` + `unref`）。
- `reveal`：darwin `open -R`；win32 `explorer.exe /select,`；linux `xdg-open <父目录>`（无统一 select 协议，KISS 打开所在目录）。
- `url`：darwin `open`；win32 `rundll32 url.dll,FileProtocolHandler`（备选 `cmd /c start ""`）；linux `xdg-open`。
- 校验：`reveal` 路径必须绝对（`requireAbsolute`）；`url` 必须是 `scheme://` 自定义协议（拒绝 http/https）。
- **Windows 平台命令为约定实现，需在 Windows 实机验证**（本机为 macOS；CI 覆盖 linux）。

**实施偏差（2026-09，#517 / PR #522）**：SSH 远程编辑器链接**不再经宿主路由执行**。DSH 部署在无头远端服务器时，宿主侧 `xdg-open` 无 DISPLAY/无编辑器，`vscode://` 静默失败。`api.openExternal`（`src/client/api.ts`）现把 `<scheme>://vscode-remote/ssh-remote+…` 形态的 URL 在浏览器客户端同步触发 `window.location.assign`（处于用户点击链内，外部协议交给本机编辑器经 Remote-SSH 打开远端文件）；reveal 与本地编辑器 URL 仍走本节宿主路由。普通浏览器可处理自定义协议；禁止/未处理 `vscode://` 的 WebView 壳客户端需各自适配（见 #517 补充信息）。

## 已知限制

- 路径含 `#`/`?` 的文件名经 URL 打开可能被浏览器当作 fragment/query（不处理，注释说明）。
- 编辑器未安装/协议未注册：由 OS 弹提示或静默失败，不做安装检测。SSH 客户端分支同理——浏览器端 `location.assign` 无法探测协议 handler 是否存在，仍返回 `{started: true}`。
- 自定义编辑器仅支持 URL 模板式，不支持 CLI 命令式；无 `{dir}` 占位符。
- Linux reveal 退化为打开所在目录（精确 select 需要各文件管理器私有协议）。
- SSH 模式为**全局**（非每会话）：DSH 无远程会话概念，文件树路径即宿主路径；该模型对应"DSH 跑在远端开发机上"的场景。

## 测试

- `tests/open-with.spec.ts`：解析容错、目标解析与 SSH 过滤、URL 构建（本地/SSH/custom/坏模板）、校验器。
- `tests/open-external.spec.ts`：三平台命令表、URL 校验、spawn 前校验。
- `tests/open-external-client.spec.ts`（#522）：SSH remote URL 客户端分流（不触 fetch）、本地/reveal/http(s) 留宿主、导航抛错 reject。
- `tests/file-tree-open-with.spec.tsx`（jsdom）：右键 → 子菜单/图钉；pin 不选中不关闭；选子项回调关闭菜单；SSH 标签后缀；未接线隐藏。
- `tests/open-with-settings.spec.tsx`：SSH 输入、添加/删除（删除剪枝 pinned）、无效提示、VSCode 系开关。
- `tests/side-card-section.spec.tsx`：`SettingsBody` 行列表 + render 共存、仅 render 时不变。
- `tests/builtins.spec.ts`：editor 描述符断言补 `settings.render`。
- 全量 `pnpm test`（810 passed）、`pnpm typecheck`、`pnpm build` 全绿；未跑挂载冒烟（由 CI plugin-mount 门禁覆盖）。
