@echo off
cd /d "%~dp0"

rem Launch the packaged desktop build (Tauri + WebView2).
if exist "dist\FileDock.exe" (
  start "" "dist\FileDock.exe"
  exit /b 0
)
if exist "FileDock.exe" (
  start "" "FileDock.exe"
  exit /b 0
)

echo [FileDock] desktop build not found.
echo [FileDock] Run "npm run dist" to build it, then try again.
pause
exit /b 1
