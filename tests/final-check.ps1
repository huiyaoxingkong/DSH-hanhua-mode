# 「汉化模式」交付前终检（冻结后一次性跑完）
#
#   pwsh -File tests\final-check.ps1
#
# 覆盖：仓库/已安装组合文件的挂载级检查、真实 discovery 健康检查、真实运行时集成测试、
#       组合文件一致性门禁、独立验证者的全部探针、仓库↔已安装副本哈希一致性。
# 退出码：0 = 全绿；1 = 有阶段失败。

param(
  [string]$Node = 'D:\Agent-windows\DeepSeekHarness\runtime\node.exe',
  [string]$Installed = 'D:\Agent-windows\DeepSeekHarness\data\.dsh\.agent-presets\hanhua',
  [string]$DshHome = 'D:\Agent-windows\DeepSeekHarness\data\.dsh'
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$script:failed = @()

function Stage([string]$name, [scriptblock]$body) {
  Write-Host "`n=== $name ===" -ForegroundColor Cyan
  & $body
  if ($LASTEXITCODE -ne 0) { $script:failed += $name; Write-Host "  -> FAIL ($name)" -ForegroundColor Red }
  else { Write-Host "  -> OK" -ForegroundColor Green }
}

Stage '1a 修复前组合（应失败：persona prefix + worker-thread import）' {
  & $Node 'tests\mount-check.mjs' 'preset\agent.cordis.yml.before-v12' 2>&1 | Select-Object -Last 4
  if ($LASTEXITCODE -eq 0) { Write-Host '  !! 期望失败却通过了'; $global:LASTEXITCODE = 1 }
}
# 上面这个阶段「期望失败」，翻转其结果
if ($script:failed -contains '1a 修复前组合（应失败：persona prefix + worker-thread import）') {
  $script:failed = $script:failed | Where-Object { $_ -ne '1a 修复前组合（应失败：persona prefix + worker-thread import）' }
  Write-Host '  (已按「期望失败」判定：通过)' -ForegroundColor Green
} else {
  $script:failed += '1a 期望失败但实际通过'
}

Stage '1b 仓库组合文件挂载级检查' { & $Node 'tests\mount-check.mjs' 2>&1 | Select-Object -Last 3 }
Stage '1c 已安装组合文件挂载级检查' { & $Node 'tests\mount-check.mjs' "$Installed\agent.cordis.yml" 2>&1 | Select-Object -Last 3 }
Stage '2 预设健康检查（真实 discovery）' {
  $env:DSH_HOME = $DshHome
  & $Node 'tests\preset-health.mjs' 2>&1 | Select-String -Pattern 'healthy|BROKEN' | Select-Object -Last 8
}
Stage '3 真实 0.1.6 服务实现集成测试（已安装插件）' {
  & $Node 'tests\harness.mjs' --plugin "$Installed\plugins\hanhua\index.js" 2>&1 | Select-String -Pattern '结果|FAIL' | Select-Object -First 8
}
Stage '4 组合文件生成器一致性' { & $Node 'tests\build-composition.mjs' --check }
Stage '5 仓库 ↔ 已安装副本一致性' {
  $pairs = @(
    @{ a = 'preset\agent.cordis.yml'; b = "$Installed\agent.cordis.yml" },
    @{ a = 'preset\plugins\hanhua\index.js'; b = "$Installed\plugins\hanhua\index.js" },
    @{ a = 'preset\preset.yml'; b = "$Installed\preset.yml" }
  )
  $bad = 0
  foreach ($p in $pairs) {
    $ha = (Get-FileHash $p.a -Algorithm SHA256).Hash
    $hb = (Get-FileHash $p.b -Algorithm SHA256).Hash
    $ok = $ha -eq $hb
    if (-not $ok) { $bad++ }
    "{0,-40} {1}" -f $p.a, $(if ($ok) { 'SAME' } else { "DIFF ($ha vs $hb)" })
  }
  if ($bad -gt 0) { $global:LASTEXITCODE = 1 }
}

# 独立验证者的探针（若存在则全部跑一遍）
$probes = @(
  'tests\.verify\probe-static.mjs',
  'tests\.verify\probe-registry.mjs',
  'tests\.verify\probe-order.mjs',
  'tests\.verify\harness-subst.mjs',
  'tests\.verify\probe-reparse.mjs',
  'tests\.verify\probe-backup-twice.mjs',
  'tests\.verify\probe-iconv.mjs',
  'tests\.verify\probe-cwd.mjs'
)
foreach ($probe in $probes) {
  if (-not (Test-Path $probe)) { continue }
  $name = "6 $probe"
  Stage $name {
    if ($probe -match 'probe-registry|probe-order|harness-subst|probe-backup-twice') {
      & $Node $probe --plugin "$Installed\plugins\hanhua\index.js" 2>&1 | Select-Object -Last 3
    } else {
      & $Node $probe 2>&1 | Select-Object -Last 3
    }
  }
}

Write-Host "`n================ 终检汇总 ================" -ForegroundColor Cyan
if ($script:failed.Count -eq 0) {
  Write-Host '全部阶段通过 ✅' -ForegroundColor Green
  exit 0
}
Write-Host "失败阶段：`n - $($script:failed -join "`n - ")" -ForegroundColor Red
exit 1
