@echo off
setlocal EnableDelayedExpansion

:: web-ext's temporary-directory code requires a regular Windows path.
if "%TEMP:~0,4%"=="\\?\" set "TEMP=%TEMP:~4%"
if "%TMP:~0,4%"=="\\?\" set "TMP=%TMP:~4%"

:: ============================================================
::  sign.bat - Pack, lint & sign the Workspaces extension
::  Usage: scripts\sign.bat [--listed | --unlisted]
::  Default: auto-detect from git branch
::    master -> listed (AMO public)
::    dev    -> unlisted (self-distributed)
:: ============================================================

set "ROOT=%~dp0.."
set "EXT_DIR=%ROOT%"
set "ENV_FILE=%ROOT%\.env"

:: ----------------------------------------------------------
::  1. Determine channel
:: ----------------------------------------------------------
set "CHANNEL="

:: Check CLI argument first
if /I "%~1"=="--listed" set "CHANNEL=listed"
if /I "%~1"=="--unlisted" set "CHANNEL=unlisted"

:: Auto-detect from git branch if no argument
if "%CHANNEL%"=="" (
    for /f "tokens=*" %%B in ('git -C "%ROOT%" rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%B"
    if "!BRANCH!"=="master" (
        set "CHANNEL=listed"
    ) else (
        set "CHANNEL=unlisted"
    )
)

echo [INFO] Channel: %CHANNEL% (branch: !BRANCH!)

:: ----------------------------------------------------------
::  2. Load .env
:: ----------------------------------------------------------
if not exist "%ENV_FILE%" (
    echo [ERROR] .env not found at %ENV_FILE%
    echo Create it from .env.example with your AMO credentials.
    exit /b 1
)

for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    set "line=%%A"
    if not "!line:~0,1!"=="#" (
        if not "%%A"=="" set "%%A=%%B"
    )
)

if "%WEB_EXT_API_KEY%"=="" (
    echo [ERROR] WEB_EXT_API_KEY not set in .env
    exit /b 1
)
if "%WEB_EXT_API_SECRET%"=="" (
    echo [ERROR] WEB_EXT_API_SECRET not set in .env
    exit /b 1
)

:: ----------------------------------------------------------
::  3. Check web-ext is installed
:: ----------------------------------------------------------
where web-ext >nul 2>&1
if errorlevel 1 (
    echo [ERROR] web-ext not found. Install it with:
    echo   npm install -g web-ext
    exit /b 1
)

:: ----------------------------------------------------------
::  4. Validate extension directory
:: ----------------------------------------------------------
if not exist "%EXT_DIR%\manifest.json" (
    echo [ERROR] manifest.json not found in %EXT_DIR%
    exit /b 1
)

:: ----------------------------------------------------------
::  5. Lint the extension
:: ----------------------------------------------------------
echo.
echo [1/3] Linting extension...
:: `call` is required: web-ext is a .cmd shim, and a batch file that invokes
:: another batch/cmd without `call` transfers control and never returns --
:: this script used to silently exit here, skipping build and sign entirely.
call web-ext lint --source-dir="%EXT_DIR%"
if errorlevel 1 (
    echo [WARN] Lint reported issues. Continuing anyway...
)

:: ----------------------------------------------------------
::  6. Build (zip) the extension
:: ----------------------------------------------------------
echo.
echo [2/3] Building extension...
call web-ext build --source-dir="%EXT_DIR%" --artifacts-dir="%EXT_DIR%\web-ext-artifacts" --overwrite-dest
if errorlevel 1 (
    echo [ERROR] Build failed.
    exit /b 1
)

:: ----------------------------------------------------------
::  7. Sign the extension
:: ----------------------------------------------------------
echo.
echo [3/3] Signing extension via AMO (%CHANNEL%)...
:: Credentials are passed via the WEB_EXT_API_KEY / WEB_EXT_API_SECRET env
:: vars loaded from .env in step 2 -- web-ext reads them automatically. Not
:: passed as CLI flags: those are visible to any process listing the command
:: line of this process.
call web-ext sign --source-dir="%EXT_DIR%" --artifacts-dir="%EXT_DIR%\web-ext-artifacts" --channel=%CHANNEL%
if errorlevel 1 (
    echo [ERROR] Signing failed. Check your AMO credentials in .env
    exit /b 1
)

echo.
echo [OK] Extension signed (%CHANNEL%). Output in %EXT_DIR%\web-ext-artifacts\
endlocal
