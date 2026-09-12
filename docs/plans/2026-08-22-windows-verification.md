# Windows 真机验证手册:fs.search 原生引擎(fd / rg)

> 适用:PR #303(`feat/fs-search-engines`)。目标:在 Windows 真机验证引擎**探测、输出格式、降级链**三项,回应 review 对 Windows 格式问题的担忧。
> 预计耗时:方案 A 约 10 分钟,方案 B(完整链路)视环境多 10~20 分钟。

## 背景:要验证什么

| 验证点 | 风险 | 单测能否覆盖 |
|---|---|---|
| DSH 捆绑 rg 探测路径命中(Windows npm 布局 `%APPDATA%\npm\node_modules`) | 推导公式若错则静默回退 JS 遍历 | 仅形状断言,真机命中需实测 |
| rg 输出分隔符:`--path-separator /` 已钉死,Windows 上不再出现 `\` | 低(flag 自 rg 0.8 起存在) | 单测注入模拟,真机确认 |
| fd 输出:`--path-separator /` + CRLF | 低 | 同上 |
| 引擎输出 `.\` 前缀 / CRLF 残留 | 已由 `normalizeEnginePaths` 剥离 | 单测已钉 |
| 运行失败 → 引擎禁用 → 回退 JS 遍历 | 中(Windows 上 spawn 行为差异) | 单测已钉,真机补一刀 |
| 中文/Unicode 文件名搜索 | 编码问题 Windows 特有 | **不能**,只能真机 |

## 方案 A:模块级验证(不依赖 DSH,推荐先做)

在 Windows 主力机上,任意目录:

```powershell
# 1. 取代码(或直接在你已有的 clone 上 fetch)
git fetch origin feat/fs-search-engines
git checkout feat/fs-search-engines

# 2. 装依赖(已有 pnpm 跳过)与引擎
pnpm install
winget install sharkdp.fd            # fd:winget 包名 sharkdp.fd
winget install BurntSushi.ripgrep.MSVC   # rg:winget 包名(或 scoop install fd rg)

# 3. 跑 search 两组单测(Windows 上会走真实 win32 分支)
pnpm vitest run tests/search-engines.spec.ts tests/fs-search.spec.ts
```

期望:28 个用例全绿。若 `bundledRgCandidates` 的 win32 用例失败,把输出贴给我。

### 4. 真引擎输出形状检查(关键,单测模拟不了的)

```powershell
# 在旧版 cmd 中直接看引擎裸输出(fd 已验证 --path-separator;rg 是本次新加的)
cd $env:TEMP; mkdir wintest; cd wintest
New-Item -ItemType Directory src; New-Item src\a.ts; New-Item README.md
fd --hidden --no-ignore --exclude .git --fixed-strings --ignore-case --path-separator / --max-results 201 a .
rg --files --hidden --no-ignore --glob "!**/.git/**" --iglob "*a*" --path-separator / .
```

期望:全部输出 `/` 分隔、无 `\r`(若 PowerShell 里看有 `\n` 即可,重点是没有 `\` 和路径尾部 `\r`)。任意一行出现 `\` 或 `\r` 就是回归,贴给我。(**注意用旧版 cmd/PowerShell 跑**,Git Bash 下 rg 本来就输出 `/`,测不出问题。)

### 5. Unicode 文件名(编码验证)

```powershell
New-Item "中文文件名.ts"; New-Item "名前テスト.txt"
fd --hidden --no-ignore --fixed-strings --ignore-case --path-separator / 中文 .
rg  --files --hidden --no-ignore --iglob "*中文*" --path-separator / .
```

期望:两行都命中 `中文文件名.ts`,且输出不是乱码。这是"编码坑"仅存的最大真机风险点。

## 方案 B:完整链路(DSH + 侧边栏 UI)

前提:Windows 上有一份可跑的 DSH(用 `dsh --version` 确认;没有则 `npm i -g @deepseek-ai/dsh` 或参照 DSH 官方安装方式,装完再回来)。

```powershell
# 1. 确认 DSH 全局安装位置(决定捆绑 rg 探测根)
npm root -g    # 期望 %APPDATA%\npm\node_modules 或等价 npm 全局根

