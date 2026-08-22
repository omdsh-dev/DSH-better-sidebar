# Windows CI 维护指南(search-windows lane)

> 面向后续开发者:什么时候、为什么、怎么给 Windows 上的新功能加 CI 测试。

## 1. 这条 lane 是什么、为什么这么轻

`.github/workflows/ci.yml` 的 `search-windows` job 在 **windows-latest** runner 上:

1. `choco install fd ripgrep`——装**真引擎二进制**(probe 从 PATH 探测,与真实用户环境一致)
2. `pnpm typecheck`
3. `pnpm vitest run tests/search-engines.spec.ts tests/fs-search.spec.ts`——搜索模块**全部**单测/测试(31 个用例)在真实 win32 Node 下重跑
4. `node scripts/win-engine-check.cjs --assert`——用真 fd/rg 跑**字节级断言**:钉死的 `--path-separator /` 输出不得含 `\`/CR,中文文件名必须命中;任一失败 → 红灯

**为什么没有跑全量 `pnpm test`**:

| 障碍 | 说明 |
|---|---|
| `agent-pty` / `smoke` | PTY/环境敏感测试,在无头 Windows runner 上会误红(与代码正确性无关) |
| `pnpm build` | build script 用 Unix `rm -rf`,Windows 不存在(**如果你要改 build script 使其跨平台,可以在这一 lane 加 build 步骤**) |
| `plugin-mount` | Playwright + Chromium + 完整 DSH 挂载,重(30 分钟级),且 e2e-mount.sh 是 bash |

**渐进路径**:先守住"最容易在 Windows 出问题、且本 PR 已验证"的搜索模块;后续可以 ① 修 build 跨平台后加 build 步骤;② 逐步把不依赖 PTY 的测试纳入全量 vitest;③ 把完整挂载链路挪到 Windows(review 跟进时再评估)。

## 2. 什么功能需要加 Windows 测试(红线清单)

后续新功能**只要涉及以下任一项,就必须在 `search-windows` lane 加对应测试**,否则 Windows 用户会成为盲区:

| 风险类别 | 具体坑(本仓库实测/已知) | 加测试的位置 |
|---|---|---|
| **子进程 spawn 外部命令** | PATH 解析、`.exe` 后缀、Windows 上 cmd/PowerShell 与 Git Bash 输出不同(rg#501:同一 rg,`\` vs `/`) | spec 注入 runner + `--assert` 真二进制检查 |
| **路径字符串处理** | `\` vs `/` 分隔符、`.\` 前缀、CRLF 行尾、盘符/UNC、`MAX_PATH` 长度 | 把 Windows 形状的用例写进 spec(可给纯函数注入 `'\\'` 模拟,见 `normalizeEnginePaths` 测试) |
| **编码/Unicode 文件名** | UTF-8 管道 vs 系统代码页(GBK);中文/日文文件名 | `win-engine-check.cjs --assert` 的 Chinese 用例 |
| **依赖探测/环境布局** | 全局安装目录布局随 OS 不同(npm POSIX `lib/node_modules` vs Windows `%APPDATA%\npm\node_modules`) | `bundledRgCandidates` 的 win32 形状断言(已有);真实布局靠真机/CI 验证 |
| **文件系统语义** | symlink 权限(测试已有 `skipIf(!canSymlink)` 先例)、大小写不敏感、保留名(CON/NUL) | `skipIf` 平台门控或平台形状断言 |
| **原生模块/node-gyp** | node-pty 等需要 Windows 构建链(conpty);CI 的 `pnpm install` 已覆盖(含 approve-builds 配置) | 若新增原生依赖,确认 CI install 绿即可 |

## 3. 怎么加(标准动作)

```yaml
# ci.yml → search-windows job → 倒数几个 name:
- name: <你的断言说明>
  run: pnpm vitest run tests/<你的spec>.spec.ts   # 或 node scripts/<检查脚本> --assert
```

同时:
1. **必须**把 spec 放进 **Windows vitest 命令**的列表里(把 `tests/<你的spec>.spec.ts` 追加到 `Search specs` 步骤的 `run` 末尾);
2. **必须**考虑 Linux 行为:同一 spec 在 ubuntu lane 也会跑,平台差异用显式注入/`skipIf` 表达(参考 `tests/fs-search.spec.ts` 的 `canSymlink` 模式与 `normalizeEnginePaths` 的 separator 注入);
3. **检查脚本**(如 `scripts/win-engine-check.cjs`)**必须可幂等**:自建 scratch 目录(勿硬编码路径)、引擎缺失时跳过而非失败(CI 有 fd/rg,本地无则跳过)、`--assert` 退出码非零才是失败;
4. 新脚本放 `scripts/`,命名 `win-*.cjs`,README/设计文档顺带记录。

## 4. 排查红灯速查

- **两套单测跑挂**:先 `pnpm vitest run tests/search-engines.spec.ts tests/fs-search.spec.ts` 在本地(任意 OS)复现——平台无关逻辑问题
- **只有 Windows 挂**:八成是上面红线清单里的一项;用 `scripts/win-engine-check.cjs`(无 `--assert`)看引擎裸输出
- **choco 装引擎失败**:runner 镜像偶发;重跑 job 即可(保底可改 winget)
- **真机复验**:见 `docs/plans/2026-08-22-windows-verification.md`(完整链路手册)

## 5. 设计背景(为什么值得)

issue #203:大目录下 JS 遍历又慢又截断;本 PR 引入 fd/rg。**Windows 恰好是格式坑最多的平台**(分隔符/CRLF/布局),此前完全无 CI 覆盖;`search-windows` lane 把这批真机验证(2026-08-22)固化成每次提交的门禁。更多实测数据见设计文档 §5「Windows 真机验收」。