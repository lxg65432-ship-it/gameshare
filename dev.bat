@echo off
rem ===================================================================
rem  GameShare - dev mode: Vite dev server + Electron, straight from
rem  source. Use this when you changed code and do not want to
rem  repackage: edit a file, Vite hot-reloads the UI, and the Electron
rem  main process is rebuilt by dev-electron.mjs on every start.
rem
rem  Close the Electron window (or press Ctrl+C here) to stop.
rem ===================================================================
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if not errorlevel 1 (
  call npm run dev -w @game-share/desktop
  goto :done
)

rem Fallback: npm missing from PATH (or intercepted by a shell shim).
rem Resolve a Node install: GAMESHARE_NODE_DIR override first, then PATH.
set "ND="
if defined GAMESHARE_NODE_DIR if exist "%GAMESHARE_NODE_DIR%\node.exe" set "ND=%GAMESHARE_NODE_DIR%\"
if not defined ND (
  for /f "delims=" %%N in ('where node 2^>nul') do if not defined ND set "ND=%%~dpN"
)
if defined ND if exist "%ND%node_modules\npm\bin\npm-cli.js" (
  echo npm not on PATH - using npm-cli.js from %ND%
  "%ND%node.exe" "%ND%node_modules\npm\bin\npm-cli.js" run dev -w @game-share/desktop
  goto :done
)

echo.
echo [X] npm was not found and no Node.js fallback worked.
echo     Install Node.js 20+ from https://nodejs.org (that also provides
echo     npm), or set the GAMESHARE_NODE_DIR environment variable to the
echo     folder containing node.exe, then run this again.
echo.
pause
exit /b 1

:done
if errorlevel 1 (
  echo.
  echo [!] Dev mode exited with an error. Scroll up for the first red line.
  pause
)
exit /b 0