# 2. 确认捆绑 rg 存在(新候选公式应命中)
Test-Path "$(npm root -g)\@deepseek-ai\dsh\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe"
# 期望 True。False = 探测布局假设不成立,贴给我。

# 3. 装插件到 profile(按仓库 README/AGENTS.md 的挂载流程),然后：
$env:DSH_SEARCH_DEBUG = "1"
dsh web

# 4. 浏览器打开,在文件窗口搜一个常见词 + 一个中文词,各搜一次
# 5. 看调试日志
Get-Content "$env:USERPROFILE\.dsh\search-debug.log" -Tail 20
```

期望:
- 首搜有一行 `engines probed: rg(<捆绑 rg.exe 全路径>), fd(...)`——证明探测命中(Windows 布局修复生效)
- 每搜一行 `engine=rg ... hits=N ... ms`,命中数合理、无报错
- 中文词能搜到中文文件名(编码链路 OK)

若日志显示 `engines probed: none` 或 `engine=plain`,探测有问题;若命中但结果乱,是编码问题。两种情况都贴日志给我。

## 验收后要做的

- 把上面三段期望的结果(或失败日志)发我,由我决定是否还差修复
- 确认无误后回复 PR 评论,写明"Windows 真机已验证(装 fd + rg,模块级 + UI 链路)",附上本手册链接
---

## 实施偏差记录（2026-09-12）：CI 车道从 #335 并入本 PR

原计划由独立 PR #335 新增 `search-windows` lane 固化这批验证。main 在 2026-09-03 拿到自己的 `ci-windows` lane（#520：windows-latest 上跑 `pnpm test:windows` 全量套件）之后，那条独立 lane 的形态已经过时，本次把它并入 #303：

**保留并搬进 `ci-windows`**（`.github/workflows/ci.yml` 的两个步骤）：
- `choco install fd ripgrep -y --no-progress` —— 真引擎二进制进 PATH（在 `pnpm install` 之前）
- `node scripts/win-engine-check.cjs --assert` —— 套件结束后跑字节级断言

**为什么并进而不是单开 lane**：单开要把「装依赖 + 跑全量」再付一遍（CI 分钟翻倍）却不增加覆盖；并进来则整条套件都在引擎在场的环境下跑（覆盖面严格更大），断言只多两个步骤。引擎相关 spec 是插桩式的（`tests/search-engines.spec.ts` 经 `setEngineHooks` 注入 probe，文件头注释即写明「CI 机器没有 fd/rg」），因此引擎在不在 PATH 上都不改变单测结论——ubuntu 的 `ci` lane 继续覆盖「引擎缺失 → JS 遍历回退」。

**随 #303 一并升级**：`scripts/win-engine-check.cjs` 从「硬编码 `C:\Users\y\wintest` 的裸输出 demo」升级为 #335 的 `--assert` 版——每次运行自建 scratch 目录、引擎缺失即跳过、钉死 `--path-separator /` 的输出不得含 `\`/CR、中文文件名必须命中、失败非零退出。新增 `docs/ci-windows.md`（红线清单 / 历史平台修正 / 标准动作）并在 AGENTS.md §2 埋入口。

**丢弃的部分**（原因见上，均已由 main 独立落地，无需随本 PR 携带）：
- 独立的 `search-windows` job 与「全量测试」步骤 —— 由 `ci-windows` 承担
- `package.json` build 跨平台（`rm -rf lib` → `node -e rmSync`）—— 已在 main
- `tests/smoke.spec.ts` 钉 `core.autocrlf=false`、`tests/pty-deps.spec.ts` 平台断言 —— 已在 main
- #335 对 README/AGENTS.md 的引擎功能描述 —— 本 PR 的 rebase 已把该描述锚定到 README 的 v0.12.3 条目与 `docs/external-plugin-guide.md`
