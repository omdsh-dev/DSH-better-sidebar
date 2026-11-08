# 发版手册

> 发版只有一条路：`dev` 准备 → 门禁 → 合 `main` → 打 tag → GitHub Release 触发 npm 发布。
> 本文是这条路的完整说明，含 Release note 的格式与写作规则。日常规则见 [AGENTS.md](../AGENTS.md)。

## 1. 版本线与 dist-tag

- 版本号 `X.Y.Z`；预发布带后缀（`X.Y.Z-alpha.N` / `X.Y.Z-rc.N`）。
- [release.yml](../.github/workflows/release.yml) 在 **GitHub Release 发布**时触发；版本号含 `-` 发到 npm 的 `alpha`，否则发到 `latest`。
- 认证走 npm **Trusted Publishing（OIDC）**，不配 `NPM_TOKEN`，provenance 随包上传。
- 只验证不发版：`gh workflow run release.yml --ref main -f dry_run=true`。

## 2. 什么时候可以发

- `dev` 三条 lane 全绿：`ci`（typecheck / lint / test / build / consumer-types）、`ci-windows`、`plugin-mount`。
- `CHANGELOG.md` 的 `### 未发布` 段就是这次 Release note 的素材；影响用户的变化都必须已经写进去。
- 动过承载面（客户端渲染 / tab / 原生侧栏 / 编辑器 / 路由）的批次，合入前必须真跑过 `pnpm test:mount`——只在本地跑 vitest 不够，v0.30.0 就吃过这个亏。

## 3. 标准流程

### 步骤 1 · 准备提交（在 `dev`）

```sh
git checkout dev && git pull --ff-only
# 改版本号与文档（见 §4 清单）
git add -A && git commit -m "chore(release): prepare vX.Y.Z"
git push origin dev
```

提交信息里逐条列出改了什么（版本号、CHANGELOG、README 安装命令、指南版本行），与历史一致。

### 步骤 2 · 门禁

```sh
PATH=/tmp/dsh-pnpm:$PATH pnpm typecheck
PATH=/tmp/dsh-pnpm:$PATH pnpm test          # 全量；fs-watch 满载 flake 隔离复跑
```

发版前**不再**重跑 mount lane——它属于批次门禁；若本批没跑过，现在补跑。

### 步骤 3 · 合入 `main`

```sh
git checkout main && git pull --ff-only
git merge --no-ff dev -m "release: merge dev for vX.Y.Z (<一句话摘要>)"
git push origin main
```

**先 fetch**：`main` 上可能有网页端直接提交的 README 改动，落后者会 non-fast-forward。

### 步骤 4 · 打 tag

```sh
git tag -a vX.Y.Z -m "vX.Y.Z — <中文摘要> / <English summary>"
git push origin vX.Y.Z
```

tag 必须指向 `main` 的 release merge 提交；注释 tag（`-a`）。

### 步骤 5 · 建 GitHub Release（触发发布）

```sh
gh release create vX.Y.Z \
  --title "vX.Y.Z — 中文标题 / English Title" \
  --notes-file /tmp/release-notes-vX.Y.Z.md \
  --verify-tag
```

正文按 §5 模板写，**发布前通读一遍**：面向用户、双语、贡献者署名齐全。

### 步骤 6 · 验证发布

```sh
gh run list --workflow=release.yml --limit 1        # build · verify · publish 成功
curl -s https://registry.npmjs.org/-/package/dsh-better-sidebar/dist-tags
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/dsh-better-sidebar/X.Y.Z
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/dsh-better-sidebar/-/dsh-better-sidebar-X.Y.Z.tgz
```

npm 元数据传播有延迟（实测 v0.30.0 约 8 分钟才可见），期间版本端点 404 属正常，**不要**急着重跑发布流程（重跑也会以「版本已存在」失败，并留下一条红色 run）。

## 4. 版本号与文档同步清单

| 文件 | 改什么 | 守护 |
| --- | --- | --- |
| `package.json` | `version` | — |
| `dsh.plugin.json` | `version` | `tests/plugin-meta.spec.ts` |
| `src/client/service.ts` | `SIDEBAR_SERVICE_VERSION` | `tests/service.spec.ts`（与 package.json 锁步） |
| `CHANGELOG.md` | `### 未发布` → `### vX.Y.Z` | `tests/changelog-integrity.spec.ts` |
| `CHANGELOG_EN.md` | `### Unreleased` → `### vX.Y.Z` | 同上 |
| `README.md` / `README_ZH.md` | 安装命令 `@X.Y.Z`、`install.sh X.Y.Z` / `-Version X.Y.Z`、版本对照表、Recent Updates 顶部一块（保留最近三条） | — |
| `docs/external-plugin-guide.md` | 「当前版本」行 | — |
| `docs/dsh-version-adaptation.md` / `AGENTS.md` | **仅当支持线变化**（抬基线 / 新增 peer） | `tests/market-manifest.spec.ts` / `tests/dsh-baseline.spec.ts` |
| `.github/workflows/ci.yml`、`scripts/e2e-common.sh`、`scripts/install.sh`、`scripts/install.ps1` | **仅当抬基線**，见 [dsh-version-adaptation.md](dsh-version-adaptation.md) | 同上 |

