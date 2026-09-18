@echo off
rem ===================================================================
rem  GameShare - one-click packaging.
rem
rem  Identical to running "npm run build:exe" in the repo root:
rem  builds the Electron main process (esbuild), then the renderer
rem  (vite), then packs everything with electron-builder.
rem
rem  Produces, under apps\desktop\release\ :
rem      win-unpacked\GameShare.exe        <- what run.bat launches
rem      GameShare Setup 1.0.0.exe         <- installer, send this out
rem
rem  Takes about 40 seconds.
rem  Close any running GameShare window first. If a leftover file
rem  handle still holds release\win-unpacked\resources\app.asar, the
rem  packager shifts to release-2\, release-3\ ... - that is not fatal,
rem  but then the installer and the unpacked exe live in different
rem  folders, which is confusing when you hand one of them out.
rem
rem  ASCII only on purpose. This project path contains non-ASCII
rem  characters and a .bat is read using the console codepage, so a
rem  non-ASCII literal here could get garbled. Paths are derived from
rem  %~dp0 at runtime instead of being written out.
rem ===================================================================
setlocal
cd /d "%~dp0"

set "T0=%TIME%"

echo.
echo ==============================================================
echo   GameShare - packaging (same as: npm run build:exe)
echo ==============================================================
echo.

where npm >nul 2>nul
if errorlevel 1 goto :nonpm
echo Using npm on PATH.
call npm run build:exe
goto :report

:nonpm
rem Fallback: npm missing or intercepted. build:exe is a plain node entry
rem point, so resolve node.exe: GAMESHARE_NODE_DIR override first, then PATH.
set "NODE_EXE="
if defined GAMESHARE_NODE_DIR if exist "%GAMESHARE_NODE_DIR%\node.exe" set "NODE_EXE=%GAMESHARE_NODE_DIR%\node.exe"
if not defined NODE_EXE (
  for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
)
if not defined NODE_EXE goto :nonode
echo npm not on PATH - using node: %NODE_EXE%
"%NODE_EXE%" scripts\build-exe.mjs
goto :report

:nonode
echo.
echo [X] Neither npm on PATH nor a resolvable node.exe.
echo     Install Node.js 20+ from https://nodejs.org, or set the
echo     GAMESHARE_NODE_DIR environment variable to the folder that
echo     contains node.exe, then run this again.
echo.
pause
exit /b 1

:report
rem Read the exit code before anything else can overwrite it.
set "RC=%errorlevel%"
set "T1=%TIME%"
if not "%RC%"=="0" goto :failed

echo.
echo ==============================================================
echo   Packaging finished OK.
echo   started %T0%   ended %T1%
echo ==============================================================
echo.
call :newest
echo.
echo   run.bat launches the newest build listed above.
echo.
pause
exit /b 0

:failed
echo.
echo ==============================================================
echo   Packaging FAILED  (exit code %RC%)
echo ==============================================================
echo.
echo   Scroll up to the first error line. The log above is the only
echo   useful clue - do not close this window before reading it.
echo.
pause
exit /b 1

rem ---- print the newest win-unpacked build and the newest installer ----
:newest
rem Same rule as run.bat: pick by the EXE timestamp, not the directory's.
rem release/ is the delivery folder and its mtime moves when the installer name
rem changes - ordering by directory would then point at a stale win-unpacked.
set "REL="
set "RELT="
for /f "delims=" %%D in ('dir /b /ad "apps\desktop\release*" 2^>nul') do call :newestOne "apps\desktop\%%D"
if defined REL (
  echo   client     %REL%\win-unpacked\GameShare.exe
) else (
  echo   [X] No win-unpacked\GameShare.exe found anywhere under release*
)
set "SETUP="
for /f "delims=" %%F in ('dir /b /o-d "apps\desktop\release\GameShare Setup *.exe" 2^>nul') do if not defined SETUP set "SETUP=%%F"
if defined SETUP (
  echo   installer  apps\desktop\release\%SETUP%
) else (
  echo   [X] No installer found in apps\desktop\release\
)
goto :eof

:newestOne
if not exist "%~1\win-unpacked\GameShare.exe" goto :eof
for %%F in ("%~1\win-unpacked\GameShare.exe") do set "NEWT=%%~tF"
if not defined RELT (
  set "REL=%~1"
  set "RELT=%NEWT%"
  goto :eof
)
if "%NEWT%" GTR "%RELT%" (
  set "REL=%~1"
  set "RELT=%NEWT%"
)
goto :eof
