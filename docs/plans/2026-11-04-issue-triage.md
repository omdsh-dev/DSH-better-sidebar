# 2026-11-04 分诊与合入批次

> 目标：把「非常影响用户体验」的条目从待办变成**已合入 dev 的代码**，并清掉已经修好却还开着的 issue。
> 依据：`.agents/skills/issue-triage/SKILL.md` 的取快照 → 分类 → 判动作流程。

## 1. 快照

| 项 | 数值 |
| --- | --- |
| open issue | 165 |
| open PR | 78（其中约 42 个与 dev 冲突、3 个 CI 红） |
| 已在 dev 修好但仍开着的 issue | 18 |
| 发版状态 | `package.json` 0.29.0 未发；npm 最新 tag 仍 `v0.28.2`；`main` 停在合并基点 |

## 2. 合入 dev 的批次

每个分支/PR 合入前都跑了 `pnpm typecheck` + 全量 `vitest`；承载面改动另跑 `pnpm test:mount`。

| 来源 | 内容 | 备注 |
| --- | --- | --- |
| #1104 | 底部工作台终端不再自带黑底 | 纯 CSS，`:global` + 特异性 0,3,0 |
| #1110 | 页面 CSS zoom 不再被误判为页面级 transform（#1102） | 新增 e2e |
| #1101 | Changes 视角切换改用公开 `SegmentedControl`（#1098） | 与 #1097 同题，择一并关闭 #1097 |
| #1112 | 容器工作区在 Git 面板显示全部子仓库并切换 | 复核补：大小写只在 Windows 拼写下折叠 |
| #1099 | 侧聊支持粘贴 / 选中图片（#1114） | 合入前修正：大 body 才计入准入、宿主附件错误分类、常量收敛 |
| #1089 | 恢复被 mermaid 合并截断的发布历史 + 完整性守卫 | |
| #1111 | 划选引用 chip 可点击回跳并闪行段（#888） | 合入前修正：二次点击 nonce、落盘失败回退、注册契约 |
| 分支 fix/1107 | 装完先查 profile 自带的宿主包是否混版（#1107） | 诊断结论：peer 无法约束 profile 树，故走随包脚本 + install 前置检查 |
| 分支 fix/1109 | 压缩 seed 里重映射 delivery 水位线（#1109） | 根因是 `throughSeq` 未随 seq 重编号 |
| 分支 fix/1072 | 原生页签关闭 / 桌面退出保留未保存草稿（#1072 / #1071） | 宿主无确认钩子 → 草稿备份 + 重开恢复 |

## 3. 关闭的 issue（18）

依据：dev 上能指出具体文件 / 测试，且修复提交在 dev 可达。逐条评论写在 issue 里。

`#915 #947 #949 #950 #951 #952 #955 #959 #983 #988 #992 #995 #1009 #1013 #1014 #1015 #1024 #1080`

## 4. 判为宿主侧，不在本仓库打补丁

- **#1086 右栏面板列不滚动**：实测 `[data-sidebar-right-guide]` 内容高 421 > 视口 382，父级宿主 `.P3OORG_tabBody` 为 `overflow:hidden` 把它裁掉；外层 dockkit `.paneBody` 因此 `scrollHeight == clientHeight`，永远不滚。插件 CSS 没有一条 `[data-sidebar-right-*]` 选择器。修法在 `@deepseek-ai/dsh-client-ui-sidebar-right`。已在 issue 里给出最小复现与修法。

## 5. 遗留

- **#683**（mermaid 缩放）：PR #829 的分支存在但**不是 dev 祖先**，未合入；按现状保留待办。
- **#1019** 里 #992 的部分已被 dev 的另一笔修复覆盖，剩 #989 / #290 仍等 review。
- **版本口径**：#1111 把 peer 改为 14 条并在 AGENTS 写「v0.30.0 起」，而 `package.json` 仍是 0.29.0（0.29.0 从未发布）。发版时需要二者对齐。
- **已知 flake**：`tests/fs-watch.spec.ts` 在满载下超时（#868），隔离运行稳定，本批未改。
- **CI 复盘**：合入 #1111 后 `plugin-mount` 在 `89b85a82` 红——chip 的可见标签变成了本地化的「引用 … / Quote …」，而 e2e 仍按 `path:line` 的冒号形式断言。已在 `a1af72a6` 改为按文件名断言 + `toHaveCount(1)`，并复跑 mount lane 通过。教训：**动承载面的 PR 必须在合入前跑 `pnpm test:mount`，只跑 vitest 不够。**
- **看板同步未执行**：Projects v2 写入需要 `project` scope，需维护者执行 `gh auth refresh -s project` 后再跑 `board-sync.mjs`。
