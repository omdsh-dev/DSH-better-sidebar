/**
 * Lazy chunk entry: the whole Tasks page (workflow graph + tree, task window,
 * team board, jobs drawer) together with the vendored shadcn/ui component set
 * it renders. Built as `lib/client-tasks.js` and registered under
 * `dsh-better-sidebar/tasks` — fetched only when the Tasks tab is first
 * opened (see chunk-loader.ts and docs/plans/2026-08-12-lazy-chunks-design.md).
 *
 * Why it is a chunk: the shadcn/radix/tailwind-ui layer costs ~430 KiB raw
 * (radix primitives + floating-ui + tailwind-merge + the vendored components),
 * and README's "startup pulls only the core bundle" contract must hold for
 * every user who never opens the Tasks tab. Never import this module (or the
 * page modules it re-exports) from the core bundle.
 */
// The Tailwind sheet (theme bridge + compiled utilities) ships WITH the
// chunk: it styles this page only, so the core bundle stays free of the
// UI-layer payload and the host page never receives the stylesheet until a
// reader opens the Tasks tab.
import '../ui/theme.css'

export { SubagentView } from '../SubagentView.tsx'
