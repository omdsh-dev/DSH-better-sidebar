# dsh-better-sidebar

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">A service-oriented sidebar framework, and a complete workbench out of the box</b><br /><br />
  <code>File management</code> <code>Edit &amp; preview</code> <code>Embedded browser</code> <code>Real terminal</code> <code>Git panel</code> <code>Background tasks</code> <code>Plugin integration</code><br /><br />
  <b>A dual workbench (right sidebar + bottom panel)</b> that opens its <code>ctx.betterSidebar</code> service to every plugin —<br />
  register new sidebar pages and file viewers via <code>registerTab</code> / <code>registerFileViewer</code>.
</div>

<div align="center">
  🌏 <a href="./README.md">中文</a> · <a href="./README_EN.md"><b>English</b></a>
</div>

<div align="center">
  <video src="https://github.com/user-attachments/assets/23187822-047e-45cc-b480-fe997bd55b86" muted autoplay loop playsinline controls width="100%"></video>
  <img alt="dsh-better-sidebar workbench" src="https://github.com/user-attachments/assets/dfdb875e-a1a8-4d4b-8340-353736b1708f" />
</div>

## ✨ Features

- **🗂️ File Workbench**: file explorer (lazy-loading tree) + CodeMirror editor; inline preview for images / Markdown / HTML / PDF / Office
- **🌐 Embedded Browser**: multiple web tabs with back / forward / refresh; content runs in a sandboxed iframe; external links open in the sidebar by default
- **💻 Real Terminal**: xterm.js + node-pty real shell, reconnect with transcript replay; optionally injects `terminal_*` tools for the model
- **🌿 Git Panel**: real diff + VSCode-style diff tabs, history, right-click to stage / commit / revert
- **🧩 Background Tasks**: agent topology + background tasks (exit codes / live output / force-kill)
- **🪟 Dual Workbench**: right sidebar + bottom panel; drag tabs to split / merge panes (cross-panel), mobile auto-merges into a full-width drawer
- **🔁 Session Isolation**: layout / tabs / panels persisted per session, stale state auto-purged
- **⚙️ Declarative Settings**: per-item toggles in the "Side Cards" settings section, secondary settings via the gear dialog
- **⚡ On-demand Loading**: only ~325KB core at startup; heavy deps (terminal / editor) load on demand ([design](docs/plans/2026-08-12-lazy-chunks-design.md))
- **🌏 i18n**: UI text follows DSH's language (zh / en) with live switching

> 🔌 **Core principle**: service-first — the 7 built-in tabs + 6 viewers register through the same `ctx.betterSidebar` API as third-party plugins, with fully equal capabilities; anything the ecosystem can provide better is delegated to ecosystem plugins. See the "🔌 Service" section below and the [external plugin guide](./docs/external-plugin-guide.md).

## 🆕 Recent Updates

<small>v0.12.1</small>

