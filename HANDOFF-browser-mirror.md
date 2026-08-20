# Handoff — 侧边栏可交互浏览器镜像（Browser Mirror）

日期：2026-08-21（会话延续中）
分支：`feat/agent-controlled-browser`（未提交、未开 PR）
仓库：`dsh-better-sidebar-dev/`（dev clone，经 pnpm-workspace overrides 链到 `~/.dsh/profiles/desktop`）

---

## 1. 目标

让用户在 DSH Web GUI 侧边栏里**直接点击、输入、滚动**，操作 Playwright 控制的 headed Chrome 浏览器（同一个可见网站表面）。从「只能看的截图轮询」升级为「可交互镜像」。

## 2. 当前实现状态（2026-08-20 迭代完成，用户实测「舒服多了」）

四层架构（最新）：

| 层 | 文件 | 内容 |
|---|---|---|
| 后端 | `src/agent-browser.ts` | `MirrorState`（含 frame/meta 订阅器 + `deviceScaleFactor`）；`startMirror`（按画布显示尺寸做 `Emulation.setDeviceMetricsOverride`，dsf 跟随 GUI `devicePixelRatio` 自适应 1–2x；导航后重设 override）；`refitMirror`（拖宽后重排版，复用 dsf）；`sendMirrorInput`（SPECIAL_KEY_CODES 带 win/mac 虚拟键码，`rawKeyDown+keyUp`；`imeSetComposition`；insertText）；`onMirrorFrame/onMirrorMeta` 订阅 |
| API 路由 | `src/index.ts` | `mirror.start/stop/frame/input/control/refit` 六个 JSON 路由 + `/sidebar/ws/browser-mirror` WS 升级端点（二进制帧 4B seq+JPEG 推送、meta JSON 文本帧、背压丢帧、连接即回放最新帧、**WS 双工**：文本帧 = 输入事件直连 `sendMirrorInput`） |
| 客户端 API | `src/client/api.ts` | `mirrorStart(display 含 dpr)/mirrorStop/mirrorFrame/mirrorInput/mirrorRefit/mirrorControl/mirrorWsUrl` |
| 前端 | `src/client/AgentBrowserView.tsx` | Canvas `absolute inset-0 + object-fit: contain`（永不溢出）；letterbox 感知坐标映射（黑边点击忽略）；WS 收帧（seq 防旧 + 解码后二次防旧 + 断线 1s 重连）；**输入 WS 优先、HTTP 兜底**；ResizeObserver 拖动中 letterbox 缩放、400ms 停稳后 `mirrorRefit` 填满；**IME**：隐藏 textarea 承载键盘焦点，compositionupdate→`imeSetComposition`、compositionend→insertText，Cmd+V 粘贴转发；mirror.start 失败 3s 自动重试 |

已验证：点击/滚动/打字/删除/中文组合/拖宽重排/Retina 清晰。环境：DSH Desktop 2.0.1 (harness rc7)。**注意：Codex 等订阅 OAuth 依赖代理 env（LaunchAgent `local.dsh.proxy-env.plist`，写死端口 12450）持久化。**

## 3. GPT 代码审查结果（7/10，在 ChatGPT「DSH 工作区」项目 →「分析交互浏览器方案」对话）

> **2026-08-20 进度**：P0-1（seq 防旧）、P0-4（键盘模型——special keys 带虚拟键码走 rawKeyDown；可打印字符仍 insertText，实测可用）、P1-2（letterbox 映射）、P1-5（WS 推帧，单 WS 双工代替分通道）、P1-6（stopMirror 清理）已完成；另有额外落地：显示尺寸自适应排版、dsf 跟随 dpr、IME 组合、拖动重排、自动重试。**剩余 backlog 见 §4。**

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

## 4. 剩余 backlog（按价值排序）

1. **P0-2 pointermove 转发**（rAF 合帧）——hover 态/拖拽前奏
2. **P0-3 鼠标 modifiers**（CDP 位掩码 Alt=1 Ctrl=2 Meta=4 Shift=8）——Cmd+点击开新标签等
3. **P0-5 controlOwner 后端强制**——`sendMirrorInput` 按 owner 拒绝
4. **P1-1 帧绑定坐标元数据**——zoom/pinch 场景（当前 refit/重排已覆盖主要 resize 路径）
5. **P1-3 Pointer Capture + blur cleanup**——拖拽出窗、失焦补 keyUp
6. **P1-4 wheel normalize + accumulate**
7. **P2**：JS dialog bridge、file chooser、popup/新标签、clipboard 互通、drag-and-drop

收尾事项：分支 `feat/agent-controlled-browser` 共 6 个提交（6b05c98 → 58053fc），**PR 尚未创建**（仓库规则：代码改动经 PR 进 main，由用户审）。

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
