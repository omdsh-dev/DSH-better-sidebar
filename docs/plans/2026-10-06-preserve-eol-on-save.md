# 保存保持文件原有行尾（#871）

> 状态：已实现（`fix/871-preserve-eol`）。来源：[issue #871](https://github.com/omdsh-dev/DSH-better-sidebar/issues/871)
> ——它是 `fix/crlf-markdown-surface`（`dev` 合并 `0ee870a`）的**直接后续**：那一批修的是读取侧的三层
> `\r` 误判，刻意没动写入侧。

## 1. 问题

在侧栏编辑器里打开一个 **CRLF 行尾**的文件，按一次保存，整个文件变成 **LF**：`git diff` 全红、review
读不了、可能触发无谓的冲突与 CI 差异。不丢数据，但把「改一行」变成「重写整个文件」。

证据链（issue 已给）：CodeMirror 的文档模型只有 LF，`save()` 写的是 `view.state.doc.toString()`；
同一条归一化在预览侧也能观察到——CRLF 内容的 draft 快照到达时已经是 LF 分段。

## 2. 已核实的事实（读装好的宿主包，逐字核对 rc.1 与 rc.2）

**结论：宿主的 `edit` 工具不会改行尾，`write` 工具会；插件的保存路径从来没管过行尾。**

| 写入面 | 行尾行为 | 证据 |
| --- | --- | --- |
| 宿主 `edit` 工具 | **保住**原文件风格 | `dsh-tool-fs` 的 `edit` → `ctx.fs.editText` → `dsh-fs-local` `editText`：`readForEdit` 返回 LF 归一化的 content + `detectLineEndings(raw)`，匹配与替换都在 LF 上做，落盘前 `restoreLineEndings(edited.content, original.lineEndings)` |
| 宿主 `write` 工具 | **不保**（原样写） | `dsh-tool-fs` 的 `write` → `ctx.fs.writeText` → `writeFileAtomic(targetKey, content)`，只有**回给 UI 的 diff 基线**做了 `normalizeLineEndings`，落盘字节就是模型给的文本 |
| 插件 `fs.write` 路由 | **原来完全不管** | `src/index.ts` 先 `encodingOfFile` 检测编码、过 mtime 冲突门，然后 `encodeText(content, encoding)` 直接写；行尾没有任何一步经手 |

检测口径（宿主 `dsh-fs-local`）：取**前 4096 字符**做多数票，`\r\n` 数**多于**裸 `\n` 数才算 CRLF；
归一化只认 `\r\n`（孤立 `\r` 即经典 Mac 行尾既不计票也不改写）；还原时**先归一化再 `split('\n').join('\r\n')`**，
注释里写明这是为了不写出 `\r\r\n`。

版本面：本机全局装 0.2.0-rc.2，从 registry 取 `@deepseek-ai/dsh-fs-local@0.2.0-rc.1` 的 tarball 对照，
上述函数**行号与实现逐字相同**，所以对仓库 CI 钉的基线同样成立。

## 3. 设计：在服务端、与编码检测同一个缝里还原

改动面只有两处，**客户端一行不动**：

- `src/text-encoding.ts`
  - 新增 `TextEol = 'lf' | 'crlf'` 与 `FileFormat = { encoding, eol }`；
  - 新增 `detectEol(text)`（前 `EOL_SNIFF_LIMIT = 4096` 字符多数票，与宿主同款口径）与
    `restoreEol(text, eol)`（LF 原样返回；CRLF 先归一化再 join）；
  - `encodingOfFile(path)` 扩成 **`fileFormatOf(path)`**：**同一趟** 64 KiB sniff 读取同时给出编码与行尾，
    `decodeTextBytes` 返回的 `content` 本身不做行尾归一化，直接拿来投票。二进制读（`decoded === null`）
    与 `ENOENT` 都返回 `{ encoding: 'utf8', eol: 'lf' }`。
- `src/index.ts` 的 `fs.write`：`const { encoding, eol } = await fileFormatOf(path)`，
  落盘改为 `encodeText(restoreEol(content, eol), encoding)`。顺序仍是「mtime 门 → sniff → 写」，
  所以还原依据是**磁盘当前**状态（外部改过就用外部的新风格），与编码检测同一取舍。

**为什么不把 `eol` 记进客户端 / per-tab store。** 那样等于再造一份状态，要跟未保存草稿、多 tab 共享
同一文件、宿主重挂三处对齐；而且保存入口只有一个（`TextEditor.tsx` 的 `api.fsWrite`），服务端覆盖它就是
全覆盖。客户端继续只发送 LF 文档，协议零变更。

**为什么不加设置开关。** 「编辑器不该偷偷改我的文件」本身就是正确默认；给两种保存语义各配一套测试与
文档只会稀释这条保证。

## 4. 边界与「不做」

| 情形 | 行为 | 理由 |
| --- | --- | --- |
| 混合行尾 | 按**多数风格整份回写** | 与宿主 `editText` 同款取舍；「只改被编辑行」做不到——CodeMirror 只给整份文档，没有逐行归属 |
| CR-only（经典 Mac） | 不识别、字节原样保留 | 归一化只认 `\r\n`；新插入的行会是 LF（结果是混合），与宿主一致，不自行发明 |
| 新文件（`ENOENT`） | UTF-8 + **LF** | **项目级行尾一致性是另一个问题**：本批只保证「不改一个文件既有的格式」，不推断项目约定（兄弟目录多数票 / `.gitattributes` / 偏好都不是本批的事） |
| 内容里已含 `\r\n`（粘贴、老调用方） | 不产生 `\r\r\n` | 先归一化再 join |
| 大文件截断只读、二进制、上传 | 不进这条路径 | 只读态没有保存入口；二进制走下载面板 |
| 模型 `write` 整份覆盖同一文件 | **仍会变 LF** | 那是宿主的 `writeText`，插件拦不住；见 §6 |

## 5. 测试与判别性

- `tests/text-encoding.spec.ts`：`fileFormatOf` 的 CRLF/LF/新文件、`detectEol` 的多数票与孤立 `\r`、
  `restoreEol` 不双写；既有 3 条编码断言改为 `toMatchObject` / `toEqual`（签名换了，覆盖面没减）。
- `tests/fs-write-route.spec.ts`：三条端到端——CRLF 文件写 LF 文档后**除被编辑行外全 CRLF**且没有裸 `\n`、
  LF 文件不引入 `\r`、GBK + CRLF 组合（LF 文档 → GBK + CRLF 字节，两个 restore 都要开火）。
- 判别性（实测）：把 `restoreEol(content, eol)` 换回 `content` → 后两条端到端用例**红**，其余仍绿。

## 6. 后续（不在本批）

1. **上游 `write` 工具不做行尾还原**：模型用 `write` 整份覆盖一个 CRLF 文件时，文件仍会变 LF。插件侧
   无写入权（那是 `ctx.fs.writeText`），只能向上游提「`writeText` 也按磁盘风格回写」，或让模型改用 `edit`。
   本批只在 issue 里留结论，不阻塞落地。
2. **新文件的 EOL 与项目级一致性**：默认 LF 是现状的诚实描述；若要做「跟随项目约定」，需要先定义口径
   （读 `.gitattributes`？同目录多数票？设置项？），另立 issue。
