# 线索引用、资料操作与稳定加载修复

日期：2026-10-22 开始，验证延续至 2026-10-23（Asia/Singapore）。

本记录对应用户明确批准的七项修复，目标仅为独立 3080 预览、profile `sidebar-test`。保留现有工作台及主题改动；不修改宿主源码，不切换共享分支，不提交、推送或发布 npm。3384 桌面实例不参与部署。

## 已批准行为

1. 使用宿主原生 @，候选仅展示标题；空查询给本地置顶、最近资料与包，关键词搜索启用且允许提及的来源。未入库命中可见，只在选中时持久化稳定引用。
2. 连续插入文件／单条／包引用可用，保留已有文字和胶囊。调用公开输入方法，使用正确的 detect 坐标和 draftRev；异步完成时已编辑／提交／切会话的旧操作拒绝，不覆盖新草稿。
3. 移除 Agent 线索工具。同机 Agent 使用原生 curl 读取固定本机 API，不搬运浏览器 cookie、启动 token 或供应商凭据。
4. “插入草稿”改为“插入资料”，详情底栏右侧提供“加入线索包”和“插入资料”。有编辑草稿时 Save 是唯一主动作。收集窗不依赖 CluesTab 可见或挂载，从聊天引用、包成员详情均可进入。
5. 帮助为每浏览器首次一次的宿主 Modal，关闭才标记完成；三幅简单图解，`?` 可随时重开。保留原生 Escape、焦点管理与 aria-modal。
6. 同查询后台刷新保留结果、选择、草稿和滚动，仅在固定刷新控件显示忙碌状态；错误在结果区域重试。搜索上方不临时插入依赖检查／目录 spinner。写入按读族精确失效，无新轮询。
7. 飞书任务接受 CLI 原生成功包 `{code:0,data:{...}}`，同时保留 shortcut 的 `ok:true` 协议；非零退出、错误对象、`ok:false`、无 data 的裸 code0 不冒充成功。

## 根因与实现

### 连续插入

宿主 `InputState.draft` 是 clipboard 投影，引用会展开成较长文本；插入 span 使用 detect 投影，每个引用只占一个 U+FFFC。原逻辑把 `draft.length` 当作插入位置，已有引用后第二次越界；事件派发也无法报告实际插入失败。现使用公开 occurrences 换算和 `SessionInput.insertReference()` 的布尔结果。原生 @ 提供的 pick.span 已是正确投影，异步 ensure 后保留原 span／draftRev，不猜新修订号；mounted session 变化后拒绝旧回调。

### @ 候选缺项与请求堆积

原合并只保留已有 clueId，隐藏了来源搜索的原始命中。现只读展示原始候选，选择时 ensure，稳定 codec 名与历史草稿保持兼容，新菜单不再生成“包含内容”重复行。

首轮真实宿主还暴露第二个根因：宿主每键查询，多来源合并等待所有来源，而共享缓存给已取消搜索保留 5 秒连接，输入一个关键词产生 65 次搜索。本地命中 10ms 已返回，却等待排队的远端请求；宿主 pending 菜单保留上一代 recent 行。修复为非空查询停顿 300ms 后才发搜索，下一键或 dispose 立即取消等待；新关键词取消同工作区、同来源无人等待的旧在飞查询。其他活跃消费者、其他工作区／来源及同关键词 5 秒回切保护保留，不通过超时丢弃合法慢结果。

### 本机读取边界

固定 `POST /sidebar/agent/clues/read`；JSON 仅允许 `workspaceId`、`reference`、`sessionId` 与可选非负安全整数 `offset`／`snapshotOffset`，reference 恰好一个稳定 token，请求体最多 1 MiB。

唯一无登录例外要求真实 socket loopback peer、实际 listener port 和匹配的 loopback Host；拒绝 URL 参数、Origin、Sec-Fetch-*、Forwarded、X-Forwarded-*、非 JSON、GET／OPTIONS，不开放 CORS。其他本机进程同样可读，这是用户已接受的机器本地信任边界，不是进程身份隔离。其他 UI／HTTP／WS 路由继续使用原完整认证，不提供写入／安装／授权／任意方法分派。

工作区必须是已注册 id；当前工作区优先、最多 64 个工作区定位引用。clue 取当前内容，失败不自动返回历史正文；pack 每页最多 50 个当前成员，不预读正文；snapshot 只读取显式历史版本及时间／完整性。快照元信息每页 20 项，可续读，索引失败明确标记 `snapshotsUnavailable`。

首次绑定清单与后续用户消息中显式引用各自持久去重；注入 metadata、当前实例实际端口和 safely-quoted curl 读法，不预取正文。标题、工具输出或来源正文不制造新的引用意图。

### 资料收集与帮助

