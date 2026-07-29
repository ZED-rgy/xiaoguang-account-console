[CmdletBinding()]
param(
  [switch]$Collect,
  [switch]$FallbackToDevelopment
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$executableName = "$($package.productName).exe"

$candidates = @()
if ($env:ACCOUNT_CONSOLE_EXE) {
  $candidates += $env:ACCOUNT_CONSOLE_EXE
}
if ($env:ACCOUNT_CONSOLE_INSTALL_DIR) {
  $candidates += Join-Path $env:ACCOUNT_CONSOLE_INSTALL_DIR $executableName
}
$candidates += Join-Path $root "dist\win-unpacked\$executableName"

Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | ForEach-Object {
  $candidates += Join-Path $_.Root "$($package.productName)\$executableName"
}

$executable = $candidates |
  Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
  Select-Object -Unique -First 1

if ($executable) {
  if ($Collect) {
    Start-Process -FilePath $executable -ArgumentList '--collect'
  } else {
    Start-Process -FilePath $executable
  }
  Write-Output "Started: $executable"
  exit 0
}

if ($FallbackToDevelopment) {
  $script = if ($Collect) { 'collect' } else { 'start' }
  $npm = Get-Command npm.cmd -ErrorAction Stop
  Start-Process -FilePath $npm.Source -ArgumentList @('run', $script) -WorkingDirectory $root
  Write-Output "No packaged executable found; started development command: npm run $script"
  exit 0
}

throw 'No packaged executable found. Set ACCOUNT_CONSOLE_EXE or ACCOUNT_CONSOLE_INSTALL_DIR, or build with npm run pack.'
