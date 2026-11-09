# --- install-deps - put every system driver the VPN protocols need on this PC ---
# Run by the installer (build/installer.nsh), elevated, and again by the app's
# Diagnostics -> "Repair drivers". Safe to run any number of times.
#   WireGuard for Windows  -> WireGuard + its tunnel driver
#   AmneziaWG for Windows  -> AmneziaWG
#   OpenVPN Community 2.6  -> OpenVPN + Wintun adapter "OpenVPN Wintun" (2.7 removed Wintun: UPSTREAM-GAPS #21)
# Each bundled MSI is checked against deps.json (SHA-256 + Authenticode signer)
# before it runs. An app already installed is left alone, never downgraded.
# Result: %ProgramData%\Devnet dVPN\install-deps.json (read by the app's doctor).
# Exit 0 = everything ready, 2 = something is missing (the app says what and offers repair).
param(
  [string]$DepsDir = (Join-Path $PSScriptRoot '..\deps'),
  [string]$OutDir = (Join-Path $env:ProgramData 'Devnet dVPN'),
  [switch]$CheckOnly,  # report only, install nothing (the app's doctor; no admin needed)
  [string]$Result = '' # the app's elevated runner (src/main/system/elevate.ts) reads this back
)
$ErrorActionPreference = 'Stop'

# A PowerShell 7 parent leaks its module path into 5.1 and breaks cmdlet autoload.
$env:PSModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop

