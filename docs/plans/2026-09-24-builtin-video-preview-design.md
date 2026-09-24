# 内置视频预览设计（`video` viewer + 媒体路由字节范围）

## 目标

侧边栏打开视频文件即预览，且**不依赖生态插件**：

1. 双击文件树里的 `.mp4` / `.webm` / `.mov` / `.mkv` / `.avi` 等，落在插件自己的预览面（原生 `<video controls>`），不是下载卡；
2. 播放器能拖进度条 —— 即 `/sidebar/file` 对 `Range` 请求回 `206 Partial Content` + `Content-Range`；
3. 大文件不被图片那档 20MB `mediaLimit` 挡住 —— 视频走自己的 `videoLimit`，并按流（`createReadStream`）下发，不整文件进内存；
4. 浏览器解不了的容器 / 编码不留下"黑框死路"：回退到下载入口，并写出宿主拒绝的真实原因。

## 为什么是 video（而 image / pdf 不是）

DSH 0.1.7 的 `ui-sidebar-documentpreview` 已经自带 code / excel / office / pdf / image / html / markdown / text 预览（带缩放与按目录自动刷新），所以插件按 §3.2 第 5 条让出了 image / pdf / binary-download 三个 viewer，并在 `editor.canOpen` 里拒绝认领那些扩展名。

**视频是宿主没有的那一格**：`ui-sidebar-documentpreview` 没有视频渲染器，生态里的做法是让读者再装一个 `dsh-video-preview`（PR #126 进的推荐目录），而那个插件需要自己的 `/video` 路由，正因为本插件的媒体路由**不支持 Range**。所以这里按同一条判据（"宿主不等价才自己留"）内置视频：一个 viewer + 把媒体路由补上 Range。

## 宿主：媒体路由升级为字节范围流

新增纯模块 `src/media-route.ts`（无 Node 流 / HTTP 对象，可单测）：

- 内容类型表补视频（mp4/m4v/webm/ogv/ogg/mov/qt/mkv/avi/wmv/flv/m2ts/mpeg/mpg/3gp/3g2），`mediaTypeForPath` 语义不变（未知 → `application/octet-stream`）；
- `VIDEO_EXTENSIONS` / `isVideoPath`：视频扩展名决定用哪条上限；
- `parseRangeHeader(header, size)`：RFC 9110 §14.1.1/§14.2 的 `bytes=a-b` / `bytes=a-` / `bytes=-N`；多段只服务**第一个可满足**的段（浏览器对 `<video>` 只发单段；不实现 `multipart/byteranges`）；**格式非法 → 当没有 Range**（full，RFC 要求忽略），**形式合法但越界 → 416**；
- `contentRangeHeader` / `unsatisfiedContentRange` / `mediaETag(size, mtimeMs)` / `ifRangeMatches(etag|date)` / `headerValue`（Node 把重复头折成数组）。

`/sidebar/file` 处理器（`src/index.ts`）改为：

1. `limit = isVideoPath(path) ? resolved.videoLimit : resolved.mediaLimit`（`config.ts` 的 `LimitsSchema` 新增 `videoLimit`，默认 **2 GiB**；它是部署限额，非 volatile 偏好）；
2. 常量头 `accept-ranges: bytes` / `etag` / `last-modified` / `content-type` / `cache-control: no-cache`；
3. `If-Range` 不匹配 → 当作无 Range（发新整份，RFC 9110 §13.1.5）；否则按 `parseRangeHeader` 分派 **200（带 `content-length`）/ 206（带 `content-range` + 切片 `content-length`）/ 416（`bytes */size`）**；
4. `createReadStream(path[, {start,end}])` `pipe` 给响应；流错误 `destroy` 响应、响应 `close` `destroy` 流。响应对象的 `pipe`/`on`/`destroy` 不在 vendored 镜像类型 `SidebarHttpResponse`（只声明 JSON 路由子集）里 —— 与 WebSocket 升级处同样的做法：在该边界 `as unknown as ServerResponse` 一次，**不扩镜像、不引 Node 类型进 d.ts 图**；
5. `?download=1` 的 disposition 语义不变。

## 客户端：`video` viewer（第 4 个内置 viewer）

- `src/client/VideoView.tsx`：`<video controls preload="metadata" playsInline src={mediaUrl}>`；`onError` 或 `mediaUrl` 缺失 → 失败面板（复用 `binary-download` 的 `editorBinaryNotice` / `editorDownloadLink` + `downloadUrl`），文案 `mediaLoadFailed` + 原因；根节点带 `data-dsh-video-view="player" | "fallback"`。
- `src/client/media-failure.ts` 的 `failureReason(url)`：失败时**再探一次同一 URL**，读宿主 JSON 信封的 `error.message`（工作区栅栏 / 超限 / 会话不存在…），非信封回退 `HTTP <status>`，请求本身失败回退通用文案。裸 `<img>`/死播放器只会给浏览器自己的兜底（图片是 `alt` 文本＝文件名），这一层把原因说出来。
- `builtins/viewers.tsx`：`id: 'video'`，`exts` 与宿主 `VIDEO_EXTENSIONS` 同表，`fetchStrategy: 'mediaUrl'`，`title: () => t('viewerVideo')`，图标 `IconVideoOutline16`（`icons.tsx`，`currentColor`，符合皮肤契约）。
- 声明式设置面自动生效（`viewersEnabled` 开关 + 设置页清单），无需额外接线。

