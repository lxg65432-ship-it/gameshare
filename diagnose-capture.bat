@echo off
rem ===================================================================
rem  GameShare - window capture diagnostic.
rem
rem  Use this when a window that IS running does not show up in the
rem  capture list ("sometimes it is there, sometimes it is not").
rem
rem    1 = compare : does the enumeration depend on its parameters?
rem    2 = watch   : keep enumerating once a second and log the exact
rem                  moment a window drops out (recommended -- start it,
rem                  then go reproduce the failure)
rem
rem  ASCII only on purpose: a .bat is read using the console codepage
rem  and this repo path contains non-ASCII characters.
rem ===================================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem --- Resolve node.exe: GAMESHARE_NODE_DIR override first, then PATH. ---
set "NODE_EXE="
if defined GAMESHARE_NODE_DIR if exist "%GAMESHARE_NODE_DIR%\node.exe" set "NODE_EXE=%GAMESHARE_NODE_DIR%\node.exe"
if not defined NODE_EXE (
  for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
)
if not defined NODE_EXE goto :nonode

echo ============================================================
echo   Window capture diagnostic
echo ============================================================
echo.
echo   1  Compare   : run the enumeration with different parameter
echo                 sets, see if the window list changes
echo   2  Watch     : enumerate once per second and log the exact
echo                  moment a window disappears (reproduce the
echo                  problem while this runs)
echo.
set "MODE="
set /p "MODE=Pick 1 or 2, then Enter (plain Enter = 2): "

if "%MODE%"=="1" (
  "%NODE_EXE%" scripts\run-electron.cjs scripts\diag-window-enum.cjs
) else (
  set "DIAG_MODE=watch"
  "%NODE_EXE%" scripts\run-electron.cjs scripts\diag-window-enum.cjs
)

echo.
echo ---- Done. Copy the whole output above. ----
pause
exit /b 0

:nonode
echo.
echo [X] node.exe was not found.
echo     Install Node.js 20+ from https://nodejs.org, or set the
echo     GAMESHARE_NODE_DIR environment variable to the folder that
echo     contains node.exe, then run this again.
echo.
pause
exit /b 1
