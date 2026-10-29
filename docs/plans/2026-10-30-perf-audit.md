# 真机性能审计：所有页面与 API（2026-10-30）

> **结论**：在一个 1,200 文件 + 5,000 文件目录 + 1.5 MB 文本 + 20 张 mermaid 图 + 21 次提交的 git 仓库上，插件所有页面与 `/sidebar/*` 路由都没有需要修复的性能问题：
> 页面交互 **32–558 ms**（唯一例外是首次打开 mermaid 文档：懒加载 1.20 MB chunk），API **1–130 ms**（常用 < 40 ms，1.5 MB 文件读 10–21 ms），**静置 10 s 零请求**。
> 同时把 e2e 启动的 `dsh web` 加上 `--no-open`（本地跑 lane 不再弹系统浏览器）。

## 一、方法

| 项 | 值 |
| --- | --- |
| 宿主 | 真实 `dsh web`：scratch profile + `dsh plugin add file:<tarball>`（与 `scripts/e2e-mount.sh` 同一条安装路径） |
| 浏览器 | Playwright headless Chromium，1440×900 |
| 本机宿主 | DSH 0.2.1-rc.2（CI 基线 0.2.1-rc.1；该 lane 对宿主版本只告警不拦截） |
| 工作区 | 30 目录 × 40 文件；`many/` 5,000 文件（宿主每层上限 1,000，见下）；`big.md` 20 个 mermaid 围栏；`large.txt` 30,000 行（约 1.5 MB）；git 仓库 21 次提交 + 约 300 KB 工作区 patch；`page.html` + css/js |
| 采集 | 每阶段 wall time；long task（>50 ms）；DOM 节点数；**Node 侧** request/response 记录每条 `/sidebar/*` 的耗时；10 s 静置请求普查 |
| 复现 | `DSH_E2E_AUDIT=1 bash scripts/e2e-mount.sh --grep "audit:"`（[tests/e2e/perf-audit.e2e.ts](../tests/e2e/perf-audit.e2e.ts)，默认 skip） |

数值取一轮完整跑（v14）与前三轮的重复项；同一格的多轮波动已在括号里注明。

## 二、页面

| 阶段 | wall time | long task | DOM 增量 | 说明 |
| --- | --- | --- | --- | --- |
| boot（goto → 插件挂载） | **599 ms** | 2 个 / 221 ms | 568 | 宿主外壳 + 插件 bundle 解析；多轮 599–947 ms |
| shell-ready（关引导 + 发首条消息） | 2,199 ms | 0 | +11 | lane 自己的准备（打字/发送/模型无 key 失败），不是插件成本 |
| Files 页 | **122 ms** | 0 | +412 | 打开原生右侧栏 + 目录第一层（`fs.trees` 61 ms 冷） |
| 展开目录（40 条） | **32 ms** | 0 | +323 | |
| 展开 5,000 文件目录 | **233 ms** | 0 | +7,995 | 宿主每层上限 1,000 行并显示「仅显示前一部分」提示；渲染被上限兜住 |
| 搜索（输入 → 结果） | **343 + 2 ms** | 0 | 0 | 343 ms = 300 ms 防抖 + 网络；**结果渲染 2 ms**（400 行），清除 23 ms |
| 打开 Markdown（20 张 mermaid） | **558 ms** | 1 个 / 114 ms | +604 | 首次会拉 1.20 MB 的 `mermaid.js` chunk；多轮 523–748 ms |
| 打开 1.5 MB 文本（分页预览） | **387 ms** | 1 个 / 101 ms | +359 | 分页读 `fs.readPage` 2–4 ms |
| Git 页（Changes） | **163 ms** | 0 | +173 | `git.status` 35–105 ms |
| 提交图 | **131 ms** | 0 | +134 | `git.graph` 82–130 ms |
| 打开 300 KB patch 的 diff | 37 ms 到面板头 | 0 | +33 | 文件行按「变更行预算」默认折叠（既有设计），不阻塞主线程 |
| 任务页 | 2,156 ms | 0 | +33 | keyless lane 没有任务数据，只做 2 s 静置；接口 `subagents.live` 6 ms / `workflows.list` 6 ms |
| 侧边对话页 | **215 ms** | 0 | +60 | 自动建线程 `sidechat.start` 49–61 ms |
| 终端页 | **203 ms** | 0 | +101 | 宿主终端 tab |
| settings.get（侧边栏首次读设置） | **34 ms** | 0 | 0 | 冷启动单次 250–276 ms（首个调用），之后 17–37 ms |
| 静置 10 s（所有页签都访问过） | — | 0 | +8 | **零请求** |

## 三、API（页面流之外的直连测量）

