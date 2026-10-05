# Issue 清理整理（2026-10-04）

> 全量复核 190 个 open issue（仓库共 354 个，已关 164）。本文是**清理前的分诊结论**：每个 issue 都补齐了类型 / 领域 / 优先级标签，并按「下一步动作」分成 10 组。标签已写回 GitHub。
>
> **2026-10-04 更新**：merge train PR #822 已合入 main（`fc09d1e`，三条 CI lane 全绿），A 组已按预期自动关闭 22 条；剩下的 3 条见 §三 A 组末尾。当前 open = **168**。
>
> **2026-10-04 清理已执行**：52 条关闭候选已全部处理完毕（关闭时都留了一句可复核的原因），当天共关 74 条（22 自动 + 52 人工），open 从 190 → **116**。逐条结果与两处分组修正见 §六。

## 一、标签口径

- **类型**：`bug` / `enhancement` / `question` / `documentation` / `refactor` / `chore`。
- **领域**：`area/sidebar`（原生承载面 / 布局 / 面板 / 交互）· `area/explorer` · `area/editor`（编辑器 + 预览）· `area/tabs`（tab 与文件预览类型）· `area/git` · `area/terminal` · `area/security` · `area/build` · `area/i18n`。跨领域或纯流程类不挂（190 条中 20 条无领域标签）。
- **优先级**：`P0` 崩溃/阻塞级，**或核心能力的缺失**（基本需求）· `P1` 影响日常使用 / 数据丢失 / 门禁红 · `P2` 功能性缺陷（有 workaround）或广泛需要的功能 · `P3` 体验与建议、窄场景，**以及已经修好或已不再适用的条目**（后者没有剩余工作量，标 P3 表示不必再排期）。
- 已有的优先级标签（此前手工打过的 81 条）原则上**保留不动**；只有「主题已从产品中消失」的 6 条下调（见 §四）。此前没有任何标签的 109 条由本次补齐。

## 二、总览

| 组 | 条数 | 处置 |
| --- | --- | --- |
| A 已被 merge train #822 修复 | 25 | ✅ 已关闭（22 自动 + 3 人工） |
| B 已在 main / 已发布修复 | 10 | ✅ 已关闭（completed） |
| C 已不再适用 | 27 | ✅ 已关闭（not planned，已说明原因） |
| D 疑似已修待复核 | 5 | ✅ 已关闭（completed / not planned） |
| E 重复 / 第三方 | 3 | ✅ 已关闭（指向 #668 / 宿主 / 上游） |
| F 已答复无需改动 | 2 | ✅ 已关闭（completed） |
| G 缺信息 | 7 | 2 条已关（#443 #804 版本线不匹配），3 条已追问（14 天无回应再关），2 条转入待办（#412 #640） |
| H 已有 PR 在飞 | 28 | 留在 open，推进 PR |
| I 保留待办 | 83 | 按 P2→P3 排期 |

注：A+B+C+D+E+F+G 共 79 条是本次清理的**关闭候选**（占 190 条的 42%）。其中 A 组的 22 条在 #822 合并时自动关闭，其余 **52 条人工关闭**，另有 3 条按「14 天无回应再关」处理（#432 #558 #681）。

## 三、逐组清单

### A. 已被 merge train 修好（合并 PR #822 后自动关闭）

PR #822 的 PR 描述里逐条列了 `Fixes #…`，已于 2026-10-04 合入 main（merge commit `fc09d1e`），GitHub 自动关闭了 22 条。三条没被 `Fixes` 覆盖的已单独复核：

- **#830（main 的 i18n 门禁红）→ 已修复**：在合并前后的两棵树各跑一次键集比对，合并前 19 份第三语言词典全部缺键（18 份缺 6 键、ja 缺 2 键，与 issue 描述逐字一致），合并后 19 份全部与 zh 的 519 键相等；main 上的 CI 也从 failure 转为 success（run [37188873774](https://github.com/omdsh-dev/DSH-better-sidebar/actions/runs/37188873774)）。可直接关闭。
- **#745（`sidebar_open` 打开 URL 后地址栏空）→ 已修复**：合并进来的 #718 把 URL 种子落进 tab 记录（`src/client/native/tab-adapter.tsx` 的 `params?.path ?? params?.url`），正是 issue 里缺的那一环。可直接关闭。
- **#651（思考链里点图片不渲染）→ 待复核**：报告者自己判断与 #622 同根因，而 #622 的修复已随本车（#754）上车；但图片 URL 的构造点与报告者描述的入口不同，建议按 #754 的路径解析改法实机点一次再关。

下面是这 25 条清单（除上述 3 条外均已关闭）。

