# 划选引用 chip 的后半程：可点击 + 跳回源文件 + 行段闪光

**日期**：2026-11-03
**分支**：`feat/selection-quote-dev`（基于 `dev` `bd6cfa55`，插件 v0.29.0 线）
**状态**：已实施，门禁见 §6
**上游**：[#888](https://github.com/omdsh-dev/DSH-better-sidebar/issues/888)（功能提案，维护者建议在 #1052 落地后把「跳回 + 高亮」那半单独做）

---

## 1. 背景：前半程已经上岸，后半程还欠着

#888 要的东西分两半：

1. **落 chip**：划选 → composer 里一枚紧凑引用 chip，发送时展开成 `路径:起止` + 围栏正文。
2. **能跳回去**：点 chip → 侧边栏打开源文件、定位到被引行、把行段高亮出来。

第 1 半在 `dev` 已经是既成事实：#1052（`25fd296`）把「添加到对话」改成引用 chip，正文只在发送时展开；#1002（`f74369d`）再修掉「整框重写会把已有 chip 拍平成纯文本」。第 2 半没有任何实现——`dev` 的 chip 是可点区域没错，但 `source` 恒为 `'reference'`，宿主按这个 source 找不到任何 `openReference` 处理者，点击落到兜底的「当文件打开」上，而 `ref` 是整段围栏文本，不是路径。

所以这次的目标很窄：**不动 #1052 的任何既有行为，只让插件自己产出的 chip 变成可点击的、能跳回源位置的那种**。

## 2. 决定一：chip 必须归属一个插件自有的 input-trigger source

宿主 `@deepseek-ai/dsh-client-ui-input-trigger` 的 `ctx.inputTriggers.registerSource(src)` 是唯一的「注册点」通道，`InputTriggerSource` 上有两个可选成员正好对应用户要的两件事：

| 成员 | 宿主何时调用 | 本插件实现 |
|---|---|---|
| `openReference(session, { ref, appearance })` | 用户点 chip | 校验 chip 的会话 → `openFile(scope, path, undefined, { line, lineEnd })` |
| `codec.serialize(ref, signal)` | 用户发送、含该 source 的 chip | 还原 `路径:起止` + 围栏正文 |

关键事实：**chip 的 `ref.source` 就是注册时的 `name`**。宿主按名字路由点击（`owner.name === source && owner.openReference?.(...)`），也按名字找 codec；找不到 owner 或 owner 没有 codec 时，`serializeReference` 直接 `reject`，宿主**拒绝发送**而不是静默降级成剪贴板文本。这带来一条硬约束：**注册必须先于插入**。因此 commit 路径里先 `ensureRegistered()`，插入失败后如果发现 source 没注册成功，还会自愈重试一次。

本插件的 source 名是 `betterSidebarQuote`，`candidates` 恒返回空数组——它不进 `@` 菜单，只做 chip 归属，`onPick` 恒 `'handled'`（不可达）。

## 3. 决定二：`insertDraftReference` 只加两个可选字段，默认值不动

`dev` 的 `src/client/conversation-draft.ts` 里，chip 载荷是硬编码的：

```ts
const chip: SidebarReferenceInsert = {
  source: 'reference',
  ref: reference.text,
  label: reference.label,
  ...(reference.appearance === undefined ? {} : { appearance: reference.appearance }),
  clipboardText: reference.clipboardText ?? reference.label
}
```

改动就两行——`source: reference.source ?? 'reference'`、`ref: reference.ref ?? reference.text`，`PendingReference` 加 `source?` / `ref?`。这样 #1052 的调用方（`buildSelectionInsert` 的返回值）字节不变，落到宿主的仍是原来那个 `{source:'reference', ref:<围栏文本>}`；只有引用了 `source` 的调用方走新通道。

**为什么不重做个新函数**：`insertDraftReference` 里已经压了三件难做的事——按 `occurrences` 把「插件投影坐标」折成宿主检测投影坐标、按需要补前导空格、以及在 `snapshot.occurrences` 存在时走 span 通道而不是整框重写。复制一份去改 source 字段，等于把这三处一致性再维护一遍。

## 4. 决定三：`lineEnd` 走模块级一次性旁路，不写进宿主导航参数

`dev` 已有 #826 的行跳转链路：`openFile(scope, path, title?)` → `openTab({type:'editor', path, line})` → 原生承载面的 `navigation.params` → `NativeTabParams.line` → `targetLine` → 编辑器的定位 effect。

看起来最省事的做法是往 `navigation.params` 里再塞一个 `lineEnd`。但宿主对这张表的声明是：

```ts
interface SidebarRightResourceParamsMap {
  file: { line?: number }
  // …
}
```

`line` 之外的键**没有任何声明，也没有运行期校验**——今天能过，是因为宿主把 params 当不透明对象往下传；哪天它开始按声明裁剪或做形状校验，行段末端就会静默丢失，而且丢得没人知道（表现为「闪光没了」，不报错）。

改成插件自己的旁路：`src/client/line-target.ts` 是一个模块级 `Map`，key = `` `${path}#${line}` ``，值 = `{nonce, end?}`。`armLineEnd(path, line, lineEnd?)` 每次 arm 都自增 nonce；`peekLineTarget(path, line)` 是**纯读**（render-safe，丢弃的并发渲染不会吃掉 arm）；`consumeLineTarget(path, line)` 在编辑器把导航交给 viewer 后消费一次。`MAX_ARMED = 32`，超了淘汰最旧的。`openFile` 实现里先 `arm` 再 `openTab`；`EditorHost` 在 layout effect 里消费，并把 `(path#line, nonce)` 作为「已落地」身份。

**nonce 是二次点击修复的关键**：宿主 `tab-adapter` 只在 `params.line !== existing.tab.line` 时 patch 导航，同一个 chip 连点两次不会重发导航；只比较 `path#line` 会把第二次误判成已消费（不跳不闪），而残留的 arm 还可能让之后同 path#line 的普通打开误闪。带 nonce 后，每次点 chip 都是新导航，落地即消费。

路径安全性：armed 和 peek/consume 的是同一个 `path` 字符串（`openTab` 的 `path` 原样传递），不做 resolve——两边都来自同一个 `openFile` 调用，做规范化反而可能让两侧不一致。

## 5. 决定四：记录放 `localStorage`，因为模块有两个实例

`selection-quote.ts` 既被 core bundle 的 `index.tsx` 引用（注册 source），又被 lazy `editor` chunk 的 `TextEditor.tsx` 引用（插入 chip）。两次打包 → **两个独立的模块实例**，各自有各自的模块级 `Map`。注册发生在 core 实例里，插入发生在 editor 实例里，靠模块变量是看不见彼此的。

所以记录（`{id, sessionId, path, cwd, lines, text, label, clipboardText, n}`）落在 `localStorage` 的 `dsh-better-sidebar:quote-refs`，FIFO 200 条；两个实例每次读写都先 `readStoreIntoMemory()`（按 `id` 合并，保留量大的顺序）再操作。id 形如 `q<n>-<4 位随机>`——`n` 单调递增，便于 FIFO 排序，随机后缀避免两个实例在同一毫秒各自计数撞号。`text` 存的是 `buildSelectionInsert(...).text`（**已按 500 字符上限截断**的发送载荷），不是原始选区：否则 200 条大选区会撑爆配额，而配额失败后仍插 chip 会得到一个点不动、发送时被 codec 抛错阻断的死 chip。

**先持久化再插 chip**：`saveStore()` 返回是否真的写进 `localStorage`；写失败就回滚记录并让 `insertQuoteChip` 返回 false，调用方退回 #1052 的 chip 或纯文本。chip 插不进去（composer 拒绝）时同样删记录。旧分支是「保留记录」，结果是 localStorage 里堆一批永远没人引用的 id。

## 6. 决定五：闪光用皮肤令牌 + CodeMirror 行装饰

`src/client/quote-flash.ts`：

- `quoteFlashField` 是 `StateField<{from,to} | null>`，`quoteFlashEffect` 写入/清除，位置随编辑 `mapPos` 跟随（用户在被闪的行段上打字不会让装饰错位）。
- `quoteFlashHighlight` 把区间展开成逐行 `Decoration.line({class:'cm-quote-flash'})`——整行高亮而不是字符级，因为引用的是「行段」。
- `ensureQuoteFlashStyle()` 幂等注入 `<style id="dsh-quote-flash-style">`，颜色是 `color-mix(in srgb, var(--dsw-alias-interactive-bg-hover-accent) 55%, transparent)`，起闪帧 85%、`prefers-reduced-motion` 下 45% 且不做 transition。与 `src/client/cm-search.ts:95` 的既有先例同源，**零硬编码颜色**（AGENTS §5 皮肤契约没有豁免面）。
- 2.4 s 后 `dispatch(quoteFlashEffect.of(undefined))`；view 已被销毁（`view.dom.isConnected === false`）时定时器直接放弃。

## 7. 降级链与「绝不比升级前更差」

| 情形 | 结果 |
|---|---|
| source 已注册、chip 插得进去 | 可点击 chip，跳回 + 闪光 |
| 宿主无 `ctx.inputTriggers`（旧宿主 / 服务未就绪） | `insertQuoteChip` 返回 false → #1052 的内置 `source:'reference'` chip（不可点击，内容正确） |
| 注册被拒（例如 `openReference` 缺失、名字冲突且非幂等重复） | 同上 |
| composer 不在 `plain`/`claimed` 相位、`draftRev` 不匹配 | `insertReference` 返回 false → 同上 |
| 没有 chip 通道 | `insertReferenceOrText` 退纯文本 `appendToDraft` |

「重复注册」按宿主的真实契约处理：`registerSource` 对同名 source **必抛**（文案是 `slash source "@betterSidebarQuote" is already registered`，正则 `/already registered|duplicate/i` 命中）。那通常意味着另一个 bundle 实例持有 source，因此本次插入仍可继续；但本实例**没有 disposer**，无法感知那个 owner 何时卸载（fiber 释放在另一个实例里发生），所以每次 commit 都会重新探测：槽位一旦空闲就接管注册，避免「ready 标志永真、实际无人注册」的死 chip。

## 8. 门禁与实测

- `tsc --noEmit` 绿；`eslint` 改动文件零输出。
- 全量 `vitest run`：240 files / 3000 tests → 2983 passed、17 skipped、0 failed。
- 新增用例：`tests/selection-quote.spec.ts` 27、`tests/quote-flash.spec.ts` 13、`tests/line-target.spec.ts` 8，`tests/conversation-draft.spec.ts` +2，`tests/editor-line-nav-mode.spec.tsx` +1（同一 chip 连点两次仍跳转/闪光）。

## 9. 未覆盖 / 已知边界

- **底部工作台没有该入口**：chip 只打开右侧栏；底部 `TabContent → EditorHost` 是同一组件、同样消费 `line`（只是 `openFile` 不开到底部），本功能**未在底部真机验证**。
- **行号漂移**：记录的是划选时的行号快照；源文件之后被编辑，点击会落到同一行号（可能已偏移）。不做锚点搜索 / 内容定位，超出本次范围。
- **挂载 lane 没有 chip 冒烟**：`pnpm test:mount` 不覆盖「点 chip → 文件打开 → 闪光」，只覆盖到编辑器 chunk 加载。要真机验证得手工点一次。
- **多实例并发写 localStorage**：两个 bundle 实例同时插入时，后写者会覆盖前者的 `readStoreIntoMemory` 结果（窗口是毫秒级，实际是同一个用户操作串行发生）。没有加锁；如果将来出现丢记录的实测，再改成「写前重读 + 只 append 自己的 id」。
