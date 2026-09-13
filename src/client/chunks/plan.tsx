/**
 * Lazy chunk entry: the Plan page. Built as `lib/client-plan.js` and
 * registered under `dsh-better-sidebar/plan` — fetched only when the plan tab
 * is first opened (see chunk-loader.ts and
 * docs/plans/2026-08-12-lazy-chunks-design.md). Never import this module from
 * the core bundle: it pulls MarkdownHtml's DOMPurify + HTML analysis into the
 * startup path, which every page load would then pay for.
 */
export { PlanView } from '../plans/PlanView.tsx'
