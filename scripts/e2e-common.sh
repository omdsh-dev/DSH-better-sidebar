# =============================================================================
# scripts/e2e-common.sh — e2e-mount.sh / e2e-aggregate-mount.sh 的共享骨架：
# 日志三件套、前置校验、DSH_CMD / tarball 解析、scratch home 与清理 trap、
# scratch profile 三件套、dsh web 后台启动与就绪轮询。
#
# 纯开发侧库文件，不进 npm 包（package.json files 白名单无它）；
# install.sh / install.ps1 随 npm 包独立分发，必须自包含，绝不 source 本文件。
#
# 用法：调用方先设 E2E_TAG（say/warn/die 的日志前缀）再 source：
#   E2E_TAG=e2e-mount
#   source "$SCRIPT_DIR/e2e-common.sh"
#
# 依赖调用方已 `set -euo pipefail` 并定义 ROOT（仓库根绝对路径）。
# 两侧脚本有意保留的差异（行为等价，靠参数 / 调用点区分）：
#   - DSH_HOME 子路径：mount 用 $SCRATCH/home，aggregate 直接用 $SCRATCH；
#   - 就绪行 grep 正则：mount 要带 token 的完整 URL，aggregate 只取 origin
#     （两侧的理由见各自脚本的就绪行注释）；
#   - 额外清理项：aggregate 的 fixture 打包 TMP_DIR（mount 不设即跳过）。
# =============================================================================

: "${E2E_TAG:?必须先设置 E2E_TAG（日志前缀）再 source e2e-common.sh}"

# ── 日志三件套 ───────────────────────────────────────────────────────────────
say()  { printf '\033[32m[%s]\033[0m %s\n' "$E2E_TAG" "$*"; }
warn() { printf '\033[33m[%s]\033[0m %s\n' "$E2E_TAG" "$*" >&2; }
die()  { printf '\033[31m[%s]\033[0m %s\n' "$E2E_TAG" "$*" >&2; exit 1; }

# ── 前置校验 ─────────────────────────────────────────────────────────────────
# e2e_require_cmd <cmd> [用途]：不在 PATH 上即 die（沿用两脚本原有报错文案）。
e2e_require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    if [ $# -ge 2 ]; then
      die "未找到 $1（$2）"
    else
      die "未找到 $1"
    fi
  fi
}

# ── DSH_CMD 解析 ─────────────────────────────────────────────────────────────
# PATH 上的 dsh 优先，否则 npx 拉官方包（同 scripts/install.sh）。DSH_CMD
# 缺省值（`dsh`）由调用方从环境变量取好传入。
e2e_resolve_dsh_cmd() {
  if ! command -v "$DSH_CMD" >/dev/null 2>&1; then
    if command -v npx >/dev/null 2>&1; then
      say "PATH 上无 ${DSH_CMD}，回退 npx -y --package @deepseek-ai/dsh"
      DSH_CMD="npx -y --package @deepseek-ai/dsh dsh"
    else
      die "未找到 $DSH_CMD 或 npx；请先安装 DSH CLI（npm i -g @deepseek-ai/dsh）或用 DSH_CMD 指定"
    fi
  fi
}

# ── tarball 解析 ─────────────────────────────────────────────────────────────
# TARBALL 已显式给出时原样使用；否则从仓库根 glob 里选。多个候选时取 mtime
# 最新——`ls | head -1` 的字典序会拿到旧版本号的历史 tarball，把冒烟挂到
# 过期产物上。未找到候选时返回非零，由调用方按各自文案 die。
e2e_resolve_tarball() {
  if [ -z "${TARBALL:-}" ]; then
    TARBALL="$(ls -t "$ROOT"/dsh-better-sidebar-*.tgz 2>/dev/null | head -1 || true)"
    local count
    count="$(ls "$ROOT"/dsh-better-sidebar-*.tgz 2>/dev/null | wc -l | tr -d ' ' || true)"
    [ "$count" -le 1 ] || warn "发现 $count 个 tarball，按 mtime 选用最新：$(basename "$TARBALL")（建议清理其余）"
  fi
  [ -n "$TARBALL" ] && [ -f "$TARBALL" ]
}

