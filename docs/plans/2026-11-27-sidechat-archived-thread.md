# 侧边对话「发不出去」：关闭 Tab 归档线程（#1265）

## 现象与复现

- 用户报告侧边对话「似乎无法发出」：输入后按发送，消息被接受，但永远没有任何回答。
- 仓库已有同现象 issue [#1265](https://github.com/omdsh-dev/DSH-better-sidebar/issues/1265)（0.32.1 / DSH 0.2.2-rc.5）。
- 在 3080（0.2.3-alpha.2 + 本仓库 dev）上复现：
  1. 新建侧边对话，第一条消息正常回答；
  2. 关闭它的 Tab（`releaseSidechat` 归档线程会话）；
  3. 用同一会话重新打开侧边对话 → 共享页重绑到被归档线程；
  4. 再发送：`sidechat.prompt` 返回 `{accepted:true}`，随后 `turn/start` →
     `turn/end{kind:"blocked"}`，没有 `step/start` / `request/header` / `assistant/message`。
- 直接对已归档线程（`session-66c48978-…`）调用 `sidechat.prompt` 得到同样结果：
  `turn/end{kind:"blocked"}`，前端 `terminalReason()` 不映射 `blocked`，转写不渲染任何行。

## 根因

1. 关闭 Tab 的 `releaseSidechat()` 会 `archiveSession(threadId, {stopActivity:true})`；而侧边对话线程是 subagent 来源，宿主的归档列表无法在 UI 里恢复（#949 因此禁用了归档按钮）。
2. 共享侧边对话页重绑时 `reattachTarget()` 有 `threads.length === 0` 分支：当这个会话的所有线程都被归档（`threads` 过滤后为空）时，它仍会返回记住的已归档线程 id。
3. 宿主 `ArchivedSessionGate` 在 `agent/pre-step` 拒绝归档会话的唤醒 → 轮次以 `blocked` 结束，`sidechat.prompt` 早已返回 accepted。
4. 前端 `terminalReason()` 只映射 `aborted` / `interrupted` / `max-tokens`，`blocked` 被丢弃 → 页面完全沉默。

## 修复

- `builtins/tabs.tsx`：关闭 Tab 只 `sidechatDispose`，不再归档（与 #949 的判断一致：归档对侧线程是单向门）。
- `SideChatView.tsx`：
  - 绑定到已归档线程时，用宿主 `uiWorkspace.unarchiveSession` 恢复（侧线程只会被旧的关闭路径归档，所以这是修复而不是复活）；
  - `reattachTarget()` 不再把已归档线程当成重绑目标；只有宿主提供 unarchive 时才恢复它，否则放弃重绑；
  - `handleSend()` / GenUI 的 `sendSurfacePrompt()` 在 prompt 前再检查一次并解除归档，覆盖「面板开着时线程才被归档」的竞态。
- `sidechat-transcript.ts` + `SideChatView.tsx`：把 `turn/end{kind:"blocked"}` 映射成独立的 terminal 行（`sideChatTerminalBlocked`，七种语言同步），宿主再次拒绝时至少能看到原因。

## 验证

- 单测：`tests/sidechat-view.spec.tsx` 新增「绑定归档线程会解归档」「可恢复的重绑」「发送前解归档」三例；`tests/builtins.spec.ts` 的关闭契约改为「释放但不归档」；`tests/sidechat-terminal-rows.spec.tsx` 新增 blocked 映射与文案两例。
- 真机（3080，0.2.3-alpha.2）：关闭 Tab 后重新打开，原对话恢复且能继续发送；预置一个已归档线程并让面板绑定它，打开时自动解除归档（`workspace.json` 的 `archivedSessionIds` 移除该 id），发送得到回答。
