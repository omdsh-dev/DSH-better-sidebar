# Git 折叠行真实展开——修复「点击展开」无反应

> 日期:2026-09-07 · 状态:计划已定,待实施 · 分支(拟):`fix/diff-fold-expand`
> 关联:上游 issue(待提)、上游 PR(待提,Closes issue)· 上游仓库 `omdsh-dev/DSH-better-sidebar`,本地 fork `LaoYueHanNi/DSH-better-sidebar`(main `6fbfeed` 与上游零差异)

## 1. 背景与 bug 确认(已核实)

**现象**:changes 组件点击 git 提交(或工作区 diff)后,diff 视图中 hunk 之间的折叠行显示「n 行…点击展开」,点击无反应(无 pointer/hover)。session(会话文件操作)lens 的折叠行可正常展开——仅 git lens 永远不可展开。

**证据链**:
- `src/client/diff/rows.ts` L407-433(`unifiedSegments`):git `-U3` 不输出 hunk 之间的未改动行,gap fold 段**只有行号范围、没有 `rows` 字段**(注释明确 "rows are unknown (non-expandable)");
- `src/client/diff/DiffRows.tsx` L193-228:`expandable = segment.rows !== undefined && segment.count >= MIN_FOLD`;`rows === undefined` 走静态分支(L197-202,**无 onClick、无 data-expandable**),但文案复用 `t('changesFold')` = zh「{count} 行…点击展开」/ en「{count} lines…click to expand」——承诺了不存在的交互;
- `src/client/diff/diff.module.css` L50-51:仅 `[data-expandable='true']` 有 pointer/hover,静态分支视觉上也不可点,唯独文字撒谎;
- session 路径(`diffLines` + `buildDiffSegments` → `foldOf`)的 fold 总有 `rows`,可正常 toggle 展开。

