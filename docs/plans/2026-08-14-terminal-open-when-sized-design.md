# 终端延迟初始化（零尺寸容器 xterm open 崩溃修复）设计

**日期**：2026-08-14
**状态**：已实施（本文档含实施偏差记录）
**目标版本**：v0.11.x（issue #25 修复）

## 1. 目标

修复 [issue #25](https://github.com/omdsh-dev/DSH-better-sidebar/issues/25)：WKWebView 下点击「展开底部面板」后底部面板内容空白、无终端，控制台报 `Cannot read properties of undefined (reading 'dimensions')` 与 `(reading 'handleResize')`。

根因：`TerminalView` 的挂载 effect 在容器可能为零尺寸时**同步**执行 `term.open(host); fit.fit()`。xterm 5.3.0 在零尺寸容器里 open 时渲染器创建失败，`RenderService._renderer.value` 保持 undefined，随后 Viewport 的 `_innerRefresh` 读 `_renderService.dimensions`（getter 即 `_renderer.value.dimensions`）崩溃。Chrome（Blink）对零尺寸布局更宽容所以不崩；WKWebView 稳定复现。

修复：把 `term.open(host)` + `fit.fit()` 推迟到容器有实际尺寸之后再执行（xterm 在隐藏/零尺寸容器初始化的标准修法），open 恰好执行一次。

## 2. 非目标

- 不换 xterm 渲染器（打包产物只有 DomRenderer 是现状，不是本次根因；`rendererType` 保持默认）。
- 不改 pty / WS / 终端连接生命周期：推迟 open 不推迟连接、不重启 shell、不丢 transcript。
- 不改 host 半与 chunk 打包结构（新模块随 terminal chunk 打入 `lib/client-terminal.js`）。
- 不 bump 版本号（release 流程负责）。

## 3. 现状回顾

- `src/client/TerminalView.tsx` 第 99–101 行同步 `term.open(host); fit.fit()`。
- 零尺寸挂载路径真实存在且不止一条：
  - 底部面板首次展开自动开终端（`Sidebar.tsx` 的 `bottomOpenedOnce` effect）在面板 slide-in transition 的同一次 commit 挂载 TerminalView，WKWebView 下此刻 host 高度为 0；
  - 所有 tab 保持挂载（`split-pane.tsx`：非激活 tab 用 `.paneTabHidden { display: none }` 隐藏），面板折叠时保持挂载（`.panelHidden`）——任何 `display:none` / 零尺寸祖先都会踩同一坑。
- 前提已验证（xterm 5.3.0 与 @xterm/addon-fit 0.10.0 源码）：
  - `FitAddon.fit()` 在 open 之前是安全 no-op（`proposeDimensions` 先查 `this._terminal.element`，undefined 即返回）。
  - `WriteBuffer.write()` 不依赖 open 状态：数据解析进 buffer，open 后渲染——推迟 open 不丢初始 transcript。
  - `TerminalView` 已有的 ResizeObserver / 字体订阅里的 `fit.fit()` 在 open 前 no-op、open 后照常 re-fit，无需改动。

## 4. 设计

### 4.1 新模块 `src/client/open-when-sized.ts`（纯逻辑，可单测）

```ts
export function openWhenSized(
  host: HTMLElement,
  open: () => void,
  raf: (cb: FrameRequestCallback) => number = requestAnimationFrame,
  caf: (id: number) => void = cancelAnimationFrame,
): () => void
```

- 单条代码路径：`raf(step)` → step 检查 `host.isConnected`（false 则停止，防卸载后空转）→ `clientWidth > 0 && clientHeight > 0` 则调 `open()` 并停止；否则再排一帧。
- 返回 cancel：`caf(frame)` 并置空（幂等），cleanup 调用。
- helper 不 try/catch（保持纯净），异常由调用方处理。

### 4.2 消费点 `src/client/TerminalView.tsx`

- 移除 effect 顶部的 `term.open(host); fit.fit()`（保留 `term.loadAddon(fit)`）。
- 在 effect 尾部（`sendResize` / `connect` 定义之后、`connect()` 调用之前）注册：

```ts
const cancelOpen = openWhenSized(host, () => {
  try {
    term.open(host)
    fit.fit()
    sendResize()
  } catch (error) {
    console.error('[dsh-better-sidebar] xterm open failed:', error)
  }
})
```

- 回调里补 `sendResize()`：推迟路径下 socket 可能已先连上（`connect()` 在 effect 尾部同步调用），open+fit 后必须把真实 cols/rows 发出去，否则 pty 停留在默认 80x24 直到下次 resize；已尺寸快速路径下 socket 尚未 open，`sendResize` 内部守卫（`readyState === OPEN`）自然 no-op，无行为变化。
- cleanup 里在 `term.dispose()` 前加 `cancelOpen()`。
- 其余（connect / observer / fontSub / schemeSub / onData / 主题）不动。

## 5. 测试

`tests/open-when-sized.spec.ts`（jsdom + 注入手动步进的假 raf/caf；`Object.defineProperty` 桩 `clientWidth/clientHeight`；`appendChild/remove` 控制 `isConnected`）：

1. 已尺寸 → tick 一次后 open 恰好一次，之后不再排帧；
2. 零尺寸 → 多次 tick 不 open，设尺寸后下一次 tick open 一次，后续 tick 不重复；
3. 只有一维缺失 → 补齐后 open；
4. cancel 后永不 open、无残留帧、cancel 幂等；
5. host 脱离文档 → 轮询停止、不 open；
6. open 抛错 → 异常向调用方传播（调用方负责 try/catch），不重复调用。

## 6. 限制与取舍

- rAF 轮询在 host 长期隐藏（`display:none` 祖先）期间持续排帧，每帧只读两个属性，开销可忽略；open 后立即停止。用 ResizeObserver 触发也可行，但轮询是 issue 中建议的标准修法，且不依赖 observer 对 transition 中间态的回调时序。
- 已尺寸快速路径比原行为晚一帧（rAF 回调时机），无感知差异。
- 若容器永远零尺寸（异常布局），终端永不 open、不崩溃——对不可见内容是可接受的降级。

## 7. 实施偏差记录

无（按设计实施）。
