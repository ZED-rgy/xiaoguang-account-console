@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-installed.ps1" -FallbackToDevelopment
if errorlevel 1 pause
