@echo off
setlocal
title Codex Filter Manager - Stop
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\windows\start.ps1" -Action Stop -Console
set "FILTER_EXIT=%errorlevel%"
echo.
pause
exit /b %FILTER_EXIT%
