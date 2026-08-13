#!/usr/bin/env bash
# =============================================================================
# dsh-better-sidebar 一键安装脚本（官方 CLI 方式）
#
# 通过 DSH 官方插件命令安装 npm 包并自动挂载：
#   dsh plugin --profile web add dsh-better-sidebar@<version>
#
# 包内声明了 dsh.bundle.patch（cordis.patch.yml）：CLI 的 bundle 协调会把它
# 自动加进 profile 的 dsh.profile.bundles，下次启动即挂载——无需手动写
# cordis.patch.yml 挂载行。符合仓库硬约束：不修改 DSH 源码，插件永远作为
# 独立包被 profile 引用。
#
# 用法：
#   bash scripts/install.sh [版本] [--restart] [--dry-run]
#
#   版本    npm 版本号/范围，缺省为 latest（自动解析为 ^<最新>）。
#           示例：0.10.2、^0.10.2、~0.10.2、latest
#   --restart   装完后尝试 `pm2 restart dsh-web`（无 pm2 时仅打印提示）。
#               注意：重启会断开当前 DSH 页面会话，默认不自动重启。
#   --dry-run   只打印将要执行的操作，不写任何文件。
#
# 环境：
#   DSH_HOME    默认 ~/.dsh
#   REGISTRY    默认 https://registry.npmjs.org（发布源；装依赖仍走 pnpm 配置）
#   DSH_CMD     默认优先用 PATH 上的 `dsh`，缺省回退 npx -y --package @deepseek-ai/dsh
#
# 说明：
# - pnpm 11 的 strict-dep-builds 会拦截 node-pty/protobufjs 的构建脚本并使
#   `dsh plugin add` 非零退出（bundle 协调因此被跳过）。脚本会先把这两个
#   构建许可写进 profile 的 pnpm-workspace.yaml（幂等），保证 CLI 一步成功。
# - 安装后按实际包元数据选择挂载通道：有 dsh.bundle.patch 时校验 bundle
#   自动注册并移除旧手动挂载；没有时幂等写入手动挂载（兼容旧发布版）。
# - 回滚：dsh plugin --profile web remove dsh-better-sidebar，或把 profile 依赖
#   改回 "dsh-better-sidebar": "link:<路径>" 再 pnpm install。
# =============================================================================
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
WS_YML="$PROFILE_DIR/pnpm-workspace.yaml"
PATCH_YML="$PROFILE_DIR/cordis.patch.yml"
REGISTRY="${REGISTRY:-https://registry.npmjs.org}"
PKG="dsh-better-sidebar"
DSH_CMD="${DSH_CMD:-dsh}"

RESTART=false
DRY_RUN=false
VERSION_SPEC=""
for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=true ;;
    --dry-run) DRY_RUN=true ;;
    -*) echo "未知参数: $arg" >&2; exit 2 ;;
    *) VERSION_SPEC="$arg" ;;
  esac
done

say()  { printf '\033[32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# 解析用户给的版本 -> CLI 要用的 npm spec（"x.y.z" / "^x.y.z"）
resolve_spec() {
  local given="${1:-latest}"
  case "$given" in
    latest)
      local v
      v="$(npm view "$PKG" version --registry="$REGISTRY" 2>/dev/null)" \
        || die "无法从 $REGISTRY 解析 $PKG 的最新版本（请检查网络/登录）。可显式传版本号：bash scripts/install.sh 0.10.2"
      printf '%s' "$v"
      ;;
    *) printf '%s' "$given" ;;
  esac
}

# 组装 dsh CLI 调用：优先 PATH 上的 dsh，缺省 npx 拉官方包
dsh_cli() {
  if command -v "$DSH_CMD" >/dev/null 2>&1; then
    printf '%s' "$DSH_CMD"
  else
    printf 'npx -y --package @deepseek-ai/dsh dsh'
  fi
}

# 只识别插件的 insert 挂载块；普通 `- id: better-sidebar` 配置覆盖不是挂载。
has_manual_mount() {
  node -e '
    const fs = require("fs");
    const t = fs.readFileSync(process.argv[1], "utf8");
    const mount = /^[ \t]*- insert:\s*\r?\n[ \t]+- id: better-sidebar\s*\r?\n[ \t]+name: ["'"'"']?dsh-better-sidebar["'"'"']?\s*$/m;
    process.exit(mount.test(t) ? 0 : 1);
  ' "$PATCH_YML"
}

[ -d "$PROFILE_DIR" ] || die "找不到 profile 目录：${PROFILE_DIR}（请先安装并运行过一次 dsh web）"
[ -f "$WS_YML" ]      || die "找不到 ${WS_YML}（请先初始化 web profile）"

SPEC="$(resolve_spec "$VERSION_SPEC")"
CLI="$(dsh_cli)"
say "目标：$CLI plugin --profile web add $PKG@${SPEC}（profile: ${PROFILE_DIR}）"

if [ "$DRY_RUN" = true ]; then
  say "[dry-run] 步骤 1：确保 $WS_YML 含 allowBuilds（node-pty/protobufjs: true）"
  say "[dry-run] 步骤 2：执行 $CLI plugin --profile web add $PKG@${SPEC}（安装 + bundle 自动注册）"
  say "[dry-run] 步骤 3：按实际包元数据校验 bundle 注册，或兼容写入旧版手动挂载"
  if [ "$RESTART" = true ]; then say "[dry-run] 步骤 4：pm2 restart dsh-web"; else say "[dry-run] 步骤 4：提示用户手动重启 DSH"; fi
  exit 0