- **#618** [P2] [Bug] v0.19.0 原生右侧栏：工作区内图片 / PDF 预览与下载全部 400「is not an absolute path」（文件地址是相对路径，/sidebar/file 只收绝对路径） — PR #822 #622
- **#636** [P2] [Bug] 切换对话后侧栏文件浏览器失灵：点文件夹/文件无任何反应，需重开该 tab（v0.19.0 / v0.19.1） — PR #822 #776
- **#643** [P2] [Bug] v0.19 openTab(seed.path) 对自定义 tab 也走 openResource：第三方 tab 点击即 400 cannot resolve target（dsh-chat-import 0.11.1 可复现 — PR #822
- **#644** [P3] native surface: activate() never focuses plugin tabs; onClose loses meta — PR #822 #736
- **#646** [P2] [Bug] fs.write 拒绝相对路径：第三方用 openFile 打开的（工作区相对路径）文件能读不能存（400 is not an absolute path） — PR #822 #655
- **#649** [P3] [Bug] 「添加到对话」选区浮层在玻璃皮肤下半透明透字：浮层 portal 到 body，吃不到皮肤对插件锚点的修正作用域 — PR #822 #650
- **#651** [P3] 思考链中点击图片会无法正常渲染 — PR #754
- **#660** [P3] [Bug] 原生右侧栏：当前选中的 tab 图标退化成默认文件夹图标（切走才恢复） — PR #822 #662
- **#661** [P2] [Bug] 切换 tab 后插件侧状态被清空：文件树展开集/终端选中态丢失，merged 就地打开的文件内容消失 — PR #822 #776
- **#676** [P2] [Bug] fence 403 被当成成功结果缓存：文件树一次 403 后不再重试，bfcache 恢复后表现为「一直打不开」 — PR #822 #677
- **#685** [P2] [Bug] 侧边会话收到主会话的待处理消息，疑似复制消息队列 — PR #822
- **#687** [P2] [Bug] 打开底部面板/创建终端后，原生右侧栏「文件」tab 文件夹无法展开（展开记录被瞬态卸载销毁） — PR #822
- **#692** [P2] HTML preview in the editor fails with ENOENT when opened from a tool-result chip — PR #822 #754
- **#693** [P3] [Bug] 文件树（files 页）在窗口重新聚焦后滚动位置跳回顶部 / File tree scroll position jumps to top after the window-focus refresh — PR #822
- **#694** [P2] [Bug] 跨会话打开会被静默丢弃：place() 信任 openTabIn()/openResourceIn()，目标会话未挂载右侧栏时打开丢失 — PR #822 #697
- **#695** [P2] [Bug] 文件树/产出文件卡片绕过原生 tab 注册表：第三方按具体扩展名注册的 tab 类型永远开不出来 / Explorer and produced-files row bypass sidebarRightTabs, so a c — PR #822
- **#703** [P2] 侧栏文件路径错误 导致无法直接预览文件的问题 — PR #822
- **#713** [P2] [Bug] `~` 不被当作绝对路径：isAbsolutePath 判否后被拼到会话 cwd 之后，报 cannot resolve target ENOENT — PR #822
- **#725** [P2] 通过 `dsh-resource://` 地址打开的文件加载失败：图片预览破图（工作区相对路径未解析为绝对路径） — PR #822
- **#732** [P1] 打开超过 readLimit(512KB) 的文件后保存，会把截断的部分内容整文件写回，静默丢失 512KB 之后的数据 — PR #822 #733
- **#745** [P2] sidebar_open 打开 http(s) URL 时标签页建出来了但 URL 丢失（native 侧边栏分支） — PR #718
- **#778** [P2] [Bug] Markdown 预览：锚点行残留裸闭合标签源码，且 <details> 折叠头丢失作者写的 summary 文案 — PR #822 #779
- **#788** [P2] 交付物（图表 chart.html）在 better-sidebar 里打开报 ENOENT / realpath '/capital-analysis/...'，官方 sidebar 则正常 — PR #822
- **#819** [P2] `/sidebar/html` 预览打不开「工作区相对路径」：解码器总是产出根锚定路径 — PR #822
- **#830** [P1] [Bug] main 的 i18n 键集门禁红着:18 份第三语言词典缺 6 键 + ja 缺 2 键;feat/merge-train-261001 上已有补齐提交,尚未合入 — PR #822 (i18n 前置提交)

### B. 已在 main / 已发布版本修好（复核后关闭）

- **#251** [P2] [Bug] Markdown 预览中 frontmatter 显示为巨大标题 / Markdown preview renders YAML frontmatter as a giant heading
- **#344** [P2] [Feature] 文件树基于 fs.watch 的自动刷新（含已验证的参考实现：按展开目录精确监听 + 无闪烁原地更新）
- **#390** [P1] v0.16.0 turnTail 产出文件接管会顶掉所有第三方 turnTail 插件（如 dsh-file-review）
- **#401** [P3] feat request: public file-tree icon provider API / 功能请求：公开文件树图标 Provider API
- **#446** [P3] WorkSpace包含两个项目仓库，源代码管理页面提示“当前目录不是 git 仓库”
- **#482** [P3] Feature request: "Delete" entry in the Explorer context menu (file & folder, workspace-safe)
- **#530** [P3] npm 0.18.0-alpha.0 在旧版 Git 报 git worktree list --porcelain -z: unknown switch z（main 已修复但未发布）
- **#610** [P3] 原生右侧栏指南页崩溃:TypeError: entry.description is not a function(0.19.0-alpha.1 + DSH 0.1.3-alpha.2)
- **#638** [P2] 重启后报错dsh-better-sidebar: Minified React error #130
- **#721** [P3] Bug: bottom panel toggle does not work — `sessionList.current` is always undefined

复核要点：#344 `src/fs-watch.ts` + `use-dir-watch.ts` 已落地；#401 `registerFileIcon` 已在接入 API 内；#482 文件树右键删除（`fs.remove`）已在；#390 turnTail 接管已整体删除；#446 多仓库支持（PR #326）；#251 frontmatter 由 `tests/markdown-frontmatter.spec.tsx` 守护；#610 `/guide` 的 `entry.description` 已做函数化归一（`guideDescriptionOf`）；#721 幽灵字段 `sessionList.current` 已从代码中消失；#530 `git worktree … -z` 兼容已随新版本发布；#638 图标族改名已在 v0.21.1 适配。

### C. 已不再适用（建议按 not planned 关闭）

这些条目的主题在当前插件里**已经不存在**，不是「以后再做」而是「已经没这块代码」：

- **自带终端类**（v0.20/0.21 把终端整体交还 DSH 内置，插件不再带 node-pty / xterm / PTY 路由）：#112 #175 #225 #287 #293 #352 #362 #445 #465 #511 #624
- **自带浏览器 / 自由窗口类**（浏览器视图交还宿主 `ui-sidebar-browser`，自由窗口整体移除）：#222 #480 #560 #599
- **工作区路径围栏类**（v0.24.1 起删除了工作区包含检查，"is outside workspace" 不复存在）：#383 #442 #519 #532 #571
- **宿主版本线已不支持**（现在只支持 DSH 0.2.0-rc.1+）：#283 #529 #533 #539 #553 #679 #783

