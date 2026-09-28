/**
 * 懒加载 chunk 入口：底部工作台的终端正文（xterm + fit addon）。
 *
 * 构建为 `lib/client-terminal.js`，注册在 `terminal` 这个 chunk 槽位上，只在
 * 用户第一次打开底部终端时经 `/sidebar/bundle/terminal.js` 取回；核心 bundle
 * 绝不静态 import 本模块（否则 xterm 会回到启动路径）。
 */
export { TerminalBody } from '../terminal/TerminalView.tsx'
