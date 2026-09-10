# 原生文件地址的相对拼法在媒体路由 400（#618）

日期：2026-09-10　分支：`fix/618-media-relative-path`　issue：[#618](https://github.com/omdsh-dev/DSH-better-sidebar/issues/618)（作者 @longisland-icetea）

## 问题

v0.19.0 迁到 DSH 原生右侧栏后，从**聊天里点开的文件**如果是靠 `mediaUrl` 渲染的，右侧栏就是空白/破图：图片、PDF、二进制下载、`.html` 渲染模式，以及 markdown 预览里的**本地图片**（同一通道）。文本、代码、md 正文的文本渲染正常。

触发入口**只有聊天那一侧**：DSH 的聊天漏斗在建文件地址时会带上 session cwd，于是工作区内的文件被写成**相对 session 根**的拼法；而插件自己的文件打开（文件树 / 产物 chip / 引用）不带 scope cwd，地址里保留的是**绝对**拼法 —— 后者不触发。

实测（同一份文件、两条入口，直接跑插件自己的 `fileAddressFor` + `parseFileAddress`）：

```
聊天打开（DSH 带 session cwd）
  address : dsh-resource://file/session/s1/docs/screenshots/x.png
  tab.path: docs/screenshots/x.png                              → 相对 → mediaUrl 400 ❌

文件树打开（插件 openTab 不带 scope）
  address : dsh-resource://file/session/s1//Users/y/…/docs/screenshots/x.png
  tab.path: /Users/y/…/docs/screenshots/x.png                   → 绝对 → mediaUrl 200 ✅
```

> 更正：issue #618 的复现步骤写作「从文件树（或聊天里的文件链接）点开该图片」，其中**文件树那半不成立**（上面第二行即反例）——照那条步骤走复现不了。

### 复现配方（可复制）

- **UI**：让模型 `write` 一个 `.svg`（文本可写 → 进 `produced` → 收尾消息里出现可点的蓝色行内代码链接；而 `.svg` 被插件当图片渲染 → 必走 `mediaUrl`）→ 点那条蓝链接 → 预览空白，DevTools Network 里 `sidebar/file` 是 **400**，`path=` 为相对拼法（无前导 `/`）。同一份文件从**文件树**打开 → 正常（`path=` 带前导 `/`）。
- **curl**（issue 原文，仍成立）：
  ```
  GET /sidebar/file?sessionId=<sid>&path=chart.png&cwd=/home/me            → 400 "chart.png" is not an absolute path
  GET /sidebar/file?sessionId=<sid>&path=/home/me/chart.png&cwd=/home/me   → 200 image/png
  GET /sidebar/html/<sid>/chart.html                                       → 400 cannot resolve target "/chart.html"
  ```

## 根因

发地址的一侧（DSH）与收地址的一侧（插件的媒体 / HTML 路由）对**同一份地址语法**的假定不一致：

1. `dsh-client-ui-chat` 的 `openFile` 注入：`fileAddressFor(sessionId, cwd, path)` —— **带** session cwd，工作区内的文件因此被相对化（`packages/util/workspace-path` 的 `fileAddressFor`：路径在 cwd 之下 → `sessionFileAddress(sessionId, 相对路径)`）。聊天里一切文件打开（工具行 / 产物行 / 正文提及 / 行内代码路径）都经这里。
2. 插件自己的打开：`src/client/service.ts:708` 用 `scope?.cwd` 建地址，而 `openSidebarFile()`（`src/client/intercept.tsx`）等调用点**不传 scope** → `cwd === undefined` → `fileAddressFor` 走 `root === ''` 分支，**保留绝对拼法**。这就是文件树不复现的原因。
3. `src/client/native/index.ts` 的 `fileParamsOf()` 把 `address.path` 原样交给 tab，于是 `tab.path` 就是地址里的拼法（0.18 及以前 tab 里恒为绝对路径）。
4. `src/client/EditorHost.tsx` 的 `mediaUrlOf = () => mediaUrl(scope, path)` 原样交给 `/sidebar/file` —— 该路由是全插件**唯一**硬性要求绝对路径的文件路由（`requireAbsolute`，`src/fs-tree.ts:129`）；`fs.read` 走 `resolveGitPath()`，相对路径会被 join 到 session cwd，所以坏的只有媒体这条通道。
5. `/sidebar/html` 是同一根因的另一面，且**宿主无法补救**：`encodeHtmlUrl` 丢掉前导 `/`、`decodeHtmlUrl` 再统一补成绝对路径，相对拼法在该语法里不可表达（`chart.html` 被当成 `/chart.html`）。

上游最新（`@deepseek-ai/dsh-client-ui-deliverables` 等 0.1.5-rc.1）没有相关改动，issue 检索确认本仓没有别的 PR 在做这件事。

## 方案（两处，互补）

- **宿主**：新增 `resolveWorkspaceTarget(cwd, target)`（`src/path-security.ts`）：绝对目标原样透传（工作区外的拼法交给围栏判定），相对目标 join 到 session 权威 cwd；`/sidebar/file` 在 `ensureWorkspacePath` 之前套用它。与 `fs.read` 的历史语义对齐，顺带覆盖「客户端 cwd 还没 hydrate」的窗口和第三方 `mediaUrl` viewer。
- **客户端**：`src/client/api.ts` 的 `fileUrl`（media / download）与 `htmlUrl` 统一经 `resolveSidebarPath(cwd, path)` 解析后再编码。/sidebar/html 只能靠这一处；媒体那处让 URL 在客户端 cwd 已知时就是绝对拼法。

围栏语义不变：join 之后仍走 `ensureWorkspacePath` 的 realpath + 包含检查（`../` 逃逸、工作区外绝对路径、指向外部的软链接照旧 403）。

## 归属与上游

触发点在**宿主**（聊天漏斗按相对拼法播地址），但插件侧容错是必须的：本仓硬约束不改 DSH 源码；而且相对拼法本就合法（`dsh-resource://file/session/<sid>/<path>` 对工作区内文件就是这么拼的），第三方 viewer 与「客户端 cwd 尚未 hydrate」的窗口同样会送相对拼法。可选的上游改法（DSH 无 issue 追踪，只能走 Discussions）：聊天漏斗改送绝对拼法，或在地址契约里写明两种拼法都必须被消费方接受。

## 验证

- 新增 `tests/media-relative-path.spec.ts`（10 例，假 ctx 挂真实路由 + 临时工作区）：相对路径无 cwd 参数 200、嵌套相对 200、绝对不变、`?download=1`、`../` 逃逸 403、工作区外绝对 403、缺失文件 400、软链接逃逸 403、**客户端 builder 产物直接喂给真实路由 200**、`htmlUrl` 产物喂给 `/sidebar/html` 200。把 src 三处改动 stash 掉后新用例 **17 例中 11 例失败**（宿主 7 + 客户端 4；剩下 6 例断言的是"绝对路径不变 / 无 cwd 时透传"这类既有行为）→ 用例确实咬住修复。
- 新增 `tests/media-url-relative.spec.ts`（7 例）：相对路径 join、Windows 反斜杠 cwd、绝对/工作区外绝对不变、无 cwd 时原样透传（宿主兜底）、html 相对与绝对拼法产出同一 URL。
- 地址拼法差异用上面的实测输出复核（`fileAddressFor` + `parseFileAddress`，两条入口各跑一次）。
- `pnpm typecheck` / `pnpm build` / 改动文件 `eslint` 全绿。
- 全量 `pnpm test`：**2 failed | 124 passed（29 例 `posix_spawnp failed`）**，与本机基线（stash 掉改动后跑同两个 pty 文件）**失败数完全一致**，属沙箱禁 pty 的环境性失败，无新增回归。

## 不做

- 不改 `markdown-images.ts`：它按 md 文件目录拼出的候选路径在 md 本身是相对拼法时也是相对拼法，本次宿主改动已覆盖。
- 不动 `/sidebar/html` 的地址语法（编码器改为可表达相对路径会破坏已发布 URL 的兼容性与相对资源解析语义）。

## 影响面 / 提醒

- **受影响**：从**聊天**打开的文件——图片 / PDF / 二进制下载 / `.html` 渲染模式 / markdown 预览里的本地图片（同一 `mediaUrl` 通道）。**不受影响**：从文件树 / 产物 chip 打开同一份文件（绝对拼法，200）；文本 / 代码 / md 正文。
- 客户端包由宿主以 `cache-control: public, max-age=31536000, immutable` 供给，修复要**硬刷新或重启宿主**才在浏览器生效；宿主侧改动重启即生效。
- 0.19.0 + DSH 0.1.5-rc.1 默认组合受影响；0.18.1 不受影响（那时 tab 里恒为绝对路径）。