- **#112** [P3] Windows 服务（无控制台）环境下使用终端时 node-pty 反复崩溃：AttachConsole failed
- **#175** [P3] [bug] 父进程环境污染导致终端工具功能异常
- **#222** [P3] [Bug] 内嵌浏览器无法打开百度（baidu.com）：HTTPS→HTTP 协议降级跳转在沙箱 iframe 内无法显示 / Sidebar browser can't load Baidu: HTTPS→HTTP downgrade 
- **#225** [P3] 加一个快捷键吧.
- **#283** [P3] [Bug] 安装后 resume 会话报错 agent-presets: refusing to compose an unscoped context
- **#287** [P3] 终端选项通过下拉菜单选择
- **#293** [P3] dsh-better-sidebar在deepseek-harness-desktop展开的底部面板的powershell终端中不能鼠标右键粘贴，但可以ctrl+v粘贴
- **#352** [P3] feat: opt-in transparent terminal background (wallpaper/skins cannot show through the terminal)
- **#362** [P3] Windows PowerShell 终端（ConPTY 显式配色）黑底深灰字，对比度极低
- **#383** [P3] [Feature] 可选开关：允许在侧边栏查看工作区外的文件（默认关闭、建议只读，保留 #328 安全围栏）
- **#442** [P3] [Feature] Add an option to access files outside the workspace
- **#445** [P3] [Feature]终端命令操作可以跨工作空间操作，没有任何权限范围控制，是否可以增加当前工作空间的操作权限控制
- **#465** [P3] dsh-better-sidebar powershell中，ctrl+c快捷键会打断，ctrl+shift+c会打开浏览器的样式表
- **#480** [P3] [Bug] Browser tab: raw Chromium 'refused to connect' when host probe can't see the site's framing block (fingerprinted s
- **#511** [P3] Terminal content overlaps when scrolling up to view history
- **#519** [P3] 软链接文件无法直接打开，提示 is outside workspace
- **#529** [P3] PR #516 (适配 alpha.5) 已合并但 npm 未发 0.19.0-alpha.0，alpha.5 用户只能用 0.18.0-alpha.0
- **#532** [P3] 点击对话中工作区外的文件引用报 403 path is outside workspace，期望降级为只读预览或回退系统打开
- **#533** [P3] DSH-0.1.2-rc.1 下 dsh 启动不了
- **#539** [P3] [Bug] Side Chat: open a new thread fails with "Cannot read properties of undefined (reading 'length')" on DSH 0.1.2-rc.1
- **#553** [P3] 在移动端报错dsh-better-sidebar：cannot get property 'bettersidebar' without inject
- **#560** [P3] Page loading issues in embedded browser
- **#571** [P3] [Bug] HTML 预览：工作区外文件点「临时解锁」仍 forbidden，刷新又回沙箱——解锁不解路径围栏，形成死循环（关联 #532）
- **#599** [P3] Free window header occluded by client top bar -> tab stuck at top / 浮窗页眉被顶栏遮挡，tab 卡在顶部拖不回来
- **#624** [P3] 跨会话 pinned 终端收不到实时等待状态（banner / ⏳ 徽章）
- **#679** [P3] 0.19.1 在 DSH 0.1.5-rc.x 上客户端报 reading 'kind'：两个 peer 包在 npm/宿主均不存在
- **#783** [P3] Changes tab crashes (React #130) + terminal.js chunk fails to load on core 0.1.5-rc.3 (works on 0.19.1)

### D. 疑似已修，需一次复核

- **#231** [P3] Mermaid chart rendering issue after update to 0.13.1
- **#253** [P3] 预览功能，本地html页面样式丢了不加载，导致页面错乱排版
- **#601** [P3] 官方新版 DSH 支持右侧 sidebar 后，折叠按钮重叠导致体验下降
- **#746** [P3] [Bug] 0.1.6-alpha.2 点击文件无反应：openSidebarFile 未把 sessionId 传给 openTab（独立于会话来源问题的一行修复）
- **#747** [P3] dsh设置侧边栏内，侧边卡片选项，1.显示空白；2.通过dsh + deepseek v41 flash修复后，解决了空白，但无法保存操作结果（切换功能后）

> **#746 补充（#822 合并后）**：报告环境（宿主 0.1.6-alpha.2）已不在支持线内，而文件打开链路已被本车重写——`openSidebarFile` 现在接收 `sessionId` 并用它解析 cwd，被原生类型认领的地址走 `fileAddressFor(sessionId, cwd, path)` 的会话作用域地址，跨会话打开改为排队到上屏重放（#697）。实机点一次即可关。


### E. 重复 / 第三方问题

- **#620**（第三方按 0.18 契约注册 tab 导致 `reading 'kind'` 崩溃）：与已按 NOT_PLANNED 关闭的 #668 同题，按 duplicate 关闭，指回 #668。
- **#639**（`leafNodes` 崩溃）：根因在宿主 bundle（`leafNodes` / `observationTabOpen` 在 DSH core 里），触发者是 browser-skill 插件往本插件承载面注册了非法描述符 → 关闭并指向宿主机 / browser-skill。
- **#666**（dsh-dream-skin 注入 CSS 命中本插件哈希类）：CSS Modules 哈希被第三方硬编码命中，已在上游仓库 RevolutionLA/dsh-dream-skin#49 报告 → 关闭并指向上游（可选：本仓库换哈希前缀只治标）。

### F. 已答复 / 通知类

- **#444** [P3] 使用`dsh plugin --profile web update`无法更新dsh-better-sidebar
- **#615** [P3] 关于您的侧边对话功能的一些疑问

### G. 缺信息无法定位

- **#412** [P3] BUG：右键在应用中打开无反应
- **#432** [P1] [Bug] DSH 工具调用通道全局卡死（Plugin enabled → all tool calls hang），在 DSH 0.1.1-rc.2 上稳定复现
- **#443** [P3] [dsh-plugin.org | dsh-plugin-hub] plugin install failed: omdsh-dev/dsh-better-sidebar
- **#558** [P3] Side chat was unable to respond
- **#640** [P3] 底部面板错误置顶
- **#681** [P3] Follow Model
- **#804** [P3] 关于在fnos-dsh项目中使用dsh-better-sidebar报错。

其中 **#432**（插件启用后工具调用通道全局卡死）是全仓库唯一仍挂着 P1 的历史问题：复现环境是插件 0.16.1 + DSH 0.1.1-rc.2（当前已不支持该宿主线），38 天没有复验回应，维持 P1 但它需要的是「拿到能复现的环境」而不是改代码。

