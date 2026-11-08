# 流式传输、原生打包、JSONL 预览与大文件分页预览

日期：2026-10-11
状态：已实施
分支：`feat/streaming-transfer-jsonl`（从 `dev` 切出）

---

## 1. 起因

三件看似无关、实则同一个根因的事：

1. **上传/下载有大小限制。** 上传其实早就端到端流式（`for await (chunk of req)` → 临时文件 → rename，见 `src/fs-operations.ts`），真正挡路的是两处 128 MB 常量；下载则整条路径都是 `readFile` → `res.end(buffer)`，配一道 20 MB 的 `mediaLimit` —— 大到足以让一个第三方插件（`dsh-video-preview`）把自己的存在理由写成「不受 20MB mediaLimit 限制」。
2. **`.jsonl` 完全没有支持。** `src/client/lang.ts` 没有映射，所以 JSONL 是纯白文本；而宿主 `dsh-util-code-language` 早就把 `jsonl`/`ndjson` 归到 JSON 了。更要命的是，直接映射到 `json()` 也不对——`@lezer/json` 的文法只接受**一个**顶层值，实测一个 400 条记录的文件会解析出 402 个错误节点。
3. **编辑器只有「全读」和「截断」两档。** 超过 `readLimit`（512 KiB）的文件被截成半份、标成只读、禁用保存。那个状态本身就是 #732 的成因：保存半份文档会毁掉文件尾部，所以只能禁止保存 —— 于是「能打开的文件存不回去」。

## 2. 设计

### 2.1 传输：不再有大小限制

**上传**只删掉了两道闸（客户端的 `MAX_UPLOAD_BYTES` 预检与宿主的逐块 `limit` 检查），流式核心、临时文件、失败清理一字未动。

**下载**新增 `src/file-stream.ts` 的 `streamFileToResponse`，`/sidebar/file` 与 `/sidebar/html` 改用它。关键不在 `createReadStream` + `pipeline`（那是常规做法），而在**写响应头的时机**：

```
open(stream) → await 'open' → writeHead(200) → pipeline(stream, res)
```

`writeHead` 会提交响应。先等 `'open'`，ENOENT / EACCES / EISDIR 就都发生在提交之前，仍然能变成插件自己的 JSON 错误信封；提交之后再失败（文件被换掉、客户端断开）就只能 `destroy()` —— 半条连接是唯一诚实的信号。配套给 `wire.ts` 的 `writeJson` 加了 `headersSent` 早退守卫：流中途失败时，路由的 catch 块会调 `writeError`，而后者会 `writeHead`，在已提交的响应上抛 `ERR_HTTP_HEADERS_SENT`，把一次「下载被截断」升级成「请求崩溃」。

`content-length` 取同一次 `stat` 的 `size`：浏览器的下载进度条需要它。

### 2.2 打包：交给系统命令

`src/zip.ts`（手写 ZIP：本地文件头、中央目录、CRC-32、原始 DEFLATE，约 300 行）被删除，换成 `src/archive-tools.ts`：

- 工具按 `zip` → `tar` 探测，结果按进程缓存。`zip` **恒带 `-y`**：不加它会**跟随**符号链接，一个 `a -> .` 的自指环会一直递归下去（实测过）；`-y` 把链接本身存进包。`tar` 是 Windows 的退路（10 1803+ 自带 `bsdtar`，而没有 `zip`）。
- `cwd` 取所有选择的**最深公共祖先**，参数是相对该目录的 `/` 分隔名。这替掉了旧版「按 basename 命名、冲突就逐段长出父目录」的算法：相对公共祖先的路径天然唯一，冲突消歧从一道算法变成了布局的性质。
- stdout 直接重定向到 OS 临时目录里的临时文件（`stdio: ['ignore', fd, 'pipe']`），**从不整包进内存**。

**为什么坚持「后台构建 → 轮询 → 一次性下载」而不是直接把 stdout 管到响应里**（后者代码更少）：直接管道意味着命令写到一半失败时，状态行早已提交，浏览器拿到的是一个 200 + 半份 zip，用户只会发现解压失败。写临时文件让「工具不存在 / 路径非法 / 退出码非 0」全部在下载开始前落地，正好保住现有那六个错误分支的语义。

