#!/usr/bin/env bash
# =============================================================================
# dsh-better-sidebar 双插件 Context 诊断 e2e（真实 dsh-context + 本插件）：
#
#   1. 全新 scratch profile（骨架复用 scripts/e2e-common.sh，不改该文件）；
#   2. 真实安装：本仓库 tarball；dual / tab-only 变体再加 dsh-context@<钉版>；
#      - dual      双插件齐全（三个入口都可用：当前会话 / 子代理详情 / 后台任务）；
#      - tab-only  dsh-context 在，但用**它自己的公开设置** defaultPlacement=tab
#                  只注册会话内视图、不注册右侧栏 tab 类型与 body —— 入口必须隐藏
#                  （controller 的判据是 kind+body 都可用）；
#      - no-context 只装 tarball —— 入口必须隐藏；
#   3. 启动真实 `dsh web`（keyless，--port 0 取 OS 分配端口，绝不动 :3384）；
#   4. 运行 tests/e2e/context-diagnostics.e2e.ts（Playwright Chromium，无头）。
#
# 用法：
#   bash scripts/e2e-context.sh [--variant dual|tab-only|no-context|all] [--grep <filter>]
#
# 环境变量（均可省略）：
#   DSH_CMD        必须保留 DSH_HOME 的真实 CLI；缺省 npx 钉版（避开桌面 shim）
#   TARBALL        插件 tarball；缺省仓库根 dsh-better-sidebar-*.tgz（须已 pack）
#   PORT           固定端口（默认 0 = OS 分配，从日志解析 URL）
#   DSH_HOME_BASE  scratch 根目录（默认系统临时目录）。脚本只在其下新建本调用拥有的
#                  独立子目录，只写入/删除该子目录
#   KEEP_HOME      非空时保留 scratch（调试用）
#   CONTEXT_PKG    context 插件规格；缺省 dsh-context@0.72.0。**必须写精确版本号，
#                  绝不写 dist-tag**（AGENTS.md §2：dist-tag 指向与候选版经常不一致）
#   每个变体都安装仅测试用 fixture，播种父子会话和后台 job；绝不发送模型请求。
#
# 退出码 = 0 全部通过；非 0 失败。服务与 scratch 由 trap 兜底清理。
#
# 清理安全性（本脚本的硬约束，见用户/父代理要求）：
#   - 只定向 kill 本脚本自己启动的 $SERVER_PID（e2e_cleanup），**没有 pkill/killall**；
#   - 只删 e2e_make_scratch（mktemp -d）产出的 $SCRATCH 与本脚本 mktemp -d 的 $TMP_DIR，
#     两者都在挂 trap 之前由 assert_mktemp_product 校验过形状，未通过即 die（不清理）。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

E2E_TAG=e2e-context
source "$SCRIPT_DIR/e2e-common.sh"

# Desktop command shims may overwrite DSH_HOME. Default to the pinned real CLI.
DSH_CMD="${DSH_CMD:-npx -y --package ${DSH_NPX_SPEC} dsh}"
PORT="${PORT:-0}"
TARBALL="${TARBALL:-}"
CONTEXT_PKG="${CONTEXT_PKG:-dsh-context@0.72.0}"
VARIANT="all"
GREP_FILTER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --variant) VARIANT="${2:?--variant 需要参数}"; shift 2 ;;
    --grep) GREP_FILTER="${2:?--grep 需要参数}"; shift 2 ;;
    -h|--help) sed -n '2,46p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "未知参数：$1（支持 --variant/--grep）" ;;
  esac
done

case "$VARIANT" in
  dual|tab-only|no-context) VARIANTS="$VARIANT" ;;
  all) VARIANTS="dual tab-only no-context" ;;
  *) die "--variant 只支持 dual / tab-only / no-context / all（收到 $VARIANT）" ;;
esac

e2e_require_cmd node "DSH 运行需要 Node.js >= 20"
e2e_require_cmd pnpm "dsh plugin 转发给 pnpm"
e2e_require_cmd npm "打包 fixture 插件需要"

e2e_resolve_dsh_cmd

e2e_resolve_tarball || die "找不到 tarball（TARBALL 或 \$ROOT/dsh-better-sidebar-*.tgz）——先运行 pnpm build && pnpm pack"
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
say "tarball: $TARBALL"

# ── 清理目标形状校验 ─────────────────────────────────────────────────────────
# e2e_cleanup 会 rm -rf $SCRATCH / $TMP_DIR，两者都必须是本次调用 mktemp -d 的产物。
# 形状不符（例如被外部环境变量顶掉）时直接 die，绝不无审查清理。
assert_mktemp_product() {
  local dir="$1" base="$2" name="$3"
  [ -n "$dir" ] || die "$name 为空，拒绝挂清理 trap"
  [ -d "$dir" ] || die "$name 不是目录：$dir（拒绝清理）"
  base="$(cd "$base" && pwd -P)" || die "$name 根目录无法解析"
  dir="$(cd "$dir" && pwd -P)" || die "$name 目录无法解析"
  case "$dir" in
    "$base"/"$name".*) ;;
    *) die "$name 不是本次 mktemp -d 产物：$dir（期望 $base/$name.XXXXXX，拒绝清理）" ;;
  esac
}

