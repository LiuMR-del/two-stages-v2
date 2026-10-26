@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Two stages 主图批量生成
cd /d "%~dp0"

set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" set "NODE=%NVM_SYMLINK%\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Volta\bin\node.exe" set "NODE=%LOCALAPPDATA%\Volta\bin\node.exe"
if not defined NODE if exist "%APPDATA%\fnm\aliases\default\node.exe" set "NODE=%APPDATA%\fnm\aliases\default\node.exe"
if not defined NODE goto nonode

"%NODE%" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)"
if errorlevel 1 goto oldnode

for %%d in ("%NODE%") do set "NODE_DIR=%%~dpd"
set "PATH=%NODE_DIR%;%PATH%"

if exist "node_modules\sharp" goto run
echo 第一次运行，正在安装图片处理组件（只需要一次，需要联网，大约 1 分钟）...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 goto installfail

:run
echo.
echo ==============================================
echo   Two stages 正在运行，浏览器会自动打开页面。
echo   关掉这个窗口会停止服务。
echo ==============================================
echo.
"%NODE%" dist\server.cjs
echo.
echo 服务已停止。
pause
exit /b 0

:nonode
echo.
echo 没有找到 Node.js。
echo 请到 https://nodejs.org/zh-cn 下载「长期支持版（LTS）」，安装后再双击这个文件。
echo.
pause
exit /b 1

:oldnode
echo.
echo 电脑上的 Node.js 版本太旧，需要 20.19 或更新的版本。
echo 请到 https://nodejs.org/zh-cn 下载「长期支持版（LTS）」，安装后再双击这个文件。
echo.
pause
exit /b 1

:installfail
echo.
echo 安装失败。请检查网络后重新双击启动；如果一直失败，把这个窗口的内容截图发给维护的人。
pause
exit /b 1
