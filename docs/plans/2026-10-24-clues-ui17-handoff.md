# 2026-10-24 线索 UI17 交接

> 后续更新（2026-10-24 10:59，Asia/Singapore）：GitHub真实列表失败已修复并部署UI18，诊断及当前部署真源见[GitHub修复记录](</Users/menghuan/Code/DSH-better-sidebar/docs/plans/2026-10-24-github-browse-query-fix.md>)。下面UI17包、测试和进程数据保留为其验收时点的历史证据；当前包与运行状态以该后续记录为准。

## 接手入口

- **业务任务已完成、已部署、已验收；当前没有未完成的实现步骤。** 最新用户请求是 `/handoff`。没有后续新需求时，不重复实现、整套测试、部署或重启。
- 2026-10-23 用户已回复“已停止自动目标”。不要恢复、重建或继续原自动目标。
- 原需求、最终设计、边界与实施结果直接查[UI17 实施记录](</Users/menghuan/Code/DSH-better-sidebar/docs/plans/2026-10-23-clues-cache-resource-ux.md>)，不以本交接替代该记录。

## 建议技能

接手后按实际新任务调用，不因交接而启动开发：

- `react-best-practices`：继续改 React 列表、详情、缓存消费或窗口生命周期。
- `diagnosing-bugs`：用户报告新故障、性能回退或部署异常时。
- `tdd`：新增行为或修复回归，先在公开 API／DOM 边界复现。
- `find-docs`：查询 DSH／React／CLI 等依赖的实际接口。
- `lark`：新的真实飞书操作或字段确认；不要自动授权或写入远端。
- `ws-search`：需要检索工作区外的既有设计文档时。
- 用户要求审查本地改动时才调用 `code-review`；其比较基点必须明确，不能把本轮开始前的脏改动全当作 UI17 新增。

## 仓库与授权边界

2026-10-24 10:26（Asia/Singapore）读取的状态：

```text
工作区：/Users/menghuan/Code/DSH-better-sidebar
分支：feat/clues-uiux-refresh
HEAD：d3bfcf62f7b8bfee07f09581a6415c4c81ad3f99
插件版本：0.28.0
预览宿主测试基线：@deepseek-ai/dsh@0.2.1-rc.1
```

- 工作区有大量 tracked 修改和 untracked 文件，包含 UI17 之前多轮已授权改动。全部保留；不 reset、不 blanket overwrite、不自动清理 worktree。
- 用户授权本地线索 API 为质量直接调整；**不授权提交、合并、推送、发布，或修改官方 DSH 源码**。本会话没有执行这些操作。
- 只部署 3080 的 `sidebar-test` profile；3384 是用户当前桌面 GUI，保持独立，不替换它的服务器或 profile。新一轮操作前重新检查实际 PID／命令／安装文件，不沿用历史 PID。
- 先读[仓库规则](</Users/menghuan/Code/DSH-better-sidebar/AGENTS.md>)和[宿主契约](</Users/menghuan/Code/DSH-better-sidebar/docs/host-contracts.md>)。现有 React／CSS Modules／宿主 primitives 延续使用，不迁移到 Tailwind／shadcn。
- 当前文件策略为 danger-full-access，审批关闭；不要传 `sandbox_permissions` 请求升级。

## 文档索引（实现细节不在此复写）

| 需要了解 | 真源 |
| --- | --- |
| UI17 决策、改动与最终验收 | [UI17 实施记录](</Users/menghuan/Code/DSH-better-sidebar/docs/plans/2026-10-23-clues-cache-resource-ux.md>) |
| 公共资料信息、filters、缓存及文档宿主 API | [接入指南 §7.1／§12](</Users/menghuan/Code/DSH-better-sidebar/docs/external-plugin-guide.md>) |
| 当前 Tab／详情设计规范 | [S9 设计](</Users/menghuan/Code/DSH-better-sidebar/docs/specs/10-17-线索收集-主设计/10-17-线索收集-S9-线索Tab与集成-设计.md>) |
| 必须保留的 UI16 引用插入、原生 @、回环只读 API 修复 | [引用流程记录](</Users/menghuan/Code/DSH-better-sidebar/docs/plans/2026-10-22-clues-reference-flow.md>) |
| 用户可见变更与历史轮次 | [CHANGELOG](</Users/menghuan/Code/DSH-better-sidebar/CHANGELOG.md>) |

### 代码导航

只在新任务涉及对应区域时阅读，不需重新实现：

