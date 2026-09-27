@echo off
setlocal DisableDelayedExpansion
rem Keep startup errors visible even when PowerShell cannot load pilot-menu.ps1.
powershell.exe -NoProfile -File "%~dp0pilot-menu.ps1" -Action "%~1" -Elevated
set "SKAO_ADMIN_EXIT=%errorlevel%"
echo.
echo Command exit code: %SKAO_ADMIN_EXIT%. Read the result above.
pause
exit /b %SKAO_ADMIN_EXIT%
