@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%LOCALAPPDATA%\DeepSeekHarness\app\node\node.exe" (
    set "NODE_EXE=%LOCALAPPDATA%\DeepSeekHarness\app\node\node.exe"
  ) else (
    echo [X] 未找到 Node.js。请先安装 DSH（自带 Node），或安装 Node.js 22.19+。
    pause
    exit /b 1
  )
)

"%NODE_EXE%" install.mjs %*
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" (
  echo 安装未完成（exit %CODE%）。请把上面的输出发给管理员。
) else (
  echo 安装完成。
)
pause
exit /b %CODE%