**上游调研结论**(2026-09-07,9 组中英文关键词 + PR 列表 + `git fetch` 源码比对):无 issue 报告过此问题(最接近的 #346 是「文件级默认折叠要多点一下」,方向相反),无已合并/进行中的修复——**全新发现**。

**已排除的轻量方案**:
- 纯改文案(原方案 A):不解决「看不到被折叠内容」的本质,用户拍板不做;
- 调大 `-U` 上下文:大 gap 依旧折叠且依旧不可展开,治标且 diff 变吵。

## 2. 目标与成功标准

点击 git 折叠行时**按需拉取两侧完整内容、按行号切片填充真实上下文行**,让「点击展开」名副其实。

1. git 提交/工作区 diff 折叠行点击后展开未改动上下文行(带双侧行号),再点可折叠;
2. session lens 行为完全不变;二进制/untracked 文件不受影响;
3. 内容拉取失败降级为无点击暗示的中性文案;
4. `pnpm typecheck` / `pnpm test` 全绿,CI 三 job(挂载冒烟/typecheck/test)绿;
5. 上游 issue(问题+预计方案)与 PR(实际修复,`Closes #N`)按仓库规范挂接。

## 3. 已确认的实现地基

- **服务端 `git.show` 路由已存在**(`src/index.ts` L474-480):payload `{rev, path}`(rev 可为 `:0` / `HEAD` / `<hash>^` / `<hashFull>`),返回 `{content: string | null}`,失败(null)内建于 `git.ts show()` 的 try/catch → **服务端零改动**;
- `src/git.ts` `diff()`(L382-388):unstaged = `git diff -- path`(**index vs worktree**),staged = `git diff --cached`(**HEAD vs index**)——决定展开时两侧 rev 取法;
- 渲染链:`DiffPane`(底部预览)/ `DiffTab`(独立 tab)→ `DiffFiles`(per-file `unifiedSegments`)→ `DiffRows`;op 路径直接 `DiffRows`(`buildDiffSegments`)。客户端 `api.ts` 尚无 `git.show` 封装(需补一行 call);
- `SidebarDiffRef`(`src/client/state.ts` L24-26):`worktree{path, staged, untracked?, worktree?, repoRoot?}` | `commit{hash, hashFull, subject, worktree?, repoRoot?}`;
- spawn 数组参数不经 shell,`<hash>^` 的 `^` 无需转义;`git show :0:<path>` 取 index 版本合法。

## 4. 实现设计(按子系统)

### 4.1 `src/client/api.ts` — gitShow 客户端封装
仿 `gitCommitDiff`(L317-318):
```ts
gitShow: (scope: SessionScope, rev: string, path: string, worktree?: string, signal?: AbortSignal) =>
  call<{ content: string | null }>('git.show', gitPayload(scope, worktree, { rev, path }), signal)
```
走既有 RPC 通道,不触构建纯度门。

### 4.2 `src/client/diff/rows.ts` — 切片纯函数
```ts
export function foldRowsFromContents(fold: FoldSegment, oldContent: string, newContent: string): readonly DiffRow[]
```
- 以 old 侧驱动 `[oldStart..oldEnd]` 逐行生成 `{kind:'context', oldLine, newLine?, text}`,`newLine = oldLine - oldStart + newStart`(仅当落在 `[newStart..newEnd]` 内才带);再以 new 侧驱动补纯新增段(old 映射不到的行,只带 `newLine`);
- 内容 `split('\n')` 切;空内容 = 空数组;行尾 `\r` 保留(与 git diff ctx 行行为一致)。

### 4.3 `src/client/diff/DiffRows.tsx` — 异步展开状态机
- 新 prop:`resolveFold?: (segment: FoldSegment) => Promise<readonly DiffRow[]>`(不传 = 现状,op 路径不变);
- 新 state:`foldData: Map<number, readonly DiffRow[]>`、`foldLoading: Set<number>`、`foldFailed: Set<number>`,随现有 useEffect(L119-123)在 segments 变化时整体重置;
- expandable 判定放宽:`(segment.rows !== undefined || resolveFold !== undefined) && segment.count >= MIN_FOLD`;
- 点击未填充的 git fold:置 loading → `resolveFold(segment)` → 成功存 `foldData`(渲染优先于 `segment.rows`)、失败标 `foldFailed`;
- 渲染三态:加载中 `t('changesFoldLoading')`;失败 `t('changesFoldUnavailable')`(无 onClick/pointer);正常沿用 `changesFold`(此时承诺为真);已展开的 fold 渲染 rows,再点折叠回。

### 4.4 `src/client/diff/DiffFiles.tsx` — loader 下传 + Promise 缓存
- 新可选 prop `resolveFold?: (file: DiffFile, segment: FoldSegment) => Promise<readonly DiffRow[]>`,转发 `DiffRows`;
- 实例级 `useRef<Map<string, Promise<readonly DiffRow[]>>>`,key = `displayPath(newPath)|oldStart|newStart`,同文件多 fold 共享一次内容拉取、并发点击天然去重;`parsed` 变化时重置。

### 4.5 `src/client/changes/DiffPane.tsx` / `src/client/DiffTab.tsx` — lens loader
按 `SidebarDiffRef` 构造传给 `DiffFiles`:
- **commit lens**:旧侧 `gitShow(scope, '<hashFull>^', displayPath(file.oldPath))`(root commit → null → ''),新侧 `gitShow(scope, hashFull, displayPath(file.newPath))`;与 `commitDiff` 的 `-m --first-parent` 语义一致;rename 由 `oldPath/newPath` 天然覆盖;
- **worktree lens**:`staged=true` → 旧 `HEAD` / 新 `:0`;`staged=false` → 旧 `:0` / 新侧 `api.fsRead` 工作区(`resolveSidebarPath(repoRoot ?? worktree ?? cwd, path)`,同现有 untracked fallback L196/L68 的写法);
- **staged 侧漂移修正(关键边缘)**:DiffPane L182-188 / DiffTab L49-57 在请求侧 diff 为空时 fallback 渲染另一侧,但 `gitRef.staged` 不变——把实际生效侧记为 state(如 `effectiveStaged`),loader 依它取数,否则切片行号错位;
- untracked 文件走 `untrackedFile` 全加渲染,无 fold,loader 不涉及。

### 4.6 i18n — 两个新 key,18 个语言文件全补
- `changesFoldLoading`:zh `展开中…` / en `Expanding…`
- `changesFoldUnavailable`:zh `上下文未加载` / en `Context unavailable`
- `locales.ts` 为基准;`locales-ja.ts` 同步是 AGENTS 硬性底线;其余 15 个 `locales-*.ts` 照 `changesFold` 现状全量补译;纯 `t()` 通道,不涉 `markdownTextProps()`。

### 4.7 测试(vitest,沿用现有模式)
- `tests/diff-rows.spec.ts` 增补 `foldRowsFromContents`:对称区间 / 纯删除 gap(old 有 new 无)/ 纯新增 gap / `\r\n` 行尾 / 空内容 / 行号越界截断;
- 新组件测试(参照 `tests/diff-files-collapse.spec.tsx`):mock `api.gitShow` → 点击 git fold 断言展开行渲染、再点折叠、失败降级文案、session fold 路径不受影响;
- 回归:`diff-rows` / `diff-files-collapse` / `diff-highlight` / `builtins` 全绿。

## 5. 边缘 case 清单(实现时逐条对照)

| 场景 | 处置 |
|---|---|
| root commit 无父 | `git.show` 返 null → 空串(旧侧视为空) |
| rename | `parseUnifiedDiff` 保留 oldPath/newPath,两侧各取各的 |
| 二进制文件 | 无 hunks,不渲染 DiffRows,不涉及 |
| untracked | `untrackedFile` 全加渲染,无 fold |
| 无换行文件 | `count` 与切片行数可差 1,展开后以实际行为准 |
| `\r\n` 行尾 | blob 行与 diff ctx 行同样保留 `\r`,一致 |
| staged fallback 侧漂移 | `effectiveStaged` state(§4.5) |
| 并发/重复点击 | Promise 缓存去重 |
| refresh / 切目标 | tick + segments 变化重置展开态 |
| 大文件 | 按需拉取不预取,失败降级兜底 |

## 6. 流程步骤(issue / PR 全文草稿)

### 步骤 1:向上游提 issue

```bash
gh issue create --repo omdsh-dev/DSH-better-sidebar \
  --title "[Bug] Git 提交/工作区 diff 折叠行显示「n 行…点击展开」,点击无反应" \
  --body-file <下方正文>
```

模板字段:环境 = `DSH Web(浏览器访问)`;类别 = `🐛 Bug`;DSH 版本可留空;插件版本 = `main(6fbfeed)`。

**描述字段正文**:

> **现象**:在「变更」面板点击历史提交(或查看工作区 diff)后,diff 视图中 hunk 之间的折叠行显示「n 行…点击展开」,但点击无任何反应(无 pointer 光标、无 hover);而会话文件操作(文件追踪)lens 的折叠行可以正常展开——仅 git lens 永远不可展开。
>
> **期望行为**:要么点击真实展开被折叠的上下文行,要么不显示「点击展开」字样。
>
> **复现步骤(Bug 必填)**:打开侧边栏 → 变更 → 历史 → 点击任一含多个 hunk 的提交 → 观察文件 diff 中 hunk 之间的折叠行 → 点击。
>
> **根因(代码定位)**:git 的 unified diff(`-U3`)不输出 hunk 之间的未改动行,`unifiedSegments`(`src/client/diff/rows.ts`)为此产生的 fold 段只有行号范围、没有 `rows`;`DiffRows`(`src/client/diff/DiffRows.tsx`)对 `rows === undefined` 渲染静态分支(无 onClick),但复用了含「点击展开」的 `changesFold` 文案,形成「承诺了不存在的交互」。

**补充信息字段正文**:

> **预计修正方案**:不采用纯改文案或调大 `-U` 上下文(治标),按需真实展开——点击折叠行时经既有 `git.show` 服务路由拉取该文件两侧完整内容(commit:`<hash>^` 与 `<hash>`;worktree staged:`HEAD` 与 `:0`;unstaged:`:0` 与工作区文件),按 fold 已知行号范围切片为 context 行填充渲染;per 文件 Promise 缓存,失败降级为中性文案。将在 fork 修好后提 PR(Closes 本 issue)。
>
> 截图:<用户提供的截图,展示「11 行…点击展开」行>

### 步骤 2:分支与实现

```bash
git checkout -b fix/diff-fold-expand   # 基于与上游一致的 main(6fbfeed)
```

按 §4 落地;同时新增本设计文档的正式版(本文件即底稿,文末补「实施偏差」节,惯例参照 `docs/plans/2026-09-06-changes-op-previews-design.md`)。

**提交拆分**(oyw-commit-style:`type(scope): 中文概括` + 无序列表 body + 背景动机段 + 决策记录伴随行;禁 AI 署名、禁 `--no-verify`):
1. `docs(diff): git 折叠上下文按需展开设计文档`
2. `feat(api): 暴露 gitShow 单文件版本内容读取`
3. `feat(diff): 折叠行异步展开状态机与内容切片`(rows.ts + DiffRows + DiffFiles + 测试)
4. `fix(diff): git lens 折叠行接入按需展开,修复点击无反应`(DiffPane/DiffTab + i18n + 组件测试)

每个 commit 保持 typecheck/test 可绿。

### 步骤 3:验证

```bash
pnpm typecheck && pnpm test          # 全量门禁
pnpm build && pnpm pack && pnpm test:mount   # 挂载冒烟(CI 同款)
```

真机点开含多 hunk 提交,验证展开/折叠/失败降级,截图用于 PR。

### 步骤 4:发 PR

```bash
git push -u origin fix/diff-fold-expand
gh pr create --repo omdsh-dev/DSH-better-sidebar --head LaoYueHanNi:fix/diff-fold-expand \
  --title "fix(diff): git 折叠上下文按需展开,修复「点击展开」无反应" --body-file <下方正文>
```

**PR body**:

> ## 问题
> Closes #<N>。git 提交/工作区 diff 的折叠行显示「n 行…点击展开」但点击无反应:`-U3` 裁剪使 `unifiedSegments` 的 gap fold 无行文本,渲染分支复用了含点击承诺的文案。
>
> ## 方案
> 点击时按需经 `git.show` 拉取两侧完整内容,按 fold 行号切片为 context 行填充;不预取(大 lockfile 场景零开销),per 文件 Promise 缓存去重并发,失败降级为「上下文未加载」中性文案。session lens 行为不变,服务端零改动(`git.show` 路由已存在)。
>
> ## 改动清单
> - `src/client/api.ts`:gitShow 封装
> - `src/client/diff/rows.ts`:`foldRowsFromContents` 纯函数
> - `src/client/diff/DiffRows.tsx`:`resolveFold` prop + 展开/加载/失败状态机
> - `src/client/diff/DiffFiles.tsx`:loader 下传 + Promise 缓存
> - `src/client/changes/DiffPane.tsx` / `src/client/DiffTab.tsx`:两种 lens 的取数映射(含 staged fallback 侧修正)
> - `src/client/locales*.ts` × 18:`changesFoldLoading` / `changesFoldUnavailable`
> - `tests/diff-rows.spec.ts` + 新组件测试
> - `docs/plans/…`:设计文档
>
> ## 测试
> - 新增:切片纯函数单测(对称/纯删/纯增/\r\n/越界);组件测试(mock gitShow:展开、折叠、降级)
> - 回归:`pnpm typecheck`、`pnpm test` 全绿;`pnpm test:mount` 冒烟通过
> - 截图:<展开前后对比>

### 步骤 5:review 跟进

按上游惯例(#499 经验)预判 review 关注点:皮肤令牌(本改动无颜色,不涉)、约定对齐(prop 命名/状态机形状)、i18n 完整性;整改意见在同分支追加 commit,重跑门禁。

## 7. 明确不做

- 不做纯文案拆分的「方案 A」单独 PR(失败降级文案已含在 B 内);
- 不调大 `-U` 上下文;
- 不改服务端;
- 不动 `changesFold` 现有文案(B 落地后「点击展开」对 git fold 也为真)。

## 8. 仓库规范备忘(实施时遵守)

- 代码改动必须走 PR(AGENTS §1);fork 侧开发,push 到 `LaoYueHanNi` 后向上游发 PR;
- 风格对齐:prop 命名、状态机形状、组件拆分与 CSS 模块组织以 `src/client/diff/` 现有实现为准,不引入新依赖/新工具/新交互模式;有歧义时参照上游最近合入的同类改动;
- i18n:zh 新 key 必须同步 ja(其余语言全补);
- 皮肤契约:无硬编码颜色(本改动无颜色);
- 提交信息遵循 oyw-commit-style,正文无序列表列改动点 + 背景动机段;
- 仅在用户明确说「提交」时才 commit;PR 创建前等用户批准。

---

## 实施偏差记录

> 实施过程中与本文设计的任何偏离,逐条记录在此(惯例:文档以本节为准)。

1. **语言文件数量**:§4.6 / §6 的「18 个语言文件」计数有误——实际变更点为 **20 个文件 21 处**(`locales.ts` 内 zh/en 双块 + 19 个 `locales-*.ts`:ar/de/fr/hi/id/ko/it/ja/pl/nl/pt/ru/sv/th/tr/vi/zh-HK/zh-MO/zh-TW),已全量补齐,PR body 计数随之更正。
2. **缓存拆为两层**:§4.4 把「同文件多 fold 共享一次内容拉取」归给 DiffFiles 的 fold 级 Promise 缓存,但 fold 级 key 含行号(`path|oldStart|newStart`),无法去重内容请求;实施时把内容拉取缓存上移到 lens 层(`DiffPane`/`DiffTab` 的 `foldContents`,key = `displayPath`),DiffFiles 的 fold 级缓存保留(价值:文件头折叠再展开导致 DiffRows 重挂载后秒开、并发点击去重,reject 时摘除)。两层各司其职。
3. **loading 态交互与竞态防护**:§4.3 三态渲染之外,加载中的 fold 不响应点击且无 pointer(`data-expandable` 移除),防 loading 期间重复触发;另以 `foldEpoch` ref 使 segments 重置后 still-in-flight 的 resolve 回调失效,防「旧 fold 的迟到结果写进新 segments 同下标」竞态(§4.3 未展开)。
4. **unstaged 新侧读取失败的宽容降级**:§4.5 未细化——工作区侧 `fsRead` 失败(如文件已删除)或返回二进制时降级为空串(catch → null → `''`)而非整体 failed,让旧侧(index)上下文依然可展开。
5. **DiffPane 组件级 gitScope**:fold loader 需要 SessionScope,新增组件级 `gitScope`(useMemo);load effect 的局部 `paneScope` 保持原样不动,最小侵入。
6. **本机测试基线**:Windows 本机全量跑 `tests/git.spec.ts` / `tests/git-worktree.spec.ts` 中 3 个真实 git 子进程集成用例会并发抖动失败(stash 后基线复现同样失败,与本次改动无关;CI Linux 绿)。diff 相关 18/18 全绿(新增 `foldRowsFromContents` 6 用例 + 组件测试 4 用例)。
7. **本地挂载冒烟未执行**:Windows 本地 Git Bash 下 `e2e-mount.sh` 将 tarball 规范为 MSYS 风格 `/d/...`,`file:` scheme 前缀使 MSYS 自动参数转换失效,Windows node 解析为 `C:\d\...` 而 ENOENT(经 `DSH_CMD` 注入 cygpath wrapper 可绕过,再因依赖下载网络受限放弃);`pnpm build` 产物构建已绿,挂载冒烟由 CI `plugin-mount` job 同款覆盖。
8. **服务端零改动前提被证伪(真机修正)**:§3/§5 的「git.show 路由已存在、服务端零改动」不成立——该路由此前无真实调用方,其 path 经 `resolveGitPath` 解析为绝对文件系统路径(工作区命令语义),而 `git show <rev>:<path>` 只接受仓库相对路径,恒 fatal 返 null,两侧空串切片 0 行,展开表现为「marker 消失、零行渲染」(link 真机首测发现)。修正:路由透传仓库相对路径(diff 输出剥前缀的形态,暴露面与 git.diff/git.log 一致,仅本仓库版本树),另在两 lens 加「两侧皆空 → 降级『上下文未加载』」防御,取数异常不再静默空白展开。