### H. 已有独立 PR 在飞

- **#80** [P2] 源代码管理 输入框右边期望增加AI生成提交消息功能 — PR #642
- **#333** [P3] [Feature Request] 子代理「任务管理」页增加「只看运行中」状态筛选 — PR #381 #608
- **#348** [P3] [Feature Request] 子代理「任务管理」页增加右键安全删除 — PR #418
- **#406** [P2] 文件预览/编辑器：ANSI（GBK/GB2312）文件打开乱码，保存会悄悄转成 UTF-8（附零依赖完整修复 patch） — PR #523
- **#513** [P3] [BUG] 「在资源管理器中打开」无法定位路径包含空格或特殊字符的文件 #Win — PR #521
- **#556** [P3] [bug] Windows + Git Bash(MSYS) 会话:点击 /e/... 盘符映射路径报 cannot resolve target "C:\e\..." — PR #566
- **#559** [P2] better-sidebar 侧边栏不渲染，依赖它的插件（server-deck / ssh-tunnel）tab 也看不到 — PR #617
- **#564** [P3] VSCode SSH无法打开文件（后续） — PR #565
- **#591** [P3] [bug] WSL 下「打开方式」/「在资源管理器中打开」静默失败：linux 分支固定 spawn xdg-open，且 vscode://file/ 形式不适用于 WSL — PR #612
- **#616** [P2] [Bug] 皮肤（backdrop-filter 类）下侧边栏整条不可见：面板宿主层几何塌陷，DOM 仍在 / Whole sidebar invisible under backdrop-filter skins — panel host — PR #617
- **#623** [P2] No sidebar appeared when a new session is started — PR #807
- **#672** [P2] [Bug] 0.19.1 版本不支持记住当前已经打开的面板并默认打开了吗 — PR #807
- **#683** [P3] [BUG]预览md文件mermaid图缩放不对 — PR #829
- **#684** [P2] [Bug] 侧边对话：打开 Tab 即落一个空会话（未发任何消息）；旧线程换会话后无法召回 — PR #839
- **#690** [P3] git 操作遇 "detected dubious ownership" 报错，无法识别 git 仓库 / 显示变更数 — PR #827
- **#698** [P2] [bug] v0.19.x 开合按钮迁入会话头槽后,空白新会话中右侧栏/底部工作台入口全部消失(0.18.x 无此问题;附根因与修法,关联 #623 / #672 / #601) — PR #807
- **#737** [P3] [Feature] 子代理/后台任务跑完后自动收起侧边栏（可选的「完成后自动收起」开关） — PR #738
- **#753** [P2] [Bug] 反代子路径挂载下侧栏全部请求 404:客户端 fetch/WebSocket 走源站绝对路径,未适配 dsh 0.1.7 <base href> 挂载相对化 — PR #584
- **#762** [P2] [Bug] 侧边对话「切换线程」点击无效：菜单关闭但不切换、也不创建标签（0.1.7-rc.1 + 0.21.1，Desktop/Web 均复现） — PR #839 #736
- **#767** [P3] 诊断红条只增不减（无移除路径） — PR #824
- **#784** [P3] v0.22.0 任务页:根卡折叠 chevron 死控制 / run 成员绕过 leaf+idle 阈值守卫 / foldedIds 文档自相矛盾 — PR #814
- **#798** [P2] v0.24.1「压缩并下载」必然失败:archive.status 客户端载荷缺 sessionId(宿主 400);修复后 ready 轮询不停止还会双下载/误报 — PR #814 #809
- **#799** [P2] fs.trees 64 路径硬上限 + 客户端单批不分块:展开目录 ≥64 的会话挂载/刷新整树报错 — PR #811
- **#800** [P2] [Bug] 崩溃重启后子代理状态错误：被中断的子代理显示为「运行中」（activity=会话驻留被当成 agent 运行） — PR #814 #813
- **#801** [P2] 侧边栏的"文件"按钮，搜索文件夹时，点击文件夹名称，报错:xxxx is a directory — PR #806
- **#805** [P3] [Bug] mermaid 放大视图工具栏落在 Windows 标题栏保留区：关闭键只有底部约 10px 可点（0.24.1 + Electron titleBarOverlay 42px） — PR #812
- **#826** [P2] [Bug] 正文里 `[path](path:131)` 形式的文件链接点不开（报文件不存在）；`#L131` 能打开但不跳行 — PR #828
- **#831** [P3] [功能请求] 文件树右键菜单支持"新建文件" — PR #832

### I. 保留待办

按优先级：

**P1（0 条）**


**P2（29 条）**

