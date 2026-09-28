/**
 * xterm 调色板：令牌是运行时的 CSS 变量，xterm 的 canvas 量不出 `var()`，所以
 * 在创建与换肤时各读一次具体值。皮肤把面板背景做成半透明（玻璃皮肤）时，
 * `effectiveTokenValue` 会返回空串，从而退回不透明兜底色——与主题模块给终端
 * /编辑器的既有约定一致（见 src/client/theme.ts 里关于 #90 的说明）。
 */
import type { ITheme } from '@xterm/xterm'
import { effectiveTokenValue, isDarkScheme } from '../theme.ts'

/** 明确方案下的兜底色（令牌缺失或半透明时使用）。 */
const DARK = {
  background: '#1b1b1f',
  foreground: '#e4e4e7',
  selectionBackground: 'rgba(125,145,255,0.35)',
}
const LIGHT = {
  background: '#ffffff',
  foreground: '#1f1f24',
  selectionBackground: 'rgba(60,90,255,0.22)',
}

/**
 * 当前方案下的 xterm 主题。背景/前景/光标优先用 DSH 令牌，选区用固定半透明色
 * （令牌里没有「选区」语义）。
 * @returns xterm 的 ITheme。
 */
export function terminalTheme(): ITheme {
  const base = isDarkScheme() ? DARK : LIGHT
  const background = effectiveTokenValue('--dsw-alias-bg-layer-1')
    || effectiveTokenValue('--dsw-alias-bg-base')
    || base.background
  const foreground = effectiveTokenValue('--dsw-alias-label-primary') || base.foreground
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: base.selectionBackground,
  }
}
