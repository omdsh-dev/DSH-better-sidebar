# 2026-10-24 线索 UI19：正文、评论与 Agent 编辑

状态：实现、主树集成、完整门禁及仅3080部署冒烟均已完成。真实第三方写入和真实模型原生编辑未执行，明确不计作已验证。以 UI18 及其全部未提交改动为起点。本文记录本轮决定及新鲜证据，不把规划当作完成。

## 已批准决定

- 正文在上、评论在下；二者是同一资源内容。预览、Agent 默认读取、分享、离线快照均包含讨论，不用单独评论页签隐藏讨论。
- 本轮包括飞书文档全文评论、飞书任务评论、Issue/PR 普通评论与 PR 非空审核总结。公开 API 预留可选 anchor；本轮不渲染正文划词评论或 PR 代码行评论。
- 独立评论分页和回复分页，支持发表/回复；GitHub 普通讨论使用引用回复，不能伪装为原生线程。权限失败保留正文并明确讨论不可用。
- 批量解析飞书人员名字，缺授权/不可见时回退 ID，不逐行查询或自动授权。
- 划线可插入本段到草稿；在主/侧会话直接启动解释/续写/改写。解释不写，续写改写允许修改整个正文。处理评论选区只支持插入和解释。
- 统一临时正文文件流程：Agent 用原生文件工具编辑，POST 通知提交；文件原文本、任务描述和 Issue/PR body 使用文本/Markdown；飞书保留原生 XML、块身份和资源引用，不做 Markdown 全文覆盖。
- 新提交端点仅本机且无需额外凭据，用户明确接受其他本机进程也能调用；限定已准备 draftId，不接任意路径、命令或方法分发。旧读取端点维持只读。
- 技能和辅助脚本随插件打包，仅对应动作显式注入；不要求宿主原生 skill 服务。操作说明会保留在会话历史。
- 相同窗口内容可转入原生侧栏并恢复浮动，保留草稿、评论输入、滚动和返回栈；回侧栏在最大化左侧且始终图标+文本。
- 文件夹进入浏览、返回父级，另能定位侧栏文件树；正文目录复用现有 Markdown TOC，排除评论标题；长正文明确续读及版本检查。
- 线索范围内统一自有下拉样式；加强查找资料可折叠标题横栏及底部操作栏，保留条件出现逻辑。
- `.cluepack` v2 包含正文与讨论，兼容 v1 导入；旧快照为未采集评论而不是无评论。缺权限、限流或预算不足时明确不完整及覆盖范围。

## 执行边界

不提交、合并、推送或发布；不修改官方 DSH 源码。只部署独立 3080 `sidebar-test`，3384 桌面实例不参与。本轮开始时分支 `feat/clues-uiux-refresh`，HEAD `d3bfcf62f7b8bfee07f09581a6415c4c81ad3f99`。1189 个版本控制及未跟踪文件已保存本地基线（不含秘密）。五个隔离 slot 分别负责来源、草稿、预览、承载面、分享；共享契约和总装由主线程串行处理。最终集成比较基线而不是 HEAD，避免覆盖此前改动。

## 请求控制

维持激活期有界缓存、账号/会话隔离、隐藏门控、无新增周期轮询。关键词统一尾随500ms；UI刷新共享在飞请求并合并完成后一秒内点击，发送时强制 fresh read 仍独立新读。每来源连接最大并发2、启动间隔至少500ms、有界等待队列；限流冷却使用服务端可得时间或30秒，不自动重试写。评论、姓名查询、快照抓取共用闸门。

## 已落盘实现

- 一个公共讨论schema贯通live service、持久库及cluepack。正文/讨论独立分页；正文续读不重抓第一批讨论，显式includeDiscussion:true除外。实时页允许最多5000个卡片展开条目，另有8 MiB字节上限。
- 飞书文档显式遍历未解决/已解决两个phase并耗尽回复，防止CLI默认is_solved=false漏采已解决评论。任务使用原生评论；GitHub包含普通讨论及非空PR review总结，20节点/8 MiB独立预算。UI按已知时间升序、未知时间保留到达slot。
- required prepareCli先完成依赖解析，唯一provider gate再执行单次closure，保证真实命令启动间隔；已取消请求不先做probe，共享probe的其他等待者不受影响。无旧路径fallback、无写重试。
- 正文、评论和CodeMirror使用同一动作表。core/editor bundle通过页面Symbol共享handler/context/listeners；编辑器资源身份沿显式props及event-time resolver传递，不依赖跨bundle React Context。插入只改明确session的草稿；其他动作明确主/侧目标及requestId。
- 主会话走公开sessionController.prompt queue，侧会话走原有sidechat.start；接受回执不等于模型已完成。草稿和投递整体有界去重，解释只读。
- 本机临时完整正文、原生XML、基线核对、受限draftId commit、attempt marker及保留失败/partial/uncertain receipts已接入真实host入口。随包技能/helper经过tarball存在性检查；额外凭据例外没有扩张到通用API。
- Agent写入通过既有session-list的turn结束事件检查既有draft ledger并失效资源缓存，不增加WS/投影/周期轮询。极快turn未被观测、目标缺失或查询失败时保留显式Refresh；不宣称commit瞬间刷新。
- 浮窗与原生栏移动同一portal目标，详情和评论在同一滚动流；目录只扫描正文。统一SelectMenu使用真实host portaled Menu；选区菜单修正到同一1100层级，避免被90层浮窗遮住；Escape由popup捕获并尊重IME。
- 文件树定位已接入真实pathless files页、正确workspace/session的expanded/revealed。不同有效cwd/linked worktree、未知或外部根明确拒绝；后台仅排队，不新建/导航会话。
- v2讨论独立entry带path/bytes/sha256，导入兼容v1；旧快照未采集状态保留，真实service导出/导入/离线重开125条讨论的回归已通过。历史content-mode引用也保留第一批讨论及完整性/cursor标记。
- 所有21种既有语言新增50键；18份补充字典的旧key/value逐项与1189文件基线核对未变。