代价说清楚：**`archive.status` 不再有 `done/total`**。子进程不报逐条目进度，而临时文件的大小是唯一的现成信号，所以状态收缩成 `{ state, bytes }`，界面退化为一句「打包中…」。凭空造一个条目计数意味着为了显示而多走一遍目录树。

### 2.3 保存：拆掉 1 MiB 的墙

`fs.write` 走 JSON，而 `/sidebar/api` 的 `MAX_BODY_BYTES = 1 MiB` 是硬顶 —— 所以 >1 MiB 的文件根本存不回去，512 KiB 的 `readLimit` 正是压在它下面。保存改为 `POST /sidebar/write` 的 **raw 路由**（文档即请求体），编码与行尾还原逻辑整体搬进 `src/fs-operations.ts` 的 `writeWorkspaceText`，一字未改。

宿主侧仍然把这 ≤5 MiB 的文档整份读进内存：`encodeText` 是整串编码（GBK 用一张表、UTF-16 需整串），而文档本身被编辑上限封住。这里要消除的是 1 MiB 的墙，不是 5 MiB 的缓冲；真正无界的只有上传。

### 2.4 读取：三态取代「截断」

`fs.read` 从 `{content, truncated, binary, head?}` 变成判别联合：

```
| { kind: 'text';      content, size, mtimeMs }
| { kind: 'binary';    size, mtimeMs, head }
| { kind: 'too-large'; size, mtimeMs, head }
```

超过 `MAX_EDITABLE_BYTES`（5 MiB，`src/editor-limits.ts`）时只读前 4 KiB：判不出文本就是 `binary`（图片/office/PDF 的 media 路径**完全不变**），是文本就是 `too-large`，并带上 head 让 `detect` 类外部 viewer 仍有机会认领。

**「截断」这个状态被彻底删掉**，包括 `FileViewerProps.truncated`、`EditorToolbarState.truncated` 与 `truncation` 文案键。理由：#732 的教训是「拿到半份文档但看起来能编辑」本身就是缺陷状态 —— 既不可信又不能保存。要么给全，要么明确说不给。

`fs.readPage` 按字节窗口分页：窗口**回退到最后一个换行**，所以一页是整数行（对 JSONL 就是整数条记录）；整页没有一个换行（超长单行）时原样返回，否则「下一个」会停在一个永不前进的偏移上。

### 2.5 分页的编码一致性（一处只有实测才会发现的坑）

第一版实现**锁死第一页嗅探到的编码**，理由是「避免同一个文档前后用两种编码解码」。这在真机上错得很具体：

- 「长 ASCII 前缀 + GBK 正文」的文件，第一页纯 ASCII → 嗅探成 UTF-8 并锁死 → 后半段 GBK 字节按 UTF-8 解 → 乱码。而一次性全读（旧行为）是能正确解出来的，所以这是一个**新引入的回归**。
- 修正后的规则：**只锁宽字符编码**。宽编码（UTF-16/UTF-32）是文件的属性，一页恰好没有 NUL 字节不能重新裁决它（BOM-less UTF-16 的探测是看 NUL 的分布，而一段纯 CJK 的 UTF-16LE 几乎没有 NUL）；字节序编码（UTF-8 / GBK / GB18030）则逐页各自嗅探 —— 纯 ASCII 的页在两种编码下解出来是同一个字符串，有非 ASCII 的页则会被正确识别。

逐页嗅探在这里是安全的，因为**分页按行对齐**：`0x0A` 既不能是 UTF-8 的续字节，也不能是 GBK 的尾字节，所以窗口边界永远不会切断一个字符。（`lastLineBreakEnd` 还要再处理宽编码：UTF-16LE 下 `U+0A41` 的低字节就是 `0x0A`，朴素的 `lastIndexOf(0x0A)` 会把字符切两半。）

### 2.6 JSONL：自己的语言 + 记录预览

