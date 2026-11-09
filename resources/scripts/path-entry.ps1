# --- path-entry - add or remove one folder on the machine PATH ---
# Run elevated by the installer (add) and uninstaller (remove) so `devnet-dvpn`
# works in any new terminal. Reads and writes the raw registry value, so
# %VARIABLES% other entries use stay unexpanded. Exact-match, case-insensitive.
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$key = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
$reg = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($key, $true)
try {
  $raw = [string]$reg.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $want = $Dir.TrimEnd('\')
  $parts = @($raw -split ';' | Where-Object { $_ -ne '' })
  $kept = @($parts | Where-Object { $_.TrimEnd('\') -ine $want })
  if ($Remove) {
    if ($kept.Count -eq $parts.Count) { Write-Output 'PATH: entry not present'; exit 0 }
    $next = $kept
  } else {
    if ($kept.Count -ne $parts.Count) { Write-Output 'PATH: entry already present'; exit 0 }
    $next = $parts + $want
  }
  $reg.SetValue('Path', ($next -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
  Write-Output ('PATH: {0} {1}' -f $(if ($Remove) { 'removed' } else { 'added' }), $want)
} catch {
  Write-Output "PATH update failed: $($_.Exception.Message)"
  exit 1
} finally {
  $reg.Close()
}
exit 0
