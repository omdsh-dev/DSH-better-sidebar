# Viewer File Icons Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let file-viewer plugins provide file-tree and editor-tab icons through the existing `FileViewerDescriptor.icon` registry field.

**Architecture:** Better Sidebar already owns extension matching through `matchFileViewer(path)` and viewer icons through `descriptor.icon`. Reuse that registry in the tree and tab render paths, then delete `dsh-lua-support`'s DOM observer. The Lua plugin remains a normal high-priority viewer that owns its CodeMirror grammar and Charmed icon.

**Tech Stack:** React 18, TypeScript, Better Sidebar service registry, Vitest, CodeMirror 6.

---

### Task 1: Resolve viewer icons centrally

**Files:**
- Modify: `src/client/Sidebar.tsx`
- Test: `tests/sidebar.spec.tsx`

1. Add a failing test asserting an `editor` tab with `path: 'main.lua'` renders the matched viewer icon instead of the generic editor icon.
2. Run `pnpm vitest run tests/sidebar.spec.tsx` and confirm failure.
3. Update `tabIconOf` to resolve `service.matchFileViewer(tab.path)?.icon` for editor file tabs, falling back to the tab descriptor icon.
4. Re-run the focused test and confirm it passes.

### Task 2: Thread viewer icons into the file tree

**Files:**
- Modify: `src/client/FileTree.tsx`
- Modify: `src/client/TreePanel.tsx`
- Modify: `src/client/EditorHost.tsx`
- Test: `tests/editor-host.spec.tsx`

1. Add a failing test that registers a `.lua` viewer icon and asserts the tree row renders it.
2. Run `pnpm vitest run tests/editor-host.spec.tsx` and confirm failure.
3. Add an optional `fileIcon(path)` render prop to `FileTree`/`TreePanel`; have `EditorHost` resolve it from `ctx.betterSidebar.matchFileViewer(path)?.icon`, with the generic code icon as fallback.
4. Re-run the focused test and confirm it passes.

### Task 3: Remove the Lua plugin DOM shim

**Files:**
- Delete: `C:/Users/asher/dsh-lua-support/src/client/file-icons.ts`
- Modify: `C:/Users/asher/dsh-lua-support/src/client/index.tsx`
- Modify: `C:/Users/asher/dsh-lua-support/src/client/LuaEditor.tsx`
- Modify: `C:/Users/asher/dsh-lua-support/tests/lua-support.spec.ts`

1. Remove `installLuaFileIcons`; keep the Charmed glyph solely on the viewer descriptor.
2. Replace CodeMirror's default highlight style with DSH's `--shiki-*` token variables so Lua matches native code surfaces.
3. Update tests to cover descriptor extensions/icon and grammar parsing without DOM mutation.
4. Run `pnpm typecheck && pnpm test && pnpm build` in both repositories.

### Task 4: Activate and verify

**Files:**
- Build output: `lib/client.js` in both repositories
- Profile mounts: `C:/Users/asher/.dsh/profiles/desktop/`

1. Point the desktop profile's `dsh-better-sidebar` dependency at the local feature branch and reinstall.
2. Rebuild both plugins and reinstall the local packages.
3. Restart DSH Desktop once.
4. Verify `http://127.0.0.1:54443/` boot metadata contains `dsh-lua-support`, open `.lua` and `.luau` fixtures, and confirm native-theme highlighting plus Charmed icons in both tree and tab.
5. Commit the Better Sidebar change on a `feat/*` branch and open the required upstream PR.
