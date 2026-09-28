/**
 * 核心 bundle 里的终端 tab 描述符组件（轻量壳）：真正的视图在 client-terminal
 * chunk 里，xterm 因此不进启动路径。
 *
 * 这里同时提供「宿主终端服务是否可用」的判据：描述符只在 `ctx.webTerminals`
 * 存在时注册（见 builtins/index.ts），老宿主上不会多出一个点不开的类型。
 */
import type { ComponentType } from 'react'
import type { Context } from '../../context-types.ts'
import { lazyChunkComponent } from '../lazy-chunk.tsx'
import type { TabComponentProps } from '../service.ts'
import type { WebTerminalsFace } from './types.ts'

/**
 * 宿主是否提供公开的客户端终端服务（`ctx.webTerminals`，由
 * `@deepseek-ai/dsh-api-terminal-controller` 的客户端半区注册）。
 * @param ctx - 客户端 Context。
 * @returns 服务可用时为 true。
 */
export function hasHostTerminals(ctx: Context): boolean {
  // 结构探测：`ctx.get` 本身也可能缺席（测试桩、老宿主的最小 ctx），此时按
  // 「没有终端服务」处理，而不是抛错把整个 builtin 注册带崩。
  if (typeof ctx.get !== 'function') return false
  const terminals = ctx.get('webTerminals') as unknown as WebTerminalsFace | null | undefined
  if (terminals === undefined || terminals === null) return false
  return typeof terminals.view === 'function' && typeof terminals.retainTabs === 'function'
}

/** 描述符 component：懒加载 client-terminal chunk 后渲染其中的 TerminalBody。 */
export const TerminalTabView = lazyChunkComponent<TabComponentProps>(
  'terminal',
  (mod) => mod.TerminalBody as ComponentType<TabComponentProps> | undefined,
)
