@echo off
setlocal
set "TASK_NAME=XiaoguangAccountDailyCollection"
set "SCRIPT=%~dp0collect-works.bat"

schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>nul
schtasks /Create /F /SC DAILY /ST 03:00 /TN "%TASK_NAME%" /TR "\"%SCRIPT%\""
if errorlevel 1 (
  echo Failed to register the scheduled task. Try running this script as administrator.
) else (
  echo Registered %TASK_NAME% to run every day at 03:00.
)
pause