- **#18** [P2] 资源管理器是否可以增加文件过滤功能
- **#98** [P2] Feature request: 文件行右键菜单支持第三方动作扩展
- **#109** [P2] [Feature Request] Tab 右键菜单：全部关闭/关闭右侧标签/在资源管理器中定位
- **#131** [P2] [Feature] 向 VSCode 看齐:资源管理器文件类型图标、Git 行数统计/分支状态、pane 级管理
- **#132** [P2] [Feature] 资源管理器文件管理:排序选项、搜索/快速打开、新建文件与文件夹(重命名/删除)
- **#155** [P2] 提些需求
- **#161** [P2] [BUG] autoOpenJobs 触发时打开的是 Subagent 页而非聚焦 Jobs 区块（注释与实现不符）
- **#186** [P2] 【建议】资源管理器优化
- **#194** [P2] 【建议】源代码管理的提交和分支的显示能不能固定到源代码管理的头部，不跟随下面的文件进行滚动。
- **#212** [P2] [Feature] 编辑器 Git 联动：行级 blame + 变更标注 + 文件树状态徽标
- **#219** [P2] 底部面板未打开时点文件不会自动展开宿主面板；面板落底部/侧边由 activePane 决定且不可配置
- **#316** [P2] ✨ [feat(git)] Git 更改支持按目录树状/层级显示 / Git changes: hierarchical tree view
- **#319** [P2] 宽窗口下拖宽右侧面板会触发官方外壳左侧会话栏自动折叠
- **#358** [P2] Feature request: Show in Finder + Copy file in the file-tree context menu
- **#403** [P2] 性能：大分组展开一次全量挂载数百行 DOM + #root 全树 MutationObserver，长会话下侧栏展开卡顿
- **#430** [P2] [Bug] 最新版 dsh-desktop 上「位置兼容模式」失效：preset/custom 任何配置都不改变展开按钮位置
- **#431** [P2] [Feature] 把「插件入口」与「打开的文档」分成两层：常驻 activity bar + 可关闭 tab（TabDescriptor.pinned）
- **#459** [P2] [Bug] dsh-desktop 2.0.4 <增强模式> 侧边栏悬浮在对话区域之上，对话区域没有正确自适应宽度
- **#479** [P2] [Bug] 文件树 @ 引用与 DSH 0.1.2-alpha 原生 @ mention 语法不适配（空格不加引号 / 目录无尾斜杠 / 基准路径不一致）
- **#481** [P2] 侧边栏展开按钮被窗口关闭按钮挡住，点不开侧边栏
- **#510** [P2] layout-push 契约在 DSH Desktop advanced 模式下未集成，中间栏不缩窄
- **#573** [P2] 通过 dsh-mobile 远程访问时右侧边栏终端 WebSocket 连接失败（1006）
- **#596** [P2] [bug][macOS Desktop] 右侧栏 tab 条顶部按钮点击失效（×/+ 经常点不动），底部面板正常
- **#734** [P2] 变更页签会话镜头对大文件 diff 走 O(n×m) 稠密 LCS：主线程冻结数秒，上万行直接渲染进程 OOM 白屏
- **#765** [P2] git.discard 在「会话 cwd 位于仓库子目录 + 同名相对路径存在」时会还原错误的文件
- **#774** [P0] [Feature/Regression] 0.21.1 移除自带终端后，底部工作台缺少终端入口，希望接入 DSH 原生终端
- **#808** [P2] Tasks page: job output is unreadable unless the model reads the job first
- **#833** [P2] dsh-better-sidebar ime-guard breaks layout-switcher text replacement (KeyRay / Punto-style apps)
- **#834** [P2] [Bug] 桌面端（dsh-app:// origin）下 sidebar_open 与文件树实时刷新完全失效：WebSocket 被拼成 ws://app/...

**P3（54 条）**

- **#119** [P3] 希望增加侧边连标签页双击关闭功能
- **#163** [P3] 希望可以同步劫持左侧栏和中间的工作区
- **#185** [P3] 友情链接建议：DSHPlugin.app 已收录 DSH Better Sidebar
- **#211** [P3] Feature request: host-side openTab RPC / agent tool to drive the sidebar browser (further DSH automation)
- **#213** [P3] 希望增加代码预览可以更换代码主题
- **#218** [P3] feat(browser): render sidebar browser via <webview> to bypass X-Frame-Options
- **#220** [P3] 文件板块ui使用反馈
- **#223** [P3] [Suggestion] 未安装 Office 预览插件时，点击 .docx/.xlsx/.pptx 无预览且无安装引导；README 功能一览仍宣称内置 Office 预览 / No preview or install guidance
- **#234** [P3] 增强源代码管理的功能
- **#238** [P3] 主机deepseek harness使用ssh连接到远程机器（通过dsh-remote插件），无法使用DSH-better-sidebar功能
- **#245** [P3] [Feature] Surface recent media (audio/video) in sidebar
- **#256** [P3] [Feature Request] 为 type-only openTab 提供面板展开通道
- **#288** [P3] 能否拓展自带的计划方案可以再右侧显示
- **#290** [P3] 希望增加配置，支持“隐藏展开底部面板按钮“开关
- **#306** [P3] 增加路径搜索
- **#346** [P3] diff 文件默认折叠后，改 md/json/yaml 反而每次都要多点一下展开
- **#375** [P3] 希望增加支持打开VS Code的工作区 *.code-workspace
- **#388** [P3] 像cursor那样拖文件或者文件夹名称到对话框
- **#393** [P3] Feature request: 媒体查看器内「上一个 / 下一个」文件导航
- **#436** [P3] [Bug] 侧边栏引用本地文件后，引用链接吞并后续中文文本且整行不可折行，消息溢出气泡边框（v0.16.1）
- **#439** [P3] 显示文件内容的时候是否可以将变动对应的行号增加颜色，直接可以看出变化。
- **#449** [P3] [Feature Request] 拆分纯净的 Better Sidebar Core 基础包
- **#473** [P3] [友好通知] 侧栏/底栏入口按钮可被 @max-null/dsh-quick-toolbar 动态聚合（生态双向价值）
- **#474** [P3] [Audit] jobs/subagents/agents 服务 ctx.get 未判空（约 3018/3412/3580/3060 行）
- **#483** [P3] 增加文件编辑自动保存功能
- **#485** [P3] Feature request: support clipboard paste upload in the files explorer
- **#488** [P3] [Feature] 用户文件操作闭环:文件树右键删除 + 源代码管理 Discard,并自动通知 AI(仿权限切换的 runtime-context 体验)
- **#502** [P3] [Feature] 「任务管理」页在子代理之外展示 agent 规划的任务清单，并在任务编排后自动展开侧边栏
- **#546** [P3] schemastery 应改为 @deepseek-ai/schemastery 并作为 peerDependency，而非普通 dependency
- **#552** [P3] 功能请求:侧边栏文件窗口缺少"全盘浏览"导航入口
- **#555** [P3] 浏览器全屏(F11)时,侧边栏的顶部不能点击,约20px大小
- **#563** [P3] Git brunches creation and worktrees management
- **#567** [P3] 在 DSH Desktop 中 (兼容模式 扩展窗口模式) 打开 DSH 配置菜单 会导致 sidebar 遮挡住配置菜单
- **#570** [P3] 通过 dsh-mobile 远程访问时无法使用 SSH 工具
- **#572** [P3] 能否增加Fortran语言文件渲染？非常感谢
- **#581** [P3] 「一期一会」DSH-better-sidebar 的观测数据分享（第 1 期）
- **#583** [P3] 展开侧边栏，对话定位光标消失
- **#588** [P3] 可以添加类似：右侧沙箱 HTML 预览 → 在预览页面框选 DOM 区块 → 一键注入对话输入框。这样的功能吗？
- **#602** [P3] 希望侧边会话注入提示词时带上主会话 sessionId
- **#614** [P3] 侧边栏和底部栏会挡住设置窗口
- **#629** [P3] 建议新增一个用量记录显示
- **#630** [P3] 建议实现类似 vscode 的 explorer.fileNesting 功能
- **#635** [P3] 能不能增加一个文件后缀类型筛选显示功能?
- **#648** [P3] [Bug] 页签条两处视觉缺陷：×/+ 被裁 5px；激活态标题末字被 × 压住 14px（根因在官方前端 CSS，此处附实测数据）
- **#657** [P3] [Feature] 点开对话中的文件应能就地看到「这一步改了什么」：编辑器内「对比修改前 / 对比最新」+ 统一·并排双布局
- **#702** [P3] [Feature] 对话里点开的预览页签缺少「在访达中显示 / 用默认应用打开」出口：预览能力有限时需要 Finder 兜底
- **#735** [P3] 自动打开时能否指定底部还是侧边
- **#743** [P3] [Feature Request] 提供侧聊引用草稿 API，支持外部插件准备提问而不自动发送
- **#759** [P3] 侧边栏@文档的位置与新增文件修改日期
- **#790** [P3] [Feature] 文件列表交互优化：tab 图标与列表同源、全局单实例且默认打开、打开即替换当前 tab
- **#820** [P3] [Tracking] 终端 Tab 双击重命名：实现已就绪，等底部工作台恢复终端入口（原 PR #209）
- **#835** [P3] [Bug] 收起底部工作台：对话列的布局推挤不过渡（面板滑 300ms、内容同帧瞬跳），与展开方向不对称
- **#836** [P3] [Bug] Successful agent-opens connections do not reset reconnect failure count
- **#838** [P3] [Feature] 让 Markdown 等扩展名可让渡给原生文档预览（HOST_OWNED_EXTS 可配置化）

