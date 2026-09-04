#!/usr/bin/env bash
# Consumer-facing type surface check: build a tiny standalone consumer that
# imports `dsh-better-sidebar/client/service` WITHOUT @types/node and with
# skipLibCheck: false, then type-check it with the repo's tsc.
#
# This is the exact scenario the v0.12.0 API work cares about: the shipped
# declaration graph (service.d.ts -> context-types.d.ts -> state/api) must
# resolve and type-check for a browser-only plugin author. Run AFTER
# `pnpm build` (the check reads lib/types).
set -euo pipefail
cd "$(dirname "$0")/.."

# Git Bash (MSYS) `ln -s` deep-copies directories by default — copying this
# repo (node_modules + full .git history) would be catastrophic. Force real
# native symlinks instead: the GitHub Windows runners (Developer Mode, admin
# user) can create them, and nativestrict makes ln fail loudly rather than
# silently falling back to a copy. Inert on Linux/macOS.
export MSYS="winsymlinks:nativestrict"

# The check reads the BUILT declaration surface (lib/types) — fail loudly
# instead of silently passing when the build output is missing.
if [ ! -f lib/types/client/service.d.ts ]; then
  echo "[check-consumer-types] FAIL: lib/types/client/service.d.ts not found — run 'pnpm build' first." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/node_modules"
# Resolve link targets to their PHYSICAL path first: under pnpm,
# node_modules/@deepseek-ai/cordis is itself a symlink/junction into .pnpm,
# and on Windows a native symlink pointing AT a junction does not traverse
# for tsc (TS2307 on a link that visibly exists). Node's NATIVE realpath
# (GetFinalPathNameByHandle on Windows) expands junctions, which bash-level
# resolution may leave untouched; node is guaranteed here (tsc runs below).
resolve_dir() { node -e 'process.stdout.write(require("node:fs").realpathSync.native(process.argv[1]))' "$1"; }
ln -s "$(resolve_dir "$(pwd)")" "$WORK/node_modules/dsh-better-sidebar"
# The vendored cordis base (and, through its realpath, cosmokit / standard-schema)
# must resolve so the consumer can type `Context` against the DSH runtime scope.
mkdir -p "$WORK/node_modules/@deepseek-ai"
ln -s "$(resolve_dir "$(pwd)/node_modules/@deepseek-ai/cordis")" "$WORK/node_modules/@deepseek-ai/cordis"
# Loud guard: both links must resolve to a package root, or tsc below would
# report misleading module-resolution errors.
for pkg_json in "$WORK/node_modules/dsh-better-sidebar/package.json" "$WORK/node_modules/@deepseek-ai/cordis/package.json"; do
  if [ ! -f "$pkg_json" ]; then
    echo "[check-consumer-types] FAIL: $pkg_json does not resolve (broken link). Link layer:" >&2
    ls -la "$WORK/node_modules" "$WORK/node_modules/@deepseek-ai" >&2 || true
    exit 1
  fi
done

cat > "$WORK/check.ts" <<'EOF'
import { SIDEBAR_FEATURES, SIDEBAR_SERVICE_VERSION } from 'dsh-better-sidebar/client/service'
import type {} from 'dsh-better-sidebar/client/service'
import type {
  BetterSidebarService, FileViewerDescriptor, OpenTabSeed, SidebarSettingsRenderProps,
  TabComponentProps, TabDescriptor,
} from 'dsh-better-sidebar/client/service'
import type { SessionScope, SidebarSnapshot, SidebarState, SidebarStore, SidebarTab } from 'dsh-better-sidebar/client/service'
import type { SidebarPrefs } from 'dsh-better-sidebar/client/service'
// The vendored-cordis path: `Context` from '@deepseek-ai/cordis' plus the
// side-effect type import above must expose `ctx.betterSidebar` — the consumer
// never needs to import this package's own Context type.
import type { Context as VendoredContext } from '@deepseek-ai/cordis'

