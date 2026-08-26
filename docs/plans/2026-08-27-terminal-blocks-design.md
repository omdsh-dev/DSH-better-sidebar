# 终端块框架（Terminal Blocks）设计

> 2026-08-27 · 状态：已实施（feat/terminal-blocks，v2 含 hover block 层）
> 需求：优化 term 框架，把终端里不同 CLI 执行拆成独立的 block；参考文件/代码 viewer 里「添加到对话框」（selection popup → `appendToDraft`）的能力，复用到 xterm 中——选中即浮出按钮、以及把「最后一次执行」作为一个整体插入对话草稿。

## 0. 决策记录（已确认）

| 决策点 | 结论 |
|---|---|
| block 边界来源 | **用户输入流**（onData 里的 Enter），不做 prompt 嗅探——shell 提示符千变万化（zsh 右提示符、git 分支、颜色），嗅探不可靠且不可测 |
| block 锚点 | Enter 时刻 `buffer.length - 1`（shell echo 行 = 提示符 + 命令所在行）；**不含 marker**——xterm marker 无法在测试中 mock，且滚动回收在 4000 行 scrollback 下几乎不影响尾部锚点（可接受偏差：paste 竞态少一行） |
| echo 行处理 | 提取输出时**跳过 echo 行**，命令由 payload 的 fence info 行（`$ <command>`）携带，不重复 |
| 「添加到对话框」两种形态 | ① **选中**：TextEditor 同款浮钮（`.xterm-selection` 首段 DOM rect 锚定 + `createPortal` 到 body）；② **block**：终端右上角内置小药丸（每次命令提交后出现），点击把当前 block（命令 + 当前输出）整块插入 |
| 输出上限 | `TERMINAL_INSERT_LIMIT = 4000` 字符，超出**截断 + `\n…` 标记**（不丢弃——终端 block 的价值就是输出本身，与文件选择的「超限只留 header」不同） |
| 纯逻辑位置 | `src/client/terminal-blocks.ts`（零依赖，结构类型对齐 xterm `IBuffer`/`IBufferLine`），随 TerminalView 打进懒加载 chunk，不进核心 bundle |
| 锚点健壮性 | 每个 block 提交时由视图 `term.registerMarker(0)`（cursor 行 = echo 行）钉住锚点——marker 随 scrollback trim 平移、随 reflow 平移、滚出 buffer 自动 dispose；`blockStartLine` 优先 marker.line，disposed marker 解析为 **+Infinity**（行已消失 = 整体不可见），无 marker 时退回索引 |
| 视觉 block 化与 hover | **已实施**（v2）：`TerminalBlockOverlay.tsx` 以每次 CLI 执行的 echo 行为界画 hairline 分隔线；鼠标悬停某个 block → 该 block 行区间淡色高亮 + 悬停行右侧浮出「添加到对话」药丸，点击整块插入草稿（选中模式 popup 优先）；矩形几何 = `.xterm-screen` rect + `(row - viewportY) × cellH`，不依赖 renderer 内部行元素 |

## 1. 现状关键事实（实施依据）

- **「添加到对话框」现有链路**（`src/client/TextEditor.tsx`）：非空选区 → 浮钮（`css.selectionPopup`，`createPortal` 到 body，`position:fixed`，锚在选区头部上方）→ 点击 `appendToDraft(ctx, scope.sessionId, insert)`（`src/client/conversation-draft.ts`：`ctx.sessions.scope(sessionId)` + `ctx.get('conversation').input.setDraft`）。payload 由 `selection-payload.ts` 纯函数构建（fence + `相对路径:行号` info 行）。滚动/失焦/选区坍缩即隐藏。
- **TerminalView**（`src/client/TerminalView.tsx`）：props `{ scope, tabId, store }`，主 effect 创建 xterm（`@xterm/xterm` 5.5.0，**DOM renderer 为默认**，`DomRenderer` 把选区画成 `.xterm-selection` 容器下的绝对定位 div——锚定 rect 的直接来源）；`term.onData` 已存在（转发 socket）；卸载三分支（close/park/drop）不变。**没有 ctx prop**——需要补。
- **懒加载**（`chunks/terminal.tsx` → `lib/client-terminal.js`）：TerminalView 经 `lazyChunkComponent` 包装；`terminal-blocks.ts` / `conversation-draft.ts` 都是零重依赖模块，随 chunk 走。
- **descriptor**（`src/client/builtins/tabs.tsx`）：终端 descriptor 的 component 收 `TabComponentProps`（含 `ctx`），显式映射 `tab.id → tabId`（`tests/lazy-chunk.spec.tsx` 回归钉住）。

## 2. 数据模型与状态机

```ts
// terminal-blocks.ts
interface TerminalBlock {
  id: number          // 单调递增
  command: string     // 清洗后的命令（trim，永不为空）
  startRow: number    // Enter 时刻 buffer.length - 1（echo 行）
  endRow: number | null  // 下一条命令的 echo 行；null = 仍开（尾部 = buffer 当前末尾）
  finished: boolean
}

class TerminalBlockTracker {
  blocks: readonly TerminalBlock[]   // 最旧在前，上限 BLOCK_KEEP = 32
  current: TerminalBlock | null      // 最后一次提交的命令（仍在生长的 block）
  pending: string                    // 自上次提交以来清洗后的输入（下一条命令）
  onData(data: string, bufferLength: number): void
}
```

