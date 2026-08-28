# dsh-better-sidebar 图标主题开发指南

> 面向**插件开发者**：如何为 dsh-better-sidebar 的文件树注册自定义图标主题，实现类似 VSCode 图标主题切换的能力。

## 概述

dsh-better-sidebar 从 v0.18.0 起暴露 `ctx.betterSidebar.registerFileIconTheme(theme)` 服务方法。外部插件可以注册自己的图标主题，用户在设置页「侧边卡片」→「常规」→「文件图标」下拉中切换。

内置两个主题：
- **None (original)**（默认）— 原版通用图标，无颜色区分
- **Seti + Brand (built-in)** — 彩色品牌图标 + 文件夹着色（563 条映射）

你的插件注册的主题会出现在同一个下拉里，用户可以随时切换，**无需刷新页面**。

## API

```ts
interface FileIconTheme {
  /** 唯一 id，建议带包前缀：'my-plugin:material-icons' */
  id: string
  /** 设置页下拉显示名（i18n 友好：传字符串或 () => string） */
  name: string | (() => string)
  /** 返回文件图标 ReactNode，或 undefined 回退到内置映射 */
  fileIcon?: (name: string) => ReactNode | undefined
  /** 返回文件夹图标 ReactNode，或 undefined 回退到内置映射 */
  folderIcon?: (name: string, isOpen: boolean) => ReactNode | undefined
}
```

### 回退机制

你的 resolver 返回 `undefined` 时，会**自动回退到内置映射**（563 条后缀/文件名/文件夹映射）。这意味着：
- 你可以只覆盖部分文件类型（比如只提供品牌图标，通用类型回退到内置）
- 你可以完全覆盖所有图标（对所有文件都返回 ReactNode，永不返回 undefined）

### 能力检查

```ts
// 检查当前 better-sidebar 是否支持图标主题
if (ctx.betterSidebar.features.includes('fileIconThemes')) {
  // 注册你的主题
}
```

## 最小骨架

### package.json

```jsonc
{
  "name": "my-plugin",
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "dsh-better-sidebar": "workspace:*",
    "react": "^18.2.0"
  },
  "peerDependenciesMeta": {
    "dsh-better-sidebar": { "optional": true }
  }
}
```

- `dsh-better-sidebar` 必须声明为 **peerDependency**（不是 dependency，避免重复实例化）
- 标记 `optional: true` 让你的插件在 better-sidebar 未安装时也能加载

### client half 入口

```tsx
// my-plugin/src/client/index.ts
import { createElement } from 'react'
import type {} from 'dsh-better-sidebar'  // 触发 ctx.betterSidebar 类型合并
import type { Context } from '@deepseek-ai/cordis'

export const inject = ['betterSidebar']

export function apply(ctx: Context): void {
  // 能力检查：不支持时静默跳过
  if (!ctx.betterSidebar.features.includes('fileIconThemes')) return

  ctx.effect(() =>
    ctx.betterSidebar.registerFileIconTheme({
      id: 'my-plugin:material-icons',
      name: 'Material Icon Theme',
      fileIcon: (name) => {
        // 你的图标逻辑
        const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
        if (ext === 'ts') return <TsIcon />
        if (ext === 'tsx') return <TsxIcon />
        // 返回 undefined → 回退到内置映射
        return undefined
      },
      folderIcon: (name, isOpen) => {
        if (name === 'node_modules') return <NodeModulesFolderIcon open={isOpen} />
        return undefined  // 回退到内置映射
      },
    })
  )
}

// 你的图标组件（可以是 SVG、react-icons、任何 ReactNode）
function TsIcon() {
  return createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: '#3178C6' },
    createElement('path', { d: 'M..." })
  )
}
```

### 关键规则

1. **用 `ctx.effect` 包裹注册** — fiber 卸载（HMR / 插件禁用）时自动注销，否则下次激活会报 `"already registered"`
2. **`import type {}` 触发类型合并** — 运行时交互走 `ctx.betterSidebar` 方法调用，不 value-import better-sidebar 的代码
3. **构建纯度门** — client bundle 禁止 value-import `@deepseek-ai/*`（`import type` 会被擦除，不触发门禁）
4. **resolver 要保持廉价** — 每次文件树渲染都会调用，不要在里面做重计算或网络请求

## 图标资源来源

### react-icons（零新增依赖）

如果 better-sidebar 已安装，`react-icons` 已是其 peer dependency。你可以直接用：

```tsx
import { SiReact, SiTypescript, SiPython } from 'react-icons/si'
import { VscFile, VscFolder } from 'react-icons/vsc'

// 品牌图标 + 颜色
fileIcon: (name) => {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const map: Record<string, ReactNode> = {
    ts: <SiTypescript size={14} style={{ color: '#3178C6' }} />,
    tsx: <SiReact size={14} style={{ color: '#61DAFB' }} />,
    py: <SiPython size={14} style={{ color: '#3776AB' }} />,
  }
  return map[ext]  // undefined → 回退到内置
}
```

