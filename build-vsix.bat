@echo off
REM chcp 65001 >nul   -- keep default codepage to avoid UTF-8 BOM issues on older Windows
setlocal enabledelayedexpansion

REM ============================================================
REM build-vsix.bat
REM Build keil-vscode-assistant and produce a .vsix installer.
REM Double-click to run, or invoke from a command shell.
REM Set NO_PAUSE=1 before calling to skip the final pause (CI).
REM ============================================================

cd /d "%~dp0"

echo ============================================================
echo  Keil VSCode Assistant - VSIX Build
echo  Working directory: %CD%
echo ============================================================
echo.

REM ---------- 1) Sanity checks ----------
where node >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Node.js not found. Install from https://nodejs.org
    if not defined NO_PAUSE pause
    exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [FAIL] npm.cmd not found. Reinstall Node.js or check PATH.
    if not defined NO_PAUSE pause
    exit /b 1
)

if not exist "package.json" (
    echo [FAIL] package.json not found. Run this script in the project root.
    if not defined NO_PAUSE pause
    exit /b 1
)

echo [1/3] Environment OK
echo.

REM ---------- 2) Production build ----------
echo [2/3] npm run package ...
call npm.cmd run package
if errorlevel 1 (
    echo.
    echo [FAIL] Build failed. See output above.
    if not defined NO_PAUSE pause
    exit /b 1
)
echo.

REM ---------- 3) vsce package ----------
echo [3/3] npx vsce package ...
REM Flags:
REM   --no-yarn                    repo has .yarnrc; avoid yarn when not installed
REM   --allow-missing-repository   skip repository field check
REM   --no-git-tag-version         keep version from package.json
call npx.cmd vsce package --no-yarn --allow-missing-repository --no-git-tag-version
if errorlevel 1 (
    echo.
    echo [FAIL] vsce packaging failed. See output above.
    if not defined NO_PAUSE pause
    exit /b 1
)

REM ---------- Done ----------
echo.
echo ============================================================
echo  DONE
echo  Output directory: %CD%
echo ============================================================

echo.
echo VSIX files (newest first):
dir /b /o-d "*.vsix" 2>nul | findstr /r ".*"

if not defined NO_PAUSE pause
endlocal
exit /b 0
