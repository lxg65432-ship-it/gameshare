@echo off
setlocal
cd /d "%~dp0"

set "CF=%~dp0tools\cloudflared.exe"

if not exist "%CF%" (
  echo.
  echo [X] tools\cloudflared.exe not found.
  echo     Download it by running this command in the repo root:
  echo.
  echo     node scripts\fetch-github-release.mjs https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe tools\cloudflared.exe
  echo.
  pause
  exit /b 1
)

echo.
echo ==============================================================
echo   GameShare - remote test tunnel
echo ==============================================================
echo.
echo   BEFORE starting this, make sure the client is already
echo   running on this computer (double-click run.bat).
echo   The tunnel needs localhost:8080 to be listening.
echo.
echo   After a few seconds you will see a line like this:
echo.
echo       https://something-random-words.trycloudflare.com
echo.
echo   Copy that address and give it to the other computer.
echo   On that PC, paste it into the "signaling server" field.
echo.
echo   NOTE: this address is PUBLIC. Anyone who knows it can
echo         reach the signaling server. Close this window
echo         (or press Ctrl+C) as soon as you are done testing.
echo ==============================================================
echo.

"%CF%" tunnel --no-autoupdate --url http://localhost:8080

echo.
echo Tunnel closed.
pause
