# Let the signed-in user START the dvpnd service (start only: stop, config and delete stay admin).
#
# Why: dvpnd refuses to start until the device has a spending permission (preflight 'grant').
# After an upgrade, or before the first device setup, Windows gives up after its 3 restarts and
# the service stays stopped. The app sets the permission up as the user, then has to start the
# service again; without this right that needed a second admin prompt. Run ELEVATED by the
# installer and by setup-daemon.ps1. Idempotent. ASCII only.
param([string]$Service = 'dvpnd')
$ErrorActionPreference = 'Stop'
if (-not (Get-Service -Name $Service -ErrorAction SilentlyContinue)) { Write-Output "service-user-start: no $Service service"; exit 0 }
$sddl = ((& sc.exe sdshow $Service) | Where-Object { $_ -match '^D:' } | Select-Object -First 1)
if (-not $sddl) { throw "could not read the $Service security descriptor" }
# IU = interactive users. RP = SERVICE_START. Add RP to the IU allow entry; add the entry if absent.
$m = [regex]::Match($sddl, '\(A;;([A-Z]*);;;IU\)')
if ($m.Success) {
  if ($m.Groups[1].Value -match '^(..)*?RP') { Write-Output 'service-user-start: already allowed'; exit 0 }
  $new = $sddl.Replace($m.Value, "(A;;$($m.Groups[1].Value)RP;;;IU)")
} else {
  $at = $sddl.IndexOf('S:'); if ($at -lt 0) { $at = $sddl.Length }
  $new = $sddl.Insert($at, '(A;;CCLCSWRPLOCRRC;;;IU)')
}
$out = (& sc.exe sdset $Service $new 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw "sc sdset failed: $out" }
Write-Output 'service-user-start: interactive users may start the service'
exit 0
