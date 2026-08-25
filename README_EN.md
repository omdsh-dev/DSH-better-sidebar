# dsh-better-sidebar

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">A service-oriented sidebar framework, and a complete workbench out of the box</b><br /><br />
  <a href="https://www.npmjs.com/package/dsh-better-sidebar"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-better-sidebar" /></a>
  <a href="https://www.npmjs.com/package/dsh-better-sidebar"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-better-sidebar" /></a>
  <a href="https://github.com/omdsh-dev/DSH-better-sidebar/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/omdsh-dev/DSH-better-sidebar/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/omdsh-dev/DSH-better-sidebar/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/omdsh-dev/DSH-better-sidebar" /></a>
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://dshfind.com/en/plugins/omdsh-dev/DSH-better-sidebar?ref=badge"><img alt="dshfind" src="https://dshfind.com/api/badge/omdsh-dev/DSH-better-sidebar?lang=en" /></a><br /><br />
  <a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="Supported DSH versions: 0.1.0-rc.8 · 0.1.1-rc.1 · 0.1.1-rc.2" src="https://img.shields.io/badge/DSH-0.1.0--rc.8_%C2%B7_0.1.1--rc.1_%C2%B7_0.1.1--rc.2-4d6bfe" /></a>
  <a href="https://github.com/topics/dsh-better-sidebar"><img alt="Plugin ecosystem: GitHub topic dsh-better-sidebar" src="https://img.shields.io/badge/plugin%20ecosystem-topic%20dsh--better--sidebar-4d6bfe" /></a><br /><br />
  <img alt="File management" src="https://img.shields.io/badge/-File%20management-4d6bfe" /> <img alt="Edit &amp; preview" src="https://img.shields.io/badge/-Edit%20%26%20preview-4d6bfe" /> <img alt="Embedded browser" src="https://img.shields.io/badge/-Embedded%20browser-4d6bfe" /> <img alt="Real terminal" src="https://img.shields.io/badge/-Real%20terminal-4d6bfe" /> <img alt="Git panel" src="https://img.shields.io/badge/-Git%20panel-4d6bfe" /> <img alt="Background tasks" src="https://img.shields.io/badge/-Background%20tasks-4d6bfe" /> <img alt="Side Chat" src="https://img.shields.io/badge/-Side%20Chat-4d6bfe" /> <img alt="Plugin integration" src="https://img.shields.io/badge/-Plugin%20integration-4d6bfe" /><br /><br />
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
- [🌐 Plugin Ecosystem](#-plugin-ecosystem)
- [🆕 Recent Updates](#-recent-updates)
- [⌨️ Keyboard Shortcuts](#-keyboard-shortcuts)
- [🔌 Service API](#-service-api)
- [🛠️ Development & Build](#-development--build)
- [🔐 Security](#-security) · [⚠️ Known Limitations](#-known-limitations) · [🖥️ Platform Support](#-platform-support)
- [💬 Community](#-community) · [🤝 Contributing](#-contributing) · [⭐ Star History](#-star-history) · [🔗 Friends](#-friends)

## ✨ Features

- **🗂️ File Workbench**: file explorer (lazy-loading tree; symlinks show their target kind — directory links expand, dangling links flagged) + CodeMirror editor; inline preview for images / Markdown (incl. Mermaid diagrams, strict-mode safe rendering + click-to-zoom) / HTML / PDF
- **🌐 Embedded Browser**: multiple web tabs with back / forward / refresh; content runs in a sandboxed iframe; external links are routed by protocol by default — HTTP opens in the sidebar, HTTPS goes to the system browser (both adjustable in settings)
- **💻 Real Terminal**: xterm.js + node-pty real shell, reconnect with transcript replay; optionally injects `terminal_*` tools for the model
- **📂 Model-driven sidebar opens (opt-in)**: with the global setting on, the `sidebar_open` tool lets the model actively open files / folders (tree rooted there) / HTTP(S) pages in the sidebar
- **🌿 Git Panel**: real diff + VSCode-style diff tabs, history, right-click to stage / commit / revert; under a workspace container it discovers child repositories and shows a **repository selector**, with linked-worktree change discovery
- **🧩 Background Tasks**: agent topology + background tasks (exit codes / live output / force-kill)
- **💬 Side Chat (beta)**: Codex-style side threads — the child inherits the parent's FULL context (completed turns + the pending question + the in-progress turn's assistant output and tool activity, honestly frozen as "interrupted") and runs independently without entering the main conversation; threads support continuous follow-ups (auto-resumed after a DSH restart) and one-click "Save as new session" promotion to a top-level session
- **🪟 Dual Workbench**: right sidebar + bottom panel; drag tabs to split / merge panes (cross-panel), mobile auto-merges into a full-width drawer
- **🪟 Free Windows**: drag any tab onto the main conversation area to turn it into a movable / resizable / raiseable floating window (default 390×780); drag it back onto a pane to dock; persisted per session. `features` includes `'floatWindows'` and plugin tabs are supported identically
- **🔁 Session Isolation**: layout / tabs / panels persisted per session, stale state auto-purged
- **⚙️ Declarative Settings**: per-item toggles in the "Side Cards" settings section, secondary settings via the gear dialog
- **⚡ On-demand Loading**: only ~325KB core at startup; heavy deps (terminal / editor / mermaid diagrams) load on demand ([design](docs/plans/2026-08-12-lazy-chunks-design.md))
- **🌏 i18n**: UI text follows DSH's language (zh / en) with live switching; with the optional `@huanlin/dsh-plugin-better-locale` peer, 19 third-language overlays (ja / de / fr / …) are available

> 🔌 **Core principle**: service-first — the 7 built-in tabs + 6 viewers register through the same `ctx.betterSidebar` API as third-party plugins, with fully equal capabilities; anything the ecosystem can provide better is delegated to ecosystem plugins (**28+ ecosystem plugins** already — see "🌐 Plugin Ecosystem" below). See "🔌 Service API" and the [external plugin guide](./docs/external-plugin-guide.md).

## 🚀 Installation

**Prerequisites**: DSH installed (`dsh web` boots), Node.js ≥ 20, pnpm ≥ 10.

**Supported DSH versions**:
<a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="Supported DSH versions: 0.1.0-rc.8 · 0.1.1-rc.1 · 0.1.1-rc.2" src="https://img.shields.io/badge/DSH-0.1.0--rc.8_%C2%B7_0.1.1--rc.1_%C2%B7_0.1.1--rc.2-4d6bfe" /></a>

```sh
dsh plugin --profile web add dsh-better-sidebar@latest   # first run fails: pnpm 11 blocks node-pty build scripts (the dependency is still written)
cd ~/.dsh/profiles/web && pnpm approve-builds --all      # allow the build scripts (re-runs the install automatically)
dsh plugin --profile web add dsh-better-sidebar@latest   # re-run succeeds
```

Then **hard-refresh the browser** (Cmd/Ctrl+Shift+R) to see the sidebar (DSH hot-reloads client changes; only host-half updates need a restart).

**Or let DSH install it for you** — paste this prompt into any DSH session:

```text
Install the dsh-better-sidebar plugin (a sidebar workbench for DSH):
1. Run: dsh plugin --profile web add dsh-better-sidebar@latest (the first run fails because pnpm 11 blocks node-pty build scripts — that's expected)
2. In ~/.dsh/profiles/web run: pnpm approve-builds --all (allows the build scripts and re-runs the install)
3. Run the add command again: dsh plugin --profile web add dsh-better-sidebar@latest
4. When done, remind me to hard-refresh the browser (Cmd/Ctrl+Shift+R)
If anything fails, check the troubleshooting table in the README at https://github.com/omdsh-dev/DSH-better-sidebar
```

<details>
<summary><b>Updating</b></summary>

```sh
dsh plugin --profile web add dsh-better-sidebar@latest
```

or bump the version in `~/.dsh/profiles/web/package.json` (e.g. `"^0.16.1"`) and run `pnpm install`. Then hard-refresh the browser (Cmd/Ctrl+Shift+R) — client changes do not need a DSH restart.

</details>

<details>
<summary><b>Troubleshooting</b></summary>

| Symptom | Cause & fix |
|---|---|
| `Ignored build scripts` | pnpm 11 blocked build scripts. Run `pnpm approve-builds --all` in the profile directory (`~/.dsh/profiles/web`). |
| `minimum release age` / version `< 24h` | The release is younger than 24 hours. Wait, or re-run once (pnpm auto-adds `minimumReleaseAgeExclude`). |
| "profile directory not found" | Run `dsh web` once so it initializes `~/.dsh/profiles/web`. |
| Two sidebars on the page | Double-mount. Old hand-written line: `~/.dsh/profiles/web/cordis.patch.yml` still has `- insert: ... better-sidebar ...` — delete it (a same-id duplicate mount makes the loader fail loudly with `duplicate loader entry id`). When an aggregate bundle (e.g. `@linxin666/dsh-web-ui-all`) mounts this package under a **different** id, the plugin's own bundle patch backs off automatically since 0.13.x (it detects an already-enabled mount of the same package name and does not mount itself) — no manual fix needed; if it still double-mounts, make sure the aggregate bundle precedes `dsh-better-sidebar` in `dsh.profile.bundles`. |
| Terminal fails on Windows | `node-pty` relies on prebuilt binaries; if none match your Node version, install a build toolchain (VS Build Tools). Mainstream Node versions are usually covered. |
| Terminal shows "node-pty failed to load" | The `node-pty` install is missing or broken (e.g. pnpm skipped its build script). The terminal banner shows a repair command — copy it into a terminal/cmd on the DSH machine and run it (in `~/.dsh/profiles/web`: `pnpm approve-builds --all && pnpm rebuild node-pty`), then restart DSH and click Retry. The plugin and DSH core share the same `node-pty@^1.1.0`, so the repair restores both. |
| `dsh: command not found` | Install DSH first, or run `npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-better-sidebar@latest`. |

</details>

<details>
<summary><b>Install from source / develop (optional — alternative to the npm flow)</b></summary>

To debug local changes or track the dev branch, point the dependency at a local clone and build it yourself:

```text
1. git clone https://github.com/omdsh-dev/DSH-better-sidebar.git ~/Code/DSH-better-sidebar
   cd ~/Code/DSH-better-sidebar && pnpm install && pnpm build
2. In ~/.dsh/profiles/web/package.json dependencies write "dsh-better-sidebar": "link:<absolute path of the clone>"
3. Append this mount line to ~/.dsh/profiles/web/cordis.patch.yml (to pick the terminal shell, add `config.shell`; `config.shellArgs` starts it with explicit args — when non-empty they replace the default `-l`. When omitted the host resolves `$SHELL` / the login shell / powershell.exe):
   - insert:
       - id: better-sidebar
         name: 'dsh-better-sidebar'
         config:
           shell: /bin/zsh
           shellArgs:
             - --noprofile
             - --no-rc
4. Run pnpm install in ~/.dsh/profiles/web
5. Restart DSH and hard-refresh
```

Update: `git pull && pnpm install && pnpm build` → just hard-refresh the browser (client changes hot-reload; only host-half changes need a DSH restart). To switch back to the npm channel, restore `"dsh-better-sidebar": "^0.16.1"` and re-run `pnpm install`.

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
| **🗂️ File Workbench: Explorer**<br/><sub>Two explorer modes: embedded in the file preview / standalone file tree. Lazy-loading directory tree, symlinks classified by target kind (directory links expand, dangling links flagged), global filename search, file/folder upload buttons plus drag-drop upload, context menu (open in new tab / open to the side / copy paths), and a hover `@file` button that references a file straight into the composer.</sub><br/><div align="center"><img width="420" alt="File explorer" src="https://github.com/user-attachments/assets/a410bfd2-a8ba-43e6-873e-22417756e94d" /></div> | **📝 Inline Preview: Markdown · Images · PDF**<br/><sub>The Markdown preview renders **Mermaid diagrams** (strict-mode safe rendering + a second sanitize pass; click a diagram for a zoom modal with wheel-zoom and drag-pan), **README-level inline HTML** (badge walls `<div align=center>`, `<details>` blocks nesting markdown, inline tags in table cells — DOMPurify-sanitized, `<script>` stripped, local media rewritten to the session media route) and a floating **table of contents** (appears with ≥3 headings, smooth-scroll jumping, auto-expanding folded blocks); images / PDFs display inline via the media route; the Office suite is covered by an ecosystem plugin.</sub><br/><div align="center"><img width="420" alt="Markdown + Mermaid preview" src="https://github.com/user-attachments/assets/fe0e5182-55bb-45cc-b98b-a2877c2bdd38" /></div> |
| **🖥️ CodeMirror editor**<br/><div align="center"><img width="420" alt="CodeMirror editor" src="https://github.com/user-attachments/assets/b44b488e-568c-4ee0-b96c-e9c906598a77" /></div> | **🖼️ Inline image preview**<br/><div align="center"><img width="420" alt="Inline image preview" src="https://github.com/user-attachments/assets/f9a58c30-5b7a-48b5-9e22-37d7e071f593" /></div> |
| **💻 Real Terminal**<br/><sub>xterm.js + node-pty real shell (not an emulator): transcript replay on reconnect, configurable shell / shellArgs (settings page or `cordis.patch.yml`), and optional `terminal_*` model tools so the agent can open terminals and run commands itself.</sub><br/><div align="center"><img width="420" alt="Real terminal" src="https://github.com/user-attachments/assets/0dad6ad3-ff3f-4b5a-86d2-f832ce65323e" /></div> | **🌿 Git Panel**<br/><sub>Stage / unstage / commit (`Ctrl+Enter`) / revert, plus a history list; clicking a changed file opens a **VSCode-style diff tab** (line-level red/green).</sub><br/><div align="center"><img width="420" alt="Git panel" src="https://github.com/user-attachments/assets/e7fc1220-305f-4bca-8583-e77ab4f4fa78" /></div> |
| **🌐 Embedded Browser**<br/><sub>Multiple web tabs with back / forward / reload / address bar; content runs in an **opaque-origin sandboxed iframe** (live sandbox status in the UI, per-page temporary unlock available); external-link clicks in the chat can be taken over into the sidebar (protocol-based routing, configurable).</sub><br/><div align="center"><img width="420" alt="Embedded browser" src="https://github.com/user-attachments/assets/9bc6b65a-64fc-4942-a685-76e391e55606" /></div> | **🧩 Tasks: Agent Topology + Background Jobs**<br/><sub>Live subagent-tree topology (run states, batched live previews) plus the background-jobs list (exit codes / live output / force-kill); new subagents / jobs can auto-expand the sidebar (configurable).</sub><br/><div align="center"><img width="420" alt="Tasks: subagent topology" src="https://github.com/user-attachments/assets/dcd8ed2f-59fa-405b-937b-2d250f5034dd" /></div> |
| **💬 Side Chat (beta)**<br/><sub>Codex-style side threads: **one independent tab per conversation**; the thread inherits the parent's full context (including the in-progress turn, honestly frozen as "interrupted") and runs independently without polluting the main session; follow-ups survive restarts; one click promotes the thread to a top-level session.</sub><br/><div align="center"><img width="420" alt="Side Chat (beta)" src="https://github.com/user-attachments/assets/3a338c36-f5de-4000-95f3-4b1cd04f60fc" /></div> | **🪟 Dual Workbench: Sidebar + Bottom Panel + Split Panes**<br/><sub>The right sidebar and the bottom panel can stay open together; drag a tab to a pane edge to **split**, to the middle to **merge** (works across panels); panel width/height drag from the left/top edge; on mobile everything merges into a full-width drawer; drag a tab onto the main conversation area to turn it into a **free window** (float / resize / raise, drag back onto a pane to dock).</sub><br/><div align="center"><img width="420" alt="Dual workbench (right sidebar + bottom panel)" src="https://github.com/user-attachments/assets/dfdb875e-a1a8-4d4b-8340-353736b1708f" /></div> |
| **⚙️ Declarative Settings**<br/><sub>The "Side card" section in DSH settings: one small card per tab / viewer with an independent toggle (highlighted enabled state + brand switch); secondary settings open from the "Feature settings" strip at the card bottom (switch / text / number / select rows); plugin-owned settings persist under `pluginSettings`.</sub><br/><div align="center"><img width="420" alt="Declarative settings: side cards" src="https://github.com/user-attachments/assets/0800ca64-621e-48da-b7df-aecfddc3ec29" /></div> | **📱 Mobile**<br/><sub>On narrow screens (<768px) the panels become a full-width drawer: bottom-panel tabs merge into the sidebar once, with touch-friendly dragging.</sub><br/><div align="center"><img width="360" alt="Mobile full-width drawer" src="https://github.com/user-attachments/assets/a82ba78a-f4cf-4d85-80e8-050a05beb144" /></div> |

## 🌐 Plugin Ecosystem

The `ctx.betterSidebar` service opens two extension points to every plugin: **`registerTab` (sidebar pages)** and **`registerFileViewer` (file previewers)**. The 7 built-in tabs + 6 viewers register through the exact same API — fully equal capabilities.

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
<summary><b>24 plugins (click to expand)</b></summary>

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
| [g-yixuan/dsh-sidechat](https://github.com/g-yixuan/dsh-sidechat) | <img alt="stars" src="https://img.shields.io/github/stars/g-yixuan/dsh-sidechat?style=flat&color=4d6bfe" /> | Codex-style side chat + selection annotations (a thin consumer plugin) |
| [thirsty5034/dsh-ssh-tunnel](https://github.com/thirsty5034/dsh-ssh-tunnel) | <img alt="stars" src="https://img.shields.io/github/stars/thirsty5034/dsh-ssh-tunnel?style=flat&color=4d6bfe" /> | Multi-host SSH tunnels + SSH manager tab |
| [thirsty5034/dsh-git-forge](https://github.com/thirsty5034/dsh-git-forge) | <img alt="stars" src="https://img.shields.io/github/stars/thirsty5034/dsh-git-forge?style=flat&color=4d6bfe" /> | GitHub / Gitea accounts, project grants and push policy |
| [YesSanSan/dsh-conversation-outline](https://github.com/YesSanSan/dsh-conversation-outline) | <img alt="stars" src="https://img.shields.io/github/stars/YesSanSan/dsh-conversation-outline?style=flat&color=4d6bfe" /> | Conversation outline tab: per-turn structure, quick jump, one-line LLM titles |
| [Wulabalabo/dsh-sidebar-Explorer-Plus](https://github.com/Wulabalabo/dsh-sidebar-Explorer-Plus) | <img alt="stars" src="https://img.shields.io/github/stars/Wulabalabo/dsh-sidebar-Explorer-Plus?style=flat&color=4d6bfe" /> | File-manager tab: upload / move / delete / rename / new folder (write operations) |
| [yq04/dsh-turn-review](https://github.com/yq04/dsh-turn-review) | <img alt="stars" src="https://img.shields.io/github/stars/yq04/dsh-turn-review?style=flat&color=4d6bfe" /> | Turn review: review agent changes turn by turn |
| [Ghz114514/dsh-refpics](https://github.com/Ghz114514/dsh-refpics) | <img alt="stars" src="https://img.shields.io/github/stars/Ghz114514/dsh-refpics?style=flat&color=4d6bfe" /> | Pinterest-style reference-image search: masonry wall, sidebar board, downloads, save-to-Eagle |
| [yzlin499/dsh-yzlin499-easy-plugins](https://github.com/yzlin499/dsh-yzlin499-easy-plugins) | <img alt="stars" src="https://img.shields.io/github/stars/yzlin499/dsh-yzlin499-easy-plugins?style=flat&color=4d6bfe" /> | A handy utility bundle for a bare-bones DSH |
| [dong-victor/dsh-better-sidebar-starter](https://github.com/dong-victor/dsh-better-sidebar-starter) | <img alt="stars" src="https://img.shields.io/github/stars/dong-victor/dsh-better-sidebar-starter?style=flat&color=4d6bfe" /> | Run-configurations tab: IDEA-style Run/Debug configs (npm / springboot / python / custom) — one-click launch, history, WebSocket live logs (ANSI colors), parallel instances, cross-platform process-tree kill |
| [baosfeng/my-dsh-plugins](https://github.com/baosfeng/my-dsh-plugins) | <img alt="stars" src="https://img.shields.io/github/stars/baosfeng/my-dsh-plugins?style=flat&color=4d6bfe" /> | Personal multi-plugin collection (`dsh-file-activity`): a sidebar file-activity tab recording read / added / modified history and stats, flat-browsed by folder, opened with the native preview |

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
<summary><b>2 plugins (click to expand)</b></summary>

| Plugin | ⭐ | Description |
|---|---|---|
| [dong-victor/dsh-better-sidebar-terminal-plus](https://github.com/dong-victor/dsh-better-sidebar-terminal-plus) | <img alt="stars" src="https://img.shields.io/github/stars/dong-victor/dsh-better-sidebar-terminal-plus?style=flat&color=4d6bfe" /> | Terminal enhancement: bundled Nerd Font icons, xterm glyph fixes, stable terminal cwd |
| [Max-Null/dsh-sidebar-preview-select](https://github.com/Max-Null/dsh-sidebar-preview-select) | <img alt="stars" src="https://img.shields.io/github/stars/Max-Null/dsh-sidebar-preview-select?style=flat&color=4d6bfe" /> | Preview selection boost: select text in any sidebar preview → floating "send to session" |

</details>

> 📣 **List your plugin**: tag your repo with the `dsh-better-sidebar` topic to appear on the [topic page](https://github.com/topics/dsh-better-sidebar); then PR one `PluginEntry` into [`src/client/plugins-tabs.ts`](./src/client/plugins-tabs.ts) / [`src/client/plugins-viewers.ts`](./src/client/plugins-viewers.ts) to join the built-in recommended catalog (data integrity is guarded by `tests/plugin-list.spec.ts`).

## 🆕 Recent Updates

<div align="center">
  <a href="https://github.com/user-attachments/assets/d2aea86b-a776-4f01-a6b8-b26b27314336"><img width="33%" alt="Sidebar" src="https://github.com/user-attachments/assets/d2aea86b-a776-4f01-a6b8-b26b27314336" /></a>
  <a href="https://github.com/user-attachments/assets/946f7028-4967-461e-a750-d1b5056b62d0"><img width="33%" alt="Service API base screenshot" src="https://github.com/user-attachments/assets/946f7028-4967-461e-a750-d1b5056b62d0" /></a>
</div>

**Supported DSH versions**: <a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="Supported DSH versions: 0.1.0-rc.8 · 0.1.1-rc.1 · 0.1.1-rc.2" src="https://img.shields.io/badge/DSH-0.1.0--rc.8_%C2%B7_0.1.1--rc.1_%C2%B7_0.1.1--rc.2-4d6bfe" /></a> · full release history on the [Releases](https://github.com/omdsh-dev/DSH-better-sidebar/releases) page

### v0.16.1

All changes since v0.16.0:

**🐛 Fixes**

- 🧊 **Git panel freeze + restart loop** ([#376](https://github.com/omdsh-dev/DSH-better-sidebar/pull/376), fixes [#369](https://github.com/omdsh-dev/DSH-better-sidebar/issues/369)): opening the Source Control panel could freeze the whole page, and the frozen layout restored itself after every reload with no way out — three unbounded layers compounding, now all bounded: **① status truncation** — the `git status --untracked-files=all` response is capped at 2,000 entries (capped results carry `truncated` and the panel shows a notice, mirroring `fs.read`'s truncation semantics; worktree change counts inherit the bound), so a huge untracked set can no longer freeze the browser main thread; **② bounded repository discovery** — a non-repository cwd (e.g. the home directory) no longer probes every visible child directory serially without limit: probe timeout 30s→5s, at most 200 probed directories, concurrent requests share one in-flight scan plus a 60s TTL cache, ending the `git rev-parse` spawn storm under `~`; **③ reset escape hatch** — loading with `?dsh-sidebar-reset` drops the persisted layout (shared width included) and starts from the default, breaking the loop even when the page is already hung; persisting resumes once the param is gone; `statusTruncated` copy synced across all 19 dictionaries

### v0.16.0

All changes since v0.15.2:

**✨ New features**

- 🪟 **Free windows** ([#354](https://github.com/omdsh-dev/DSH-better-sidebar/pull/354)): drag any tab (built-in or plugin-registered) out of the tab bar **onto the main conversation area** — a dashed drop hint marks the landing zone and release turns it into a floating window (default 390×780, phone-portrait ratio, clamped to the viewport and centered at the drop point). Windows can be moved by dragging the header, resized from the SE corner (≥320×200), raised to the top by clicking anywhere, sent back with the header context menu ("Back to sidebar" / "Close"), and closed with X through the normal `closeTab` lifecycle (pty release etc.). Dragging over a sidebar pane highlights it and releasing **docks** the window back into that pane. `floats` persist per session (restored as-is after refresh, lenient sanitize + geometry clamping). Service semantics: `features` gains `'floatWindows'` — `openTab`'s dedupe/id focus on a floating tab **raises its window** (no duplicate open, no panel expansion), `closeTab` / `activateTab` work on floating tabs and still fire their lifecycle callbacks, `visible` is always true inside a float, and agent-terminal reconcile covers floating windows. Tab content reuses the regular render path; plugin tabs are fully supported. Also ships the 8px-grid spacing cleanup of file sub-pages ([design](docs/plans/2026-08-23-free-window-design.md))
- 📂 **Model-driven sidebar opens (`sidebar_open` tool)** ([#353](https://github.com/omdsh-dev/DSH-better-sidebar/pull/353)): a new global setting `agentOpenTools` (**off by default**) injects **one** tool letting the model open local **files** (editor tab, deduped by path), **folders** (full-window tree rooted there, `meta.dir`) and **HTTP(S) pages** (browser tab, URL prefilled) in the caller's sidebar. Turning the setting off unregisters the tool and clears the undelivered queue; already-open tabs stay. Opens targeting non-active sessions queue and replay when visible (`/sidebar/ws/agent-opens` push, same trust fence). No new public API and no new `/sidebar/api` routes ([design](docs/plans/2026-08-23-agent-open-tools-design.md))
- 📝 **README-level inline HTML + table of contents (TOC) in Markdown previews** ([#360](https://github.com/omdsh-dev/DSH-better-sidebar/pull/360)): previews now genuinely render **block-level inline HTML** — badge walls `<div align=center>`, `<details>` blocks nesting markdown, `<br/>`/`<sub>`/`<img>` inside table cells, `<video>`/`<picture>` — all sanitized through a DOMPurify allowlist (`<script>` and other active content stripped, `<a>` forced `_blank rel=noopener`), with local media `src` rewritten to the session media route. With ≥3 headings a floating **TOC** button appears: smooth scroll, auto-expanding folded `<details>` ancestors, collecting headings from HTML segments too. The renderer is still the host `MarkdownText` (shiki / KaTeX / GFM preserved); pure-markdown documents take the original path with zero regression ([design](docs/plans/2026-08-24-markdown-html-toc-design.md))
- 🌏 **Third-language coverage (19 languages)** ([#339](https://github.com/omdsh-dev/DSH-better-sidebar/pull/339)): optional peer `@huanlin/dsh-plugin-better-locale` adds full dictionaries for ja / de / fr / pt / ko / ar / hi / id / tr / vi / th / ru / it / nl / sv / pl / zh-HK / zh-TW / zh-MO (~340 keys each). Coverage **borrows the DSH English slot**: it is active only while DSH's active locale is `en` and is completely inert under `zh` (no mixed-language UI). The 19 dictionaries are also registered into better-locale so external `ctx.locale.lookup('betterSidebar', key)` callers get the override text. Without better-locale installed `ctx.get('betterLocale')` is undefined and the whole block is a no-op — zh/en behavior is unchanged
- 🌿 **Multi-repository Git selection + linked-worktree discovery** ([#326](https://github.com/omdsh-dev/DSH-better-sidebar/pull/326) [#285](https://github.com/omdsh-dev/DSH-better-sidebar/pull/285)): when the session cwd is a workspace container rather than a Git repository, the Git panel discovers direct child repositories and shows a **repository selector** — status / branch / history / diff / stage / commit / revert / cherry-pick / file opening are all threaded through the selected repository. Linked-worktree change discovery and per-worktree git operations are transactionally bound to the selected checkout (including delayed pagination responses), stale/prunable worktree targets are rejected, and individual inventory failures degrade safely
- 🖥️ **Browser loopback allowlist** ([#365](https://github.com/omdsh-dev/DSH-better-sidebar/pull/365)): a new side-card setting `browserAllowedLoopback` (comma-separated host or host:port entries; bare hosts match every port, host:port matches exactly) lets the sidebar browser navigate to explicitly trusted local addresses. Allowlisted loopback pages additionally get the `allow-same-origin` iframe sandbox token — local dev servers (Vite etc.) need a real origin for their module/HMR/fetch pipeline and would otherwise render blank. The page stays cross-origin to the GUI and to every other site; the server-side `browser.probe` route mirrors the same allowlist
- 📝 **Vue + 28 legacy languages in the editor** ([#202](https://github.com/omdsh-dev/DSH-better-sidebar/pull/202)): `.vue` maps to `@codemirror/lang-vue` (template / script / style dispatch on the `lang` attribute, `<style lang="scss">` preprocessors); zero new dependencies bring scss/sass/less/stylus/ruby/lua/perl/r/dart/scala/groovy/powershell/diff/protobuf/cmake/pug/tcl/haskell/clojure/erlang/julia/pascal/vb/vhdl/stex/objectivecpp via legacy-modes. A throwing language factory degrades to plain text (console.warn) instead of breaking the editor; ambiguous `.v` / `.m` extensions stay unmapped on purpose
- 🔄 **Editor preview refresh trio** ([#215](https://github.com/omdsh-dev/DSH-better-sidebar/pull/215) [#228](https://github.com/omdsh-dev/DSH-better-sidebar/pull/228), fixes [#167](https://github.com/omdsh-dev/DSH-better-sidebar/issues/167)): a **manual refresh** button for text previews; switching back to preview after an edit-save auto-reloads (suppressed while dirty so drafts survive); a successful save while in preview mode reloads on the saved edge. Automatic polling and the `fs.stat` version endpoint are gone (zero background API traffic)
- 🖼️ **Local / relative images in Markdown** ([#292](https://github.com/omdsh-dev/DSH-better-sidebar/pull/292)): `![alt](./img.png)`, `/cwd/img.png` and reference-style `[id]: url` destinations are rewritten to `/sidebar/file` media URLs (still bounded by the session cwd) — previews no longer show just the alt text
- ➕ **New recommended-catalog entry: ego-browser** ([#340](https://github.com/omdsh-dev/DSH-better-sidebar/pull/340)): `@dsh-external/ego-browser` Agent browser tab (registers a sidebar page automatically when better-sidebar is present, falls back to a floating bubble otherwise); description dictionary completed across 19 languages ([#371](https://github.com/omdsh-dev/DSH-better-sidebar/pull/371))

**🐛 Fixes**

- 🛒 **DSH marketplace managed-install compatibility** ([#338](https://github.com/omdsh-dev/DSH-better-sidebar/pull/338)): the public `cordis` entry was removed from `peerDependencies` (the market preview hard-rejects `cordis` in any dependency field — optional does not help), so the npm package satisfies the [dsh-community-market install rules](https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/dsh-community-market/docs/install-and-uninstall.zh.md) — catalog sources (dshfind / 1024Store) can re-issue the `repository_backlink` verified target and the plugin becomes installable through the Desktop market
- 🔤 **Type base migrated to `@deepseek-ai/cordis`** ([#338](https://github.com/omdsh-dev/DSH-better-sidebar/pull/338)): the declaration surface (`src/context-types.ts`) no longer depends on or restates the public `cordis` — `Context` is now an **intersection** of the real vendored cordis Context with the structural service faces, and the `ctx.betterSidebar` type merge lives on `@deepseek-ai/cordis`. **Consumer migration**: change `import type { Context } from 'cordis'` to `import type { Context } from '@deepseek-ai/cordis'` (the `import type {} from 'dsh-better-sidebar'` merge path is unchanged); plugins that never used that import are unaffected
- 🧩 **All internal `ctx.betterSidebar` reads fixed** ([#357](https://github.com/omdsh-dev/DSH-better-sidebar/pull/357), fixes [#356](https://github.com/omdsh-dev/DSH-better-sidebar/issues/356)): on npm-installed DSH 0.1.1-rc.x (web bundle) the sidebar died on every page load (`cannot get property "betterSidebar" without inject`) — the 26 internal direct reads now go through `ctx.get('betterSidebar')` (root reflect-store resolution, immune to the fiber chain); external consumers keep `inject: ['betterSidebar'] + ctx.betterSidebar`
- 🔐 **Session-workspace boundary for file APIs** ([#345](https://github.com/omdsh-dev/DSH-better-sidebar/pull/345), fixes [#328](https://github.com/omdsh-dev/DSH-better-sidebar/issues/328)): fixed `fs.tree / fs.read / fs.write` workspace escapes; media, HTML preview and uploads share real-path symlink validation; regression tests for absolute paths, symlinks, uploads and nested Git sessions
- 🪟 **Panel-host layering and viewport clipping** ([#330](https://github.com/omdsh-dev/DSH-better-sidebar/pull/330) [#278](https://github.com/omdsh-dev/DSH-better-sidebar/pull/278), fixes [#277](https://github.com/omdsh-dev/DSH-better-sidebar/issues/277)): panel host z-index 40→25 — below the DSH cordis dynamic-plugin layer (30), so the workbench no longer covers cordis inventory/approval surfaces (still above AppFrame's 20 and below the 100+ float stack); `overflow: hidden` on the host clips at the viewport edge, so collapsed panels no longer stretch the document into bidirectional scrolling (measured `scrollWidth` 2289→1672 / `scrollHeight` 1280→1032, any skin)
- 📐 **Layout-push hardening** ([#310](https://github.com/omdsh-dev/DSH-better-sidebar/pull/310) [#130](https://github.com/omdsh-dev/DSH-better-sidebar/pull/130) [#180](https://github.com/omdsh-dev/DSH-better-sidebar/pull/180)): conversation column gets `min-height: 0` + `overflow: hidden` + `overflow-wrap: anywhere` (long unbreakable URLs / OAuth links no longer push the composer and left-rail Settings out of the viewport); the layout-push effect is split into "set only" + "remove only on unmount" and the width push is gated on `panelOpen` — dragging the bottom height with the right panel closed no longer squeezes the conversation, and release no longer flashes full-width; `useLayoutEffect` removes cross-paint full-width frames; all three drags flush the final frame and sync `centerRect.right` before committing; bottom height caps at `viewportHeight - PANEL_MIN`; drag handles no longer highlight mid-drag
- 📱 **Mobile: unavailable-sidebar clarity + 1px overflow** ([#254](https://github.com/omdsh-dev/DSH-better-sidebar/pull/254)): with no session the toggle uses `aria-disabled` — keeping the non-executable semantics while allowing touch/keyboard focus so the "select a session to use the sidebar" tooltip is reachable; the panel uses `border-box` so mobile `100vw` includes the left border and no longer causes 1px horizontal overflow
- 📏 **Side-card width shared across sessions** ([#36](https://github.com/omdsh-dev/DSH-better-sidebar/pull/36)): panel width is a layout preference, not session content — "last drag wins" writes the global `dsh-sidebar:v1:width` key that fresh and cached session switches adopt; without a global key (first run / pre-existing sessions) behavior is byte-for-byte unchanged
- 🧹 **Terminals close immediately on session delete** ([#130](https://github.com/omdsh-dev/DSH-better-sidebar/pull/130)): new `PtyManager.closeSession()` subscribing to DSH's `session/disposed` — deleted sessions no longer wait for the 30s reconnect grace to release their terminals (agent terminals are agent-lifecycle-owned and untouched)
- 🔍 **Filename search skips noise directories** ([#342](https://github.com/omdsh-dev/DSH-better-sidebar/pull/342)): `node_modules` / `.pnpm-store` / `.yarn` / `.turbo` / `.next` / `dist` / `build` / `coverage` etc. (case-insensitive, `.git` still skipped) — huge dependency trees no longer burn the 100k visit budget and return `truncated` early, so real files in later directories (`docs/`) are found; no `.gitignore` semantics, still filename lookup
- 📝 **Mermaid global error rendering suppressed** ([#341](https://github.com/omdsh-dev/DSH-better-sidebar/pull/341)): `suppressErrorRendering` enabled — invalid diagrams no longer inject a large error SVG into `document.body`; the component-level error fallback and source display remain
- 🖥️ **Terminal Nerd Font icon fallback** ([#190](https://github.com/omdsh-dev/DSH-better-sidebar/pull/190)): supplementary-plane PUA icons in starship / powerlevel10k prompts (Nerd Fonts v3 Material icon set) no longer render as tofu — `withIconFontFallbacks()` appends Nerd Font icon families to the winning base font (before the first generic family, deduped by family name, CSS global keywords filtered, no color-emoji fonts)
- 🌐 **HTML preview declares UTF-8** ([#193](https://github.com/omdsh-dev/DSH-better-sidebar/pull/193), fixes [#170](https://github.com/omdsh-dev/DSH-better-sidebar/issues/170)): `/sidebar/html` responses carry `charset=utf-8` (Chinese fragments without `<meta charset>` no longer mojibake); original file bytes preserved
- 🧪 **trust-fence Origin compared by hostname** ([#182](https://github.com/omdsh-dev/DSH-better-sidebar/pull/182)): some Chromium builds (Edge 151) serialize the Origin of non-default-port loopback pages without the port — `http://127.0.0.1` against `Host: 127.0.0.1:3080` no longer 403s (mirrors DSH's official gateway fence); different hostnames and opaque null origins are still rejected
- 🪟 **"Show in folder" now reveals in the explorer** ([#94](https://github.com/omdsh-dev/DSH-better-sidebar/pull/94)): the folder-reveal gesture no longer opens the directory as a file in the editor (`"..." is a directory`) — `revealInExplorer` switches to the explorer tab, auto-expands a collapsed panel, expands the parent folder and highlights/scrolls to the produced file; the produced-files selector now reads the engine's Turn deliverables (same source as ui-deliverables)
- 🖱️ **Panel-drag layout flash fixed** ([#180](https://github.com/omdsh-dev/DSH-better-sidebar/pull/180)): dragging the bottom height with the right panel closed no longer shifts the conversation left; release no longer flashes full-width before snapping back
- 🖥️ **PowerShell installer fixes** ([#47](https://github.com/omdsh-dev/DSH-better-sidebar/pull/47)): the remote entry is now "download the script → strip the UTF-8 BOM → run it in memory", so `-Version` / `-DryRun` work again under Windows PowerShell 5.1 (the BOM no longer eats the leading `param(...)`); `pnpm --version` is checked before touching the profile (major <10 fails with a clear error and exit code 1)
- 🔄 **Browser embed probing GET fallback** ([#69](https://github.com/omdsh-dev/DSH-better-sidebar/pull/69)): when a HEAD response omits both `Content-Security-Policy` and `X-Frame-Options`, probe retries once with GET — sites like Alibaba Bailian that only advertise their embed policy on GET no longer show a misleading "refused to connect"; they get the friendly "site refuses embedding" panel with an "open in browser" button
- 🔧 **git-source installs fixed via `unrun` devDependency** ([#336](https://github.com/omdsh-dev/DSH-better-sidebar/pull/336)): tsdown 0.22 loads its config through `unrun` and pnpm 11 does not auto-install peer deps — git-hosted `prepare` no longer fails with `Failed to import module "unrun"` (npm tarballs unaffected)
- 🍃 **Strict `ctx.effect` also fixed 4 latent sites**: interception / IME-guard effect bodies returned `undefined` on failure instead of a disposer (invalid shape under the vendored cordis effect contract) — now a no-op disposer

<details>
<summary><b>Older releases (v0.12.0 – v0.15.2)</b></summary>

### v0.15.2

All changes since v0.15.1:

**✨ New features**

- 🗂️ **"Open in app" submenu in the file tree** ([#334](https://github.com/omdsh-dev/DSH-better-sidebar/pull/334)): the file-tree context menu gains an "Open in app >" submenu — built-in openers (reveal/select in file manager, VS Code, Cursor, Zed), each with a pin button that promotes it to a top-level context-menu item (click again to unpin); with an optional SSH host configured, VSCode-family entries switch to the `vscode-remote/ssh-remote+<host>/<path>` protocol and local-only entries hide automatically; custom editors supported (name + URL template with `{path}` + "VSCode-family" flag, configured in the Files card gear popup). Open actions go through the new host route `POST /sidebar/api/open.external` (argv-array spawn, no shell injection) ([design](docs/plans/2026-08-22-open-with-menu-design.md))
- 📑 **Tab context menu** ([#331](https://github.com/omdsh-dev/DSH-better-sidebar/pull/331)): right-clicking a tab offers **Close / Close others / Close to the left / Close to the right**, scoped to the current pane (tab group); items grey out when there is nothing to close; the menu only opens — it never switches the active tab; bulk closes go through the existing per-tab `onClose` path so lifecycle callbacks, pty release and agent-terminal shutdown all stay intact
- 📄 **Diff files collapsed by default** ([#270](https://github.com/omdsh-dev/DSH-better-sidebar/pull/270)): each changed-file header is now an accessible expand/collapse control; recognized source files expand by default while tests, docs, generated files, lockfiles and unknown types stay collapsed; the existing 500-row cap for expanded content is preserved
- 📖 **README update**: feature tour converted to a table (two screenshots per row, saves space); community section now shows the WeChat group and QQ group QR codes ([#325](https://github.com/omdsh-dev/DSH-better-sidebar/pull/325), QQ group 577011007)

**🐛 Fixes**

- 🪟 **Prune empty restored panes** ([#268](https://github.com/omdsh-dev/DSH-better-sidebar/pull/268)): persisted split panes left empty when ephemeral diff tabs were dropped no longer survive as full-size blanks — `sanitizeState` now also prunes the empty split leaf and repairs the stale active-pane pointer; a fully empty workbench keeps its single empty pane
- 🖥️ **Hide spawned git windows on Windows** ([#301](https://github.com/omdsh-dev/DSH-better-sidebar/pull/301), fixes [#124](https://github.com/omdsh-dev/DSH-better-sidebar/issues/124)): the shared `runGit()` spawn options now set `windowsHide: true`, so repo-status polling and git actions no longer flash console windows on Windows (no behavior change on other platforms)
- 📁 **Untracked files inside new folders** ([#242](https://github.com/omdsh-dev/DSH-better-sidebar/pull/242)): `git status` switched from `--untracked-files=normal` to `--untracked-files=all` — each file inside a new folder now shows as its own row and its diff can be loaded (no more `fs.read` "is a directory" error), matching VSCode's default behavior
- ⚡ **Per-frame React re-renders eliminated for toggles/drags** (closes [#315](https://github.com/omdsh-dev/DSH-better-sidebar/issues/315)): `centerRect` moved to a ref with direct DOM writes to the bottom bar (zero React renders); `TabContent` memoized with an explicit comparator; a new frame-batcher coalesces Divider/dock drags per frame; meaningless locate passes skipped during drags. 4x CPU-throttled A/B: >17ms frames on toggle collapse 19→6 / expand 24→4~6, p95 21ms→15ms; drags unchanged (non-regression)

### v0.15.1

All changes since v0.15.0:

**✨ New features**

- 💬 **Codex-style transcript rework for Side Chat** ([#314](https://github.com/omdsh-dev/DSH-better-sidebar/pull/314)): transcript rows became **collapsible** — tool calls, thinking and context injections share one quiet single-line chrome (chevron + label + one-line argument summary) that expands into an indented body on a hairline thread, no cards or fills; streaming labels and a creating hero shimmer (shimmer = generating), failed tools go danger, `prefers-reduced-motion` stills every loop; **the first question is no longer swallowed by the boundary prompt** — context injection and first contact are delivered as separate events (boundary + parked snapshot ride `agent.inject`, the question wakes the driver), so the transcript maps injections onto a collapsible injection row while genuine user messages — the first one included — render as user bubbles; legacy threads' first message is split out into its own bubble too
- 📖 **README rewrite**: feature tour (real UI screenshots per feature), user-facing DSH compatibility badges, simplified install (`add` → `approve-builds` → `add`, node-pty-safe build, paste-to-DSH install prompt), 28+ plugin ecosystem with per-category collapsed listings

**🐛 Fixes**

- 🖥️ **Terminal pty stays alive across conversation switches** ([#323](https://github.com/omdsh-dev/DSH-better-sidebar/pull/323)): switching sessions is no longer treated as a transient drop — the client sends a `park` control frame on unmount and the host skips the 30s reconnect-grace countdown; switching back (`open()` cancels parked) or explicitly closing the tab resumes the normal lifecycle; agent terminals keep their indefinite lifetime
- 📂 **File-tree upload overlay no longer intercepts Tab drags** ([#317](https://github.com/omdsh-dev/DSH-better-sidebar/pull/317)): dragging tabs (reorder / cross-pane split) across the explorer no longer shows the upload overlay or swallows the event — gated on `dataTransfer.types` containing `Files` (consistent with the panel-host shield), so tabs land normally; OS file drags behave as before
- 💬 **Subagent auto-open debounced** ([#314](https://github.com/omdsh-dev/DSH-better-sidebar/pull/314)): Side Chat thread creation no longer pops the task page — the 0→N trigger rearms for 500ms and re-evaluates the original baseline against the live snapshot, by which time the title filter recognizes the thread; genuine subagents still auto-open

### v0.15.0

All changes since v0.14.0:

**✨ New features**

- 💬 **Side Chat (beta) tab** ([#286](https://github.com/omdsh-dev/DSH-better-sidebar/pull/286)): Codex-style side threads, **one independent tab per conversation** — the child inherits the parent's full context (completed turns + pending messages + the in-progress turn's assistant output and tool activity, honestly frozen with an "interrupted" marker); created with an identical composition (same preset / provider / model) so the first request reuses the parent's input prefix cache; threads stay invisible in the main session list with zero subagent-catalog noise; follow-ups survive DSH restarts (auto cold-resume); one-click "Save as new session" promotes the thread to a top-level session ([design](docs/plans/2026-08-20-sidechat-tab-design.md))
- 📤 **Upload into the files window** ([#239](https://github.com/omdsh-dev/DSH-better-sidebar/pull/239)): header "upload file / upload folder" buttons plus drag-drop (drop on the tree body = workspace root, on a directory row = that directory, on a file row = its parent directory, VSCode semantics); full-window blurred progress overlay while uploading (per-file progress + cancel / Esc); buttons disabled while busy, tree refreshes after the upload settles
- 🧩 **Desktop compatibility in four options** ([#284](https://github.com/omdsh-dev/DSH-better-sidebar/pull/284)): "Position compatibility mode" is now a main-row dropdown — **Auto-detect** (default, conservative: only the standard Window Controls Overlay geometry contributes; real 32/36px caption-overlay heights per shell, live on maximize/restore; zero modification on plain web) / **DSH official web** (explicitly no adaptation) / **Shell preset** (built-in, opt-in; only shells that appeared in this repo's issues/PRs with 100+ stars, "detected" badge when the environment matches) / **Custom** (free-form CSS + shift distance). Documents that already carried compatibility values migrate to the custom scheme; interactive chrome opts out of desktop drag regions (`no-drag`); the bottom-push anchor is a composite selector (`[data-pane]` and `:has(> [data-slot])`)
- 🎛️ **Settings page UI/UX modernization** ([#300](https://github.com/omdsh-dev/DSH-better-sidebar/pull/300)): the side-card secondary-settings entry is now a full-width "Feature settings" strip at the card bottom (replacing the invisible corner gear — much easier to discover); coordinated two-tone enabled state (brand activation accent + success-green check badge); every color is still `--dsw-alias-*` token-derived so skins follow automatically
- ➕ **New entries in the recommended-plugin catalog**: `dsh-docs-panel` (global docs, [#230](https://github.com/omdsh-dev/DSH-better-sidebar/pull/230)), `dsh-flowglass` ([#261](https://github.com/omdsh-dev/DSH-better-sidebar/pull/261)), `dsh-git-forge` and `dsh-ssh-tunnel` ([#204](https://github.com/omdsh-dev/DSH-better-sidebar/pull/204)), `dsh-turn-review` ([#102](https://github.com/omdsh-dev/DSH-better-sidebar/pull/102))

**🐛 Fixes**

- ⚡ **Batched live preview for the subagent page** ([#298](https://github.com/omdsh-dev/DSH-better-sidebar/pull/298)): the old implementation polled `subagents.history` per running subagent, each poll triggering a full host-side enumeration — an O(N²) amplification that stalled the page with many concurrent subagents; now a single batch route `subagents.live` (one enumeration of the whole tree) plus one client poller with a single in-flight request; display logic and copy unchanged
- 🖱️ **Interrupted / fast-release drags no longer roll back** ([#249](https://github.com/omdsh-dev/DSH-better-sidebar/pull/249), closes [#247](https://github.com/omdsh-dev/DSH-better-sidebar/issues/247) [#248](https://github.com/omdsh-dev/DSH-better-sidebar/issues/248)): interrupted or fast-released drags commit the last known position; HMR re-activation re-locates the center column (fixes the blank bottom panel after a hot reload)
- 📐 **Push variables stay effective while mounted** ([#259](https://github.com/omdsh-dev/DSH-better-sidebar/pull/259), fixes [#258](https://github.com/omdsh-dev/DSH-better-sidebar/issues/258)): the bottom panel no longer flashes full-width after a drag is released
- 🔐 **Workspace boundary hardening for file APIs** ([#328](https://github.com/omdsh-dev/DSH-better-sidebar/issues/328)): `fs.tree/read/write`, media, HTML preview, and uploads now share real-path containment checks that reject outside absolute paths and symlink escapes
- 🔧 **Adapted to DSH 0.1.1-rc.1 / rc.2 (@next)** ([#297](https://github.com/omdsh-dev/DSH-better-sidebar/pull/297) [#305](https://github.com/omdsh-dev/DSH-better-sidebar/pull/305)): no code changes needed
- 🔒 **Upload-chain hardening** ([#239](https://github.com/omdsh-dev/DSH-better-sidebar/pull/239)): empty and absolute `relativePath` segments are refused outright; uniquely named temp files (concurrent uploads stay independent, crashed processes never block later uploads); write-stream error listeners (a failing disk can no longer crash the host); client error codes unified with the wire (`too-large`), 413s localized

### v0.14.0

> ⚠️ This release requires DSH ≥ 0.1.0-rc.8. All changes since v0.13.1:

**✨ New features**

- 🖼️ **Unified panel-host injection refactor** ([#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)): panels/toggle clusters moved into a `[data-dsh-panel-host]` fixed containing block (`fixed inset-0 z-40`), immune to desktop-shell intermediate transforms hijacking `fixed`; mount self-check (page-level transform → `data-dsh-panel-host-degraded` degraded sync, judged on uncorrected geometry, exits only when the ancestor transform is gone); push anchor switched to `#root [data-dsh-frame] > [data-pane="conversation"]` + `#root` calc width against desktop-shell additive overflow; chunk revalidation on activation (HEAD+ETag keeps unchanged chunks, 5s timeout fails open); `visualViewport` keyboard inset + `env(safe-area-inset-*)` mobile adaptation
- 📂 **Separate file windows by default** ([#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)): `editorExplorer` now defaults to **separate** — tree clicks / file opens create a new tab per path and the path-less window is a pure file manager; merged mode stays available as an opt-in
- 🖥️ **Terminal shell / shellArgs configurable from the settings page** ([#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)): the terminal card's gear popup gains "Shell path" and "Shell arguments" rows (previously yaml-only via `cordis.patch.yml`) — saved values take effect immediately for terminals opened afterwards (UI terminals and model `terminal_create` alike); empty keeps the existing yaml → `$SHELL` / login shell / `powershell.exe` resolution order
- 🏷️ **Version badge on the settings page** ([#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)): the side-card settings section now opens with a `DSH-better-sidebar v0.14.0` identity badge (version synced with the service instance, test-guarded)
- 🔍 **Add-plugin catalog: search / grouping / independent scroll** ([#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)): built for a growing plugin ecosystem — a live search box (filters by name / id / description), optional `category` grouping for entries, and an independently scrolling list (the modal no longer grows unbounded with catalog size)

**🐛 Fixes**

- 🧩 **rc.8 module-system migration** ([#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)): rc.8 no longer exposes the `window.__DSH_MODULES__` page global (it moved to the `ctx.modules` service), which broke every lazy chunk's externals resolution — the client now injects the `modules` service and shares it with chunk-bundle copies through a plugin-owned global (terminal / editor / Mermaid on-demand loading restored)
- 🧩 **Chunk revalidation barrier hardening** ([#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)): HEAD revalidation gains a 5s timeout (fails open on a stuck route so the barrier can never wedge lazy loads); `resetChunks` clears a pending revalidation barrier
- 🖱️ **Drag robustness** ([#232](https://github.com/omdsh-dev/DSH-better-sidebar/pull/232)): fast releases (browsers merge/lose pointermove bursts) commit the last known dragged position instead of rolling back; `pointercancel` / lost-capture interruptions keep the drag result too; the center column is re-measured right after commit (no mid-frame bottom-panel width jump); HMR re-activation re-locates the center column via an `<html>` style observer plus a retry when the bottom panel opens (fixes the blank bottom panel / shifted input bar after a hot reload)

### v0.13.1

**✨ New features**

- 📊 **Safe Mermaid rendering in the Markdown preview** ([#164](https://github.com/omdsh-dev/DSH-better-sidebar/pull/164)): when a previewed md file contains mermaid fences, a `client-mermaid.js` chunk (~7MB) is served on demand (zero load without mermaid); defense-in-depth rendering — `securityLevel: 'strict'` + `htmlLabels: false` (node labels use real SVG `<text>`) + a second sanitize pass before SVG injection (foreignObject/script/foreign HTML elements removed, `@*`/`on*`/`href` attributes stripped); click a diagram to zoom in a modal overlay (wheel zoom centered on the cursor, drag pan, toolbar & shortcuts), re-renders with light/dark theme, falls back to the raw code block on parse failure
- 🖥️ **Configurable terminal shell & shellArgs** ([#125](https://github.com/omdsh-dev/DSH-better-sidebar/pull/125)): `cordis.patch.yml` `better-sidebar.config` can set `shell` / `shellArgs` (a non-empty `shellArgs` fully replaces the defaults; unset keeps the previous auto-resolution of `$SHELL` / login shell / `powershell.exe`), applied to both UI terminals and agent terminals (`terminal_create`); terminal tab titles now show the shell name (bash/zsh/powershell) and internal tab ids use UUIDs so the same shell can open multiple terminals

**🐛 Fixes**

- 🔗 **Aggregate double-mount auto-yield** ([#200](https://github.com/omdsh-dev/DSH-better-sidebar/pull/200)): when an aggregate package (e.g. dsh-web-ui-all) mounts the same package under its own entry id, the guard expression in `cordis.patch.yml` disables the plugin's own `better-sidebar` row so `/sidebar/api` is no longer registered twice (`duplicate prefix route` crashing the whole plugin tree / `dsh web`); standalone installs behave as before
- 🔧 **Adapted to DSH 0.1.0-rc.7** ([#207](https://github.com/omdsh-dev/DSH-better-sidebar/pull/207), fixes [#206](https://github.com/omdsh-dev/DSH-better-sidebar/issues/206)): fixes the `agent-presets: refusing to compose an unscoped context` error when picking a model / sending a message after DSH moved to rc.7

### v0.13.0

**✨ New features**

- 📁 **Files window merged with the explorer** ([#151](https://github.com/omdsh-dev/DSH-better-sidebar/pull/151)): new `editorExplorer` setting (editor card gear) — file tabs gain a path-input header plus a toggleable right-docked file tree (per-tab open/width memory, drag-resize 160–480px from the left edge, global filename search via the host `fs.search` route with a hard budget, skipping `.git` and symlink dirs); in separate mode (default) tree clicks / Enter in the path input open each file **in its own new tab**, merged mode switches the current tab **in place**; fresh sessions seed an empty Files window instead of the explorer tab, and a path-less window is a bare file manager in separate mode / a chrome'd empty file window in merged mode; the tree context menu offers "Open in new tab" and "Open to the side" (split)
- 🎛️ **Select rows for declarative settings** ([#151](https://github.com/omdsh-dev/DSH-better-sidebar/pull/151)): settings rows gain `type: 'select'` (`options` with value/title/desc/icon, `multi` stores the picked values as an array); options with icons render big-icon option cards and keep the icon in the closed anchor; `editorExplorer` became an iconed select (merged vs separate); the capability list gained `settingSelect`
- 🔀 **Mutual exclusion with the dsh-web-ui family right panel** ([#181](https://github.com/omdsh-dev/DSH-better-sidebar/pull/181)): reads the `aionui-panel` settings namespace's provider choice — when "Use aionui-panel" is selected, the whole better-sidebar (right sidebar / bottom panel / floating entry / all takeovers) does not mount; with DSH-better-sidebar (or no aionui installed) it behaves as before. Takes effect live after a settings save (settings-document push), no reload needed

### v0.12.3

**✨ New features**

- 🎨 **Skin compatibility (token-driven)**: fully consumes DSH design tokens and follows the dsh-web-ui skin center's 10 skins automatically; terminal/editor surfaces fall back to opaque backgrounds under transparent/translucent-glass token values so text never scrolls over the skin art ([#110](https://github.com/omdsh-dev/DSH-better-sidebar/pull/110), fixes #106 #105 #90 #60, also #52 #57 #92)
- 🗂️ **Unified path handling**: UNC / symlink classification (directory symlinks expandable, broken links highlighted) + HTML-route platform guards ([#134](https://github.com/omdsh-dev/DSH-better-sidebar/pull/134), #65 #67 #43 #79 #115)
- 🖥️ **Configurable terminal shell**: custom shell setting with Windows pwsh auto-probe ([#95](https://github.com/omdsh-dev/DSH-better-sidebar/pull/95))
- 📝 **Editor languages**: C# / Kotlin / Swift syntax highlighting ([#120](https://github.com/omdsh-dev/DSH-better-sidebar/pull/120))
- 🧭 **Settings nav icon**: settings-page navigation icon and layout polish ([#114](https://github.com/omdsh-dev/DSH-better-sidebar/pull/114))
- ➕ **Recommended-plugin catalog**: added `dsh-git-remotes` — Git Remotes tab (branches/upstream/ahead-behind, fetch with prune, ff-only pull, confirm-before-push; does not replace the built-in stage/commit tab) ([#91](https://github.com/omdsh-dev/DSH-better-sidebar/pull/91)); and `dsh-video-preview` — inline video preview (.mp4/.webm/.mov/.mkv/.avi etc.) backed by a /video host route with HTTP Range (206) scrubbing, not capped by the 20MB mediaLimit ([#126](https://github.com/omdsh-dev/DSH-better-sidebar/pull/126))

**🐛 Fixes**

- 🔧 **xterm migration**: deprecated xterm dependency migrated to `@xterm/xterm` (Closes [#122](https://github.com/omdsh-dev/DSH-better-sidebar/issues/122), [#128](https://github.com/omdsh-dev/DSH-better-sidebar/pull/128))
- 📝 **Markdown editor**: selection-to-conversation popup restored ([#24](https://github.com/omdsh-dev/DSH-better-sidebar/pull/24))
- 🖼️ **Markdown preview renders local/relative images**: image destinations that point at local files (relative/absolute paths, reference-style `[id]: url`) are rewritten to `/sidebar/file` media URLs and displayed in the preview (previously only absolute http(s) images rendered; relative paths showed just the alt text)
- 🐛 **node-pty load failure no longer crashes the server** ([#140](https://github.com/omdsh-dev/DSH-better-sidebar/issues/140)): the host half now lazy-loads node-pty — when it is missing the plugin still mounts, the terminal shows a repair banner (copyable command + Retry button), and agent terminal tools are skipped
- 🧪 Test engineering: unit spec split (#141) + flaky smoke cleanup fix

</details>

## ⌨️ Keyboard Shortcuts

| Action | Keys |
|---|---|
| Save edits | `Ctrl/Cmd + S` |
| Git commit | `Ctrl + Enter` |
| Close tab | Middle mouse button |
| Tab context menu (right-click) | Close / Close Other Tabs / Close Tabs to the Left / Close Tabs to the Right (current pane) |
| Split / merge panes | Drag tab to pane edge / middle |
| Reference file to input | Hover the `@file` button at end of line |
| Copy file path | Right-click row → copy relative/absolute path |

## 🔌 Service API

Since v0.4.0 the plugin exposes the `ctx.betterSidebar` service — other plugins can register sidebar pages and file viewers (the 7 built-in tabs + 6 viewers register through the same service). v0.12.1 completed the base capabilities (complete type exports, capability detection, state subscription, tab badges, lifecycle callbacks, targeted open, plugin-owned settings, etc.).

Full integration docs:
- **[`AGENTS.md`](./AGENTS.md)** — the in-repo integration doc (full fields, matching algorithm, HMR pitfalls, declarative settings, version detection);
- **[`docs/external-plugin-guide.md`](./docs/external-plugin-guide.md)** — the external-plugin guide (with a complete minimal example).

### ➕ Add Plugins (recommended plugin catalog)

The dashed cards at the end of the "Sidebar content" / "File viewers" grids in the "Side Cards" settings section open the **Add tab plugins** / **Add preview plugins** modals: each declares its open extension point, offers a "**Browse more plugins on GitHub**" button (the [GitHub topic `dsh-better-sidebar`](https://github.com/topics/dsh-better-sidebar)), and lists the recommended catalog (name / repo / description / install script) — "**Open**" jumps to the repo, "**Copy**" writes the install command to the clipboard.

**Curating a new plugin**: append a `PluginEntry` to [`src/client/plugins-tabs.ts`](./src/client/plugins-tabs.ts) (tab registrations) or [`src/client/plugins-viewers.ts`](./src/client/plugins-viewers.ts) (file-previewer registrations) and tag your repo with the `dsh-better-sidebar` topic; data integrity is guarded by `tests/plugin-list.spec.ts`.

## 🛠️ Development & Build

```sh
pnpm install      # @deepseek-ai/* devDependencies resolve to 0.1.1-rc.1 (published) — no token needed
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

- Git has no push/pull/fetch; Markdown previews provide a manual refresh button with confirmation before discarding unsaved edits; no file watcher or automatic polling; tool inline file-open buttons cannot be intercepted
- Dragging a terminal tab to another pane remounts it (shell restarts)
- Office-suite preview (.docx/.xlsx/.pptx) moved to the recommended office plugin (see the "Add plugins" modals in settings); without it these files fall through to the code/download fallbacks
- Browser sandbox has no login state / third-party cookies are restricted; some sites need popup login; sites that refuse embedding via `X-Frame-Options`/`frame-ancestors` (e.g. arxiv.org) show a reason panel (with "Open in browser"); in-iframe navigation does not enter the back stack
- HTML preview renders the saved file (not unsaved drafts)
- No bottom panel on mobile (<768px): on narrow screens its tabs merge into the right sidebar once (after migrating back to desktop they stay in the right sidebar); the desktop bottom panel is only available on wide viewports; auto-open terminal on first bottom-panel expand does not trigger on mobile. Without a selected session, tapping the subdued toggle shows the select-session message; with a selected session, it opens the full-width drawer

## 🖥️ Platform Support

Windows / Linux / macOS (macOS validated daily; the rest covered by unit tests); `node-pty` prefers prebuilt binaries, otherwise a build toolchain is required (Windows VS Build Tools / Linux make+g+++python3 / macOS Xcode CLT).

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

## 🤝 Contributing

- **Code changes go through PRs**: develop on a `feat/*` / `fix/*` branch, then `gh pr create`; docs-only changes may be pushed to main directly
- **Curate an ecosystem plugin**: tag your repo with `dsh-better-sidebar` + PR a `PluginEntry` into [`src/client/plugins-tabs.ts`](./src/client/plugins-tabs.ts) / [`plugins-viewers.ts`](./src/client/plugins-viewers.ts)
- **Before submitting**: `pnpm typecheck && pnpm build && pnpm test` (CI additionally gates on npm-pack → real-mount → headless-render via `pnpm test:mount`)
- See [`AGENTS.md`](./AGENTS.md) for the repository rules (hard constraints, CI lanes, release flow)

## ⭐ Star History

<a href="https://star-history.com/#omdsh-dev/DSH-better-sidebar&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=omdsh-dev/DSH-better-sidebar&type=Date&theme=dark" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=omdsh-dev/DSH-better-sidebar&type=Date" />
  </picture>
</a>

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