| Feature | Description | Screenshot |
|---|---|---|
| 🔌 Service API base | Complete type exports + `version`/`features` capability detection, state subscription (`getSnapshot`/`subscribeState`), tab `badge`, `onOpen`/`onActivate`/`onClose` lifecycle callbacks, `updateTab`/`activateTab`/`openFile`, targeted open, `meta` persisted across reloads, plugin-owned settings (`pluginToggles`/`render`) | <a href="https://github.com/user-attachments/assets/946f7028-4967-461e-a750-d1b5056b62d0"><img width="480" alt="Service API base screenshot" src="https://github.com/user-attachments/assets/946f7028-4967-461e-a750-d1b5056b62d0" /></a> |
| ➕ Add Plugins | Recommended plugin catalog in settings + one-click copy install command; built-in Office preview moved to the recommended plugin | <a href="https://github.com/user-attachments/assets/d4385b7e-aab4-425d-a5c4-2da5da81a34e"><img width="480" alt="Add Plugins screenshot" src="https://github.com/user-attachments/assets/d4385b7e-aab4-425d-a5c4-2da5da81a34e" /></a> |
| 🖱️ Tab-bar scroll | Mouse-wheel horizontal scrolling on the tab bar | |
| 🐛 Fixes | Remote access 403 (trust fence now uses `trustedHosts`), sidebar crash [#31](https://github.com/omdsh-dev/DSH-better-sidebar/issues/31), Windows HTML-preview drive-path | |

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
curl -fsSL https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.sh | bash -s 0.12.1 --restart

# Windows PowerShell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.ps1'))) -Version 0.12.1 -Restart
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

# ③ Install and auto-mount (no @version = npm's latest; pin with dsh-better-sidebar@0.12.1)
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

`curl | bash` / `irm | iex` executes remote code — the scripts are open source in the repo (`scripts/install.sh` / `scripts/install.ps1`); download and review them first if you prefer. The plugin ships as npm package `dsh-better-sidebar@0.12.1` and mounts via `dsh.bundle.patch` (the shipped `cordis.patch.yml`), so the DSH source is never modified.

</details>

<details>
<summary><b>Updating</b></summary>

```sh
dsh plugin --profile web add dsh-better-sidebar
```

or re-run the one-click script; or bump the version in `~/.dsh/profiles/web/package.json` (e.g. `"^0.12.1"`) and run `pnpm install`. Then hard-refresh the browser (Cmd/Ctrl+Shift+R) — client changes do not need a DSH restart.

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

Update: `git pull && pnpm install && pnpm build` → just hard-refresh the browser (client changes hot-reload; only host-half changes need a DSH restart). To switch back to the npm channel, restore `"dsh-better-sidebar": "^0.12.1"` and re-run `pnpm install`.

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
| Toggle sidebar | `Ctrl/Cmd + B` |
| Save edits | `Ctrl/Cmd + S` |
| Git commit | `Ctrl/Cmd + Enter` |
| Close tab | Middle mouse button |
| Split / merge panes | Drag tab to pane edge / middle |
| Reference file to input | Hover the `@file` button at end of line |
| Copy file path | Right-click row → copy relative/absolute path |

The first three shortcuts can be rebound in Settings → Side card → Keyboard shortcuts: select the key field and press the new combination to save it (include `Ctrl`, `Cmd`, or `Alt`, optionally with `Shift`; `Esc` cancels recording; browser- or OS-reserved combinations may not be recordable).

## 🔌 Service: register tabs & file viewers

Since v0.4.0 the plugin exposes the `ctx.betterSidebar` service — other plugins can register sidebar pages and file viewers (the 7 built-in tabs + 6 viewers register through the same service):

```ts
import type {} from 'dsh-better-sidebar'  // triggers the ctx.betterSidebar type merge
export const inject = ['betterSidebar']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'my-plugin:db', title: 'Database', component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  }))
}
```

v0.12.1+ base capabilities (complete type exports, capability detection, state subscription, tab badge, lifecycle callbacks, targeted open, plugin-owned settings, etc.) — see the integration docs below.

Full integration docs:
- **[`AGENTS.md`](./AGENTS.md)** — the in-repo integration doc (full fields, matching algorithm, HMR pitfalls, declarative settings, version detection);
- **[`docs/external-plugin-guide.md`](./docs/external-plugin-guide.md)** — the external-plugin guide (with a complete minimal example).

### ➕ Add Plugins (recommended plugin catalog)

The dashed cards at the end of the "Sidebar content" / "File viewers" grids in the "Side Cards" settings section open the **Add tab plugins** / **Add preview plugins** modals: each declares its open extension point, offers a "**Browse more plugins on GitHub**" button (the [GitHub topic `dsh-better-sidebar`](https://github.com/topics/dsh-better-sidebar)), and lists the recommended catalog (name / repo / description / install script) — "**Open**" jumps to the repo, "**Copy**" writes the install command to the clipboard.

**Curating a new plugin**: append a `PluginEntry` to [`src/client/plugins-tabs.ts`](./src/client/plugins-tabs.ts) (tab registrations) or [`src/client/plugins-viewers.ts`](./src/client/plugins-viewers.ts) (file-previewer registrations) and tag your repo with the `dsh-better-sidebar` topic; data integrity is guarded by `tests/plugin-list.spec.ts`.

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
- Office-suite preview (.docx/.xlsx/.pptx) moved to the recommended office plugin (see the "Add plugins" modals in settings); without it these files fall through to the code/download fallbacks
- Browser sandbox has no login state / third-party cookies are restricted; some sites need popup login; sites that refuse embedding via `X-Frame-Options`/`frame-ancestors` (e.g. arxiv.org) show a reason panel (with "Open in browser"); in-iframe navigation does not enter the back stack
- HTML preview renders the saved file (not unsaved drafts)
- No bottom panel on mobile (<768px): on narrow screens its tabs merge into the right sidebar once (after migrating back to desktop they stay in the right sidebar); the desktop bottom panel is only available on wide viewports; auto-open terminal on first bottom-panel expand does not trigger on mobile

## 🖥️ Platform Support

Windows / Linux / macOS (macOS validated daily; the rest covered by unit tests); `node-pty` prefers prebuilt binaries, otherwise a build toolchain is required (Windows VS Build Tools / Linux make+g+++python3 / macOS Xcode CLT).

## 🔗 Friends

- [dsh-tianshu-tui](https://github.com/huiliyi37/dsh-tianshu-tui): an interactive terminal UI plugin for DeepSeek Harness (its rendering core evolved from the self-developed harness agent Tianshu-Tui), adding TDD and evidence-gate workflows on top of the official harness
- [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI): a Claude Code-style fullscreen interactive TUI plugin — pixel-whale top bar, live working-status row, streaming thought expansion, double-Esc rollback, context progress bar + TPS meter; one-command npm install
- [dshfind Plugin Market](https://dshfind.com/zh/plugins): a third-party plugin marketplace — a listing of public repos under the GitHub topic `dsh-plugin`, with stars, contributors and growth data synced daily
- [DeepSeek Harness Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop): a modern desktop client for the DeepSeek Harness ecosystem — start and manage a local Harness service without configuring Node.js or running commands; [official site](https://www.dshdesktop.cn)
