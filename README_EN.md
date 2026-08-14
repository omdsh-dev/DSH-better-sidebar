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

## 🆕 Recent Updates

- **Custom terminal fonts**: font-family + 9–32px size settings on the terminal card, applied live
- **Side card settings redesign**: grouped container cards, count badges, custom toggles, wider settings dialog
- **Fix**: blank terminal after expanding the bottom panel on WKWebView (xterm initialized in a zero-size container, [#25](https://github.com/omdsh-dev/DSH-better-sidebar/issues/25))
- **Docs**: client changes take effect on a hard refresh — no DSH restart needed

## ✨ Features

- **🗂️ File Explorer**: lazy-loading directory tree (root = session cwd), click to open, `@file` reference, right-click to copy path
- **📝 Edit & Preview**: CodeMirror 6 editing (Ctrl/Cmd+S atomic save, drafts survive tab switches); inline preview for images / Markdown / HTML / PDF / Word / Excel / PPT (HTML in a sandboxed iframe)
- **⚡ Client-side Lazy Loading**: only ~325KB core at startup; heavy deps (Office / terminal / editor) load on demand (see `docs/plans/2026-08-12-lazy-chunks-design.md`)
- **🌐 Browser**: multiple embedded web tabs, back/forward/refresh; pages run in a sandboxed iframe (no access to UI data or local files, rejects local addresses), temporarily unlockable (red warning); sites refusing embedding show a reason panel; external links open in the sidebar by default
- **💻 Terminal**: xterm.js + node-pty real shell, reconnect with transcript replay; optionally injects `terminal_*` tools for the model; custom font (family + 9–32px size, applied live)
- **🌿 Git Panel**: real diff + VSCode-style diff tabs, history, right-click to stage/commit/revert etc.
- **🧩 Background Tasks**: main-session agent topology with click-through to execution records; background tasks on the same page (type badges + exit codes, live-output peek, force-kill)
- **🪟 Bottom Panel**: an independent second workbench that only squeezes the center output area; auto-opens a terminal on first expand (toggleable)
- **📱 Mobile**: narrow viewports (<768px) merge into a full-width drawer with the bottom panel's tabs folded into the sidebar; files/links auto-expand the panel
- **🔧 Split-pane Workbench**: drag tabs to split/merge panes (cross-panel supported), divider to adjust ratios; one-click collapse/expand both panels from the top-right buttons
- **🔁 Session Isolation**: layout / tabs / panel states persisted per session, stale state auto-purged; "produced files" open in the sidebar
- **⚙️ Declarative Settings**: the "Side Cards" settings section renders a registry-driven toggle grid, each item independently switchable; secondary settings (auto-expand, terminal tools, sandbox, etc.) edited in a native dialog via the gear button
- **🔌 Service API**: exposes `ctx.betterSidebar` — other plugins can register tabs and file viewers (the 7 built-in tabs + 9 viewers share the same service, see [AGENTS.md](./AGENTS.md))
- **🌏 i18n**: UI text follows DSH's language setting (zh/en) with live switching, no refresh needed

## 🚀 Installation

**Prerequisites**: DSH installed (`dsh web` boots), Node.js ≥ 20, pnpm ≥ 10.

**macOS / Linux** (also works in Git Bash / WSL on Windows):

```sh
curl -fsSL https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.sh | bash
```

**Windows (PowerShell 5.1+ / pwsh)**:

```powershell
irm https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.ps1 | iex
```

Then **hard-refresh the browser** (Cmd/Ctrl+Shift+R) to see the sidebar (DSH hot-reloads client changes; only host-half updates need a restart).

<details>
<summary><b>Pin a version / auto-restart (optional)</b></summary>

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.sh | bash -s 0.10.3 --restart

# Windows PowerShell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.ps1'))) -Version 0.10.3 -Restart
```

Not sure? Add `--dry-run` (`-DryRun` in PowerShell) to preview before running.

</details>

<details>
<summary><b>Manual install (step by step)</b></summary>

Equivalent to the one-click script. **Step ③ is repeatable; ①② only need to run once.**

**macOS / Linux (bash)**:

```sh
cd ~/.dsh/profiles/web

# ① Allow node-pty / protobufjs build scripts (pnpm 11 blocks them by default; skip on pnpm 10)
pnpm approve-builds --all

# ② Allow versions published less than 24h ago (skip for older releases; if the key already exists, merge the line under it instead)
cat >> pnpm-workspace.yaml <<'EOF'
minimumReleaseAgeExclude:
  - dsh-better-sidebar
EOF

# ③ Install and auto-mount (no @version = npm's latest; pin with dsh-better-sidebar@0.10.3)
npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-better-sidebar
```

**Windows (PowerShell)**:

```powershell
cd ~\.dsh\profiles\web

# ① Allow build scripts
pnpm approve-builds --all

# ② Allow fresh releases (once; if the key already exists, merge - dsh-better-sidebar under it instead)
Add-Content -Path pnpm-workspace.yaml -Value "`nminimumReleaseAgeExclude:`n  - dsh-better-sidebar"

# ③ Install and auto-mount
npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-better-sidebar
```

</details>

<details>
<summary><b>What the script does (technical details)</b></summary>

The one-click script does four things, all idempotent (safe to re-run):

1. Pre-writes `allowBuilds` (node-pty / protobufjs) to dodge pnpm 11's build-script block;
2. Pre-writes `minimumReleaseAgeExclude` to allow versions younger than 24 hours;
3. Runs `dsh plugin --profile web add dsh-better-sidebar`: registers the dependency → detects `dsh.bundle.patch` → auto-appends the plugin to `dsh.profile.bundles`;
4. Removes any leftover hand-written mount line to avoid double-mounting (two sidebars on the page).

`curl | bash` / `irm | iex` executes remote code — the scripts are open source in the repo (`scripts/install.sh` / `scripts/install.ps1`); download and review them first if you prefer. The plugin ships as npm package `dsh-better-sidebar@0.10.3` and mounts via `dsh.bundle.patch` (the shipped `cordis.patch.yml`), so the DSH source is never modified.

</details>

<details>
<summary><b>Updating</b></summary>

```sh
dsh plugin --profile web add dsh-better-sidebar
```

or re-run the one-click script; or bump the version in `~/.dsh/profiles/web/package.json` (e.g. `"^0.10.3"`) and run `pnpm install`. Then hard-refresh the browser (Cmd/Ctrl+Shift+R) — client changes do not need a DSH restart.

</details>

<details>
<summary><b>Troubleshooting</b></summary>

| Symptom | Cause & fix |
|---|---|
| `Ignored build scripts` | pnpm 11 blocked build scripts. Run `pnpm approve-builds --all` (the one-click script handles it). |
| `minimum release age` / version `< 24h` | The release is younger than 24 hours. Wait, or re-run once (pnpm auto-adds `minimumReleaseAgeExclude`); the one-click script handles it. |
| "profile directory not found" | Run `dsh web` once so it initializes `~/.dsh/profiles/web`. |
| Two sidebars on the page | Double-mount: `~/.dsh/profiles/web/cordis.patch.yml` still has the old hand-written `- insert: ... better-sidebar ...` line — delete it (the one-click script cleans it). |
| Terminal fails on Windows | `node-pty` relies on prebuilt binaries; if none match your Node version, install a build toolchain (VS Build Tools). Mainstream Node versions are usually covered. |
| No bash / curl on Windows | Use the PowerShell one-click command, or install Git Bash / WSL and run the bash commands. |

</details>

<details>
<summary><b>Install from source / develop (optional — alternative to the npm flow)</b></summary>

To debug local changes or track the dev branch, point the dependency at a local clone and build it yourself:

```text
1. git clone https://github.com/omdsh-dev/DSH-better-sidebar.git ~/Code/DSH-better-sidebar
   cd ~/Code/DSH-better-sidebar && pnpm install && pnpm build
2. In ~/.dsh/profiles/web/package.json dependencies write "dsh-better-sidebar": "link:<absolute path of the clone>"
3. Append this mount line to ~/.dsh/profiles/web/cordis.patch.yml:
   - insert:
       - id: better-sidebar
         name: 'dsh-better-sidebar'
4. Run pnpm install in ~/.dsh/profiles/web
5. Restart DSH and hard-refresh
```

Update: `git pull && pnpm install && pnpm build` → just hard-refresh the browser (client changes hot-reload; only host-half changes need a DSH restart). To switch back to the npm channel, restore `"dsh-better-sidebar": "^0.10.3"` and re-run `pnpm install`.

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

## 🔗 Friends

- [dsh-tianshu-tui](https://github.com/huiliyi37/dsh-tianshu-tui): an interactive terminal UI plugin for DeepSeek Harness (its rendering core evolved from the self-developed harness agent Tianshu-Tui), adding TDD and evidence-gate workflows on top of the official harness
