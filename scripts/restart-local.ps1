[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$port = if ($env:ACCOUNT_CONSOLE_PORT) { [int]$env:ACCOUNT_CONSOLE_PORT } else { 8826 }
$connections = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)

foreach ($processId in @($connections | Select-Object -ExpandProperty OwningProcess -Unique)) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
  if (-not $process) {
    continue
  }

  $identity = "$($process.Name) $($process.CommandLine)"
  $belongsToAccountConsole = $identity -match 'account-console-server' -or $identity -match 'run_server\.py'
  if (-not $belongsToAccountConsole) {
    throw "Port $port is owned by another process and was not stopped: $identity"
  }

  Stop-Process -Id $processId -Force
  Write-Output "Stopped account-console backend PID $processId on port $port."
}

& (Join-Path $PSScriptRoot 'start-installed.ps1') -FallbackToDevelopment