- **输入清洗**（跨 chunk 的状态机，逐字符）：ESC 起 CSI（`[`…0x40–0x7e）/ OSC（`]`…BEL 或 ST）、bracketed-paste 标记、`\x7f`/`\b` 退格弹末字符、其余 C0（tab/bell）丢弃、可打印累积。
- **提交**：`\r`/`\n` → `command = pending.trim()`；空命令（裸 Enter）**不产生 block**（shell 只多盖一行新提示符，留在前一个 block 的区间里，提取时尾部空行被剥掉）；非空 → 关闭上一个 block（`endRow = 新 startRow`）、新 block `startRow = max(0, bufferLength - 1)`。
- **多行 paste**（`echo a\recho b\r` 一个 chunk）：逐字符处理 → 每行一个 block。

## 3. 提取与 payload

```ts
blockOutputText(buffer, block, pending = '') → string
```
- 区间 `[startRow+1, end)`（echo 行跳过；finished block 用 `endRow` 闭合，开 block 用 `buffer.length`）。
- 行拼接：`isWrapped` 行不插 `\n`（还原折行）；`translateToString(true)` 去行尾空白。
- **剥离尾巴**：最后一行若以 `pending.trim()` 结尾（shell 正在回显下一条命令）→ 剥掉该行（单行场景整段为空）；尾部空行 `trimEnd()`。
- 防御：`startRow` 越界（alt buffer 切换）→ clamp 到 `[0, length]`，`end <= from` 返回 ''。
- best-effort 偏差（文档化）：paste 竞态（Enter 先于 echo 落屏）锚点偏一行；进度条 `\r` 原地重写只影响最终快照。

```ts
buildTerminalInsert(command, body, { limit = 4000, ellipsis = '\n…' }) → string
// ```$ npm test
// ✓ 3 passed
// ```
```
- fence info 行 = `$ <command>`（命令未知/空时为裸 fence）；body 超限截断 + 标记（与文件选择的「超限只留 header」刻意不同）。
- `blockForSelection(blocks, row0)`：倒序找 `startRow <= row0 < endRow` 的 block（选中开始行归属的 block 的命令作为 header；开 block 的 `endRow === null` 视为无穷）。

## 4. TerminalView 接线

```tsx
// props 增加 ctx；effect 内：
const tracker = new TerminalBlockTracker()
termRef.current = term; trackerRef.current = tracker

term.onData((data) => {
  tracker.onData(data, term.buffer.active.length)
  if (tracker.current !== null) setBlockReady(true)   // 幂等，首次提交后常亮
  socket.send(data)
})

term.onSelectionChange(() => { ...  // 选区非空 → rAF 后读 .xterm-selection 首段 rect
  // command = blockForSelection(tracker.blocks, range.start.y - 1)?.command
  showSelectionPopup(buildTerminalInsert(command, selected), ...) })
term.onScroll(() => hideSelectionPopup())             // 与编辑器同规则
```

- **选中 popup**：`createPortal` 到 body 的 `css.selectionPopup`（TextEditor 同款），`onMouseDown.preventDefault` 保选区，点击 `appendToDraft(ctx, scope.sessionId, insert)`。
- **block 药丸**：`blockReady && connected && 无致命` 时渲染 `css.selectionPopup + css.terminalAddBlock`（absolute 右上角）；点击时**现取** `tracker.current` + `blockOutputText(term.buffer.active, ...)` 构建 payload（无过期状态）；有选中时隐藏（选中优先）。
- **清理**：`selectionSub`/`scrollSub` dispose、rAF cancel、`termRef/trackerRef` 置空、`hideSelectionPopup()`；effect 开头 `setBlockReady(false)`（重挂载不残留旧会话状态）。
- 卸载三分支（close/park/drop）、重连、字体/主题订阅全部不动。

## 5. 风险与取舍

| 项 | 说明 |
|---|---|
| DOM renderer 依赖 | 选区 rect 来自 `.xterm-selection > div`（当前默认且唯一 renderer）；若未来换 renderer，选中 popup 静默隐藏，block 药丸不受影响 |
| 半条命令泄漏 | 剥尾巴只处理「最后一行以完整 pending 结尾」；折行的 pending 可能剥不干净（best-effort，文档化） |
| 误剥 | 输出最后一行恰好以 pending 文本结尾会被误剥（概率低，可接受） |
| 重连后 | 转录回放无输入历史 → 从零开始跟踪；用户再敲命令即恢复 |
| 核心 bundle | terminal-blocks.ts 只被 TerminalView 引用 → 打进 `client-terminal.js` chunk，不动启动路径（`tests` 直接 import 该模块不受 bundle 影响） |

## 6. 测试

- `tests/terminal-blocks.spec.ts`（21 例，零挂载）：清洗状态机（CSI/OSC/粘贴标记/跨 chunk ESC/退格）、提交语义（锚点/闭合/裸 Enter/多行 paste/上限裁剪）、`blockOutputText`（echo 跳过/折行/闭合区间/尾部空行/pending 剥离/越界防御）、`blockForSelection`、`buildTerminalInsert`（fence 形状/截断/默认上限）。
- 既有回归：`lazy-chunk.spec.tsx`（descriptor props 契约）、`builtins.spec.ts`、`terminal-deps-banner.spec.tsx` 全绿；typecheck 通过；`pnpm build` 出 chunk。