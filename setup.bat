@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

echo ============================================
echo   UE CodeGraph MCP - Setup
echo ============================================
echo.

:: SSL cert issue workaround (corporate proxy)
set NODE_TLS_REJECT_UNAUTHORIZED=0

:: Node.js check
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not installed.
    echo         Install Node.js 22 LTS from https://nodejs.org [LTS tab]
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER%

:: Node.js LTS version check
for /f "tokens=1 delims=." %%a in ("%NODE_VER%") do set NODE_MAJOR=%%a
set NODE_MAJOR=%NODE_MAJOR:v=%
if "%NODE_MAJOR%"=="20" goto :node_ok
if "%NODE_MAJOR%"=="22" goto :node_ok

echo.
echo [ERROR] Node.js v%NODE_MAJOR% is NOT supported!
echo         tree-sitter requires LTS version (v20 or v22).
echo.
echo         Fix:
echo           1. Windows Settings - Apps - "Node.js" - Uninstall
echo           2. Install Node.js 22 LTS: https://nodejs.org [LTS tab]
echo           3. Open new terminal, re-run setup.bat
echo.
pause
exit /b 1

:node_ok
:: npm check
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] npm not found.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('npm --version') do set NPM_VER=%%v
echo [OK] npm %NPM_VER%
echo.

:: SSL workaround for npm (after confirming npm exists)
call npm config set strict-ssl false >nul 2>&1

:: package.json check
if not exist "%~dp0package.json" (
    echo [ERROR] package.json not found.
    pause
    exit /b 1
)

cd /d "%~dp0"

:: Step 1: node-gyp
echo [1/4] node-gyp ...
call npm install -g node-gyp >nul 2>&1
echo [OK] node-gyp
echo.

:: Step 2: npm install
echo [2/4] npm install ... (1~2 min)
echo.
call npm install --legacy-peer-deps
echo.
if not exist "%~dp0node_modules\better-sqlite3\" goto :install_fail
if not exist "%~dp0node_modules\tree-sitter\" goto :install_fail
echo [OK] npm install
echo.
goto :step3

:install_fail
echo [ERROR] npm install failed!
echo.
echo   1. Install Visual Studio Build Tools (C++ workload)
echo      https://visualstudio.microsoft.com/visual-cpp-build-tools/
echo   2. Re-run setup.bat
pause
exit /b 1

:step3
:: Step 3: npm link
echo [3/4] npm link ...
call npm link >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN] npm link failed. Try running as Administrator.
    echo.
) else (
    echo [OK] ue-graph command registered globally.
    echo.
)

:: Step 4: mcp.json + indexing
echo [4/4] Claude Code setup
echo.

set "MCP_PATH=%~dp0build\index.js"

set /p UE_SOURCE_PATH="UE Source path (e.g. G:\MyProject\Source) [Enter to skip]: "
if "!UE_SOURCE_PATH!"=="" goto :done

if not exist "!UE_SOURCE_PATH!" (
    echo [ERROR] Path not found: !UE_SOURCE_PATH!
    goto :done
)

:: Source parent = project root
for %%I in ("!UE_SOURCE_PATH!\..") do set "UE_PROJECT_ROOT=%%~fI"

set "JSON_PATH=!MCP_PATH:\=\\!"
echo { > "!UE_PROJECT_ROOT!\mcp.json"
echo   "mcpServers": { >> "!UE_PROJECT_ROOT!\mcp.json"
echo     "ue-codegraph": { >> "!UE_PROJECT_ROOT!\mcp.json"
echo       "command": "node", >> "!UE_PROJECT_ROOT!\mcp.json"
echo       "args": ["!JSON_PATH!"], >> "!UE_PROJECT_ROOT!\mcp.json"
echo       "env": {}, >> "!UE_PROJECT_ROOT!\mcp.json"
echo       "disabled": false >> "!UE_PROJECT_ROOT!\mcp.json"
echo     } >> "!UE_PROJECT_ROOT!\mcp.json"
echo   } >> "!UE_PROJECT_ROOT!\mcp.json"
echo } >> "!UE_PROJECT_ROOT!\mcp.json"
echo.
echo [OK] mcp.json created: !UE_PROJECT_ROOT!\mcp.json
echo.

set /p DO_INDEX="Index now? (Y/N) [Y]: "
if /i "!DO_INDEX!"=="" set DO_INDEX=Y
if /i "!DO_INDEX!"=="Y" (
    echo.
    echo Indexing...
    call node "%~dp0ue-graph.mjs" index "!UE_SOURCE_PATH!" ue-project
    echo.
)

:done
echo.
echo ============================================
echo   Setup Complete!
echo ============================================
echo.
echo   Usage:
echo     ue-graph index "G:\YourProject\Source" ue-project
echo     ue-graph status
echo     ue-graph callers SetHP
echo     ue-graph analyze MyClass
echo.
echo   Claude Code:
echo     cd G:\YourProject
echo     claude
echo     /mcp to check server connection
echo.
pause
