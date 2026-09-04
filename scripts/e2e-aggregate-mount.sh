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
#   DSH_CMD        dsh 命令；缺省 PATH 上的 `dsh`，回退 npx 拉官方包
#                  （同 e2e-mount.sh）
#   TARBALL        插件 tarball；缺省仓库根 dsh-better-sidebar-*.tgz（须已 pack）
#   PORT           固定端口（默认 0 = OS 分配，从日志解析 URL）
#   DSH_HOME_BASE  scratch 根目录（默认系统临时目录）。脚本始终在其下新建
#                  本调用拥有的独立子目录，只写入/删除该子目录；调用方提供
#                  的目录本身（可能是真实 ~/.dsh）绝不写入或删除。
#   KEEP_HOME      非空时保留 scratch 目录（调试用）
#
# 退出码 = 0 通过；非 0 失败。服务器与 scratch 目录由 trap 兜底清理。
# 日志/前置校验/DSH_CMD 与 tarball 解析/scratch profile 三件套/清理 trap/
# dsh web 启动与就绪轮询的共享骨架见 scripts/e2e-common.sh。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE_DIR="$ROOT/tests/fixtures/aggregate-better-sidebar"

E2E_TAG=e2e-aggregate-mount
source "$SCRIPT_DIR/e2e-common.sh"

DSH_CMD="${DSH_CMD:-dsh}"
TARBALL="${TARBALL:-}"
PORT="${PORT:-0}"
KEEP_HOME="${KEEP_HOME:-}"

e2e_require_cmd node "DSH 运行需要 Node.js >= 20"
e2e_require_cmd pnpm "dsh plugin 转发给 pnpm"
e2e_require_cmd npm "打包 fixture 需要"
e2e_require_cmd curl

e2e_resolve_dsh_cmd

e2e_resolve_tarball || die "未找到插件 tarball：先在本仓库跑 pnpm build && npm pack，或用 TARBALL 指定"

# ── scratch home ────────────────────────────────────────────────────────────
# DSH_HOME 直接用 $SCRATCH（mount lane 用子路径 home/——两 lane 既有差异）；
# DSH_HOME_BASE 语义与清理 trap 见 e2e-common.sh。
e2e_make_scratch dsh-e2e-agg
export DSH_HOME="$SCRATCH"
LOG_DIR="$DSH_HOME/logs"; mkdir -p "$LOG_DIR"
OUT_LOG="$LOG_DIR/dsh-web.out.log"; ERR_LOG="$LOG_DIR/dsh-web.err.log"
SERVER_PID=""
TMP_DIR=""
trap e2e_cleanup EXIT

# ── 打包 fixture 聚合包 ─────────────────────────────────────────────────────
TMP_DIR="$(mktemp -d)"
( cd "$FIXTURE_DIR" && npm pack --silent --pack-destination "$TMP_DIR" >/dev/null )
FIXTURE_TGZ="$(ls "$TMP_DIR"/*.tgz 2>/dev/null | head -1 || true)"
[ -n "$FIXTURE_TGZ" ] || die "fixture 打包失败"

# ── 引导 scratch profile（web 模板）────────────────────────────────────────
# 三件套 heredoc 及 pnpm-workspace 的 allowBuilds / minimumReleaseAgeExclude
# 理由见 e2e-common.sh 的 e2e_write_profile。
PROFILE_DIR="$DSH_HOME/profiles/web"
e2e_write_profile "$PROFILE_DIR"

# ── 组装 profile：聚合先行，插件后到 ──────────────────────────────────────
say "安装 fixture 聚合包（先行）…"
$DSH_CMD plugin --profile web add "file:$FIXTURE_TGZ"
say "安装插件 tarball（后到）…"
$DSH_CMD plugin --profile web add "file:$TARBALL"

# ── 启动真实 dsh web ───────────────────────────────────────────────────────
say "启动 dsh web（--port ${PORT}，日志 ${LOG_DIR}）…"
e2e_start_dsh_web "$OUT_LOG" "$ERR_LOG"

# 等待启动 URL 或进程退出（最多 120s）。这里有意只取 origin：0.1.2-alpha.1+
# 的就绪行是 `…/?token=<43字符>` 鉴权 URL，但下方的探活全部打插件的
# /sidebar/api/* 路由——webserver carrier 不做鉴权（只有 /api、index 与
# remote.mux 升级在 browser auth 之后），origin 拼路径即正确且两版通用。
E2E_READY_RE='http://127\.0\.0\.1:[0-9]+'
E2E_READY_PICK=tail
e2e_wait_dsh_web_ready "$OUT_LOG" || true
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