## 相对路径：会话作用域的地址可以是相对的

聊天打开"本轮产物文件"用的是 `dsh-resource://file/session/<id>/<相对工作区的路径>`。宿主所有路由只接受绝对路径（`requireAbsolute`；`ensureWorkspacePath` 只做 Windows/WSL 投影，不做 cwd 拼接），相对路径会被 400 拒绝——而浏览器对失败的 `<img>` 就画文件名。

- `src/client/native/file-tab.ts`（新）：`fileTabTarget(address, cwdOf)` 把地址→tab 路径按会话 cwd 解析成绝对路径（absolute scope、本来就绝对的路径、cwd 未知三种情况原样透传），`native/index.ts` 的 `fileParamsOf` / `fileSessionIdOf` 用它；
- `src/client/api.ts` 的 `absolutePath(scope, path)` 作为兜底覆盖 `mediaUrl` / `downloadUrl` / `fsTree` / `fsRead` / `fsWrite` / `fsRename` / `fsRemove`，外部调用者传相对路径也能到达宿主。

## i18n

新增 `viewerVideo` / `videoUnsupported` / `mediaLoadFailed`，**20 份词典全同步**（`locales.ts` 的 zh+en + 19 份第三语言），`tests/locales.spec.ts` 的键集相等断言即守护。

## 退役推荐插件 `dsh-video-preview`

两者 **viewer id 都是 `video`**，而 `service.registerFileViewer` 对重复 id **抛错**：内置之后再推荐第三方，等于给用户的是一条必然失败的安装路径。因此从 `plugins-viewers.ts` 目录移除该条目，并删除它的两个词条 `pluginVideoPreviewName` / `pluginVideoPreviewDesc`（20 份词典）。README 生态表保留该插件一行，但注明"已内置、勿同时安装（viewer id 冲突）"。

**若要回退这个决定**：恢复目录条目 + 两词条，并给其中一个 viewer 换 id。

## 语义后果

- 任何走 `/sidebar/file` 的响应多出 `Accept-Ranges` / `ETag` / `Last-Modified`；旧的"整文件一次性写入"变成流式，**下载路径（`?download=1`）语义不变**（仍 `Content-Disposition: attachment`，仍支持 Range 续传）。
- 视频上限默认 2 GiB，超出仍是 400（`not a file or too large`）；前端表现为失败面板（`<video>` 收到错误响应即 `onError`）。
- 浏览器解码能力是边界：`.mkv` / `.avi` / 部分 `.mov` 在 Chromium 下常常解不了 —— 这正是回退面板存在的原因，属预期行为。
- 让出的 image / pdf / binary-download 三个 id 仍然只由宿主渲染；`video` 不参与那条让出清单。

## 测试

- `tests/media-route.spec.ts`（新，22 例）：类型表 / `isVideoPath` / `headerValue` / Range 全边界（闭区间、越界钳制、开放端、后缀、大小写单位、越界 416、非法忽略、多段取首、空资源）/ `Content-Range` 格式化 / `ETag` 稳定性 / `If-Range` 两种形态。
- `tests/media-failure.spec.ts`（新）：JSON 信封 → 宿主消息；非信封 → `HTTP <status>`；请求失败 → 通用文案。
- `tests/media-path-resolution.spec.ts`（新）：`mediaUrl` / `downloadUrl` 与 `fileTabTarget` 的相对 / 绝对 / 无 cwd / 非地址四态。
- `tests/builtins.spec.ts`：内置 viewer 清单 3 → 4，新增 video 的 `exts` / `fetchStrategy` / 匹配断言（含 `clip.MKV`），并断言让出的 id 仍不在内置清单里。
- `tests/e2e/mount.e2e.ts`（真机挂载车道）：seed 一个 4 KiB `.mp4` 桩 → 经文件树打开 → 断言落在 `[data-dsh-video-view]`（player 或 fallback 皆可，无头 Chromium 无专有编解码器）→ 对同一路由发 `Range: bytes=0-3` 断言 **206 + `content-range: bytes 0-3/4096` + `accept-ranges` + `video/mp4`**，再发无 Range 请求断言 **200 + `content-length`**。

## 不做

- 不做音轨 / 字幕轨选择、画中画、倍速等播放器功能 —— 交给浏览器原生控件。
- 不做转码 / 缩略图 / 海报帧：需要 ffmpeg 依赖，与"插件零重依赖、纯 Node 流"的现状冲突。
- 不做 `multipart/byteranges` 多段响应（浏览器单段即可覆盖拖动进度条）。
- 不重新认领让给宿主的 image / pdf / binary-download。
