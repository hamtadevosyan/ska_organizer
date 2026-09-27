@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem Keep startup errors visible even when PowerShell cannot load pilot-menu.ps1.
powershell.exe -NoProfile -File "%~dp0pilot-menu.ps1" -Action "%~1" -Elevated
set "SKAO_ADMIN_EXIT=%errorlevel%"
echo.
echo Command exit code: %SKAO_ADMIN_EXIT%. Read the result above.
rem Read a line: unlike pause, this also waits when standard input is a pipe.
set "SKAO_ADMIN_ACK="
set /p "SKAO_ADMIN_ACK=Press Enter to close this window... "
exit /b %SKAO_ADMIN_EXIT%
