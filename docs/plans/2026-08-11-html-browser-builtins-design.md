# 内置 HTML 预览器 + 内嵌网页浏览器（沙箱化）设计

**日期**：2026-08-11
**状态**：已批准，已实施
**作者**：opencode + 用户
**当前版本**：v0.4.3（main `35cde82`）
**目标版本**：v0.5.0

## 1. 目标

在 `dsh-better-sidebar` 内按既有 builtins 模式新增两个内置能力：

1. **`html` 文件预览器**：`.html`/`.htm` 文件在侧边栏编辑器中默认以真实渲染预览（相对资源可加载），可切换代码编辑（CodeMirror HTML 高亮 + 保存）。
2. **`browser` 浏览器 tab**：`+` 菜单新增「浏览器」页面，地址栏输入 URL 在沙箱 iframe 中浏览，支持后退/前进/刷新，URL 与标题按 tab 持久化。

安全问题为第一优先级（用户显式要求"注意安全问题"）：所有渲染走**不透明源沙箱 iframe**，host 侧新增 `/sidebar/html` 路由带 CSP + 信任围栏 + cwd 边界。另按用户追加要求提供**关闭沙箱的子设置**（默认关闭该设置；开启需明确勾选，设置项与界面都带安全警告文案）。

## 2. 复用门（dsh-reuse-first）

