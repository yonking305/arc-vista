# ArcVista 内网离线安装器 · Windows PowerShell 入口
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $portable = Join-Path $env:LOCALAPPDATA 'DeepSeekHarness\app\node\node.exe'
  if (Test-Path $portable) {
    $node = $portable
  }
}

if (-not $node) {
  Write-Host '[X] 未找到 Node.js。请先安装 DSH（自带 Node），或安装 Node.js 22.19+。' -ForegroundColor Red
  Read-Host '按回车关闭'
  exit 1
}

& $node (Join-Path $PSScriptRoot 'install.mjs') @args
$code = $LASTEXITCODE

Write-Host ''
if ($code -eq 0) {
  Write-Host '安装完成。' -ForegroundColor Green
} else {
  Write-Host "安装未完成（exit $code）。请把上面的输出发给管理员。" -ForegroundColor Yellow
}
Read-Host '按回车关闭'
exit $code
