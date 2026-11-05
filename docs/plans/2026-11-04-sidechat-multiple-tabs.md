# Independent native Side Chat tabs

## Reproduction and cause

On the native right sidebar, open Side Chat, then use the tab strip's `+` and choose Side Chat again. The host focuses the existing tab. The `+` below the composer creates a new thread but navigates that same tab, so it appears to replace the old conversation.

There are two independent causes:

1. The descriptor factory mints a unique plugin tab id, but native registration omits `multiple`. DSH therefore uses the singleton `sidebar://sidechat` page identity; `revealIfOpened: false` does not override singleton-page deduplication.
2. An unbound view restores the session's last/newest thread before considering `autoCreate`. Giving the host independent occurrences alone would still bind new tabs to the old thread.

## Implementation

- Side Chat opts into `TabDescriptor.multiple`, forwarded to native registration. Other kinds retain their previous multiplicity.
- A fresh `autoCreate` view starts its own thread. Composer/history actions pass `meta.threadId` explicitly rather than relying on the global parked seed.
- Native layout identity is durable, navigation parameters are not. A bounded versioned localStorage map stores only thread id and title under `(seat session, contentId)`; it never stores transcripts or drafts. Reloads and client-entry replacements restore that exact occurrence. A new occurrence has a new contentId and cannot inherit another tab's binding.
- Missing/corrupt bindings use the neutral hero with the existing history menu; no newest-thread guess, automatic replacement thread, or deletion of old history. The legacy last-thread hint remains written for external consumers but is no longer our restore authority.
- Existing-thread opens dedupe across both bottom and native carriers. The host inventory also covers unvisited/restored native tabs; explicit seeds are persisted immediately after placement so synchronous repeated opens can dedupe before React mounts. Bottom factory results merge explicit `seed.meta` before dedupe.
- Native explicit closes use `registerCloseHandler`, not component unmount or `AbortSignal` (the latter also fires on host teardown). Registration follows the host service lifetime, including late arrival. This applies the already-declared sidechat `onClose` behavior once; programmatic close can also resolve a restored occurrence before its body is visited. Plugin teardown keeps bindings for recovery.
- Creation locks include the parent session, preventing two sessions' `tab1` from blocking each other. A late creation result for a closed tab is released instead of rebound.
- `reveal:false` and cross-session queueing preserve focus isolation. A history open whose owner is in the collapsed bottom workbench expands that workbench.

## Compatibility and scope

The contribution originally targeted upstream `dev` at `09b83cc`; the conflict-resolution update merges `dev` at `11e6c8e`, including upstream's v0.30.0 / DSH 0.2.2-rc.1 adaptation. It preserves the image-draft, GenUI, and model-selection paths. The #949 manual archive guard remains intact. A recoverable non-subagent binding clears only its own tab after archive, rather than stealing another open thread.

**Close semantics remain archive-on-close** as specified by the existing descriptor and #942/#981. This patch makes the native close button honor that behavior too. A user who needs an independently recoverable ordinary session must use “Save as new session” before closing; this change does not introduce an unarchive interface for hidden subagent sessions.

No DSH source changes, new dependency, version bump, polling loop, model request, or unrelated terminal behavior change. The storage holds at most 512 recent native bindings. When storage is unavailable or a binding is missing, recovery uses the neutral state rather than guessing a thread.

## Verification

Regression coverage:

- Two native guide opens and two ordinary service opens yield independent occurrences.
- Composer `+` opens an explicit new-thread binding without rewriting the current tab.
- History dedupe works before body mount and across bottom/native carriers.
- Independent reload and client-entry remount restore, cross-session identical ids, malformed storage, explicit-close cleanup, teardown retention, and close-during-create.
- Archived-thread handling and the upstream image-composer restore test use exact occurrence identity.
- A real-host Chromium test clicks the two top-level opens and composer `+`, asserts three bindings, reloads, and visits all three without another creation request. Its sidechat transport is stubbed, so this proves real host/DOM binding behavior, not concurrent model execution.

The original v0.28.2 source fails the three discriminating component tests (fresh create with an existing thread, explicit composer new-tab binding, concurrent same-id tabs in two parent sessions). The repaired local implementation passes them; the contribution is revalidated on current dev rather than reusing those old suite totals.

Validation commands and final results are recorded in the PR body. Relevant commands:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test --maxWorkers=2
pnpm build
pnpm check:consumer-types
pnpm check:engines
pnpm pack
pnpm exec playwright install chromium
bash scripts/e2e-mount.sh --grep 'sidechat multi-instance|plugin mounts into|bottom workbench opens|native tab types survive'
```

Mount tests install a tarball into a new scratch profile through the official CLI. No user profile or production session is used.

### Receipt — 2026-11-04

Typecheck, repository-wide ESLint, build, pack and consumer declarations passed. The full unit/component sweep passed 247 files / 3047 tests, with 17 platform-related skips. Engine checks passed for installed ripgrep; fd was absent and its probes skipped. The four selected Chromium cases passed on the pinned DSH 0.2.1-rc.1 host (37.7 s). Windows execution is left to upstream CI. Two extra review regressions (queued-native-to-bottom ownership and closing a restored unvisited tab) were first observed failing, then passed with the fixes.
