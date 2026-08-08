@echo off
REM MONEY node launcher (Windows). Double-click this file to run your node.
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo(
echo   ================================
echo    MONEY  --  starting your node
echo   ================================
echo(

REM 1) Node.js present?
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js is not installed.
  echo(
  echo       MONEY needs Node.js to run. It's free and takes 2 minutes:
  echo         - https://nodejs.org  ^(download the "LTS" version, install, then
  echo           double-click this file again^).
  echo(
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do set NODEVER=%%v
echo   [ok] Node.js found (!NODEVER!)

REM 2) Dependencies installed? (node_modules appears after the first run)
if not exist node_modules (
  echo   ... first run -- installing the two small libraries MONEY needs ^(ws, tweetnacl^)...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo   [X] npm install failed. Please check your internet connection and try again.
    pause
    exit /b 1
  )
  echo   [ok] libraries installed
) else (
  echo   [ok] libraries already installed
)

REM 3) Optional overrides from a .env file (e.g. a different relay). Optional --
REM    the default relay is already baked into swarm\genesis.json.
if exist .env (
  echo   [ok] loading overrides from .env
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    set "line=%%a"
    if not "!line:~0,1!"=="#" if not "%%a"=="" set "%%a=%%b"
  )
)

REM 4) Your wallet lives in identity.json in THIS folder (created on first run).
REM    NODE_LABEL is deliberately left unset so the node uses that persisted wallet.
if not defined IDENTITY_FILE set "IDENTITY_FILE=%cd%\identity.json"
set "NODE_LABEL="

REM 5) Human-readable output. The node would pick this automatically on a console,
REM    but set it explicitly so it stays readable even if you pipe it to a log file.
REM    Set MONEY_JSON=1 instead if you want the raw machine-readable event stream.
if not defined MONEY_JSON set "MONEY_PRETTY=1"

echo(
echo   Starting... your address and balance will appear below.
echo   ---------------------------------------------------------------------------
echo(

node swarm\run_node.js
pause
