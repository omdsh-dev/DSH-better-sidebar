# Office 三件套预览 — 设计文档

> 日期:2026-08-10
> 状态:已批准(待实现)
> 范围:`dsh-better-sidebar` 插件,`EditorView` 文件类型扩展

## 1. 背景与目标

当前 `EditorView.tsx` 对 `.docx/.xlsx/.pptx` 及旧格式 `.doc/.xls/.ppt` 一律显示 binary 占位(`EditorView.tsx:210`),因为 host 的 `readText` 检测到 NUL 字节就标记 binary(`src/index.ts:108`),而 Office 文件本质是 zip。

**目标**:为 Office 三件套新增有意义的预览能力,保持插件现有架构纪律(host 零改动、bundle 纯度门、跨平台、失败模式全覆盖)。

**非目标**:
- 不做 Office 文件编辑(只预览)
- 不做 `push/pull/fetch` 之类网络 Git 操作(与本次无关,沿用 v1 限制)
- 不做文件 watcher

## 2. 范围与选型

| 类型 | 方案 | 库 | 加载策略 | host 改动 |
|---|---|---|---|---|
| `.docx` | 保真渲染(保留样式/页眉页脚/图片/表格) | `docx-preview` | 静态 import(~500KB,小) | 零 |
| `.xlsx` | 完整电子表格(公式/图表/条件格式/多 sheet) | `@univerjs/*` 全家桶 + `xlsx`(SheetJS,导入) | `dynamic import()` 懒加载(~5MB,首次打开 .xlsx 才加载) | 零 |
| `.pptx` | 降级下载按钮 | — | — | — |
| `.doc/.xls/.ppt`(OLE 二进制) | 降级下载按钮 | 纯前端无成熟库 | — | — |

**决策依据**:
- 纯前端路线符合现有 bundle 纯度门(`tsdown.config.ts:128` 的 purity gate 只禁 `@deepseek-ai/*` value import,普通 npm 包内联不受限)与跨平台原则(无需 host 装重依赖)。
- `pptx` 纯前端无成熟渲染库( OOXML slides + layouts + masters + shapes 解析极复杂),YAGNI 降级。
- 旧 OLE 二进制格式(`.doc/.xls/.ppt`)纯前端基本无解,降级。
- Univer 选 dynamic import 懒加载:静态内联会让 client bundle 从 2MB→7MB(gzip 1.5MB→3MB),首屏负担过重。

## 3. 架构

### 3.1 host 半:零改动

复用现有 `/sidebar/file` media route(`src/index.ts:349-392`):
- 该路由已支持任意文件字节(不限扩展名,只检查 `isWithin(cwd, path)` + `isFile` + `size <= mediaLimit`)
- `MEDIA_TYPES`(`index.ts:44`)对 Office 扩展名 fallback 到 `application/octet-stream`,client 用 `fetch` 拿 ArrayBuffer,不依赖 content-type
- `mediaLimit` 默认 20MB,对 Office 文件足够(超限降级下载)

**不改 `fs.read`**:Office 文件不走文本读取路径(会被 NUL 探测当 binary 拒绝),直接走 media route。

### 3.2 client 半:EditorView 类型扩展

`EditorLoad` 类型(`EditorView.tsx:26`)扩展:

```ts
type EditorLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; kind: 'text' | 'image' | 'md' | 'docx' | 'xlsx'; content: string; truncated: boolean }
  | { status: 'binary' }  // 现保留:未知二进制 / pptx / OLE 旧格式 → 下载按钮
```

加载流程(`EditorView.tsx:60` 的 `useEffect`):
1. `api.fsRead(scope, path)` 仍调(用于探测 binary/text)— 对 Office 文件会返回 `{kind:'binary'}`,据此分流
2. 识别扩展名 ∈ `{.docx, .xlsx}` → `setLoad({ status:'ready', kind:'docx'|'xlsx', content:'', truncated:false })`
3. 识别 `.pptx` / `.doc` / `.xls` / `.ppt` / 其他未知 binary → 保持 `{status:'binary'}`,但 binary 占位改为"下载查看"按钮(见 §3.5)
4. `IMAGE_EXT` / `MD_EXT` 分支不变

