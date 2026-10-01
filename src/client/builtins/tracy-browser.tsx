/**
 * Tracy: the `tracy:browser` tab descriptor — the site preview page.
 *
 * Registered through the same service every other tab uses, so the native
 * surface (native/index.ts) turns it into a page kind of DSH's right Sidebar:
 * kind `tracy:browser`, ONE page per pane (no `createTab`), which makes a
 * second open with another `url` navigate the tab already there instead of
 * stacking a new one. The view is BrowserView.tsx.
 */
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { BrowserView, TRACY_BROWSER_KIND } from '../BrowserView.tsx'
import { t } from '../locales.ts'
import type { TabDescriptor } from '../service.ts'

/**
 * The descriptor. Hidden from the native guide (the "+" list): a Tracy
 * preview is opened BY a consumer with the site's address (My Sites, Add
 * site, Build), and an empty address bar is not a page a customer is asked
 * to start from — nor does upstream's `guideDescBrowser` line ("takes over
 * chat links") describe this tab. No `settings`: upstream's browser prefs (sandbox switch,
 * link takeover, loopback allowlist) left with upstream's browser tab, and a
 * Tracy site's sandbox is decided by the deployment's site domain, not a
 * per-viewer switch.
 * @returns the tab descriptor to register.
 */
export function tracyBrowserTab(): TabDescriptor {
  return {
    id: TRACY_BROWSER_KIND,
    title: () => t('browser'),
    icon: (size: number) => <IconGlobeOutlineRegular size={size} />,
    order: 50,
    hidden: true,
    // The frame is a live page: selecting another tab (Tasks opened, Files) must not unmount it, or
    // coming back loads the site again from the top and loses the Refresh state (TCH e2e v3 X08).
    keepMounted: true,
    component: (props) => <BrowserView {...props} />,
  }
}
