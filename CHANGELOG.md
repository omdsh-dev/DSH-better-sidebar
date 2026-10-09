# Changelog

> 本文档收录 dsh-better-sidebar 的完整发布历史（最新版摘要见 [README](README.md)；同步发布于 [GitHub Releases](https://github.com/omdsh-dev/DSH-better-sidebar/releases)）。

### v0.25.0

> 📦 **支持线前移：仅适配 DSH `0.2.0-rc.2+`**（peer 下限 `^0.2.0-rc.2`，CI 与挂载 lane 钉 `@deepseek-ai/dsh@0.2.0-rc.2`）。DSH 的 npm `latest` 现在正是 **0.2.0-rc.2**（不再停在 0.1.7-rc.2），本版就钉在它上面。**0.2.0-rc.1 及更早（含 0.1.7 线）请固定 v0.24.1**——`^0.2.0-rc.2` 对 rc.1 判定为 false，会被宿主的启动兼容性预检整行静默禁用；0.1.7 线的最后支持版是 v0.22.1。本次前移是一次纯声明与钉版变更：0.2.0-rc.2 对本插件消费的宿主面仍是纯增量，运行时零改动。

> 🙏 **本版包含以下贡献者的工作**（按合并先后；括号内为其 PR 带来的能力）：
> [@NolanHo](https://github.com/NolanHo)（#880 搜索框粘贴路径直开 + 噪声目录名单、#884 子进程输出偶发清空）、
> [@yanzhaohui1999](https://github.com/yanzhaohui1999)（#865 文件引用落到那一行、#828 行号后缀切分）、
> [@finley08](https://github.com/finley08)（#890 编辑器显现后重新测量、#859 桌面壳 HTTP 走页面基址、#832 新建文件）、
> [@ZinChl](https://github.com/ZinChl)（#806 目录命中点击、#809 打包状态按会话、#811 树批量拆分、#813 重启后的子代理、#814 任务折叠守卫）、
> [@graydovee](https://github.com/graydovee)（#807 空白会话的底部入口）、
> [@btsd321](https://github.com/btsd321)（#818 tab 条右侧动作）、
> [@ZhangFengshun](https://github.com/ZhangFengshun)（#641 宿主加载不带会话日志偏移）、
> [@PerryLink](https://github.com/PerryLink)（#843 目录条目清理）、
> [@UNscientific-9](https://github.com/UNscientific-9)（#842 checkout 的 `--end-of-options`、#645 引用胶囊）、
> [@lpf20200901](https://github.com/lpf20200901)（#821 插件目录 memory-delta）、
> [@dat-lequoc](https://github.com/dat-lequoc)（#837 编辑器可见性重测量）、
> [@lhh010](https://github.com/lhh010)（#823 插件目录 file-trace）、
> [@MengJiapeng](https://github.com/MengJiapeng)（#803 多仓库 git 历史）、
> [@zhanghunuaa](https://github.com/zhanghunuaa)（#802 文件树跟随活动 worktree）、
> [@mengge237](https://github.com/mengge237)（#817 自动激活保留已开页）、
> [@Waser750](https://github.com/Waser750)（#840 侧边对话归档线程）、
> [@suiyideali](https://github.com/suiyideali)（#587 编辑器内查找）、
> [@wang-kaopu](https://github.com/wang-kaopu)（#612 WSL 外部打开、#523 非 UTF-8 编码、#566/#565/#521 Windows 路径）、
> [@nyantused-cpun](https://github.com/nyantused-cpun)（#600 编辑器草稿保护）、
> [@bulingbuling688](https://github.com/bulingbuling688)（#574 工作区提及）、
> [@ingeb0rga](https://github.com/ingeb0rga)（#845 IME 229 守卫）、
> [@shyuan-hub](https://github.com/shyuan-hub)（#264 面包屑折叠与排除模式，方向）、
> [@rijiu915](https://github.com/rijiu915)（#363 Markdown 跨文件锚点，方向）。
> 谢谢每一位！


- 🧷 **右侧面板展开时不再显示底部入口**：宿主右上角在那种状态下是它自己的一簇控件（Split / Fullscreen / Collapse right sidebar），插件的「展开底部面板」挤进去只会跟它们打架 —— 现在右侧栏一展开，头部入口与空白会话的备用入口都退场，收起后重新出现。这条规则把「展开态该把入口摆在哪儿」整个问题去掉了，让位逻辑只需服务收起态（那里宿主的角落只有一个按钮）。**判据必须按「可见」而不是「在不在 DOM 里」**：实测宿主把两个角落控件都留在文档里（落屏时 `data-sidebar-right-expand` 与 `data-sidebar-right-toggle` 各 1 个、而面板已经展开），只查属性会一直读成「没展开」、按钮照旧冒出来。判别性用例见 `tests/dock-fallback.spec.tsx`（造一个可见的 Collapse 控件，还原门即红）。

- 🧷 **再修一处同源的碰撞：右侧栏打开时，空白会话的底部入口压在宿主「收起右侧栏」上**。备用入口是按宿主**角落控件**的 rect 左移 8+28px 定位的，但那只认控件**关闭形态**的属性 `data-sidebar-right-expand`——右侧栏**打开**时这个属性整个消失、同一个座位换成 `data-sidebar-right-toggle`，于是定位落到视口兜底坐标（`innerWidth - 44`），而那里正是宿主自己的角落按钮群。实测 2200px 视口、右侧栏打开时：入口落在 `2156..2184`，与宿主「Collapse right sidebar」（`2166..2194`）**重叠 18px**、并切到「Fullscreen」2px——与用户截图逐字一致。现在锚点同时认两种形态，**并且让位不再是一个固定偏移**——宿主的角落控件是肩并肩一簇（打开态实测 `Split@2094 / Fullscreen@2130 / Collapse@2166`，各 28px、间隔 8px），只往左挪 36px 会精确落在**下一个**按钮上（实测压住 Fullscreen 28x28px），所以改为逐个槽位左移直到与**任何**宿主按钮都不相交。真机复测（2200px 视口）：关闭态入口 `2124..2152`、宿主 `Open right sidebar@2160`，打开态入口让到 `2058..2086`、整簇从 `2094` 起——**两种状态都零重叠**。**占位判定改用命中测试**：早先按 `button, [role="button"]` 筛「谁占着这一格」，而右侧栏的**页签芯片**不是这两者——页签一多，让位就停在芯片上（用户报的「tab 多的时候位置也错误」）。现在用 `document.elementsFromPoint` 直接问页面「这一格下面有什么」：**不透明的小控件**（≤300px 宽，含页签芯片）算占位，整行的背景板（会话头 titleRow、面板 tabStrip、面板本体）不算；并且沿水平方向采 **5 个点**——只测中心点会漏掉「中心空着、右缘却压着邻居」的情况（实测这样压住 Split/Fullscreen）。让位步长同时收到 4px。判别性用例见 `tests/dock-fallback.spec.tsx`（还原锚点即红 `expected '980px' to be '464px'`；关掉让位步进即红 `expected '464px' to be '428px'`）。

- 🧷 **修掉「展开底部面板」按钮在会话头与备用入口之间叠成两个**：blank 会话里宿主不渲染会话头，插件的会话头入口随之不可达，于是空白会话专用入口以 `position: fixed` 贴到宿主「Open right sidebar」按钮左侧（#698 / #623）。但**相位判定不足以互斥**——相位是每 1s 轮询来的，而会话头入口由宿主自行决定何时渲染，两者之间必然存在窗口（相位读取失败时还会按「非 blank」降级，一个从未成功读到的会话可能一直停在 blank）；而两套入口在版面上**就是同一个位置**，同时在场即精确重叠成一团。现在除相位外再加一条与相位无关的兜底：**会话头那套入口只要真的在 DOM 里，备用入口就让位**，判别性用例见 `tests/dock-fallback.spec.tsx`（造出「相位说 blank + 会话头入口在场」的不一致状态，还原守卫即红）。最多 500ms 的让位延迟（与位置对齐同一节拍）。
- 🧠 **Side Chat 跟随父会话模型（[#892](https://github.com/omdsh-dev/DSH-better-sidebar/issues/892)）**：新线程使用所属父会话当前模型；每条新消息入队时记录当时的 provider、model 与 reasoning effort，并在该消息被领取时更新子线程自己的 `ModelSelectionRef`。DSH 的 `installModelSelection()` 在 prompt assembly 时应用该路由，并将同一选择用于 `agent/request`；新模型未提供 reasoning effort 时会清除旧值。关闭后恢复的线程会读取父会话当前模型。`sidechat.info` 返回下一轮模型及正在执行请求使用的模型，二者不同时，页签头部会分别显示。
  - 🧪 测试：新增 DSH `installModelSelection()` 与真实 Cordis waterfall 集成用例，核对 `agent/request` 的 provider/model/reasoningEffort 与 `request/header` 一致；Side Chat 路由用例覆盖所属父会话选择、消息级路由记录、排队消息模型固定与旧 reasoning effort 清除。

- 🎯 **文件引用终于落到那一行（[#826](https://github.com/omdsh-dev/DSH-better-sidebar/issues/826) 第二半）**：第一半把 `path:131` 的行号从地址上切了下来、文件能打开了，但行号**被解析出来就扔掉**——点开停在第 1 行。现在两种写法合流到同一个字段：`#L131` 由宿主解析成 `navigation.params.line`，`path:131` 由插件在 `src/client/path-line.ts` 切出，都落到 `SidebarTab.line`，再经 `FileViewerProps.line` 交给 viewer；文本编辑器在**到达时定位一次**并高亮该行，越界行号钳到最后一行，区间（`:起-止`）只取起始行、列号丢弃（编辑器只有一处光标）。定位直接写 `view.scrollDOM.scrollTop` 而不是 `scrollIntoView`——后者会走遍每一层可滚动祖先，浏览器缩放时连 window 都算上、把整个侧栏拖上去。**`line` 是瞬态**：`sanitizePersistedTab` 的白名单不含它（与 `revealed` 同处理），链接可能是几天前写的，刷新后不该把读者拽回那一行。**markdown / html 收到行号会先强制切到编辑态再定位**——预览里没有源码行号可放，而它自己挂载时的滚动恢复（`useLayoutEffect`）会和跳转抢同一个 `scrollTop`；引用要的是源码，所以让源码先可见。**公开面纯增量**：`FileViewerProps.line?: number`（§5 已同步），第三方 viewer 忽略它即可。原地把 `a.ts:131` 切到 `a.ts` 时行号会被**清掉**（更新路径比的是当前值而不是「有没有传」），否则每次通知都会把读者弹回去；同一引用重复投递不重复跳，同一文件的新行号照跳。
  - 🧪 测试：`tests/native-tab-line.spec.ts`（6 例：记录铸造 / 宿主 `#L` 片段 / 普通打开不种子 / 新导航改行 / **裸路径清行** / 重复投递保住记录身份）、`tests/text-editor-line-jump.spec.tsx`（6 例：落到指定行 / 越界钳位 / 普通打开不跳 / **markdown 强制切出预览** / 无行号留在预览 / 只落一次），`tests/native-surface.spec.ts` 的 `fileParamsOf` 断言补上 `line` 并加区间与 `行:列` 两例。scroll 那一步刻意不断言（骑在两层嵌套 rAF 之后、且 jsdom 不排版），断言的是同一次 dispatch 的 selection anchor。（贡献者 PR [#865](https://github.com/omdsh-dev/DSH-better-sidebar/pull/865) @yanzhaohui1999）

- 🖥️ **桌面壳里插件路由不再满屏「Failed to fetch」**：HTTP 与 WebSocket 需要**不同**基址，而壳正是把两者拉开的地方——页面在 `dsh-app://app/`，注入的 `__DSH_TRANSPORT__.streamBaseUrl` 却是宿主的 `http://127.0.0.1:<port>`（另一个 origin）。壳的 `protocol.handle` 会把非静态的 `dsh-app://app/*` 路径**同源转发**给宿主，所以 HTTP 必须骑**页面基址**（`hostHttpBase()` → `document.baseURI`，反代目录前缀也带在里面，一套规则覆盖两种部署）；发到注入 origin 就是跨源，而插件自己的 `/sidebar/*` 路由不带 `Access-Control-Allow-*`，浏览器直接拒（文件树 / git / 编辑器全部请求失败）。WebSocket 反过来，必须用注入 origin：自定义 scheme 承载不了 `ws:`，而 `dsh-app://app` 的 host 是字面量 `app`，DNS 永远不解析。`tests/base-path.spec.ts` 钉住三种场景（壳内页面基址 + 注入 origin 的 socket、无页面基址时回退注入基址、普通 http 页面同源不变）。
- 👁️ **被 park 过的编辑器不再是一片空白**：原生页签在宿主里靠 `keepMounted` 存活，宿主把不活跃的 body **移动**进隐藏 seat、需要时再移回来——而移动一个节点**不改变它的 border box**，所以只看尺寸变化的 `ResizeObserver` 一次都不触发，一个在隐藏宿主里被打开的编辑器会把视口量成 0 并把这个空的虚拟视口一直留着（症状很有辨识度：**行号槽照常画，正文空白**）。现在每次「显现」都重新测量：`IntersectionObserver` 报显现本身（补上移动这条 ResizeObserver 看不见的路径），`requestAnimationFrame` 兜住「显现与挂载同帧」的那一次（此时 CodeMirror 的首次测量仍可能读到 0），另接 `visibilitychange` 与 `window` resize；四种观察器都可缺省、逐个 dispose，旧浏览器/测试环境不受影响。
- 🛡️ **会话切换不再把上一个项目的写操作带进新项目（[#848](https://github.com/omdsh-dev/DSH-better-sidebar/issues/848)）**：右侧栏的每个 page 都按「会话 + 页签 id」**复用同一个组件实例**，而页签 id 每会话重新计数——换会话（或换 cwd）时组件是**原地重渲染**而不是重挂，于是上一个项目里选中的行、打开的行菜单、内联重命名/新建编辑器、以及**已经弹出来的删除确认框**都会活到下一个项目里。最危险的是选中集：「删除选中」会把**新会话的 scope 配上一个会话的绝对路径**发给宿主，而 v0.23.0 起包含性检查是刻意移除的，宿主对绝对路径照单执行——**它会删掉另一个项目的文件**。现在这些状态随会话与 cwd 一起失效（选中集、锚点、行菜单、内联编辑器、确认框、拖拽落点、busy 标志、错误条），批量删除与打包构建按 generation 捕获自己的 scope、并把**结算**（pruneTree / 选中集 / busy / 任务条）在换代后退役（它们结算的是「在屏项目」的状态，已经不一定是自己开始的那个项目了）。
  - **一并修掉两处「靠 passive effect 兜底」的窗口**：换会话的清理写在 `useEffect` 里，而点击可以落在「swap 已提交、effect 尚未 flush」之间，此时 props 已经是新会话。单行删除的确认框与拖拽上传因此改为**在调用点复核自己 armed 时的 scope**（`sameScope`），不一致就整条请求不发（fail closed）；请求本身用 armed scope，scope 与路径永远同源。实测还原守卫即红：那个窗口里会发出 `fsRemove({sessionId:'s2',cwd:'/projects/beta'}, '/projects/alpha/a.ts')`。
  - 🧪 测试：新增 `tests/file-tree-session-scope.spec.tsx`（6 条：选中集/确认框随换代清除、同会话重渲染**不**清除、批量走的在途结算不写进新会话、上面那条窗口的判别性用例、以及一条钉住「请求里的 scope 与 path 必须同源」的正向对照——只数调用次数抓不到 scope 被换掉的回归）、`tests/task-window-delete-arm.spec.tsx`（3 条：任务窗口的两步删除按钮不跨任务武装）、`fs-operations` / `git-view-worktree` / `file-tree-archive` 各补相关用例。**已知未修（另立跟进）**：宿主侧 `fs.remove/rename/mkdir` 没有项目归属校验，客户端仍是唯一守卫；`isWorkspaceRoot` 的 `catch` 会吞掉 EACCES/EPERM 而回退到拼写比较。

- 🪟 **保存不再把 CRLF 文件写成 LF（[#871](https://github.com/omdsh-dev/DSH-better-sidebar/issues/871)）**：上一批只修了读取侧，写入侧仍有洞——编辑器传送的永远是 LF 文档（CodeMirror 没有别的行模型），而 `fs.write` 把它原样落盘，于是在 Windows 检出上**改一行 = 整文件 diff**。现在保存前用**同一趟** 64 KiB sniff 读取同时取出编码与行尾（`text-encoding.ts` 的 `encodingOfFile` 扩成 `fileFormatOf`，新增 `detectEol` / `restoreEol`），落盘改为 `encodeText(restoreEol(content, eol), encoding)`：CRLF 文件保持 CRLF、LF 文件不被引入 `\r`、已含 `\r\n` 的内容不会被写成 `\r\r\n`。口径与宿主自己的 `edit` 工具逐字一致（前 4096 字符多数票；孤立 `\r` 既不计票也不改写），所以插件保存与模型 `edit` 对同一个文件得到同一个结论——顺带核实：宿主的 `write` 工具**不做**这件事（`writeText` 原样写模型文本），模型整份覆盖时文件仍会变成 LF，那是宿主写入、插件无权干预，已在 issue 里留结论。**客户端零改动**，保存入口（含快捷键与草稿边沿）自动全覆盖。新文件仍是 UTF-8 + LF：「项目级行尾约定」不在本批范围。
- 🧪 测试：`tests/text-encoding.spec.ts` 补 3 条新用例（CRLF/LF 检测、多数票与孤立 `\r`、`restoreEol` 不双写）并把既有的编码三例扩成 `fileFormatOf` 断言；`tests/fs-write-route.spec.ts` 补 3 条端到端（CRLF 文件写 LF 文档后除被编辑行外全 CRLF 且无裸 `\n`、LF 文件不引入 `\r`、GBK + CRLF 组合下两个 restore 同时开火）。判别性：把 `restoreEol(...)` 换回 `content` → 2 条端到端红，其余仍绿。
- 🔎 **搜索框支持直接粘贴路径：指名路径 stat 直开、相对片段按路径匹配**（[#879](https://github.com/omdsh-dev/DSH-better-sidebar/issues/879)）：`fs.search` 之前把整个输入当作文件名子串在整个 cwd 树里递归匹配——文件名永不包含分隔符，所以粘贴任何带 `/` 的路径都是**结构性零命中**，却仍烧满 10 万条访问预算（实测含 worktree 森林的 Rust 仓库上 1.9s 返回 `{matches:[],truncated:true}`，工作区外文件如 `/tmp` 下的实验产物图因此在右侧无从预览）。现在 `searchFiles` 按查询形态分流：**指名单一目标的 query（绝对路径、`~/…`、`./x`、`../x`）经 `resolveTarget`——与 fs.read 同一解析原语（`~` 展开 #713、会话 cwd 拼接、win32 WSL/dsh-remote 命名空间改写、词法 resolve）——stat 直取**，命中返回**解析后的绝对路径**（resolve 剥掉 shell 补全带的尾分隔符；客户端对匹配行与树行做精确字符串比对，客户端 `resolveSidebarPath` 对绝对路径透传，TreePanel 现有点击链路零改动即可打开），目录目标按 #801 契约同列 `dirs`（行内树导航而非按文件打开；**工作区外的目录命中行只清空查询**——树以 cwd 为根，没有可导航的行，客户端守卫同时避免了 `ancestorDirs` 为外部路径合成垃圾 `expanded` 条目），目标缺失立即返回空结果（不再烧预算换一个注定为空的遍历）；**含分隔符的相对片段按根相对路径匹配**（大小写不敏感，Windows 两种分隔符都收；同名文件消歧正是 #306 的诉求）。引擎不参与路径分支——fd 的 `--fixed-strings` 不带 `--full-path`、rg 的三个 glob 以单路径段为匹配单元，路径语义由遍历独占，引擎 argv 构造零改动（新 skip 名仍由 `SKIP_DIR_NAMES` 派生进 fd `--exclude` / rg glob，`check:engines` 门禁不受影响）。用户 exclude 列表不作用于直开分支：粘贴路径是显式意图，与点击后的 `fs.read` 行为一致（fs.read 同样不应用 exclude）。POSIX 上 `\` 仍是文件名合法字符而非分隔符（`~\foo` 形态仅在 win32 计入路径手势）；单独的 `~` 按客户端 `isAbsolutePath` 的口径视为指名 home 目录，其余不带分隔符的 `~`/点前缀拼写（`util.ts~`、`~$doc.docx`、`.env`）仍是名字查询，引擎资格不受影响。
- 🧹 **噪声目录名单补 worktree 森林与语言环境**：`SKIP_DIR_NAMES` 增加 `.worktrees` / `.worktree`（两种 git worktree 布局拼写，`.worktrees/` 正是 DeepSeek Harness 自己的约定）、`target`（Rust / Maven 构建产物）、`venv` / `.venv` / `__pycache__`（Python 环境与字节码缓存）——此前两片 worktree 森林实测可烧掉 100k 预算的 97k，真实目录从未被遍历、`truncated` 恒真。walk 与两条引擎 argv 共用同一名单（fd `--exclude` 与 rg glob 对自动派生），引擎与遍历的跳过行为保持一致。
- 🧪 测试：`tests/fs-search.spec.ts` 新增 9 条——路径片段匹配（深度无关 / 大小写 / 目录行的 dirs 拆分 / 噪声围栏照常生效）、直开分支（文件与目录目标、目标缺失即空且 `maxVisited:1` 下仍 `truncated:false` 钉住「未走遍历」、尾分隔符 / `./` / `../` / `~` 经 `resolveTarget` 解析后返回解析路径）、`probed===false` 证明路径分支不触引擎、不带分隔符的 `~`/点前缀拼写仍是名字查询（引擎资格保持）、分隔符 query 不进引擎（假引擎返回污染行判别）、POSIX 反斜杠名字（探针式 skipIf 只在名字可存在的平台运行）、worktree/语言环境森林不进入；`tests/smoke.spec.ts` 新增 1 条路由级用例（绝对命中 / 立即空结果 / 相对片段 / `./` 锚定解析四态穿真实 mount）；`tests/file-tree-search-persist.spec.tsx` 新增 1 条（工作区外目录命中行只清空查询、不触发任何 toggle）。判别性：还原 `fs-search.ts` 的分支即红（引擎污染行会浮出来）；还原 skip 名单即红（森林内的 guide.md 命中）；拿掉客户端守卫即红（外部路径的垃圾 toggle 浮出）。
- 🐞 **修掉 `streamLines` 以 `exit` 结算子进程输出、负载下 fd 目录结果偶发静默清空**（[#883](https://github.com/omdsh-dev/DSH-better-sidebar/issues/883)）：Node 的 `exit` 在进程死亡**瞬间**触发，stdout 管道可能还有未排空的数据；正确信号是 **`close`**（进程结束**且 stdio 全部关闭**，stdout 读到 EOF、readline 的全部 `line` 事件已发出）。宿主负载高时 `exit` 抢在管道排空前到达，`lines` 数组还是空就 resolve——fd 双调用的第二路（`--type d`）最常受害，签名恒为 **`matches` 完好、`dirs: []`**，目录命中行退化为按文件打开（报 `is a directory`，正是 #801 修的错误面被偶发化）。实证（装 fd 的 Linux 宿主，`tests/search-engines.spec.ts` 单文件连跑）：干净 dev 基线 **7/30 复现**、签名恒一；`exit`→`close` 一行后 **0/30**。截断 / 超时 / spawn-error 三条既有结算路径换事件后语义不变（`finish` 幂等守卫 + `if (truncated)` 分支照旧）；探测函数的 `--version` 调用是 `stdio: 'ignore'`、只读退出码，`exit` 即正确信号，不改。上游 CI 从未暴露的原因：ubuntu lane 无 fd（真引擎用例自跳过，双 spawn 路径不存在）、ci-windows 串行跑撞不进竞态窗口——#872 记录的「慢机/负载才暴露」类隐患。
- 🧹 **`runChild` 的 fd 分支不再吞掉第二路的失败**：删除 `streamLines(dirChild, cap).catch(() => ({ lines: [], truncated: false }))`——rejection 现在流进 `runEngine` 既有的 broken 标记 + 本次回退 JS 遍历（与主路对称；旧 catch 把失败降级成「目录恰好为零」，在所有环境都不可见）。
- 🧪 测试：`setEngineHooks` 新增 `spawner` 缝隙（类型收窄为 `EngineSpawner`），两条**确定性**用例用脚本化 PassThrough 子进程直接钉住契约——「`exit` 先于 stdout 排空时零行丢失」（复放竞态的真实次序：先 exit、数据在途、close 后至；exit 版代码在「close 前仍未结算」断言即红）与「fd 目录路失败整路 reject 并标记 broken」（swallow-catch 版代码红在「以空 dirs resolve 而非 reject」）。判别性均已临时还原对应实现验证：还原 `exit` → 用例 1 红；还原 catch → 用例 2 红。真引擎用例（'matches literals…'）此前正是该竞态的偶发受害者，负载机器上 ~23% 概率红。
- 🪟 **修掉 CRLF 行尾文件在预览里的三层 `\r` 误判与「预览渲染两遍」（ci-windows 上暴露）**：Windows 检出下 README 的锚点用例全红，根因不是 slug 而是① `markdown-html.ts` 的 `isBlank`、`mermaid-blocks.ts` 的 `CLOSE_FENCE_RE`、`markdown-code.ts` 的 `closesFence` 都把行尾的 `\r` 当内容——于是 **HTML 段永不终止**（实测 `splitHtmlBlocks(README.md)`：LF 36 段 vs CRLF **4 段**，`# b` 被当原始 HTML 文字渲染）、**mermaid 围栏吞掉文件余下部分**、**链接改写从第一个围栏起全部失效**（首个分歧在第 16883 字节）；② `TextEditor` 的 draft 快照把 CodeMirror 归一化后的 LF 文档在挂载后一个 commit 发布出去，`previewMdText` 从 CRLF 翻成 LF，宿主 `MarkdownText` 于是重建了文本变化的标题节点——挂载那一趟写入的 **26/26 个 id 被丢弃**（断言时只剩 7/26、13/15 个 TOC 锚点 `id=missing`），MutationObserver 一个微任务后才自愈。现已把 draft 定义成「编辑」：与已加载正文逐字节相等（或行尾归一后相等）时不发布。
- 🧪 测试：新增 `tests/markdown-crlf.spec.ts`（7 条 **CRLF ≡ LF** 不变式，覆盖分段器 / mask / 两个改写器 / mermaid 分段器）与两条真实渲染器用例（含把 `README.md` **在内存里**转成 CRLF，让 ubuntu / macOS lane 也跑 Windows 的拼写）；测试脚手架 `scanDocumentAnchors` 改为 CRLF 安全（实测 CRLF 标题 0 → 26）。判别性：还原三个扫描文件 → 9 条红；还原 `TextEditor` → CRLF 检出下 2 条红（即 CI 原症状）。
- 📝 **已知未修（另立 [#871](https://github.com/omdsh-dev/DSH-better-sidebar/issues/871)）**：同一归一化意味着**保存会把 CRLF 文件写成 LF**（一次内容修改变成整文件 diff），需要产品取舍；本轮只修读取侧。
- 🔄 **模型改完文件后，正在看的预览自己刷新**（[#855](https://github.com/omdsh-dev/DSH-better-sidebar/issues/855)）：此前模型在会话里 `write` / `edit` 一个你正开着的文件，侧栏里仍是旧内容，只能手点刷新（或切走再切回、关掉重开）。现在**命中即静默重载**：走页头刷新按钮那条完全相同的加载路径（同样的 `fsRead` / `load()`），因此手动刷新入口原样保留。信号来自**插件自有的会话事件增量流** `changes.ops`（不是新的文件系统观察者）：宿主按 `seq > afterSeq` 增量下发 `tool/call` + `tool/result`，客户端折成文件操作后只认**结算成功**的 `write` / `edit`（`running === false && !isError`）——半写内容与失败的调用都不触发重载。**每会话一个共享轮询器**（`src/client/ops-stream.ts` 的成员选举，2.5s、self-scheduling，与文件变动页的会话透镜同一节奏、同一路由）：一个会话开 N 个编辑器 tab 每 tick 仍只有 **1 个** `changes.ops` 请求，页签全部离开即停；**没有 fs.watch，也没有任何周期性的 `fsRead` 指纹轮询**。**叠加口径**：文件变动页的**会话透镜保留它自己的轮询器**（两条流的可见性条件不同），所以同一会话**同时**开着会话透镜与编辑器时，该会话每 tick 是 **2 个** `changes.ops` 请求——「1 个」说的是编辑器这一份，不是全会话总数（把两者合并会改动会话透镜那条已被既有 spec 钉住的「只在透镜在屏时轮询」语义，见[设计文档 §4.1](docs/plans/2026-10-06-editor-auto-refresh.md)）。
  - **只刷新命中的那一个**：命中判定用 `resolveSidebarPath` 把模型写的相对路径按会话 cwd 归一（含 `.` / `..` 词法折叠、Windows 盘符与 UNC 大小写折叠），未命中的文件**零重读**、不重挂、不动滚动位置。
  - **脏态优先**：编辑器上报 `dirty` 时自动刷新**直接跳过**——草稿只活在编辑器实例里，重载会重挂它，用户没保存的输入永远不会被磁盘内容覆盖；处于**编辑态**（`mode === 'edit'`）同样跳过，免得光标跳走。**跳过不等于死路**：未 dirty 时既有的「编辑 → 预览」边沿照旧重载并拿到新内容（实测 `fsRead` 1→2，`tests/editor-refresh.spec.tsx` 的 B 例）；**dirty 时这条边沿自身也带 dirty 守卫**（`EditorHost.tsx` 的边沿判定要求 `dirty !== true`；`tests/editor-refresh.spec.tsx` 的 B 例两半都钉住了它——干净时 `fsRead` 1→2，dirty 时仍是 1）因而被抑制，此时的两条出口是**页头刷新按钮**（`window.confirm` 后重载，draft 换成新内容）与**「保存 → `fs-conflict` 横幅的 reload」**（`TextEditor.tsx` 的保存带 `mtimeMs` 基线，模型写过就会被拒成 `fs-conflict` 而不会静默覆盖模型字节，横幅里的 reload 就是新内容入口）。一句话：**dirty 期间保持旧内容直到用户显式动作，不存在看不到新内容的死路**。
  - **不误报历史**：流的第一帧是**基线**——打开文件之前会话里已经结算的写入一条都不会触发（该文件刚刚才被读过），只有**打开之后**才结算的动作会刷新。会话作用域按会话 id 分账，别的会话写同一个路径不会串台。
  - 🧪 测试：`tests/editor-auto-refresh.spec.tsx`（14 例，jsdom + 假计时器），每条都做了**还原源码即红**的证伪：拿掉重载调用 → 「命中即重读重渲染」与「相对路径命中」红；拿掉路径命中判定 → 「未命中零重读」红；拿掉 dirty 判定 → 「脏草稿不被覆盖」红；把每会话一条流改成全局共享 → 「另一会话写本文件不刷新」红（并带正向对照，证明两个编辑器确实都在轮询）；拿掉成员选举 → 「N 个 tab 每 tick 恰 1 个请求」红（3 个 tab 变 3 个请求）；拿掉编辑态判定 → 编辑态用例红；拿掉基线 → 「打开前写过的文件不被重读」红；放行 running / err 的调用 → 「结算成功才刷新」红；**放行 `kind === 'read'`** → 「模型 read 本文件零重读」红；**放松 `EditorHost` 的 `opBaseline` 守卫**（只留 `null` 判断、不再按路径比对基线）→ 「重新定向到刚被 touch 的路径不重复读」红（既有 12 例仍全绿）；**塞进一个周期性 `fsRead`** → 「无事件不轮询 fsRead」红。`tests/editor-refresh.spec.tsx` 的既有 4 条（#167）未改动、仍绿。
  - ⚠️ **滚动位置与「真实浏览器」边界（如实记录）**：重载走的是既有那条加载路径（与 #167 的保存后刷新、页头刷新按钮逐字相同），所以 markdown / html **预览态**的滚动位置由 `TextEditor` 既有的模块级 per-file 滚动记忆恢复（`previewScrollMemory` + 布局 effect；jsdom 量不出 `scrollHeight`，这一层是**读源码得出、未在真机浏览器验证**）；`code` 这类「编辑器就是唯一视图」的文件（`toolbar.mode` 恒为 `preview`）**无法保留光标/滚动**——重挂会回到文档开头，但**内容不会丢**（dirty 时根本不刷新）。真实浏览器里「预览是否真的刷到了新内容」这一层本轮**只在 jsdom 验证**，没有做真机点击验证。[设计文档](docs/plans/2026-10-06-editor-auto-refresh.md)
- 🔗 **Markdown 里的本地 `.md` 链接改在侧栏打开，标题锚点可跳转**（[#363](https://github.com/omdsh-dev/DSH-better-sidebar/issues/363)）：插件自绘的四处 markdown（编辑器预览 / 侧边对话转录 / 文件变动阅读视图 / 任务笔记）原先把 `[x](./other.md)` 渲染成**不可点的纯文本**——宿主渲染器只有在 `MarkdownDelegateProvider` 提供 `openFile` 时才把本地目标变成可点元素，且它自己的 `parseFileLink` **只认行号 fragment**（`#L24`），带标题 fragment 会让整个目标判为非法，于是「点了没反应」。现在链接被判为「同文档 fragment」或「要打开的文件」：同文档的就地滚动预览**自己的滚动容器**（不用 `window.scrollTo`，也不用 `scrollIntoView`——后者会连整条侧栏一起滚），跨文件的把 fragment 以 `%23` 编码带过宿主解析器、按「会话 + 绝对路径」暂存，目标文件渲染出来后落到对应标题。

- 🔗 **Markdown 里的本地 `.md` 链接改在侧栏打开，标题锚点可跳转**（贡献者 PR [#363](https://github.com/omdsh-dev/DSH-better-sidebar/pull/363)（@rijiu915）提出方向；因宿主渲染器的两条硬约束——本地链接无官方 delegate 时退化为纯文本、`#标题` 片段被 `parseFileLink` 判非法——维护者以**官方 `MarkdownDelegateProvider` + `%23` 片段载体**重新实现，该 PR 已带署名关闭）：插件自绘的四处 markdown（编辑器预览 / 侧边对话转录 / 文件变动阅读视图 / 任务笔记）原先把 `[x](./other.md)` 渲染成**不可点的纯文本**——宿主渲染器只有在 `MarkdownDelegateProvider` 提供 `openFile` 时才把本地目标变成可点元素，且它自己的 `parseFileLink` **只认行号 fragment**（`#L24`），带标题 fragment 会让整个目标判为非法，于是「点了没反应」。现在链接被判为「同文档 fragment」或「要打开的文件」：同文档的就地滚动预览**自己的滚动容器**（不用 `window.scrollTo`，也不用 `scrollIntoView`——后者会连整条侧栏一起滚），跨文件的把 fragment 以 `%23` 编码带过宿主解析器、按「会话 + 绝对路径」暂存，目标文件渲染出来后落到对应标题。
  - **标题 id 现在与 GitHub 逐字一致**：`githubHeadingSlug` 改成 GitHub `github-slugger` 的真实规则——**不 trim、不折叠连续空白**（每个空格各转一个 `-`）、删 emoji 与 `\uFE0F` 等 variation selector、删标点与符号、保留任意文字系统的字母/数字/组合标记、重复标题 `-1`/`-2`，文档里已存在的显式 id 先占用。**这是本批最有用户价值的一处**：仓库自己的两份 README 目录锚点因此从 **0/15 全部失效**（点击被认领成按钮但 `scrollTop` 纹丝不动，静默 no-op）变为 **15/15 全部可用**（真实 `TextEditor` + 真实宿主 `MarkdownText` 渲染后逐个锚点点击实测）。旧实现错在两处：先 `trim` 再把空白折叠成一个 `-`（GitHub 两者都不做，`## 🛠️ Development & Build` 的真实 id 是 `-development--build`），以及保留 `\p{M}` 而把 VS16 留在 id 里（`🖼️ 特性巡礼` 曾得到含不可见字符的 `"\uFE0F-特性巡礼"`）。
  - 🧹 `<a id="x"></a>` 这类空显式锚点（GitHub README 常用）被标为 `hidden`——不再占版面，id 仍在，`#x` 深链照旧。
  - **范围决定**：非 markdown 的本地链接（`./notes.txt`、`./pic.png`、`./docs`）**维持纯文本不变**——本批只认领 `.md` / `.markdown`，目的是不把用户交到插件不打算服务的动作上。`#L24` 行号目标仍交给宿主自己的语法，**本批不做「打开后跳到第 24 行」**。
  - 🧪 测试：`tests/markdown-navigation.spec.ts`（认领判定 / `%23` 载体 / 幂等 / 跨文件 fragment 表）、`tests/markdown-slug.spec.ts`（**以真实 `github-slugger` 正则做对照**的 slug 判定 + 两份 README 的锚点解析率断言）、`tests/markdown-surface.spec.tsx`（真实渲染下的 host delegate 点击路径、祖先滚动容器、跨文件落点）。
- 🐞 **修掉 `~~~` 代码围栏内的链接与图片被改写**：两份源码改写器（`markdown-images.ts` / `markdown-navigation.ts`）各自内联的围栏 mask 只认三个反引号，于是 `~~~` 围栏里当作**示例**展示的 `[y](./b.md#u)` 会被写成 `[y](./b.md%23u)`、`![i](./p.png)` 会被写成 `/sidebar/file` URL（与 58d7f71 基线逐字对比，这是本批唯一的渲染差异）。现在抽出一个共享 mask（`src/client/markdown-code.ts`，CommonMark 规则：**3 个及以上反引号或 3 个及以上波浪号**开栏、闭合不短于开栏、未闭合则延伸到文末），两个 pass 共用。**图片那条盲区是既有缺陷而非本批引入**（58d7f71 上 `rewriteLocalImageUrls('~~~\n![i](./p.png)\n~~~')` 已经会改写），一并修掉。
- 📝 如实记录的窄边（不修、无损坏）：目的地含**转义括号**（`[x](./a\(1\).md)`）或**单引号 title**（`[x](./a.md 'title')`）的链接不会被认领，回退成纯文本——与本批之前的渲染逐字一致。

- 💻 **底部工作台也有终端了**（[#774](https://github.com/omdsh-dev/DSH-better-sidebar/issues/774)）：`+` 菜单新增内置类型 **`terminal-bottom`**——页面是插件自绘的 xterm，**进程由宿主的会话级终端服务 `ctx.webTerminals` 供给**（`@deepseek-ai/dsh-api-terminal-controller` 的 client 半边），插件不持有 PTY，也与右侧栏那条 **互不干扰**（右列仍是 `ui-sidebar-terminal` 的地盘）。**恢复语义**：页面每次都用**同一份 `(sessionId, key, contentId)`** 调宿主的 `webTerminals.view()`，宿主持久化在 localStorage 的 `(会话, contentId) → 终端 id` 绑定因此能在刷新后认回**同一个 shell**；`terminalId` **不写进 `tab.meta`**（`view()` 显式传 id 会关掉宿主的「缺了就建」，一个过期 id 会把页签永久卡在 `missingTerminal`），DSH 重启后 PTY 已消失而绑定还在，所以状态面板的「**新建终端**」按钮把 `tab.meta.terminalRun` +1 换一代 `contentId` 另铸进程。**关页签**才结束进程（`onClose` → `webTerminals.close()`），卸载**不**关——宿主的契约是「视图跨 DOM 卸载存活」，这正是刷新能认回同一个 shell 的原因。宿主没挂终端控制器时该行置灰、页面显示「宿主未提供终端能力」，**不**把整行拖成 `pending`（`webTerminals` 走结构化探测，没有写进 `dsh.client.inject`）。
- 🧩 **新 API：`TabDescriptor.bottomOnly`**（#774）——只投插件自己的底部工作台、**永不注册原生右侧栏承载面**的类型：`openTab` 落点强制 `'bottom'`（`target: 'side'` 也被改道），原生 tab 类型与 guide 条目都不注册。它是 `terminal-bottom` 不变成「宿主右栏里第二个终端胶囊」的全部机制（挂载 lane 钉住宿主 `terminal` guide 条目恰好 1 条），也**不是** `hidden` 的替代品——后者会连 `+` 菜单一起摘掉。字段说明与承载面差异已进 [接入指南](docs/external-plugin-guide.md)，内置清单从 5 变 6。
- 📦 **新依赖 `@xterm/xterm@^6.0.0` + `@xterm/addon-fit@^0.11.0`**（与宿主自用版本一致，两者安装期零脚本），**只进新 chunk `lib/client-terminal.js`**：核心包 `lib/client.js` 里连一处 `@xterm/xterm` / `xterm-char-measure-element` 都没有（chunk **748,716** 字节，xterm 与它的样式表整份在内；实测于合并 dev 之后的树，该 chunk 还内嵌 zh/en 词典，所以数字随词典增删浮动——#774 分支单独构建时是 749,897 字节），并已写进 `package.json#files` 与 registry 清单——chunk 名镜像点同步到 8 处。
- 🧪 测试：`tests/terminal-tab.spec.tsx`（15 条，jsdom + `vi.mock` 掉 xterm/addon-fit，钉住 `view()` 调用形状与 contentId 恒定性、mount/detach、`write`/`resize` 转发与上限夹紧、snapshot 重放 + `acknowledge`、无服务降级、「新建终端」走真实 `updateTab` 路由、`onClose` → `close()`）；`tests/builtins.spec.ts` 内置清单 5 → 6 并新增「`terminal-bottom` 是 `bottomOnly`，其余内置都不是」；`tests/native-registration.spec.ts` 新增「`bottomOnly` 类型一个原生 tab 类型、一个 slot、一条 guide 条目都不产生」（**删掉 `sync()` 里那行 skip 即红**——此前这半边只有挂载 lane 抓得住）；`tests/chunk-artifact.spec.ts` 新增「chunk 里必须有 xterm、核心包里一处都不许有」的产物断言；`tests/e2e/mount.e2e.ts` 新增第三条真实浏览器用例（展开底部 → **空面板里的「Terminal」类型卡片** → 断言 `.xterm` 挂载、`/sidebar/bundle/terminal.js` 有响应、无 pageerror，且宿主 `terminal` guide 条目**仍恰好 1 条**、`terminal-bottom` 的 guide 条目**为 0**；`+` 菜单那条点击路径 lane 里没有覆盖，两条入口共用同一份 `buildNewTabOptions`）。
- 📄 词条 `terminalNew` / `terminalUnavailable` / `terminalGone` 进 `locales.ts` 的 zh/en 与 19 份第三语言词典。[设计文档](docs/plans/2026-10-05-bottom-terminal-tab.md)。

- 🧹 **移除「位置兼容模式 / 标题栏条带」整套机制与设置**（[#430](https://github.com/omdsh-dev/DSH-better-sidebar/issues/430)，细节与消费者普查见 [移除记录](docs/plans/2026-10-05-remove-titlebar-compat-strip.md)）：这套设置想让人手动声明「我的桌面壳在顶部占了 N 像素」、好让插件把内容下移，但**插件内部早已没有消费者**——唯一的三条读 `--dsh-title-bar-strip` 的 CSS 规则随「顶部自绘 chrome 交还宿主」在 v0.19.0（`223b254`）删除，而用户期望被移动的「侧边栏按钮」是**宿主原生控件**（插件没有它的位置 API），宿主也不读这条契约（DSH 源码树对该契约与 `desktopWindow` 全 0 命中）。于是改设置只会写一个没人读的变量、**什么都不动**。本版把整套机制删除：`titlebar-strip.ts` / `wco.ts` / `shell-presets.ts` 三个模块与各自 spec、`titleBarScheme` / `titleBarPresetId` / `titleBarCompat` / `titleBarStripPx` 四个偏好键与设置界面、12 个词典 key × 21 份词典、挂载 lane 里两条 WCO / preset 场景。**保留**：`desktop-env.ts` 的 `hostTransportBase()`（反向代理前缀与 `dsh-app://` 解析基准，另有 3 个消费者）与「**自定义 CSS**」逃生口（改为独立分组、**非空即生效**）。旧偏好数据**安全忽略**（宿主 schema 为 OPEN 不报错、客户端 `parsePrefs` 只按声明字段构造、一次性 `settings.yaml` 回迁丢弃未声明键），三层各有测试与变异证伪。
- 🧪 测试：新增「旧数据被安全忽略」三层断言（`tests/prefs.spec.ts` / `tests/plugin-shape.spec.ts` / `tests/smoke.spec.ts`），挂载 lane 改为**负向断言**（戳记 URL 下 `body[data-dsh-title-bar-compat]` 必须缺席、`--dsh-title-bar-strip` 必须为空）并保留「自定义 CSS 实时注入」用例；删除 5 个只服务该机制的 spec。
- 🗂️ **资源管理器补「新建文件」**（[#132](https://github.com/omdsh-dev/DSH-better-sidebar/issues/132)，移植贡献者 PR [#832](https://github.com/omdsh-dev/DSH-better-sidebar/pull/832) 的交互语义）：目录行右键「新建文件夹」旁新增「**新建文件**」，在该层顶部插入同款行内输入（Enter 提交 / Escape 取消 / 失焦提交 / IME 保护，图标跟随输入的文件名），与「新建文件夹」**互斥**（开一个即关另一个）。与 PR 的差别是**写路径落在服务端**：新增路由 `fs.createFile` → `fs-operations.ts` 的 `createWorkspaceFile`，复用既有 rename/mkdir 的单段名与「已存在即拒」规则（`fs-error` 409，同一句 `"x" already exists`），并额外拒绝 Windows 非法字符（`< > : " | ? *` 与控制字符）与保留设备名（CON / PRN / AUX / NUL / COM1-9 / LPT1-9，带不带扩展名都拒）；落盘用 `wx`，**同名文件绝不被截断**；客户端在已加载的那一层先做一次大小写不敏感的占用检查（`newFileExists`），服务端仍是最终裁决。词条 `newFile` / `newFilePlaceholder` / `newFileInvalid` / `newFileExists` 同批进入 `locales.ts` 的 zh/en 与 19 份第三语言词典。
- ↕️ **资源管理器排序三档**（[#132](https://github.com/omdsh-dev/DSH-better-sidebar/issues/132)）：文件树头部工具区（刷新 / 上传按钮旁）新增排序菜单——**按名称 / 按类型**二选一（打勾）+ **文件夹优先**独立开关。排序作用于 `level.entries` 的**副本**，不改服务端、不原地重排共享的目录缓存；**默认（名称 + 文件夹优先）与宿主原有顺序逐元素一致**（`tests/file-tree-sort.spec.tsx` 直接拿 `fs-tree.ts` 的 `compareEntries` 当基准）。「按修改时间」不在本批范围（维护者另立 issue）。
- 🧪 测试：`tests/fs-create-file.spec.ts`（11 例：成功 / 根目录为父 / 空名·`.`·`..`·分隔符·`../escape` 路径穿越 / 全部 Windows 非法字符 / 保留名与近似名 / 已存在且内容不被截断 / 同名为目录 / 不可写父目录 / 工作区外父目录 / 路由 200·409·400 三态），`tests/file-tree-new-file.spec.tsx`（11 例：菜单只在目录行、根层与子层提交、Escape、非法名、占用名、服务端拒绝进错误条、失焦提交、两种创建器互斥），`tests/file-tree-sort.spec.tsx`（12 例：三档顺序、文件夹优先两种取值、默认等于宿主顺序、不原地排序、`typeOf`，以及 FileTree 渲染与 TreePanel 头部控件端到端切档）。

- 📑 **Tab 右键菜单补两项**（[#109](https://github.com/omdsh-dev/DSH-better-sidebar/issues/109)）：「**关闭全部页签**」与「**在资源管理器中定位**」。前者作用域与相邻三项一致——**右键所在的那个标签组**（分栏各管各的），含右键的那个页签本身（这是它与「关闭其他页签」的区别），逐条走既有单页签关闭路径（descriptor `onClose` 生命周期 + 终端 pty 释放 + 会话作用域），页签在滚动视口外也能关；菜单只从页签上打开，所以该项恒可用。后者对页签关联的文件（`tab.path`，即编辑器/文件夹窗口）调用宿主 **open-in-app** 的 reveal——与资源管理器行右键「在文件管理器中显示」**同一个适配器**（`createOpenInApp` → `ctx.remote.session.openWorkspacePath({ action: 'reveal' })`），不新增任何宿主调用；变更 / 任务 / 侧边对话 / diff 页签没有可定位的文件（diff 的 ref 是仓库相对路径，不是宿主能定位的路径），该项置灰，无 resolver 时同样置灰。词条 `closeAllTabs` / `revealTabInFileManager` 同批进入 `locales.ts` 的 zh/en 与 19 份第三语言词典。
- 🧪 测试：`tests/tab-bar-context-menu.spec.tsx` 把菜单整份钉到 **6 项**（标签序 + 每行 disabled 数组），新增「关闭全部」「定位」「无关联文件置灰」「无 resolver 置灰」用例，并新增一条 Workbench 用例钉住 reveal resolver 穿到**分栏后每个 pane 的** tab 条（回退任一层传递即红）。
- 🔍 **文件搜索优先走本机原生引擎（fd / ripgrep），缺失或失败自动回退 JS 遍历**（[#203](https://github.com/omdsh-dev/DSH-better-sidebar/issues/203)，PR [#303](https://github.com/omdsh-dev/DSH-better-sidebar/pull/303) 重写落地）：`fs.search` 之前是纯 JS 递归遍历，十万级目录秒级、10 万条访问预算一顶就静默截断。现在启动后惰性探测一次（每个候选二进制 `--version` 500ms 内验证通过才用，进程内缓存），探到就用引擎，探不到/运行失败回退原遍历；rg 优先用 DSH 自己捆绑的 `@vscode/ripgrep`（agent 侧搜索工具同一个二进制，从 CLI 入口的依赖树推导候选路径），fd 走 `--fixed-strings` 字面量匹配。噪声目录排除名单单源化到 `SKIP_DIR_NAMES`（18 项，walk 与两条 argv 共用），引擎输出统一归一化成 walk 契约（根相对、`/` 分隔、大小写不敏感），**路由与客户端零改动**。**目录命中按 #801 的契约同时产出 `dirs`**：fd 用 `--type d` 直接列目录，rg 由文件路径倒推匹配的目录段（`deriveRgMatches`）——唯一残留差异是**空目录在 rg 下不可见**（已记录）。运行失败禁用该引擎（坏二进制不该拖慢后续搜索），**超时只降级本次**（树太大不等于二进制坏）。调试插桩 `DSH_SEARCH_DEBUG=1` 写 `$DSH_HOME/search-debug.log`，默认完全静默。Windows 侧由 `ci-windows` lane 承载：`choco install fd ripgrep` + `pnpm check:engines` 对插件自己的 argv 做字节级断言（不得含 `\`/CR、非 ASCII 文件名必须命中）。
- 🧪 测试：`tests/search-engines.spec.ts`（探测缓存 / 失败禁用 / 超时不禁用 / argv 对称性 / `deriveRgMatches` / 捆绑 rg 候选路径推导 / 真引擎在场时的端到端），`tests/fs-search.spec.ts` 的 dispatch 组（引擎优先、`dirs` 透传、预算透传、运行失败回退并禁用）。

### v0.24.1

> 🎁 **本版包含从 v0.22.1 起的全部内容**（v0.23.0 的文件页 / 文件变动页 UI/UX 重构与性能打磨、v0.24.0 的 DSH 0.2.0-rc.1 支持线前移，以及本节的修复）。
>
> 🐞 **修复版**：文件树「一操作就整体刷新」的两处根因。① 原生承载面（`src/client/native/index.ts` 的 `sync()`）把 `files` 接管项当成多余注册——它按 KIND 记账、永远不在 `wanted` 里，于是**每次会话状态写入**都被 dispose + 重建；替换 slot 注册等于替换宿主的 slot entry，**整个插件 tab body 被卸载重挂**（展开/收起、切 tab、拖底部工作台都会触发）→ 文件树丢失层缓存、滚动位置与目录 watcher，并重新 `fs.trees([root, ...expanded])` 重列整棵可见树。② 目录实时刷新（`FileTree.tsx` 的 `retryDir`）**先把该层缓存删掉**再请求，行被占位替换后重建（构建 / 格式化 / 模型跑 bash 时整层闪空）。

- 🧪 判别性证据：真实挂载 lane 新增 `tests/e2e/zz-expand-refresh.e2e.ts`（展开只请求该层、tab body 存活、行数不归零；回退任一修复即红），配套两个 jsdom 单测（回退后 `registered` 6 → 12、`disposed` 全是 `dsh-better-sidebar:files`；另一条断言重列期间旧行仍在屏）
- 📉 修复后实测（40 子项目录）：展开 `fs.trees` payload 由 `[root, big]`（空缓存特征）变为 **`[big]`**，新开 WebSocket 1 → **0**，被删行 45 → **0**，外部写入由「删 40 建 40」变为 **只增 1 行**
- 🔧 `src/fs-watch.ts` / `use-dir-watch.ts` / `TreePanel.tsx` / `tab-adapter.tsx` 零改动（`fs.watch` 新建自身不投递事件，已实测证伪）

### v0.24.0

> 📦 **支持线前移**：仅适配 DSH **0.2.0-rc.1+**（peer 下限 `^0.2.0-rc.1`，CI 钉 `@deepseek-ai/dsh@0.2.0-rc.1`）。**0.1.7 线（含 npm `latest` 的 0.1.7-rc.2）请固定 v0.22.1（0.1.7 线最后发布的版本）**——宿主 0.2.0 的启动兼容性预检按 `semver.satisfies(宿主版本, peer范围, {includePrerelease:true})` 判定，caret 范围跨 minor 不成立（实测 `^0.1.7-rc.1` 对 `0.2.0-rc.1` 为 **false**，整行会被静默禁用），因此本版不保留任何 0.1.7 兼容分支。

- 📦 **基线抬到 `0.2.0-rc.1`**：14 条 DSH peer + 27 个 `@deepseek-ai/*` devDependencies 同步钉版；`dsh.plugin.json` 的 `engines.dsh` 随之前移；挂载 lane（`scripts/e2e-common.sh`）与 CI 钉版同步。
- 🔍 **适配前的实测结论（纯增量，故无运行时改动）**：本插件消费的 19 个宿主包里**零个值导出被删除**；类型面仅 `dsh-client-ui-primitives`（`DisclosureRow`/`TextShimmer`/`Tooltip` 新增可选 prop、overlay 顶部内距）、`dsh-session`（新增 `ToolCallRecovery`）、`dsh-api-remotes`（新增 product-analytics remote）有变化；会话格式仍 **v4**（无迁移包）、`SUBAGENT_DESCRIPTOR_VERSION` 仍 **3**、`dsh/lib/bin.js`（`dsh plugin` / `dsh web` / 启动行 / `--version`）与 `dsh-client-modules` 运行时**逐字节相同**、web profile 的客户端 inject 列表相同、`ui-primitives` 的裸 import 集合相同（无需新增测试期依赖）。
- 🧩 **宿主 web profile 组成变化与本插件无关但已核对**：新增 desktop-only 的 `product-analytics` / `desktop-product-telemetry`（web profile 上 `disabled`）；原先就 `disabled` 的 `time-context` / `schedule` / `ui-schedule` 三行移入可选的 `dsh-experimental-schedule-bundle`。「宿主 tab 只有 terminal、browser 缺席」的挂载断言不受影响。
- 🧪 **测试与规则**：`tests/market-manifest.spec.ts` 的 peer 形状断言改为钉当前基线 tuple，并把「caret 跨 minor 必失效」写进注释（这条与 §3.4 第 12 条里「includePrerelease 更宽松」的经验不冲突：宽松只发生在同一 minor 内）。
- ⚠️ **唯一残留**：可选集成 `@huanlin/dsh-plugin-better-locale`（未被任何源码/测试 import，仅结构化运行时探测）的 peer 钉在 `^0.1.0-rc.8`，其最新 0.4.3 同样钉 `^0.1.5-rc.2`——两者在 0.2.0 上都会被宿主预检禁用，故 `pnpm peers check` 会报它的 5 条 unmet peer。这是上游未适配 0.2.0 的结果，与本插件自身 14 条 peer 无关。
### v0.23.0

> 🧭 **开发线版本（从未发布到 npm，全部内容随 v0.24.1 一并发布）**：文件页与文件变动页的整体 UI/UX 重构，加上一轮性能与交互打磨。文件页新增 **Ctrl/Cmd 与 Shift 多选**（VS Code 语义）、批量操作条、**Git 变更着色**（与 VS Code 同色的新增/修改/删除/冲突，目录带汇总点）、**新建文件夹**、拖拽上传体验重做；**多选可右键「压缩并下载」**，打包在宿主侧成为带进度的任务（`archive.build` / `archive.status`，逐条目回调，4 并发 + 5 分钟 TTL + sessionId 绑定）。「打开方式」改为**双源并存**：宿主探测到的本机关联应用（资源管理器 / VS Code / Cursor / Zed / 自定义编辑器，含 SSH 远端）与插件自研目标，可用设置开关 `openWithPluginTargets` 强制并存；右键菜单收敛层级（一级只留默认动作，应用列表进子菜单）。文件变动页**重构为层级树**，Git 视角（工作区 / 暂存 / 历史）与 Agent 视角（会话内改动）各自保留，目录行可暂存/取消暂存。交互与性能：`/sidebar/api/fs.tree` 实测 **22.8ms → 3.8ms**（10k 条目，readdir 一次取回 + 只为 cap 建行 + 小写比较排序 + 1.5s 目录级缓存，由写操作与 fs-watch 失效），新增批量路由 `fs.trees`（挂载/刷新的 N+1 请求变 1 个），右键菜单打开不再重列目录、行不再随 git 轮询重渲染。修掉「在侧边打开」没有效果（原来只写未展开的底部工作台，现按承载面分流到宿主 `openResource(preferNewPane)` 真正分栏）。

- ⚠️ **行为变更（安全相关）**：**删除工作区路径检测**——插件 fs 路由（tree/read/write/rename/remove/mkdir/媒体/HTML/upload/archive）不再做包含性检查，可读写宿主用户能访问的任意路径（仅受 OS 权限约束），`workspaceFence` 设置与围栏提示一并移除。
- 🧩 抽出可复用的全局组件与共享 store（`IconButton` / `Chip` / `SectionHeader` / `Notice` / `ConfirmDialog` / `StatusBadge` + 共享 git 状态 store），皮肤契约（`tests/theme.spec.ts`）继续守护；ZIP 打包器自研（无第三方依赖）并修掉非 latin1 文件名的下载头 500（RFC 5987）。
- 🐞 同时修掉：关闭文件后返回文件树时展开状态被重置（原生承载面的展开集合原先按 tab 记录，现改为**每会话状态**的投影）。

### v0.22.1

> 📦 **正式版**（npm `latest`）：仅支持 **DSH 0.1.7-rc.1+**（peer 下限 `^0.1.7-rc.1`，CI 钉 `@deepseek-ai/dsh@0.1.7-rc.1`）——**支持线不变**，0.21.1 / 0.22.0 的用户直接升级即可；**DSH 0.1.6-alpha.2 及更早请继续固定 v0.19.1**。这是一次补丁版：两个缺陷在真机上可稳定复现，而当时的单元测试**全绿**。

- 🐛 **`files` 接管 id 被孤儿化 → `native register files error: … already registered` 刷屏 + 文件树落到宿主空态（需刷新页面才恢复）**（社区 issue #770 / #771 / #766）。根因链由官方桌面壳日志逐字确认（`desktop.frontdesk.log` 2026-09-27 15:51:39.338）：客户端条目替换（插件市场更新 / Plugins 页禁用→启用 / HMR 重打）期间，插件 teardown 逐个注销内置描述符 → `service.notify()`（同步内联）驱动 `sync()` 在**已经 inactive** 的插件上下文上运行；清理循环把**不是描述符**的 `files` 接管释放后又**在同一轮里重建**它——`tabs.register` 建在**宿主**上下文上（宿主上下文仍活着）因此照样取走 id，紧随的 `ctx.slots.inject` 建在插件上下文上抛 `cannot create effect on inactive context`，`live.set(FILES_KIND, …)` 永不执行，disposer 丢失 → 该 id 在**整个页面生命周期内不可再注册**。修复（社区 PR #777，@yanzhaohui1999）：① 清理循环**跳过 `FILES_KIND`**——接管的寿命只由编辑器类型的 `wantsFiles/hasFiles` 开关与 seat disposer 决定；② **任何在宿主取走 id 之后失败的注册都回滚释放**该 type 与已建好的槽位，失败只留一个「下次通知可重试」的状态，绝不留下无处释放的 id；③ teardown / 清理循环逐个安全释放（一个释放抛错不再中断其余）。
- 🐛 **macOS 桌面版窗口拖拽「拖一次就失效」并且双击标题栏缩放也失效**（issue #772）。插件宿主是直挂 `body` 的子元素，宿主的 `html[data-platform=darwin] body > :not(#root) { -webkit-app-region: no-drag }`（选择器含 id，只有 `!important` 能压过）命中它，而 app-region **无视 `pointer-events`**——铺满视口的面板层把下面每条 `[data-window-drag]` 拖拽带一起抵消。修复（社区 PR #773 合并；随后 #786 补齐）：`[data-dsh-better-sidebar]`、`[data-dsh-panel-host]`（`> *` 保持 `no-drag`）与放大视图 `.mermaidModal` 用**中性值** `-webkit-app-region: initial !important` 退出计算——`initial` 的计算值 `none` **不**扣减拖拽区，而字面量 `none` 不是中性值（它计算成 `no-drag`）；交互弹层（`.selectionPopup`、`FloatingWindow`、`AnchoredPopover`）**不**加 `initial`，否则按下会变成拖窗（重演 #103/#111）。
- ✅ **守护**：`tests/native-registration.spec.ts` 把两条不变量钉在注册表的**事件日志**上（在未修复代码上 4/4 红，且「失败后仍能重新注册」不再是非判别断言）；槽位失败判据改为 `name::key`，让 `registerSlots` 的**部分回滚**释放路径真正被执行；新增**部署级回归门** `tests/e2e/native-reload.e2e.ts`（`utimesSync` 已安装的 `lib/client.js` → 页面内条目替换 → 断言无 `native register … error`、无诊断条、`files` 接管重新可用；npm 0.22.0 上连续 3 次运行全红、修复版连续 3 次全绿（该用例只有 1 个 test，重复跑三次））。拖拽契约由 `tests/panel-host-css.spec.ts` 在 Linux 的 `pnpm test` 里钉形状（无 macOS runner），并由挂载 lane 的**真实级联探针**按宿主规则读计算值（面板宿主/放大视图在未修复产物上都判红）。
- 📐 **基线不变**：`@deepseek-ai/dsh-*` 仍钉 `0.1.7-rc.1`，peer 下限 `^0.1.7-rc.1`；无公共 API / 契约 / 词典 / chunk 改动。事故记录与「为什么否决 #766 的吸收方案」见 [docs/plans/2026-09-28-native-files-takeover-reload-leak.md](./docs/plans/2026-09-28-native-files-takeover-reload-leak.md)。
- 🧪 **验证**：`pnpm test` 122 files / 1293 passed / 9 skipped；`pnpm test:mount` 与 `DSH_CMD=… pnpm test:mount:aggregate` 绿；打包产物里 `app-region:initial!important` ×2、`no-drag` ×2。

### v0.22.0

> 📦 **正式版**（npm `latest`）：仅支持 **DSH 0.1.7-rc.1+**（peer 下限 `^0.1.7-rc.1`，CI 钉 `@deepseek-ai/dsh@0.1.7-rc.1`）——本版没有动支持线，0.21.1 的用户直接升级即可。**DSH 0.1.6-alpha.2 及更早仍请固定 v0.19.1**。主内容是把任务管理页从「子代理拓扑」重做成**工作流图**，并在随后几轮里按真机反馈打磨；期间 DSH 0.1.7 删掉了 Agent Teams 的 Remote 方法，团队与后台任务两个数据面随之改写。

- 🧩 **任务管理页 = 工作流图（全新主显示模式）**：会话树渲染为分层节点 + 贝塞尔连线的画布——拖拽平移、滚轮缩放到光标、内容包围盒居中适配（双击背景重新适配）、右下角控制条（图/树切换 + 折叠开关 + 缩放 + 适配）。**经典缩进树保留**（键盘可导航），两种模式共享同一个视图模型，折叠状态与团队富化不会视觉漂移；默认视图走设置里的偏好。
- 🃏 **双段式节点卡**：上段 = 类型徽章（主代理 / 子代理 / 成员 / 工作流 / 已完成聚合）+ 相位徽标 + 名称 + 元信息；下段小条 = 状态点 + 状态词 + **主 Agent 同款合并活动行**（并发工具按类别归并 + 计数 + 最新在跑那条的细节，措辞直接取宿主 `chat` 命名空间的词条）+ 已完成节点的折叠 chevron。运行中小条从左到右**完整扫过**（1.5s，令牌渐变，`prefers-reduced-motion` 下关闭）。卡片 8px 圆角、只用上段极淡底色表达层级、当前会话用加粗 accent 描边。
- 🔀 **工作流 run 入图**：宿主侧从 `tool-workflow/*` 会话事件折叠出 run（与官方 workflow-run 面板同一批事件），run 挂在发起代理下、成员 agent 重新挂到 run 节点下并按相位分框、同色相位徽标；catalog 里没有的成员用 run 自身数据合成占位节点，所以跑完的 run 仍能看到它的成员。
- 🗂 **折叠分两组，各自说清自己是什么**：`✓ N 已完成`（已完成 + 出错，失败会单独报 `出错 N`）与 `N 个待命`（跑完一轮、随时可被叫起来的 teammate）是**两行**；**手动 chevron 永远有效**（不设阈值），**自动聚合**只在「待命成员 ≥3」时收空闲成员——1~2 个待命成员就是这个团队的工作集，而且它们的卡上会挂任务行。聚合卡名字行写「前两个名字 + `+N`」，点聚合全部展开。
- 🪟 **两个常驻浮动窗**（抽出可复用的 `FloatingWindow`）：后台任务输出与共享任务详情/编辑都在其中——可拖拽、可四边拉伸、内容区自滚动、只靠关闭按钮或 Escape 结束时消失（外部点击、失焦、锚点离屏都不关）。任务窗把窗口余量交给描述区（编辑态交给多行输入框），拉大窗口是给内容更多空间而不是留白；动作行固定在 footer，长描述不会把按钮推出视野。
- 👥 **Agent Teams 任务板（实验层）**：团队成员富化到对应节点上、常驻任务条列出成员与共享任务；任务状态机跟随宿主（待办 → 认领 → 进行中 → 完成 → 重开）+ 改派 / 编辑 / 两击删除，CAS 过期修订单独提示（别人改过 → 已刷新）。**成员活动由 `subagents.live` 的 running 叠加**，不是在客户端猜。
- 🔄 **后台任务改读宿主客户端服务**：0.1.7 的 web profile 挂载客户端 `ctx.jobs`（推送 roster + 非消费输出流 + kill），插件因此删掉自建的 `jobs.list` / `jobs.output` / `jobs.kill` 三条路由与事件回放镜像，也彻底不碰模型 `job_output` 游标（宿主把这层约束变成了能力）。输出改在常驻浮动窗里流式显示并尾随，代理数 ≥ 8 时抽屉自动折叠。
- 🛠 **DSH 0.1.7 的两处数据面重写**：① 团队读——0.1.6 的 `agentTeams.remoteView` 三个 Remote 方法被上游删除，插件改为读 Lead Session 的 **`agentTeam` Session projection**（与 `subagentCatalog` 同源、推送式），删掉 `teams.view` 路由与 5 秒轮询；写路径保留两条路由（`createTask` / `updateTask`），拒绝从「返回联合」变为「抛 `TeamError`」，`TEAM_TASK_STALE_REVISION` 映射成 409 `team-conflict`。② 后台任务——见上一条。**修掉的真实故障**：0.1.7 上团队条从来不渲染（路由报 `remoteView is not a function`，页面静默无提示）。
- 🐛 **真机抓到的四个缺陷**（单测都绿的）：
  - 逐节点折叠按钮点了没反应——它被**自动**折叠的守卫卡住了（`isAutoFoldable` 要求非成员且是叶子），而按钮是**手动**触发，现在两种触发各有各的守卫；
  - 「待命」的卡片**从来不画**折叠按钮（chevron 的渲染条件写死成「已完成/出错」），现在「不在执行」即提供；
  - 认领任务后标签变「阻塞」——`ready` 的语义只是「待办且无未完成 blocker 可认领」，对所有非 pending 任务都是 false，现在收敛成唯一规则 `taskBlocked/taskStatusLabel/taskTone/taskDotState`；
  - 任务窗「完成」在队列中的任务上必失败——宿主状态机要求先认领，动作行现在跟随状态。
- 🎨 **窄屏与手机设置**：卡片/行距/字号按原生右侧栏的窄宽重新定档（内容包围盒居中、缩放夹取、平移边界、相位框配色、连线 stub 加粗、卡片高度预算重算）；设置页新增**手机**分组——窄屏（≤768px）时新任务页不再自动弹出、任务管理页默认走树状图。
- 📐 **基线**：`@deepseek-ai/dsh-*` 钉版与支持线**不变**（0.1.7-rc.1，peer `^0.1.7-rc.1`）。新增词条若干（含 `teamTaskClaim` / `tasksFoldIdle` / `taskWindowCreate` / `tasksStateProvisioning` 等）×20 份词典；设计文档见 [docs/plans/2026-09-14-tasks-graph-workflow-teams-design.md](docs/plans/2026-09-14-tasks-graph-workflow-teams-design.md)、[2026-09-27-tasks-graph-polish.md](docs/plans/2026-09-27-tasks-graph-polish.md)、[2026-09-27-floating-window-mobile-settings.md](docs/plans/2026-09-27-floating-window-mobile-settings.md)、[2026-09-27-agent-teams-dsh-0.1.7-adaptation.md](docs/plans/2026-09-27-agent-teams-dsh-0.1.7-adaptation.md)（含实施偏差与已知限制）。

### v0.20.0（开发线，**从未发布**）

> 🚫 **这一版没有发布到 npm**（npm 上 `latest` 仍是 v0.19.1）：它原本是 0.1.6-alpha.2 线的正式版，开发完成后被 0.21 线直接取代，所以下面这些变更实际随 **v0.21.1** 一起发布。原本的定位：仅支持 **DSH 0.1.6-alpha.2+**（peer 下限 `^0.1.6-alpha.2`，CI 钉 `@deepseek-ai/dsh@0.1.6-alpha.2`）。**这是一次破坏性变更版**：0.1.5-rc.* 用户请固定 `dsh-better-sidebar@0.19.1`。适配记录见 [docs/plans/2026-09-21-dsh-0.1.6-alpha.2-adaptation.md](docs/plans/2026-09-21-dsh-0.1.6-alpha.2-adaptation.md)。

- 🖥️ **终端交给 DSH 内置**：DSH 0.1.6 自带右列终端（`ui-sidebar-terminal`），所以插件删掉了整套自研终端——`pty-manager` / `agent-pty` / `pty-deps` / 8 个 `terminal_*` 工具 / xterm 视图与字体链接 / 跨会话固定终端，以及 `node-pty` 依赖、它的 `allowBuilds` 放行与安装脚本的 `-Repair` 模式。**注意**：模型因而失去跨调用持久的终端（只剩一次性 `bash` / `pwsh`）；上游 `@deepseek-ai/dsh-tool-terminal` 未被内置 bundle 挂载，需要时请自行在 profile 里启用。
- 🌐 **浏览器视图让给内置**：插件删掉 `BrowserView` / 沙箱状态条 / 嵌入性探测（含宿主 `browser.probe` 路由）与两个只配置自家 iframe 的设置项；**保留**聊天与界面的外链接管（按协议分流是宿主没有的能力），目标改为 DSH 内置的 `browser` tab 类型。
- 🧩 **产物行交回宿主**：DSH 0.1.6 把 `conversation.chat.turnTail` 从 chain 改成 list（上游有意让多个插件**追加**而非互相替换），插件原来的接管只能与内置产物卡重复，因此整体删除；点击行为不变（内置走宿主 `openFile` → 本插件编辑器）。代价是失去轮尾那一个「在文件树中显示」入口（树内右键仍在）。
- 🐛 **修复两个静默破坏**：`SidebarRightGuideEntry.id` 变成必填后，缺 id 会让**整个原生承载面静默空掉**（抛在 `ctx.inject` 回调里被吞）；`turnTail` 改 list 后原注册直接抛错、产物行失效。两处都已修好并加测试守护，同时补了注册失败的上报口。
- 🎨 **空白面板卡片对齐内置卡风格**：`.paneCard` 改用 DSH 指南胶囊那套配方（0.5px l4 描边 / 24px 圆角 / layer-1 填充 / 56px 下限 / 14×20 内边距），并加测试守护其几何、令牌化配色，以及不复制上游那套**未定义**的 `--dsw-alias-bg-l1/-l2` 拼写。
- 📐 **基线**：`@deepseek-ai/dsh-*` 全部钉 `0.1.6-alpha.2`，`dsh-code-runtime` 整包消失已移除，`diff` / `simple-icons` 作为 primitives 的新裸 import 提升进 devDependencies；`ui-primitives` 本版三处破坏（`IconSendOutline16` 下线、`TerminalBlockLabels.noExitCode` 新增、`ConnectionIndicator.reconnectLabel` 移除）同步适配。

### v0.19.1

> 📌 **正式版**（npm `latest`，无 prerelease 后缀）：钉版推进到 **DSH 0.1.5-rc.2**（npm `next`），**peer 下限仍是 `^0.1.5-rc.1`**——rc.2 的上游 delta 里没有任何触及本插件的面（零 `packages/api|host|session|agent` 变更，真实代码改动只有消息反馈弹窗、产物卡片 CSS 与 `CodeFileIcon` 的 SVG 数据拆分），因此 rc.1 用户无需升级 DSH 即可用本版。DSH 0.1.5-alpha.2 用户继续用 **v0.19.0-alpha.1**；0.1.2-rc.1 稳定线继续用 **v0.18.1**。

- 🎯 **适配 DSH 0.1.5-rc.2**：devDependency 钉版、CI 挂载车道与 `SIDEBAR_SERVICE_VERSION` 同步到 rc.2；插件侧**零代码改动**（上游 delta 未触及本插件，逐文件核对见 [docs/plans/2026-09-10-dsh-0.1.5-rc.2-adaptation.md](docs/plans/2026-09-10-dsh-0.1.5-rc.2-adaptation.md)——300 个变更文件里绝大多数只是各包 `package.json` 的版本号单行）。
- 🎨 **文件图标（#611）与内置 Tab 图标改为彩色**（#531 + #594 合并，实现按 rc.2 重做）：
  - **文件/文件夹图标走 DSH 官方图形**：回退链末端是宿主 `ui-primitives` 的 `FileTypeIcon`（48 类官方全彩代码/配置图形 + markdown/图片/PDF/Office/视频/文件夹的类目色板），插件**不再自带扩展名表，也不再需要图标懒加载 chunk**——`#429` 那份 563 条彩色数据与 `lib/client-file-icons.js`（255 kB）连同 `fileIconTheme` 设置开关一并删除，彩色就是唯一形态（核心 bundle 因此只增 10 kB）。
  - **新增对外 `registerFileIcon` API**（能力 `'fileIcons'`）：按扩展名（`exts`）、精确文件名（`names`）、目录名（`folderNames`）注册自己的图标，优先级降序、同级按注册序；**注意**：宿主分类器覆盖任意路径，所以注册 `exts: []` 的 catch-all 会接管所有未具体命中的行。
  - **内置 tab 图标彩色**：文件 / 文件变动 / 任务管理 / 侧边对话 / 终端 / 浏览器 六个类型与 diff 视图的 glyph 换成彩色版本（颜色全部来自 `--dsw-alias-*` 令牌，皮肤照旧全覆盖）。
  - **原生右侧栏的 tab 芯片也带图标**：宿主的 tab 定义没有 icon 字段，但 `sidebar.right.pane.tab.title` 槽就是芯片内容——插件在该槽渲染「图标 + 标题」（编辑器 tab 带路径时显示该文件的图标），glyph 为 `aria-hidden`，芯片可访问名不变。
- 🛠 **CI 修复一：Windows lane 的真实超时**。`ci-windows` 在 2026-09-09/10 窗口内红了 8 次，其中 6 次是真起进程的用例撞上 vitest 默认 5000ms：`tests/agent-pty.spec.ts`（真起 PowerShell + ConPTY）与 `tests/install-powershell.spec.ts`（冷启 `powershell.exe` 实测 12.1s）现在各自声明 30s 预算，且 `vitest.config.ts` 的全局 `testTimeout` 从默认 5000ms 提到 **15s**（第一次真实 Windows 跑又在**第三个**文件上翻车：`tests/git.spec.ts:85` 耗时 9607ms——三个文件同一个根因，逐文件加超时是打地鼠）；`waitForTranscript` 的内层轮询预算从 5000ms 降到 15s，**内层预算必须小于外层**（原先是同一个 5000ms，结构性必然超时）。`ci-windows` 的 `Test` 改跑 `pnpm test:windows`（`--maxWorkers=2`），在 2 核 runner 上不再让真起进程的 spec 互相抢占。
- 🛠 **CI 修复二：挂载车道的 npm 安装**。`plugin-mount` 的 `npm install -g @deepseek-ai/dsh@<ver>` 曾 4 次失败（2 次 `ETARGET`、2 次 `JavaScript heap out of memory` exit 134）：钉版自身的传递依赖是浮动 `^` 范围，上游**分阶段发布**预发布版时（rc.2 于 09-10 的 14:43–14:57 逐包上线）npm 会组出 rc.1/rc.2 混合 peer 图（3062 条 ERESOLVE）。现在钉一个**已完整发布**的 rc.2（修 ETARGET）并加 `NODE_OPTIONS=--max-old-space-size=4096`（修 OOM）。中途试过 `--legacy-peer-deps`，被真实 CI 否掉：它跳过的正是全局安装必须提供的 peer，`dsh-app-boot` 在 boot 时 require 的 `@deepseek-ai/cordis-plugin-group` 是 peer 而非 dependency，加了它 CLI 直接 `ERR_MODULE_NOT_FOUND`。

### v0.19.0

> 📌 **正式版**（npm `latest`，无 prerelease 后缀）：本版仅支持 **DSH 0.1.5-rc.1+**（peer 下限 `^0.1.5-rc.1`，CI 钉 `@deepseek-ai/dsh@0.1.5-rc.1`）。DSH 0.1.5-alpha.2 用户请继续用 **v0.19.0-alpha.1**（npm `alpha` 标签仍指向它）；0.1.2-rc.1 稳定线继续用 **v0.18.1**。

**✨ 新功能**

- 📝 **新建标签页列表恢复可选说明**（#613）：DSH 0.1.5-rc.1 让 `SidebarRightGuideEntry.description` 回归（可选），插件随之恢复 `TabDescriptor.description`，六个内置类型各写回一条说明（原生指南的 文件 / 文件变动 / 任务管理 / 侧边对话 / 终端 / 浏览器 六行都带上它），`guideDesc*` 词条回到 20 份词典。**宿主的原生指南只在列出的条目 ≤ 4 条时渲染说明**（更长的列表是整列丢弃，不是截断），而插件默认贡献 6 个 guide 条目——因此默认组合下说明不渲染，只有在插件设置页关掉足够多的 tab 类型、把 guide 压到 ≤ 4 条时才会出现。未声明说明的条目仍是「图标 + 标题」单行（插件不补通用兜底句）。

**🐛 修复**

- 无。rc.1 相对 alpha.2 的 delta 很小（373 个变更文件，绝大多数是上游各包版本号、原生右侧栏预览 UI 打磨与测试快照），除上述说明字段回归（并附带上游 `files` 类型改用自己的彩色文件夹图标作指南字形）外，没有需要插件适配的变更。

**🧰 CI 与内部**

- 基线推进到 **DSH 0.1.5-rc.1+**（#613）：peer 下限、devDependency 钉版、CI 挂载车道与 `dsh.plugin.json` 的 `engines.dsh` 同步（rc.1 在 npm 上同时是 `latest` 与 `next`）。
- 明确未变、不必再核：全局主面板模型（`main` 槽 / `sidebar.panellist` / `ctx.layout` / 根级 `rightbar` + `rightbar.session`，插件仍不接入）、文件地址语法（`packages/util/workspace-path` 只动了版本号）、原生 tab 体宿主契约（`.paneBody` 仍是有确定高度的块级滚动容器）、core / agent / session / subagent 宿主 API 与 `ui-primitives` 导出面（仅 CodeBlock 渲染变化）。
- `@deepseek-ai/dsh-client-ui-primitives@0.1.5-rc.1` 仍不声明 `dependencies` 而 bundle 仍裸 import `anser` / `shiki` / `@shikijs/langs/*` / `mdast-util-*` / `micromark-*` / `katex`——上一版提升进 devDependencies 的那组包因此保留，不得回退。
- 真机验证（DSH 0.1.5-rc.1 + 插件 0.19.0）：门禁 `typecheck` / `lint` / `check:consumer-types` 全绿，单测 **124 files · 1296 passed · 9 skipped**，`pnpm peers check` 干净；挂载冒烟对真实 rc.1 **7 passed**（含 tab 体填充断言，以及新增的「指南 ≤4 条时说明才渲染」断言）；本地 3080 实测：guide 六行仍是「图标 + 标题」（6 > 4，说明按上游规则不渲染；上游把胶囊 `min-height` 从 48px 调到 56px），文件树点击 `AGENTS.md` 落到插件编辑器（CodeMirror 就绪），sidechat 输入框贴底（宿主盒 962px == 面板体 962px，composer 底边距 8px），底部工作台与中心列左右边完全重合，`pageerror` 0（控制台仅有第三方 `dsh-tauri-worktree` 的 `/api/dsh-worktree/attach` 500，与本次改动无关）。

### v0.19.0-alpha.1

> 🧪 **alpha 通道**（npm dist-tag `alpha`，安装 `dsh-better-sidebar@latest`）：本版仅支持 **DSH 0.1.5-alpha.2+**（peer 下限 `^0.1.5-alpha.2`，CI 钉 `@deepseek-ai/dsh@0.1.5-alpha.2`）。0.1.5-alpha.1 请继续用 **v0.19.0-alpha.0**；0.1.2-rc.1 稳定线用 **v0.18.1**（npm `latest`）。

**✨ 新功能**

- 🪟 **每个 tab 体都填满面板**（#609）：原生右侧栏的 tab 体宿主是「有确定高度的块级滚动容器」而非 flex 容器，此前插件各 tab 的根只写 `flex: 1`，在块容器里塌成内容高度——侧边对话的输入框因此贴不到面板底（转录一长就被推出可视区）。现在 native 适配层统一给每个 tab 体包一层 `height: 100%` 的列 flex 宿主，插件全部 tab（含第三方 `registerTab` 注册的 descriptor）恢复与底部工作台一致的填满语义。

**🐛 修复**

- 🧭 **跟随 DSH 0.1.5-alpha.2 的文件地址语法**：`fileAddressFor` 一律产出 session 作用域地址、绝对路径保留前导 `/`；`parseFileAddress` 改为前缀解析并忽略 `?`/`#` 后缀。
- 🪟 **底部工作台的中心列定位跟随 alpha.2 全局面板改动**：`conversation` 槽改为根级 `main` keyed 槽下的 `main.conversation`，定位器改认新 key 并跳过 `display: contents` 槽宿主（alpha.1 的旧 key 仍兼容）。

**🧰 CI 与内部**

- 基线推进到 DSH 0.1.5-alpha.2（#609）：peer 下限、22 个 devDependency 钉版、CI 挂载车道与 `dsh.plugin.json` engines 同步；`pnpm peers check` 干净（按 §3-9 补提 `dsh-session-persistence` 传递 peer）。
- **移除 `TabDescriptor.description`**：alpha.2 的原生指南条目不再渲染第二行（改为「图标+标题」胶囊），该字段与 6 个 `guideDesc*` 词条（20 份词典）一并下线；新建标签页的默认页改由注册表选（恰好 1 个指南条目则直接打开它）。

### v0.19.0-alpha.0

> 🧪 **alpha 通道**（npm dist-tag `alpha`，安装 `dsh-better-sidebar@latest`）：本版仅支持 **DSH 0.1.5-alpha.1+**（peer 下限 `^0.1.5-alpha.1`，CI 钉 `@deepseek-ai/dsh@0.1.5-alpha.1`）。0.1.2-rc.1 稳定线请继续用 **v0.18.1**（npm `latest`）。

**✨ 新功能**

- 🖥️ **接入 DSH 原生右侧栏**（#604）：右列改为 DSH 自己的右侧栏——插件的 7 个 tab 类型全部注册成原生 tab 类型 + 原生 tab 体；聊天里的文件打开统一走 `ctx.sidebarRight.openResource(dsh-resource://file/…)`；`editor` 类型以 `extension` 优先级认领文件资源（压过内置文本预览）并接管内置「文件」页 kind（注销即复位）；跨会话打开在目标会话未上屏时排队重放。
- 🧩 **退役插件自绘右侧面板与自由窗口**（#605）：右列归 DSH 后，插件只保留底部工作台（单分栏树、随会话持久化），开合按钮注册进 DSH 会话头 utilities 槽；浮窗 API（`floats` / `floatTab` / `dockFloat` / `raiseFloat` / 右键「移动到自由窗口」）、`features` 里的 `'floatWindows'`，以及 `openByDefault` / `defaultWidthPercent` / `changesDiffFloat` 三个设置项一并删除（旧持久化文档里的 `floats` 字段被忽略，不影响加载）。
- 🔗 **适配 DSH 0.1.5 宿主契约**（#603）：`assistant/chunk` 事件删除 → 实时增量改由 `agent/assistant-stream` 帧折叠（侧边对话转录的 `live` 字段）；`sessionPersistence.inspect` 删除 → 冷会话读取改走 `open(id,'read')`；会话头 `version` 用 `SESSION_FORMAT_VERSION`。

**🐛 修复**

- 侧边对话转录 / `jobs.output` 回放 / fork 继承等 8 处会话事件读取跟随 0.1.5 契约；自定义种子补齐 fork 标记对，避免继承父会话未领取的 inbox 输入。

**🧰 CI 与内部**

- 真机挂载冒烟门禁钉 0.1.5-alpha.1，e2e 增加「展开原生栏 → 经引导页逐个打开插件 tab 类型」的巡检；typecheck / lint / 单测 / 挂载车道全绿。

### v0.19.0（未发布）

- 🎨 **可选彩色图标主题**：设置页「文件 → 文件图标」可在**内置单色**与**彩色品牌图标**之间切换——彩色主题含 563 条规则（218 扩展名 + 197 精确文件名 + 148 目录名，如 `.tsx → React`、`package.json → npm`、`node_modules` 着色），数据在**懒加载 chunk**（`lib/client-file-icons.js`）里，只有选中时才下载，默认关闭时启动零开销。数据源自 [#429](https://github.com/omdsh-dev/DSH-better-sidebar/pull/429)（@fenter）。
- 🎨 **文件图标多样化 + 对外图标注册 API（[file-icons.tsx](./src/client/file-icons.tsx)）**：文件树与编辑器文件 tab 不再是单一 `VscFile`——markdown / 图片媒体 / PDF / JSON / 40+ 代码扩展 / 配置 / 数据库 / lock / 压缩包各有专属 glyph（VSCodicons 单色 `currentColor`，遵循皮肤契约），未知扩展回退通用图标。`ctx.betterSidebar` 新增 `registerFileIcon`（`features` 含 `'fileIcons'`）：按扩展名 / 精确文件名（`names`）/ 目录名（`folderNames`）注册自定义图标（彩色 ReactNode 亦可，颜色责任在注册方），`exts: []` 为全局默认（只兜内置 glyph 没认领的扩展，不吞掉内置多样性），保留扩展名 `'folder'` / `'folder-open'` 可换目录行图标；`fileIcon` / `folderIcon` 为权威解析器（完整回退链 + 逐工厂崩溃隔离），注册/注销即时生效。接入示例见[外部插件指南 §7](./docs/external-plugin-guide.md)。

### v0.18.1

> 📌 **正式版**（npm `latest`）：DSH 基线不变（**0.1.2-rc.1+**，peer 下限 `^0.1.2-rc.1`）——本版是 v0.18.0 之后的增量发布：变更面板预览能力增强、文件树可写，以及五项修复。

**✨ 新功能**

- 📄 **变更面板操作预览增强**（#499）：`.md` 阅读模式（含 mermaid 渲染）、`.html` 与 `.pdf` 内嵌渲染预览；diff 语法高亮扩展到 mjs/cjs/mts/cts、CSS/SCSS/Less、HTML/XML/SVG/Vue、GraphQL、JSONC/JSON5；新增**密钥脱敏**层（预览默认开启，面板头部可切换）
- 🗂️ **文件树重命名 / 删除**（#550）：行内重命名 + 确认式删除，右键菜单减重与子菜单视口钳制
- 🧩 **插件目录名与 shell 预设文案词典化**（#535）：跟随宿主语言

**🐛 修复**

- 🔀 **git diff 折叠上下文真实展开**（#576，修复 #577）：折叠行此前显示「n 行…点击展开」却点不动（`-U3` 裁剪使 gap 段没有行文本）；现按需经 `git.show` 拉取两侧完整内容切片填充，带加载 / 失败降级三态与请求去重；顺带修复该路由的 `rev:path` 寻址（此前恒返空）
- 💬 **侧边对话种子不再继承父会话未领取的 inbox 消息**（#562）：补 fork 标记对，消除「上下文很长时侧边对话先把之前的 User 消息发出去」的幽灵消息
- 🖼️ **Markdown 分栏渲染器内的本地图片**（#569）：改写为可访问 URL，不再 404

**🧰 CI 与内部**

- ESLint flat config 接入 CI 与 Makefile（#536）、Makefile 命令面规范化（#526）、e2e 脚本加固（#527）、共享组件测试工具收敛样板（#524）
- 重构：Sidebar.tsx 按关注点拆分（#542）、四处轮询习语收敛到 `use-polling`（#541）、删除 rc.7 宿主的 `__DSH_MODULES__` 回退路径（#540）、One Dark/Light 语法色板单源化（#534）、重复实现收敛与死代码清理（#525）

### v0.18.0

> 📌 **正式版**（npm `latest`）：本版仅支持 **DSH 0.1.2-rc.1+**（peer 下限 `^0.1.2-rc.1`）；不再支持 0.1.0-rc.8 ~ 0.1.1-rc.2——DSH stable 用户请固定安装 `dsh-better-sidebar@0.17.1`，停留在 0.1.2-alpha.x 的宿主继续用 `dsh-better-sidebar@latest`（v0.18.0-alpha.0）。

**✨ 新功能**

- 🌿 **「文件变动」统一 tab**（#475）：Git 视角（真 diff / 历史 / 暂存·提交·还原 / worktree·子仓库选择）与本轮文件视角（模型读/写/编辑实时追踪）双视角合一；统一 diff 渲染（改蓝配对 + 行内字符级高亮 + 语法着色 + 上下文折叠）、底部可拖拽预览面板、一键展开独立 diff tab
- 💬 **侧边对话渲染升级**（#486）：主对话级 Blocks 结构、turn 用量尾标、断线重连横幅
- ⚙️ **工作区路径围栏开关**（#458）：新增 `workspaceFence` 声明式设置键，工作区外路径 403 时错误面一键关闭并指引

**⚡ 性能**

- 🚀 **核心包 -45%**（#489）：19 个非中英词典 chunk 懒加载、渲染稳定化（转录行复用 / tree Sets / 批量 drag）、启动与轮询开销削减（单次 settings fetch、每 tick 单 git 进程）；新增 perf 测量 lane；顺带修复底栏拖拽把面板宽度泄漏进宿主布局、原生左栏突跳的 bug
- 📉 会话列重复 DOM 查询削减（#456）

**🐛 修复（节选）**

- ✏️ 编辑器 / Markdown：SSH 远程链接客户端打开（#522）、预览/编辑切换保持阅读位置（#467）、预览隐藏 YAML frontmatter（#394）、TOC 外点关闭与层级修复（#461）、@-引用保留 basename（#417）
- 💻 终端 / 平台：Windows 自定义 shell 解析（#503）、resize 失败容错（#428）、字体解析兜底等宽（#366）、WSL 会话 Linux 绝对路径（#455）、Windows Explorer reveal 保留选中（#508）
- 🗂️ 布局 / 状态 / 文件树 / 对话：桌面 shell 布局与侧卡片共存（#398）、窄屏自动激活不强制抽屉（#373）、自由窗口 id 恢复冲突（#385）、窗口聚焦自动刷新文件树（#469）、引用提示固定行尾（#509）、划选弹窗关闭与草稿插入锚定（#427）、折叠态开关组对齐（#361）、旧引擎滚动跳变兼容（#448）、旧版 Git worktree 列表（#454）

**🧰 CI 与内部**

- Windows CI 车道（#520）、Makefile 命令面规范化（#526）、e2e 脚本加固 + 聚合双挂载回归（#527）、共享组件测试工具收敛样板（#524）、重复实现收敛与死代码清理（#525）

**🌐 生态收录**

- 新收录 10+ 插件：dsh-better-sidebar-icons（#441）、dsh-sidenote（#451，原 dsh-sidechat #470）、dsh-github-workbench（#410）、dsh-bilingual-reader（#379）、dsh-server-deck（#413）、dsh-md-export（#405）、dsh-code-nav（#404）、dsh-suhuang-scroll（#392）、dsh-better-overleaf（#370）等（均含 18+ 语言 i18n 补齐）

<details>
<summary><b>历史版本（v0.12.0 – v0.15.2）</b></summary>

### v0.19.0-alpha.0（0.1.2-alpha.5 适配，未发布，内容并入 v0.18.0）

> 🧪 **alpha 通道**：本版仅支持 **DSH 0.1.2-alpha.x**（peer 下限 `^0.1.2-alpha.5`，npm dist-tag `alpha`）。该版本号当时未单独发布，内容已并入 **v0.18.0** 正式版；v0.19.0-alpha.0 这个号后来被 0.1.5 适配线复用（见上）。

- 🔗 **适配 DSH 0.1.2-alpha.5（npm 已发布，`alpha` dist-tag）**：CI 挂载门禁钉版、`dsh.plugin.json` engines 下限与 `@deepseek-ai/*` peer / devDependencies 基线升至 0.1.2-alpha.5（真机挂载冒烟 14/14 验证）。`dsh-client-locale` 上游停在 0.1.2-alpha.3 未发新版，其 peer 下限 / devDep 保持并天然兼容 alpha.5 运行时（`pnpm peers check` 零失配，无需新增提升传递 peer）。代码适配了 alpha.4 的兼容性标记改动——`Session.events` 属性移除，迁移到按需读 API `snapshotEvents()`（sidechat 转录 live 读、fork 继承、`jobs.output` 回放、subagent 活跃度共 8 处），新建线程 meta 中宿主已删的 `seedLength` 一并移除；alpha.4 其余变化（双向 `send_message`、自定义模型发现复用 Profile 请求头、`SessionSeq`/`SessionLogOffset` 强类型）与 alpha.5（升级启动修复）经核实不触及本插件其余表面。

### v0.18.1-alpha.0

> 🧪 **alpha 通道**：本版仅支持 **DSH 0.1.2-alpha.x**（peer 下限 `^0.1.2-alpha.3`，npm dist-tag `alpha`，安装 `dsh-better-sidebar@latest`）。该版本号未单独发布，内容已并入 **v0.18.0** 正式版。

- 🔗 **适配 DSH 0.1.2-alpha.3（npm 已发布，`alpha` dist-tag）**：CI 挂载门禁钉版、`dsh.plugin.json` engines 下限与 `@deepseek-ai/*` peer / devDependencies 基线升至 0.1.2-alpha.3（真机挂载冒烟 14/14 验证）。逐点核查了 alpha.2 → alpha.3 全部 117 个 commit：插件依赖的宿主契约（token 鉴权、斜杠 RPC、`MarkdownText` labels、`sidechat.events` 所依赖的事件流与持久化 API、`SettingsNamespaceInput`、`SUBAGENT_DESCRIPTOR_VERSION`（仍为 3）、`dsh-client-store`、profile 加载器、node-pty 钉版）均无变化，无需代码适配；alpha.3 的破坏性改动（`BeginSubmissionInput.mode` 必填、subagent 错误码改名 `attachment-invalid`、SQLite 持久化后端移除、投影 change feed 收紧为 identity-gated）经核实均不触及本插件。

### v0.18.0-alpha.0

> 🧪 **alpha 通道**：本版仅支持 **DSH 0.1.2-alpha.x**（peer 下限 `^0.1.2-alpha.2`，npm dist-tag `alpha`，安装 `dsh-better-sidebar@latest`）；不再支持 0.1.0-rc.8 ~ 0.1.1-rc.2——stable DSH 用户请用 v0.17.1（npm `latest`）。

- 🔗 **适配 DSH 0.1.2-alpha.2（npm 已发布，`alpha` dist-tag）**：CI 挂载门禁钉版与 `@deepseek-ai/*` devDependencies 基线升至 0.1.2-alpha.2（真机挂载冒烟 14/14 验证）。适配点：`dsh-settings` 移除运行时导出 `settingsNamespace`（命名空间改为编译期校验，宿主侧直接传常量）；`dsh-subagent` 描述符版本 2→3（由宿主包盖章，测试断言跟随 `SUBAGENT_DESCRIPTOR_VERSION` 常量）；`SessionEvent.ignorable` 恢复与 Remote 网关 `RemoteError` 封装经核实对本插件无破坏。
- 🐛 **修复 DSH 0.1.2-alpha.1+ 上侧边对话转录空白**：转录轮询此前仍走 alpha.1 已移除的 `ctx.connection.api`（错误被静默吞掉，tab 永远渲染空转录），现改由插件自有 `sidechat.events` 路由供给（活线程读内存事件日志、冷线程读会话持久化，`afterSeq` 增量拉取，[sidechat-routes.ts](./src/sidechat-routes.ts)）。
- 🧹 **删除对 0.1.1-rc.x 及更早的兼容层**：e2e 宿主 RPC 从点分/斜杠双方言收敛为斜杠单方言（token URL 必选，[host-protocol.ts](./tests/e2e/host-protocol.ts)）；`MarkdownText` labels 收敛为嵌套单形状（[markdown-labels.tsx](./src/client/markdown-labels.tsx)，不再双 prop 名）；peerDependencies / devDependencies / `dsh.client.inject` / chunk externals 白名单四处同步清除已消亡的 `@deepseek-ai/dsh-client-runtime`。

### v0.17.1

- 🔗 **DSH 0.1.2-alpha.1 适配（双版本兼容）**：DSH 0.1.2-alpha.1 的 Remote gateway、一次性 token 浏览器鉴权与 `MarkdownText` labels 契约变更已全量适配，插件在 0.1.0-rc.8 ~ 0.1.1-rc.2 与 0.1.2-alpha.1 上一致工作（后者经 GitHub tag 源码构建的真机挂载冒烟 14/14 验证；alpha.1 至今未发布 npm，CI 钉版已在 v0.18.0-alpha.0 升至 npm 发布的 0.1.2-alpha.2）。要点：`MarkdownText` 四个渲染点统一改走双形状 labels helper（[markdown-labels.tsx](./src/client/markdown-labels.tsx)），修复 alpha.1 上 markdown/mermaid 预览的 `reading 'code'` 崩溃；e2e 冒烟双协议化（token URL 换 cookie、`/api` 斜杠端点 + 按参数名包装 args，[tests/e2e/host-protocol.ts](./tests/e2e/host-protocol.ts)）；移除已在 0.1.2-alpha.1 消亡的 `@deepseek-ai/dsh-client-runtime` peer

### v0.16.1

自 v0.16.0 以来的全部更改：

**🐛 修复**

- 🧊 **Git 面板卡死 + 重启死循环**（[#376](https://github.com/omdsh-dev/DSH-better-sidebar/pull/376)，修复 [#369](https://github.com/omdsh-dev/DSH-better-sidebar/issues/369)）：开启「源代码管理」面板可能整页冻结、重启后自动恢复冻结状态且无法退出——三层无上限操作叠加所致，现已全部设界：**① status 截断**——`git status --untracked-files=all` 响应上限 2000 条（超限置 `truncated`，面板显示截断提示，对齐 `fs.read` 截断语义；worktree 变更计数同步有界），海量未跟踪文件不再冻结浏览器主线程；**② 仓库发现限界**——cwd 非 Git 仓库（如家目录）时不再对每个可见子目录串行无界探测：探测超时 30s→5s、子目录探测上限 200 个、并发请求共享同一次扫描并按 60s TTL 缓存，家目录不再引发 `git rev-parse` 进程风暴；**③ 重置逃生通道**——带 `?dsh-sidebar-reset` 打开页面即丢弃持久化布局（含共享宽度）从默认布局启动，即使原页面已卡死也能自救，移除参数后恢复持久化；`statusTruncated` 文案同步全部 19 个词典

### v0.16.0

自 v0.15.2 以来的全部更改：

**✨ 新功能**

- 🪟 **自由窗口**（[#354](https://github.com/omdsh-dev/DSH-better-sidebar/pull/354)）：把标签栏的任意 tab（内置或插件注册）**拖到主会话区域**——会话列出现虚线提示浮层，松开即成为悬浮窗口（默认 390×780，手机竖屏比例，创建时按视口钳制后居中于松点）；窗口支持头部拖动移动、右下角 SE 缩放（≥320×200）、点击任意处置顶、头部右键「回到侧边栏 / 关闭」、X 走 `closeTab` 正常关闭生命周期（释放终端等）；拖到侧边栏 pane 上时该 pane 高亮、松开即**停靠**合并回该 pane；`floats` 随会话持久化（刷新原样恢复，宽容 sanitize + 几何钳入视口）；服务语义：`features` 新增 `'floatWindows'`——`openTab` 的 dedupe/id 聚焦命中浮动 tab = **置顶窗口**（不重复开、不展开面板），`closeTab` / `activateTab` 对浮窗正常关窗 / 置顶并照常触发回调，浮窗内 tab `visible` 恒 true，agent 终端 reconcile 覆盖浮窗；tab 内容复用常规渲染、插件 tab 与 pane 完全同契约；附带文件二级页面 8px 网格间距规整（[设计文档](docs/plans/2026-08-23-free-window-design.md)）
- 📂 **模型主动打开（`sidebar_open` 工具）**（[#353](https://github.com/omdsh-dev/DSH-better-sidebar/pull/353)）：侧边栏新增全局设置 `agentOpenTools`（**默认关闭**），开启后向模型注入**一个**工具——模型可在调用方会话的侧边栏打开本地**文件**（editor tab，按 path 去重）、**文件夹**（全窗树窗口，以该目录为根，`meta.dir`）与 **HTTP(S) 网页**（browser tab，URL 预填）；关闭设置即注销工具并清空未投递队列，已打开 tab 保留；非激活会话的打开排队、下次可见时重放（`/sidebar/ws/agent-opens` 推送，同一 trust fence）；无新增公共 API、不改变 `BetterSidebarService`（[设计文档](docs/plans/2026-08-23-agent-open-tools-design.md)）
- 📝 **Markdown README 级内嵌 HTML + 目录大纲（TOC）**（[#360](https://github.com/omdsh-dev/DSH-better-sidebar/pull/360)）：Markdown 预览现在真实渲染**块级内嵌 HTML**——徽章墙 `<div align=center>`、`<details>` 折叠块内嵌 markdown、表格单元格 `<br/>`/`<sub>`/`<img>`、`<video>`/`<picture>` 全部经 DOMPurify 白名单消毒（`<script>` 等活性内容剥除、`<a>` 强制 `_blank rel=noopener`），本地媒体 src 重写为会话媒体路由；≥3 标题出现浮动**目录大纲**按钮，点击平滑滚动并自动展开折叠 `<details>`，HTML 段内标题同样收录；渲染器仍是宿主 `MarkdownText`（shiki / KaTeX / GFM 保留），纯 markdown（零 HTML）文档走原路径零回归（[设计文档](docs/plans/2026-08-24-markdown-html-toc-design.md)）
- 🌏 **第三语言覆盖（19 语言）**（[#339](https://github.com/omdsh-dev/DSH-better-sidebar/pull/339)）：接入可选 peer `@huanlin/dsh-plugin-better-locale`——ja / de / fr / pt / ko / ar / hi / id / tr / vi / th / ru / it / nl / sv / pl / zh-HK / zh-TW / zh-MO 全量词典（每种约 340 keys）；覆盖**借用 DSH 英文槽位**（DSH active=en 时生效，zh 下完全惰性、界面不混语言）；19 语言词典同时注册进 better-locale，外部 `ctx.locale.lookup('betterSidebar', key)` 调用者同样可拿覆盖文本；未安装时 `ctx.get('betterLocale')` 为 undefined、整段 no-op，zh/en 行为不变
- 🌿 **Git 多仓库选择 + linked worktree 变更发现**（[#326](https://github.com/omdsh-dev/DSH-better-sidebar/pull/326) [#285](https://github.com/omdsh-dev/DSH-better-sidebar/pull/285)）：会话 cwd 是工作区容器（非 Git 仓库）时自动发现直接子仓库并显示**仓库选择器**——status / 分支 / 历史 / diff / 暂存 / 提交 / 还原 / cherry-pick / 文件打开全部按所选仓库线程化；linked worktree 的变更发现与按工作树操作（含延迟分页响应的事务一致性），并拒绝过期 / 可修剪的 worktree 命令目标、对单库存取失败降级
- 🖥️ **浏览器本地回环允许清单**（[#365](https://github.com/omdsh-dev/DSH-better-sidebar/pull/365)）：新增侧边卡设置 `browserAllowedLoopback`（逗号分隔 host 或 host:port；裸 host 匹配任意端口、带有端口精确匹配）——显式信任的本地开发服务器（如 Vite）可导航，并额外获得 iframe `allow-same-origin` 令牌（模块 / HMR / fetch 管线需要真实 origin，否则白屏）；页面相对 GUI 与其他站点仍是跨源；服务端 `browser.probe` 镜像同一允许清单，本地服务器不再被误拒
- 📝 **编辑器 Vue + 28 种 legacy 语言语法高亮**（[#202](https://github.com/omdsh-dev/DSH-better-sidebar/pull/202)）：`.vue` 映射 `@codemirror/lang-vue`（template / script / style 按 `lang` 属性分派、`<style lang="scss">` 预处理器）；零新依赖用 legacy-modes 补齐 scss/sass/less/stylus/ruby/lua/perl/r/dart/scala/groovy/powershell/diff/protobuf/cmake/pug/tcl/haskell/clojure/erlang/julia/pascal/vb/vhdl/stex/objectivecpp；语言工厂抛错降级纯文本（console.warn），不再炸编辑器；`.v` / `.m` 跨语言歧义故意不映射
- 🔄 **编辑器预览刷新三件套**（[#215](https://github.com/omdsh-dev/DSH-better-sidebar/pull/215) [#228](https://github.com/omdsh-dev/DSH-better-sidebar/pull/228)，修复 [#167](https://github.com/omdsh-dev/DSH-better-sidebar/issues/167)）：文本预览新增**手动刷新**按钮；编辑保存后切回预览自动重载（dirty 时抑制，草稿不丢）；预览模式下保存成功边沿自动重载；移除自动轮询与 `fs.stat` 版本端点（后台 API 零流量）
- 🖼️ **Markdown 本地 / 相对图片**（[#292](https://github.com/omdsh-dev/DSH-better-sidebar/pull/292)）：`![alt](./img.png)`、`/cwd/img.png` 与引用式 `[id]: url` 目标重写为 `/sidebar/file` 媒体 URL（会话 cwd 边界不变）——预览不再只显示 alt 文本
- ➕ **推荐插件目录新增 ego-browser**（[#340](https://github.com/omdsh-dev/DSH-better-sidebar/pull/340)）：`@dsh-external/ego-browser` Agent 浏览器 Tab（会话侧边栏自动注册本机浏览器页，无 better-sidebar 时回退浮动浮窗）；描述词典 19 语言补全（[#371](https://github.com/omdsh-dev/DSH-better-sidebar/pull/371)）

**🐛 修复**

- 🛒 **DSH 市场受管安装兼容**（[#338](https://github.com/omdsh-dev/DSH-better-sidebar/pull/338)）：移除 `peerDependencies` 里的公开版 `cordis`（市场预览硬拒依赖字段出现 `cordis`，optional 无效）——npm 包满足 [dsh-community-market 安装规范](https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/dsh-community-market/docs/install-and-uninstall.zh.md)，dshfind / 1024Store 目录里的条目重新获得 `repository_backlink` 验证目标，可直接从 Desktop 市场受管安装
- 🔤 **类型基底迁移到 `@deepseek-ai/cordis`**（[#338](https://github.com/omdsh-dev/DSH-better-sidebar/pull/338)）：`Context` = 真实 vendored cordis Context 与结构化服务面的**交集**，`ctx.betterSidebar` 类型合并改挂 `@deepseek-ai/cordis`，公开版 cordis 不再被依赖。**消费者迁移**：`import type { Context } from 'cordis'` 改为 `import type { Context } from '@deepseek-ai/cordis'`（`import type {} from 'dsh-better-sidebar'` 的类型合并方式不变）；未使用该导入的插件无影响
- 🧩 **插件树内 `ctx.betterSidebar` 读取全面修复**（[#357](https://github.com/omdsh-dev/DSH-better-sidebar/pull/357)，修复 [#356](https://github.com/omdsh-dev/DSH-better-sidebar/issues/356)）：npm 安装的 DSH 0.1.1-rc.x（web bundle）下侧边栏页面每次加载即崩（`cannot get property "betterSidebar" without inject`）——26 处内部直读 `ctx.betterSidebar` 改走 `ctx.get('betterSidebar')`（root reflect store 解析，不受 fiber 链影响）；外部消费者 `inject: ['betterSidebar'] + ctx.betterSidebar` 契约不变
- 🔐 **文件 API 会话工作区边界**（[#345](https://github.com/omdsh-dev/DSH-better-sidebar/pull/345)，修复 [#328](https://github.com/omdsh-dev/DSH-better-sidebar/issues/328)）：`fs.tree / fs.read / fs.write` 的 workspace 越界访问修复；媒体、HTML 预览与上传统一 real-path 符号链接校验；新增绝对路径 / 符号链接 / 上传 / 嵌套 Git 会话回归测试
- 🪟 **面板宿主层级与视口裁剪**（[#330](https://github.com/omdsh-dev/DSH-better-sidebar/pull/330) [#278](https://github.com/omdsh-dev/DSH-better-sidebar/pull/278)，修复 [#277](https://github.com/omdsh-dev/DSH-better-sidebar/issues/277)）：面板宿主层 z-index 40→25——低于 DSH cordis 动态插件面板 30，工作台不再遮挡 cordis 清单 / 审批面（AppFrame 20 之上、100+ 浮层之下）；宿主 `overflow: hidden` 裁剪视口边缘，收起的面板不再把文档撑出双向滚动（实测 `scrollWidth` 2289→1672 / `scrollHeight` 1280→1032，任意皮肤）
- 📐 **布局推挤加固**（[#310](https://github.com/omdsh-dev/DSH-better-sidebar/pull/310) [#130](https://github.com/omdsh-dev/DSH-better-sidebar/pull/130) [#180](https://github.com/omdsh-dev/DSH-better-sidebar/pull/180)）：对话列补 `min-height: 0` + `overflow: hidden` + `overflow-wrap: anywhere`（长不可断 URL / OAuth 链接不再把 composer 与左侧设置按钮挤出视口）；layout-push effect 拆「仅设置 + 仅卸载移除」并按 `panelOpen` 门控宽度 push——右栏关闭时拖底部高度不再挤压对话区、松手瞬间不再整页右铺再回弹；`useLayoutEffect` 消除跨 paint 全宽闪帧；松手 flush 最终帧 + `centerRect.right` 同步提交；底部高度按 `viewportHeight - PANEL_MIN` 封顶；拖拽手柄拖动中不再高亮
- 📱 **移动端无会话状态说明 + 1px 溢出修复**（[#254](https://github.com/omdsh-dev/DSH-better-sidebar/pull/254)）：无会话时开关改用 `aria-disabled` 保持不可执行语义、同时允许触摸 / 键盘聚焦显示「选择一个会话以使用侧边栏」提示；panel 改 `border-box`——移动端 `100vw` 含左边框，不再产生 1px 横向溢出
- 📏 **侧边栏宽度跨会话共享**（[#36](https://github.com/omdsh-dev/DSH-better-sidebar/pull/36)）：面板宽度是布局偏好而非会话内容——「最后一次拖拽胜出」写入全局 `dsh-sidebar:v1:width`，缓存会话切换与新建会话即时跟随；无全局键（首次运行 / 旧会话）时行为逐字节不变
- 🧹 **会话删除立即关闭该会话终端**（[#130](https://github.com/omdsh-dev/DSH-better-sidebar/pull/130)）：新增 `PtyManager.closeSession()` + 订阅 DSH `session/disposed`——删除会话不再等 30s 重连宽限到期（agent 终端由 agent 生命周期管理，不受影响）
- 🔍 **文件名搜索跳过噪声目录**（[#342](https://github.com/omdsh-dev/DSH-better-sidebar/pull/342)）：`node_modules` / `.pnpm-store` / `.yarn` / `.turbo` / `.next` / `dist` / `build` / `coverage` 等黑名单（小写不敏感，`.git` 仍跳）——超大依赖树不再耗尽 10 万访问预算提前 `truncated`，`docs/` 等后序目录里的真实文件能搜到；不引入 `.gitignore` 语义，保持「文件名查找」
- 📝 **mermaid 全局错误渲染抑制**（[#341](https://github.com/omdsh-dev/DSH-better-sidebar/pull/341)）：开启 `suppressErrorRendering`——非法图表不再把大错误 SVG 注入 `document.body`；组件级错误回退与源码展示保留
- 🖥️ **终端 Nerd Font 图标字体回退**（[#190](https://github.com/omdsh-dev/DSH-better-sidebar/pull/190)）：starship / powerlevel10k 提示符的补充平面 PUA 图标（Nerd Fonts v3 Material 图标集）不再显示豆腐块——`withIconFontFallbacks()` 为胜出的基础字体追加 Nerd Font 图标族（插入首个通用族之前、按族名去重、过滤 CSS 全局关键字、不列彩色 emoji 字体）
- 🌐 **HTML 预览 UTF-8 声明**（[#193](https://github.com/omdsh-dev/DSH-better-sidebar/pull/193)，修复 [#170](https://github.com/omdsh-dev/DSH-better-sidebar/issues/170)）：`/sidebar/html` 响应带 `charset=utf-8`（无 `<meta charset>` 的中文片段不再乱码），保留原始文件字节
- 🧪 **trust-fence Origin 改按 hostname 比较**（[#182](https://github.com/omdsh-dev/DSH-better-sidebar/pull/182)）：Edge 151 把非默认端口 loopback 页面的 Origin 序列化为无端口形式——`http://127.0.0.1` 对 `Host: 127.0.0.1:3080` 不再 403（对齐 DSH 官方网关栅栏）；不同 hostname / opaque null origin 仍拒绝
- 🪟 **「在文件夹中显示」改为资源管理器揭示**（[#94](https://github.com/omdsh-dev/DSH-better-sidebar/pull/94)）：不再把目录当文件开进编辑器（`"..." is a directory`）——`revealInExplorer` 切到资源管理器 tab、面板折叠时自动展开、展开父目录并高亮滚动到本轮产出文件；产物行数据改读引擎 Turn deliverable（与 ui-deliverables 同源）
- 🖱️ **面板拖动布局闪烁**（[#180](https://github.com/omdsh-dev/DSH-better-sidebar/pull/180)）：右侧栏关闭时拖底部高度不再左移挤压对话区；松手瞬间不再整体右铺再回弹
- 🖥️ **PowerShell 安装脚本修复**（[#47](https://github.com/omdsh-dev/DSH-better-sidebar/pull/47)）：远程入口统一为「下载脚本 → 移除 UTF-8 BOM → 内存执行」，`-Version` / `-DryRun` 参数在 Windows PowerShell 5.1 下恢复生效（BOM 解析不再吃掉首行 `param(...)`）；安装前校验 `pnpm --version`（主版本 <10 时明确报错并以退出码 1 结束，不再写一半 profile）
- 🔄 **浏览器嵌入探测 GET 兜底**（[#69](https://github.com/omdsh-dev/DSH-better-sidebar/pull/69)）：HEAD 响应同时缺 CSP 与 X-Frame-Options 时回退 GET 重试一次——阿里云百炼等只在 GET 回头发嵌入策略的站点不再显示误导性「拒绝连接请求」，而是正确显示「该站点拒绝嵌入」面板 + 「在浏览器中打开」
- 🔧 **git 源安装修复 `unrun` devDependency**（[#336](https://github.com/omdsh-dev/DSH-better-sidebar/pull/336)）：tsdown 0.22 经 `unrun` 加载配置而 pnpm 11 不自动装 peer——git-hosted 安装的 `prepare` 不再报 `Failed to import module "unrun"`（npm tarball 不受影响）
- 🍃 **`ctx.effect` 严格化顺手修了 4 处**：拦截注册失败时 effect 体返回 `undefined` 改为 no-op disposer（vendored cordis 的 effect 契约要求返回 disposer，返回 `undefined` 属非法形状）

### v0.15.2

自 v0.15.1 以来的全部更改：

**✨ 新功能**

- 🗂️ **文件树「在应用中打开」子菜单**（[#334](https://github.com/omdsh-dev/DSH-better-sidebar/pull/334)）：文件树右键菜单新增「在应用中打开 >」子菜单——内置打开方式（资源管理器显示/选中、VS Code、Cursor、Zed），每行右侧图钉可固定为右键菜单顶层直达项（再点取消）；配置可选 SSH host 后 VSCode 系条目改用 `vscode-remote/ssh-remote+<host>/<path>` 协议打开，本地专用条目自动隐藏；支持自定义编辑器（名称 + URL 模板 `{path}` + 是否 VSCode 系，配置入口在 Files 卡片齿轮弹窗）。打开动作经新宿主路由 `POST /sidebar/api/open.external`（argv 数组 spawn，无 shell 注入）（[设计文档](docs/plans/2026-08-22-open-with-menu-design.md)）
- 📑 **Tab 右键菜单**（[#331](https://github.com/omdsh-dev/DSH-better-sidebar/pull/331)）：页签右键提供「关闭 / 关闭其他页签 / 关闭左侧页签 / 关闭右侧页签」，作用范围为当前 pane（标签组），无可关对象时置灰；仅打开菜单、不切换激活页签；批量关闭逐条走既有 `onClose` 路径，生命周期完整
- 📄 **Diff 文件默认折叠**（[#270](https://github.com/omdsh-dev/DSH-better-sidebar/pull/270)）：改动文件头部改为可访问的展开/折叠控件；识别出的源文件默认展开，测试 / 文档 / 生成文件 / lockfile 与未知类型默认折叠；保留现有 500 行上限
- 📖 **README 更新**：特性巡礼改为表格展示（每行两张图，节省空间）；社区补全微信群 / QQ 群二维码（[#325](https://github.com/omdsh-dev/DSH-better-sidebar/pull/325)，QQ 群 577011007）

**🐛 修复**

- 🪟 **空分栏清理**（[#268](https://github.com/omdsh-dev/DSH-better-sidebar/pull/268)）：持久化的 split pane 在临时 diff tab 被清理后遗留全尺寸空分栏——`sanitizeState` 现在同时修剪空的 split leaf，并修复修剪后的失效激活 pane 指针；整个工作台为空时保留唯一空 pane
- 🖥️ **Windows 下隐藏 Git 子进程窗口**（[#301](https://github.com/omdsh-dev/DSH-better-sidebar/pull/301)，关闭 [#124](https://github.com/omdsh-dev/DSH-better-sidebar/issues/124)）：`runGit()` 统一加 `windowsHide: true`，仓库状态轮询与操作不再闪现控制台窗口（其他平台行为不变）
- 📁 **未跟踪文件夹内文件差异**（[#242](https://github.com/omdsh-dev/DSH-better-sidebar/pull/242)）：`git status` 从 `--untracked-files=normal` 切换为 `--untracked-files=all`——新文件夹内每个文件独立成行、可正常加载差异（修正 `fs.read` 报 "is a directory"，与 VSCode 默认行为一致）
- ⚡ **开关/拖拽每帧 React 重渲染消除**（关闭 [#315](https://github.com/omdsh-dev/DSH-better-sidebar/issues/315)）：centerRect 改 ref + 底栏 DOM 直写（零 React 渲染）；TabContent memo（显式比较器）；新增 frame-batcher 对 Divider/dock 拖拽按帧合并；拖拽期跳过无意义 locate。4x CPU 节流 A/B：开关 >17ms 帧 collapse 19→6 / expand 24→4~6，p95 21ms→15ms；拖拽不变（非回归）

### v0.15.1

自 v0.15.0 以来的全部更改：

**✨ 新功能**

- 💬 **侧边对话 Codex 风格转录重构**（[#314](https://github.com/omdsh-dev/DSH-better-sidebar/pull/314)）：转录改为**折叠行**——工具调用 / 思考 / 上下文注入统一为安静的单行 chrome（chevron + 标签 + 单行参数摘要，展开为 hairline 缩进正文，无卡片无填充），流式标签与创建 shimmer（shimmer = 生成中）、失败工具 danger、`prefers-reduced-motion` 停帧；**首条问题不再被边界提示吞掉**——上下文注入与首问拆分交付（边界 + 快照经 `agent.inject` 排队、问题唤醒驱动），转录把注入映射为可折叠注入行、真实用户消息（**含首问**）渲染为用户气泡，旧线程的首问同样拆分为独立气泡
- 📖 **README 重写**：功能导览（逐特性实机截图）、用户视角 DSH 兼容徽章、简化安装流程（`add` → `approve-builds` → `add`、node-pty 安全构建、粘贴到 DSH 安装提示）、插件生态 28+ 与分类折叠展示

**🐛 修复**

- 🖥️ **终端跨会话切换保活**（[#323](https://github.com/omdsh-dev/DSH-better-sidebar/pull/323)）：切到其他会话不再被当作瞬时掉线——客户端卸载时发送 `park` 控制帧，主机跳过 30s 重连宽限倒计时；切回会话（`open()` 取消 parked）或显式关闭恢复正常生命周期；agent 终端保持无限期存活
- 📂 **文件树上传遮罩不再拦截 Tab 拖拽**（[#317](https://github.com/omdsh-dev/DSH-better-sidebar/pull/317)）：拖拽 Tab（重排 / 跨 pane split）经过资源管理器时不再弹上传遮罩、不吞事件——统一按 `dataTransfer.types` 含 `Files` 门控（与面板宿主 shield 一致），Tab 正常落下；OS 文件拖拽行为不变
- 💬 **子代理自动展开去抖**（[#314](https://github.com/omdsh-dev/DSH-better-sidebar/pull/314)）：Side Chat 线程创建不再误弹任务页——0→N 触发 500ms 重臂并对实时快照按原基线重评估，标题过滤器识别线程后才放行；真实子代理依然自动激活任务页（宽屏展开侧边栏，窄屏只准备 Tab、不强制展开抽屉）

### v0.15.0

自 v0.14.0 以来的全部更改：

**✨ 新功能**

- 💬 **侧边对话(beta) Tab**（[#286](https://github.com/omdsh-dev/DSH-better-sidebar/pull/286)）：Codex 风格的侧边线程，**每个对话一个独立 Tab**——子会话继承主会话完整上下文（已完成回合 + 未回答消息 + 进行中回合的 assistant 输出与工具调用，以「interrupted」冻结标记诚实继承）；同组合创建（同 preset / provider / model）复用前缀输入缓存；线程对主会话列表不可见、零子代理目录噪音；线程内可持续追问（重启后自动冷恢复）；一键「保存为新会话」提升为顶层会话（[设计文档](docs/plans/2026-08-20-sidechat-tab-design.md)）
- 📤 **文件窗口上传**（[#239](https://github.com/omdsh-dev/DSH-better-sidebar/pull/239)）：头部「上传文件 / 上传文件夹」按钮 + 拖放上传（拖到树区 = 工作区根，目录行 = 进该目录，文件行 = 进其所在目录，对齐 VSCode）；上传时全屏模糊进度弹层（文件级进度 + 取消 / Esc）；上传中按钮禁用、成功后文件树自动刷新
- 🧩 **桌面兼容四选项**（[#284](https://github.com/omdsh-dev/DSH-better-sidebar/pull/284)）：位置兼容模式改为**主行下拉**——**自动检测**（默认，保守：仅使用标准的 Window Controls Overlay 几何，32/36px 等各壳差异自动跟随、最大化/还原实时更新，网页环境零修改）/ **DSH官方Web**（显式零适配）/ **壳兼容方案**（内置预设，手动启用；只收录 issue/PR 中出现过且 100+ star 的壳，命中环境带「已检测」提示）/ **自定义方案**（自定义 CSS + 下移距离）。旧版本已有兼容配置的用户自动落到自定义方案；交互控件统一退出桌面拖拽区（`no-drag`）；底栏推挤锚点复合选择器双保险（`[data-pane]` 与 `:has(> [data-slot])`）
- 🎛️ **设置页 UI/UX 现代化**（[#300](https://github.com/omdsh-dev/DSH-better-sidebar/pull/300)）：侧边卡片二级设置入口改为卡片底部「功能设置」设置条（替代右下角隐形齿轮，可发现性提升）；协调双色启用态（brand 激活强调 + success 绿勾选徽标）；全部颜色仍为 `--dsw-alias-*` 令牌派生，皮肤体系自动跟随
- ➕ **推荐插件目录新增**：`dsh-docs-panel` 全局文档面板（[#230](https://github.com/omdsh-dev/DSH-better-sidebar/pull/230)）、`dsh-flowglass`（[#261](https://github.com/omdsh-dev/DSH-better-sidebar/pull/261)）、`dsh-git-forge` 与 `dsh-ssh-tunnel`（[#204](https://github.com/omdsh-dev/DSH-better-sidebar/pull/204)）、`dsh-turn-review`（[#102](https://github.com/omdsh-dev/DSH-better-sidebar/pull/102)）

**🐛 修复**

- ⚡ **子代理页实时预览批量接口**（[#298](https://github.com/omdsh-dev/DSH-better-sidebar/pull/298)）：旧实现每个 running 子代理独立轮询 `subagents.history`，host 侧每次触发全量子代理枚举形成 O(N²) 放大、多子代理并发时页面卡顿——改为单个批量接口 `subagents.live`（一次枚举整棵子代理树）+ 客户端单轮询、单在途请求；展示逻辑与文案不变
- 🖱️ **拖拽中断 / 快速释放不再回滚**（[#249](https://github.com/omdsh-dev/DSH-better-sidebar/pull/249)，关闭 [#247](https://github.com/omdsh-dev/DSH-better-sidebar/issues/247) [#248](https://github.com/omdsh-dev/DSH-better-sidebar/issues/248)）：中断 / 快速释放提交最后已知位置；HMR 后中心列重定位兜底（修复热更新后底栏空白）
- 📐 **推挤变量挂载期持续有效**（[#259](https://github.com/omdsh-dev/DSH-better-sidebar/pull/259)，修复 [#258](https://github.com/omdsh-dev/DSH-better-sidebar/issues/258)）：拖拽松手后底边栏不再闪全宽
- 🔧 **适配 DSH 0.1.1-rc.1 / rc.2（@next）**（[#297](https://github.com/omdsh-dev/DSH-better-sidebar/pull/297) [#305](https://github.com/omdsh-dev/DSH-better-sidebar/pull/305)）：无代码逻辑改动
- 🔒 **上传链路安全加固**（[#239](https://github.com/omdsh-dev/DSH-better-sidebar/pull/239)）：`relativePath` 空段 / 绝对路径显式拒绝；临时文件唯一命名（并发上传互不干扰、崩溃不阻塞）；写流错误监听（磁盘失败不崩溃进程）；客户端错误码与服务端统一、413 本地化
- 🔐 **文件 API workspace 边界加固**（[#328](https://github.com/omdsh-dev/DSH-better-sidebar/issues/328)）：`fs.tree/read/write`、媒体、HTML 预览和上传统一按真实路径限制在会话 workspace 内，拒绝越界绝对路径与外链符号链接

### v0.14.0

> ⚠️ 本版起需要 DSH ≥ 0.1.0-rc.8。自 v0.13.1 以来的全部更改：

**✨ 新功能**

- 🖼️ **统一面板宿主注入重构**（[#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)）：面板/开关簇迁入 `[data-dsh-panel-host]` 固定含块层（`fixed inset-0 z-40`），免疫桌面套壳中间层 transform 对 fixed 含块的劫持；挂载自检（页面级 transform → `data-dsh-panel-host-degraded` 降级同步，按未修正几何判定、祖先变换消失才退出）；推挤锚点改 `#root [data-dsh-frame] > [data-pane="conversation"]` + `#root` calc 宽度防桌面壳加性溢出；chunk 激活重验证（HEAD+ETag 保留未变 chunk，5s 超时兜底 fail-open）；`visualViewport` 键盘 inset + `env(safe-area-inset-*)` 移动端适配
- 📂 **文件打开方式默认独立**（[#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)）：`editorExplorer` 默认从「合并」改为「独立」——新会话树点击 / 打开文件按路径**新开**文件 tab，无路径窗口即纯资源管理器；合并模式保留为可选手动开启
- 🖥️ **终端 shell / shellArgs 设置页可配**（[#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)）：终端卡齿轮二级页面新增「Shell 路径」「Shell 参数」两行配置（此前只能通过 `cordis.patch.yml` 配置）——设置页写入后对**之后打开的** UI 终端与模型终端（`terminal_create`）即时生效；留空保持 yaml → `$SHELL` / 登录 shell / `powershell.exe` 的既有解析顺序
- 🏷️ **设置页版本徽标**（[#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)）：侧边卡片设置页顶部新增 `DSH-better-sidebar v0.14.0` 身份徽标（版本与服务实例同步，由测试守护）
- 🔍 **添加插件目录搜索 / 分组 / 独立滚动**（[#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)）：为插件生态增长做准备——目录列表顶部加实时搜索（按名称 / id / 描述过滤），条目支持可选 `category` 分组渲染，列表独立滚动（弹窗不再随条目数无限增长）

**🐛 修复**

- 🧩 **rc.8 模块系统迁移**（[#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)）：rc.8 不再暴露 `window.__DSH_MODULES__` 页面全局（改由 `ctx.modules` 服务提供），懒加载 chunk 的外部依赖解析全面失效——client 注入 `modules` 服务 + 插件自有全局共享给 chunk 副本（终端 / 编辑器 / Mermaid 恢复正常按需加载）
- 🧩 **chunk 重验证屏障健壮性**（[#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)）：HEAD 重验证加 5s 超时兜底（路由挂起时 fail-open 重取，屏障不再可能无限期阻塞懒加载）；`resetChunks` 清挂起的重验证屏障
- 🖱️ **拖拽健壮性**（[#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)）：快速释放（浏览器合并 / 丢失 pointermove 突发）时提交最后已知拖动位置而非回退；`pointercancel` / 捕获丢失中断同样保留拖动结果；提交后立即重测中心列（消除底栏宽度中间帧抖动）；HMR 重激活后中心列重定位兜底（`<html>` 样式观察 + 底栏打开重测），修复热更新后底栏空白 / 输入框位移

### v0.13.1

**✨ 新功能**

- 📊 **Markdown 预览安全渲染 Mermaid 图表**（[#164](https://github.com/omdsh-dev/DSH-better-sidebar/pull/164)）：预览的 md 含 mermaid fence 时按需下发 `client-mermaid.js` chunk（~7MB，无 mermaid 文件零加载）；纵深防御渲染——`securityLevel: 'strict'` + `htmlLabels: false`（节点文字走真实 SVG `<text>`）+ SVG 注入前二次清洗（删 `foreignObject`/`script`/外来 HTML 元素、剥 `@*`/`on*`/`href` 属性）；点击图表在弹窗中放大（滚轮以鼠标为中心缩放、拖拽平移、工具栏与快捷键），深浅色跟随重渲、解析失败回退原码
- 🖥️ **终端 shell 与 shellArgs 可配置**（[#125](https://github.com/omdsh-dev/DSH-better-sidebar/pull/125)）：`cordis.patch.yml` 的 `better-sidebar.config` 可指定 `shell` / `shellArgs`（`shellArgs` 非空时完全替换默认参数；未配置维持自动解析 `$SHELL` / 登录 shell / `powershell.exe` 原行为），UI 终端与 agent 终端（`terminal_create`）同时生效；终端 tab 标题改用 shell 名（bash / zsh / powershell），内部标识改 UUID，同 shell 可开多个终端

**🐛 修复**

- 🔗 **聚合双挂载自动退让**（[#200](https://github.com/omdsh-dev/DSH-better-sidebar/pull/200)）：聚合包（如 dsh-web-ui-all）以独立条目 id 挂载同包时，`cordis.patch.yml` 的守卫表达式自动禁用自身 `better-sidebar` 行，不再重复注册 `/sidebar/api` 导致 `duplicate prefix route` 整个插件树启动失败（`dsh web` 崩溃）；独立安装行为不变
- 🔧 **适配 DSH 0.1.0-rc.7**（[#207](https://github.com/omdsh-dev/DSH-better-sidebar/pull/207)，修复 [#206](https://github.com/omdsh-dev/DSH-better-sidebar/issues/206)）：修复 DSH 主框架升至 rc.7 后选模型 / 发消息报 `agent-presets: refusing to compose an unscoped context` 的问题

### v0.13.0

**✨ 新功能**

- 📁 **文件窗口与资源管理器二合一**（[#151](https://github.com/omdsh-dev/DSH-better-sidebar/pull/151)）：新 `editorExplorer` 设置（编辑器卡齿轮）——文件 tab 增加路径输入框头部 + 可开关的右侧停靠文件树（每 tab 记忆展开/宽度，左缘拖拽调宽 160~480px，全局文件名搜索走 host `fs.search` 路由，预算封顶并跳过 `.git` / 符号链接目录）；独立模式（默认）树点击 / 输入框 Enter **按路径新开**文件 tab，合并模式**原地切换**当前 tab；新会话默认 seed 空文件窗口（`Files`）替代 explorer tab，无路径窗口在独立模式为纯资源管理器、合并模式为带 chrome 的空文件窗口；树右键提供「在新 Tab 中打开」「在侧边打开」（split）
- 🎛️ **声明式设置 select 行**（[#151](https://github.com/omdsh-dev/DSH-better-sidebar/pull/151)）：设置项新增 `type: 'select'`（`options` 支持 value/title/desc/icon，`multi` 多选存数组）；带图标的选项渲染大图标选项卡、收起态同样显示图标；`editorExplorer` 改为图标化下拉（合并 / 独立）；能力清单新增 `settingSelect`
- 🔀 **与 dsh-web-ui 家族右侧面板互斥**（[#181](https://github.com/omdsh-dev/DSH-better-sidebar/pull/181)）：读取 `aionui-panel` 设置命名空间的提供方选择——当选择「使用 aionui-panel」时，整个 better-sidebar（右侧栏 / 底部面板 / 浮动入口 / 各类接管）不再挂载；选择 DSH-better-sidebar（或未安装 aionui）时正常。设置页保存后实时生效（settings-document 推送），无需刷新

### v0.12.3

**✨ 新功能**

- 🎨 **皮肤兼容（令牌驱动）**：全面消费 DSH 设计令牌，与 dsh-web-ui 皮肤中心 10 款皮肤兼容，换肤自动跟随；终端/编辑器表面在透明/半透明玻璃值下回退不透明底色，文字不叠在皮肤背景上（[#110](https://github.com/omdsh-dev/DSH-better-sidebar/pull/110)，修复 #106 #105 #90 #60，附带 #52 #57 #92）
- 🗂️ **统一路径处理**：UNC 路径 / 软链接分类（目录软链接可展开、失效链接标红）、HTML 路由平台守卫（[#134](https://github.com/omdsh-dev/DSH-better-sidebar/pull/134)，#65 #67 #43 #79 #115）
- 🖥️ **终端 shell 可配置**：设置项自定义 shell，Windows 自动探测 pwsh（[#95](https://github.com/omdsh-dev/DSH-better-sidebar/pull/95)）
- 📝 **编辑器新增语言**：C# / Kotlin / Swift 语法高亮（[#120](https://github.com/omdsh-dev/DSH-better-sidebar/pull/120)）
- 🧭 **设置页导航图标**：设置页导航图标与布局优化（[#114](https://github.com/omdsh-dev/DSH-better-sidebar/pull/114)）
- ➕ **推荐插件目录新增**：`dsh-git-remotes`——Git 远程 Tab（分支/上游/ahead-behind、fetch 可 prune、ff-only pull、确认后才 push，不替换内置暂存/提交）（[#91](https://github.com/omdsh-dev/DSH-better-sidebar/pull/91)）；`dsh-video-preview`——视频内联预览（.mp4/.webm/.mov/.mkv/.avi 等，自带 /video 宿主路由支持 HTTP Range 206 拖进度条，不受 20MB mediaLimit 限制）（[#126](https://github.com/omdsh-dev/DSH-better-sidebar/pull/126)）

**🐛 修复**

- 🔧 **xterm 依赖迁移**：弃用的 xterm 迁移至 `@xterm/xterm`（Closes [#122](https://github.com/omdsh-dev/DSH-better-sidebar/issues/122)，[#128](https://github.com/omdsh-dev/DSH-better-sidebar/pull/128)）
- 📝 **Markdown 编辑器**：选区转对话弹窗恢复可用（[#24](https://github.com/omdsh-dev/DSH-better-sidebar/pull/24)）
- 🖼️ **Markdown 预览支持本地/相对路径图片**：预览 `.md` 时把指向本地文件的图片目标（相对/绝对路径、引用式 `[id]: url`）重写为 `/sidebar/file` 媒体 URL 并显示（此前仅绝对 http(s) 图片能渲染，相对路径只显示 alt 文本）
- 🐛 **node-pty 加载失败不再拖垮 server**（[#140](https://github.com/omdsh-dev/DSH-better-sidebar/issues/140)）：宿主半改为懒加载 node-pty，缺失时插件照常挂载，终端以修复提示横幅（可复制命令 + 重试按钮）呈现，agent 终端工具自动跳过
- 🧪 测试工程：单元测试拆分（#141）+ smoke 偶发失败修复

</details>