> 备注:step 1 的 `fsRead` 对 Office 文件是冗余往返(必定返回 binary)。可选优化:client 侧先按扩展名短路,Office 扩展名直接走 media route 不调 `fsRead`。实现时取短路方案,省一次请求。

### 3.3 文件类型分发(纯函数,易测)

新增 `src/client/office-types.ts`:

```ts
export const OFFICE_PREVIEWABLE = ['.docx', '.xlsx'] as const
export const OFFICE_DOWNLOAD_ONLY = ['.pptx', '.doc', '.xls', '.ppt'] as const

export type OfficeKind = 'docx' | 'xlsx' | 'download-only' | null

export function officeKindForExt(ext: string): OfficeKind {
  if (ext === '.docx') return 'docx'
  if (ext === '.xlsx') return 'xlsx'
  if (['.pptx', '.doc', '.xls', '.ppt'].includes(ext)) return 'download-only'
  return null
}
```

`EditorView` 的 `extOfPath` 已有(`EditorView.tsx:235`),复用。

### 3.4 DocxView / XlsxView 组件

新增 `src/client/office-view.tsx`,导出 `DocxView` 与 `XlsxView`,各自管理库生命周期。

#### DocxView

```tsx
export function DocxView(props: { scope: SessionScope; path: string; title: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [load, setLoad] = useState<{status:'loading'|'ready'|'error'; message?: string}>({status:'loading'})

  useEffect(() => {
    let cancelled = false
    const container = hostRef.current
    if (container === null) return
    ;(async () => {
      try {
        const buf = await fetch(mediaUrl(scope, path)).then(r => r.arrayBuffer())
        if (cancelled) return
        const { renderAsync } = await import('docx-preview')  // 静态 import 亦可,此处用动态保持一致
        await renderAsync(buf, container, null, { className: 'docx', inWrapper: true })
        if (!cancelled) setLoad({status:'ready'})
      } catch (error) {
        if (!cancelled) setLoad({status:'error', message: error instanceof Error ? error.message : String(error)})
      }
    })()
    return () => { cancelled = true; container.innerHTML = '' }
  }, [scope.sessionId, scope.cwd, path])

  // 渲染:host div + loading/error 占位
}
```

- `docx-preview` 的 `renderAsync(arrayBuffer, container, null, options)` 把 docx 渲染到 container,保留样式/页眉页脚/图片(图片库内部 base64 内联处理)
- 卸载清空 `container.innerHTML`(docx-preview 无 dispose API,DOM 清空即可)

#### XlsxView

```tsx
export function XlsxView(props: { scope: SessionScope; path: string; title: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const univerRef = useRef<Univer | null>(null)
  const [load, setLoad] = useState<{status:'loading'|'ready'|'error'; message?: string}>({status:'loading'})

  useEffect(() => {
    let cancelled = false
    const container = hostRef.current
    if (container === null) return
    ;(async () => {
      try {
        const buf = await fetch(mediaUrl(scope, path)).then(r => r.arrayBuffer())
        if (cancelled) return
        // 懒加载 Univer 全家桶(首次打开 .xlsx 才下载 ~5MB chunk)
        const { createUniver, defaultLocale } = await import('@univerjs/core')
        const { UniverSheetsCorePlugin } = await import('@univerjs/sheets-ui')
        const { UniverSheetsFormulaPlugin } = await import('@univerjs/sheets-formula')
        const { UniverSheetsConditionalFormattingPlugin } = await import('@univerjs/sheets-conditional-formatting')
        const { UniverSheetsChartPlugin } = await import('@univerjs/sheets-chart')
        const { UniverDocsPlugin } = await import('@univerjs/docs-ui')
        // xlsx 导入:SheetJS 解析后转 Univer workbook data
        const XLSX = await import('xlsx')
        const wb = XLSX.read(buf, { type: 'array' })
        const workbookData = xlsxWorkbookToUniver(wb)  // 转换函数,见 §3.6

        const univer = createUniver({
          locale: defaultLocale,
          plugins: [
            UniverDocsPlugin,
            UniverSheetsCorePlugin,
            UniverSheetsFormulaPlugin,
            UniverSheetsConditionalFormattingPlugin,
            UniverSheetsChartPlugin,
          ],
        })
        univer.createUniverSheet(workbookData)
        univerRef.current = univer
        if (!cancelled) setLoad({status:'ready'})
      } catch (error) {
        if (!cancelled) setLoad({status:'error', message: ...})
      }
    })()
    return () => {
      cancelled = true
      univerRef.current?.dispose()  // 关键:防 canvas + worker 泄漏
      univerRef.current = null
    }
  }, [scope.sessionId, scope.cwd, path])

  // 渲染:host div + loading/error 占位
}
```

