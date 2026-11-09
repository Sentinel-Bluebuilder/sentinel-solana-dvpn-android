# Run by the uninstaller (build/installer.nsh), elevated. Leaves the computer's
# networking exactly as it was before the app:
#   1. puts back the user's own system proxy if ours is still set
#   2. stops the dvpnd service gracefully (a clean stop ends the session and
#      releases kill-switch rules and DNS), then removes the service
# The device key folder in ProgramData is kept: it holds the device's on-chain
# permission and SOL, and a reinstall picks it up again.
param(
  [Parameter(Mandatory = $true)][string]$Dvpnd,
  [string]$AppDataDir = (Join-Path $env:APPDATA 'Devnet dVPN')
)
$ErrorActionPreference = 'Continue'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'

# --- 1. system proxy ---
$backup = Join-Path $AppDataDir 'proxy-backup.json'
if (Test-Path -LiteralPath $backup) {
  try {
    $saved = Get-Content -LiteralPath $backup -Raw | ConvertFrom-Json
    # Same helper as the app (WinINET per-connection options; browsers read those).
    $helper = Join-Path $PSScriptRoot 'sysproxy.ps1'
    if (Test-Path -LiteralPath $helper) {
      $now = (& $helper -Mode query | Select-Object -Last 1) | ConvertFrom-Json
      if ($now.server -eq $saved.ours -and ($now.flags -band 2)) {
        $st = if ($saved.state) { $saved.state } else { [ordered]@{ flags = $(if ([int]$saved.proxyEnable) { 3 } else { 1 }); server = [string]$saved.proxyServer; bypass = ''; pac = '' } }
        $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(($st | ConvertTo-Json -Compress)))
        & $helper -Mode set -Json $b64 | Out-Null
        Write-Output 'system proxy restored'
      }
    } else {
      # Older install without the helper: registry values only.
      $now = (Get-ItemProperty -Path $key -Name ProxyServer -ErrorAction SilentlyContinue).ProxyServer
      if ($now -eq $saved.ours) {
        Set-ItemProperty -Path $key -Name ProxyEnable -Value ([int]$saved.proxyEnable) -Type DWord
        if ($saved.proxyServer) { Set-ItemProperty -Path $key -Name ProxyServer -Value $saved.proxyServer }
        else { Remove-ItemProperty -Path $key -Name ProxyServer -ErrorAction SilentlyContinue }
        Write-Output 'system proxy restored (registry)'
      }
    }
    Remove-Item -LiteralPath $backup -Force
  } catch {
    Write-Output "proxy restore failed: $($_.Exception.Message)"
  }
}

# --- 2. VPN service ---
$svc = Get-Service -Name 'dvpnd' -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
  Stop-Service -Name 'dvpnd' -ErrorAction SilentlyContinue
  try { (Get-Service -Name 'dvpnd').WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) } catch { Write-Output "service did not stop in 30 s: $($_.Exception.Message)" }
}
# Always run it, even with no service left: a persist kill switch outlives the service by
# design, and `service uninstall` is what releases it (otherwise the PC stays offline).
if (Test-Path -LiteralPath $Dvpnd) {
  & $Dvpnd service uninstall 2>&1 | Write-Output
} elseif ($svc) {
  & sc.exe delete dvpnd | Write-Output
}

# --- 3. tunnels the service may have left (a killed daemon, a crash) ---
# Only ours (dvpn-*): a user's own WireGuard/AmneziaWG tunnels are never touched.
$pf = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
Get-Service | Where-Object { $_.Name -like 'WireGuardTunnel$dvpn-*' -or $_.Name -like 'AmneziaWGTunnel$dvpn-*' } | ForEach-Object {
  $tunnel = $_.Name.Split('$')[1]
  $exe = if ($_.Name -like 'WireGuard*') { "$pf\WireGuard\wireguard.exe" } else { "$pf\AmneziaWG\amneziawg.exe" }
  if (Test-Path -LiteralPath $exe) { & $exe /uninstalltunnelservice $tunnel; Start-Sleep -Seconds 2 }
  if (Get-Service -Name $_.Name -ErrorAction SilentlyContinue) {
    Stop-Service -Name $_.Name -Force -ErrorAction Continue
    & sc.exe delete $_.Name | Out-Null
  }
  Write-Output "tunnel service removed: $($_.Name)"
}
foreach ($name in 'hysteria2', 'v2ray', 'xray', 'pipe-bridge') {
  # Only copies run from the app's own folder; a user's own copies are left alone.
  Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\Devnet dVPN\*' } | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction Continue
    Write-Output "stopped $name pid $($_.Id)"
  }
}

# --- 4. firewall rules the Hysteria2 client adds for itself ("sing-tun (<path>)", inbound allow) ---
# Only rules naming the app's own folder (UPSTREAM-GAPS the Windows app).
Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'sing-tun (*\Devnet dVPN\*' } | ForEach-Object {
  Remove-NetFirewallRule -Name $_.Name -ErrorAction Continue
  Write-Output "firewall rule removed: $($_.DisplayName)"
}
exit 0
