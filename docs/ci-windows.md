# Windows CI 维护指南(search-windows lane)

> 面向后续开发者:什么时候、为什么、怎么给 Windows 上的新功能加 CI 测试。

## 1. 这条 lane 是什么

`.github/workflows/ci.yml` 的 `search-windows` job 在 **windows-latest** runner 上:

1. `choco install fd ripgrep`——装**真引擎二进制**(probe 从 PATH 探测,与真实用户环境一致)
2. `pnpm install --frozen-lockfile`
3. `pnpm typecheck`
4. `pnpm test`——**全量 vitest 套件**(75 文件 / 776 用例)在真实 win32 Node 下跑
5. `pnpm build`——构建产物(注意:build script 已跨平台,禁回退到 `rm -rf`)
6. `node scripts/win-engine-check.cjs --assert`——用真 fd/rg 跑**字节级断言**:钉死的 `--path-separator /` 输出不得含 `\`/CR,中文文件名必须命中;任一失败 → 红灯

**Windows 全量是绿的**(2026-08-22 真机验证:773 passed / 3 skipped —— 全绿的达成靠两个平台修正,见下文 §3)。这条 lane 不存在"Windows 例外测试不用跑"的说法——**新功能必须让全量保持绿**。

为什么曾有"只跑部分"的想法:最初 `pnpm test` 在 Windows 上有 4 个失败(3 个 smoke 的 CRLF 断言 + 1 个 pty-deps 的平台断言),都是测试自身不跨平台,不是产品 bug;修掉后全量直接绿,于是 lane 演进为全量门禁。**平台的坑应当修在测试里,而不是把测试从 Windows 门禁里排除**。

## 2. 什么功能需要加 Windows 测试(红线清单)

后续新功能**只要涉及以下任一项,就必须保证 `search-windows` lane 全绿**(新增测试或修正平台断言):

| 风险类别 | 具体坑(本仓库实测/已知) | 加测试的位置 |
|---|---|---|
| **子进程 spawn 外部命令** | PATH 解析、`.exe` 后缀、Windows 上 cmd/PowerShell 与 Git Bash 输出不同(rg#501:同一 rg,`\` vs `/`) | spec 注入 runner + `--assert` 真二进制检查 |
| **路径字符串处理** | `\` vs `/` 分隔符、`.\` 前缀、CRLF 行尾、盘符/UNC、`MAX_PATH` 长度 | 把 Windows 形状的用例写进 spec(可给纯函数注入 `'\\'` 模拟,见 `normalizeEnginePaths` 测试) |
| **编码/Unicode 文件名** | UTF-8 管道 vs 系统代码页(GBK);中文/日文文件名 | `win-engine-check.cjs --assert` 的 Chinese 用例 |
| **依赖探测/环境布局** | 全局安装目录布局随 OS 不同(npm POSIX `lib/node_modules` vs Windows `%APPDATA%\npm\node_modules`) | `bundledRgCandidates` 的 win32 形状断言(已有);真实布局靠真机/CI 验证 |
| **文件系统语义** | symlink 权限(测试已有 `skipIf(!canSymlink)` 先例)、大小写不敏感、保留名(CON/NUL)、**git autocrlf 行尾**(smoke.spec.ts 先例:平台相关断言修进测试) | `skipIf` 平台门控或平台形状断言 |
| **原生模块/node-gyp** | node-pty 等需要 Windows 构建链(conpty);CI 的 `pnpm install` 已覆盖(含 approve-builds 配置) | 若新增原生依赖,确认 CI install 绿即可;修复命令的断言要按平台(pty-deps.spec.ts 先例) |

## 3. 历史平台修正(保持警觉的样板)

这些修正让 Windows 全量变绿,也是"平台坑修在测试里"的范例——**不要回退它们**:

- `tests/smoke.spec.ts`:scratch repo 钉 `git config core.autocrlf false`(Windows 默认 autocrlf=true 会把 checkout 文件转 CRLF,精确 LF 断言会挂;测试测的是 git 驱动逻辑,不是行尾转换)
- `tests/pty-deps.spec.ts`:`depsStatus()` 按**真实平台**生成修复命令(win32 → `powershell -Repair`,POSIX → `bash --repair`),断言必须按平台写,fixture 建双安装脚本

## 4. 怎么加(标准动作)

```yaml
# ci.yml → search-windows job → 新增断言步骤:
- name: <你的断言说明>
  run: pnpm vitest run tests/<你的spec>.spec.ts   # 或 node scripts/<检查脚本> --assert
```

同时:
1. **新 spec 必须放进全量**(vitest 默认收集 `tests/*.spec.ts`,新文件自动进 `pnpm test`,无需改 ci.yml);
2. **必须考虑 Linux 行为**:同一 spec 在 ubuntu lane 也会跑,平台差异用显式注入/`skipIf` 表达(参考 `tests/fs-search.spec.ts` 的 `canSymlink` 模式与 `normalizeEnginePaths` 的 separator 注入);
3. **检查脚本**(如 `scripts/win-engine-check.cjs`)**必须可幂等**:自建 scratch 目录(勿硬编码路径)、引擎缺失时跳过而非失败(CI 有 fd/rg,本地无则跳过)、`--assert` 退出码非零才是失败;
4. 新脚本放 `scripts/`,命名 `win-*.cjs`,README/设计文档顺带记录。

## 5. 排查红灯速查

- **全量跑挂**:先本地(任意 OS)`pnpm vitest run`,看是否平台无关逻辑问题;再在 Windows 真机 `pnpm vitest run` 复现
- **只有 Windows 挂**:八成是上面红线清单里的一项;用 `scripts/win-engine-check.cjs`(无 `--assert`)看引擎裸输出
- **choco 装引擎失败**:runner 镜像偶发;重跑 job 即可(保底可改 winget)
- **真机复验**:见 `docs/plans/2026-08-22-windows-verification.md`(完整链路手册)

## 6. 设计背景(为什么值得)

issue #203:大目录下 JS 遍历又慢又截断;搜索模块引入 fd/rg。**Windows 恰好是格式坑最多的平台**(分隔符/CRLF/布局),此前完全无 CI 覆盖;`search-windows` lane 把这批真机验证(2026-08-22)固化成每次提交的全量门禁。更多实测数据见设计文档 §5「Windows 真机验收」。