共享收集窗口拥有选包／新包表单与串行 CAS 写循环。取消不写；部分失败移走成功项、保留目标／新名称及未完成项；成功先释放关闭保护再关窗并刷新包架。窗口生命期独立于 Tab，已关闭草稿最多缓存 30 项，活跃或写入中的草稿由窗口组件持有，不参与淘汰。

帮助由原生 Modal 承载，localStorage 版本标记在关闭时写入；测试中专门的首访用例保留自动弹出，其余测试显式使用已看过帮助状态。portaled 模态沿用共享中性主按钮主题。

## 新鲜证据与边界

已验证：

- 飞书响应回归及相关适配测试 135 项通过；真实本机 CLI 只读 `task tasks list --page-size 1 --as user --format json` 返回 exit0、code0、data.items 非空，只记录结构和数量，不记录任务标题／正文。
- 集成后资料／帮助／缓存／主题定向测试 216 项通过；读取、注入、引用相关定向 121 项通过。
- 请求堆积新增回归先红后绿：34 项 mention、25 项缓存、11 项插入，共 70 项通过。覆盖 trailing 300ms、下一键与 dispose 立即取消、同关键词 5s 回切和其他活跃消费者保护。
- 收集草稿 lifetime 新增回归先红后绿，8 项通过，含 31 个其他实例不能淘汰活跃草稿、关闭重开和成功后清除。
- 主工作区真实宿主 UI／触控用例通过：每浏览器首次帮助、固定刷新反馈、列表保留、明暗与窄列、详情底栏真实边界、收集窗／分享操作。
- 每次集成均重新执行 typecheck、定向 ESLint、构建与打包。上游 primitives 包缺失 source map、jsdom 导航与历史 share 测试 act 提示为已观察到的测试环境警告，不当作运行时成功证据。

最终已完成（2026-10-23 00:44，Asia/Singapore）：

- 全量单元 **291 文件、4178 passed、18 skipped**；typecheck、135 个改动 TS／TSX 文件定向 ESLint、consumer-types、engines、build、pack 与 `git diff --check` 通过。首次受限运行的唯一失败是 HOME 临时夹具写入被阻止，授权环境重跑后全部通过；文档尾空格随后修正并复验。
- 精确 `@deepseek-ai/dsh@0.2.1-rc.1` 完整真实宿主门禁 **16 passed、3 skipped**（可选 context companion 未挂载），含重复文件／资料引用、未入库 @ 选择、无 Cookie 本机读取、原生 HMR、真实 xterm、明暗窄屏与触控。
- 3080 继续由原 PM2 服务 `dsh-sidebar-preview-3080` 管理，独立 `sidebar-test` profile，PID **37657**；3384 仍为原 PID **50833**。安装后实际页面无 pageerror，首访帮助、关闭完成标记和刷新后不再自动弹出均通过；帮助模态完全出现时背景为不透明主题色，截图禁用入场动画后取证。
- 实际 3080 无 Cookie 读取返回 HTTP **200**、业务 `status:ok`；跨站请求 **403**，额外写入方法字段 **400**，普通 UI API 无 Cookie 仍 **403**。本轮预览验证未发送聊天消息、未修改远端资源。
- 候选包 `dsh-better-sidebar-ui16-final.tgz` 的 SHA-256：`6f27746e4d0c7626b32611877efa9a8e424e69d7919fa107d11f318540570dd9`。安装后的全部 **704 个文件（含 8 个 bundle）**与归档、完整通过挂载的 scratch profile 逐字节对照一致。全量测试中的 package specs 会重跑 pack／prepare，并改变工作目录构建中 CSS 对象属性排列；因此安装比较使用实际通过门禁的归档，不以测试后重生成的工作目录 bundle 代替它。
- 证据：[包身份与 hash](../../.local/3080-preview/package-ui16-verification.json)、[安装后页面／接口验证](../../.local/3080-preview/verification-ui16.json)、[首访帮助截图](../../.local/3080-preview/installed-ui16-help.png)、[单元日志](../../.local/3080-preview/unit-ui16.log)、[完整挂载日志](../../.local/3080-preview/e2e-ui16.log)。

**飞书当前账号前提**：开始诊断时真实只读命令曾返回 `code:0 + data.items`，该成功格式已有正负回归覆盖，原解析错误已修复。安装后现场再次读取时，官方 CLI 独立返回 exit3、`authentication/token_missing`；其 `auth status --json` 明确显示 `identities.user.status:missing`，实际 3080 同样返回 `auth-required`。页面已验证显示明确“未授权”状态，不再是“no usable success envelope”。没有自动触发登录、授权或改写凭据；当前真实任务列表成功加载仍需用户在来源设置重新授权后验证，不把这个账号前提冒称为成功。

未验证：重新授权后的当前账号任务列表、真实 GitHub 写操作、飞书远程编辑／授权全流程，以及 Windows runner。keyless scratch mount 不证明供应商模型实际调用 curl，读取说明／去重和安全协议另有契约测试。
