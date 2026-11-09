; Devnet dVPN - NSIS hooks (electron-builder `nsis.include`). See docs/INSTALLER.md.
; extraResources land at $INSTDIR\resources\resources; the CLI shim at $INSTDIR\bin.
;
; Install (elevated, perMachine):
;   customInit     stop the VPN service if it runs, so an upgrade can replace its files
;   customInstall  install system drivers (WireGuard, AmneziaWG, OpenVPN 2.6), put the CLI
;                  on PATH, start the service again if it was running
; Uninstall (order is electron-builder's: customUnInit -> files deleted -> customUnInstall):
;   customUnInit   stop the service + helper, copy the cleanup scripts out of $INSTDIR
;   customUnInstall (full uninstall only, not an upgrade) restore the network, remove the
;                  service + leftover tunnels, take the CLI off PATH. Shared drivers and the
;                  device key folder in ProgramData are kept on purpose.
; The installer is a 32-bit process: always call the 64-bit PowerShell (sysnative).

!macro ddvFindPowerShell OUT
  ${If} ${FileExists} "$WINDIR\sysnative\WindowsPowerShell\v1.0\powershell.exe"
    StrCpy ${OUT} "$WINDIR\sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${Else}
    StrCpy ${OUT} "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
Var ddvPs
Var ddvServiceWasRunning

!macro customInit
  !insertmacro ddvFindPowerShell $ddvPs
  StrCpy $ddvServiceWasRunning "no"
  nsExec::ExecToStack '"$ddvPs" -NoProfile -NonInteractive -Command "(Get-Service -Name dvpnd -ErrorAction SilentlyContinue).Status"'
  Pop $0
  Pop $1
  StrCpy $1 $1 7
  ${If} $1 == "Running"
    StrCpy $ddvServiceWasRunning "yes"
    ; A clean stop ends the session and releases the kill switch and DNS.
    nsExec::ExecToLog '"$ddvPs" -NoProfile -NonInteractive -Command "Stop-Service -Name dvpnd -Force -ErrorAction SilentlyContinue; (Get-Service -Name dvpnd).WaitForStatus(\"Stopped\", [TimeSpan]::FromSeconds(30))"'
    Pop $0
  ${EndIf}
!macroend

!macro customInstall
  ${If} $ddvPs == ""
    !insertmacro ddvFindPowerShell $ddvPs
  ${EndIf}
  DetailPrint "Installing VPN drivers (WireGuard, AmneziaWG, OpenVPN)..."
  nsExec::ExecToLog '"$ddvPs" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\resources\scripts\install-deps.ps1" -DepsDir "$INSTDIR\resources\resources\deps"'
  Pop $0
  DetailPrint "VPN drivers finished (exit $0)"
  ${If} $0 != "0"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Some VPN drivers could not be installed. Devnet dVPN still works with the protocols that are ready.$\r$\n$\r$\nOpen the app and go to Diagnostics to see what is missing and repair it.$\r$\n$\r$\nDetails: %ProgramData%\Devnet dVPN\install-deps.log" /SD IDOK
  ${EndIf}

  DetailPrint "Adding the devnet-dvpn command to PATH..."
  nsExec::ExecToLog '"$ddvPs" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\resources\scripts\path-entry.ps1" -Dir "$INSTDIR\bin"'
  Pop $0
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; An existing service from an older build: delayed automatic start, restart on any failure
  ; (plain automatic start timed out on every boot; UPSTREAM-GAPS the Android app). No-op without the service.
  nsExec::ExecToLog '"$ddvPs" -NoProfile -NonInteractive -Command "if (Get-Service -Name dvpnd -ErrorAction SilentlyContinue) { sc.exe config dvpnd start= delayed-auto; sc.exe failureflag dvpnd 1 }"'
  Pop $0
  ; Let the signed-in user start the service (it stays stopped until device setup grants spending).
  nsExec::ExecToLog '"$ddvPs" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\resources\scripts\service-user-start.ps1"'
  Pop $0
  ; Config keys renamed by the bundled dvpnd (it ignores unknown keys). No-op on a fresh install.
  DetailPrint "Updating VPN service settings..."
  nsExec::ExecToLog '"$ddvPs" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\resources\scripts\migrate-daemon-config.ps1"'
  Pop $0

  ${If} $ddvServiceWasRunning == "yes"
    DetailPrint "Starting the VPN service again..."
    nsExec::ExecToLog '"$ddvPs" -NoProfile -NonInteractive -Command "Start-Service -Name dvpnd"'
    Pop $0
  ${EndIf}
!macroend
!endif

!ifdef BUILD_UNINSTALLER
Var ddvUnPs

!macro customUnInit
  !insertmacro ddvFindPowerShell $ddvUnPs
  ; Files in use cannot be deleted: stop the service and the app's pipe helper first.
  nsExec::ExecToLog '"$ddvUnPs" -NoProfile -NonInteractive -Command "Stop-Service -Name dvpnd -Force -ErrorAction SilentlyContinue; Stop-Process -Name pipe-bridge -Force -ErrorAction SilentlyContinue"'
  Pop $0
  ; The scripts live in $INSTDIR, which is gone by the time customUnInstall runs.
  InitPluginsDir
  CopyFiles /SILENT "$INSTDIR\resources\resources\scripts\uninstall-cleanup.ps1" "$PLUGINSDIR"
  CopyFiles /SILENT "$INSTDIR\resources\resources\scripts\path-entry.ps1" "$PLUGINSDIR"
  CopyFiles /SILENT "$INSTDIR\resources\resources\scripts\sysproxy.ps1" "$PLUGINSDIR"
  CopyFiles /SILENT "$INSTDIR\resources\resources\bin\dvpnd.exe" "$PLUGINSDIR"
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    DetailPrint "Restoring network settings and removing the VPN service..."
    nsExec::ExecToLog '"$ddvUnPs" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\uninstall-cleanup.ps1" -Dvpnd "$PLUGINSDIR\dvpnd.exe"'
    Pop $0
    DetailPrint "Network cleanup finished (exit $0)"
    nsExec::ExecToLog '"$ddvUnPs" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\path-entry.ps1" -Dir "$INSTDIR\bin" -Remove'
    Pop $0
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend
!endif
