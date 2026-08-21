#!/usr/bin/env bash
# =============================================================================
# dsh-better-sidebar 聚合双挂载冒烟（CI + 本地）：
#
#   场景：一个聚合 bundle（tests/fixtures/aggregate-better-sidebar）先以独立
#   条目 id 挂载 dsh-better-sidebar，插件自身的 bundle patch 后到 —— 旧行为
#   两个实例都注册 /sidebar/api，整个插件树启动失败（duplicate prefix
#   route）；新行为插件行检测到已有启用中的同包名挂载后自动 disabled，由
#   聚合行接管 sidebar。
#
#   流程：
#     1. 打包 fixture 聚合包；
#     2. 用官方 CLI 把 fixture 先装进全新 scratch profile，再把插件 tarball
#        装进同一 profile（复刻真实安装顺序：聚合先行、dsh plugin add 后到）；
#     3. 启动真实 `dsh web`（keyless，--port 0）；
#     4. 断言：日志出现启动 URL、无 "duplicate prefix route"、/sidebar/api
#        路由存活（POST 未知方法应返回 404 JSON 而非崩溃）。
#
# 用法：
#   bash scripts/e2e-aggregate-mount.sh
#
# 环境变量（均可省略）：
#   DSH_CMD        dsh 命令；缺省 `npx -y --package @deepseek-ai/dsh dsh`
#                  （与 pm2 启动器同源，避免依赖可能失效的 PATH dsh）
#   TARBALL        插件 tarball；缺省仓库根 dsh-better-sidebar-*.tgz（须已 pack）
#   PORT           固定端口（默认 0 = OS 分配，从日志解析 URL）
#   DSH_HOME_BASE  scratch 根目录（默认系统临时目录）。脚本始终在其下新建
#                  本调用拥有的独立子目录，只写入/删除该子目录；调用方提供
#                  的目录本身（可能是真实 ~/.dsh）绝不写入或删除。
#   KEEP_HOME      非空时保留 scratch 目录（调试用）
#
# 退出码 = 0 通过；非 0 失败。服务器与 scratch 目录由 trap 兜底清理。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE_DIR="$ROOT/tests/fixtures/aggregate-better-sidebar"

DSH_CMD="${DSH_CMD:-npx -y --package @deepseek-ai/dsh dsh}"
TARBALL="${TARBALL:-}"
PORT="${PORT:-0}"
KEEP_HOME="${KEEP_HOME:-}"

say()  { printf '\033[32m[e2e-aggregate-mount]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[e2e-aggregate-mount]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[e2e-aggregate-mount]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "未找到 node（DSH 运行需要 Node.js >= 20）"
command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm（dsh plugin 转发给 pnpm）"
command -v npm >/dev/null 2>&1 || die "未找到 npm（打包 fixture 需要）"
command -v curl >/dev/null 2>&1 || die "未找到 curl"

if [ -z "$TARBALL" ]; then
  TARBALL="$(ls "$ROOT"/dsh-better-sidebar-*.tgz 2>/dev/null | head -1 || true)"
fi
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || die "未找到插件 tarball：先在本仓库跑 pnpm build && npm pack，或用 TARBALL 指定"

# ── scratch home ────────────────────────────────────────────────────────────
# 始终在本调用拥有的全新目录里运行：调用方给了 DSH_HOME_BASE（可能是真实
# ~/.dsh）时，只在其下新建子目录并只删除该子目录；缺省时直接用系统临时
# 目录。调用方提供的目录本身绝不写入或删除。
DSH_HOME_BASE="${DSH_HOME_BASE:-}"
if [ -n "$DSH_HOME_BASE" ]; then
  SCRATCH="$(mktemp -d "$DSH_HOME_BASE/dsh-e2e-agg.XXXXXX")"
else
  SCRATCH="$(mktemp -d /tmp/dsh-e2e-agg.XXXXXX)"
fi
export DSH_HOME="$SCRATCH"
LOG_DIR="$DSH_HOME/logs"; mkdir -p "$LOG_DIR"
OUT_LOG="$LOG_DIR/dsh-web.out.log"; ERR_LOG="$LOG_DIR/dsh-web.err.log"
SERVER_PID=""
TMP_DIR=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
  if [ -z "$KEEP_HOME" ] && [ -d "$SCRATCH" ]; then
    rm -rf "$SCRATCH"
  else
    warn "KEEP_HOME 已设置，保留 $SCRATCH"
  fi
}
trap cleanup EXIT