# ── 一个变体的完整流程（在子 shell 里跑：EXIT trap 只清这一个变体）──────────
run_variant() {
  local variant="$1"
  local fixture_dir=""

  e2e_make_scratch dsh-e2e-context
  assert_mktemp_product "$SCRATCH" "${DSH_HOME_BASE:-/tmp}" "dsh-e2e-context"

  export DSH_HOME="$SCRATCH/home"
  local workspace="$SCRATCH/workspace"
  local web_log="$SCRATCH/web.log"
  local profile="$DSH_HOME/profiles/web"
  mkdir -p "$profile" "$workspace"
  SERVER_PID=""
  TMP_DIR=""
  trap e2e_cleanup EXIT
  say "[$variant] scratch：$SCRATCH"

  # 步骤 1：引导 scratch profile（三件套 heredoc 及 minimumReleaseAgeExclude 的
  # 理由见 e2e-common.sh 的 e2e_write_profile）
  e2e_write_profile "$profile"

  # 步骤 2：官方 CLI 安装（真实挂载路径）
  say "[$variant] 安装插件 tarball…"
  $DSH_CMD plugin --profile web add "file:$TARBALL"

  if [ "$variant" = "dual" ] || [ "$variant" = "tab-only" ]; then
    say "[$variant] 安装 ${CONTEXT_PKG}…"
    install_plugin_spec "$CONTEXT_PKG" "$profile"
  fi

  local fixture_tmp
  fixture_tmp="$(mktemp -d "${TMPDIR:-/tmp}/dsh-e2e-context-fixture.XXXXXX")"
  assert_mktemp_product "$fixture_tmp" "${TMPDIR:-/tmp}" "dsh-e2e-context-fixture"
  TMP_DIR="$fixture_tmp"
  fixture_dir="$(build_fixture_package "$TMP_DIR")"
  say "[$variant] 安装仅测试用 fixture 宿主插件（$fixture_dir）…"
  $DSH_CMD plugin --profile web add "file:$fixture_dir"

  if [ "$variant" = "tab-only" ]; then
    # The plugin's OWN public setting, applied as an id-targeted config override
    # in the profile patch layer (the documented `PatchOptions` shape: bundles
    # first, then cordis.patch.yml). `defaultPlacement: tab` keeps dsh-context's
    # in-conversation Context view and does NOT register the right-sidebar tab
    # type or its pane body — the "kind present, body absent / tab-only" state
    # the entries must hide in. Written AFTER the installs so `dsh plugin add`
    # cannot clobber it.
    say "[$variant] 写入 dsh-context defaultPlacement=tab（profile patch 覆盖）…"
    cat > "$profile/cordis.patch.yml" <<'EOF'
# e2e lane (scripts/e2e-context.sh, variant tab-only): an id-targeted config
# override of dsh-context's own public setting. It keeps the plugin's
# conversation-level Context view while leaving the native right column without
# a `dsh-context` tab type — the state the diagnostics entries must hide in.
- id: dsh-context
  config:
    defaultPlacement: tab
EOF
  fi

  # 步骤 3：校验挂载生效（dsh.profile.bundles 含 dsh-better-sidebar；dual 另证
  # context 依赖真的进了 profile）
  assert_profile_installed "$profile" "$variant"

  # 步骤 4：启动真实 dsh web（--port 0 = OS 分配；keyless 可起）
  say "[$variant] 启动 dsh web（port=${PORT}）…"
  export DSH_E2E_CONTEXT_WORKSPACE="$workspace"
  $DSH_CMD web --port "$PORT" --no-open >"$web_log" 2>&1 &
  SERVER_PID=$!

  # 就绪行解析：带一次性 token 的鉴权 URL（理由见 e2e-mount.sh 的同名注释）
  E2E_READY_RE='dsh web: http://127\.0\.0\.1:[0-9]+[^ ]*'
  E2E_READY_PICK=head
  local wait_rc=0
  e2e_wait_dsh_web_ready "$web_log" || wait_rc=$?
  if [ "$wait_rc" -eq 2 ]; then
    echo "=== [$variant] dsh web 提前退出，日志尾部 ===" >&2
    tail -30 "$web_log" >&2 || true
    exit 1
  fi
  if [ "$wait_rc" -ne 0 ]; then
    echo "=== [$variant] 120s 内未等到 dsh web 就绪，日志尾部 ===" >&2
    tail -40 "$web_log" >&2 || true
    exit 1
  fi
  say "[$variant] dsh web 就绪：${URL}（pid ${SERVER_PID}）"

  # 启动期前置校验（都读宿主日志，失败即停在测试之前，避免把「插件没加载」误读
  # 成 controller 失效）：
  # 1) 宿主兼容性预检会把 peer 范围不满足的整行静默 disabled（AGENTS.md §12）；
  if grep -q "disabling profile plugin .*dsh-context" "$web_log"; then
    warn "宿主预检禁用了 dsh-context 行——真机前提不成立"
    grep -n "disabling profile plugin" "$web_log" >&2 || true
    exit 1
  fi
  # 2) tab-only 变体的 id 定向 config 覆盖必须真的命中那行；未命中时 include 只
  #    告警并跳过（cordis-plugin-include 的 applyEntryPatches），右侧栏类型就会
  #    照旧注册——spec 会红，但这里更早给出原因。
  if [ "$variant" = "tab-only" ] && grep -qE "patch: entry .*dsh-context.* not found" "$web_log"; then
    warn "defaultPlacement 覆盖未命中 dsh-context 行（profile patch 的 id 对不上）"
    grep -nE "patch: entry .*dsh-context.* not found" "$web_log" >&2 || true
    exit 1
  fi

  # 步骤 5：运行本 lane 的 spec（只这一个文件；--grep 可选）
  say "[$variant] 运行 Playwright（tests/e2e/context-diagnostics.e2e.ts）…"
  export DSH_E2E_URL="$URL"
  export DSH_E2E_WORKSPACE="$workspace"
  export DSH_E2E_CONTEXT_VARIANT="$variant"
  if [ -n "$GREP_FILTER" ]; then
    pnpm exec playwright test tests/e2e/context-diagnostics.e2e.ts --output "test-results/context-$variant" --grep "$GREP_FILTER"
  else
    pnpm exec playwright test tests/e2e/context-diagnostics.e2e.ts --output "test-results/context-$variant"
  fi

  if ! grep -q '\[e2e-context-fixture\] seeding complete' "$web_log"; then
    warn "fixture 未完成播种"
    tail -20 "$web_log" >&2 || true
    exit 1
  fi

  say "[$variant] 通过"
}

