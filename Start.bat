@echo off
setlocal
title Codex Filter Manager
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\windows\start.ps1" -Action Start -Console
if errorlevel 1 (
  echo.
  echo Startup failed. Please read the error above.
  pause
  exit /b 1
)
