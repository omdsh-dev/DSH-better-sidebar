## =============================================================================
# dsh-better-sidebar 一键安装脚本（官方 CLI 方式，Windows PowerShell 5.1+ / pwsh）
#
# 通过 DSH 官方插件命令安装 npm 包并自动挂载：
#   dsh plugin --profile web add dsh-better-sidebar@<version>
#
# 包内声明了 dsh.bundle.patch（cordis.patch.yml）：CLI 的 bundle 协调会把它
# 自动加进 profile 的 dsh.profile.bundles，下次启动即挂载——无需手动写
# cordis.patch.yml 挂载行。符合仓库硬约束：不修改 DSH 源码，插件永远作为
# 独立包被 profile 引用。
#
# 用法（任选其一）：
#   # 默认最新版
#   irm https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.ps1 | iex
#   # 指定版本 / 装完重启
#   & ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.ps1'))) -Version 0.10.2 -Restart
#   # 本地保存后运行
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Version 0.10.2 -DryRun
#   # 修复 node-pty 依赖（终端提示「node-pty 加载失败」时用，见 issue #140）
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Repair
#
# 参数：
#   -Version    npm 版本号/范围，缺省 latest（自动解析为最新）。
#   -Repair     修复模式：不重装插件，只确保 profile 的 pnpm-workspace.yaml
#               放行 node-pty 构建脚本，然后重跑 pnpm install + pnpm rebuild
#               node-pty。
#   -Profile    目标 profile 名（缺省 web）；安装与修复模式均适用。
#   -Restart    装完后尝试 `pm2 restart dsh-web`（无 pm2 时仅提示）。会断开当前页面会话。
#   -DryRun     只打印将要执行的操作，不写任何文件。
#
# 环境变量（均可省略）：
#   DSH_HOME    默认 %USERPROFILE%\.dsh
#   REGISTRY    默认 https://registry.npmjs.org
#   DSH_CMD     默认优先 PATH 上的 dsh，缺省回退 npx -y --package @deepseek-ai/dsh
#
# 说明：
# - pnpm 11 的 strict-dep-builds 会拦截 node-pty/protobufjs 的构建脚本并使
#   `dsh plugin add` 非零退出。脚本会先把这两个构建许可写进 profile 的
#   pnpm-workspace.yaml（幂等），保证 CLI 一步成功。
# - pnpm 11 的 minimumReleaseAge 会拒绝发布 <24h 的新版本。脚本会预写
#   minimumReleaseAgeExclude（幂等），放行本插件，避免"重跑一次才成功"。
# - 老版本（<0.10.2）用手动挂载行，bundle 通道激活后需移除，否则双挂载。
#   脚本会幂等移除 better-sidebar 挂载行。
# =============================================================================
param(
  [string]$Version = '',
  [switch]$Restart,
  [switch]$DryRun,
  [switch]$Repair,
  [string]$Profile = 'web'
)

$PKG = 'dsh-better-sidebar'
$REGISTRY = if ($env:REGISTRY) { $env:REGISTRY } else { 'https://registry.npmjs.org' }

# DSH_HOME：DSH_HOME 环境变量 > %USERPROFILE% > $HOME
if ($env:DSH_HOME) {
  $DSH_HOME = $env:DSH_HOME
} elseif ($env:USERPROFILE) {
  $DSH_HOME = Join-Path $env:USERPROFILE '.dsh'
} else {
  $DSH_HOME = Join-Path $HOME '.dsh'
}
$PROFILE_DIR = Join-Path $DSH_HOME "profiles\$Profile"
$WS_YML = Join-Path $PROFILE_DIR 'pnpm-workspace.yaml'
$PATCH_YML = Join-Path $PROFILE_DIR 'cordis.patch.yml'