- **dispose 纪律**:卸载必须 `univer.dispose()`,否则 canvas + worker 泄漏(类比 `TerminalView` 的 `term.dispose()` + `observer.disconnect()`)
- Univer 的 UI 需要容器有尺寸(类似 xterm),复用 `ResizeObserver` 模式

### 3.5 binary 占位升级为下载按钮

`EditorView.tsx:210` 现状:`{t('binary')}` 纯文本占位。

改为:

```tsx
{load.status === 'binary' && (
  <div className={css.editorBinary}>
    <span>{t('binaryNoPreview')}</span>
    <a className={css.editorDownloadLink} href={downloadUrl(scope, path)} download>
      {t('downloadToView')}
    </a>
  </div>
)}
```

- 复用现有 `downloadUrl(scope, path)`(`api.ts:140`),走 `/sidebar/file?download=1`
- 对所有 binary 统一(不只 Office)— PDF、zip、exe 等都受益

### 3.6 xlsx → Univer workbook data 转换

SheetJS 解析的 workbook 结构与 Univer 的 `IWorkbookData` 不同,需转换层 `src/client/xlsx-to-univer.ts`:

- SheetJS `wb.SheetNames[]` + `wb.Sheets[name]` → Univer `sheets: Record<sheetId, IWorksheetData>`
- 单元格:`ws[addr]` → `cellData[row][col]`,映射类型(s/n/b/e)、值、样式(对齐/字体/背景/边框)
- 合并单元格:`ws['!merges']` → `mergeData`
- 列宽/行高:`ws['!cols']` / `ws['!rows']` → `columnData` / `rowData`
- 公式:SheetJS `cell.f` → Univer 公式格式
- 图表/条件格式:SheetJS 不解析这些,需 Univer importer 或跳过(首版可只迁数据+样式+合并+公式)

**首版范围**:数据 + 基本样式(字体/颜色/对齐/边框/合并)+ 公式(文本形式即可,Univer 引擎计算)。图表/条件格式若 Univer importer 直接支持则用,否则跳过。

> 备选:用 Univer 官方的 `@univerjs/sheets-import-export`(基于 SheetJS 封装,直接产出 `IWorkbookData`),省去自写转换层。实现时优先评估此包,若版本耦合/体积可接受则用,否则自写。

### 3.7 EditorView 集成

`EditorView.tsx` 的 `renderTab` / `TabContent` 分发(`Sidebar.tsx:49` 的 switch)无需改 — editor tab 仍走 `EditorView`。

`EditorView` 内部 `useEffect`(`EditorView.tsx:60`)加 Office 分支:

```ts
const ext = extOfPath(path)
const officeKind = officeKindForExt(ext)
if (officeKind === 'docx' || officeKind === 'xlsx') {
  setLoad({ status: 'ready', kind: officeKind, content: '', truncated: false })
  return  // 不再走 fsRead(短路,省一次 binary 往返)
}
// 原有 IMAGE / MD / text / binary 逻辑不变
```

渲染区(`EditorView.tsx:220` 附近)加:

```tsx
{load.status === 'ready' && load.kind === 'docx' && (
  <DocxView scope={scope} path={path} title={title} />
)}
{load.status === 'ready' && load.kind === 'xlsx' && (
  <XlsxView scope={scope} path={path} title={title} />
)}
```

## 4. 错误处理

