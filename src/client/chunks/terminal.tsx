/**
 * Lazy chunk entry: the bottom workbench's terminal emulator (xterm.js + the
 * fit addon, several hundred KB). Built as `lib/client-terminal.js` and
 * registered under the `terminal` global chunk slot — fetched only when the
 * bottom tray's terminal tab is first opened (see chunk-loader.ts and
 * src/client/TerminalView.tsx). Never import this module from the core bundle:
 * it pulls xterm into the startup path.
 */
export { TerminalBottomView } from '../TerminalView.tsx'