function Say([string]$m)  { Write-Host "[install] $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "[warn] $m" -ForegroundColor Yellow }
function Die([string]$m)  { Write-Host "[error] $m" -ForegroundColor Red; exit 1 }

# 解析版本 -> npm spec（"x.y.z" / "^x.y.z" / latest）
function Resolve-Spec {
  param([string]$Given)
  if ([string]::IsNullOrWhiteSpace($Given) -or $Given -eq 'latest') {
    $v = $null
    foreach ($tool in @('npm', 'pnpm')) {
      if (Get-Command $tool -ErrorAction SilentlyContinue) {
        $v = (& $tool view $PKG version "--registry=$REGISTRY" 2>$null | Select-Object -Last 1)
        if ($v) { break }
      }
    }
    if ($v) { return ([string]$v).Trim() }
    Warn '无法联网解析最新版本（npm/pnpm 查询失败），回退为 latest，由 pnpm 直接解析。'
    Warn '若已知版本号，可显式传入：-Version 0.10.2'
    return 'latest'
  }
  return $Given
}

# 组装 dsh CLI：优先 PATH 上的 dsh，缺省 npx 拉官方包
function Get-DshCli {
  if ($env:DSH_CMD) { return $env:DSH_CMD }
  if (Get-Command dsh -ErrorAction SilentlyContinue) { return 'dsh' }
  if (Get-Command npx -ErrorAction SilentlyContinue) { return 'npx' }
  return $null
}

# 步骤 1（安装与修复共用）：预写 workspace 设置（幂等），保证 pnpm 不拦截
# node-pty/protobufjs 构建脚本、放行本插件新版本
function Ensure-WorkspaceSettings {
  $wsScript = @'
const fs = require("fs");
const p = process.argv[2];
let t = fs.readFileSync(p, "utf8");
const before = t;
t = t.replace(/^(\s*)(node-pty|protobufjs):.*$/gm, "$1$2: true");
if (!/^\s*allowBuilds:\s*$/m.test(t)) {
  t += "\nallowBuilds:\n  node-pty: true\n  protobufjs: true\n";
} else {
  for (const k of ["node-pty", "protobufjs"]) {
    if (!new RegExp("^\\s*" + k + ":\\s*true\\s*$", "m").test(t)) {
      t = t.replace(/^(\s*allowBuilds:\s*)$/m, "$1\n  " + k + ": true");
    }
  }
}
if (!/^\s*-\s+dsh-better-sidebar\s*$/m.test(t)) {
  if (/^\s*minimumReleaseAgeExclude:\s*$/m.test(t)) {
    t = t.replace(/^(\s*minimumReleaseAgeExclude:\s*)$/m, "$1\n  - dsh-better-sidebar");
  } else {
    t += "\nminimumReleaseAgeExclude:\n  - dsh-better-sidebar\n";
  }
}
if (t !== before) fs.writeFileSync(p, t);
console.log(t === before ? "unchanged" : "updated");
'@
  # PowerShell 5.1 把含内嵌双引号的多行 JS 作为参数传给 `node -e` 时，引号会被
  # Windows 命令行解析吞掉，导致 JS 语法错误（Expected ',', got ':'）。
  # 改用临时文件方式，兼容 PS 5.1 与 pwsh 7。
  $wsJs = Join-Path $env:TEMP ("dshbs-ws-" + [guid]::NewGuid().ToString("N") + ".js")
  Set-Content -LiteralPath $wsJs -Value $wsScript -Encoding UTF8
  $wsOut = node $wsJs "$WS_YML" 2>&1
  $wsCode = $LASTEXITCODE
  Remove-Item -LiteralPath $wsJs -Force -ErrorAction SilentlyContinue
  $wsResult = (($wsOut | Out-String)).Trim()
  if ($wsCode -ne 0) { Die "处理 $WS_YML 失败（node 退出码 $wsCode）：$wsResult" }
  if ($wsResult -eq 'updated') {
    Say "已确保 $WS_YML：allowBuilds（node-pty/protobufjs: true）+ minimumReleaseAgeExclude（$PKG）"
  } else {
    Say 'workspace 设置已就绪，跳过'
  }
}

# 前置校验
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die '未找到 node（DSH 运行需要 Node.js >= 20），请先安装 Node.js 并加入 PATH。'
}
if (-not (Test-Path $PROFILE_DIR)) {
  Die "找不到 profile 目录：$PROFILE_DIR（请先安装并运行过一次 dsh web）"
}
if (-not (Test-Path $WS_YML)) {
  Die "找不到 $WS_YML（请先初始化 $Profile profile）"
}

# ── 修复模式（issue #140）：不重装插件，只修复 node-pty 依赖 ────────────
# 终端提示「node-pty 加载失败」时运行：确保 allowBuilds 后重跑
# pnpm install + pnpm rebuild node-pty（重放被 pnpm 11 拦截的构建脚本）。
if ($Repair) {
  if ($DryRun) {
    Say "[dry-run] 修复：确保 $WS_YML 含 allowBuilds（node-pty: true）"
    Say "[dry-run] 修复：cd $PROFILE_DIR; pnpm install; pnpm rebuild node-pty"
    exit 0
  }
  Say "修复模式：重装 node-pty（profile: $Profile，$PROFILE_DIR）..."
  Ensure-WorkspaceSettings
  Push-Location $PROFILE_DIR
  try {
    pnpm install
    if ($LASTEXITCODE -ne 0) { Die "pnpm install 失败（退出码 $LASTEXITCODE）。请确认 pnpm 在 PATH 上、网络可用，然后重试。" }
    pnpm rebuild node-pty
    if ($LASTEXITCODE -ne 0) { Die "pnpm rebuild node-pty 失败（退出码 $LASTEXITCODE）。请确认 pnpm 在 PATH 上，然后重试。" }
  } finally {
    Pop-Location
  }
  Say '修复完成：node-pty 已重装（与 DSH 核心保持同一版本）。请重启 DSH 后重试终端。'
  exit 0
}

$SPEC = Resolve-Spec $Version
$CLI = Get-DshCli
if (-not $CLI) {
  Die '未找到 dsh 或 npx。请先安装 DSH（并确保 Node/npm 可用），或用 DSH_CMD 指定。'
}
Say "目标：$CLI plugin --profile $Profile add $PKG@$SPEC（profile: $PROFILE_DIR）"