| 场景 | 检测 | 响应 |
|---|---|---|
| 文件损坏(非有效 zip) | 库抛错 | 显示错误信息 + 下载按钮 |
| `>20MB`(超 `mediaLimit`) | fetch 响应 / host 返回 400 | 提示"文件过大" + 下载按钮 |
| 加密文件(密码保护) | SheetJS/docx-preview 抛特定错 | "不支持加密文件" + 下载按钮 |
| Univer chunk 加载失败 | dynamic import reject | 重试按钮(类比 `TerminalView` 的 `FAILURE_LIMIT`) |
| 网络失败(媒体路由 403) | fetch 非 200 | 错误信息(信任围栏拒绝) |
| Univer dispose 后异步回调 | cancelled flag | 静默(类比现有 `TerminalView` 模式) |

**降级统一出口**:所有 Office 错误分支都附带"下载查看"链接,确保用户始终能拿到文件。

## 5. bundle 与构建

### 5.1 依赖新增(`package.json`)

`dependencies`(运行时,内联进 client bundle):
- `docx-preview`(~500KB)
- `xlsx`(SheetJS,~400KB,xlsx 导入)
- `@univerjs/core` + `@univerjs/sheets` + `@univerjs/sheets-ui` + `@univerjs/sheets-formula` + `@univerjs/sheets-conditional-formatting` + `@univerjs/sheets-chart` + `@univerjs/docs-ui` + `@univerjs/design` + `@univerjs/engine-render`(~5MB 合计)

**不放 `peerDependencies`**:这些是插件自有运行时依赖,不由 web profile 提供(对比现有 `node-pty`/`CodeMirror` 也在 `dependencies`)。

> **实施偏差记录（#122，2026-08）**：上文"`xterm` 也在 `dependencies`"已过时——`xterm` 与 `@xterm/addon-fit` 自 v0.13.0 起从 `dependencies` 迁至 `devDependencies`：二者始终内联进 `lib/client-terminal.js`（tsdown `noExternal` 全内联 + CSS 构建期解析），运行时零依赖；同时代码与开发依赖已从已弃用的 `xterm` 迁移到官方新包名 `@xterm/xterm@^5.5.0`（addon-fit@0.10.0 的 peer 约束锁 `^5.0.0`，不用 6.x），消除用户安装时的 deprecated 与 missing-peer 警告。Office 预览若落地，其依赖按同一原则处理。

### 5.2 tsdown.config.ts 调整

现有 client bundle 配置(`tsdown.config.ts:103` 的 `clientBundle()`):
- `format: 'cjs'` + `banner`/`footer` 包成 `__ModuleLoader__.load` 闭包工厂
- `noExternal: (id) => (CLIENT_EXTERNALS.includes(id) ? undefined : true)` — 非 externals 全内联

**dynamic import 兼容性(最大实现风险)**:

Rollup 在 `format: 'cjs'` + `inlineDynamicImports: false` 时会拆 chunk,但 CJS chunk 在浏览器端无 `require`,动态导入链路可能断裂。需 spike 验证:

1. **首选**:保持 `format: 'cjs'`,让 rollup 拆 chunk,验证浏览器 `import()` 是否能加载子 chunk(rollup 会输出 `import()` 调用,浏览器原生支持 ESM dynamic import,但 CJS chunk 的 `module.exports` 形态需 wrapper)
2. **fallback A**:退回静态内联(放弃懒加载,接受 7MB bundle)
3. **fallback B**:Univer 单独打 IIFE bundle `lib/univer-bundle.js`,host 新增静态路由 `/sidebar/univer-bundle.js` serve,client 用 `<script>` 动态注入(破坏 host 零改动,最后手段)

**spike 必须是实现第一步**,结果决定后续构建配置。

### 5.3 CSS

Univer 自带样式,需确保:
- Univer 的 CSS 被 `dsh-css-inline` plugin 正确内联(走 `import '@univerjs/.../style.css'`)
- 或 Univer 的样式注入机制不与现有 `data-plugin-css` tag 冲突

docx-preview 的样式由 `className: 'docx'` 选项控制,可能需补 `src/client/office.module.css` 微调。

## 6. 测试

### 6.1 Unit(纯函数,加进 `tests/unit.spec.ts`)

- `officeKindForExt('.docx')` → `'docx'`
- `officeKindForExt('.xlsx')` → `'xlsx'`
- `officeKindForExt('.pptx')` → `'download-only'`
- `officeKindForExt('.doc')` → `'download-only'`
- `officeKindForExt('.txt')` → `null`
- `officeKindForExt('')` → `null`