fi

# 步骤 1：预写 allowBuilds（幂等），保证 pnpm 不为 node-pty/protobufjs 拦截构建
if ! grep -qE '^\s*node-pty: true\s*$' "$WS_YML"; then
  # 清除 pnpm 自动写入的占位值（"set this to true or false"）后写入 true
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    let t = fs.readFileSync(p, "utf8");
    t = t.replace(/node-pty:.*/g, "node-pty: true");
    t = t.replace(/protobufjs:.*/g, "protobufjs: true");
    if (!t.includes("allowBuilds:")) t += "\nallowBuilds:\n  node-pty: true\n  protobufjs: true\n";
    fs.writeFileSync(p, t);
  ' "$WS_YML"
  say "已确保 $WS_YML 的 allowBuilds（node-pty/protobufjs: true）"
else
  say "allowBuilds 已就绪，跳过"
fi

# 步骤 2：官方 CLI 安装 + bundle 自动注册（含挂载）
say "执行 $CLI plugin --profile web add $PKG@$SPEC ..."
if ! $CLI plugin --profile web add "$PKG@$SPEC" 2>&1 | tail -n +1; then
  warn "dsh plugin add 失败。可能原因：minimumReleaseAge（发布 <24h，pnpm 通常自动写入排除并重试）"
  warn "或 allowBuilds 未生效。可手动重试：cd $PROFILE_DIR && pnpm install"
  exit 1
fi

INSTALLED_PKG_JSON="$PROFILE_DIR/node_modules/$PKG/package.json"
[ -f "$INSTALLED_PKG_JSON" ] || die "安装命令完成，但找不到 $INSTALLED_PKG_JSON"
[ -f "$PATCH_YML" ] || die "找不到 ${PATCH_YML}（请先初始化 web profile）"

# 步骤 3：以实际安装包元数据为准选择挂载通道。main 可能领先 npm latest，
# 因此不能按脚本自身版本或请求 spec 猜测 dsh.bundle.patch 是否已经发布。
if node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.exit(typeof p.dsh?.bundle?.patch === "string" ? 0 : 1);
' "$INSTALLED_PKG_JSON"; then
  if ! node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const bundles = p.dsh?.profile?.bundles ?? [];
    process.exit(bundles.includes(process.argv[2]) ? 0 : 1);
  ' "$PROFILE_DIR/package.json" "$PKG"; then
    warn "${PKG} 声明了 dsh.bundle.patch，但未出现在 dsh.profile.bundles 中——挂载未注册。"
    warn "若上面的 pnpm 输出提示 ignored build scripts，请确认 $WS_YML 的 allowBuilds 后重跑本脚本。"
    exit 1
  fi
  say "bundle 已注册：dsh.profile.bundles 包含 ${PKG}（下次启动自动挂载）"

  # bundle 通道激活后移除旧手动挂载，避免双挂载。
  if has_manual_mount; then
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      let t = fs.readFileSync(p, "utf8");
      const mount = /(?:^[ \t]*#[^\n]*\n)*^[ \t]*- insert:\s*\r?\n[ \t]+- id: better-sidebar\s*\r?\n[ \t]+name: ["'"'"']?dsh-better-sidebar["'"'"']?\s*(?:\r?\n|$)/gm;
      t = t.replace(mount, "");
      t = t.replace(/\n{3,}/g, "\n\n");
      if (t.trim() === "") t = "[]\n";
      fs.writeFileSync(p, t);
    ' "$PATCH_YML"
    say "已从 $PATCH_YML 移除旧的 better-sidebar 手动挂载行（bundle 通道接管挂载）"
  else
    say "无旧手动挂载行，跳过"
  fi
else
  # 旧发布版没有 dsh.bundle.patch：保留 CLI 的依赖安装结果，回退到 profile
  # 手动挂载。不能直接向初始 `[]` 后追加，否则会产生无效 YAML。
  if has_manual_mount; then
    say "旧版手动挂载已存在，跳过"
  else
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      let t = fs.readFileSync(p, "utf8");
      const content = t.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
      if (content.length === 1 && content[0] === "[]") t = t.replace(/^[ \t]*\[\][ \t]*(?:\r?\n|$)/m, "");
      if (t.length > 0 && !t.endsWith("\n")) t += "\n";
      if (t.length > 0 && !t.endsWith("\n\n")) t += "\n";
      t += "# dsh-better-sidebar mount (added by scripts/install.sh)\n";
      t += "- insert:\n    - id: better-sidebar\n      name: '"'"'dsh-better-sidebar'"'"'\n";
      fs.writeFileSync(p, t);
    ' "$PATCH_YML"
    say "已为不含 dsh.bundle.patch 的旧发布版写入手动挂载：$PATCH_YML"
  fi
fi

say "安装完成：$PKG@$SPEC"

# 步骤 4：重启提示
if [ "$RESTART" = true ]; then
  if command -v pm2 >/dev/null 2>&1; then
    say "重启 dsh-web（pm2）..."
    pm2 restart dsh-web || warn "pm2 restart 失败，请手动重启 DSH"
  else
    warn "未找到 pm2，请手动重启 DSH（如：pm2 restart dsh-web 或 dsh web）"
  fi
else
  say "下一步：重启 DSH 并硬刷新（Cmd/Ctrl+Shift+R）使新副本生效。"
  if command -v pm2 >/dev/null 2>&1; then
    say "本机可用：pm2 restart dsh-web（会短暂断开当前页面会话）"
  fi
fi