## 5. Release note 格式

### 必须有的四段

1. **安装 / Installation**：一行要求（DSH 版本线）、安装命令、硬刷新提醒、版本对照表、支持线警告。
2. **中文｜本版更新**：按主题分节（功能 → 修复 → 性能 → 质量），每节写用户能感知的行为与影响面。
3. **贡献者与致谢 / Contributors & thanks**：表格 `| 贡献者 | 本版贡献 | PR |`，一人一行、`@handle` + PR 链接；末尾维护者一行（做了什么 + 集成与发布）。本版没有外部贡献者时只保留维护者一行。
4. **English｜What's new in vX.Y.Z**：与中文逐节对应，不是机翻摘要。

页脚固定一行指向**该 tag 下**的 CHANGELOG：`blob/vX.Y.Z/CHANGELOG.md`。

### 三条硬规则

- **面向用户**：写现象、变更、影响面；不写内部发布细节（例如某个版本是否曾经发布、内部代号、CI 流水账）。
- **贡献者必须署名**：每一个合入本版的贡献者 PR 都要出现在表里，并注明做了什么；漏掉署名等同于吞掉别人的工作。
- **不虚构**：只写本次真正合入的内容；数字必须是实测过的。

### 模板

````md
## 安装 / Installation

**要求 DSH <版本线> 或更新的同线版本。 / Requires DSH <line> or a newer release on the same line.**

```sh
dsh plugin --profile web add dsh-better-sidebar@X.Y.Z
```

将 `web` 换成你实际使用的 profile 名。安装或更新后，按 **Cmd/Ctrl + Shift + R** 硬刷新浏览器。
Replace `web` with your profile name. After installing or updating, **hard-refresh the browser with Cmd/Ctrl + Shift + R**.

| DSH 版本 / DSH version | 插件版本 / Plugin version |
| --- | --- |
| <线 A> | **X.Y.Z** |
| <线 B> | `<旧版本>` |

> ⚠️ 插件版本必须与宿主线匹配：0.x 的依赖范围不跨 minor，一个构建只服务一条宿主线。
> Match the plugin to your host line — one build serves one host line.

---

## 中文｜本版更新

### 🎯 <主题一：一句话说清用户能看到什么>
<现象 / 原因 / 现在的行为 / 影响面>

### 🩹 其他修复
- **<子项>**：<一句用户能懂的话>

### ⚡ 性能
### 🧪 质量
类型检查与全量单元测试通过，<另外做了什么真机/挂载验证>。

---

## 贡献者与致谢 / Contributors & thanks

感谢本次发布范围内提交功能与修复的贡献者！

| 贡献者 / Contributor | 本版贡献 / Contribution | PR |
| --- | --- | --- |
| @handle | <中文> / <English> | [#N](https://github.com/omdsh-dev/DSH-better-sidebar/pull/N) |

维护者 @Menghuan1918 <做了什么>，以及本批的复核、集成与发布。
Maintainer @Menghuan1918 <what they did>, plus this batch's review, integration and release.

---

## English｜What's new in vX.Y.Z

<与中文逐节对应>

---

**完整变更 / Full changelog**：[CHANGELOG.md](https://github.com/omdsh-dev/DSH-better-sidebar/blob/vX.Y.Z/CHANGELOG.md) · [CHANGELOG_EN.md](https://github.com/omdsh-dev/DSH-better-sidebar/blob/vX.Y.Z/CHANGELOG_EN.md)
````

## 6. 热修复

- 从 `dev` 切 `fix/*` → 合回 `dev` → 走上面整条流程（patch 版本号）。
- npm **同版本不可覆盖**：修好必须 bump 新版本，不能改写已发布的 tag。
- 只改文档类的小修补也要发版才能到用户手里（README 除外——它随仓库走）。

## 7. 失败与回滚

| 阶段 | 处理 |
| --- | --- |
| 准备提交 / 合 main 之前 | 直接改，无副作用 |
| tag 已推、Release 未建 | 删 tag 重来：`git push origin :refs/tags/vX.Y.Z` |
| Release 建了但发布失败 | 看 Actions 日志修好，重新 `publish`（同版本未发出时可直接重跑） |
| 已发布到 npm 且有问题 | **回退不可能**：发 patch 版本；必要时 `npm deprecate dsh-better-sidebar@X.Y.Z "<原因>"` |
| Release note 写错 | `gh release edit vX.Y.Z --notes-file <新文件>`（不会重新触发发布） |

## 8. 常见坑

- `main` 被网页端直接提交过 → push 前必须 `git pull --ff-only`，release merge 要重做在最新首提交上。
- 本地 `pnpm` 走桌面端的 corepack shim 时版本校验会失败 → 用 `PATH=/tmp/dsh-pnpm:$PATH` 之类的固定 pnpm。
- Release note 里漏写贡献者、或写进内部发布细节，是本仓库明确回过炉的两类错误。