`NO EXISTING CAPABILITY`：已搜索 DSH checkout（docs/*-catalog、apps/web、packages 源码——sidecar/iframe/webview/html preview/CSP 均无等价物；`WorkspaceBrowser` 只是目录树）与 dsh-external org hub 目录（browser/html/webview/iframe/sidecar/viewer/preview 均 0 命中）。全新实现，落点为本仓库 builtins（用户已确认）。

## 3. 威胁模型与安全基线

| 威胁 | 对策 |
|---|---|
| 恶意 HTML/网页读取 GUI 数据（localStorage、`/sidebar/api`、同源 cookie） | iframe 一律 `sandbox` 且**不含 `allow-same-origin`** → 文档源为不透明源（null）。**禁止 srcdoc**（srcdoc 在无沙箱时继承父源），一律 route-src |
| 预览/浏览内容劫持 GUI 页面（top 导航） | 不含 `allow-top-navigation` / `allow-top-navigation-by-user-activation` |
| 表单 CSRF 打到本地服务 | html 预览器 iframe **不含 `allow-forms`**；浏览器 tab 含 `allow-forms`（登录流必需，残余风险见 §9） |
| 浏览器 tab 访问内部地址（GUI 自身、localhost、127.0.0.0/8） | 地址栏导航前客户端阻断（`browser.ts` 纯函数）；`javascript:`/`data:`/`file:` 等非 http(s) 一律拒绝 |
| 预览页脚本请求 `/sidebar/api` | 三层：不透明源 fetch 被 CORS 拒读；信任围栏拒 `sec-fetch-site: cross-site`；`Origin: null` 无法伪造同源 |
| 敏感信息泄露给被浏览站点 | iframe `referrerPolicy="no-referrer"`；权限策略 `allow=""`（拒绝 camera/mic/geolocation 等一切策略特性） |
| 直接顶层打开 `/sidebar/html/*` URL（弹窗等） | 路由响应带 `Content-Security-Policy: sandbox ...; object-src 'none'`，顶层同样被沙箱化 |
| 路径逃逸 | 路由复用 `requireAbsolute` + `isWithin(cwd, path)` + `mediaLimit` 上限 + 信任围栏 |
| 关闭沙箱（用户主动选择） | 每功能独立子设置（`htmlViewerNoSandbox` / `browserNoSandbox`，默认 false）；设置文案 + 渲染时持久警告条双警告 |

## 4. 变更清单

### 4.1 host：`/sidebar/html` 路由（src/html-route.ts 新 + src/index.ts）

URL 采用**路径编码**（无 query）——WHATSG URL 解析对纯路径相对引用会丢弃 base 的 query，query 式 URL 下 `./style.css` 会丢失 session 作用域：

```
/sidebar/html/<sessionId>/<绝对路径逐段 encodeURIComponent>
例：/sidebar/html/S/Users/me/proj/index.html
    ./style.css → /sidebar/html/S/Users/me/proj/style.css ✓
    Windows: C:\Users\me\a.html → /sidebar/html/S/C%3A/Users/me/a.html
```

- `src/html-route.ts`（无依赖纯模块，client 可导入不触发纯度门）：`encodeHtmlUrl(sessionId, path)`、`decodeHtmlUrl(pathname)`（404 错前缀；400 空路径/双斜杠/畸形编码/缺 sessionId 或文件路径/空段）。
- `src/index.ts`：注册 `/sidebar/html` prefix 路由（fence → GET 校验 → decode → `requireAbsolute` → `isWithin(cwd)` → stat isFile + `mediaLimit` → 读文件），响应头：
  `content-type`（新增 `.html`/`.htm` → `text/html` 到 MEDIA_TYPES）、`cache-control: no-cache`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Content-Security-Policy: sandbox allow-scripts allow-popups allow-downloads allow-modals; object-src 'none'`。
- cwd 语义与媒体路由一致：session store 权威；会话附着前的首请求回退 `process.cwd()`，通常被 `isWithin` 拒绝（可接受）。

### 4.2 client：`html` 预览器（TextEditor.tsx 扩展 + builtins/viewers.tsx）

- descriptor：`{ id:'html', exts:['html','htm'], priority:0, fetchStrategy:'fsRead', settings.toggles:[htmlViewerNoSandbox] }`。
- TextEditor：`markdown || html` 都显示预览/编辑切换；html 预览分支渲染：
  `<iframe src={htmlUrl(scope,path)} sandbox="allow-scripts allow-popups allow-downloads allow-modals" referrerPolicy="no-referrer" allow="" />`
  - 导出 `HTML_IFRAME_SANDBOX` 常量（测试钉死）；沙箱关闭时 `sandbox` 属性整体移除 + 渲染 `sandboxWarning` 警告条。
  - 预览显示**已保存文件**（route-src），不反映未保存草稿（有意取舍，文档化）。

### 4.3 client：`browser` tab（BrowserView.tsx 新 + browser.ts 新 + builtins/tabs.tsx + state.ts）

- state.ts：`SidebarState.nextBrowser`（默认 1；sanitize 对缺失/畸形值回退 1，旧持久化布局继续加载）；新 reducer `patchTab(state, tabId, {title?, path?})`。
- tabs.tsx：`{ id:'browser', order:50, settings.toggles:[browserNoSandbox], createTab: 铸造 browser:<n> + nextBrowser 递增 }`。
- browser.ts（无依赖纯模块）：`isLoopbackHostname`（localhost/::1/0.0.0.0/127/8）；`normalizeBrowserUrl(input, selfOrigin)`：
  - 无 scheme → 补 `https://`；`://` 完整 URL 走解析后协议兜底；已知危险 scheme 前缀（javascript/data/file/about/...）直接拒绝；`host:port` 形态（如 `example.com:8080`）不被误判为 scheme。
  - 拒绝顺序：协议 → 自身 origin **放行**（GUI 自身可在侧边栏打开，沙箱不透明源兜底；须先于 loopback 判定，因其主机通常就是 loopback）→ loopback 阻止 → ok。
- BrowserView：地址栏（后退/前进/刷新/输入/前往）+ iframe + 状态行；URL 经 `patchTab` 持久化到 `tab.path`/`tab.title`（hostname）；历史栈仅记录地址栏导航（iframe 内部跳转跨域不可见，已知限制）；无 URL 时显示起始页（不自动加载任何站点）。
  - iframe：`sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox"`（导出 `BROWSER_IFRAME_SANDBOX`；无 allow-same-origin / allow-top-navigation；allow-popups-to-escape-sandbox 供 OAuth 弹窗）；沙箱关闭时移除属性 + 警告条。
  - 常驻底部小字沙箱说明（`browserHint`）。

### 4.4 设置（prefs-shared.ts + config.ts + SideCardSection 声明式渲染）

- `SidebarPrefs` 新增 `htmlViewerNoSandbox` / `browserNoSandbox`（boolean，默认 false）；`SIDEBAR_PREFS_DEFAULTS` 与 `PrefsSchema` 同步；`parsePrefs` 按字段校验回退。
- 声明式设置：html viewer 行与 browser tab 行各自 `settings.toggles`，设置页自动渲染（父级关闭时隐藏），文案含「（不安全）」+ 后果说明。

### 4.5 其他

- `api.ts`：`htmlUrl(scope, path)` = `encodeHtmlUrl(sessionId, path)`。
- `icons.tsx`：`IconHtmlOutline16`（文件 + `‹/›`）、`IconGlobeOutline16`（地球）。
- `locales.ts`：zh/en 双份新键（viewerHtml/browser/浏览器栏/阻止原因/沙箱提示/设置文案）。
- `sidebar.module.css`：`sandboxWarning`、`editorHtml`、`.browser*` 系列。

## 5. 测试

| 文件 | 覆盖 |
|---|---|
| tests/html-route.spec.ts（新） | 编码/解码往返（POSIX/Windows/特殊字符）、相对解析保持同路由同 session、404/400 拒绝、遍历段留给 isWithin |
| tests/browser.spec.ts（新） | 补 https、host:port 不误判、危险 scheme/loopback 拒绝、自身 origin 放行、invalid |
| tests/sandbox-views.spec.tsx（新） | iframe sandbox 常量钉死（无 allow-same-origin/top-navigation）、route-src 非 srcdoc、referrer/allow 属性、沙箱关闭 → 无 sandbox 属性 + 警告条、markdown 分支回归、浏览器起始页不自动加载 |
| tests/builtins.spec.ts | 7 tab / 9 viewer 清单、html 扩展名匹配、browser createTab 铸造与 nextBrowser、两个 toggles 声明 |
| tests/unit.spec.ts | nextBrowser sanitize（缺失/畸形回退 1）、patchTab 更新/无操作、parsePrefs 新字段默认与校验 |
| tests/smoke.spec.ts | fenced routes 清单 + `/sidebar/html` |

## 6. 版本与文档

- 版本 0.4.3 → 0.5.0（package.json + dsh.plugin.json 同步，manifest-consistency 守卫）。
- README/AGENTS 内置清单更新为 7 tab + 9 viewer。

## 7. 验收标准

1. `pnpm typecheck && pnpm build && pnpm test` 全绿（245 用例）。
2. 手动：打开 `.html` 默认预览渲染（相对资源可加载），可切编辑/保存；`+` 菜单浏览器 tab 多开、地址栏浏览、后退/前进/刷新、刷新页面恢复 URL 与标题。
3. 安全：预览/浏览 iframe 无 allow-same-origin/top-navigation；`javascript:`/`data:`/`file:`/localhost/127.x 均被阻止并提示（自身 origin 允许）；`/sidebar/html` 越界 403、超限 400、跨站 403；预览页 fetch `/sidebar/api` 读不到（CORS），预览器表单被沙箱禁（无 allow-forms）。
4. 关闭沙箱开关：设置页勾选后界面出现持久警告条，iframe 无 sandbox 属性。

## 8. 实施偏差记录

- 设计初期考虑过 srcdoc + `<base>` 注入以实现"预览反映未保存草稿"，因 srcdoc 无沙箱时继承父源的致命风险与 base 注入的脆弱性，改采 route-src（预览 = 已保存文件）；相对资源经路径编码 URL 天然解析，无需内容改写。
- `normalizeBrowserUrl` 的 scheme 判别：朴素正则会把 `example.com:8080` 误判为 scheme，最终采用「`://` 完整 URL + 危险 scheme 黑名单 + 解析后协议兜底」三段式。
- `nextBrowser` 在 sanitize 中为宽松字段（缺失/畸形回退 1），避免旧持久化布局整体失效（与严格校验的 `nextTerminal` 不同）。
- **UNC 路径编码标记（PR #134 整合 #79/#115 时）**：`/sidebar/html` 对 `\\server\share\...` / `//server/share/...` 采用 sessionId 后的 `//` 标记，且解码统一重建为**前斜杠** `//server/share/...` 而非反斜杠——`node:path` 在 win32/POSIX 上分别解析为 `\\server\share\...` / `/server/share/...`，因此无需任何平台信号；原「400 双斜杠」约束改为「首个空段仅作 UNC 标记，其余空段仍 400」。

## 8.1 追加需求（2026-08-11，v0.5.0 内）

1. **设置页滚动**：`SideCardSection.module.css` 的 `.section` 填满设置壳 options 区并内部滚动（`height:100% + min-height:0 + overflow-y:auto`），7 tab + 9 viewer 卡片再多也不会被裁切。
2. **沙箱状态实时显示 + 临时解锁**：新增 `SandboxStatusBar`（HTML 预览与浏览器 tab 共用）——沙箱开启显示绿色状态 + 「临时解锁（不安全）」按钮；关闭（全局设置或本页临时解锁）显示**红色警示**（`state-error-primary` 色系 + 危险文案）与「恢复沙箱」按钮（仅临时态）。临时解锁是组件内 state，不写回全局设置，随页面/标签卸载失效；iframe 随沙箱翻转重挂载。
3. **聊天/界面外链在侧边栏打开**：新设置 `browserInterceptLinks`（默认开，受浏览器 tab 启用开关 gate）——`link-intercept.ts` 在 document capture 阶段拦截 http(s) **外部**链接点击（同源/非 http(s)/修饰键点击一律放行），经 `openTab({type:'browser', url, title: hostname})`（openTab seed 新增 `url` 字段：落地后 patchTab 预填 path）在侧边栏打开。浏览器 tab 地址栏新增「在浏览器中打开」按钮（`window.open(url,'_blank','noopener')`，用户手势触发，等价真实浏览器新标签）。

## 8.2 追加需求（2026-08-11 二轮，v0.5.0 内）

1. **HTML「默认非安全」二级设置**：`htmlViewerDefaultUnsafe`（默认 false）——打开 HTML 文件时预览**初始**处于非沙箱状态（localUnlock 初始值取自该 pref），状态行仍可一键「恢复沙箱」；与 `htmlViewerNoSandbox`（全局强制关闭，不可界面恢复）语义区分。
2. **沙箱状态行单行化并取代底部说明**：浏览器 tab 底部常驻 `browserHint` 条移除，说明并入 `SandboxStatusBar` 开启态文案（「沙箱模式：已启用 · 页面无法访问界面数据与本地文件，登录态与第三方 Cookie 可能不可用」），状态行 `nowrap + ellipsis + title` 恒为一行；关闭态同样单行红色警示。
3. **「在浏览器中打开」图标放大**：`IconRightUpOutline14` → `IconRightUpOutline16`（15px 渲染）。

## 8.3 追加需求（2026-08-11 三轮，v0.5.0 内）

1. **图标改 15px**：`<IconRightUpOutline16 size={15} />`。
2. **嵌入拒绝面板**：站点通过 `X-Frame-Options` / CSP `frame-ancestors` 禁止嵌入时，浏览器 tab 不再显示空白拒绝框，而是显示 `BrowserEmbedBlocked` 面板——「{host} 拒绝了嵌入请求」+ 原因说明 + 「在浏览器中打开」（`window.open`）+ 「仍然加载」两个按钮。检测：新增 host 路由 `browser.probe`（HEAD→GET 兜底，8s 超时，仅 http(s) 非 loopback，返回目标响应头的 `x-frame-options`/`frame-ancestors`，受信任围栏保护）+ 客户端 `embeddabilityOf` 判定（XFO DENY/SAMEORIGIN 或 frame-ancestors 不含 `*` → blocked；探测失败 → unknown 保持普通 iframe）。探测在每次导航（含恢复的 path）时经 `useEffect(url)` 触发；「仍然加载」以 `forceEmbed` 保留普通 iframe。

## 9. 已知限制与残余风险

- 浏览器沙箱无登录态/第三方 Cookie 受限（SameSite=Lax 在跨站 iframe 不发送），部分站点登录需走弹窗（allow-popups-to-escape-sandbox 已开）。
- iframe 内部链接跳转不进后退栈（跨域不可见）；被 `X-Frame-Options`/`frame-ancestors` 拒绝的站点显示空白（站点策略，无法绕过）。
- 用户主动浏览的恶意站点仍可在沙箱内发起盲 GET（无法读取响应）到本地服务；站点重定向链可把 iframe 带到 localhost（内容仍沙箱化、受围栏保护）。
- 关闭沙箱后预览/浏览内容获得 GUI 同源权限（可读会话文件/本地存储/调内部接口）——仅建议对完全可信内容开启，设置与界面双重警告。