| 路由 | 耗时 | 载荷 |
| --- | --- | --- |
| `fs.read` `large.txt` | 10–21 ms | 1.58 MB |
| `fs.readPage` `large.txt` | 2–4 ms | 134 KB/页 |
| `fs.search`（1,200+ 文件） | 14–38 ms | 2.9 KB（上限 200 命中） |
| `fs.trees`（30 层） | 4–5 ms | 220 KB |
| `git.status` | 35–105 ms | 0.5 KB |
| `git.diff`（300 KB patch） | 21–25 ms | 858 KB |
| `git.graph` | 82–130 ms | 5.1 KB |
| `git.blame`（40 行） | 10–25 ms | 0.2 KB |
| `changes.ops` | 1–2 ms | 45 B |
| `settings.get` | 17–22 ms | 0.5 KB |
| `GET /sidebar/file`（1.5 MB） | 5–7 ms | 1.55 MB |
| `GET /sidebar/file`（md） | 2 ms | 1.7 KB |
| `GET /sidebar/html`（带 css/js） | 2–3 ms | 147 B（资源由同路由按需再取） |
| `POST /sidebar/upload` 1 MB | 28–31 ms | — |
| `POST /sidebar/write` 200 KB | 3–5 ms | — |
| `archive.build` → `archive.status` → `GET /sidebar/archive`（40 文件） | 59 ms | 4.3 KB |
| 同上（5,000 文件） | 163 ms | 544 KB |

## 四、成本与判断

- **懒加载 chunk**：`editor.js` 784 KB（transfer）、`mermaid.js` 1.20 MB（transfer，3.9 MB 解码）。两者都只在首次用到处拉取，属于既有设计；mermaid 的 114–172 ms long task 就是它的解析 + 首图渲染。继续压缩需要裁剪 mermaid 功能或改架构，不符合 KISS。
- **启动 long task**：boot 两个 long task 共 221–330 ms，无法在不用对照组的情况下把宿主外壳与插件 bundle 拆开；插件挂载本身 599–947 ms。
- **静置**：0 请求 / 10 s，没有隐藏轮询。
- **DOM**：访问完全部页签约 10.8k 节点（原生 tab 一律 keepMounted），有界。
- **结论**：没有发现需要修改产品代码的性能问题。上面的数字留作下一轮比较的基线。

## 五、为什么不动

- 300 ms 搜索防抖 + 2 ms 渲染：属于标准搜索交互，不是瓶颈；缩短防抖只会增加请求。
- `/sidebar/file` 与 `/sidebar/html` 都是流式直出，1.5 MB 在 5–7 ms 内发完，无需缓存层。
- `git.status` 35–105 ms 是 spawn git 进程的成本（每 30 s 一次、服务端），不在主线程。
- 树每层上限 1,000 行由宿主兜住并明确提示（`filesTruncated`），5,000 文件目录展开 233 ms。

## 六、未覆盖

- Windows / macOS 桌面壳（Electron 外壳）、Tauri/WebKit 路径。
- 真机移动端。
- 任务页 / 侧边对话在**有真实 job / 模型回复**时的渲染：keyless lane 里只有空状态（接口耗时已单独记录）。
- 设置页 UI（宿主设置对话框 + 插件的侧边卡片分组）：只测了 `settings.get`；插件在该页只挂一个导航图标与一组卡片。
- 写操作与推送通道没有单独计时：`git.stage/unstage/commit/push`、`teams.*`、`sidechat.prompt/dequeue/cancel`、three `/sidebar/ws/*` 通道（它们的读取侧与页面流已覆盖；写操作都是既有 git/文件系统调用的薄包装）。
- 长时间运行的内存曲线：`performance.memory` 在 Chromium 中被量化（多轮恒为 45 MB），不能作为泄漏证据，需要 CDP heap snapshot，本轮未做。
- 多用户/远程（`dsh-remote`）场景的网络延迟。

## 七、随本批落地的脚本改动

- [scripts/e2e-common.sh](../scripts/e2e-common.sh)：`e2e_start_dsh_web` 给 `dsh web` 加 `--no-open`。宿主默认会在启动后打开系统浏览器，本地反复跑挂载 lane 会一直弹窗；基线宿主 0.2.1-rc.1 的 `@deepseek-ai/dsh-web-app` 已提供该 flag（`lib/startup.js` `.option("--no-open", ...)`）。
- [tests/e2e/perf-audit.e2e.ts](../tests/e2e/perf-audit.e2e.ts)：本审计的采集脚本，`DSH_E2E_AUDIT=1` 才运行（默认 skip，不进 CI 的普通挂载门禁）。
