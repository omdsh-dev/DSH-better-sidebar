# fs.search 原生搜索引擎探测设计(fd / rg)

**日期**：2026-08-19
**状态**：已实施(feat/fs-search-engines,待 PR)
**作者**：opencode + 用户
**关联**：issue #203(fs.search 文件名搜索优先嗅探并使用本机 fd/rg)

## 1. 目标

编辑器侧栏全局文件名搜索(`fs.search` 路由 → `searchFiles`)在纯 JS 递归遍历下,大目录(十万级)单次搜索可达秒级。本设计在**零新依赖、路由和客户端零改动**的前提下:

1. 探测本机已验证可用的原生引擎(fd → rg),按需调用,带宽返回
2. 引擎不可用/运行失败时无缝回退纯 JS 遍历,行为与现状一致
3. 引擎输出统一换算为朴素遍历的既有契约(根相对、`/` 分隔、大小写不敏感名字子串、排序、上限截断)

## 2. 非目标(Out of Scope)

- **懒索引 / mtime 校验缓存**:无引擎?环境的兜底加速,二期候选(见 §6「二期」)
- **应用层脏标记**:依赖 DSH jobs.output 事件流,延期
- **自带引擎**(`@vscode/ripgrep` 作为依赖):包体积问题需维护者决策,二期候选
- 修改 `fs.search` 路由签名、客户端 TreePanel 交互协议:不动

## 3. 设计

### 3.1 探测(进程内一次,懒,带缓存)

