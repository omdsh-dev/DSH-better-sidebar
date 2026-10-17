/**
 * Public entry of the unified window host (S6).
 *
 * `createWindowHost()` returns the store the client service publishes as
 * `ctx.betterSidebar.windows`; `WindowHost` is mounted once by the plugin's
 * client activation. `ClueFormatHost` is the S1-format renderer seat used by
 * structured content.
 */
export { createWindowHost, windowHostLayerKey } from './host.ts'
export { WindowHost, type WindowHostProps } from './WindowHost.tsx'
export { ClueFormatHost, type ClueFormatHostProps, type FormatRendererRegistry } from './format-content.tsx'
export {
  WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH, WINDOW_SIZE_PRESETS, WINDOW_VIEWPORT_MARGIN,
  clampWindowBox, clampWindowOrigin, initialWindowBox, maximizedWindowBox, placeWindowBox,
  resizeWindowBox, resolveWindowSize,
} from './geometry.ts'
export { WINDOW_LAYER_BASE_Z, raiseWindowLayer, subscribeWindowLayer, windowLayerZ } from './layer.ts'
export type {
  BetterSidebarWindowsClientFace, ViewportSize, WindowBodyLayout, WindowBox, WindowContent,
  WindowDocumentContent, WindowHandle, WindowHostController, WindowHostOptions, WindowHostSnapshot,
  WindowNavigation, WindowOpenOptions, WindowPage, WindowPageView, WindowSize, WindowSizePreset,
  WindowUpdate, WindowView,
} from './types.ts'
