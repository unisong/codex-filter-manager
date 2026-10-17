@echo off
setlocal
title Codex History Filter - Read-only Diagnostics
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0tools\diagnose.ps1" %*
set "DIAG_EXIT=%errorlevel%"
echo.
pause
exit /b %DIAG_EXIT%