## 四、优先级调整记录

原有优先级标签中下调了 6 条（主题已消失，下调表示「不需要再排期」）：

| Issue | 原 | 现 | 原因 |
| --- | --- | --- | --- |
| #112 | P1 | P3 | 自带终端（node-pty）已整体移除 |
| #175 | P1 | P3 | 同上，终端环境不再由本插件提供 |
| #283 | P0 | P3 | 宿主 0.1.0-rc.8 线，当前基线只支持 0.2.0-rc.1+ |
| #293 | P2 | P3 | 自带终端已移除 |
| #362 | P2 | P3 | 自带终端已移除 |
| #465 | P2 | P3 | 自带终端已移除 |

另有 42 条新打 P1/P2（此前完全没有优先级标签）的高优先条目，主要落在「文件打开 / 路径解析 / 原生承载面状态」三簇（#732 #830 #753 #774 #798 #799 #800 #801 #808 #819 #826 #833 #834 等）。

## 五、建议的下一步

1. ~~**先推 PR #822 合入**~~：✅ 已完成（`fc09d1e`），A 组 22 条自动关闭，main CI 转绿。
2. ~~**关闭 B–F 组 + A 组剩余（共 50 条）**~~：✅ 已执行，实关 52 条（见 §六）。
3. ~~**G 组统一追问**~~：✅ 已执行——#432 / #558 / #681 各留一条追问（声明 14 天无新证据即按无法复现关闭）；#443 #804 直接关闭（版本线不匹配）；#412 #640 转入待办（它们其实不缺信息）。
4. **H 组（28 条）逐 PR 推进**：这些 issue 本身不需要决策，瓶颈在 review。若要减负，可优先合 #617 / #807 / #839 / #584 这几条「一条修多个 issue」的。
5. **I 组（83 条）按 P2→P3 排期**（P2 29 条 / P3 54 条，无 P1）：P2 里，「路径解析」「原生 tab 状态」「反代 base path」三簇已有在飞或已在 train 的修复，实际新开工作量主要集中在桌面壳形态（#459 #510 #596 #834）与 git 面板（#765 #690）。
6. 可选：新增两个流程标签 `close-candidate` / `needs-info`，把「可关」与「等回应」直接编码进标签面（本次没有新建，避免与既有体系冲突）。

---

## 六、执行结果（2026-10-04）

**关闭 52 条**（每条都带一句可复核的原因）：

- A 组剩余 3：`#651` `#745` `#830`（#830 用合并前后的键集比对实证；#745 是 #718 的 `params?.path ?? params?.url`）
- B 组 10：`#251` `#344` `#390` `#401` `#446` `#482` `#530` `#610` `#638` `#721`
- C 组 27：终端 11（`#112` `#175` `#225` `#287` `#293` `#352` `#362` `#445` `#465` `#511` `#624`）· 浏览器/浮窗 4（`#222` `#480` `#560` `#599`）· 路径围栏 5（`#383` `#442` `#519` `#532` `#571`）· 旧宿主线 7（`#283` `#529` `#533` `#539` `#553` `#679` `#783`）
- D 组 5：`#231`（升级瞬态，重启即好）`#253` `#601` `#746` `#747`
- E 组 3：`#620`（duplicate of #668）`#639`（宿主 core + 第三方触发）`#666`（上游 dsh-dream-skin）
- F 组 2：`#444` `#615`
- G 组 2：`#443` `#804`（均为宿主版本线不匹配）

**分组修正的两条**（原判「缺信息」，实际信息充分）：

- `#412`（右键「在应用中打开」无反应）：两条独立根因已由两位报告者补齐（win32 的 `vscode://file/`；Desktop 壳泄漏 `ELECTRON_RUN_AS_NODE=1`）→ 解除缺信息状态，**P3 → P2**，保留待办。
- `#640`（底部面板盖住设置面板）：复现步骤与截图齐全，是真实 z 序缺陷 → 转入待办（P3，未发言）。

