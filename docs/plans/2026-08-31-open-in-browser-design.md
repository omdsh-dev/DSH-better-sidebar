# 编辑器「在浏览器中打开」按钮（open in browser）

日期：2026-08-31

> 取代已 reset 的「预览 / 下载新 Tab」方案（2026-08-29，未合入）。旧方案的教训：对 `.md`/`.yaml` 等文本文件，浏览器只能 plain text 预览（无语法高亮），「先预览再下载」体验差。新方案收窄范围：**只对浏览器能原生渲染的类型**提供新 Tab 打开，且入口从文件树右键移到**编辑器 header**。

## 功能定义

文件在侧边栏编辑器打开时，header 右上角按钮组由 3 个（保存 / 刷新 / 文件树面板）变为 4 个：

```
保存 / 刷新 / 在浏览器中打开 / 文件树面板
```

- 「在浏览器中打开」仅在**当前匹配的 viewer 声明了浏览器可渲染 URL** 时出现（内置：image / pdf / html）；
- 点击 `window.open(url, '_blank', 'noopener')` 在真实浏览器新 Tab 打开；
- 图标与文案复用 BrowserView 的现成组合：`VscLinkExternal` + `t('browserOpenExternal')`（i18n 零新增，行为一致）；
- 文件树右键菜单的「下载」（强制落盘）**保持原样不动**。

## 实现

### 1. 声明式能力：`FileViewerDescriptor.browserUrl`（`src/client/service.ts`）

```ts
export interface FileViewerDescriptor {
  // …既有字段…
  /**
   * Browser-renderable URL for "open in browser" (new-tab). When present the
   * editor header shows the open-in-browser button; absent = the browser
   * cannot meaningfully render this type (text/code/binary) and the button
   * stays hidden.
   */
  browserUrl?: (scope: SessionScope, path: string) => string
}
```

可选字段，外部插件 viewer 同享（吃自己的狗粮）。

### 2. 内置 viewer 接线（`src/client/builtins/viewers.tsx`）

| viewer | browserUrl | 路由 |
|---|---|---|
| `image` | `mediaUrl(scope, path)` | `/sidebar/file` inline（图片原生渲染） |
| `pdf` | `mediaUrl(scope, path)` | `/sidebar/file` inline（浏览器 PDF 查看器） |
| `html` | `htmlUrl(scope, path)` | `/sidebar/html`（自带 CSP sandbox，顶层打开仍在 opaque origin） |
| markdown / code / binary-download | （不声明 → 按钮不出现） | — |

### 3. EditorHost header 按钮（`src/client/EditorHost.tsx`）

- 显示条件：`load.status === 'ready' && load.viewer.browserUrl !== undefined`（binary/loading/error/folder 态均无）；
- 位置：refresh 与 tree toggle 之间；
- 行为：`window.open(load.viewer.browserUrl(scope, path), '_blank', 'noopener')`（点击即用户手势，不触发弹窗拦截）；
- `aria-label`/`title` = `t('browserOpenExternal')`。

### 4. Host 安全加固（`src/index.ts`，必须与按钮同 PR）

`image` viewer 的 exts 含 **svg**——`image/svg+xml` 作为顶层文档可执行 `<script>`，而 `/sidebar/file` 的 inline 响应此前只在 `<img>`/sandbox iframe 内消费，无任何安全头部。按钮让该 URL 首次被顶层导航，工作区恶意 svg 将与 GUI **同源**执行（localStorage/token 失窃）。

加固：inline（非 `download=1`）响应统一追加，对齐 `/sidebar/html` 的头部策略：

- `content-security-policy: sandbox allow-scripts allow-downloads; object-src 'none'`（opaque origin；图片/PDF 渲染不受影响）；
- `x-content-type-options: nosniff`；`referrer-policy: no-referrer`。

`download=1`（attachment）分支不变。抽 `mediaHeadersFor(path, download)` 纯函数供单测（沿用 reset 前 commit 的同名设计，但**不含**文本 MIME 映射 / NUL 嗅探 / inline 文件名——那些是旧方案的教训，本期不做）。

### 5. 文档（「接入 API 即文档」）

- `docs/external-plugin-guide.md` §5：`FileViewerDescriptor` 字段表加 `browserUrl`；内置 viewer 清单补「image/pdf/html 支持在浏览器中打开」；`/sidebar/file` 路由说明补 inline 安全头部契约。

### 6. 测试

- `tests/builtins.spec.ts`：image/pdf/html 描述符的 `browserUrl` 存在且产出对应路由 URL；markdown/code/binary-download 无该字段。
- `tests/editor-host.spec.tsx`：注册带 `browserUrl` 的 fake viewer（`fetchStrategy: 'none'` 直达 ready 态，沿用现有 toolbar 测试套路）→ header 出现「Open in browser」按钮，点击调 `window.open`（stub）且参数为 `(url, '_blank', 'noopener')`；无 `browserUrl` 的 viewer → 按钮缺席。
- `tests/file-route.spec.ts`（新建）：`mediaHeadersFor` inline 分支带 CSP/nosniff/no-referrer、无 disposition；attachment 分支带 UTF-8 文件名、无 CSP。

## 取舍记录

- 文本/代码/二进制**不提供**新 Tab 打开（浏览器无语法高亮，plain text 预览无价值）——旧方案的核心教训。
- html 的新 Tab 打开**始终**走 sandbox（CSP 头），不受 `htmlViewerNoSandbox` 设置影响——该设置只管编辑器内 iframe 的 sandbox 属性，顶层导航必须保持隔离。
- svg 经图片 viewer 获得按钮；其顶层脚本风险由 inline CSP 沙箱兜底（允许脚本运行但处 opaque origin）。

## 验证

- `pnpm vitest run tests/editor-host.spec.tsx tests/builtins.spec.ts tests/file-route.spec.ts tests/locales.spec.ts`；`pnpm typecheck`；`pnpm build`。
- 手工：打开 png/pdf/html 文件 → header 出现第 4 按钮 → 点击新 Tab 原生渲染；打开 md/ts/zip → 按钮不出现；svg 新 Tab 打开后 DevTools 确认 opaque origin。

## 分支与流程

`feat/preview-download` 已被 reset 至 main；本特性改用 `feat/open-in-browser` 分支 + PR（AGENTS §1）。
