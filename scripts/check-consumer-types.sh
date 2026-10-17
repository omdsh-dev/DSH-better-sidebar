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
# The public host subpath `./clues` has its own declaration entry; it is part
# of the consumer surface too and must exist and type-check.
if [ ! -f lib/types/clues/index.d.ts ]; then
  echo "[check-consumer-types] FAIL: lib/types/clues/index.d.ts not found — run 'pnpm build' first." >&2
  exit 1
fi
if [ ! -f lib/clues.js ]; then
  echo "[check-consumer-types] FAIL: lib/clues.js not found — run 'pnpm build' first." >&2
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

# The public HOST subpath. A source plugin imports this package's `clues`
# entry; the declaration graph must stand on its own (the clue vocabulary is
# node-free, and `installClues` reuses the Context type). This consumer
# registers a source and raises a typed category, exactly as S2+ plugins do.
cat > "$WORK/clues-check.ts" <<'EOF'
import { ClueError, createCluesService, isClueError } from 'dsh-better-sidebar/clues'
import type {
  ClueEditDocument, ClueErrorCategory, ClueListResult, ClueOperationContext,
  ClueReadResult, ClueSaveEditInput, ClueSourceRegistration, ClueTypeDescriptor,
  CluesService, Locator,
} from 'dsh-better-sidebar/clues'

const category: ClueErrorCategory = 'auth-required'
const error = new ClueError(category, 'sign in to continue')
if (!isClueError(error)) throw new Error('unreachable')

const type: ClueTypeDescriptor = {
  typeId: 'x.docs.text',
  sourceId: 'x.docs',
  formats: ['text/plain'],
  capabilities: { read: true, edit: false },
}
const registration: ClueSourceRegistration = {
  descriptor: {
    sourceId: 'x.docs',
    name: 'X docs',
    order: 1,
    pluginId: 'x-plugin',
    types: [type.typeId],
    transport: 'http',
    capabilities: { resolve: false, list: false, search: false, read: true, edit: false, portable: false },
  },
  types: [type],
  operations: {
    async read(_input, context: ClueOperationContext): Promise<ClueReadResult> {
      void context.sessionId
      return { format: 'text/plain', data: { text: 'body' }, fetchedAt: new Date().toISOString() }
    },
    async loadEdit(): Promise<ClueEditDocument> {
      return { format: 'text/plain', data: { text: 'body' }, baseRevision: 'r1' }
    },
    async saveEdit(input): Promise<{ revision: string; savedAt: string }> {
      const document: ClueSaveEditInput = input.document
      return { revision: String(document.baseRevision), savedAt: new Date().toISOString() }
    },
  },
}
const locator: Locator = { url: 'https://example.invalid/doc' }
void locator
const service: CluesService = createCluesService({ builtinSources: [registration] })
service.registerSource(registration)
async function page(): Promise<ClueListResult> {
  return service.list({ workspaceId: 'ws-1', sourceId: 'x.docs' })
}
void page
EOF

cat > "$WORK/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "target": "ES2023", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": false, "types": [],
    "jsx": "react-jsx", "lib": ["ES2023", "DOM"]
  },
  "include": ["check.ts", "clues-check.ts"]
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
echo "[check-consumer-types] OK: the client/service and clues declaration surfaces are node-free and self-contained."

# Built-artifact identity guard (the host bundle and the public ./clues
# artifact must share ONE ClueError class). It imports lib/index.js and
# lib/clues.js, so it runs only after the build this script already requires.
echo "[check-consumer-types] checking the built clue artifacts share one ClueError class..."
node scripts/check-clue-artifact.mjs

