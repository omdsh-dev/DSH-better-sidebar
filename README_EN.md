# dsh-better-sidebar

> [!IMPORTANT]
> **Built on DSH's native sidebar API** (since v0.19.0): the right column *is* DSH's own sidebar — the plugin registers every tab type as a native tab (no right panel of its own anymore) and keeps only its self-drawn bottom workbench and the `ctx.betterSidebar` service open to every plugin.
>
> **Since v0.24.1 the host support floor is DSH `0.2.0-rc.1+`** (peer floor `^0.2.0-rc.1`). Everything this plugin consumes from 0.2.0 is **purely additive** (zero removed exports, session format still v4, CLI and client runtime byte-identical), so this version carries no runtime compatibility branch — it only moves the support line. **Hosts on the 0.1.7 line should pin `dsh-better-sidebar@0.22.1` — a caret never spans a minor bump, and `^0.1.7-rc.1` is silently disabled by the 0.2.0 startup preflight**; the DSH-to-plugin version table is in [Installation](#-installation).

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">A service-oriented sidebar framework, and a complete workbench out of the box</b><br /><br />
  <a href="https://www.npmjs.com/package/dsh-better-sidebar"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-better-sidebar" /></a>
  <a href="https://www.npmjs.com/package/dsh-better-sidebar"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-better-sidebar" /></a>
  <a href="https://github.com/omdsh-dev/DSH-better-sidebar/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/omdsh-dev/DSH-better-sidebar/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/omdsh-dev/DSH-better-sidebar/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/omdsh-dev/DSH-better-sidebar" /></a>
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://dshfind.com/en/plugins/omdsh-dev/DSH-better-sidebar?ref=badge"><img alt="dshfind" src="https://dshfind.com/api/badge/omdsh-dev/DSH-better-sidebar?lang=en" /></a><br /><br />
  <a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="Supported DSH versions (v0.24.1): 0.2.0-rc.1+" src="https://img.shields.io/badge/DSH-0.2.0--rc.1%2B-4d6bfe" /></a>
  <a href="https://github.com/topics/dsh-better-sidebar"><img alt="Plugin ecosystem: GitHub topic dsh-better-sidebar" src="https://img.shields.io/badge/plugin%20ecosystem-topic%20dsh--better--sidebar-4d6bfe" /></a><br /><br />
  <img alt="File management" src="https://img.shields.io/badge/-File%20management-4d6bfe" /> <img alt="Edit &amp; preview" src="https://img.shields.io/badge/-Edit%20%26%20preview-4d6bfe" /> <img alt="Bottom workbench" src="https://img.shields.io/badge/-Bottom%20workbench-4d6bfe" /> <img alt="Changes" src="https://img.shields.io/badge/-Changes-4d6bfe" /> <img alt="Background tasks" src="https://img.shields.io/badge/-Background%20tasks-4d6bfe" /> <img alt="Side Chat" src="https://img.shields.io/badge/-Side%20Chat-4d6bfe" /> <img alt="Plugin integration" src="https://img.shields.io/badge/-Plugin%20integration-4d6bfe" /><br /><br />
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

## 📑 Contents

- [✨ Features](#-features)
- [🚀 Installation](#-installation)
- [🖼️ Feature Tour](#-feature-tour)
- [💬 Community](#-community)
- [🆕 Recent Updates](#-recent-updates)
- [⌨️ Keyboard Shortcuts](#-keyboard-shortcuts)
- [🔌 Service API](#-service-api)
- [🛠️ Development & Build](#-development--build)
- [🔐 Security](#-security) · [⚠️ Known Limitations](#-known-limitations) · [🖥️ Platform Support](#-platform-support)
- [🌐 Plugin Ecosystem](#-plugin-ecosystem) · [🤝 Contributing](#-contributing) · [👥 Contributors](#-contributors) · [🔗 Friends](#-friends)

## ✨ Features

What this plugin adds on top of DSH's stock sidebar:

- **✏️ Editable editor**: the host's document preview is **read-only** → the plugin keeps an **editable** CodeMirror editor (save, syntax highlighting, preview toggle); Markdown / HTML also render through the plugin's own pipeline (Mermaid diagrams with safe rendering + click-to-zoom, README-level inline HTML, floating table of contents, sandboxed HTML preview)
- **🗂️ Enhanced file tree**: takes over the built-in Files page — lazy-loading tree, **expanded directories watched live and auto-refreshed**, symlink awareness, global filename search (**paste an absolute path to open it directly; relative paths match by path**), drag-and-drop upload, hover `@file` to drop a reference into the input box; **Ctrl/Cmd multi-select and Shift range-select** (copy or delete a batch), **VS Code-style git status colors + M/A/D/U letters**, **new folder / new file** (inline editor; the server refuses illegal names, Windows reserved device names and an existing destination — a same-named file is never truncated), **sorting** (by name / by type, plus a folders-first switch; the default is the host's own order), **multi-select “Zip and download”** (the host streams a ZIP built with no third-party dependency), and an “Open with” menu that COMBINES DSH’s own open-in-app (the host’s probed OS handlers + file-manager reveal) with the plugin’s own targets (file manager / VS Code / Cursor / Zed / custom editor URL templates, SSH remotes, pin-to-menu)
- **🌿 Changes** (no Git panel in the stock sidebar): two lenses in one tab — **Git** (diff / history / stage·commit·revert) and **This Session** (every file the model touched) — with a unified diff renderer (intra-line character highlights, syntax coloring, secret redaction); the two lenses now share one 36px header (host SegmentedControl), 28px rows, a single empty state and a sticky commit bar, and the git snapshot is shared with the file tree so staging recolors the tree too
- **🧩 Background Tasks** (absent upstream): agent topology preview + background task list (exit codes / live output / force-kill)
- **💬 Side Chat** (absent upstream, beta): Codex-style side threads — inheriting the full parent context, running independently, promotable to a top-level session
- **🖥️ Bottom workbench** (absent upstream): the right column belongs to DSH's native right sidebar; the plugin adds its own bottom workbench (drag-to-split panes, per-session persistence) that coexists with the native bar
- **📂 Model-driven sidebar opens (opt-in)**: the `sidebar_open` tool lets the model actively open files / folders / web pages in the sidebar
- **🔗 Markdown paths in chat**: complete absolute `.md` / `.markdown` paths in inline code are clickable in each turn's final assistant message and open through the current session's file address in the native sidebar; missing files show a read error
- **🔌 Service API**: `ctx.betterSidebar` is open to every plugin (`registerTab` / `registerFileViewer`); the built-in 6 tabs + 3 viewers go through the same API, and **28+ ecosystem plugins** already build on it (see "🌐 Plugin Ecosystem")
- **⚡ On-demand loading**: ~325KB core at startup, editor / Mermaid / third-language dictionaries load on demand · **🌏 i18n** follows DSH's language · **🔁 Session isolation** persists layout per session

## 🚀 Installation

**Prerequisites**: DSH installed (`dsh web` boots), Node.js ≥ 20, pnpm ≥ 10.

**Supported DSH versions**:
<a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="Supported DSH versions (v0.24.0): 0.2.0-rc.1+" src="https://img.shields.io/badge/DSH-0.2.0--rc.1%2B-4d6bfe" /></a>

> 📌 **Channel and support line**: `v0.24.1` targets DSH **0.2.0-rc.1+** (0.2.0's first candidate rides npm's `next` dist-tag; `latest` is still 0.1.7-rc.2). **Pin the DSH version exactly**: `npm i -g @deepseek-ai/dsh@0.2.0-rc.1`. **Hosts on the 0.1.7 line should pin `dsh-better-sidebar@0.22.1`**: 0.2.0 is a host minor bump, and caret ranges such as `^0.1.7-rc.1` fail the host's startup compatibility preflight on 0.2.0, which disables the whole profile row silently.

> 🧭 **Pick the plugin version that matches your DSH**:
>
> | Your DSH | Install command | Version / peer declared |
> | --- | --- | --- |
> | **0.2.0-rc.1+** (including a later 0.2.0 stable) | `dsh plugin --profile web add dsh-better-sidebar@latest` | **0.24.1**, `^0.2.0-rc.1` |
> | **0.1.7-rc.1 – 0.1.7-rc.2** (and a later 0.1.7 stable; npm `latest` is still 0.1.7-rc.2) | `dsh plugin --profile web add dsh-better-sidebar@0.22.1` | **0.22.1**, `^0.1.7-rc.1` |
> | 0.1.7-alpha.1 / 0.1.7-alpha.2 | **nothing to install** — move DSH to rc.1 first, then run the row above:<br>`npm i -g @deepseek-ai/dsh@0.1.7-rc.1` | — |
> | 0.1.6-alpha.2 and earlier, `0.1.5-rc.*` (including the 0.1.5-rc.3 that is npm's `latest`) | `dsh plugin --profile web add dsh-better-sidebar@0.19.1` | **0.19.1**, `^0.1.5-rc.1` |
> | `0.1.5-alpha.2` | `dsh plugin --profile web add dsh-better-sidebar@0.19.0-alpha.1` | `^0.1.5-alpha.2` |
> | `0.1.2-rc.*` | `dsh plugin --profile web add dsh-better-sidebar@0.18.1` | `^0.1.2-rc.1` |
> | `0.1.2-alpha.2` | `dsh plugin --profile web add dsh-better-sidebar@0.18.0-alpha.0` | `^0.1.2-alpha.2` |
> | `0.1.0-rc.8` / `0.1.1` | `dsh plugin --profile web add dsh-better-sidebar@0.17.1` | `^0.1.0-rc.8` |
>
> Swap `web` for your own profile name. **Older versions are pinned exactly** (`@0.19.1`, not `@latest`), because `latest` moves forward with each new stable cut; conversely, do **not** install 0.19.1 on a 0.1.7 alpha — it would simply break.

```sh
dsh plugin --profile web add dsh-better-sidebar@latest
```

> The plugin depends on no package that needs a build script (the terminal and `node-pty` went back to DSH wholesale), so installing is **one step**; once installed you can enable / disable it on DSH's own **Plugins page**.

Then **hard-refresh the browser** (Cmd/Ctrl+Shift+R) to see the sidebar (DSH hot-reloads client changes; only host-half updates need a restart).

**Or let DSH install it for you** — paste this prompt into any DSH session:

```text
Install the dsh-better-sidebar plugin (a sidebar workbench for DSH):
1. Run: dsh plugin --profile web add dsh-better-sidebar@latest (`latest` is the current stable)
2. When done, remind me to hard-refresh the browser (Cmd/Ctrl+Shift+R)
If anything fails, check the troubleshooting table in the README at https://github.com/omdsh-dev/DSH-better-sidebar
```

**Option 3: one-shot script** — from a clone of this repo, run `bash scripts/install.sh` (macOS / Linux / Windows Git Bash; native Windows uses `install.ps1`; `-h` for options) — it installs and registers the bundle in one go (including idempotent cleanup of an old manual mount row).

<details>
<summary><b>Updating</b></summary>

```sh
dsh plugin --profile web add dsh-better-sidebar@latest
```

or bump the version in `~/.dsh/profiles/web/package.json` to the matching npm version (`"^0.22.1"`) and run `pnpm install`. Then hard-refresh the browser (Cmd/Ctrl+Shift+R) — client changes do not need a DSH restart.

</details>

<details>
<summary><b>Troubleshooting</b></summary>

| Symptom | Cause & fix |
|---|---|
| `Ignored build scripts` | pnpm 11 blocked a **transitive** dependency's build script. Run `pnpm approve-builds` (no `--all`) in the profile directory (`~/.dsh/profiles/web`) and follow its prompts — the plugin itself has no build-script dependency (`node-pty` left with the terminal). |
| `minimum release age` / version `< 24h` | The release is younger than 24 hours. Wait, or re-run once (pnpm auto-adds `minimumReleaseAgeExclude`). |
| "profile directory not found" | Run `dsh web` once so it initializes `~/.dsh/profiles/web`. |
| Two sidebars on the page | Double-mount. Old hand-written line: `~/.dsh/profiles/web/cordis.patch.yml` still has `- insert: ... better-sidebar ...` — delete it (a same-id duplicate mount makes the loader fail loudly with `duplicate loader entry id`). When an aggregate bundle (e.g. `@linxin666/dsh-web-ui-all`) mounts this package under a **different** id, the plugin's own bundle patch backs off automatically since 0.13.x (it detects an already-enabled mount of the same package name and does not mount itself) — no manual fix needed; if it still double-mounts, make sure the aggregate bundle precedes `dsh-better-sidebar` in `dsh.profile.bundles`. |
| Where did my settings go after upgrading? | DSH 0.1.7 removed the registrable settings namespace: preferences now live on this plugin's **mount row** in the profile (entry id `better-sidebar` by default), not in `~/.dsh/settings.yaml`. On first boot the plugin imports the `dsh-better-sidebar` section of the old `settings.yaml` (renamed `settings.yaml.imported` by the host) exactly once — only fields the current schema still declares, and only while that row has no user values yet, so it never overwrites values set after the upgrade. |
| Terminal unusable / shell fails to start | The terminal comes from **DSH's own `ui-sidebar-terminal`** (this plugin no longer ships a terminal or `node-pty`, and has no terminal settings). Consult DSH's own docs for problems; if the error mentions build scripts, see the row above. |
| `dsh: command not found` | Install DSH first, or run `npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-better-sidebar@latest`. |

</details>

<details>
<summary><b>Install from source / develop (optional — alternative to the npm flow)</b></summary>

To debug local changes or track the dev branch, point the dependency at a local clone and build it yourself:

```text
1. git clone https://github.com/omdsh-dev/DSH-better-sidebar.git ~/Code/DSH-better-sidebar
   cd ~/Code/DSH-better-sidebar && pnpm install && pnpm build
2. In ~/.dsh/profiles/web/package.json dependencies write "dsh-better-sidebar": "link:<absolute path of the clone>"
3. Append this mount line to ~/.dsh/profiles/web/cordis.patch.yml (this row's `config` IS this plugin's settings form: the deployment limits `readLimit` / `mediaLimit` / `uploadLimit` / `listLimit` plus the user-preference fields — that is what the settings page writes; omit it and every field falls back to its schema default):
   - insert:
       - id: better-sidebar
         name: 'dsh-better-sidebar'
         config:
           readLimit: 524288
4. Run pnpm install in ~/.dsh/profiles/web
5. Restart DSH and hard-refresh
```

Update: `git pull && pnpm install && pnpm build` → just hard-refresh the browser (client changes hot-reload; only host-half changes need a DSH restart). To switch back to the npm channel, restore the matching npm version (`"^0.22.1"`) and re-run `pnpm install`.

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

## 🖼️ Feature Tour

> Below are real UI screenshots (two per row; click to zoom).

| | |
|---|---|
| **🗂️ File Workbench: Explorer**<br/><sub>Two explorer modes: embedded in the file preview / standalone file tree. Lazy-loading directory tree whose **expanded directories the host watches per directory and re-lists on change**, symlinks classified by target kind (directory links expand, dangling links flagged), global filename search, file/folder upload buttons plus drag-drop upload, context menu (open in new tab / open to the side / new folder / new file / Open with — the host’s probed OS handlers PLUS the plugin’s own targets (file manager / VS Code / Cursor / Zed / custom editors, SSH remotes, pin-to-menu) / copy paths / rename / delete), **Ctrl/Cmd multi-select with Shift range-select** (batch copy paths, batch delete, **zip and download**), **git changes colored by status with M/A/D/U letters**, a header control to **sort by name / by type with a folders-first switch** (the default is the host's own order), and a hover `@file` button that references a file straight into the composer.</sub><br/><div align="center"><img width="420" alt="File explorer" src="https://github.com/user-attachments/assets/a410bfd2-a8ba-43e6-873e-22417756e94d" /></div> | **📝 Inline Preview: Markdown · HTML**<br/><sub>The Markdown preview renders **Mermaid diagrams** (strict-mode safe rendering + a second sanitize pass; click a diagram for a zoom modal with wheel-zoom and drag-pan), **README-level inline HTML** (badge walls `<div align=center>`, `<details>` blocks nesting markdown, inline tags in table cells — DOMPurify-sanitized, `<script>` stripped, local media rewritten to the session media route) and a floating **table of contents** (appears with ≥3 headings, smooth-scroll jumping, auto-expanding folded blocks); HTML uses the plugin's own **sandboxed preview** with the two escape hatches the host does not have (`htmlViewerNoSandbox` / `htmlViewerDefaultUnsafe`). **Images / PDF / spreadsheets / Office are no longer a plugin capability** — the host's own document preview renders those formats.</sub><br/><div align="center"><img width="420" alt="Markdown + Mermaid preview" src="https://github.com/user-attachments/assets/fe0e5182-55bb-45cc-b98b-a2877c2bdd38" /></div> |
| **🖥️ CodeMirror editor**<br/><sub>An **editable** text / code editor (save, syntax highlighting, preview toggle) — the host's own document preview is **read-only**, which is exactly why the plugin keeps its catch-all viewer.</sub><br/><div align="center"><img width="420" alt="CodeMirror editor" src="https://github.com/user-attachments/assets/b44b488e-568c-4ee0-b96c-e9c906598a77" /></div> | **🖼️ Images / PDF / spreadsheets / Office (provided by DSH)**<br/><sub>These read-only formats render in DSH's own `ui-sidebar-documentpreview`: host-side Office→PDF conversion, worker-backed spreadsheet tables, image / PDF zoom viewports, and **per-directory auto-refresh**. The plugin deleted its own image / pdf / download-fallback viewers and no longer claims those extensions.</sub><br/><div align="center"><img width="420" alt="Inline image preview" src="https://github.com/user-attachments/assets/f9a58c30-5b7a-48b5-9e22-37d7e071f593" /></div> |
| **💻 Terminal (provided by DSH)**<br/><sub>The right-Sidebar terminal is provided by DSH's own `ui-sidebar-terminal`: shell picker, double-click rename, reconnect, restore after reload, theme and contrast following. The plugin no longer ships xterm + node-pty.<br/><br/>⚠️ **Model-side caveat**: the plugin's own 8 `terminal_*` tools (off by default) were the model's only **cross-call persistent** terminal; the upstream equivalent `@deepseek-ai/dsh-tool-terminal` is not mounted by any shipped bundle, so if you need that capability, add a `tool-terminal` row to your profile's `cordis.patch.yml` yourself.</sub><br/><div align="center"><img width="420" alt="Terminal" src="https://github.com/user-attachments/assets/0dad6ad3-ff3f-4b5a-86d2-f832ce65323e" /></div> | **🌿 Changes: Git lens + This-Session lens**<br/><sub>Two lenses on "what changed?": the **Git lens** keeps the full source-control surface (stage / unstage / commit (`Ctrl+Enter`) / revert, history, worktree and child-repo selectors); the **This Session** lens folds the session event log live, recording every file the model read / wrote / edited (grouped by file, kind-filtered, op-count badge). Both lenses now share one 36px header, 28px rows, a single empty state and a sticky commit bar; the **Git lens lists changes as a directory tree** (single-child chains collapsed into one row, collapsible folders with descendant counts, status letters and file icons on the leaves); the git snapshot is shared with the file tree, so staging recolors the tree as well. Clicking any change previews it in the **draggable bottom pane** with the unified diff — del red / add green / mod-blue pairing + intra-line character highlights + syntax coloring + context folding — or expands into a VSCode-style dedicated diff tab (same rendering stack).</sub><br/><div align="center"><img width="420" alt="Changes" src="https://github.com/user-attachments/assets/e7fc1220-305f-4bca-8583-e77ab4f4fa78" /></div> |
| **🌐 External-link takeover (browser view provided by DSH)**<br/><sub>Web tabs are DSH's own `ui-sidebar-browser` (multiple tabs / back-forward-reload / address bar / sandboxed iframe), mounted **only in the desktop profile since 0.1.7** — the Web profile has no such kind. The plugin keeps the half the host does not provide: it takes over **only links a tab type explicitly claims through `urlTarget`** (Ctrl/Cmd-clicks always pass through) and **lets everything else through to the host** (whose `linkOpening` user setting decides where prose links go); the three protocol-routing settings are gone, and a claim whose target type is unavailable at open time falls back to `window.open`.</sub><br/><div align="center"><img width="420" alt="Browser" src="https://github.com/user-attachments/assets/9bc6b65a-64fc-4942-a685-76e391e55606" /></div> | **🧩 Tasks: Agent Topology + Background Jobs**<br/><sub>Live subagent-tree topology (run states, batched live previews) plus the background-jobs list (exit codes / live output / force-kill); new subagents / jobs can auto-activate the Tasks page, expanding the sidebar on wide viewports without forcing narrow full-screen drawers open (configurable).</sub><br/><div align="center"><img width="420" alt="Tasks: subagent topology" src="https://github.com/user-attachments/assets/dcd8ed2f-59fa-405b-937b-2d250f5034dd" /></div> |
| **💬 Side Chat (beta)**<br/><sub>Codex-style side threads: **one independent tab per conversation**; the thread inherits the parent's full context (including the in-progress turn, honestly frozen as "interrupted") and runs independently without polluting the main session; follow-ups survive restarts; one click promotes the thread to a top-level session.</sub><br/><div align="center"><img width="420" alt="Side Chat (beta)" src="https://github.com/user-attachments/assets/3a338c36-f5de-4000-95f3-4b1cd04f60fc" /></div> | **🖥️ DSH's native right sidebar + plugin bottom workbench**<br/><sub>The right column is DSH's own sidebar: the plugin registers every tab type as a native tab (including taking over the built-in Files page), so clicking a file in the chat lands there directly — **formats the host's own document preview already covers are rendered by the host**, and the plugin claims only Markdown / HTML / editable code; the plugin's own bottom panel can stay open alongside it — drag a tab to a pane edge to **split**, to the middle to **merge**, drag the top edge to resize; the toggle lives in the session header.</sub><br/><div align="center"><img width="420" alt="Dual workbench (right sidebar + bottom panel)" src="https://github.com/user-attachments/assets/dfdb875e-a1a8-4d4b-8340-353736b1708f" /></div> |
| **⚙️ Declarative Settings**<br/><sub>The "Side card" section in DSH settings: one small card per tab / viewer with an independent toggle (highlighted enabled state + brand switch); secondary settings open from the "Feature settings" strip at the card bottom (switch / text / number / select rows); plugin-owned settings persist under `pluginSettings`, while the whole preference set lives on this plugin's **mount row** in the profile (since DSH 0.1.7 settings are addressed by Loader entry id).</sub><br/><div align="center"><img width="420" alt="Declarative settings: side cards" src="https://github.com/user-attachments/assets/0800ca64-621e-48da-b7df-aecfddc3ec29" /></div> | **📱 Mobile**<br/><sub>On narrow screens (<768px) the panels become a full-width drawer: bottom-panel tabs merge into the sidebar once, with touch-friendly dragging.</sub><br/><div align="center"><img width="360" alt="Mobile full-width drawer" src="https://github.com/user-attachments/assets/a82ba78a-f4cf-4d85-80e8-050a05beb144" /></div> |



## 💬 Community

WeChat / QQ group QR codes will live here. After uploading the QR images (drag them into any issue/comment to get a `user-attachments` link), replace `src` below and uncomment:

<div align="center">
  <!-- WeChat group QR code
  <img width="220" alt="WeChat group QR code" src="https://github.com/user-attachments/assets/REPLACE_ME" />
  -->
  <!-- QQ group QR code
  <img width="220" alt="QQ group QR code" src="https://github.com/user-attachments/assets/REPLACE_ME" />
  -->
</div>

## 🆕 Recent Updates
<div align="center">
  <a href="https://github.com/user-attachments/assets/d2aea86b-a776-4f01-a6b8-b26b27314336"><img width="33%" alt="Sidebar" src="https://github.com/user-attachments/assets/d2aea86b-a776-4f01-a6b8-b26b27314336" /></a>
  <a href="https://github.com/user-attachments/assets/946f7028-4967-461e-a750-d1b5056b62d0"><img width="33%" alt="Service API base screenshot" src="https://github.com/user-attachments/assets/946f7028-4967-461e-a750-d1b5056b62d0" /></a>
</div>

**Supported DSH versions**: <a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="Supported DSH versions (v0.24.0): 0.2.0-rc.1+" src="https://img.shields.io/badge/DSH-0.2.0--rc.1%2B-4d6bfe" /></a> · full release history on the [Releases](https://github.com/omdsh-dev/DSH-better-sidebar/releases) page

### v0.24.1

> 🐞 **Fix release**: two defects made the file tree rebuild itself on every interaction — (1) the native surface re-created the `files` takeover’s slot registration on EVERY session-state write (folder toggles, tab switches, bottom-workbench drags), so the host swapped the slot entry and unmounted/remounted the whole tab body: the explorer lost its level cache, scroll position and directory watcher and re-listed the entire visible tree; (2) the live-refresh re-list deleted a level from the cache before refetching, replacing its rows with a loading placeholder (a build, a formatter or the model’s own bash made whole folders blink). Now a toggle asks only for the toggled level, the tab body survives, and disk changes update rows in place.

### v0.23.0

> 🧭 **Development-line version (never published to npm; its content ships with v0.24.1)**: the Files and Changes pages rebuilt. The Files page gains **Ctrl/Cmd and Shift multi-select**, a batch bar, **Git change coloring**, **new-folder creation**, reworked drag-and-drop upload and **"Zip and download" on a multi-selection** (a host-side archiving task with progress); "Open with" keeps the host-detected local apps and the plugin's own targets **side by side** (setting `openWithPluginTargets`), and the context menu was restructured; the Changes page is **a hierarchy tree** again (Git view + Agent view, directory staging). Performance: `fs.tree` measured **22.8ms → 3.8ms** (10k entries) with the new batch route `fs.trees` (mount/refresh: N+1 requests → one), and opening the context menu no longer re-lists directories. ⚠️ **Behavior change (security-relevant)**: the **workspace path fence was removed** — the plugin's fs routes can read and write any path the host user can reach (OS permissions only). Details in [CHANGELOG_EN](./CHANGELOG_EN.md#v0230).

### v0.24.0

> 📦 **Support line moved**: DSH **0.2.0-rc.1+** only (peer floor `^0.2.0-rc.1`, CI pins `@deepseek-ai/dsh@0.2.0-rc.1`). **The 0.1.7 line (including npm `latest` = 0.1.7-rc.2) should pin v0.22.1 (the last published release on the 0.1.7 line)**: a caret never spans a minor bump, so `^0.1.7-rc.1` fails the 0.2.0 host's startup compatibility preflight and the whole row is disabled (measured: `semver.satisfies('0.2.0-rc.1','^0.1.7-rc.1',{includePrerelease:true}) === false`).

- 📦 **Baseline lifted to `0.2.0-rc.1`**: 14 DSH peers and 27 `@deepseek-ai/*` devDependencies move together; `dsh.plugin.json`'s `engines.dsh` follows.
- 🔍 **Measured as purely additive**: across the 19 host packages this plugin consumes, **zero value exports were removed**; the only type-surface changes are `ui-primitives` (optional props on `DisclosureRow` / `TextShimmer` / `Tooltip`, plus the overlay top inset), `dsh-session` (new `ToolCallRecovery`) and `dsh-api-remotes` (a new product-analytics remote). Session format stays v4, `SUBAGENT_DESCRIPTOR_VERSION` stays 3, and `dsh/lib/bin.js` plus the `dsh-client-modules` runtime are byte-identical — so **no compatibility branch for 0.1.7 is kept**.
- 🧪 **Mount lane and CI pins follow to `0.2.0-rc.1`**; the peer-shape rule in `tests/market-manifest.spec.ts` now pins the current baseline tuple and records the "a caret never spans a minor bump" lesson.
- ⚠️ **Ecosystem side effect**: the optional `@huanlin/dsh-plugin-better-locale` integration pins the `^0.1.x` line and cannot load on 0.2.0; its 5 unmet peers are the only residue in `pnpm peers check` (upstream has not adapted; unrelated to this plugin's own 14 peers).
**Supported DSH versions**: <a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="Supported DSH versions (v0.22.1): 0.1.7-rc.1+" src="https://img.shields.io/badge/DSH-0.1.7--rc.1%2B-4d6bfe" /></a> · full release history on the [Releases](https://github.com/omdsh-dev/DSH-better-sidebar/releases) page

### v0.22.1

> 📦 **Stable release** (npm `latest`): the support line is **unchanged** — DSH **0.1.7-rc.1+** only (peer floor `^0.1.7-rc.1`, CI pins `@deepseek-ai/dsh@0.1.7-rc.1`), so 0.21.1 / 0.22.0 users can upgrade straight away. Two defects that were **reproducible on a real host while every unit test stayed green** are fixed; **hosts on DSH 0.1.6-alpha.2 or earlier still pin v0.19.1**.

- 🐛 **The `files` takeover could be orphaned → error spam + an empty tree** (community issues #770 / #771, proven from the desktop shell's own log): during an in-page client entry replacement (plugin-market update, Plugins page disable→enable, HMR rebundle), `sync()`'s drop loop released the `files` takeover — which is **not a descriptor** — and re-created it in the same pass. That re-creation ran on an **already inactive** plugin context: `tabs.register` lives on the HOST context and took the id anyway, while the `ctx.slots.inject` right after it threw `cannot create effect on inactive context`, so the disposer was lost and the id became **unregistrable for the rest of the page's life** (`native register files error: … already registered` spam plus the Files window falling back to the host's empty state until a page refresh). The drop loop now **skips `FILES_KIND`** (the takeover lives and dies by the editor-type switch and the seat disposer only), and **any registration that fails after the host took the id is rolled back** (including slots already installed), leaving only a failure the next notification can retry. Taken from community PR #777 (@yanzhaohui1999).
- 🖥️ **macOS desktop: window drag / double-click-title zoom stopped working** (#772): the plugin host is a direct `body` child, so the shell's `html[data-platform=darwin] body > :not(#root) { -webkit-app-region: no-drag }` applied to it — and app-region **ignores `pointer-events`** — leaving the viewport-sized panel layer cancelling every drag strip beneath it (the first drag worked, later ones did not). `[data-dsh-better-sidebar]`, `[data-dsh-panel-host]` and the zoom modal `.mermaidModal` now opt out with the neutral `initial !important`, while panels and their controls stay `no-drag` so clicks are never swallowed. Merges community PR #773 and finishes the job for the zoom modal, the last viewport-sized body child.
- ✅ **They stay fixed**: new unit cases pin "a notification must not tear the takeover down" and "a failed registration must release the type and the slots it installed" to the registry's **event log** (4/4 red on the unfixed code), plus a **deployment-level regression gate** `tests/e2e/native-reload.e2e.ts` (red on 3 consecutive runs against npm 0.22.0, green on 3 consecutive runs of the fixed build (one case, run repeatedly)). The drag contract is guarded by unit cases and by a real cascade probe in the mount lane that reads computed values against the shell's own rules. Verification: `pnpm test` 122 files / 1293 passed / 9 skipped, `pnpm test:mount` and `test:mount:aggregate` green. Incident write-up: [docs/plans/2026-09-28-native-files-takeover-reload-leak.md](./docs/plans/2026-09-28-native-files-takeover-reload-leak.md).

### v0.22.0

> 📦 **Stable release** (npm `latest`): the support line is **unchanged** — DSH **0.1.7-rc.1+** only (peer floor `^0.1.7-rc.1`, CI pins `@deepseek-ai/dsh@0.1.7-rc.1`), so v0.21.1 users can upgrade straight away. **Hosts on DSH 0.1.6-alpha.2 or earlier keep pinning v0.19.1.**

- 🧩 **The Tasks page is now a workflow graph** (the primary view): the session tree renders as layered nodes joined by bezier edges — drag to pan, wheel-zoom to the cursor, fit to the content box, a control cluster bottom-right (graph/tree toggle + fold switch + zoom + fit); the **classic indented tree is kept** (keyboard-navigable) and both modes share one view model, so fold state and team enrichment never drift apart.
- 🃏 **Two-segment node cards**: the top segment is the kind badge (main agent / subagent / teammate / workflow / completed aggregate) + phase badge + name + meta; the bottom bar is the state dot + state word + **the same merged activity line the main agent shows** (concurrent tools grouped and counted, with the running call's detail — wording from the host's `chat` namespace) + a fold button on finished nodes; a running bar is swept across its **whole** width (disabled under `prefers-reduced-motion`). 8px-rounded, hierarchy carried by a faint top-segment tint only, the session you are on wearing a heavier accent border.
- 🔀 **Workflow runs enter the graph**: runs folded from `tool-workflow/*` events (the same events the official panel folds) hang under their origin agent, with member agents re-parented below and boxed per phase with matching badges; members with no catalog row are synthesized from the run's own data, so a finished run still shows who took part.
- 🗂 **Folding split into two groups that say what they hold**: `✓ N completed` (including failures, called out as `N failed`) and `N idle` (teammates that finished a turn and can be called back at any moment) are **two separate rows**; the manual fold button always works, the automatic rule only sweeps idle members once there are 3 or more, and an aggregate's name line reads "first two names + `+N`".
- 🪟 **Two persistent floating windows** (extracted into a reusable `FloatingWindow`): background-job output and the shared task's detail/edit surface — draggable, resizable from every edge, a self-scrolling body, dismissed only by the close button or Escape (no outside click / blur / anchor observer); the task window hands its spare height to the description, so enlarging it gives the content room, and the action row is pinned to the bottom.
- 👥 **Agent Teams board (experimental layer)**: members enrich their nodes and an always-visible strip lists the roster and shared tasks; the state machine follows the host (pending → claim → in progress → complete → reopen) with reassign / edit / two-step delete, and stale CAS revisions get their own notice; member activity is overlaid from `subagents.live`'s `running` flag.
- 🔄 **Background jobs now read the host's client `ctx.jobs`** (a pushed roster plus a non-consuming output stream and `kill`): the plugin deleted its own `jobs.list` / `jobs.output` / `jobs.kill` routes and the event-replay mirror, never touching the model's `job_output` cursor; output streams in a persistent floating window with tail-follow, and the drawer auto-collapses at 8+ agents.
- 🛠 **DSH 0.1.7 data-plane rewrite**: upstream deleted the three `agentTeams.remoteView`-style Remote methods → team reads moved to the Lead Session's **`agentTeam` Session projection** (push-based; the `teams.view` route and its 5-second poll are gone); the two write routes stay, with rejections moved from a result union to a thrown `TeamError` and a stale revision mapped to a 409 `team-conflict`. **The bug this fixed in the wild**: on 0.1.7 the team strip never rendered at all (the route answered `remoteView is not a function`, and the page degraded silently).
- 🐛 **Four defects caught on a real host, all green in unit tests**: the per-node fold button did nothing (blocked by the automatic rule's guards); an idle card never drew a fold button; claiming a task mislabelled it "blocked"; and "complete" on a queued task always failed (a claim comes first).
- 🎨 **Narrow panes and mobile settings**: card and row metrics re-tuned for the native right sidebar's narrow width; the settings page gained a **Mobile** group — on a narrow viewport (≤768px) the Tasks page no longer auto-opens and defaults to the tree view.

> 📜 **Earlier versions**: full release history in [CHANGELOG_EN.md](./CHANGELOG_EN.md) (v0.21.1 → v0.12.3) and on [GitHub Releases](https://github.com/omdsh-dev/DSH-better-sidebar/releases).

## ⌨️ Keyboard Shortcuts

| Action | Keys |
|---|---|
| Save edits | `Ctrl/Cmd + S` |
| Find / replace in file | `Ctrl/Cmd + F` (the panel carries the replace row; `Enter` / `Shift + Enter` next / previous, `Esc` closes) |
| Find next / previous | `Ctrl/Cmd + G` / `Shift + Ctrl/Cmd + G` |
| Select next occurrence | `Ctrl/Cmd + D` |
| Git commit | `Ctrl + Enter` |
| Close tab | Middle mouse button |
| Tab context menu (right-click) | Close / Close Other Tabs / Close Tabs to the Left / Close Tabs to the Right / Close All Tabs (all scoped to the current pane); Reveal in File Manager (for a tab that has a file) |
| Split / merge panes | Drag tab to pane edge / middle |
| Reference file to input | Hover the `@file` button at end of line |
| Copy file path | Right-click row → copy relative/absolute path |

## 🔌 Service API

Since v0.4.0 the plugin exposes the `ctx.betterSidebar` service — other plugins can register sidebar pages and file viewers (the 5 built-in tabs + 3 viewers register through the same service). v0.12.1 completed the base capabilities (complete type exports, capability detection, state subscription, tab badges, lifecycle callbacks, targeted open, plugin-owned settings, etc.).

Full integration docs (complete fields, matching algorithm, HMR pitfalls, declarative settings, version detection, the native-sidebar surface and the skinning contract): **[`docs/external-plugin-guide.md`](./docs/external-plugin-guide.md)**; repository rules (hard constraints / CI / release) live in [`AGENTS.md`](./AGENTS.md).

### ➕ Add Plugins (recommended plugin catalog)

The dashed cards at the end of the "Sidebar content" / "File viewers" grids in the "Side Cards" settings section open the **Add tab plugins** / **Add preview plugins** modals: each declares its open extension point, offers a "**Browse more plugins on GitHub**" button (the [GitHub topic `dsh-better-sidebar`](https://github.com/topics/dsh-better-sidebar)), and lists the recommended catalog (name / repo / description / install script) — "**Open**" jumps to the repo, "**Copy**" writes the install command to the clipboard.

**Curating a new plugin**: append a `PluginEntry` to [`src/client/plugins-tabs.ts`](./src/client/plugins-tabs.ts) (tab registrations) or [`src/client/plugins-viewers.ts`](./src/client/plugins-viewers.ts) (file-previewer registrations) and tag your repo with the `dsh-better-sidebar` topic; data integrity is guarded by `tests/plugin-list.spec.ts`.

## 🛠️ Development & Build

```sh
pnpm install      # @deepseek-ai/* devDependencies resolve (baseline 0.1.7-rc.1, alpha dist-tag) — no token needed
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint . (flat config: js + typescript-eslint + react-hooks recommended)
pnpm build        # → lib/index.js + lib/invariant.js + lib/client.js + lib/client-registry.js + lib/types
pnpm test         # vitest (includes manifest consistency guard; build first)
pnpm watch        # tsdown --watch
```

**Make thin wrappers** (`make help` lists every target; package.json stays the single source of truth):

```sh
make check          # aggregate gate: typecheck → build → test → check:consumer-types (mirrors CI)
make mount          # real-mount smoke: build + pack → install Chromium → pnpm test:mount
make clean          # remove lib/, *.tgz, playwright-report/, test-results/
```

`pnpm check:consumer-types`: the consumer-facing declaration-surface guard — type-checks the built `lib/types` from a browser-only consumer's perspective (no `@types/node`, `skipLibCheck: false`); run `pnpm build` first.

**Architecture**: a single npm package with host/client halves — host (`src/index.ts`): `/sidebar/api/*` JSON API, `/sidebar/file` media route, `/sidebar/html` preview route, `/sidebar/upload` upload route, and two WebSockets (`/sidebar/ws/agent-opens` for model-driven opens, `/sidebar/ws/fs-watch` for the file tree's directory watch; fs / git / preview are all session-scoped behind a trust fence); client (`src/client/index.tsx`): portal sidebar + views + link takeover; state persisted per session in localStorage. Organized per DSH official conventions (no default export, dual client bundles); no dependency on npm / checkout at runtime (`@deepseek-ai/*` provided by the web profile).

## 🔐 Security

- Routes protected by a Host-header trust fence (same as `/api`); `fs.write` is atomic; git only shells out to the CLI and never sets identity
- ⚠️ **Since v0.23.0 the filesystem routes do NO workspace containment**: `fs.tree` / `fs.trees` / `fs.read` / `fs.write` / `fs.rename` / `fs.remove` / `fs.mkdir` / media / HTML preview / `/sidebar/upload` / `archive.build` reach **any path the host user can reach** (OS permissions are the only bound; the `workspaceFence` switch and the 403 branch are gone) — do not treat these routes as fenced
- HTML preview content renders in an **opaque-origin sandboxed iframe** (no `allow-same-origin`/`allow-top-navigation`, `no-referrer`, all permission policies disabled); the `/sidebar/html` route carries a CSP `sandbox` + size/path bounds
- The settings page can disable the HTML preview's sandbox per feature (`htmlViewerNoSandbox` / `htmlViewerDefaultUnsafe`, off by default, with a warning) — when off, content shares the origin with the UI; only recommended for fully trusted content. **The web tab's sandbox is no longer this plugin's surface**: the browser view comes from the host (desktop profile); see DSH's own docs for its sandbox and navigation policy

## ⚠️ Known Limitations

- Git has no push/pull/fetch; Markdown previews provide a manual refresh button with confirmation before discarding unsaved edits; the file tree only watches **expanded** directories (collapsed folders are unsubscribed, and there is no recursive whole-workspace scan); tool inline file-open buttons cannot be intercepted
- Unsaved drafts: closing an editor tab, deleting the file, and refreshing/closing the page all confirm first (the find/replace panel covers the open editor only, not across files); a save is refused when the file changed on disk since it was loaded (a "Reload from disk" action is offered) instead of silently overwriting those bytes
- **Which read-only previews exist is the host's call**: spreadsheets / PDF / images / Office go to DSH's own `ui-sidebar-documentpreview`, while the plugin renders only Markdown / HTML and the editable text buffer; the host implementation (rendering details, zoom, refresh timing) follows the DSH version
- **The browser view exists only in the desktop profile**: the Web profile has no host `browser` kind and the plugin no longer ships a browser tab, so web tabs are desktop-only; login state / third-party cookies / `X-Frame-Options` limits follow the host implementation
- HTML preview renders the saved file (not unsaved drafts)
- No bottom panel on mobile (<768px): on narrow screens its tabs merge into the right sidebar once (after migrating back to desktop they stay in the right sidebar); the desktop bottom panel is only available on wide viewports. Without a selected session, tapping the subdued toggle shows the select-session message; with a selected session, it opens the full-width drawer

## 🖥️ Platform Support

Windows / Linux / macOS (macOS validated daily; the rest covered by unit tests). The plugin carries no native dependencies (the terminal and `node-pty` went back to DSH wholesale), so building needs only Node + pnpm, with no compiler toolchain.

## 🌐 Plugin Ecosystem

The `ctx.betterSidebar` service opens two extension points to every plugin: **`registerTab` (sidebar pages)** and **`registerFileViewer` (file previewers)**. The 5 built-in tabs + 3 viewers register through the exact same API — fully equal capabilities.

```ts
import type {} from 'dsh-better-sidebar'  // triggers the ctx.betterSidebar type merge
export const inject = ['betterSidebar']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'my-plugin:db', title: 'Database', component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  }))
  ctx.effect(() => ctx.betterSidebar.registerFileViewer({
    id: 'my-plugin:csv', exts: ['csv'], fetchStrategy: 'custom',
    load: async (path, scope) => parseCsv(await fetchText(scope, path)),
    component: ({ customData }) => <CsvGrid rows={customData} />,
  }))
}
```

The GitHub topic [`dsh-better-sidebar`](https://github.com/topics/dsh-better-sidebar) already hosts **28+ ecosystem plugins** (and growing):

<div align="center">
  <a href="https://github.com/user-attachments/assets/d4385b7e-aab4-425d-a5c4-2da5da81a34e"><img width="66%" alt="The built-in Add Plugins modal: recommended catalog + one-click install command" src="https://github.com/user-attachments/assets/d4385b7e-aab4-425d-a5c4-2da5da81a34e" /></a><br />
  <i>The built-in "Add plugins" modal in settings: recommended catalog + one-click install command + a direct link to the GitHub topic</i>
</div>

### 📑 Tab Plugins (sidebar pages)

<details>
<summary><b>26 plugins (click to expand)</b></summary>

| Plugin | ⭐ | Description |
|---|---|---|
| [ChenRuoT/dsh-sidebar-qa](https://github.com/ChenRuoT/dsh-sidebar-qa) | <img alt="stars" src="https://img.shields.io/github/stars/ChenRuoT/dsh-sidebar-qa?style=flat&color=4d6bfe" /> | Selection-based side Q&A — Codex-style side questions / Claude Code `/btw` |
| [fuhefei/dsh-sentinel](https://github.com/fuhefei/dsh-sentinel) | <img alt="stars" src="https://img.shields.io/github/stars/fuhefei/dsh-sentinel?style=flat&color=4d6bfe" /> | Condition-driven wakeup: file / command / HTTP / process / webhook watches that wake the agent; dock + sidebar branch + global dashboard |
| [Fisfzy/ego-browser](https://github.com/Fisfzy/ego-browser) | <img alt="stars" src="https://img.shields.io/github/stars/Fisfzy/ego-browser?style=flat&color=4d6bfe" /> | Agent browser: a local browsing tab (`@dsh-external/ego-browser`, auto-registers the sidebar page when better-sidebar is present, floating-bubble fallback otherwise) |
| [jiuge2467/dsh-studio](https://github.com/jiuge2467/dsh-studio) | <img alt="stars" src="https://img.shields.io/github/stars/jiuge2467/dsh-studio?style=flat&color=4d6bfe" /> | Full-stack enhancement workbench: multi-source MCP visual debugging hub, visual thinking engine |
| [Iwctwbh/dsh-flowglass](https://github.com/Iwctwbh/dsh-flowglass) | <img alt="stars" src="https://img.shields.io/github/stars/Iwctwbh/dsh-flowglass?style=flat&color=4d6bfe" /> | Flowglass: live session flowgraph (messages / tool groups / subagent branches) |
| [FeatherHunter/dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck) | <img alt="stars" src="https://img.shields.io/github/stars/FeatherHunter/dsh-mattpocock-skills-deck?style=flat&color=4d6bfe" /> | Game-like mission system for mattpocock/skills: fog-of-war map + task bar |
| [GULI-lab/DSH-element-source](https://github.com/GULI-lab/DSH-element-source) | <img alt="stars" src="https://img.shields.io/github/stars/GULI-lab/DSH-element-source?style=flat&color=4d6bfe" /> | Click any UI element on your dev page to jump to its Vue / React / Svelte / Angular source, straight into the chat |
| [Lzh3070/dsh-file-review-tab](https://github.com/Lzh3070/dsh-file-review-tab) | <img alt="stars" src="https://img.shields.io/github/stars/Lzh3070/dsh-file-review-tab?style=flat&color=4d6bfe" /> | File-change review tab: line-level red/green diffs + undo + chat-line deep links |
| [yq04/dsh-git-remotes](https://github.com/yq04/dsh-git-remotes) | <img alt="stars" src="https://img.shields.io/github/stars/yq04/dsh-git-remotes?style=flat&color=4d6bfe" /> | Git remotes tab: branches / upstream / ahead-behind, fetch with prune, ff-only pull, confirm-before-push |
| [ztyhehe/dsh-better-sidebar-svn](https://github.com/ztyhehe/dsh-better-sidebar-svn) | <img alt="stars" src="https://img.shields.io/github/stars/ztyhehe/dsh-better-sidebar-svn?style=flat&color=4d6bfe" /> | SVN source-control tab: status / diff / log / commit / update / revert / conflict resolution — symmetric to the built-in Git panel |
| [Melody-max114/dsh-excel-panel](https://github.com/Melody-max114/dsh-excel-panel) | <img alt="stars" src="https://img.shields.io/github/stars/Melody-max114/dsh-excel-panel?style=flat&color=4d6bfe" /> | Excel editing: xlsx preview/edit, live formula evaluation, merged cells, save back to the original file |
| [v587d/dsh-anysearch-refs](https://github.com/v587d/dsh-anysearch-refs) | <img alt="stars" src="https://img.shields.io/github/stars/v587d/dsh-anysearch-refs?style=flat&color=4d6bfe" /> | AnySearch results as sidebar cards: query, source snippets, highlighted keywords |
| [mlosun/dsh-docs-panel](https://github.com/mlosun/dsh-docs-panel) | <img alt="stars" src="https://img.shields.io/github/stars/mlosun/dsh-docs-panel?style=flat&color=4d6bfe" /> | Global docs panel: portable Markdown notes, readable from any workspace |
| [lnyuqian/dsh-skill-sidebar](https://github.com/lnyuqian/dsh-skill-sidebar) | <img alt="stars" src="https://img.shields.io/github/stars/lnyuqian/dsh-skill-sidebar?style=flat&color=4d6bfe" /> | Skills panel: scans local skill directories, one-click invocation copy, pinning |
| [g-yixuan/dsh-sidenote](https://github.com/g-yixuan/dsh-sidenote) | <img alt="stars" src="https://img.shields.io/github/stars/g-yixuan/dsh-sidenote?style=flat&color=4d6bfe" /> | Codex-style side chat + selection annotations (a thin consumer plugin) |
| [OMSociety/dsh-ssh-tunnel](https://github.com/OMSociety/dsh-ssh-tunnel) | <img alt="stars" src="https://img.shields.io/github/stars/OMSociety/dsh-ssh-tunnel?style=flat&color=4d6bfe" /> | Multi-host SSH tunnels + SSH manager tab |
| [OMSociety/dsh-git-forge](https://github.com/OMSociety/dsh-git-forge) | <img alt="stars" src="https://img.shields.io/github/stars/OMSociety/dsh-git-forge?style=flat&color=4d6bfe" /> | GitHub / Gitea accounts, project grants and push policy |
| [YesSanSan/dsh-conversation-outline](https://github.com/YesSanSan/dsh-conversation-outline) | <img alt="stars" src="https://img.shields.io/github/stars/YesSanSan/dsh-conversation-outline?style=flat&color=4d6bfe" /> | Conversation outline tab: per-turn structure, quick jump, one-line LLM titles |
| [Wulabalabo/dsh-sidebar-Explorer-Plus](https://github.com/Wulabalabo/dsh-sidebar-Explorer-Plus) | <img alt="stars" src="https://img.shields.io/github/stars/Wulabalabo/dsh-sidebar-Explorer-Plus?style=flat&color=4d6bfe" /> | File-manager tab: upload / move / delete / rename / new folder (write operations) |
| [yq04/dsh-turn-review](https://github.com/yq04/dsh-turn-review) | <img alt="stars" src="https://img.shields.io/github/stars/yq04/dsh-turn-review?style=flat&color=4d6bfe" /> | Turn review: review agent changes turn by turn |
| [Ghz114514/dsh-refpics](https://github.com/Ghz114514/dsh-refpics) | <img alt="stars" src="https://img.shields.io/github/stars/Ghz114514/dsh-refpics?style=flat&color=4d6bfe" /> | Pinterest-style reference-image search: masonry wall, sidebar board, downloads, save-to-Eagle |
| [yzlin499/dsh-yzlin499-easy-plugins](https://github.com/yzlin499/dsh-yzlin499-easy-plugins) | <img alt="stars" src="https://img.shields.io/github/stars/yzlin499/dsh-yzlin499-easy-plugins?style=flat&color=4d6bfe" /> | A handy utility bundle for a bare-bones DSH |
| [dong-victor/dsh-better-sidebar-starter](https://github.com/dong-victor/dsh-better-sidebar-starter) | <img alt="stars" src="https://img.shields.io/github/stars/dong-victor/dsh-better-sidebar-starter?style=flat&color=4d6bfe" /> | Run-configurations tab: IDEA-style Run/Debug configs (npm / springboot / python / custom) — one-click launch, history, WebSocket live logs (ANSI colors), parallel instances, cross-platform process-tree kill |
| [baosfeng/my-dsh-plugins](https://github.com/baosfeng/my-dsh-plugins) | <img alt="stars" src="https://img.shields.io/github/stars/baosfeng/my-dsh-plugins?style=flat&color=4d6bfe" /> | Personal multi-plugin collection (`dsh-file-activity`): a sidebar file-activity tab recording read / added / modified history and stats, flat-browsed by folder, opened with the native preview |
| [Hoemr/dsh-better-overleaf](https://github.com/Hoemr/dsh-better-overleaf) | <img alt="stars" src="https://img.shields.io/github/stars/Hoemr/dsh-better-overleaf?style=flat&color=4d6bfe" /> | Overleaf tab: direct-CDP browser login (third-party Chromium supported), project switching, local git mirrors under the workspace with two-way sync |
| [Andor-Z/dsh-turn-outline](https://github.com/Andor-Z/dsh-turn-outline) | <img alt="stars" src="https://img.shields.io/github/stars/Andor-Z/dsh-turn-outline?style=flat&color=4d6bfe" /> | Turn-outline tab: folds the session by user turns (input + tool steps + output) with one-click jump-back to the exact spot in the conversation; zero-LLM, read-only |

</details>

### 🖼️ Viewer Plugins (file previewers)

<details>
<summary><b>3 plugins (click to expand)</b></summary>

| Plugin | ⭐ | Description |
|---|---|---|
| [HuanLinOTO/dsh-plugin-better-sidebar-plugin-office](https://github.com/HuanLinOTO/dsh-plugin-better-sidebar-plugin-office) | <img alt="stars" src="https://img.shields.io/github/stars/HuanLinOTO/dsh-plugin-better-sidebar-plugin-office?style=flat&color=4d6bfe" /> | Office-suite preview (.docx / .xlsx / .pptx) as a separate bundle to slim the core (in the official recommended catalog) |
| [zemul/dsh-video-preview](https://github.com/zemul/dsh-video-preview) | <img alt="stars" src="https://img.shields.io/github/stars/zemul/dsh-video-preview?style=flat&color=4d6bfe" /> | Inline video preview: .mp4 / .webm / .mov / .mkv / .avi with a /video host route supporting HTTP Range scrubbing |
| [dong-victor/dsh-better-sidebar-jupyter](https://github.com/dong-victor/dsh-better-sidebar-jupyter) | <img alt="stars" src="https://img.shields.io/github/stars/dong-victor/dsh-better-sidebar-jupyter?style=flat&color=4d6bfe" /> | Runnable `.ipynb` notebook view: lazy-start Python kernel, streaming outputs, save-back |

</details>

### 🧰 Enhancements & Tools

<details>
<summary><b>3 plugins (click to expand)</b></summary>

| Plugin | ⭐ | Description |
|---|---|---|
| [dong-victor/dsh-better-sidebar-terminal-plus](https://github.com/dong-victor/dsh-better-sidebar-terminal-plus) | <img alt="stars" src="https://img.shields.io/github/stars/dong-victor/dsh-better-sidebar-terminal-plus?style=flat&color=4d6bfe" /> | Terminal enhancement: bundled Nerd Font icons, xterm glyph fixes, stable terminal cwd |
| [Max-Null/dsh-sidebar-preview-select](https://github.com/Max-Null/dsh-sidebar-preview-select) | <img alt="stars" src="https://img.shields.io/github/stars/Max-Null/dsh-sidebar-preview-select?style=flat&color=4d6bfe" /> | Preview selection boost: select text in any sidebar preview → floating "send to session" |
| [Hoemr/dsh-quicklook](https://github.com/Hoemr/dsh-quicklook) | <img alt="stars" src="https://img.shields.io/github/stars/Hoemr/dsh-quicklook?style=flat&color=4d6bfe" /> | QuickLook-style Space preview: press Space on the active file tab for a full-size image / PDF / text overlay; Space or Esc closes |

</details>

> 📣 **List your plugin**: tag your repo with the `dsh-better-sidebar` topic to appear on the [topic page](https://github.com/topics/dsh-better-sidebar); then PR one `PluginEntry` into [`src/client/plugins-tabs.ts`](./src/client/plugins-tabs.ts) / [`src/client/plugins-viewers.ts`](./src/client/plugins-viewers.ts) to join the built-in recommended catalog (data integrity is guarded by `tests/plugin-list.spec.ts`).

## 🤝 Contributing

- **Code changes go through PRs**: develop on a `feat/*` / `fix/*` branch, then `gh pr create`; docs-only changes may be pushed to main directly
- **Curate an ecosystem plugin**: tag your repo with `dsh-better-sidebar` + PR a `PluginEntry` into [`src/client/plugins-tabs.ts`](./src/client/plugins-tabs.ts) / [`plugins-viewers.ts`](./src/client/plugins-viewers.ts)
- **Before submitting**: `pnpm typecheck && pnpm build && pnpm test` (or `make check` for the one-shot aggregate; CI additionally gates on npm-pack → real-mount → headless-render via `pnpm test:mount`, plus the aggregate double-mount regression `pnpm test:mount:aggregate`)
- See [`AGENTS.md`](./AGENTS.md) for the repository rules (hard constraints, CI lanes, release flow)

## 👥 Contributors

Thanks to everyone who contributed:

<a href="https://github.com/omdsh-dev/DSH-better-sidebar/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=omdsh-dev/DSH-better-sidebar" alt="Contributors" />
</a>

## 🔗 Friends

- [dsh-tianshu-tui](https://github.com/huiliyi37/dsh-tianshu-tui): an interactive terminal UI plugin for DeepSeek Harness (its rendering core evolved from the self-developed harness agent Tianshu-Tui), adding TDD and evidence-gate workflows on top of the official harness
- [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI): a Claude Code-style fullscreen interactive TUI plugin — pixel-whale top bar, live working-status row, streaming thought expansion, double-Esc rollback, context progress bar + TPS meter; one-command npm install
- [dshfind Plugin Market](https://dshfind.com/zh/plugins): a third-party plugin marketplace — a listing of public repos under the GitHub topic `dsh-plugin`, with stars, contributors and growth data synced daily
- [DeepSeek Harness Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop): a modern desktop client for the DeepSeek Harness ecosystem — start and manage a local Harness service without configuring Node.js or running commands; [official site](https://www.dshdesktop.cn)

---

<div align="center">
  <sub>MIT License · Built for the <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> ecosystem · discover more on the <a href="https://github.com/topics/dsh-better-sidebar">dsh-better-sidebar topic</a></sub>
</div>