- 展示契约和校验：[types.ts](</Users/menghuan/Code/DSH-better-sidebar/src/clues/types.ts>)、[resource-info.ts](</Users/menghuan/Code/DSH-better-sidebar/src/clues/resource-info.ts>)、[service.ts](</Users/menghuan/Code/DSH-better-sidebar/src/clues/service.ts>)。
- 缓存、跨视图事件与身份失效：[request-cache.ts](</Users/menghuan/Code/DSH-better-sidebar/src/client/clues/request-cache.ts>)、[客户端 API](</Users/menghuan/Code/DSH-better-sidebar/src/client/clues/api.ts>)、[runtime-api.ts](</Users/menghuan/Code/DSH-better-sidebar/src/client/clues/runtime-api.ts>)。
- 统一资料 UI：[resource-summary.tsx](</Users/menghuan/Code/DSH-better-sidebar/src/client/clues/resource-summary.tsx>)、[resource-filters.tsx](</Users/menghuan/Code/DSH-better-sidebar/src/client/clues/resource-filters.tsx>)、[detail.tsx](</Users/menghuan/Code/DSH-better-sidebar/src/client/clues/windows/detail.tsx>)、[format-content.tsx](</Users/menghuan/Code/DSH-better-sidebar/src/client/windows/format-content.tsx>)。
- Tab、置顶、包与帮助：[browser.tsx](</Users/menghuan/Code/DSH-better-sidebar/src/client/clues/tab/browser.tsx>)、[packs.tsx](</Users/menghuan/Code/DSH-better-sidebar/src/client/clues/tab/packs.tsx>)、[pack.tsx](</Users/menghuan/Code/DSH-better-sidebar/src/client/clues/windows/pack.tsx>)、[help.tsx](</Users/menghuan/Code/DSH-better-sidebar/src/client/clues/tab/help.tsx>)。

## 验证证据与时间边界

### 2026-10-23 最终完整验证（不是本次交接新跑）

