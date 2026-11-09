# Apply staged dvpnd config files and restart the service (decision D4).
#
# Run ELEVATED by the app (one UAC prompt). Takes only paths: the app wrote and
# validated the files in its own folder; this script never sees config text on
# its command line. It refuses anything but the two expected file names, keeps a
# backup, restarts the service, and rolls back if the service fails to start.
param(
  [Parameter(Mandatory = $true)][string]$Staged,
  [Parameter(Mandatory = $true)][string]$DaemonHome,
  [string]$Service = 'dvpnd',
  [string]$Result
)
$ErrorActionPreference = 'Stop'

function Write-Result([string]$status, [string]$detail) {
  if ($Result) {
    $json = @{ status = $status; detail = $detail; at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($Result, $json, (New-Object System.Text.UTF8Encoding($false)))
  }
}

try {
  $pairs = @(
    @{ src = Join-Path $Staged 'config.toml'; dst = Join-Path $DaemonHome 'config.toml' },
    @{ src = Join-Path $Staged 'client.config.toml'; dst = Join-Path (Join-Path $DaemonHome 'client') 'config.toml' }
  )
  foreach ($p in $pairs) {
    if (-not (Test-Path -LiteralPath $p.src -PathType Leaf)) { throw "missing staged file $($p.src)" }
    if (-not (Test-Path -LiteralPath $p.dst -PathType Leaf)) { throw "daemon home has no $($p.dst)" }
    if ((Get-Item -LiteralPath $p.src).Length -gt 65536) { throw "staged file too large: $($p.src)" }
  }

  foreach ($p in $pairs) { Copy-Item -LiteralPath $p.dst -Destination "$($p.dst).bak" -Force }

  $svc = Get-Service -Name $Service -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -ne 'Stopped') { Stop-Service -Name $Service -Force; $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }

  foreach ($p in $pairs) { Copy-Item -LiteralPath $p.src -Destination $p.dst -Force }

  if ($svc) {
    try {
      Start-Service -Name $Service
      (Get-Service -Name $Service).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    } catch {
      foreach ($p in $pairs) { Copy-Item -LiteralPath "$($p.dst).bak" -Destination $p.dst -Force }
      Start-Service -Name $Service -ErrorAction SilentlyContinue
      throw "service failed to start with the new settings; previous settings restored: $($_.Exception.Message)"
    }
  }
  Write-Result 'ok' ($(if ($svc) { 'applied and restarted' } else { 'applied (no service installed)' }))
  exit 0
} catch {
  Write-Result 'error' $_.Exception.Message
  exit 1
}
