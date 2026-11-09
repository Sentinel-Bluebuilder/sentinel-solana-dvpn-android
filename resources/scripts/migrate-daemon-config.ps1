# Rename dvpnd config keys written by older builds to the names the bundled dvpnd reads.
#
# dvpnd (upstream cf4c372, bundled since 2026-10-21) renamed keys and IGNORES unknown ones, so
# an old `escrow = 5000000` would silently fall back to a 1000 tDVPN deposit and an old
# `dns = 'none'` would let the service change system DNS again. Run ELEVATED by the installer
# (upgrade) and by setup-daemon.ps1. Idempotent: a key is renamed only when its new name is
# not already in the file. Writes UTF-8 without BOM and keeps one .pre-migrate backup.
param(
  # The service home (manager.ts DEFAULT_DAEMON_HOME): it holds config.toml and client\config.toml.
  [string]$DaemonHome = (Join-Path $env:ProgramData 'dvpnd\client')
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $DaemonHome 'config.toml') -PathType Leaf)) {
  Write-Output "migrate-daemon-config: no dvpnd home at $DaemonHome (fresh install), nothing to do"
  exit 0
}

# old key -> new key, per file (key names are unique within each file)
$renames = @{
  'config.toml' = @(
    @('pipe', 'endpoint'),
    @('compute_unit_margin', 'compute_unit_margin_percent'),
    @('loaded_data_limit', 'loaded_data_limit_bytes'),
    @('max_priority_fee', 'max_priority_fee_lamports'),
    @('priority_fee', 'priority_fee_lamports')
  )
  'client\config.toml' = @(
    @('escrow', 'escrow_base_units'),
    @('dns', 'dns_backend')
  )
}

$changed = 0
foreach ($rel in $renames.Keys) {
  $path = Join-Path $DaemonHome $rel
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
  $text = [System.IO.File]::ReadAllText($path)
  $orig = $text
  foreach ($pair in $renames[$rel]) {
    $old = [regex]::Escape($pair[0]); $new = $pair[1]
    if ($text -match "(?m)^\s*$([regex]::Escape($new))\s*=") { continue }
    $text = [regex]::Replace($text, "(?m)^(\s*)$old(\s*=)", "`${1}$new`${2}")
  }
  if ($text -ne $orig) {
    Copy-Item -LiteralPath $path -Destination "$path.pre-migrate" -Force
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
    $changed++
    Write-Output "migrated $path"
  }
}
Write-Output "migrate-daemon-config: $changed file(s) changed"
exit 0