- **语言**：`src/client/lang-jsonl.ts` 是一个手写的 `StreamLanguage`，一行一次 JSON 词法分析。不携带跨行状态（JSONL 的记录按定义互相独立），未闭合的字符串直接标 `invalid`（一行一条记录，所以这是**可证**的）。没有复用语法的代价：不检查重复键、不做结构校验 —— 词法分析器不是语法分析器，越界只会产出假错误。
- **描述符**：新增第 4 个内置 viewer `jsonl`（`exts: ['jsonl','ndjson']`、priority 0），而不是塞进 `code` 兜底 —— 这样外部插件可以按格式精确遮蔽，设置页也能单独开关。
- **预览**：`src/client/LargeFileView.tsx` 一条记录一行，默认折叠成一行摘要（`summarizeRecord` 把第一层内联、更深的用 `{…}`/`[…n]` 省略），点击才展开宿主的 `JsonTree`。一页最多几百行、只对展开项建树，所以渲染成本有界。
- **编辑**：`mode` 切到 `edit` 就是原来的可保存 CodeMirror（带 jsonl 语言与未提交变更 gutter），仅在 ≤5 MiB 时提供。

### 2.7 大文件：只读分页预览

超过编辑上限的文件不再拒绝打开，而是进入 `LargeFileView` 的只读模式：通用文件是等宽行列表（不换行、横向滚动，日志查看器的形态），JSONL 是记录卡片列表。两者共用 `src/client/text-pages.ts` 的分页游标，内存与文件大小无关。

**追加模型（2026-10-11 修订，按用户要求对齐 VS Code）**。第一版做成的是「显式翻页」（上一页/下一页，新页**替换**当前页）。用户要求改成 VS Code 的 output/log 面板那样：**滚到底就自动取下一页并拼接**，同时在超限提示条最右侧加一个「加载全部」。于是游标被整体删除，只剩一个只向前的累加器：

- 页按文件顺序**累积**，滚动到底追加下一页，读者已经读过的内容不会被抽走；
- 「加载全部」就是「一直追加到 EOF」，**必须串行**——每一页的 `offset` 就是上一页响应的 `nextOffset`，无法预先算出；
- 页数仍然事先不可知、也不能跳到末尾（同一条理由：随机访问要先扫全文件）。

**唯一 VS Code 不需要、而这里必须有的东西是行数上限。** 它的 `TextModel` 与视图都是虚拟化的，所以模型里塞进一个 GB，DOM 仍然很小；这里渲染的是**真实元素**。`MAX_PREVIEW_ROWS = 50_000` 因此是「停止追加并让读者去下载」的那条线——看得见的天花板胜过卡死的标签页，而且它远高于任何人在侧栏里真会读的日志（6 MB 的参考日志约 3.5 万条记录，稳稳在其内）。这个上限由 **hook 持有**（`useTextPager(..., maxLines)`），不是由视图按自己的**已渲染**行数判断：`loadAll` 在 `await` 循环里推进时，React 还没重渲染，读渲染态的数字会滞后好几页、把上限冲过去。测试直接抓到了这一点（worker 十秒内 OOM）。

### 2.8 打包下载：改回直链

客户端的 `saveArchive` 从 `fetch → blob → objectURL` 改成普通 `<a download>` 指向路由 URL。Blob 会把整包放进**标签页**的内存 —— 宿主侧刚刚为超过这个而改成流式，客户端再缓冲一次就把收益抵消了。

代价也记在这里：无法再检查路由的 JSON 错误信封，所以这一步失败会把一个 JSON 体存成存档名。但所有现实中的失败（工具缺失、选择不可读、工具退出码非 0）都在 `archive.status` 轮询阶段被拦下，剩下的只有「轮询到点击之间任务被消费或过期」。

## 3. 与 VS Code Web 的对照

用户要求参考 VS Code Web 的做法。研究结论（源码 + 已安装 1.141.0 产物双向核对）：

- **VS Code 不分页。** `TextModel` 用 piece tree 装整份文档，没有行窗口或 limit 参数。
- 真正的模型是**阈值 + 确认 + 降级**：`getLargeFileConfirmationLimit()`（`isWeb` → **50 MB**）→ 超阈值在编辑器区显示占位符「The file is not displayed in the text editor because it is very large.」+ **Open Anyway**（`limits: {size: MAX_VALUE}`）+ **Configure Limit**（设置项 `workbench.editorLargeFileConfirmation`）。
- 阈值以下但 >20 MB 或 >300k 行 → `editor.largeFileOptimizations` 在**模型构造时永久**关掉 tokenization 以及一切 token 派生的特性。
- 唯一接近流式的是 Output/日志面板：`readFile(resource, { position: endOffset })` 增量尾读追加到模型里。
- 顺带纠错：常被引用的 `files.maxMemoryForLargeFilesMB` **不存在**（1.141.0 产物零命中，`files.contribution.ts` 里也没有）。

