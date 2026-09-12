/**
 * Shared vocabulary of the sidebar's HTML preview surfaces (the editor's
 * html viewer and the changes tab's op render preview): the sandbox tokens
 * both preview iframes load with.
 */

/**
 * The sandbox tokens of an HTML preview iframe. NO allow-same-origin (the
 * preview must stay in an opaque origin — with the route's own origin it
 * could read session data) and NO allow-top-navigation (a previewed page
 * must not hijack the GUI). The editor viewer can disable the sandbox
 * per-feature in the side card settings (warned); the changes tab's op
 * render preview always stays sandboxed.
 */
export const HTML_IFRAME_SANDBOX = 'allow-scripts allow-popups allow-downloads allow-modals'
