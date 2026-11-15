# 2026-11-16 contributor PR batch: side-chat mode, responsive repo switcher, chat paths, release deps

## Scope

- Integrate contributor PRs #1115 (independent native Side Chat tabs), #1130
  (multi-repository picker) and #882 (absolute Markdown paths in chat).
- Fix #1191: the published package installs libraries that are already bundled
  into `lib/client*.js`.
- Triage #1201 (file-tree right-click on desktop) without a speculative code
  fix: the reporter could not be reproduced on macOS Web or Desktop, and the
  proposed `contextual` explanation does not match the host Menu source.

## Product decisions

- **#1115 is opt-in.** The default remains one shared native page with the
  session's last/newest thread reattach. Settings → Side card → Side chat →
  Side-chat pages switches to one native page per thread. The switch affects
  later opens only; existing tabs keep their identity. Occurrence bindings are
  read/written only for `sidebar://sidechat/<uuid>` contentIds, so the shared
  page cannot be captured by an old binding.
- **#1130 stays above Changes.** The switcher renders natural-width chips while
  every location label fits, and one native select once it does not. A hidden
  natural-width row makes the decision content-driven. Labels and the server
  fallback stand-in are shared with the ⋯ → Repository submenu. No fixed
  viewport breakpoint, no extra polling.
- **#882 forwards the host gesture.** DSH 0.2.2's
  `chatFileMentions.forClosing(owner, sessionId, getFileTriggerProps?)` third
  argument is forwarded to the stock provider; the added absolute-path match
  also carries the host file context-menu binding.
- **#1191 keeps `src`.** Only bundled libraries move to devDependencies;
  `./src/*` is an existing export surface and removing it would be a breaking
  change.

## Host compatibility

- rc.2 → rc.3 source diff in the consumed packages is limited to
  `ui-primitives` icons/artwork and package versions; no API changes. The
  `^0.2.2-rc.2` peer floor already accepts rc.3, so both RCs are supported
  without compatibility code. Verification uses a temporary rc.3 dev tree and
  a real rc.3 mount; dev pins/CI stay on the rc.2 baseline.
- sidechat uses the host's stable per-occurrence `contentId`, `openTabs`
  inventory and `registerCloseHandler`; the shared page keeps the host's
  singleton identity.

## #1201 triage

The issue's proposed `Menu.contextual` / `isExternalTrigger` fix does not
explain a menu that never opens: in the rc.2 source, `contextual` controls
cursor positioning, right-click dismissal inside the popup, ARIA linkage and
icon-column alignment; `anchorPoint` already supplies the cursor position.
A diagnostic comment was posted asking for the DSH/plugin versions, OS/desktop
or Web, sidebar mode, console errors, whether a `[role="menu"]` node exists,
whether other host/plugin context menus work, and a read-only probe script.

## Verification

- [x] `pnpm typecheck` (rc.2 baseline and rc.3 temporary dev tree)
- [x] `pnpm lint`
- [x] full `pnpm test` — 303 files / 3,518 passed, 17 skipped on the rc.2 serial lane; the parallel run hit only the known `fs-watch` flake (#868), which passed in isolation
- [x] `pnpm build` + `pnpm check:consumer-types` (both dev trees)
- [x] `pnpm pack` + temp install — 3 packages / 22 MB total; `dependencies` is exactly `ws` / `yaml`, no mermaid / CodeMirror / xterm / react-icons; `src` still packed
- [x] real-host Chromium mount on rc.2 — 26 passed / 6 skipped; both sidechat cases (shared-page repeat, independent three-thread reload) passed
- [x] rc.3 temporary dev tree + real rc.3 mount — full suite 302/303 files (only the baseline pin assertion fails because the temp tree intentionally pins rc.3), 3,517 passed; rc.3 mount 26 passed / 6 skipped
- [ ] CI on `dev` (pending push)

## Links

- [#1115](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1115)
- [#1130](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1130)
- [#882](https://github.com/omdsh-dev/DSH-better-sidebar/pull/882)
- [#1191](https://github.com/omdsh-dev/DSH-better-sidebar/issues/1191)
- [#1201](https://github.com/omdsh-dev/DSH-better-sidebar/issues/1201)