**采纳**：阈值 + 超限降级为只读；大文件不装作能高亮（分页预览天然没有高亮，与 VS Code 一致）；上限取用户给的 5 MiB（VS Code 的 web 阈值是 50 MB，但那是**确认**阈值而非编辑阈值，两者不是一回事）。
**有意偏离**：VS Code 直接拒绝打开超限文件，我们按用户要求做分页，让大日志**能看**。这与 VS Code Output 面板的 offset 增量读是同一路数。

## 4. 实施偏差与代价（如实记录）

1. **`data-` 前缀之外的一处未预期发现**：`archive.status` 的进度语义无法保留（见 §2.2），这是「交给系统命令」的必然代价，不是实现偷懒。
2. **分页的编码锁第一版是错的**（见 §2.5），真机测试才发现；已修正并补上双向用例（长 ASCII 前缀 + GBK 正文，以及纯 CJK 的 UTF-16 页）。
3. **JSONL 词法分析器第一版有死循环**：`StringStream.next()` 在行尾返回 `undefined` 而不是 `null`，未闭合字符串的分支因此无限追加直到 `RangeError: Invalid string length`。测试用例直接抓到了它。
4. **`stat` 失败从 500 变 400**：两条字节路由原先让 `stat` 的原始 rejection 逃成 500「internal」，读起来像插件故障；不可读的用户路径是 400。smoke 里一条把 500 写进断言的用例随之更新。
5. **`tags.invalid` 从纯白改成红色波浪线**：`invalid` 是 JSON/JSONL 语法错误落到的 token，而它在深浅两种配色下都是 `#ffffff` —— 浅色主题下就是白底白字，读者看不见哪里没解析。
6. **保留 `uploadTooLarge` 文案**：`too-large` 这个 wire 码在契约里还在（`SidebarErrorCode`），展示映射留着比删掉 21 份词典的一行更有价值。
7. **`readLimit` / `mediaLimit` / `uploadLimit` 三个配置键删除**，旧 profile 里残留的值由 schemastery 当未知键容忍（与 `workspaceFence` 同一条先例）。`listLimit` 保留 —— 它是浏览器行数上限，与传输无关。

## 5. 测试守护

- `tests/file-stream-route.spec.ts`：真 `node:http` 下发 21 MiB（旧 `mediaLimit` 之上）、`content-length`、`?download=1` 的 RFC 5987、SVG 的 CSP、**不可读文件仍是 4xx JSON 信封**（证明头是在 open 之后才写的）、客户端中途断开的存活、`writeJson` 的 `headersSent` 守卫。
- `tests/fs-read-page.spec.ts`：单页/多页重组逐字节相同、页按行对齐、超长单行不被裁空、EOF 精确、偏移缺省与越界、**两种编码场景**（长 ASCII 前缀 + GBK 正文；纯 CJK 的 UTF-16 页）。
- `tests/jsonl-language.spec.ts`：400 条记录零错误节点（`json()` 是 402 个）、坏行不溢出到后一行、词法分析器**不**为「缺失的结构」编造错误、属性名与字符串值的区分（含负例）、未闭合字符串、超长单行。
- `tests/jsonl.spec.ts`：`.jsonl`/`.ndjson` 的扩展判定（`.json` 不claim）、逐行解析、空行是「跳过」而不是「损坏」、摘要的第一层内联与省略、单行长度上限。
- `tests/fs-write-route.spec.ts`：并发保存、mtime 冲突、CRLF/LF/GBK+CRLF 还原，以及**远超旧 1 MiB JSON 上限的一次保存**。
- `tests/archive-tools.spec.ts` / `tests/archive.spec.ts`：argv 规划（含 `-y`）、公共祖先与上移、根拒绝、扩展名归一、注入式 spawn 的探测顺序与缓存、stderr 尾部、六个错误分支、并发上限、TTL、下载消费任务并删除临时文件、`dispose()` 杀子进程、以及**唯一一条真二进制用例**（自探测、缺席即跳过）。
- `tests/editor-large-file.spec.tsx`：超限进入只读分页预览 + 下载出口 + 无 CodeMirror + 无保存按钮，并有「可编辑时确实有保存按钮」的反证。
