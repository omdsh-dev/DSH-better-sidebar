#!/usr/bin/env bash
# =============================================================================
# dsh-better-sidebar 挂载冒烟编排（CI + 本地）：
#
#   1. 用官方 CLI 把 npm 打包产物（tarball）真实挂载进一个全新 scratch
#      profile（`dsh plugin --profile web add file:<tarball>`，触发
#      dsh.profile.bundles 协调，与用户安装路径一致）；
#   2. 启动真实 `dsh web`（keyless，--port 0 取 OS 分配端口）；
#   3. 运行 tests/e2e 无头渲染 lane（Playwright Chromium）：断言外壳与
#      插件挂载、无崩溃标记，并驱动内置 tab 深扫。
#
# 用法：
#   bash scripts/e2e-mount.sh [--grep <playwright-filter>]
#
# 环境变量（均可省略）：
#   DSH_CMD        dsh 命令；缺省 PATH 上的 `dsh`，回退 npx 拉官方包
#   TARBALL        插件 tarball；缺省仓库根 dsh-better-sidebar-*.tgz（须已 pack）
#   PORT           固定端口（默认 0 = OS 分配，从日志解析 URL）
#   DSH_HOME_BASE  覆盖 scratch 根目录（默认系统临时目录）。脚本始终在其下
#                  新建本调用拥有的独立子目录，只写入/删除该子目录；调用方
#                  提供的目录本身（可能是真实 ~/.dsh）绝不写入或删除。
#   KEEP_HOME      非空时保留 scratch home（调试用）
#
# 退出码 = playwright 的退出码；服务器与 scratch 目录由 trap 兜底清理。
# 日志/前置校验/DSH_CMD 与 tarball 解析/scratch profile 三件套/清理 trap/
# dsh web 启动与就绪轮询的共享骨架见 scripts/e2e-common.sh。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

E2E_TAG=e2e-mount
source "$SCRIPT_DIR/e2e-common.sh"

DSH_CMD="${DSH_CMD:-dsh}"
PORT="${PORT:-0}"
TARBALL="${TARBALL:-}"
GREP_FILTER=""
if [ "${1:-}" = "--grep" ]; then GREP_FILTER="${2:?--grep 需要参数}"; fi

e2e_require_cmd node "DSH 运行需要 Node.js >= 20"
e2e_require_cmd pnpm "dsh plugin 转发给 pnpm"

e2e_resolve_dsh_cmd

e2e_resolve_tarball || die "找不到 tarball（TARBALL 或 \$ROOT/dsh-better-sidebar-*.tgz）——先运行 pnpm build && pnpm pack"
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
say "tarball: $TARBALL"

# scratch home（每次全新，绝不触碰真实 ~/.dsh；DSH_HOME_BASE 语义见
# e2e-common.sh）。DSH_HOME 用子路径 home/（aggregate lane 直接用 $SCRATCH，
# 两 lane 既有差异）：playwright lane 还需要独立的 workspace 目录，与
# DSH_HOME 的 profiles 布局分开。
e2e_make_scratch dsh-e2e-mount
export DSH_HOME="$SCRATCH/home"
WORKSPACE_DIR="$SCRATCH/workspace"
LOG_DIR="$SCRATCH"
WEB_LOG="$LOG_DIR/web.log"
mkdir -p "$DSH_HOME/profiles/web" "$WORKSPACE_DIR"
say "scratch home: ${DSH_HOME}（DSH_HOME=${DSH_HOME}）"

SERVER_PID=""
trap e2e_cleanup EXIT

# 步骤 1：引导 scratch profile（三件套 heredoc 及其理由见 e2e-common.sh
# 的 e2e_write_profile）
PROFILE_DIR="$DSH_HOME/profiles/web"
e2e_write_profile "$PROFILE_DIR"

# 步骤 2：官方 CLI 安装 tarball + bundle 协调（真实挂载路径）
say "执行 dsh plugin --profile web add file:$TARBALL ..."
$DSH_CMD plugin --profile web add "file:$TARBALL"

# 步骤 3：校验挂载生效（dsh.profile.bundles 含 dsh-better-sidebar）
if ! node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const bundles = p.dsh?.profile?.bundles ?? [];
  process.exit(bundles.includes("dsh-better-sidebar") ? 0 : 1);
' "$PROFILE_DIR/package.json"; then
  warn "dsh-better-sidebar 未出现在 dsh.profile.bundles 中——挂载未注册"
  cat "$PROFILE_DIR/package.json"
  exit 1
fi
say "挂载已注册：dsh.profile.bundles 包含 dsh-better-sidebar"

# 步骤 4：启动 dsh web（--port 0 = OS 分配，避免端口冲突；keyless 可起）
say "启动 dsh web（port=${PORT}）..."
e2e_start_dsh_web "$WEB_LOG"

# 就绪行解析：DSH 0.1.2-alpha.1+ 打印的是带一次性 token 的鉴权 URL
# （`dsh web: http://127.0.0.1:<port>/?token=<43字符>`，页面导航用它换取
# 浏览器 cookie；干净 URL 只会得到 401）；0.1.1-rc.x 及更早是裸 origin。
# 匹配必须延伸到空白（`[^ ]*`）——在 `/` 处截断会丢掉 token，alpha.1+
# 宿主上的整条 lane 都会挂在首屏 401。LAN 后缀 `(LAN: …)` 是下一个
# 空格分段，不会被并进来。
E2E_READY_RE='dsh web: http://127\.0\.0\.1:[0-9]+[^ ]*'
E2E_READY_PICK=head
WAIT_RC=0
e2e_wait_dsh_web_ready "$WEB_LOG" || WAIT_RC=$?
if [ "$WAIT_RC" -eq 2 ]; then
  echo "=== dsh web 提前退出，日志尾部 ===" >&2
  tail -30 "$WEB_LOG" >&2 || true
  exit 1
fi
if [ "$WAIT_RC" -ne 0 ]; then
  echo "=== 120s 内未等到 dsh web 就绪，日志尾部 ===" >&2
  tail -40 "$WEB_LOG" >&2 || true
  exit 1
fi
say "dsh web 就绪：${URL}（pid ${SERVER_PID}）"

# 步骤 5：运行无头渲染 lane
say "运行 Playwright 无头渲染 lane..."
DSH_E2E_URL="$URL" DSH_E2E_WORKSPACE="$WORKSPACE_DIR" \
  pnpm exec playwright test ${GREP_FILTER:+--grep "$GREP_FILTER"}

say "通过：插件挂载到真实 DSH 后无头渲染未崩溃"
