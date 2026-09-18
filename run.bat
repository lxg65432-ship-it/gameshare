@echo off
rem ===================================================================
rem  GameShare - launcher for the newest packaged build.
rem
rem  Double-click this file. Nothing is built, nothing is installed:
rem  it just finds the most recent win-unpacked\GameShare.exe under
rem  apps\desktop\release* and starts it.
rem
rem  ASCII only on purpose. This project path contains non-ASCII
rem  characters and a .bat is read using the console codepage, so a
rem  non-ASCII literal here could get garbled. Paths are derived from
rem  %~dp0 at runtime instead of being written out.
rem ===================================================================
setlocal
cd /d "%~dp0"

rem Pick by the **exe's own mtime**, NOT by the release* directory mtime.
rem
rem Directory mtime has a nasty trap: release/ is the delivery folder, and the
rem packaging script copies the installer into it every time. The moment the
rem installer gets a new filename (version bump), release/ itself becomes the
rem newest directory - and run.bat would launch the PREVIOUS exe sitting in
rem release/win-unpacked/, looking perfectly normal while running old code.
rem
rem Relies on the file timestamp giving a lexically sortable "YYYY/MM/DD HH:MM"
rem (24-hour) string.
set "REL="
set "RELT="
for /f "delims=" %%D in ('dir /b /ad "apps\desktop\release*" 2^>nul') do call :consider "apps\desktop\%%D\win-unpacked\GameShare.exe"

if not defined REL (
  echo.
  echo [X] No packaged build found under apps\desktop\release*\
  echo.
  echo     Rebuild it first:   npm run build:exe
  echo     Or start from source without packaging:   dev.bat
  echo.
  pause
  exit /b 1
)

echo Launching %REL%
start "" "%~dp0%REL%"
exit /b 0

rem ---- keep whichever candidate has the newer exe -------------------------
rem A file timestamp here looks like "2026/09/18/Fri 10:19" on this machine.
rem Same day => the weekday part is identical, so the comparison falls through
rem to the time; different day => the date decides. Both orders are correct.
:consider
if not exist %1 exit /b 0
for %%F in (%1) do set "NEWT=%%~tF"
if not defined RELT (
  set "REL=%~1"
  set "RELT=%NEWT%"
  exit /b 0
)
if "%NEWT%" GTR "%RELT%" (
  set "REL=%~1"
  set "RELT=%NEWT%"
)
exit /b 0