- 探测顺序:`fd` → `rg`
- 候选位置 = PATH 展开 + 固定路径,并**优先 DSH 自带的 rg**:
  - rg 第一候选:**DSH CLI 内置的 ripgrep**。因为 DSH 的安装布局因平台/包管理器而异,`bundledRgCandidates` 枚举多个候选根(每条经 `--version` 预检剔除):POSIX npm 全局(`<npm 全局 prefix>/lib/node_modules`,由 `process.execPath` 推导——node 在 `<prefix>/bin/`)、**Windows npm 全局(`%APPDATA%\npm\node_modules`,没有 `lib/` 层)**、Homebrew/pnpm 全局根、`~/.dsh/profiles/node_modules`(launchd/profile 布局,2026-08-22 本机实测 DSH 真实落在此处,旧的 execPath 单一定向反而 miss);之后 PATH `rg` + `/opt/homebrew/bin/rg`、`/usr/local/bin/rg`、`/usr/bin/rg`
  - fd: PATH `fd` **与 `fdfind`**(Ubuntu 包装名)+ `/opt/homebrew/bin/fd`、`/usr/local/bin/fd`、`/usr/bin/fd`、`~/.cargo/bin/fd`
  - ~~VS Code 捆绑 rg hack~~ **已弃用**:DSH 自身就捆绑 @vscode/ripgrep,不需要反向借用 VS Code 应用目录(issue #203 的核心洞察)
- 每个候选二进制跑 `--version`(500ms 超时)验证可执行,验证不过的路径不采用
- 首次搜索时懒探测,结果 Promise 级缓存整个进程生命周期;`search-engines.ts` 导出 `setEngineHooks` / `resetEngines` 作为测试注入点

### 3.2 调用与语义对齐

| 引擎 | 命令 | 语义对齐 |
|---|---|---|
| fd | `fd --hidden --no-ignore --exclude .git --fixed-strings --ignore-case --path-separator / --max-results N+1 <q> .`(cwd=root) | `--fixed-strings` 字面量子串匹配(对齐朴素语义,防 glob 注入);`-H -I` 不忽略隐藏/ignore 文件;"文件名+目录名" 都匹配;`--max-results` 天然限流;`.git` 目录显式排除(朴素遍历同样跳过) |
| rg | `rg --files --hidden --no-ignore --glob '!**/.git/**' --iglob '*<escaped>*' --path-separator / .`(cwd=root) | `--iglob` 大小写不敏感(rg globset 不支持 `(?i)` 前缀);`--path-separator /` 把 Windows 上的 `\` 输出钉成 `/`(rg 在 cmd/PowerShell 下输出 `\`、Git Bash 下输出 `/`,见 rg#501,源头钉死);**只匹配文件,不匹配目录名**(documented lossy);`.git` 全程排除;无结果上限,流式读取到 N+1 杀进程;**exit 1 = 无匹配,属正常空结果**(rg 契约,streamLines 放行,不触发引擎禁用) |

统一出口:子进程 stdout 流式逐行(全量结果用 readline + 超过 N+1 即 kill,不会 buffer 进内存),经 `normalizeEnginePaths` 换算(去 `./` 前缀、`/` 分隔),由 `searchFiles` 排序 + 截断。

### 3.3 降级链与失败策略

- 探测超时/非零 → 剔除该候选;无候选的引擎不进链
- 运行期失败(非零退出 / 无法 spawn)→ **禁用该引擎(进程内)**,继续下一个引擎
- **超时(15s)不禁用**:超时的语义是「这棵树太大」而非「二进制坏了」——broken 集按引擎记、不按搜索根记,若大目录搜一次就禁用,其余所有小目录的搜索也永远失去引擎加速。超时只降级本次(换下一个引擎 / plain walk),引擎保持可用
- 全部不可用 → 纯 JS 遍历(`searchFilesPlain`,原逻辑原样)
- 调用方 signal abort → 杀子进程,跳过回退遍历直接返回空(请求已死,客户端不再消费)

## 4. 文件变更

| 文件 | 类型 | 内容 |
|---|---|---|
| `src/search-engines.ts` | 新增 | 探测缓存 + 三引擎调用 + `normalizeEnginePaths`/`escapeGlob` + hooks |
| `src/search-debug.ts` | 新增 | 门控调试插桩:`DSH_SEARCH_DEBUG=1` 才写 `$DSH_HOME/search-debug.log`(+ console 镜像),默认零开销;写盘失败静默 |
| `src/fs-search.ts` | 改动 | 原逻辑改名 `searchFilesPlain`;新增 `searchFiles` dispatch(引擎优先,失败回退) |
| `tests/search-engines.spec.ts` | 新增 | 规范化/转义/探测缓存/失败禁用/abort 不禁用 |
| `tests/fs-search.spec.ts` | 改动 | 既有用例改测 `searchFilesPlain`;新增 dispatch 组(路由/截断/回退/无引擎/abort) |
| `docs/plans/2026-08-19-fs-search-engines-design.md` | 新增 | 本文档 |

路由(`src/index.ts` 的 `fs.search`)与客户端:**零改动**。

## 5. 验证

- `pnpm typecheck` 通过;`pnpm test` 全量 637 passed / 5 skipped
- 真实机器集成(本机 macOS):PATH 不含 Homebrew 的容器里,`/opt/homebrew/bin/rg` 被固定路径探测命中,`searchFiles` 命中 `src/search-engines.ts`;DSH 内置 rg 由 `process.execPath` 前缀推导命中(enginetest profile 实测)
- **真实目录基准(本机 macOS,DSH 内置 rg 15.0,3 次取最优)**:

  | 目录(规模) | 查询 | plain(JS walk) | rg(--iglob) |
  |---|---|---|---|
  | `/opt/homebrew`(17 万文件) | `libruby` | 518ms,4 命中,`truncated=true` | 205ms,4 命中,完整 |
  | `/opt/homebrew`(17 万文件) | 无匹配 | 513ms,0 命中,`truncated=true` | 198ms,0 命中,完整 |
  | `/Users/y/workspace`(9 万文件) | `search-engines` | 870ms,4 命中,`truncated=true` | 184ms,4 命中,完整 |
  | `/Users/y/workspace`(9 万文件) | 无匹配 | 872ms,0 命中,`truncated=true` | 191ms,0 命中,完整 |
  | `/Applications`(24 万文件) | `README` | 453ms,85 命中,`truncated=true` | 23ms,200 命中,完整 |
  | `/Applications`(24 万文件) | 无匹配 | 452ms,0 命中,`truncated=true` | 184ms,0 命中,完整 |
  | `/Users/y/tools`(3.7 万文件) | `glob` | 217ms,102 命中,完整 | 56ms,99 命中,完整 |

  结论:**真实嵌套目录下 rg 快 2.5~20 倍,且 plain 大目录一律预算截断(结果不完整,正是 issue #203 指出的问题)**;`tools "glob"` 的 99 vs 102 差异是 rg 只报文件、plain 把目录也算命中(documented lossy);README 查询 rg 命中 200(结果上限)+ 完整遍历,而 plain 85 命中即因预算截断而漏掉其余。顺带修出两个 mock 测不出的 bug:`(?i)` 前缀无效(改 `--iglob`)与 rg exit 1 = 无匹配(放行,不触发引擎禁用)。极端场景(如 `~/Library/Containers`,数百万 iCloud 小文件)下 plain 与 rg 均需 >5min,两类实现都不可用,不作为基准
- 本机无 fd,`fd` 候选探测自然剔除,链正常降级
- **门控插桩验收(2026-08-21,本机 macOS,真机 dsh web + UI 实测)**:
  - 默认静默:未设 `DSH_SEARCH_DEBUG` 时零 console、零磁盘写(测试与真机双重确认)
  - 开启后:进程首搜 1 行 `engines probed: rg(<捆绑路径>)`(fd 缺失静默剔除,不报错);每搜索 1 行 `engine=rg bin=<捆绑 rg> root=~… query=… hits=… truncated=… ms`(root 以 `~` 缩写)
  - `~/workspace`(9 万文件量级)实测 15~500ms:常见词毫秒级;罕见词(如 `.dsh` 仅 1 命中)全量遍历 ~478ms 且**结果完整不截断**——正是 issue #203 要的行为(`query="."` 则 hits=202 `truncated=true`,200 上限截断生效)
  - `query="*"` → 0 命中(glob 元字符转义生效,字面量语义);真机复跑同款 rg 命令确认输出无任何 `.git/` 目录内部路径
   - **Windows 真机验收(2026-08-22,Windows 11 + npm 全局 DSH 0.1.1-rc.2 + scoop fd/rg)**:
     - 输出格式字节级:`rg` 默认输出 `\` 分隔 + `.\` 前缀(commenter 担忧的坑实锤);`--path-separator /` 后全 `/`;fd 同效。CR 全 false / LF true(Rust 二进制管道输出 LF);中文文件名 UTF-8 无乱码
     - 探测命中:DSH 装于 `%APPDATA%\npm\node_modules`(npm 全局,无 `lib/` 层)→ `bundledRgCandidates` 的 `%APPDATA%` 候选 `existsSync` 命中,`probeEngines` 实测 `rg(捆绑 rg.exe)` 与 `fd(scoop shim)` 双双就位;PATH 滤掉 Scoop 后捆绑 rg 依旧命中(固定绝对路径兜底,与"无 PATH 环境"设计一致)
     - 完整链路:`pnpm pack` tarball → `dsh plugin --profile web add`(首次 install 需先把 profile 模板的 `allowBuilds: node-pty` 占位写成 true)→ `dsh web --port <OS分配>` → `POST /sidebar/api/fs.search` 返回 `ok:true`、200 匹配、`/` 分隔;`DSH_SEARCH_DEBUG` 日志见引擎行(web UI 搜索路径同款)
     - **bench(D:\Project,>10 万元素,3 次最优)**:plain 一律 `truncated=true`(visited 100k 预算耗尽,**不含匹配预算**),`query="1234"` plain hits=5 vs 引擎 hits=40——"慢且结果不全"正是 issue #203;引擎快 3.7~34.7x(md 415→25ms、hollow 978→264ms、1234 1970→262ms、test 1008→29ms)。`scripts/win-bench.cjs` 可复跑
     - 顺手修复:fd `--max-results` 原钉在 `cap`(=maxMatches+1 哨兵)处,满集永不触发截断、多余返回 1 条;改为 `cap+1` 后 fd/rg 截断语义对齐,`fdArgv`/`rgArgv` 抽为导出纯函数由单测钉死

## 6. 二期候选(有意不做,记录在案)

1. **懒索引 + 目录 mtime 校验**(`searchFilesPlain` 回退路径加速):文件名索引只需感知创建/删除/改名——必然改变父目录 mtime,故 mtime 校验即正确失效信号;TTL(如 5s)免校验补偿秒级粒度。有 fd/rg 时索引无意义甚至更慢(校验遍历 > 原生一次遍历),故**仅在无引擎路径生效**
2. **自带 `@vscode/ripgrep` 依赖**:消灭"用户没装/DSH 布局探不到"的概率问题,代价是 2-4MB 三平台二进制 + optionalDependencies 平台分片,需维护者拍板
3. **应用层脏标记**:通过 DSH `jobs.output` 事件流解析 agent 写文件路径,即时失效 mtime 兜底的陈旧窗口(延迟/复杂度高)
4. rg 的目录名匹配缺失:`rg --files` 无目录输出,若反馈集中可考虑砍掉 rg 或换 `--no-ignore` 全量 + 客户端过滤

## 7. 已知取舍(诚实记录)

- **truncated 语义**:引擎路径的截断顺序是引擎遍历序(非确定性),朴素路径是遍历序——截断结果本来就不保证全集,差异可接受
- **DSH 内置 rg 路径由 `process.execPath` 推导**:依赖 DSH CLI 的全局 node_modules 布局(npm 风格 `lib/node_modules/@deepseek-ai/dsh/...`);用 `pnpm`/`bun` 全局安装等异构布局探不到,但 existSync + `--version` 预检会将其剔除,不影响正确性(还有 PATH/固定路径 rg 与 JS 兜底)
- **探测顺序决定引擎胜负**:rg 的 DSH 内置候选排在 PATH 之前——即使系统装了别的 rg,也优先用 DSH 自带的 15.x(行为一致、免环境依赖)
- **node_modules 不排除**:引擎与兜底 walk 同样沿用 no-ignore 语义(结果集一致,不引入两种模式的结果漂移);常见词查询的 200 名额可能被依赖树打满(实测 `query="test"` 202 条大半来自 node_modules)。加 `--exclude node_modules` 属产品决策(§6 候选),留待反馈
- **rg glob 的花括号必须转义**:`{a,b}` 是 globset 交替组语法——查询含未闭合 `{` 会让 rg 解析 glob 失败(exit 2,引擎被误判损坏而进程内禁用),含成对 `{}` 则被静默当交替展开(`a{b}` 实搜 `ab`,rg 15.0 实测)。`escapeGlob` 对 `{}` 一并反斜杠转义后两类症状均消除
- **`.git` 文件(worktree)三实现对齐**:git worktree 工作区根的 `.git` 是指针文件而非目录——plain walk 只匹配名字、fd `--exclude .git` 文件目录都排、rg 的 `!**/.git/**` 因模式要求 `.git` 后还有路径段而漏掉它(rg 15.0 实测会列出该文件)。现统一语义:凡名为 `.git` 的条目一律不算命中(rg 补 `!**/.git`,walk 去掉 isDirectory 条件)
- **超时不进入 broken 集**(见 §3.3):代价是同一个大根目录每次搜索都先付 15s 再落 plain walk,换来其余目录不受牵连