# ── scratch home 与清理 ──────────────────────────────────────────────────────
# 始终在本调用拥有的全新目录里运行：调用方给了 DSH_HOME_BASE（可能是真实
# ~/.dsh）时，只在其下新建子目录并只删除该子目录；缺省时直接用系统临时
# 目录。调用方提供的目录本身绝不写入或删除。
# $1 = mktemp 模板短名（dsh-e2e-mount / dsh-e2e-agg，便于区分两 lane 的残留）。
# DSH_HOME 用 $SCRATCH 还是其子路径由调用方自行 export（两 lane 的既有差异）。
e2e_make_scratch() {
  if [ -n "${DSH_HOME_BASE:-}" ]; then
    SCRATCH="$(mktemp -d "$DSH_HOME_BASE/$1.XXXXXX")"
  else
    SCRATCH="$(mktemp -d /tmp/$1.XXXXXX)"
  fi
}

# EXIT trap 兜底清理：杀 dsh web 后台进程；清 aggregate lane 的 fixture 打包
# 目录（TMP_DIR——mount lane 不设该变量即整段跳过）；最后按 KEEP_HOME 决定
# 是否删除 scratch。结尾显式 exit 回传 trap 触发时的退出码。
e2e_cleanup() {
  local code=$?
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "${TMP_DIR:-}" ] && [ -d "${TMP_DIR:-}" ]; then
    rm -rf "$TMP_DIR"
  fi
  if [ -z "${KEEP_HOME:-}" ]; then
    if [ -d "${SCRATCH:-}" ]; then
      rm -rf "$SCRATCH"
    fi
  else
    warn "KEEP_HOME 已设置，保留 $SCRATCH"
  fi
  exit "$code"
}

# ── scratch profile 三件套 ───────────────────────────────────────────────────
# 引导 scratch profile（web 模板，镜像 dsh initProfile）；先写
# pnpm-workspace.yaml 的 allowBuilds / minimumReleaseAgeExclude，避免 pnpm 11
# strict-dep-builds 拦截 node-pty/protobufjs 或拒绝 <24h 新版本——同 install.sh。
# @deepseek-ai/* 通配与仓库根 pnpm-workspace.yaml 同策：钉的 DSH alpha 常在
# 发布后 24h 内跑 lane，没有豁免会被 minimumReleaseAge 直接拒装。
e2e_write_profile() {
  mkdir -p "$1"
  cat > "$1/package.json" <<EOF
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
  printf '[]\n' > "$1/cordis.patch.yml"
  cat > "$1/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

allowBuilds:
  node-pty: true
  protobufjs: true

minimumReleaseAgeExclude:
  - dsh-better-sidebar
  - '@deepseek-ai/*'
EOF
}

# ── dsh web 启动 + 就绪轮询 ──────────────────────────────────────────────────
# 后台启动 dsh web（--port 0 = OS 分配，避免端口冲突；keyless 可起）。
# $1 = stdout 日志；$2 = stderr 日志（缺省合并进 $1：mount lane 单文件，
# aggregate lane 分 out/err 两个文件）。写入全局 SERVER_PID。
e2e_start_dsh_web() {
  if [ $# -ge 2 ]; then
    $DSH_CMD web --port "$PORT" >"$1" 2>"$2" &
  else
    $DSH_CMD web --port "$PORT" >"$1" 2>&1 &
  fi
  SERVER_PID=$!
}

# 轮询日志等待就绪行（最多 120s）。$1 = 参与轮询的日志文件；就绪行 ERE 与
# 多条命中的取舍（head/tail）由 E2E_READY_RE / E2E_READY_PICK 传入——这是
# 两条 lane 有意保留的差异（token URL vs 裸 origin，理由见各自脚本的就绪
# 行注释）。URL 提取统一为「命中串按空白分段取末段」：mount 的模式带
# `dsh web: ` 前缀（两段）故末段即完整 URL；aggregate 的模式不含空白故末段
# 即 origin——与原先两侧的 awk '{print $3}' / 直接取整行等价。
# 返回：0 = URL 已写入全局 URL；1 = 120s 超时；2 = 服务进程提前退出。
e2e_wait_dsh_web_ready() {
  URL=""
  local _
  for _ in $(seq 1 120); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      return 2
    fi
    if URL="$(grep -oE "$E2E_READY_RE" "$1" | "${E2E_READY_PICK:-head}" -1 | awk '{print $NF}')" && [ -n "$URL" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}