$outDir = $OutDir
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$log = Join-Path $outDir 'install-deps.log'
function Note([string]$m) {
  $line = '{0} {1}' -f (Get-Date).ToString('o'), $m
  [System.IO.File]::AppendAllText($log, "$line`r`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Output $m
}

$results = New-Object System.Collections.ArrayList
$rebootRequired = $false
function Add-Result($name, $wanted, $found, $status, $detail) {
  [void]$results.Add([ordered]@{ name = $name; wanted = $wanted; found = $found; status = $status; detail = $detail })
  Note ('{0}: {1}{2}' -f $name, $status, $(if ($detail) { " ($detail)" } else { '' }))
}

function Get-FileSha256([string]$path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $fs = [System.IO.File]::OpenRead($path)
  try { return ([System.BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '').ToLowerInvariant() }
  finally { $fs.Dispose(); $sha.Dispose() }
}

function Test-Package($dep) {
  $msi = Join-Path $DepsDir $dep.file
  if (-not (Test-Path -LiteralPath $msi)) { return "bundled installer missing: $($dep.file)" }
  $got = Get-FileSha256 $msi
  if ($got -ne $dep.sha256) { return "checksum mismatch (got $got)" }
  $sig = Get-AuthenticodeSignature -LiteralPath $msi
  if ($sig.Status -ne 'Valid') { return "signature $($sig.Status)" }
  if ($sig.SignerCertificate.Subject -notlike "*$($dep.signer)*") { return "unexpected signer: $($sig.SignerCertificate.Subject)" }
  return $null
}

function Install-Msi($dep, [string[]]$props) {
  $msi = Join-Path $DepsDir $dep.file
  $msiLog = Join-Path $outDir "msi-$($dep.name).log"
  $argv = @('/i', "`"$msi`"", '/qn', '/norestart', '/l*v', "`"$msiLog`"") + $props
  $p = Start-Process -FilePath msiexec.exe -ArgumentList $argv -Wait -PassThru
  if ($p.ExitCode -eq 3010 -or $p.ExitCode -eq 1641) { $script:rebootRequired = $true; return 0 }
  return $p.ExitCode
}

function Get-OpenVpnVersion([string]$exe) {
  try {
    $first = (& $exe --version 2>&1 | Select-Object -First 1 | Out-String).Trim()
    if ($first -match 'OpenVPN (\d+)\.(\d+)\.(\d+)') { return [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])" }
  } catch {
    Note "openvpn --version failed: $($_.Exception.Message)"
  }
  return $null
}

# --- preflight ---
Note "install-deps start (deps: $DepsDir)"
if (-not [Environment]::Is64BitOperatingSystem) {
  Add-Result 'windows' 'x64' 'x86' 'failed' 'Devnet dVPN needs 64-bit Windows'
}
$manifestPath = Join-Path $DepsDir 'deps.json'
$manifest = @()
if (Test-Path -LiteralPath $manifestPath) {
  $manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
} else {
  Add-Result 'deps.json' '' '' 'failed' "manifest missing at $manifestPath"
}
$byName = @{}
foreach ($d in $manifest) { $byName[$d.name] = $d }
# The 64-bit Program Files, even if a 32-bit host started this script.
$pf = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }

# --- WireGuard + AmneziaWG ---
foreach ($spec in @(
    @{ name = 'wireguard'; exe = "$pf\WireGuard\wireguard.exe"; manager = 'WireGuardManager' },
    @{ name = 'amneziawg'; exe = "$pf\AmneziaWG\amneziawg.exe"; manager = 'AmneziaWGManager' }
  )) {
  $dep = $byName[$spec.name]
  if (-not $dep) { continue }
  $ver = $null
  if (Test-Path -LiteralPath $spec.exe) {
    $ver = (Get-Item -LiteralPath $spec.exe).VersionInfo.ProductVersion
    $older = $false
    try { $older = ([version]$ver -lt [version]$dep.version) } catch { Note "$($spec.name): unreadable version '$ver'" }
    if (-not $older) { Add-Result $spec.name $dep.version $ver 'present' ''; continue }
    # Upgrade an older copy, but never under a running tunnel (it would drop that connection).
    $prefix = if ($spec.name -eq 'wireguard') { 'WireGuardTunnel$*' } else { 'AmneziaWGTunnel$*' }
    $live = @(Get-Service | Where-Object { $_.Name -like $prefix -and $_.Status -eq 'Running' })
    if ($live.Count -gt 0) {
      Add-Result $spec.name $dep.version $ver 'present' "older than bundled; upgrade skipped while $($live.Count) tunnel(s) run"
      continue
    }
  }
  $bad = Test-Package $dep
  if ($bad) { Add-Result $spec.name $dep.version '' 'failed' $bad; continue }
  if ($CheckOnly) {
    if ($ver) { Add-Result $spec.name $dep.version $ver 'present' 'older than bundled; repair upgrades it' }
    else { Add-Result $spec.name $dep.version '' 'missing' '' }
    continue
  }
  $code = Install-Msi $dep @('DO_NOT_LAUNCH=1')
  if ($code -ne 0 -or -not (Test-Path -LiteralPath $spec.exe)) {
    # A failed upgrade leaves the old copy working: report it, don't fail the install.
    if ($ver -and (Test-Path -LiteralPath $spec.exe)) { Add-Result $spec.name $dep.version $ver 'present' "upgrade failed (msiexec exit $code)" }
    else { Add-Result $spec.name $dep.version '' 'failed' "msiexec exit $code" }
    continue
  }
  # The GUI's manager service is not needed: dvpnd drives tunnels itself.
  $mgr = Get-Service -Name $spec.manager -ErrorAction SilentlyContinue
  if ($mgr -and $mgr.Status -eq 'Running') { Stop-Service -Name $spec.manager -Force -ErrorAction Continue }
  Add-Result $spec.name $dep.version $dep.version $(if ($ver) { 'upgraded' } else { 'installed' }) $(if ($ver) { "from $ver" } else { '' })
}

# --- OpenVPN 2.6 + Wintun adapter ---
$ovpn = $byName['openvpn']
if ($ovpn) {
  $exe = "$pf\OpenVPN\bin\openvpn.exe"
  $ok = $false
  if (Test-Path -LiteralPath $exe) {
    $v = Get-OpenVpnVersion $exe
    if ($v -and $v -ge [version]'2.7.0') {
      Add-Result 'openvpn' $ovpn.version "$v" 'incompatible' 'OpenVPN 2.7 removed Wintun; uninstall it, then Diagnostics -> Repair drivers installs 2.6'
    } else {
      Add-Result 'openvpn' $ovpn.version "$v" 'present' ''
      $ok = $true
    }
  } else {
    $bad = Test-Package $ovpn
    if ($bad) { Add-Result 'openvpn' $ovpn.version '' 'failed' $bad }
    elseif ($CheckOnly) { Add-Result 'openvpn' $ovpn.version '' 'missing' '' }
    else {
      $code = Install-Msi $ovpn @()
      if ($code -eq 0 -and (Test-Path -LiteralPath $exe)) { Add-Result 'openvpn' $ovpn.version $ovpn.version 'installed' ''; $ok = $true }
      else { Add-Result 'openvpn' $ovpn.version '' 'failed' "msiexec exit $code" }
    }
  }
  if ($ok) {
    $tapctl = "$pf\OpenVPN\bin\tapctl.exe"
    if (-not (Test-Path -LiteralPath $tapctl)) {
      Add-Result 'openvpn-wintun' 'OpenVPN Wintun' '' 'failed' 'tapctl.exe missing'
    } else {
      $list = (& $tapctl list 2>&1 | Out-String)
      if ($list -match 'OpenVPN Wintun') {
        Add-Result 'openvpn-wintun' 'OpenVPN Wintun' 'OpenVPN Wintun' 'present' ''
      } elseif ($CheckOnly) {
        Add-Result 'openvpn-wintun' 'OpenVPN Wintun' '' 'missing' ''
      } else {
        $made = (& $tapctl create --hwid wintun --name 'OpenVPN Wintun' 2>&1 | Out-String).Trim()
        if ((& $tapctl list 2>&1 | Out-String) -match 'OpenVPN Wintun') {
          Add-Result 'openvpn-wintun' 'OpenVPN Wintun' 'OpenVPN Wintun' 'installed' ''
        } else {
          Add-Result 'openvpn-wintun' 'OpenVPN Wintun' '' 'failed' "tapctl: $made"
        }
      }
    }
  }
}

# --- result ---
$failed = @($results | Where-Object { $_.status -in 'failed', 'incompatible', 'missing' })
$report = [ordered]@{
  schema = 1
  at = (Get-Date).ToUniversalTime().ToString('o')
  ok = ($failed.Count -eq 0)
  rebootRequired = $rebootRequired
  deps = $results
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $outDir 'install-deps.json'), ($report | ConvertTo-Json -Depth 5), $utf8)
if ($Result) {
  $summary = [ordered]@{ status = $(if ($report.ok) { 'ok' } else { 'error' }); detail = (($failed | ForEach-Object { "$($_.name): $($_.detail)" }) -join '; '); report = $report }
  [System.IO.File]::WriteAllText($Result, ($summary | ConvertTo-Json -Depth 6 -Compress), $utf8)
}
Note ("install-deps done: {0} ({1} problem(s))" -f $(if ($report.ok) { 'ready' } else { 'partial' }), $failed.Count)
if ($report.ok) { exit 0 } else { exit 2 }
