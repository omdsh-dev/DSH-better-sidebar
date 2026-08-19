# Locale 文案治理

本文件是 `src/client/locales/` 的长期归属合同，面向本仓库贡献者和 Agents。

## 范围与边界

- `src/client/locales.ts` 是唯一聚合与消费入口：现有组件只从它导入 `t`、`zh`、`en` 和相关类型；
- `src/client/locales/*.ts` 是内部领域切片，不新增 package export；
- 本文定义文案 key 的归属，不定义 DSH locale 服务、语言选择、翻译流程或发布流程；
- 现有设计的实施历史留在 `docs/plans/`，不与本文重复。

## 归属规则

按以下顺序为新增或移动的 key 选择 owner：

1. 文案归属于拥有该行为、状态或组件的功能，而不是碰巧渲染它的页面。
2. 功能专属设置跟随该功能切片；不要集中放入 `settings.ts`。
3. 仅当一个语义 key 被两个或以上领域真实复用、且没有明确行为 owner 时，才放入 `core.ts`。
4. 相同显示文字不代表相同语义；含义不同的状态应使用各自 key，而不是为了复用塞入 `core.ts`。
5. 一个 key 只能由一个切片声明。禁止依赖聚合对象 spread 的后写覆盖。
6. 归属仍有歧义时，在 PR 描述中说明理由；不要默认放入 `core.ts` 或 `settings.ts`。

`core.ts` 不是未分类文案的兜底文件。它增长时优先复核 owner 是否错误。

## 切片职责

| 切片 | 职责 |
|---|---|
| `core.ts` | 侧边栏外壳和跨领域通用语义：展开、关闭、加载、错误、重试、复制、通用时间、共享沙箱状态 |
| `explorer.ts` | 文件树、编辑器、文件 viewer、HTML viewer 设置 |
| `terminal.ts` | 终端生命周期、依赖提示和终端专属设置 |
| `git.ts` | Git 状态、提交、分支、历史和 diff 操作 |
| `subagent.ts` | 子代理、后台任务和它们的专属设置 |
| `browser.ts` | 内嵌浏览器、安全限制、嵌入失败和浏览器专属设置 |
| `settings.ts` | 设置框架与全局侧边栏偏好，不承载功能专属设置 |
| `plugins.ts` | 推荐插件市场和安装/跳转/复制交互 |

例如，`settingsBrowserSandboxTitle` 属于 `browser.ts`，`settingsFontSizeTitle` 属于 `terminal.ts`，`settingsHtmlSandboxTitle` 属于 `explorer.ts`，而 `settingsOpenTitle` 属于 `settings.ts`。

## 贡献者检查清单

修改文案时：

1. 先根据归属规则选择切片；
2. 在同一变更中同步更新该切片的 `zh` 与 `en`；
3. 带 `{placeholder}` 的文案须在 zh/en 使用相同的 placeholder 名称；
4. 不得修改调用方以绕过聚合入口；
5. 运行 `pnpm typecheck`、`pnpm build`、`pnpm test` 与 `pnpm check:consumer-types`；
6. 影响打包客户端时，PR 的 `plugin-mount` job 必须通过；本地未跑挂载时应明确记录。

若单一功能的 key 后来成为跨领域语义，可在独立、纯机械的重归属提交中移动到 `core.ts`。不要在无关功能 PR 中静默改变边界。

## 自动化边界

`tests/locales.spec.ts` 守护：

- 每个切片的 zh/en 键集一致；
- 不同切片之间无重复 key；
- 聚合字典等于切片 key 的并集；
- 每个 key 的 zh/en placeholder 集合一致；
- 语言 fallback、动态切换、插值和相对时间行为不回归。

测试不能判断业务语义是否属于正确 owner；这部分由本文、PR review 和归属理由共同约束。
