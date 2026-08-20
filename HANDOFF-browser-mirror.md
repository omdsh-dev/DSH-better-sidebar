# Handoff — 侧边栏可交互浏览器镜像（Browser Mirror）

日期：2026-08-21（会话延续中）
分支：`feat/agent-controlled-browser`（未提交、未开 PR）
仓库：`dsh-better-sidebar-dev/`（dev clone，经 pnpm-workspace overrides 链到 `~/.dsh/profiles/desktop`）

---

## 1. 目标

让用户在 DSH Web GUI 侧边栏里**直接点击、输入、滚动**，操作 Playwright 控制的 headed Chrome 浏览器（同一个可见网站表面）。从「只能看的截图轮询」升级为「可交互镜像」。

## 2. 当前实现状态（MVP 已写完，构建通过，55 测试全绿）

四层改动：

| 层 | 文件 | 内容 |
|---|---|---|
| 后端 | `src/agent-browser.ts` | `MirrorState` + `startMirror/stopMirror/getMirrorFrame/getMirrorState/sendMirrorInput/setMirrorControl`；CDP `Page.startScreencast`(jpeg q70, 1280×900) + 立即 ACK；`Input.dispatchMouseEvent/dispatchKeyEvent/insertText`；`close()` 先 `stopMirror` |
| API 路由 | `src/index.ts` | 5 个新路由：`agent-browser.mirror.start/stop/frame/input/control`，全部走 `sessionCwdOf` 校验 |
| 客户端 API | `src/client/api.ts` | `mirrorStart/mirrorStop/mirrorFrame/mirrorInput/mirrorControl` + `MirrorFrame`/`MirrorStateInfo` 接口 |
| 前端 | `src/client/AgentBrowserView.tsx` | Canvas 渲染（latest-frame-only、renderLatest 防重入）；100ms 轮询 `mirrorFrame`；坐标映射 `scaleX = viewportWidth / rect.width`；pointerdown/up/wheel/key 转发；SPECIAL_KEYS 走 dispatchKeyEvent、可打印字符走 insertText；Take Control / Return to Agent 按钮 |

**尚未重启 DSH Desktop 加载新代码。重启需先征得用户同意（用户指令："你重启前先经过我允许"）。**

## 3. GPT 代码审查结果（7/10，在 ChatGPT「DSH 工作区」项目 →「分析交互浏览器方案」对话）

结论：方向正确，可作 MVP，但需从「Screenshot Viewer + Click Support」升级为真正的 Browser Mirror。

### ✅ 做对的部分
- CDP screencast + 立即 ACK
- 后端 latest-frame-only 存储
- 用 `cssVisualViewport` 而非 `layoutViewport`
- React 不直接接触 CDP，走后端白名单

### ❌ P0 — 现在就修
1. **旧帧覆盖新帧**：两个 HTTP 请求可能乱序返回 → 前端加 `seq` guard，丢弃 `seq <= lastReceivedSeq` 的帧；`createImageBitmap` 完成后再查一次 seq，过期则 `bitmap.close()` 不画
2. **缺 pointermove**：只有 click 没有 hover/drag → 加转发（rAF 合帧）
3. **鼠标事件不完整**：缺 `modifiers`（Shift/Ctrl/Alt/Meta）→ 补字段（CDP modifiers 位掩码：Alt=1, Ctrl=2, Meta=4, Shift=8）
4. **可打印字符只走 insertText**：缺 keyDown/keyUp 对，监听 keydown 的网页收不到 → 改为 `rawKeyDown + char + keyUp`（insertText 仅留给 IME commit）
5. **controlOwner 后端没 enforce**：纯 UI 状态 → `sendMirrorInput` 里检查 `mirror.controlOwner !== 'human'` 时拒绝用户输入（agent 的 Playwright 操作天然绕过此通道）

### ⚠️ P1 — 尽快修
1. **坐标绑定到每帧**：viewport 只在 startMirror 读一次，zoom/resize 后过期 → 用 screencastFrame 自带 metadata（pageScaleFactor/offsetTop/deviceWidth/deviceHeight/scrollOffsetX/Y），监听 `Page.frameResized` 重读 getLayoutMetrics
2. **Canvas letterbox 映射**：canvas 与 frame 宽高比不同时要算 renderRect（object-fit: contain 语义）
3. **Pointer Capture + blur cleanup**：`setPointerCapture`、窗口失焦时补发 mouseReleased/keyUp
4. **wheel normalize + accumulate**：deltaMode 换算 + 亚像素累积
5. **100ms polling → WebSocket push**：减少无效 JPEG 编码与 base64/JSON 双重开销（video 走 binary WS，control 走 JSON WS，分通道）
6. **stopMirror 完整清理**：确认 CDP session 完全释放

### P2 — 以后再说
JS dialog bridge（`Page.javascriptDialogOpening`）、file chooser bridge、popup/新标签页、clipboard、drag-and-drop 专门支持

### 四个关键改造方向（GPT 原话）
```
HTTP polling        → push transport (WebSocket)
static viewport     → frame-bound coordinate metadata
text injection      → real keyboard event model
UI control state    → server-side control lease
```
坐标体系和 keyboard model 最值得先重构——基础抽象错了，后面补拖拽/IME/zoom 会不断打补丁。

## 4. 下一步选项

A. 先按 P0 修 5 个问题（推荐，约 1-2 小时工作量）
B. 先重启 DSH 试 MVP 手感，再决定修什么（需用户同意重启）

## 5. 关键不变量（不可违反）

- **思悟身份层冻结**：不碰 `IDENTITY.md / USER.md / MEMORY.md / SESSION-STATE.md / AGENTS.md / persona / 生命图谱`。授权范围仅「模式与工具的插件创建」+ 容器级研究。
- **不修改官方 DSH 源码或已安装 npm 包**；只在 dev clone 里改。
- **非文档改动都在 `feat/agent-controlled-browser`，PR 由用户审**。
- **重启 DSH Desktop 前必须征得用户同意**。当前 GUI：http://127.0.0.1:55803。
- 浏览器安全不变量：按 `exec.agent.session.id` 隔离 profile；仅 HTTP(S)；loopback 阻断；snapshot/mirror 路由过 `sessionCwdOf` 校验；工具由 `agentBrowserTools` pref 门控（当前 ON）。

## 6. 环境备忘

- ChatGPT 登录态在 agent-browser profile（真实 Chrome，`channel: 'chrome'`）；Pro 账号，「DSH 工作区」项目 URL：`https://chatgpt.com/g/g-p-6a8580fc90f88191807b46e547745bb6/project`
- ChatGPT 输入框是 ProseMirror contenteditable：`browser_type` 的 fill 不适用；用 `browser_eval` + `document.execCommand('insertText')` 输入，点 `[data-testid="send-button"]` 发送
- 「极高」思考模式回复要 4-5 分钟：用 `browser_wait(30000)` 多次轮询，`[data-message-author-role="assistant"]` 取全文（snapshot 12K 截断）
- gpt-planning skill 已建在 `~/.dsh/skills/gpt-planning/SKILL.md`，新会话生效
- 残留 Chrome 进程清理：`pkill -f "chromium.*agent-browser-profiles"`；SingletonLock 卡死：`rm -rf ~/.dsh/agent-browser-profiles/*/SingletonLock`