if ($DryRun) {
  Say "[dry-run] 步骤 1：确保 $WS_YML 含 allowBuilds（node-pty/protobufjs: true）与 minimumReleaseAgeExclude（$PKG）"
  Say "[dry-run] 步骤 2：执行 $CLI plugin --profile $Profile add $PKG@$SPEC（安装 + bundle 自动注册）"
  Say "[dry-run] 步骤 3：校验 dsh.profile.bundles 含 $PKG"
  Say "[dry-run] 步骤 4：幂等移除 $PATCH_YML 里旧的 better-sidebar 手动挂载行（避免双挂载）"
  if ($Restart) { Say '[dry-run] 步骤 5：pm2 restart dsh-web' } else { Say '[dry-run] 步骤 5：提示用户手动重启 DSH' }
  exit 0
}

# 步骤 1：预写 workspace 设置（幂等），保证 pnpm 不拦截构建、放行本插件新版本
Ensure-WorkspaceSettings

# 步骤 2：官方 CLI 安装 + bundle 自动注册（含挂载）
if ($CLI -eq 'dsh') {
  $cliArgs = @('plugin', '--profile', $Profile, 'add', "$PKG@$SPEC")
} else {
  $cliArgs = @('-y', '--package', '@deepseek-ai/dsh', 'dsh', 'plugin', '--profile', $Profile, 'add', "$PKG@$SPEC")
}
Say "执行 $CLI plugin --profile $Profile add $PKG@$SPEC ..."
$addOut = & $CLI @cliArgs 2>&1
$addCode = $LASTEXITCODE
$addOut | ForEach-Object { $_ }
if ($addCode -ne 0) {
  Warn 'dsh plugin add 失败。已预写 allowBuilds 与 minimumReleaseAgeExclude，仍失败的可能原因：'
  Warn '  - 网络/登录问题：npm registry 不可达或需要登录。'
  Warn "  - 依赖安装冲突：可手动重试 cd $PROFILE_DIR; pnpm install。"
  exit 1
}

# 步骤 3：校验 bundle 已注册（挂载生效的判据）
$pkgJson = Get-Content -Raw (Join-Path $PROFILE_DIR 'package.json') | ConvertFrom-Json
$bundles = $pkgJson.dsh.profile.bundles
if ($bundles -notcontains $PKG) {
  Warn 'dsh-better-sidebar 未出现在 dsh.profile.bundles 中——挂载未注册。'
  Warn "若上面的 pnpm 输出提示 ignored build scripts，请确认 $WS_YML 的 allowBuilds 后重跑本脚本。"
  exit 1
}
Say "bundle 已注册：dsh.profile.bundles 包含 $PKG（下次启动自动挂载）"

# 步骤 4：幂等移除旧的 manual 挂载行（避免与 bundle 双挂载）
$mountScript = @'
const fs = require("fs");
const p = process.argv[2];
const lines = fs.readFileSync(p, "utf8").split("\n");
const out = [];
let i = 0;
let removed = false;
while (i < lines.length) {
  const line = lines[i];
  if (/^[ \t]*- insert:\s*$/.test(line)) {
    const block = [line];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "" && !/^-\s/.test(lines[j])) {
      block.push(lines[j]);
      j++;
    }
    if (block.some((l) => /id:\s*better-sidebar\b/.test(l))) {
      while (out.length && /^[ \t]*#/.test(out[out.length - 1])) out.pop();
      i = j;
      removed = true;
      continue;
    }
  }
  out.push(line);
  i++;
}
if (!removed) {
  console.log("none");
} else {
  const t = out.join("\n").replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(p, t);
  console.log("removed");
}
'@
$mountJs = Join-Path $env:TEMP ("dshbs-mount-" + [guid]::NewGuid().ToString("N") + ".js")
Set-Content -LiteralPath $mountJs -Value $mountScript -Encoding UTF8
$mountOut = node $mountJs "$PATCH_YML" 2>&1
$mountCode = $LASTEXITCODE
Remove-Item -LiteralPath $mountJs -Force -ErrorAction SilentlyContinue
$mountResult = (($mountOut | Out-String)).Trim()
if ($mountCode -ne 0) { Die "处理 $PATCH_YML 失败（node 退出码 $mountCode）：$mountResult" }
if ($mountResult -eq 'removed') {
  Say "已从 $PATCH_YML 移除旧的 better-sidebar 手动挂载行（bundle 通道接管挂载）"
} else {
  Say '无旧手动挂载行，跳过'
}

Say "安装完成：$PKG@$SPEC"

# 步骤 5：重启提示
if ($Restart) {
  if (Get-Command pm2 -ErrorAction SilentlyContinue) {
    Say '重启 dsh-web（pm2）...'
    pm2 restart dsh-web
    if ($LASTEXITCODE -ne 0) { Warn 'pm2 restart 失败，请手动重启 DSH' }
  } else {
    Warn '未找到 pm2，请手动重启 DSH（如：pm2 restart dsh-web 或 dsh web）'
  }
} else {
  Say '下一步：重启 DSH 并硬刷新（Ctrl+Shift+R / Cmd+Shift+R）使新副本生效。'
  if (Get-Command pm2 -ErrorAction SilentlyContinue) {
    Say '本机可用：pm2 restart dsh-web（会短暂断开当前页面会话）'
  }
}
