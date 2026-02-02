@echo off
setlocal enabledelayedexpansion

REM Build the Vite site into /docs for GitHub Pages.
cd /d "%~dp0"

set "DEFAULT_REPO=Micro-bit-Dashboard"
set /p REPO_NAME=Enter GitHub repo name [%DEFAULT_REPO%]: 
if "%REPO_NAME%"=="" set "REPO_NAME=%DEFAULT_REPO%"

echo.
echo Using repo name: %REPO_NAME%
echo Setting VITE_BASE=/%REPO_NAME%/
echo.

if not exist node_modules (
  echo Installing dependencies...
  npm install
  if errorlevel 1 goto :fail
)

set "VITE_BASE=/%REPO_NAME%/"
npm run build
if errorlevel 1 goto :fail

if not exist docs (
  echo Build output not found.
  goto :fail
)

REM Prevent Jekyll processing on GitHub Pages.
type nul > docs\.nojekyll

REM SPA fallback (safe even without routing).
copy /y docs\index.html docs\404.html >nul

echo.
echo Starting Vite dev server in a new window...
start "Vite Dev Server" cmd /k "npm run dev"

echo.
echo Done. Commit and push the /docs folder, then enable GitHub Pages:
echo Settings ^> Pages ^> Deploy from a branch ^> main ^> /docs
echo.
pause

:fail
echo.
echo Build failed.
pause
