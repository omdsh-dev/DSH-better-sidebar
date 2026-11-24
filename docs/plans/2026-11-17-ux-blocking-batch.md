# 2026-11-17 open-PR / open-issue scan: UX-blocking batch

## Scope

Scanned all 157 open issues and 65 open PRs (`node .agents/skills/issue-triage/scripts/snapshot.mjs`).
The owner reviewed the shortlist and selected the two batches processed here:

- **A** — five in-repo defects that block or badly degrade a core surface.
- **B** — contributor PR #1206 (WSL Git tab).

Everything else identified by the scan was deliberately left for later; it is
recorded under "Deferred" so the next batch does not have to re-derive it.

## Product decisions

- **#1166 keeps the fallback local.** A secure-context-only `crypto.randomUUID`
  cannot be polyfilled at the app boundary without touching host code, so the
  three tab-id call sites go through one internal `freshId()`. It is NOT
  exported and NOT promoted to a general id utility: `open-with.ts` and
  `share-client.ts` already had their own guards, and unifying three unrelated
  call sites behind a new module would be a refactor with no caller asking for it.
- **#1212 sends one explicit boolean.** The host settings route deep-merges, so
  a deleted key cannot mean "shown". The first implementation also normalized
  `guideHidden` in `parsePrefs`; that was dropped — every reader already asks
  `=== true`, so the stored `false` reads as shown on its own. Smaller diff,
  same behaviour.
- **#1159 fixes the discarded read, not the registration path.** The issue's
  own diagnosis (first `sync()` runs before hydration) was tested and disproved:
  `store.subscribe(sync)` does release a late-disabled type. The real defect is
  the boot race throwing away the losing read's answer while
  `settings/document-updated` only fires on a *change*. So the timeout path now
  adopts the same read's late answer, generation-guarded.
- **#1214 adds a command, not a toolbar.** `EditorToolbarControls.search` is
  optional so existing `{ setMode, save }` mocks stay valid; the self-toolbar
  button and the host header share one `search()` closure.
- **#1165 reuses the degraded path.** No new viewer, no new setting, byte limit
  unchanged. The host refuses the document at `fs.read` with `reason: 'line'`
  and the client renders the existing paged preview with a notice that names the
  real cause. The probe is bounded to the document head (64 K chars) — a
  deliberate limit, documented in code and changelog.

## Merged

| Commit | Subject | Closes |
| --- | --- | --- |
| `2c7c0cba` `416e20d2` | fix(git): keep the UNC spelling of a WSL repository root (contributor @llwinty, PR #1206) | #1189 |
| `ddfcb670` | fix(client): mint tab ids without `crypto.randomUUID` | #1166 |
| `160f0682` | chore(client): log the quote-chip probe at debug level | #1179 |
| `58cf84b7` | fix(settings): re-show a start-page card with an explicit false | #1212 |
| `c337adbb` | fix(client): apply side-card prefs that arrive after the boot timeout | #1159 |
| `da13770e` | fix(editor): offer find when the host owns the header | #1214 |
| `62a9ceee` | fix(editor): keep a single very long line out of the edit buffer | #1165 |

PR #1206 was rebased onto `dev` and fast-forwarded, so the contributor's commits
sit on first-parent with `xucl <xucl@si-tech.com.cn>` as author. The PR is
**closed**, not merged: the contributor's branch was not force-pushed (per
[docs](../../.agents/skills/external-pr-integration/SKILL.md) §3), so GitHub
cannot show a MERGED badge. `CONTRIBUTORS.md` and both changelogs carry the credit.

## Verification

Run in an isolated worktree based on `origin/dev` (`cbc2f575`), Node 24.16.0, pnpm 11.8.0:

- [x] `pnpm typecheck`
- [x] `pnpm exec eslint .`
- [x] full `vitest` — 304 files, **3537 passed**, 17 skipped, 2 failed
- [x] `pnpm build`
- [x] `pnpm check:consumer-types`
- [x] `pnpm pack` + `pnpm test:mount` — real host (DSH 0.2.2-rc.2) + Chromium, **26 passed / 6 skipped**
- [ ] CI on `dev` (running at the time of writing)

The 2 failing tests (`tests/market-manifest.spec.ts`, `tests/plugin-meta.spec.ts`)
are **pre-existing and environmental**: both spawn `pnpm pack` and die on
"this project is configured to use 11.8.0 of pnpm, your current pnpm is v11.7.0"
before any project code runs. Reproduced identically on an untouched
`origin/dev` checkout, and the passing count there is 3522 (this batch adds 15).

Each fix was red-green checked by reverting only its source change:

| Issue | Failure observed without the fix |
| --- | --- |
| #1166 | `TypeError: crypto.randomUUID is not a function` at `builtins/tabs.tsx:312` |
| #1212 | `settingsUpdate` called with the sparse map, not `{ guideHidden: { a: false } }` |
| #1159 | (new helper) late-answer callback never invoked |
| #1214 / #1165 | covered by the new cases in `editor-host` / `editor-limits` |

## Deferred (found by the scan, not in this batch)

- **#1204** — DSH master (post-rc.3) removed `connection.requestRejection`.
  **Verified not to affect npm 0.2.2-rc.3**: `@deepseek-ai/dsh-client-connection@0.2.2-rc.3`
  still ships `requestRejection` (lib/index.js:737, and both `rpc.d.ts` /
  `rpc-host.d.ts`), and the rc.3 docs still list it on `ctx.connection`. It is a
  forward-compat item for the next baseline raise, not a live regression, and the
  repo rule is "抬基线就抬下限，不写运行时兼容层" — so it needs a baseline
  decision, not a defensive patch.
- **#1199** — `changes_summary` latency is in the host (`/api/changes.summary`
  lives in `@deepseek-ai/dsh-client-ui-deliverables`), not in this plugin.
  Misdirected; belongs upstream.
- **#1186 / #1169** — the Tasks-tab `team.members.map` crash was already fixed
  on `dev` (`b6c20174`); only a release is missing. Close after the next cut.
- **#1208** — the "back to latest" pill was fixed by #1209, already on `dev`,
  unreleased.
- **Install-failure cluster (13 issues)** — ten are "installed the wrong plugin
  version for the running DSH" (`#1161 #1172 #1173 #1192 #1195 #1200 #1203 #1205
  #1207 #1213`); the support line already answers them. Two are
  `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` for **third-party** packages in the same
  profile (`dsh-super-injector`, `dsh-genui`), not this package. One (`#1215`)
  carries no diagnostics.
- **16 PRs ready to merge** (#957 #1054 #894 #1184 #1182 #937 #984 #1162 #948 #945)
  and **4 needing a precondition fix first** (#1105 pins `dsh-better-sidebar@0.29.0`;
  #1091 deletes an unrelated live assertion; #1168 has a CHANGELOG-only conflict;
  #1140 is missing two keys in 18 dictionaries). Held back because the owner
  limited this batch to A + B.

## Links

- [#1206](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1206) · [#1189](https://github.com/omdsh-dev/DSH-better-sidebar/issues/1189)
- [#1166](https://github.com/omdsh-dev/DSH-better-sidebar/issues/1166) · [#1212](https://github.com/omdsh-dev/DSH-better-sidebar/issues/1212) · [#1159](https://github.com/omdsh-dev/DSH-better-sidebar/issues/1159)
- [#1214](https://github.com/omdsh-dev/DSH-better-sidebar/issues/1214) · [#1165](https://github.com/omdsh-dev/DSH-better-sidebar/issues/1165) · [#1179](https://github.com/omdsh-dev/DSH-better-sidebar/issues/1179)