## 验证与候选

以下保留本轮实施过程；最终验收与部署时间以末节和机器记录的UTC时间为准，不把定向测试替代最终验收：

- 来源补线10套247项通过，真实gate工厂+虚拟时钟验证GitHub/飞书两prepared closure在900/1400ms启动；34卡/102消息跨公开normalizer通过。
- 预览/编辑器目标补线12套131项通过；文件树/native补线6文件214项通过；跨bundle bridge3文件42项通过。
- 草稿、提交端点、公开调度与服务权限有独立回归。普通agent和agent-edit均不能通过公共评论接口写入；agent-edit只用于显式正文草稿。
- 第一轮完整单测327文件：4540通过、18跳过、9失败。失败暴露旧select交互、route清单、React artifact stub、全语种键集与非隔离home fixture；均已按真实新契约修正，home fixture改到受控临时目录，不再写用户home。最终全量结果以下一节为准。
- 候选1仅用于第一轮排错。候选2 SHA256：`d94890fa5754d1cde59e1ae3d63ab605a48a0c45b6ec8653ca689af55c879e57`。已验证宿主精确0.2.1-rc.1、包内三份action skill/helper路径及打包后无prepare hook。
- 候选2真实mount定位了滚动140→0：普通append并不保留同DOM的浏览器滚动。已在局部RetainedSurface中用getSnapshotBeforeUpdate先于frame mutation捕获，接入后恢复；保留同portal/React树、断连gap和用户主动滚回0，无新增定时器。旧select/权限数量/文件行选择器与canonical路径fixture也按实际契约修正。终端失败定位为PTY沙箱EPERM，未弱化断言；候选3在允许PTY的隔离上下文原样通过。

## 最终验收与仅3080部署：已验证

部署浏览器记录时间：2026-10-26 02:02:20 +08:00（机器记录UTC为2026-10-25T18:02:20.619Z）。

- **最终候选3**：SHA256 `149c1e70310a1e49417fbc95e3787e3dec2dd28e00aa7de3393a2c95115cb352`。随包389个源码文件逐字节匹配当前主树；11项JS与动作技能/helper有独立hash manifest。部署使用同一个tarball，没有重打包替换。
- **整仓门禁**：typecheck、lint、build、pack、consumer-types、engines通过；327个单测文件全部通过，4551项通过、18项条件跳过。
- **真实0.2.1-rc.1挂载**：24项中21通过、3项按dsh-context未安装条件跳过；真实xterm、页面内native条目替换和性能/稳态门禁通过。UI19四项全通过：正文/评论与目录、实际选区菜单及主侧payload、390px同DOM/未发送草稿/140滚动往返与图标+可见文字、真实本地文件树祖先展开/高亮/视口内定位。没有force click、伪marker或弱化滚动断言。
- **3080实际部署**：只更新sidebar-test，PM2预览PID由24137变为67813。安装后的11项产物hash与候选3一致。新浏览器访问实际3080，插件及原生Clues页可见、5个来源及评论能力存在、实际下发editor chunk的SHA256 `1cb3e46dd8000b5958f07511b10de172c06244df2f7894d290032aa62cdcf84b`与候选一致；pageErrors为空，模型消息0、远端写入0。
- **3384保护**：PID仍72737，client.js SHA256仍`53b70b1b5317205247c074b8121e1ececec1df2dc3771b0641f0a66b8fd127e1`，与任务开始指纹一致。未更新、重启或替换桌面实例。
- **仓库边界**：分支及HEAD仍为本页执行边界所列值；没有commit、merge、push或release。3080由原PM2应用继续常驻；scratch测试服务已回收，没有新增开发watcher。

本地机器证据保留在`.local/clues-ui19/`：candidate3-manifest、candidate3-unit-tests、candidate3-typecheck/lint/build/pack/consumer-types、candidate3-mount、protected-deployments-before/after以及deployed-browser-verification。未把token或鉴权URL复制进本文。

## 未执行与诚实边界

真实第三方账号发帖/回复和真实模型原生编辑未执行，只使用隔离fixture与受控投递回执；不冒充账号联调。飞书复杂结构删除/移动会在写前拒绝并留稿；check-before-save不是供应商原子CAS，多步写入可能partial/uncertain，禁止盲重放。Agent自动刷新粒度是观测到turn结束，不是commit瞬间，仍保留显式Refresh。不同有效工作目录/linked worktree的文件树定位明确拒绝，不假装定位成功。