### vscode-icons SVG（MIT 协议）

从 https://github.com/vscode-icons/vscode-icons/tree/master/icons 拉取 SVG 文件，内联为 React 组件：

```tsx
function TsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 32 32" fill="#3178C6">
      <path d="M..." />  {/* 从 vscode-icons 的 .svg 文件复制 path 数据 */}
    </svg>
  )
}
```

### 自定义 SVG

你可以完全自定义任何 SVG 图标：

```tsx
function MyFileIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill={color}>
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M5 8h6" stroke="white" strokeWidth="1.5" />
    </svg>
  )
}
```

## 部分覆盖示例

只覆盖品牌图标，其他回退到内置：

```tsx
ctx.effect(() =>
  ctx.betterSidebar.registerFileIconTheme({
    id: 'my-plugin:brand-only',
    name: 'Brand Icons Only',
    fileIcon: (name) => {
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
      // 只处理品牌文件，其他返回 undefined 回退到内置 563 条映射
      switch (ext) {
        case 'tsx': case 'jsx': return <SiReact size={14} style={{ color: '#61DAFB' }} />
        case 'ts': return <SiTypescript size={14} style={{ color: '#3178C6' }} />
        case 'vue': return <SiVuedotjs size={14} style={{ color: '#42B883' }} />
        case 'py': return <SiPython size={14} style={{ color: '#3776AB' }} />
        default: return undefined  // 回退到内置
      }
    },
    folderIcon: () => undefined,  // 文件夹全部回退到内置
  })
)
```

## 完整覆盖示例

完全用自己的图标，不回退：

```tsx
ctx.effect(() =>
  ctx.betterSidebar.registerFileIconTheme({
    id: 'my-plugin:full-custom',
    name: 'Full Custom Icons',
    fileIcon: (name) => {
      // 对所有文件都返回 ReactNode，永不返回 undefined
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
      return <MyCustomIcon ext={ext} name={name} />
    },
    folderIcon: (name, isOpen) => {
      return <MyCustomFolderIcon name={name} open={isOpen} />
    },
  })
)
```

## 安装与挂载

### 通过 profile 挂载

```sh
# 1. 在 profile 的 package.json 加依赖
# ~/.dsh/profiles/web/package.json 的 dependencies 写：
#   "my-plugin": "^1.0.0"

# 2. 在 cordis.patch.yml 加挂载行（如果需要 config）
# - insert:
#     - id: my-plugin
#       name: 'my-plugin'

# 3. 安装
cd ~/.dsh/profiles/web && pnpm install

# 4. 硬刷新浏览器（Cmd/Ctrl+Shift+R）
```

### 从源码安装（开发调试）

```sh
# 1. 克隆你的插件仓库
git clone https://github.com/you/my-plugin.git ~/Code/my-plugin
cd ~/Code/my-plugin && pnpm install && pnpm build

# 2. 在 profile 的 package.json 写 link:
#   "my-plugin": "link:/Users/you/Code/my-plugin"

# 3. pnpm install + 硬刷新
```

## 用户侧操作

用户安装你的插件后，在 DSH 设置页：
1. 打开「设置」→ 找到「侧边卡片」分区
2. 在「常规」区域找到「文件图标」下拉
3. 选择你的主题名 → **即时生效，无需刷新**

## 内置主题参考

| 主题 id | 显示名 | 说明 |
|---|---|---|
| `none` | None (original) | 默认。原版通用图标，无颜色区分 |
| `builtin` | Seti + Brand (built-in) | 彩色品牌图标 + 文件夹着色（563 条映射） |

内置主题的 resolver 返回 `undefined`，所以外部主题返回 `undefined` 时会回退到内置映射（如果活跃主题是 `builtin`）或通用图标（如果活跃主题是 `none`）。

## 注意事项

- **id 唯一**：重复 id 会抛 `"file icon theme \"X\" already registered"`
- **HMR 安全**：必须用 `ctx.effect` 包裹，否则热更新时会重复注册报错
- **resolver 异常**：resolver 抛错会被 try-catch 吞掉并回退到内置映射（不会崩溃）
- **性能**：resolver 在每次文件树渲染时调用，保持廉价（不要做 I/O 或重计算）
- **i18n**：`name` 字段传 `() => string` 可以跟随 DSH 语言切换
- **零 value-import**：不要 value-import `dsh-better-sidebar` 的代码，只 `import type {}` 触发类型合并；运行时交互走 `ctx.betterSidebar` 方法调用
