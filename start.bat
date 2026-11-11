@echo off
setlocal EnableExtensions

REM ==========================================================
REM hooshlive - Start Script
REM ==========================================================
REM This file is the single source of truth for running the project.
REM IMPORTANT: Any change in how the project is executed MUST be
REM recorded/updated in this file to avoid run issues.
REM
REM Current run method:
REM   1) Requires Node.js (v22+ recommended, tested with Node 24).
REM      - No npm install is required (uses Node built-in modules:
REM        http, fs, path, url, node:sqlite, fetch).
REM   2) Creates the "data" folder if missing (SQLite DB is stored there).
REM   3) Sets default PORT=3000 unless already set in environment.
REM   4) Opens http://localhost:%PORT% in the default browser shortly after start.
REM   5) Runs the server in this window: node server.js
REM      - Keep this window open while using the site.
REM      - Press Ctrl+C to stop the server.
REM
REM Data/storage:
REM   - SQLite database: .\data\hooshlive.db
REM   - News sources and folders are stored in this database.
REM ==========================================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [hooshlive] ERROR: Node.js is not installed or not in PATH.
  echo.
  echo Please install Node.js ^(LTS recommended^) from: https://nodejs.org/
  echo After installation, close this window and run start.bat again.
  echo.
  pause
  exit /b 1
)

if not exist "data" mkdir "data"

if "%PORT%"=="" set "PORT=3000"

echo [hooshlive] Starting hooshlive...
echo [hooshlive] Project folder: %CD%
echo [hooshlive] URL: http://localhost:%PORT%
echo [hooshlive] Database: %CD%\data\hooshlive.db
echo.
echo [hooshlive] The browser will open automatically in a few seconds.
echo [hooshlive] Keep this window open. Press Ctrl+C to stop the server.
echo.

REM Open browser after a short delay (server needs a moment to start)
start "" cmd /c "timeout /t 2 /nobreak >nul && start "" http://localhost:%PORT%"

node server.js

if errorlevel 1 (
  echo.
  echo [hooshlive] Server exited with an error.
  echo Check the messages above for details.
  pause
)

endlocal