| 门禁 | 结果与证据 |
| --- | --- |
| 全量单元 | 297 文件，4291 passed／18 skipped：[日志末尾](</Users/menghuan/Code/DSH-better-sidebar/.local/3080-preview/unit-ui17-deployed.log#L4181-L4184>) |
| 精确 RC 真实宿主完整门禁 | 17 passed／3 skipped：[日志末尾](</Users/menghuan/Code/DSH-better-sidebar/.local/3080-preview/e2e-ui17-deployed.log#L210-L215>)；既有可选 companion 场景跳过 |
| 类型、源码／测试／脚本 lint、构建、消费方类型、引擎 | 通过，见[实施记录的验证段](</Users/menghuan/Code/DSH-better-sidebar/docs/plans/2026-10-23-clues-cache-resource-ux.md#L28-L39>)和同目录 `*-ui17-deployed.log` |
| 最终部署归档 | [包及逐项校验记录](</Users/menghuan/Code/DSH-better-sidebar/.local/3080-preview/package-ui17-deployed-verification.json>)：713 个归档文件与成功挂载实例一致，365 个源文件与工作区一致，8 个 bundle 与3080安装一致 |
| 3080 实际中文页面 | [页面验收 JSON](</Users/menghuan/Code/DSH-better-sidebar/.local/3080-preview/verification-ui17.json>)：帮助在 Tab 内，三步、128px、无模态；重开详情累计读取2→2，刷新后3，loadEdit=0，回切列表新增读0，无 pageerror，无聊天发送／远端写入 |
| 真实飞书 | 同一[页面验收 JSON](</Users/menghuan/Code/DSH-better-sidebar/.local/3080-preview/verification-ui17.json#L11-L32>)：真实任务读取成功，完成筛选实际发送 true，详情有状态／发起人／负责人／创建与更新时间。缺人员姓名时回退到 provider id。不要继续沿用更早 token_missing 的旧结论 |
| 回环读取边界 | [页面验收 JSON](</Users/menghuan/Code/DSH-better-sidebar/.local/3080-preview/verification-ui17.json#L40-L46>)：只读200、带Origin403、伪写入400、普通无登录API403 |

PR／Issue／文档的新增真实宿主展示检查使用受控来源响应，测试入口为[来源 UX E2E](</Users/menghuan/Code/DSH-better-sidebar/tests/e2e/clues-resource-ux.e2e.ts>)；GitHub 查询字段另有公开仓库只读／introspection 验证。真实飞书任务是已安装3080的实际账号读取。不得把这两类证据混写为全部真实账号的端到端写入验证。

### 2026-10-24 10:26:45（Asia/Singapore）交接前只读复核

- 3080 当前监听 PID **85141**，与最终部署时相同。
- 最终 tarball SHA256 仍为 `384abf853af68a74e218abbde6a6f6f6d6ede276bff99879f0b00c239fef53b5`。
- 当前3080已安装的 **8个 JS bundle 全部匹配最终包**；当前工作区 **365个源文件全部匹配最终包**。本次交接没有重新跑全量测试或重新部署。
- 3384 当前监听 PID **72737**；2026-10-23验收时是50833。交接期间未重启3384，PID变化的原因未调查。
- 3384已安装插件的 client bundle SHA256 仍为 `53b70b1b5317205247c074b8121e1ececec1df2dc3771b0641f0a66b8fd127e1`，与2026-10-23保护基线一致。**不要把昨日的“PID未变”表述延续为今日当前状态。**

## 部署定位（不含访问 token）

```text
预览 URL：http://127.0.0.1:3080
预览 profile：sidebar-test
预览 PM2 名称：dsh-sidebar-preview-3080
预览安装：/Users/menghuan/.dsh/profiles/sidebar-test/node_modules/dsh-better-sidebar
受保护桌面 URL：http://127.0.0.1:3384
桌面安装：/Users/menghuan/.dsh/profiles/web/node_modules/dsh-better-sidebar
PM2 CLI：/Users/menghuan/.npm/_npx/5f7878ce38f1eb13/node_modules/pm2/bin/pm2
```

- 启动方式真源：[launch.sh](</Users/menghuan/Code/DSH-better-sidebar/.local/3080-preview/launch.sh>)；最终包：[已部署 tarball](</Users/menghuan/Code/DSH-better-sidebar/.local/3080-preview/dsh-better-sidebar-ui17-deployed.tgz>)。其他 `ui17-final`／`ui17-reviewed` 命名只是中间候选，不用它们覆盖最终部署。
- 只读安装验收脚本：[verify-ui17.cjs](</Users/menghuan/Code/DSH-better-sidebar/.local/3080-preview/verify-ui17.cjs>)。脚本会读取现有启动日志中的私有访问地址，不要把日志、cookie、token或用户任务正文复制到报告。
- 已安装截图：[Tab内帮助](</Users/menghuan/Code/DSH-better-sidebar/.local/3080-preview/installed-ui17-help.png>)；更多截图与日志位于同一目录。不要公开真实任务截图中的人员标识或业务正文。
- `pnpm pack` 可能重新触发构建；部署核对必须以**实际测试过的tarball**为准，不拿之后重建的工作区 bundle 当作同一个包。
- PM2 CLI 可能提示内存版本与本地版本不一致；本轮没有执行 `pm2 update`。`jlist` 可能带前缀提示，解析时定位 JSON 数组。

## 本地隔离槽与历史比较

并行实现已完成并串行集成，没有等待接收的 worker delta。2026-10-24 的 `git worktree list` 仍列出：

```text
.worktrees/clue-cache-ux
.worktrees/clue-detail-ux
.worktrees/clue-metadata-ux
.worktrees/clue-pack-cache
.worktrees/clue-reference-repair
.worktrees/clue-agent-api
.worktrees/clue-flow-repair
```

这些槽含本轮或前轮工作副本，不可整体覆盖主工作区，也不可无确认删除。UI17 开始时曾保存 `.worktrees/clues-ui17-baseline/` 快照；它不是 HEAD，若后续要使用，先确认目录仍在。只有 `git diff HEAD` 无法区分UI17与之前各轮脏改动。

## 自动目标登记的收尾状态

- 旧目标：`goal-875440e7-7af3-4e06-830e-f1677121f13b`；最后读取修订4。
- 父会话目标工具的调用曾被严格参数模式补入不适用字段，完成／失败操作返回 `objective is only valid for create/edit`；多次同参重试没有推进。
- 子代理目标按会话隔离，不能关闭父目标；备用公开接口返回 `gateway/definition-unavailable`，strict definition已撤回且禁止SRC fallback。
- **用户随后明确确认“已停止自动目标”。** 以此作为收尾事实；本次handoff不再读取／恢复／重建该目标，不调查或修改DSH来修复登记问题。
- 接手无需重复调用上述失败接口、修改会话存储或追加无关任务。等待用户新的工作指令即可。
