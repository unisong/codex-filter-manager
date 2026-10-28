@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\open.ps1"
if errorlevel 1 pause
