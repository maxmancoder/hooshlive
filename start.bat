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
REM   1) Requires Node.js (v22+ recommended).
REM   2) Requires dependencies installed: run "npm install" (installs pg).
REM   3) Requires PostgreSQL connection via environment variables:
REM        - DATABASE_URL (required), e.g.
REM          postgres://USER:PASSWORD@HOST:PORT/DBNAME?sslmode=require
REM        - DATABASE_CA_CERT (optional but recommended for Aiven), the CA
REM          certificate PEM contents if your provider requires it.
REM   4) Sets default PORT=3000 unless already set in environment.
REM   5) Opens http://localhost:%PORT% in the default browser shortly after start.
REM   6) Runs the server in this window: node server.js
REM      - Keep this window open while using the site.
REM      - Press Ctrl+C to stop the server.
REM
REM Data/storage:
REM   - News, sources, and folders are stored in PostgreSQL (Aiven/external DB).
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

if "%DATABASE_URL%"=="" (
  echo [hooshlive] ERROR: DATABASE_URL environment variable is not set.
  echo.
  echo Set DATABASE_URL to your PostgreSQL connection string, for example:
  echo   set DATABASE_URL=postgres://user:pass@host:port/dbname?sslmode=require
  echo Optionally set DATABASE_CA_CERT if your provider requires a CA certificate.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\pg" (
  echo [hooshlive] Dependency "pg" not found. Running npm install...
  call npm install
  if errorlevel 1 (
    echo.
    echo [hooshlive] ERROR: npm install failed.
    pause
    exit /b 1
  )
)

if "%PORT%"=="" set "PORT=3000"

echo [hooshlive] Starting hooshlive...
echo [hooshlive] Project folder: %CD%
echo [hooshlive] URL: http://localhost:%PORT%
echo [hooshlive] Database: PostgreSQL (via DATABASE_URL)
echo.
echo [hooshlive] The browser will open automatically in a few seconds.
echo [hooshlive] Keep this window open. Press Ctrl+C to stop the server.
echo.

REM Open browser after a short delay (server needs a moment to start)
start "" cmd /c "timeout /t 2 /nobreak >nul && start "" http://localhost:%PORT%""

node server.js

if errorlevel 1 (
  echo.
  echo [hooshlive] Server exited with an error.
  echo Check the messages above for details.
  pause
)

endlocal
