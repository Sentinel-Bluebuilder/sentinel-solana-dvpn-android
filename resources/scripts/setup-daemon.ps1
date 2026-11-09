# Install the VPN service from a home the app already initialised (F1.5).
#
# Order matters: dvpnd refuses to start until its device key holds a grant, so
# the app first runs `dvpnd init` UNELEVATED into a per-user staging folder,
# the owner signs device setup, and only then this script runs ELEVATED (one
# UAC prompt) to: copy the home into ProgramData, lock the key folder to
# SYSTEM + Administrators, install + start the service, and delete the staging
# copy (it holds the device secret). Takes only paths, each checked here.
param(
  [Parameter(Mandatory = $true)][string]$Dvpnd,
  [Parameter(Mandatory = $true)][string]$Staging,
  [Parameter(Mandatory = $true)][string]$DaemonHome,
  [Parameter(Mandatory = $true)][string]$Result,
  [string]$Service = 'dvpnd',
  # The app's bin folder; its v2ray\, xray\ and hysteria2\ subfolders go on the SERVICE's own PATH only
  [string]$BinRoot = ''
)
$ErrorActionPreference = 'Stop'

function Write-Result([string]$status, [string]$detail) {
  $json = @{ status = $status; detail = $detail; at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($Result, $json, (New-Object System.Text.UTF8Encoding($false)))
}

try {
  if (-not (Test-Path -LiteralPath $Dvpnd -PathType Leaf)) { throw "dvpnd not found at $Dvpnd" }
  if ([System.IO.Path]::GetFileName($Dvpnd) -ne 'dvpnd.exe') { throw 'unexpected daemon binary name' }
  if (-not $DaemonHome.StartsWith($env:ProgramData, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'daemon home must be under ProgramData' }

  if (-not (Test-Path -LiteralPath (Join-Path $DaemonHome 'config.toml') -PathType Leaf)) {
    if (-not (Test-Path -LiteralPath (Join-Path $Staging 'config.toml') -PathType Leaf)) { throw "staging home has no config.toml: $Staging" }
    New-Item -ItemType Directory -Force -Path $DaemonHome | Out-Null
    Copy-Item -Path (Join-Path $Staging '*') -Destination $DaemonHome -Recurse -Force
  }
  & (Join-Path $PSScriptRoot 'migrate-daemon-config.ps1') -DaemonHome $DaemonHome | Out-Null
  $keys = Join-Path (Join-Path $DaemonHome 'client') 'keys'
  if (Test-Path -LiteralPath $keys) {
    & icacls $keys /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'could not restrict the device key folder' }
  }

  $svc = Get-Service -Name $Service -ErrorAction SilentlyContinue
  if (-not $svc) {
    $out = & $Dvpnd service install --home $DaemonHome 2>&1
    if ($LASTEXITCODE -ne 0) { throw "service install failed: $out" }
  }
  # Plain automatic start failed on EVERY boot of the GCP VM (3 of 3, 2026-10-21): Windows gave
  # up after 45 s waiting for the unsigned dvpnd.exe to connect (event 7009) while the rest of
  # boot was still loading, and the restart actions do not cover a start timeout, so the VPN
  # service stayed off until someone started it. Delayed start (about 2 min after boot) came
  # up on its own (UPSTREAM-GAPS the Android app; still to measure: a persisted kill switch during those
  # ~2 min). Also restart on any non-crash failure.
  & sc.exe config $Service start= delayed-auto | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'could not set the service to delayed automatic start' }
  & sc.exe failureflag $Service 1 | Out-Null
  & (Join-Path $PSScriptRoot 'service-user-start.ps1') -Service $Service
  # dvpnd looks up v2ray/xray on PATH. A per-service Environment value scopes that to this
  # service; the machine PATH is left alone. Restart so a running service picks it up.
  $dirs = @()
  if ($BinRoot) { $dirs = @('v2ray', 'xray', 'hysteria2' | ForEach-Object { Join-Path $BinRoot $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Container }) }
  if ($dirs.Count -gt 0) {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $svcKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$Service"
    New-ItemProperty -Path $svcKey -Name Environment -PropertyType MultiString -Value @("PATH=$machinePath;$($dirs -join ';')") -Force | Out-Null
    if ((Get-Service -Name $Service).Status -eq 'Running') { Restart-Service -Name $Service -Force }
  }
  if ((Get-Service -Name $Service).Status -ne 'Running') {
    Start-Service -Name $Service
    (Get-Service -Name $Service).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
  }
  if (Test-Path -LiteralPath $Staging) { Remove-Item -LiteralPath $Staging -Recurse -Force }
  Write-Result 'ok' 'service installed and running'
  exit 0
} catch {
  Write-Result 'error' $_.Exception.Message
  exit 1
}
