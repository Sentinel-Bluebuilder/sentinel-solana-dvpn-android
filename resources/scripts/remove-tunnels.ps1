# Run elevated by "Restore network" (src/main/system/tunnels.ts). Removes WireGuard /
# AmneziaWG tunnel services and hysteria2 / v2ray / xray / openvpn processes that dvpnd left
# running with no session behind them (gaps #29, the Linux app): such a tunnel keeps the default route,
# so every connection goes into it and the computer is offline. Only ours: dvpn-* services,
# processes from the app folder or with dvpnd config; a user's own tunnels are never touched.
# The app calls this only when the daemon has no live session. ASCII only (PowerShell 5.1).
param([string]$Result)
$ErrorActionPreference = 'Continue'

function Write-Result([string]$status, [string]$detail) {
  if ($Result) {
    $json = @{ status = $status; detail = $detail; at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($Result, $json, (New-Object System.Text.UTF8Encoding($false)))
  }
}

try {
  $pf = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
  $removed = @()
  Get-Service | Where-Object { $_.Name -like 'WireGuardTunnel$dvpn-*' -or $_.Name -like 'AmneziaWGTunnel$dvpn-*' } | ForEach-Object {
    $svc = $_.Name
    $tunnel = $svc.Split('$')[1]
    # Through the owning app first: it also removes the adapter and its routes.
    $exe = if ($svc -like 'WireGuard*') { "$pf\WireGuard\wireguard.exe" } else { "$pf\AmneziaWG\amneziawg.exe" }
    if (Test-Path -LiteralPath $exe) { & $exe /uninstalltunnelservice $tunnel; Start-Sleep -Seconds 2 }
    if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
      Stop-Service -Name $svc -Force -ErrorAction Continue
      & sc.exe delete $svc | Out-Null
    }
    $removed += $svc
  }
  # Protocol processes a dead dvpnd left behind (UPSTREAM-GAPS the Linux app): they keep the tunnel and
  # the route. hysteria2 / v2ray / xray only from the app's own folder; openvpn only when its
  # command line points at dvpnd's config (a user's own OpenVPN is never touched).
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    (($_.Name -match '^(hysteria2|v2ray|xray)\.exe$') -and ("$($_.ExecutablePath)" -like '*\Devnet dVPN\*')) -or
    (($_.Name -eq 'openvpn.exe') -and ("$($_.CommandLine)" -like '*\dvpnd\*'))
  })
  foreach ($p in $procs) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Continue
    $removed += "$($p.Name):$($p.ProcessId)"
  }
  if ($procs.Count) { Start-Sleep -Seconds 3 }
  $left = @(Get-Service | Where-Object { $_.Name -like 'WireGuardTunnel$dvpn-*' -or $_.Name -like 'AmneziaWGTunnel$dvpn-*' })
  $left += @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($_.Name -match '^(hysteria2|v2ray|xray)\.exe$') -and ("$($_.ExecutablePath)" -like '*\Devnet dVPN\*') } | ForEach-Object { [pscustomobject]@{ Name = "$($_.Name):$($_.ProcessId)" } })
  if ($left.Count -gt 0) { Write-Result 'error' ("still running: " + (($left | ForEach-Object { $_.Name }) -join ', ')); exit 1 }
  Write-Result 'ok' ($(if ($removed.Count) { 'removed: ' + ($removed -join ', ') } else { 'none left' }))
} catch {
  Write-Result 'error' $_.Exception.Message
  exit 1
}
