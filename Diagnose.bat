@echo off
setlocal
title Codex Filter Manager - Diagnostics
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\windows\start.ps1" -Action Diagnose -Console %*
set "FILTER_EXIT=%errorlevel%"
echo.
pause
exit /b %FILTER_EXIT%