**仍开着且已追问的 3 条**：`#432`（要受支持组合上的复现）· `#558`（要 preset 与 console 日志）· `#681`（要明确「follow model」指哪处）。都写明了 14 天无新证据即按无法复现关闭。

**当前 open = 116**：H 组 28（等 PR review）+ 待办 85（I 组 83 + `#412` + `#640`）+ 已追问 3。

---

## 七、排期（2026-10-04）

> 已落地到 Projects v2 看板：**[omdsh-dev/projects/1](https://github.com/orgs/omdsh-dev/projects/1)**（已关联本仓库，见 `repository.projectsV2`）。
>
> - **条目**：116 个 open issue + 88 个 open PR = **204 条**，全部写了字段值、零缺失。
> - **字段**：`优先级`（P0–P3）· `批次`（R0–R3）· `Status` 已按流水线拆为 `Todo` / **等待审核** / **等待开发** / `Done`（带说明文案）。
> - **视图**：`#1 总表 · 全部条目`（Table）· `#2 队列看板 · 按状态`（Board，分组仍待在页面上点一次：`Group by → 批次` 或按 Status）。
> - **状态分布**：等待审核 120（32 条 R0 issue + 88 个 PR）· 等待开发 84。
> - **PR 的优先级**：从它引用的**仍开着**的 issue 继承（27 个得值）；引用不到或不引用 issue 的 61 个 PR 留空，等 review 时顺手定。
> - ✅ **public 已完成**（2026-10-04，由组织 owner 设定）：`public: true` 已可读到；项目说明（README）已改成中英双语，包含批次/优先级/状态口径与用法。
> - ⚠️ 视图**分组**仍只能在 UI 设：公开 API 的 `ProjectV2ViewConfigurationInput` 只有 `visibleFieldIds`，没有 group-by，所以 `Group by → 批次` / `→ Status` 需要手点一次。

口径：**批次 = 行动优先级**，不是发布承诺。R0 不需要开发（等 PR review，瓶颈在 reviewer）；R1 = 立即（下一版本窗口，2 周内）；R2 = 下一窗口；R3 = 待排期。

| 批次 | 条数 | 含义 |
| --- | --- | --- |
| R0 · 等 PR review | 32 | 修复已在开着的 PR 里（16 条 P2 + 16 条 P3），只需 review/合并 |
| R1 · 立即 | 10 | P0 1 + P1 1 + 7 条影响日常使用/破坏性的 P2 + 1 条低成本 P3 |
| R2 · 下一窗口 | 21 | 其余 P2：桌面壳几何簇、Git 面板重构、资源管理器交互、性能 |
| R3 · 待排期 | 53 | 53 条 P3：体验/建议/窄场景 |

### R1 · 立即（下一版本窗口）

| Issue | 优先级 | 领域 | 标题 | 做法 |
| --- | --- | --- | --- | --- |
| [#432](https://github.com/omdsh-dev/DSH-better-sidebar/issues/432) | P1 | sidebar | [Bug] DSH 工具调用通道全局卡死（Plugin enabled → all tool calls hang），在 DSH 0.1.1 | 等一份受支持组合上的复现（已追问）；没有复现前不开工，避免修错地方 |
| [#412](https://github.com/omdsh-dev/DSH-better-sidebar/issues/412) | P2 | explorer | BUG：右键在应用中打开无反应 | 两条腿：win32 的 `vscode://file/` 打开腿；Desktop 壳泄漏 `ELECTRON_RUN_AS_NODE=1` 时绕开 VS Code CLI 入口 |
| [#734](https://github.com/omdsh-dev/DSH-better-sidebar/issues/734) | P2 | tabs | 变更页签会话镜头对大文件 diff 走 O(n×m) 稠密 LCS：主线程冻结数秒，上万行直接渲染进程 OOM 白屏 | 会话镜头 diff 换分块 + 上限，避免 O(n×m) 稠密 LCS 冻结主线程 |
| [#753](https://github.com/omdsh-dev/DSH-better-sidebar/issues/753) | P2 | sidebar | [Bug] 反代子路径挂载下侧栏全部请求 404:客户端 fetch/WebSocket 走源站绝对路径,未适配 dsh 0.1.7 <ba | 客户端 fetch/WS 改走相对 base（`<base href>` / 壳注入 base），与 #584 同式 |
| [#765](https://github.com/omdsh-dev/DSH-better-sidebar/issues/765) | P2 | git | git.discard 在「会话 cwd 位于仓库子目录 + 同名相对路径存在」时会还原错误的文件 | `resolveGitPath` 的相对路径优先级会让 discard 打错文件；改成按调用方给的基准显式判定 |
| [#774](https://github.com/omdsh-dev/DSH-better-sidebar/issues/774) | P0 | sidebar | [Feature/Regression] 0.21.1 移除自带终端后，底部工作台缺少终端入口，希望接入 DSH 原生终端 | 底部工作台接回宿主原生终端入口（宿主 `terminal` tab 类型已在原生右栏提供）；#820 的终端 tab 重命名等它恢复入口 |
| [#808](https://github.com/omdsh-dev/DSH-better-sidebar/issues/808) | P2 | sidebar | Tasks page: job output is unreadable unless the model reads the job fi | 任务页输出改读宿主 `ctx.jobs` 的推送保留输出，不再要求模型先 `job_output` |
| [#833](https://github.com/omdsh-dev/DSH-better-sidebar/issues/833) | P2 | editor | dsh-better-sidebar ime-guard breaks layout-switcher text replacement ( | ime-guard 的全局 keydown 拦截误伤其它输入法/替换类应用；收窄到焦点在插件自己的可编辑面 |
| [#834](https://github.com/omdsh-dev/DSH-better-sidebar/issues/834) | P2 | sidebar | [Bug] 桌面端（dsh-app:// origin）下 sidebar_open 与文件树实时刷新完全失效：WebSocket 被拼成  | 桌面壳 `dsh-app://app` origin 下 WS 被拼成 `ws://app/...`：改走壳注入的 transport base（与 #822 里 #797 同式） |
| [#640](https://github.com/omdsh-dev/DSH-better-sidebar/issues/640) | P3 | sidebar | 底部面板错误置顶 | 底部面板 z 序低于宿主设置弹窗（低成本，顺手做） |

### R2 · 下一窗口（按簇开工，一次修一类）

| Issue | 优先级 | 领域 | 标题 |
| --- | --- | --- | --- |
| [#18](https://github.com/omdsh-dev/DSH-better-sidebar/issues/18) | P2 | explorer | 资源管理器是否可以增加文件过滤功能 |
| [#98](https://github.com/omdsh-dev/DSH-better-sidebar/issues/98) | P2 | explorer | Feature request: 文件行右键菜单支持第三方动作扩展 |
| [#109](https://github.com/omdsh-dev/DSH-better-sidebar/issues/109) | P2 | tabs | [Feature Request] Tab 右键菜单：全部关闭/关闭右侧标签/在资源管理器中定位 |
| [#131](https://github.com/omdsh-dev/DSH-better-sidebar/issues/131) | P2 | explorer | [Feature] 向 VSCode 看齐:资源管理器文件类型图标、Git 行数统计/分支状态、pane 级管理 |
| [#132](https://github.com/omdsh-dev/DSH-better-sidebar/issues/132) | P2 | explorer | [Feature] 资源管理器文件管理:排序选项、搜索/快速打开、新建文件与文件夹(重命名/删除) |
| [#155](https://github.com/omdsh-dev/DSH-better-sidebar/issues/155) | P2 | sidebar | 提些需求 |
| [#161](https://github.com/omdsh-dev/DSH-better-sidebar/issues/161) | P2 | sidebar | [BUG] autoOpenJobs 触发时打开的是 Subagent 页而非聚焦 Jobs 区块（注释与实现不符） |
| [#186](https://github.com/omdsh-dev/DSH-better-sidebar/issues/186) | P2 | explorer | 【建议】资源管理器优化 |
| [#194](https://github.com/omdsh-dev/DSH-better-sidebar/issues/194) | P2 | git | 【建议】源代码管理的提交和分支的显示能不能固定到源代码管理的头部，不跟随下面的文件进行滚动。 |
| [#212](https://github.com/omdsh-dev/DSH-better-sidebar/issues/212) | P2 | git | [Feature] 编辑器 Git 联动：行级 blame + 变更标注 + 文件树状态徽标 |
| [#219](https://github.com/omdsh-dev/DSH-better-sidebar/issues/219) | P2 | sidebar | 底部面板未打开时点文件不会自动展开宿主面板；面板落底部/侧边由 activePane 决定且不可配置 |
| [#316](https://github.com/omdsh-dev/DSH-better-sidebar/issues/316) | P2 | git | ✨ [feat(git)] Git 更改支持按目录树状/层级显示 / Git changes: hierarchical tree view |
| [#319](https://github.com/omdsh-dev/DSH-better-sidebar/issues/319) | P2 | sidebar | 宽窗口下拖宽右侧面板会触发官方外壳左侧会话栏自动折叠 |
| [#358](https://github.com/omdsh-dev/DSH-better-sidebar/issues/358) | P2 | explorer | Feature request: Show in Finder + Copy file in the file-tree context menu |
| [#403](https://github.com/omdsh-dev/DSH-better-sidebar/issues/403) | P2 | sidebar | 性能：大分组展开一次全量挂载数百行 DOM + #root 全树 MutationObserver，长会话下侧栏展开卡顿 |
| [#430](https://github.com/omdsh-dev/DSH-better-sidebar/issues/430) | P2 | sidebar | [Bug] 最新版 dsh-desktop 上「位置兼容模式」失效：preset/custom 任何配置都不改变展开按钮位置 |
| [#431](https://github.com/omdsh-dev/DSH-better-sidebar/issues/431) | P2 | sidebar | [Feature] 把「插件入口」与「打开的文档」分成两层：常驻 activity bar + 可关闭 tab（TabDescriptor.pinned） |
| [#459](https://github.com/omdsh-dev/DSH-better-sidebar/issues/459) | P2 | sidebar | [Bug] dsh-desktop 2.0.4 <增强模式> 侧边栏悬浮在对话区域之上，对话区域没有正确自适应宽度 |
| [#481](https://github.com/omdsh-dev/DSH-better-sidebar/issues/481) | P2 | sidebar | 侧边栏展开按钮被窗口关闭按钮挡住，点不开侧边栏 |
| [#510](https://github.com/omdsh-dev/DSH-better-sidebar/issues/510) | P2 | sidebar | layout-push 契约在 DSH Desktop advanced 模式下未集成，中间栏不缩窄 |
| [#596](https://github.com/omdsh-dev/DSH-better-sidebar/issues/596) | P2 | sidebar | [bug][macOS Desktop] 右侧栏 tab 条顶部按钮点击失效（×/+ 经常点不动），底部面板正常 |

簇的划分：**桌面壳几何/命中面**（#596 #510 #459 #481 #430 #319）· **Git 面板重构**（#194 #316 #212，#765 在 R1 先修破坏性那条）· **资源管理器交互**（#358 #219 #186 #132 #109 #18 #98 #155 #131）· **性能**（#403）· **其它交互**（#431 #161）。

### R0 · 等 PR review（32 条，review 即产出）

这些 issue 的修复已经在开着的 PR 里，**不需要新开发**，瓶颈是 review。建议按「一条修多个 issue」的先合：`#617`（→ #559 #616）· `#807`（→ #623 #672 #698）· `#839`（→ #684 #762）· `#584`（→ #753 #573 #570）· `#814`（→ #784 #798 #800）· `#811`（→ #799）。

### R3 · 待排期（53 条 P3）

清单就是 §三 I 组里的 P3 部分（体验/建议/窄场景），不单独重复；要动的时候按 `area/*` 标签成批挑（`area/explorer` 23 条、`area/sidebar` 52 条、`area/editor` 16 条、`area/git` 10 条）。

---

生成于 2026-10-04，数据源：GitHub open issues 190 条快照 + main/merge-train 提交引用 + 代码核对。
