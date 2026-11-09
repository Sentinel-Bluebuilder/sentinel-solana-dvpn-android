@echo off
rem Devnet dVPN command line. The installer puts this folder on the machine PATH.
rem Runs the bundled CLI with the app's own Node runtime (same pattern as VS Code's code.cmd).
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\Devnet dVPN.exe" "%~dp0..\resources\app.asar\out\cli\devnet-dvpn.cjs" %*
exit /b %ERRORLEVEL%