# 官方 CLI 安装一条插件规格；失败时给 profile 写 .npmrc 走官方 registry 重试一次
# （本机默认 registry 是 npmmirror，对新预发布/新版本可能滞后；AGENTS.md §2）。
install_plugin_spec() {
  local spec="$1" profile="$2"
  if $DSH_CMD plugin --profile web add "$spec"; then return 0; fi
  warn "安装 $spec 失败——改用官方 registry（写 $profile/.npmrc）重试一次"
  printf 'registry=https://registry.npmjs.org/\n' > "$profile/.npmrc"
  $DSH_CMD plugin --profile web add "$spec"
}

# 把 tests/e2e/context-fixture-plugin.mjs 打成仅测试用的 npm 包（manifest 随本脚本
# 生成，镜像 tests/fixtures/aggregate-better-sidebar 的形态），返回 tarball 绝对路径。
build_fixture_package() {
  local tmp="$1"
  local dir="$tmp/fixture-context-seed"
  mkdir -p "$dir/lib"
  cp "$ROOT/tests/e2e/context-fixture-plugin.mjs" "$dir/lib/index.mjs"
  cat > "$dir/package.json" <<'EOF'
{
  "name": "fixture-context-seed",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "lib/index.mjs",
  "files": [
    "lib",
    "cordis.patch.yml"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
EOF
  cat > "$dir/cordis.patch.yml" <<'EOF'
# e2e-only bundle patch: mount the context-diagnostics seeding fixture as its own
# row. It never ships (the package is built into the lane's scratch dir from
# tests/e2e/context-fixture-plugin.mjs).
- insert:
    - id: e2e-context-fixture
      name: 'fixture-context-seed'
EOF
  ( cd "$dir" && npm pack --pack-destination "$tmp" >&2 ) || return $?
  local tgz
  tgz="$(ls "$tmp"/fixture-context-seed-*.tgz 2>/dev/null | head -1 || true)"
  [ -n "$tgz" ] || die "fixture 插件打包失败（$dir）"
  printf '%s\n' "$tgz"
}

# 校验挂载点：bundles 含 dsh-better-sidebar；dual 变体另证 context 插件确实进了
# profile 的 dependencies（否则「入口消失」会被误读成 controller 失效）。
assert_profile_installed() {
  local profile="$1" variant="$2"
  if ! node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const bundles = p.dsh?.profile?.bundles ?? [];
    process.exit(bundles.includes("dsh-better-sidebar") ? 0 : 1);
  ' "$profile/package.json"; then
    warn "dsh-better-sidebar 未出现在 dsh.profile.bundles 中——挂载未注册"
    cat "$profile/package.json"
    exit 1
  fi
  if [ "$variant" = "dual" ] || [ "$variant" = "tab-only" ]; then
    if ! node -e '
      const fs = require("fs");
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const dep = p.dependencies?.["dsh-context"] ?? "";
      process.exit(dep === "" ? 1 : 0);
    ' "$profile/package.json"; then
      warn "$variant 变体下 dsh-context 不在 profile dependencies 中——真机前提不成立"
      cat "$profile/package.json"
      exit 1
    fi
  fi
  say "[$variant] 挂载已注册：dsh.profile.bundles 含 dsh-better-sidebar"
}

cd "$ROOT"
for one in $VARIANTS; do
  say "==== 变体 $one ===="
  # Keep this outside a conditional: Bash otherwise disables errexit inside
  # run_variant and a failing Playwright run could be reported as successful.
  ( run_variant "$one" )
done

say "通过：双插件 Context 诊断 lane（变体：$VARIANTS）"
