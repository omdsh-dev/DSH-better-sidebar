# 2026-10-24 GitHub 列表请求失败诊断

## 复现与原因

用户在线索页看到 `the GitHub CLI request failed`。在现有3080预览、当前工作区推导的 `omdsh-dev/DSH-better-sidebar` 仓库范围上，Issue／PR 的 `clues.list` 都稳定返回 HTTP500、code=failed 和上述消息。

同机 `gh 2.102.0` 登录状态成功；仓库 REST 读取及最小 GraphQL 读取均成功。执行插件 `listArgs()` 原样生成的命令，普通终端环境与插件白名单环境均得到：

- Issue：`Expected NAME, actual: (none) ("") at [1, 449]`。
- PR：`Expected NAME, actual: (none) ("") at [1, 532]`。

两条列表文档各缺少最外层 selection set 的一个右花括号。只给对应请求末尾补一个 `}`，其余 argv／账号／仓库不变，GitHub 即返回成功。搜索和读取文档的闭合原本正确。不是重新授权、换账号或网络配置问题。

## 最小修复与回归边界

- [gh.ts](../../src/clues/sources/github/gh.ts)：仅给 Issue／PR 列表查询各补一个闭合字符，不改字段、分页、缓存、权限或写入行为。
- [clues-github-gh.spec.ts](../../tests/clues-github-gh.spec.ts)：在现有公开来源客户端→CLI请求边界增加六组文档完整性检查，覆盖两种资源的浏览／搜索／读取。先观察到两个浏览用例失败，其余四个通过，再修复。
- 原有测试使用 canned provider response，只验证请求中的字段片段及返回结果，不能证明请求文档闭合；新增回归检查实际发出的完整文档。此检查针对已证实的 delimiter 回归，不宣称代替完整 GraphQL grammar／schema 校验；本次另用真实 GitHub 请求验收。
- 错误映射仍不回传原始 stderr、响应正文或凭据；不因排错扩大日志或登录权限。

## 验证入口

- 真实安装复现脚本：`.local/3080-preview/verify-github-ui18.cjs`，经现有预览登录地址认证，只调用 list／search／read，无远端写入。修复前执行退出1，红灯日志 `.local/3080-preview/github-ui18-red.log`。
- 最终单元：297文件，4297 passed／18 skipped；类型、定向lint、构建、消费方类型、引擎及diff检查通过。完整真实宿主：17 passed／3 skipped；日志为 `.local/3080-preview/unit-ui18-github.log` 和 `.local/3080-preview/e2e-ui18-github.log`。
- 只将同一测试tarball装入3080：`.local/3080-preview/dsh-better-sidebar-ui18-github.tgz`，SHA256 `420fc3dd4bc51870a6fd9ac7a87367460831cb6de6f0ce9572b4e362385043bc`。713归档文件与成功挂载实例逐项匹配，8个已安装bundle哈希匹配。
- 原复现脚本修复后退出0：真实Issue／PR列表均HTTP200，各返回30项并有后续游标；两种来源搜索和首项详情均HTTP200。元信息保留作者、编号、时间，PR保留branches及counts；证据 `.local/3080-preview/verification-github-ui18.json`。
- 实际中文Tab验证：Issue／PR均进入page状态，分别渲染25行，没有错误态或pageerror；证据 `.local/3080-preview/verification-github-page-ui18.json`，对应 `installed-ui18-github-{issues,pulls}.png`。未发送聊天或执行远端写入。
- 最终3080 PID24137；3384仍PID72737，启动命令及已安装client bundle哈希与本轮保护基线一致；证据 `.local/3080-preview/after-ui18-processes.json`。未修改官方DSH源码，未提交／推送／发布。

CLI参数规则参考[官方 gh api 文档](https://cli.github.com/manual/gh_api)：GraphQL的query以外字段作为变量。本次通过Context7查询官方文档；复现使用当前已安装CLI和实际来源代码，不依赖文档示例替代运行证据。