### 6.2 xlsx → Univer 转换(若自写转换层)

- fixture xlsx → 解析 → 转换 → 断言 `IWorkbookData` 结构(sheet 名/单元格值/合并/公式)
- 用 `tests/fixtures/sample.xlsx` 作为输入

### 6.3 集成测试限制

- Univer 依赖 canvas API,jsdom 环境无法渲染 → 不测 Univer 渲染产物
- 只测加载逻辑:mock `fetch` 返回 ArrayBuffer,验证 loading → ready/error 状态转换
- docx-preview 同样依赖 DOM,jsdom 可跑 `renderAsync`(无 canvas 依赖)但渲染产物脆弱 → 只测"不抛错"

### 6.4 手动冒烟

- 真实 .docx(含图片/表格/页眉)→ 渲染保真度
- 真实 .xlsx(多 sheet/公式/条件格式)→ 渲染 + 公式计算
- .pptx → 下载按钮
- 加密 docx/xlsx → 错误提示 + 下载
- >20MB → 提示 + 下载

## 7. 国际化

`src/client/locales.ts` 新增 key:

- `downloadToView` — "下载查看" / "Download to view"
- `binaryNoPreview` — "此文件类型不支持预览" / "This file type cannot be previewed"
- `officeTooLarge` — "文件过大,无法预览" / "File too large to preview"
- `officeCorrupt` — "文件损坏或格式无效" / "File is corrupt or in an invalid format"
- `officeEncrypted` — "不支持加密文件" / "Encrypted files are not supported"
- `officeLoadFailed` — "Office 预览组件加载失败" / "Office preview component failed to load"
- `retry` — 复用现有 `terminalRetry` 或新增 `retry`

## 8. 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/client/EditorView.tsx` | 加 docx/xlsx kind 分支 + 下载按钮 binary 占位 |
| `src/client/office-view.tsx`(新) | `DocxView` / `XlsxView` 组件 |
| `src/client/office-types.ts`(新) | 扩展名 → kind 纯函数 |
| `src/client/xlsx-to-univer.ts`(新,若自写转换) | SheetJS workbook → Univer IWorkbookData |
| `src/client/locales.ts` | 新文案 key |
| `src/client/sidebar.module.css` | `.editorBinary` / `.editorDownloadLink` 样式 |
| `package.json` | 加 docx-preview / @univerjs/* / xlsx 依赖 |
| `tsdown.config.ts` | dynamic import 配置(spike 后定) |
| `tests/unit.spec.ts` | officeKindForExt 单测 |
| `tests/fixtures/`(新) | sample.docx / sample.xlsx 测试夹具 |

## 9. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| tsdown CJS 闭包不兼容 dynamic import | 中 | 高(阻塞懒加载) | spike 优先;fallback A 静态内联 / fallback B 独立 bundle |
| Univer 体积超预期(>5MB) | 低 | 中 | 评估 tree-shaking;裁剪非必要插件(如 chart) |
| xlsx → Univer 转换层复杂度爆表 | 中 | 中 | 优先用 `@univerjs/sheets-import-export` 官方包 |
| Univer canvas 在某些浏览器渲染异常 | 低 | 中 | 错误边界捕获 + 下载降级 |
| docx-preview 图片 base64 内存爆炸(大 docx) | 低 | 低 | 文件 size cap 已 20MB,可接受 |
| Univer dispose 不彻底导致内存泄漏 | 中 | 中 | 严格 cleanup + 手动验证 Tab 切换/卸载 |

## 10. 实现里程碑(粗略,待 writing-plans 细化)

1. **Spike**:验证 tsdown CJS + dynamic import 兼容性(决定构建策略)
2. **基础**:office-types.ts + EditorView 分发 + binary 下载按钮(最小可用,pptx/旧格式先受益)
3. **docx**:DocxView + docx-preview 集成 + 错误处理
4. **xlsx**:XlsxView + Univer 集成 + xlsx 导入(优先官方 importer)
5. **测试**:unit + fixture + 手动冒烟
6. **收尾**:CSS 打磨 + 国际化 + 文档更新(README 功能一览)
