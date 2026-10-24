# 空白新会话缺少「打开底部工作台」入口 — 修复记录（issue #698 / #623）

> 分支 `fix/blank-session-bottom-entry`（基于 upstream/main，0.2.0-rc.1 / v0.24.1 线）。
> 调试与验收全部在真实 `dsh web`（DSH 0.2.0-rc.1）上完成：DOM 证据 + 截图。

## 现象

新建会话（已建会话、未发出第一条消息）时，右上角只有宿主的「Open right sidebar」，没有
「打开底部工作台」；正常会话里两者都在会话头。

## 根因（0.2.0-rc.1 源码 + 真机 DOM 实测）

宿主 `dsh-client-ui-conversation` 在 `session.blank && conversationPhase(session, conversation) === "blank"`
时**仍然渲染会话头**，但只渲染两个区域：`headerLeading`（空）与 `titleRow > headerCorner`
（内含宿主自己的「Open right sidebar」按钮）。**`header.utilities` 与 `header.actions` 两个
槽在这个状态完全不渲染** —— 插件挂在 `header.utilities` 的底部工作台开关随之消失。

（与 0.1.x 的差异：0.1.x 是整行 `display:none`/不渲染、连带宿主按钮一起消失；0.2.0 改成了
「保留 corner、去掉 utilities/actions」。）

## 设计

判定来源**不用 DOM 探测**：插件 host 半区新增只读路由 `session.phase`，直接读会话对象
（`ctx.sessions.get(sessionId).snapshotEvents()`），按宿主会话列表投影同一规则判定
`blank`（日志里没有 `user/message` / `assistant/message`）。客户端 `useSessionPhase(sessionId)`
读取并在 blank 期间以 1s 轮询跟踪；发出第一条消息后 `blank` 翻转即停。

渲染互斥：

- `blank` → 会话头实例（宿主不渲染该槽，天然不出现）＋ 插件在
  **`conversation.composer.dock`**（`list` 槽；blank 态渲染且为空，实测）渲染的备用入口；
- 非 `blank` → 只有会话头里那一套。

备用按钮 `position: fixed`，按宿主「Open right sidebar」按钮的 rect 对齐到其**左侧紧邻**
（随 resize 与 500ms 周期重对齐），经 **portal 到 `document.body`**（z-index 40：高于
AppFrame(20) 与会话头、低于浮层 100+）—— 否则按钮会被会话头 `titleRow` 拦截点击（实测）。

## 排除过的方案（都实测过，避免复踩）

- `conversation.hero.workspace`：`single` 槽且已被宿主 WorkspacePicker 占用，注册会使插件
  客户端条目激活失败（`web boot: 1 entry did not activate`）。
- `header.utilities` / `header.actions`：blank 态不渲染，坐上去不可见。
- DOM 可见性探针（量自家按钮/槽位的 rect 来推断状态）：宿主会为每个保留会话渲染隐藏副本
  并用 `transform` 平移出视口，且渲染顺序是「先 input dock、后会话头」——探针会自我成环、
  认错副本、或首帧测量过早，三处都翻过车。**结论：状态一律取自会话对象/插件 host 半区，
  不从 DOM 反推。**

## 测试

- 单测 `tests/dock-fallback.spec.tsx`（mock `session.phase`）：`blank` → 备用入口渲染且点击
  写 store；非 `blank` → 不渲染；相位未到达 → 不渲染。
- 部署级 `tests/e2e/blank-session-dock-entry.e2e.ts`：新建空会话 → 备用入口可见（宿主侧边栏
  按钮仍在旁边）→ 点击（`data-active=true`、底部面板展开）→ 发一条消息 → 备用入口退场、
  屏幕内入口回到会话头、全程无 console/pageerror。屏幕内计数与插件探针同一判据
  （rect 与视口相交），避免把宿主隐藏副本（transform 平移出视口、rect 仍在）算成第二个入口。
- 真机验收（`dsh web` + 截图）：空白态右上角双按钮并排；点击后底部工作台在空白会话展开；
  发消息后退场。见本目录同期验收截图。
