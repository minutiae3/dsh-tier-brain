# dsh-tier-brain 安装脚本
# 用法：powershell -ExecutionPolicy Bypass -File .\install.ps1
# 做的事：备份 package.json → 复制插件 → 把包名加进 bundles。不改 cordis.patch.yml。

$ErrorActionPreference = 'Stop'

$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$src = $PSScriptRoot
$dst = Join-Path $profileDir 'node_modules\dsh-tier-brain'
$pkgPath = Join-Path $profileDir 'package.json'

if (-not (Test-Path $pkgPath)) {
  throw "找不到 profile：$pkgPath"
}

Write-Host "1/3 备份 package.json ..."
if (-not (Test-Path "$pkgPath.bak-tier-brain")) {
  Copy-Item $pkgPath "$pkgPath.bak-tier-brain" -Force
}

Write-Host "2/3 复制插件到 $dst ..."
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item (Join-Path $src 'lib') (Join-Path $dst 'lib') -Recurse -Force
Copy-Item (Join-Path $src 'package.json') $dst -Force
Copy-Item (Join-Path $src 'cordis.patch.yml') $dst -Force
Copy-Item (Join-Path $src 'README.md') $dst -Force
Copy-Item (Join-Path $src 'LICENSE') $dst -Force

Write-Host "3/3 更新 bundles ..."
$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-tier-brain') {
  $pkg.dsh.profile.bundles = @($bundles + 'dsh-tier-brain')
}
# 必须写“无 BOM 的 UTF-8”。Windows PowerShell 5.1 的 Set-Content -Encoding UTF8
# 会加 BOM，而 DSH 的 readProfileManifest 用 JSON.parse 读取，遇 BOM 会直接启动崩溃
# （2026-10-21 踩过：DesktopHostFatalError: Unexpected token '﻿'...）。
$json = $pkg | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host '安装完成。请重启 DSH（完全退出后重开）。'
Write-Host '重启后：正常聊天看左下角卡片，或输入 /tier 测试。'
Write-Host '回滚：把 package.json.bak-tier-brain 复制回 package.json，删掉 node_modules\dsh-tier-brain。'
