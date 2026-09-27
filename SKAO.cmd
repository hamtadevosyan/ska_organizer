@echo off
setlocal
powershell.exe -NoProfile -File "%~dp0scripts\pilot-menu.ps1" %*
exit /b %errorlevel%
