# v0.28.0-alpha.0 发布整合验证

## 发布范围

用户确认 3080 的 alpha.5 适配试用通过后，要求包含远端 dev 新增修复再发布 alpha。发布候选以 `6417547` 合并本地适配 `5772280` 与远端 dev `24d2032`，包含 Context 可选诊断入口（`93c43b0`）和 Git 提交图填满高度修复（`38d94bd`），不遗漏尚未发布的 v0.27.0 内容。

版本为 `0.28.0-alpha.0`，DSH 基线为 `0.2.1-alpha.5`。GitHub Release 必须标记 prerelease，npm 使用 alpha dist-tag，不更改稳定 latest（发布前为 `0.26.1`）。

## 整合修改

- 变更日志唯一合并冲突保留双方条目，新修复归入本 alpha。
- 新增 Context e2e 原有 onboarding helper 不识别 alpha.5 Get started 对话框，改为重新导出既有共享 helper；不修改生产导航行为。
- 版本、peer、安装脚本和 lockfile 未被远端 dev 的旧 rc.2 基线覆盖。

## 新鲜验证结果

- `pnpm install --frozen-lockfile`：通过。
- `pnpm typecheck` / `pnpm lint`：通过。
- `pnpm test --maxWorkers=1`：221 个文件通过，2681 passed / 17 skipped（共 2698）。
- 默认并发 `pnpm test`：本机出现既有 fs.watch 等待事件超时（两次均为 1 例，其他 2680 例通过）；未删除测试、未增加超时或修改产品以隐藏问题。远端 Linux/Windows CI 结果另行核对后才发布。
- `pnpm build` / `pnpm check:consumer-types` / `pnpm pack`：通过。
- `bash scripts/e2e-context.sh --variant all`：真实 `dsh-context@0.72.0` 在 alpha.5 下 dual、tab-only、no-context 三态全部通过；每个变体只执行属于自己的 1 项，其余 2 项按设计跳过，不发送模型请求。
- 普通真实 alpha.5 挂载：13 passed / 3 skipped（新增 Context 专用用例由独立 lane 执行），2.8 min；含 Git 图完整高度、原生重挂、文件/editor 懒加载与终端唯一性。

## 发布流程

主题分支整合验证 → 合入 dev 并推送 → 等待 Linux/Windows/plugin-mount CI → dev 合入 main → tag `v0.28.0-alpha.0` → GitHub prerelease → Release workflow 使用 npm Trusted Publishing / OIDC → 检查 npm alpha、latest 和 provenance。

此记录中的本地结果不代替远端 CI 或实际 npm 发布结果。3080 独立预览实例保留，3384 与真实用户 profile 不变。