# ── 打包 fixture 聚合包 ─────────────────────────────────────────────────────
TMP_DIR="$(mktemp -d)"
( cd "$FIXTURE_DIR" && npm pack --silent --pack-destination "$TMP_DIR" >/dev/null )
FIXTURE_TGZ="$(ls "$TMP_DIR"/*.tgz 2>/dev/null | head -1 || true)"
[ -n "$FIXTURE_TGZ" ] || die "fixture 打包失败"

# ── 引导 scratch profile（web 模板）────────────────────────────────────────
# 先写 pnpm-workspace.yaml 的 allowBuilds / minimumReleaseAgeExclude，避免
# pnpm 11 strict-dep-builds 拦截 node-pty/protobufjs——同 e2e-mount.sh。
PROFILE_DIR="$DSH_HOME/profiles/web"
mkdir -p "$PROFILE_DIR"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
EOF
printf '[]\n' > "$PROFILE_DIR/cordis.patch.yml"
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

allowBuilds:
  node-pty: true
  protobufjs: true

minimumReleaseAgeExclude:
  - dsh-better-sidebar
EOF

# ── 组装 profile：聚合先行，插件后到 ──────────────────────────────────────
say "安装 fixture 聚合包（先行）…"
$DSH_CMD plugin --profile web add "file:$FIXTURE_TGZ"
say "安装插件 tarball（后到）…"
$DSH_CMD plugin --profile web add "file:$TARBALL"

# ── 启动真实 dsh web ───────────────────────────────────────────────────────
say "启动 dsh web（--port ${PORT}，日志 ${LOG_DIR}）…"
$DSH_CMD web --port "$PORT" >"$OUT_LOG" 2>"$ERR_LOG" &
SERVER_PID=$!

# 等待启动 URL 或进程退出（最多 120s）
URL=""
for _ in $(seq 1 120); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+' "$OUT_LOG" | tail -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then
  warn "out log 尾部：$(tail -5 "$OUT_LOG" 2>/dev/null || true)"
  warn "err log 尾部：$(tail -5 "$ERR_LOG" 2>/dev/null || true)"
  die "dsh web 未在 120s 内启动"
fi
say "已启动：$URL"

# ── 断言 ────────────────────────────────────────────────────────────────────
if grep -q "duplicate prefix route" "$ERR_LOG" "$OUT_LOG" 2>/dev/null; then
  die "检测到 duplicate prefix route（双挂载未退让）"
fi

# 真实方法探活：terminal.deps 是插件自己的 handler（writeOk → HTTP 200 +
# {"ok":true,...}）。成功响应证明至少一个实例真正注册了 /sidebar/api 路由
# ——generic missing-route 404 无法冒充（P2: Probe a real sidebar API method）。
DEPS="$(curl -s -X POST "$URL/sidebar/api/terminal.deps" 2>/dev/null || true)"
if ! printf '%s' "$DEPS" | grep -q '"ok":true'; then
  die "/sidebar/api/terminal.deps 未返回 ok:true（响应：$(printf '%s' "$DEPS" | head -c 200)）"
fi
say "/sidebar/api/terminal.deps → ok:true（真实 handler 存活）"

STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/sidebar/api/__e2e_unknown__" 2>/dev/null || true)"
say "/sidebar/api POST 未知方法 → HTTP ${STATUS}（期望 404）"
[ "$STATUS" = "404" ] || die "/sidebar/api 未知方法未按预期返回 404（HTTP ${STATUS}）"

say "通过：聚合双挂载场景下插件自动退让，侧边栏由聚合行接管。"
