# Run elevated before an OpenVPN connect when the "OpenVPN Wintun" adapter is gone.
# An AmneziaWG tunnel start removes it (UPSTREAM-GAPS #27); OpenVPN 2.6 cannot start
# without it. Creates only that one adapter with OpenVPN's own tapctl.exe - nothing else
# is touched. ASCII only (PowerShell 5.1).
param([string]$Result)
$ErrorActionPreference = 'Continue'

function Write-Result([string]$status, [string]$detail) {
  if ($Result) {
    $json = @{ status = $status; detail = $detail; at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($Result, $json, (New-Object System.Text.UTF8Encoding($false)))
  }
}

try {
  $tapctl = Join-Path $env:ProgramFiles 'OpenVPN\bin\tapctl.exe'
  if (-not (Test-Path -LiteralPath $tapctl)) { Write-Result 'error' 'OpenVPN is not installed (tapctl.exe missing)'; exit 1 }
  if ((& $tapctl list 2>&1 | Out-String) -match 'OpenVPN Wintun') { Write-Result 'ok' 'already present'; exit 0 }
  $made = (& $tapctl create --hwid wintun --name 'OpenVPN Wintun' 2>&1 | Out-String).Trim()
  if ((& $tapctl list 2>&1 | Out-String) -match 'OpenVPN Wintun') { Write-Result 'ok' 'created'; exit 0 }
  Write-Result 'error' "tapctl: $made"
  exit 1
} catch {
  Write-Result 'error' $_.Exception.Message
  exit 1
}
