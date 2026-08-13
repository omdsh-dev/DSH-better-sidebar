# dsh-better-sidebar

<!-- Hero (HTML layout) -->
<div align="center">
  <b style="font-size: 1.15em;">One plugin, one complete workbench</b><br /><br />
  <code>File management</code> <code>Edit &amp; preview</code> <code>Embedded browser</code> <code>Real terminal</code> <code>Git panel</code> <code>Background tasks</code><br /><br />
  <b>Dual workbench: right sidebar + bottom panel</b>, all in one plugin.<br />
  <small>Tabs are freely draggable; third-party plugins can register new tab pages and file viewers</small>
</div>

<div align="center">
  🌏 <a href="./README.md">中文</a> · <a href="./README_EN.md"><b>English</b></a>
</div>

https://github.com/user-attachments/assets/23187822-047e-45cc-b480-fe997bd55b86

<img width="2630" height="1794" alt="6c4293e1bec2e935031bf0e986d6ec65" src="https://github.com/user-attachments/assets/dfdb875e-a1a8-4d4b-8340-353736b1708f" />

## ✨ Features

- **🗂️ File Explorer**: lazy-loading directory tree (root = session cwd), click to open in the sidebar, `@file` reference at end of line into the input box, right-click to copy path
- **📝 Edit & Preview**: CodeMirror 6 multi-language highlighting + Ctrl/Cmd+S atomic save; inline preview for images / Markdown (preview/edit toggle) / HTML (sandboxed iframe preview, relative resources loadable) / PDF / Word / Excel / PPT; drafts survive tab switches
- **⚡ Client-side Lazy Loading**: heavy dependencies (Office / terminal / code editor) are chunked and loaded on demand — only ~325KB core is fetched at startup; Univer (~20MB) is fetched only when opening .xlsx, the docx viewer only when opening .docx, xterm only when opening a terminal; brief loading on first open, then instant (see `docs/plans/2026-08-12-lazy-chunks-design.md`)
- **🌐 Browser**: embedded web browsing tabs (multiple), back/forward/refresh + "Open in browser"; pages run in a **sandboxed iframe** (opaque origin: cannot access UI data or local files, rejects localhost and other local addresses); the UI shows sandbox status live and can be temporarily unlocked (red warning when off); sites that refuse embedding (X-Frame-Options) show a reason panel; http(s) links in chat/UI open in the sidebar by default (panel auto-expands when collapsed)
- **💻 Terminal**: xterm.js + node-pty real shell (max 3 UI instances per session), tab keep-alive with reconnect/replay; optionally injects 8 `terminal_*` tools for the model
- **🌿 Git Panel**: real diff + VSCode-style diff tabs, lazy-loaded history, right-click to stage/discard/commit/revert/pick
- **🧩 Background Tasks**: full agent topology of the main session, click-through to execution records, live tool-call polling, auto-expand for new subagents; background tasks shown on the same page (all background tasks in the current tree, bash/pwsh type badges + exit codes, click to view live output — auto-follows the bottom, non-consuming peek that doesn't disturb the model's `job_output`; double-click confirm to force-kill)
- **🪟 Bottom Panel**: an independent second workbench (same kind of tabs as the right sidebar) that only squeezes the middle Agent output area without covering the left/right sidebars; auto-opens a new terminal on first expand (can be disabled in the terminal card's secondary settings); one-click collapse via the top-right x
- **📱 Mobile**: at viewport < 768px (true mobile width, not the host's 1024 breakpoint) only the right sidebar shows — when entering narrow screens, bottom-panel tabs merge directly into the right sidebar's tab bar, leaving a single toggle at top-right and a full-width drawer panel; new sessions start collapsed; files/external links in chat auto-expand without squeezing the conversation area
- **🔧 Split-pane Workbench**: drag tabs to split/merge panes (cross-panel dragging supported), divider to adjust ratios; persistent button cluster at top-right (bottom bar + side pull glyph) to collapse/expand both panels; the two panels share a corner double-direction drag to resize, rAF direct-DOM writes keep it smooth
- **🔁 Session Isolation**: layout/panes/tabs/panel states persisted per session (localStorage), stale state auto-purged; chat "produced files" open in the sidebar (auto-expands panels when collapsed)
- **⚙️ Declarative Settings**: the "Side Cards" section of the settings page renders a registry-driven feature list (small card grid, highlighted = enabled), each toggleable independently; secondary settings (auto-expand subagents, terminal tools, auto-open terminal on first bottom-panel expand, sandbox switches, etc.) are edited in a native dialog via the gear button
- **🔌 Service API**: exposes the `ctx.betterSidebar` service — other plugins can register sidebar tabs and file viewers (the 7 built-in tabs + 9 viewers go through the same service, see [AGENTS.md](./AGENTS.md))
- **🌏 i18n**: UI text follows DSH's language setting (zh/en) with live switching — Host preference takes priority over browser language, dictionaries registered into DSH's i18n namespace; no refresh needed

## 🚀 Installation

Prerequisites: DSH installed (`dsh web` works), Node.js ≥ 20, pnpm ≥ 10. The plugin is published to npm as **`dsh-better-sidebar@0.10.0`** (`@deepseek-ai/*` peers aligned with the host's actual versions `^0.1.0-rc.6` / `@deepseek-ai/cordis@^4.0.1`, single instance). Mounting still goes through the profile + `cordis.patch.yml`; the dependency source is the npm package:

```text
1. In ~/.dsh/profiles/web/package.json dependencies add "dsh-better-sidebar": "^0.10.0"
2. Append the mount line to ~/.dsh/profiles/web/cordis.patch.yml:
   - insert:
       - id: better-sidebar
         name: 'dsh-better-sidebar'
3. Run pnpm install in ~/.dsh/profiles/web
4. Restart DSH and hard-refresh (Cmd/Ctrl+Shift+R) to verify
```

> Installation = dependency registration + one mount line. **It also works when DSH is started as an npm package (e.g. `npx -p @deepseek-ai/dsh@0.1.0-rc.6 dsh web`)** (verified since v0.4.3).

> Note: if the profile's pnpm rejects a too-fresh release via `minimumReleaseAge` (<24h old), it auto-appends a `minimumReleaseAgeExclude` entry to `~/.dsh/profiles/web/pnpm-workspace.yaml` — or add `dsh-better-sidebar@<version>` there manually.

### Updating

```text
1. Bump the version range in ~/.dsh/profiles/web/package.json (e.g. "^0.10.1")
2. Run pnpm install in ~/.dsh/profiles/web
3. Restart DSH and hard-refresh (Cmd/Ctrl+Shift+R)
```

<details>
<summary><b>Install from source / develop (optional — alternative to the npm flow)</b></summary>

To debug local changes or track the dev branch, point the dependency at a local clone and build it yourself:

```text
1. git clone https://github.com/omdsh-dev/DSH-better-sidebar.git ~/Code/DSH-better-sidebar
   cd ~/Code/DSH-better-sidebar && pnpm install && pnpm build
2. In ~/.dsh/profiles/web/package.json dependencies write "dsh-better-sidebar": "link:<absolute path of the clone>"
3. Append the mount line to ~/.dsh/profiles/web/cordis.patch.yml (same as above)
4. Run pnpm install in ~/.dsh/profiles/web
5. Restart DSH and hard-refresh
```

Update: `git pull && pnpm install && pnpm build` → restart DSH (client-only changes can just hard-refresh). To switch back to the npm channel, restore `"dsh-better-sidebar": "^0.10.0"` and re-run `pnpm install`.

</details>

<details>
<summary><b>Install via plugin-registry (optional — use either this or the main flow)</b></summary>

Prerequisite: DSH with [plugin-registry](https://github.com/dsh-external/plugin-registry) integrated (`dsh registry` available). **Enabling both channels double-mounts** (the Node half loads twice, the page gets two sidebars).

```sh
git clone https://github.com/omdsh-dev/DSH-better-sidebar.git && cd DSH-better-sidebar
pnpm install && pnpm build
node scripts/package-registry.mjs   # assemble the registry/ staging (manifest + artifacts + README, not committed)
dsh registry install ./registry     # install (disabled by default)
dsh registry enable dsh-external/dsh-better-sidebar
```

Update: `git pull && pnpm install && pnpm build` → `node scripts/package-registry.mjs` → `dsh registry uninstall/install/enable`. Remove the other channel's mount before switching.

</details>

## ⌨️ Keyboard Shortcuts

| Action | Keys |
|---|---|
| Save edits | `Ctrl/Cmd + S` |
| Git commit | `Ctrl + Enter` |
| Close tab | Middle mouse button |
| Split / merge panes | Drag tab to pane edge / middle |
| Reference file to input | Hover the `@file` button at end of line |
| Copy file path | Right-click row → copy relative/absolute path |

## 🔌 Service: register tabs & file viewers

Since v0.4.0 the plugin exposes the `ctx.betterSidebar` service — other plugins can register sidebar pages and file viewers (the 7 built-in tabs + 9 viewers go through the same service, eating our own dog food):

```ts
import type {} from 'dsh-better-sidebar'  // triggers the ctx.betterSidebar type merge
export const inject = ['betterSidebar']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'my-plugin:db', title: 'Database', component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  }))
}
```

Full integration docs (`TabDescriptor` / `FileViewerDescriptor` full fields, matching algorithm, HMR pitfalls, declarative settings): see [`AGENTS.md`](./AGENTS.md).

## 🛠️ Development & Build

```sh
pnpm install      # @deepseek-ai/* resolved from npm (^0.1.0-rc.6, published) — no token needed
pnpm typecheck    # tsc --noEmit
pnpm build        # → lib/index.js + lib/invariant.js + lib/client.js + lib/client-registry.js + lib/types
pnpm test         # vitest (includes manifest consistency guard; build first)
pnpm watch        # tsdown --watch
```

**Architecture**: a single npm package with host/client halves — host (`src/index.ts`): `/sidebar/api/*` JSON API, `/sidebar/file` media route, `/sidebar/html` preview route, `/sidebar/ws/terminal` WebSocket (fs / git / pty / preview, all session-scoped with a trust fence); client (`src/client/index.tsx`): portal sidebar + views + interception; state persisted per session in localStorage. Organized per DSH official conventions (no default export, dual client bundles); no dependency on npm / checkout at runtime (`@deepseek-ai/*` provided by the web profile).

## 🔐 Security

- Routes protected by a Host-header trust fence (same as `/api`); `fs.write` is atomic; media/preview routes only serve files inside the session cwd; git only shells out to the CLI and never sets identity
- HTML preview and browser tab content render in **opaque-origin sandboxed iframes** (no `allow-same-origin`/`allow-top-navigation`, `no-referrer`, all permission policies disabled); the `/sidebar/html` route carries a CSP `sandbox` + size/path bounds; the address bar rejects `javascript:`/`data:`/`file:` and local addresses like localhost
- The UI shows the sandbox status live (red warning when off) and can temporarily unlock the current page; the settings page can disable the sandbox per feature (disabled by default, with a warning) — when off, content shares the origin with the UI; only recommended for fully trusted content

## ⚠️ Known Limitations

- Git has no push/pull/fetch; no file watcher (manual refresh); tool inline file-open buttons cannot be intercepted
- Dragging a terminal tab to another pane remounts it (shell restarts)
- `.xlsx` preview does not preserve cell styles (SheetJS community-edition limitation); Office/PPTX preview is inlined into the client bundle (~23MB), slower on first load
- Browser sandbox has no login state / third-party cookies are restricted; some sites need popup login; sites that refuse embedding via `X-Frame-Options`/`frame-ancestors` (e.g. arxiv.org) show a reason panel (with "Open in browser"); in-iframe navigation does not enter the back stack
- HTML preview renders the saved file (not unsaved drafts)
- No bottom panel on mobile (<768px): on narrow screens its tabs merge into the right sidebar once (after migrating back to desktop they stay in the right sidebar); the desktop bottom panel is only available on wide viewports; auto-open terminal on first bottom-panel expand does not trigger on mobile

## 🖥️ Platform Support

Windows / Linux / macOS (macOS validated daily; the rest covered by unit tests); `node-pty` prefers prebuilt binaries, otherwise a build toolchain is required (Windows VS Build Tools / Linux make+g+++python3 / macOS Xcode CLT).
