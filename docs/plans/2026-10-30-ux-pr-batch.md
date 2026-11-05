# UX 修复批次（2026-10-30）

> **范围**：148 open issue + 77 open PR 全量扫描后的第一批。基线 `dev` `5831053`（v0.29.0 GenUI sidechat 已在 dev）。
> **结论**：11 个贡献者 PR 合入 `dev`（10 个 GitHub 已标 Merged，1 个 base=`main` 待发版自动合并），4 个无 PR 的体验缺陷直接修好，1 条 mount-lane 假阴性修掉；`ci` 与 `plugin-mount` 绿。

## 一、逐条复核结论

| 对象 | 结论 | 依据 / 备注 |
| --- | --- | --- |
| [#1083](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1083) 合并模式换文件丢草稿 | MERGE-AS-IS | 复用 `isEditorDirty` 登记表；取消/确认两条路径都有判别性用例（回退实现后 1 failed）。PR 另带 3 个 test-only CI flake 提交 + 1 个空提交，保留作者提交不动 |
| [#974](https://github.com/omdsh-dev/DSH-better-sidebar/pull/974) 未闭合 `@media` | MERGE-AS-IS | dev 的 `layout.css` 13 `{` / 12 `}`；新 spec 在修复前 2 failed |
| [#988](https://github.com/omdsh-dev/DSH-better-sidebar/issues/988) Git 面板子菜单 | FIXED（本批实现） | 该入口从不写 `data-dsh-sidebar-submenu`；改为复用 `menu-flip` 的同一 token，无第二套定位逻辑 |
| [#972](https://github.com/omdsh-dev/DSH-better-sidebar/pull/972) HTML 预览 MIME | MERGE-AS-IS | 只补 `MEDIA_TYPES` + 10 条真 HTTP 回归；补了 README_ZH 对照句 |
| [#975](https://github.com/omdsh-dev/DSH-better-sidebar/pull/975) 同缺陷另一方案 | DROP（留开待确认） | 第二张 24 项类型表 + 公开导出，其中 11 项在沙箱预览里空转；收益不抵双份维护 |
| [#922](https://github.com/omdsh-dev/DSH-better-sidebar/pull/922) 分栏唯一标签丢失 | MERGE-AS-IS | 仅同 pane 早返回；跨窗格语义未动 |
| [#1032](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1032) 搜索 probe TDZ | MERGE-AS-IS | `let timer` 提前，成功路径分配时机不变 |
| [#966](https://github.com/omdsh-dev/DSH-better-sidebar/pull/966) 并发上传 rename 争用 | MERGE-AS-IS | 有界重试（10 次、`setImmediate`）；base 是 `main`，发版进 `main` 时 GitHub 自动标 Merged |
| [#1067](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1067) 尖括号链接 | MERGE-AS-IS | 8 行实现 + 35 行测试 |
| [#1074](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1074) 侧聊本地源码链接 | FIX-SMALL | 去掉与 #1067 重复的判括块；保留 `allLocalFiles`；补 2 条钉住「尖括号内含空格」语义的用例 |
| [#1079](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1079) UNC 前缀 | MERGE-AS-IS | 只折分隔符、不折 UNC 前缀；幂等实测 |
| [#1070](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1070) 子目录会话根 | FIX-SMALL | 一行参数顺序不够：macOS `/var` vs `/private/var` 仍会抬根；改为按 `realpath(base)` 取 canonical 基址且永不替换成仓库顶层，保住 #952 的 containment 语义 |
| [#963](https://github.com/omdsh-dev/DSH-better-sidebar/pull/963) 同缺陷另一方案 | DROP（留开待确认） | 不是 #1024 的根因（客户端已绝对化）；把「永远返回 raw base」应用到 dev 会让 #952 两条用例回归；`fs.read` 取消静默回退是另一条路由契约，另案 |
| [#1040](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1040) mermaid 沙箱 iframe | MERGE-AS-IS | 上一轮两个阻断实测已修：坏图不熔断（变异删早抛 → 用例红）、双向消息绑定 `event.source`/schema（变异删除 → 用例红）；真 Chromium 探针 |
| hub 安装失败 5 条（#1007/#1065/#1068/#1073/#1076） | 非本仓库 | `duplicated mapping key` 出自 profile 的 `pnpm-workspace.yaml`（干净 profile 可装 0.28.2；把该文件改坏可逐字复现）；hub 的 `classifyFailure` 把任何 `Command failed` 判成插件 prepare/build 失败并投给本仓库 |

## 二、无 PR 的 4 条（本批实现）

- **#949** 侧边对话归档后无法恢复：归档按钮对侧线程禁用 + tooltip（宿主对 `origin: subagent` 的行在任何筛选下都不渲染，连「已归档」也看不到）。
- **#951** `agentOpenTools` 读不到设置时被当成关闭：改成三态，只有明确 `false` 才注销；设置写入成功与 loader 就绪后各重估一次。
- **#1009** 设置页两张假开关：`hidden: true` 的 tab 类型不再列成卡片，`isTabEnabled()` 对 hidden 类型恒真（旧 prefs 的 `false` 不再阉割 diff / 远程文件打开）。
- **#1014** 手机端整页可拖动：`100vh` 兜底 + `100dvh`（大视口与 `innerHeight` 的差值归零，不再误触发 degraded）；不回 `100%`，不加 `visualViewport` 常驻监听。

## 三、mount-lane 假阴性（测试修复）

`mount.e2e.ts` 两处 `pane.getByText('tail text')` 期望恰好 1 个元素，但编辑器页签在预览模式下**保留隐藏的 CodeMirror host**，其 `cm-line` 可能包含同一行：

```
DEBUG panelCount 1 dupes 2
DEBUG 0 visible= false <div class="cm-line">tail text</div>
DEBUG 1 visible= true <p>tail text</p>
```

可见 UI 正确（截图里只有一个预览）。CodeMirror 在隐藏容器里是否已虚拟化末行取决于测量时机，断言因此时红时绿。改为 `.filter({ visible: true })`，与同文件后面两处断言一致；产品行为未改。

## 四、合入与门禁

`dev` 从 `5831053` 到 `2c48ff4`：first-parent 12 个提交（10 个 `--no-ff` 合并 + 2 个直接提交），含作者原始提交共 57 个。逐笔门禁：定向 spec + `tsc --noEmit`；整批：`vitest run` 237 files / 2932 passed / 17 skipped、`eslint .`、`build`、`check:consumer-types`。真实挂载 lane 本地 2/2 绿（5 tests）。CI（`2c48ff4`）：`ci` ✅、`plugin-mount` ✅、`ci-windows` 见运行记录。

## 五、未合入 / 待确认

- **#975 / #963**：建议关闭（理由见上），等维护者拍板后回评论。
- **#1072 / #1071**：草稿保护的两条缺口（原生页签关闭、Cmd+Q），报告者自述未独立复现，需先造复现；未在本批。
- 大改动按用户决定本轮不碰：#1004（文件树根选择）、#887（Markdown 写作模式）、#829（mermaid 缩放）、#1043（桌面壳预览图片）、#738（自动收起）、#1081（zen-remote 桥接）。
- **#1077**（`dev → main` 0.29.0 发版）按用户决定本轮不处理。

## 六、残留风险

- #1040 引入的 mermaid 单测里有 React「同步 unmount during render」警告（不失败）；`use-markdown-surface` 的 80ms 合并缺 hidden 门控（成本可忽略）。
- `tests/fs-watch.spec.ts` 在并行全量下偶发超时（既有 flake，单价可复跑绿）。
- 关闭已绑定的侧聊页签仍会归档该线程（#942 既定行为），该路径对 subagent 行仍不可恢复。
