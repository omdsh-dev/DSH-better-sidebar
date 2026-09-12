#!/usr/bin/env bash
# Boot the official mount lane, then put `dsh web` behind a path-prefix
# reverse proxy and run the base-path Playwright spec against that URL.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

E2E_TAG=e2e-base-path
source "$SCRIPT_DIR/e2e-common.sh"

DSH_CMD="${DSH_CMD:-dsh}"
PORT="${PORT:-0}"
TARBALL="${TARBALL:-}"
PROXY_PREFIX="${PROXY_PREFIX:-/dataops/proxy/3080}"

e2e_require_cmd node "DSH 运行需要 Node.js >= 20"
e2e_require_cmd pnpm "dsh plugin 转发给 pnpm"
e2e_resolve_dsh_cmd
e2e_resolve_tarball || die "找不到 tarball（TARBALL 或 \$ROOT/dsh-better-sidebar-*.tgz）——先运行 pnpm build && pnpm pack"
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
say "tarball: $TARBALL"

e2e_make_scratch dsh-e2e-base-path
export DSH_HOME="$SCRATCH/home"
WORKSPACE_DIR="$SCRATCH/workspace"
LOG_DIR="$SCRATCH"
WEB_LOG="$LOG_DIR/web.log"
PROXY_LOG="$LOG_DIR/proxy.log"
mkdir -p "$DSH_HOME/profiles/web" "$WORKSPACE_DIR"
say "scratch home: ${DSH_HOME}"

SERVER_PID=""
PROXY_PID=""
e2e_cleanup_with_proxy() {
  if [ -n "${PROXY_PID:-}" ] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
  e2e_cleanup
}
trap e2e_cleanup_with_proxy EXIT

PROFILE_DIR="$DSH_HOME/profiles/web"
e2e_write_profile "$PROFILE_DIR"
say "执行 dsh plugin --profile web add file:$TARBALL ..."
$DSH_CMD plugin --profile web add "file:$TARBALL"

say "启动 dsh web（port=${PORT}）..."
e2e_start_dsh_web "$WEB_LOG"
E2E_READY_RE='dsh web: http://127\.0\.0\.1:[0-9]+[^ ]*'
E2E_READY_PICK=head
WAIT_RC=0
e2e_wait_dsh_web_ready "$WEB_LOG" || WAIT_RC=$?
if [ "$WAIT_RC" -ne 0 ]; then
  echo "=== dsh web 未就绪，日志尾部 ===" >&2
  tail -40 "$WEB_LOG" >&2 || true
  exit 1
fi
say "dsh web 就绪：${URL}（pid ${SERVER_PID}）"

UPSTREAM="$(printf '%s' "$URL" | awk -F'[?]' '{print $1}' | sed 's#/$##')"
TOKEN="$(printf '%s' "$URL" | sed -n 's/.*[?&]token=\([^& ]*\).*/\1/p')"
[ -n "$TOKEN" ] || die "launch URL 没有 token：$URL"

say "启动 prefix proxy ${PROXY_PREFIX} → ${UPSTREAM} ..."
UPSTREAM="$UPSTREAM" PROXY_PREFIX="$PROXY_PREFIX" PROXY_PORT=0 \
  node "$SCRIPT_DIR/prefix-proxy.mjs" >"$PROXY_LOG" 2>&1 &
PROXY_PID=$!
PROXY_URL=""
for _ in $(seq 1 30); do
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    tail -20 "$PROXY_LOG" >&2 || true
    die "prefix proxy 提前退出"
  fi
  PROXY_URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/[^ ]+' "$PROXY_LOG" | head -1 || true)"
  [ -n "$PROXY_URL" ] && break
  sleep 0.2
done
[ -n "$PROXY_URL" ] || die "未读到 prefix-proxy 监听地址"
say "prefix proxy 就绪：${PROXY_URL}"

PROXIED_LAUNCH="${PROXY_URL}?token=${TOKEN}"
say "运行 Playwright base-path lane against ${PROXIED_LAUNCH}"
DSH_E2E_URL="$PROXIED_LAUNCH" DSH_E2E_WORKSPACE="$WORKSPACE_DIR" \
  pnpm exec playwright test tests/e2e/base-path.e2e.ts

say "通过：子路径反向代理下的 sidebar 传输保留了前缀"