declare const ctx: { betterSidebar: BetterSidebarService }
const tab: TabDescriptor = {
  id: 'x:tab',
  title: 'X',
  single: true,
  badge: (_ctx, _scope, state: SidebarState) => state.expanded.length,
  onOpen: (_tab: SidebarTab, _scope: SessionScope) => {},
  onClose: (_tab: SidebarTab, _scope: SessionScope) => {},
  createTab: (state: SidebarState) => ({ tab: { id: 'x:1', type: 'x:tab', title: 'X', meta: {} } }),
  settings: {
    toggles: [{ key: 'autoOpenSubagent', title: 'A' }],
    pluginToggles: [{ key: 'k', title: 'K', type: 'number', min: 0, max: 9 }],
    render: (props: SidebarSettingsRenderProps) => { props.updatePluginSetting('a', 1); return null },
  },
  component: (props: TabComponentProps) => null,
}
ctx.betterSidebar.registerTab(tab)
const viewer: FileViewerDescriptor = {
  id: 'x:csv', exts: ['csv'], fetchStrategy: 'custom',
  load: (_path, _scope, signal?: AbortSignal) => { void signal; return Promise.resolve([]) },
  component: () => null,
}
ctx.betterSidebar.registerFileViewer(viewer)
const seed: OpenTabSeed = { type: 'x:tab', title: 'X', meta: { a: 1 } }
ctx.betterSidebar.openTab(seed, { sessionId: 's1' })
ctx.betterSidebar.openFile({ sessionId: 's1' }, '/p/a.csv')
ctx.betterSidebar.updateTab('t', { meta: { b: 2 } })
const snap: SidebarSnapshot = ctx.betterSidebar.getSnapshot()
const prefs: SidebarPrefs = snap.prefs
const store: SidebarStore = null as unknown as SidebarStore
void prefs; void store; void ctx.betterSidebar.version; void ctx.betterSidebar.features
void SIDEBAR_SERVICE_VERSION; void SIDEBAR_FEATURES
// Vendored-cordis augmentation path.
declare const vctx: VendoredContext
vctx.betterSidebar.registerTab(tab)
vctx.betterSidebar.registerFileViewer(viewer)
void vctx.betterSidebar.getSnapshot()
EOF

cat > "$WORK/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "target": "ES2023", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": false, "types": [],
    "jsx": "react-jsx", "lib": ["ES2023", "DOM"]
  },
  "include": ["check.ts"]
}
EOF

echo "[check-consumer-types] type-checking a browser-only consumer (no @types/node)..."
echo "[check-consumer-types]   pass 1: skipLibCheck: true (the realistic consumer experience) — must be fully clean"
./node_modules/.bin/tsc -p "$WORK/tsconfig.json" --skipLibCheck true
echo "[check-consumer-types]   pass 2: skipLibCheck: false — OUR declaration surface (lib/types/**) must be clean"
echo "[check-consumer-types]   (upstream cordis/cosmokit declaration noise is filtered out; it predates this plugin)"
set +e
./node_modules/.bin/tsc -p "$WORK/tsconfig.json" --skipLibCheck false > "$WORK/strict.log" 2>&1
STATUS=$?
set -e
# Fail only on errors that mention OUR package / declarations / the fixture.
# Upstream noise (vendored cordis / cosmokit declaration warnings under the
# repo's pinned TS lib) lives anywhere under node_modules and is filtered.
if grep -E "dsh-better-sidebar|lib/types|check\.ts" "$WORK/strict.log" | grep -vE "node_modules/[^ ]*(cordis|cosmokit)"; then
  echo "[check-consumer-types] FAIL: errors in the dsh-better-sidebar declaration surface:" >&2
  grep -E "dsh-better-sidebar|lib/types|check\.ts" "$WORK/strict.log" >&2
  exit 1
fi
if [ "$STATUS" -ne 0 ]; then
  echo "[check-consumer-types] pass 2 note: strict mode only reports upstream declaration noise:"
  grep -v "dsh-better-sidebar\|lib/types\|check\.ts" "$WORK/strict.log" | head -5 || true
fi
echo "[check-consumer-types] OK: the client/service declaration surface is node-free and self-contained."

